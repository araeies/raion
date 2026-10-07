import { capabilityOf, presenceMetric, pulledReceiver, type ResolvedService } from '@raion/core';
import type { GatewayClient } from './gateway.js';

export interface SignalStatus {
  signal: 'metrics' | 'logs' | 'traces';
  ok: boolean;
  message: string;
  /** Query a user can run in Grafana to see the same thing. */
  query: string;
}

export interface ServiceTelemetry {
  service: string;
  signals: SignalStatus[];
  correlation?: {
    /** Share of the service's recent log lines that carry a trace ID (0..1). */
    logsWithTraceId: number;
    /** A trace referenced by a log line could be opened in Tempo. */
    linkedTraceFound: boolean;
    message: string;
  };
  /** Golden signals over the last 5 minutes, when the service has HTTP metrics. */
  red?: {
    requestsPerSecond: number | null;
    errorRatio: number | null;
    p95Seconds: number | null;
    queries: { requestsPerSecond: string; errorRatio: string; p95Seconds: string };
  };
}

/** Escapes a value for a PromQL/LogQL double-quoted string. */
export function quote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

const WINDOW_NS = 15n * 60n * 1_000_000_000n;

async function promScalar(gateway: GatewayClient, query: string): Promise<number | null> {
  const body = await gateway.json<{ data: { result: { value: [number, string] }[] } }>(
    `/prometheus/api/v1/query?query=${encodeURIComponent(query)}`,
  );
  const value = body.data.result[0]?.value[1];
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function lokiCount(gateway: GatewayClient, query: string): Promise<number> {
  const body = await gateway.json<{ data: { result: { value: [number, string] }[] } }>(
    `/loki/loki/api/v1/query?query=${encodeURIComponent(query)}`,
  );
  return Number(body.data.result[0]?.value[1] ?? 0);
}

/**
 * Checks what a running service actually sends: answers "is my service connected?" and
 * "are its logs linked to its traces?", with the queries to look further in Grafana.
 */
export async function checkServiceTelemetry(
  gateway: GatewayClient,
  svc: ResolvedService,
  options: { tracesDeployed: boolean },
): Promise<ServiceTelemetry> {
  const name = quote(svc.name);
  const result: ServiceTelemetry = { service: svc.name, signals: [] };
  const http = capabilityOf(svc.capabilities, 'http.server');

  // Databases, caches and proxies: the collector reads their metrics; there are no logs or
  // traces to check.
  const receiver = pulledReceiver(svc);
  if (receiver) {
    const metric = presenceMetric(receiver);
    const query = `${metric}{service_name=${name}}`;
    const [series, read] = await Promise.all([
      promScalar(gateway, `count(${query})`),
      // Data points the collector read from the service recently (null: not known yet).
      promScalar(
        gateway,
        `sum(increase(otelcol_scraper_scraped_metric_points{receiver=${quote(`${receiver}/${svc.name}`)}}[2m]))`,
      ),
    ]);
    const failing = read === 0;
    const ok = (series ?? 0) > 0 && (read ?? 0) > 0;
    result.signals.push({
      signal: 'metrics',
      ok,
      message: ok
        ? `the collector reads ${svc.name} (${receiver})`
        : failing
          ? `the collector fails to read ${svc.name}: check that it is reachable at the configured endpoint and that the credentials are right (the collector's log names the error)`
          : `no metrics from ${svc.name} yet: the collector reads every 15 seconds; if this persists, check the endpoint and that the service is on the observability network`,
      query,
    });
    if (svc.containerLogs && svc.signals.logs && svc.features.logs) {
      const logQuery = `{service_name=${name}}`;
      const lines = await lokiCount(gateway, `sum(count_over_time(${logQuery}[15m]))`);
      result.signals.push({
        signal: 'logs',
        ok: lines > 0,
        message:
          lines > 0
            ? `${lines} container log lines in the last 15 minutes`
            : 'no container logs in the last 15 minutes: start the container with the override from "raion connect" (it sets the logging driver)',
        query: logQuery,
      });
    }
    return result;
  }

  // Metrics -------------------------------------------------------------------------------
  if (http) {
    const m = http.metrics.requestDuration;
    const sel = `service_name=${name}`;
    const status = m.labels.status;
    const queries = {
      requestsPerSecond: `sum(rate(${m.name}_count{${sel}}[5m]))`,
      // "or vector(0)": no 5xx series at all means an error ratio of 0, not "no data".
      errorRatio: `(sum(rate(${m.name}_count{${sel},${status}=~"5.."}[5m])) or vector(0)) / sum(rate(${m.name}_count{${sel}}[5m]))`,
      p95Seconds: `histogram_quantile(0.95, sum by (le) (rate(${m.name}_bucket{${sel}}[5m])))`,
    };
    const [rps, errors, p95, series] = await Promise.all([
      promScalar(gateway, queries.requestsPerSecond),
      promScalar(gateway, queries.errorRatio),
      promScalar(gateway, queries.p95Seconds),
      promScalar(gateway, `count(${m.name}_count{${sel}})`),
    ]);
    result.red = {
      requestsPerSecond: rps,
      errorRatio: series ? errors : null,
      p95Seconds: p95,
      queries,
    };
    result.signals.push(
      series
        ? {
            signal: 'metrics',
            ok: true,
            message:
              rps && rps > 0
                ? `receiving HTTP metrics (${rps.toFixed(2)} requests/s)`
                : 'HTTP metrics exist, but there were no requests in the last 5 minutes',
            query: queries.requestsPerSecond,
          }
        : {
            signal: 'metrics',
            ok: false,
            message:
              'no HTTP request metrics from this service yet (has it handled any requests since it was connected?)',
            query: `${m.name}_count{${sel}}`,
          },
    );
  } else {
    const any = await promScalar(gateway, `count({service_name=${name}})`);
    result.signals.push({
      signal: 'metrics',
      ok: (any ?? 0) > 0,
      message:
        (any ?? 0) > 0 ? `receiving ${any} metric series` : 'no metrics from this service yet',
      query: `{service_name=${name}}`,
    });
  }

  // Logs ----------------------------------------------------------------------------------
  const logQuery = `{service_name=${name}}`;
  const total = await lokiCount(gateway, `sum(count_over_time(${logQuery}[15m]))`);
  result.signals.push({
    signal: 'logs',
    ok: total > 0,
    message:
      total > 0
        ? `${total} log lines in the last 15 minutes`
        : 'no logs from this service in the last 15 minutes',
    query: logQuery,
  });

  // Traces --------------------------------------------------------------------------------
  if (options.tracesDeployed && svc.features.traces && svc.signals.traces) {
    const end = BigInt(Date.now()) * 1_000_000n;
    const traceQuery = `{resource.service.name=${name}}`;
    const search = await gateway.json<{ traces?: unknown[] }>(
      `/tempo/api/search?q=${encodeURIComponent(traceQuery)}&limit=1&start=${(end - WINDOW_NS) / 1_000_000_000n}&end=${end / 1_000_000_000n}`,
    );
    const found = (search.traces?.length ?? 0) > 0;
    result.signals.push({
      signal: 'traces',
      ok: found,
      message: found ? 'receiving traces' : 'no traces from this service in the last 15 minutes',
      query: traceQuery,
    });

    // Correlation: do logs carry trace IDs, and do those IDs open a trace?
    if (total > 0) {
      const withTrace = await lokiCount(
        gateway,
        `sum(count_over_time(${logQuery} | trace_id != "" [15m]))`,
      );
      const ratio = withTrace / total;
      let linkedTraceFound = false;
      if (withTrace > 0) {
        // Skip the last 30 seconds: applications export spans in batches, so the newest
        // log lines can refer to traces that have not reached Tempo yet.
        const now = BigInt(Date.now());
        const start = (now - 15n * 60_000n) * 1_000_000n;
        const end = (now - 30_000n) * 1_000_000n;
        const lines = await gateway.json<{
          data: { result: { stream: Record<string, string> }[] };
        }>(
          `/loki/loki/api/v1/query_range?query=${encodeURIComponent(`${logQuery} | trace_id != ""`)}&start=${start}&end=${end}&limit=5`,
        );
        for (const traceId of lines.data.result
          .map((r) => r.stream.trace_id)
          .filter(Boolean)
          .slice(0, 3)) {
          const res = await gateway.fetch(`/tempo/api/traces/${encodeURIComponent(traceId!)}`);
          await res.body?.cancel();
          if (res.ok) {
            linkedTraceFound = true;
            break;
          }
        }
      }
      result.correlation = {
        logsWithTraceId: ratio,
        linkedTraceFound,
        message:
          withTrace === 0
            ? 'logs do not contain trace IDs, so they cannot be linked to traces (is the logging library instrumented?)'
            : `${Math.round(ratio * 100)}% of log lines carry a trace ID${linkedTraceFound ? ' and open the matching trace' : ', but the referenced traces were not found in Tempo yet'}`,
      };
    }
  }
  return result;
}
