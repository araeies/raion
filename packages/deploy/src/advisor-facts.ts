import { capabilityOf, type LiveFacts, type ResolvedWorkspace } from '@raion/core';
import type { GatewayClient } from './gateway.js';

/** Range the advisor looks back over. Long enough to smooth out bursts, short enough to be current. */
export const ADVISOR_WINDOW = '1h';

interface Sample {
  metric: Record<string, string>;
  value: number;
}

async function vector(gateway: GatewayClient, path: string, query: string): Promise<Sample[]> {
  const body = await gateway.json<{
    data: { result: { metric: Record<string, string>; value: [number, string] }[] };
  }>(`${path}?query=${encodeURIComponent(query)}`, { timeoutMs: 15_000 });
  return body.data.result
    .map((r) => ({ metric: r.metric, value: Number(r.value[1]) }))
    .filter((s) => Number.isFinite(s.value));
}

const prom = (gateway: GatewayClient, query: string) =>
  vector(gateway, '/prometheus/api/v1/query', query);
const loki = (gateway: GatewayClient, query: string) =>
  vector(gateway, '/loki/loki/api/v1/query', query);

function byService(samples: Sample[]): Record<string, number> {
  return Object.fromEntries(
    samples.filter((s) => s.metric.service_name).map((s) => [s.metric.service_name!, s.value]),
  );
}

/** Service names are DNS labels, so they are safe inside a regex matcher as they are. */
function anyOf(names: string[]): string {
  return `service_name=~"${names.join('|')}"`;
}

function sumIncrease(metrics: string[]): string {
  return metrics.map((m) => `(sum(increase(${m}[${ADVISOR_WINDOW}])) or vector(0))`).join(' + ');
}

const SIGNALS = ['spans', 'metric_points', 'log_records'];

/**
 * Reads what the advisor needs from the running stack, using read-only queries through the
 * gateway. A part that fails is reported in `problems` and left out; the rest still counts.
 */
export async function collectLiveFacts(
  gateway: GatewayClient,
  ws: ResolvedWorkspace,
): Promise<LiveFacts> {
  const facts: LiveFacts = {
    collectedAt: new Date().toISOString(),
    window: ADVISOR_WINDOW,
    problems: [],
  };
  const attempt = async (what: string, collect: () => Promise<void>) => {
    try {
      await collect();
    } catch (error) {
      facts.problems.push(`${what}: ${(error as Error).message}`);
    }
  };

  await Promise.all([
    attempt('request rates', async () => {
      const byMetric = new Map<string, string[]>();
      for (const svc of ws.services) {
        const http = capabilityOf(svc.capabilities, 'http.server');
        if (!http || !svc.signals.metrics) continue;
        const name = http.metrics.requestDuration.name;
        byMetric.set(name, [...(byMetric.get(name) ?? []), svc.name]);
      }
      const rates: Record<string, number> = {};
      for (const [metric, names] of byMetric) {
        Object.assign(
          rates,
          byService(
            await prom(
              gateway,
              `sum by (service_name) (rate(${metric}_count{${anyOf(names)}}[${ADVISOR_WINDOW}]))`,
            ),
          ),
        );
      }
      facts.requestRates = rates;
    }),

    attempt('log lines', async () => {
      const names = ws.services.filter((s) => s.signals.logs).map((s) => s.name);
      if (names.length === 0) return;
      const selector = `{${anyOf(names)}}`;
      const [lines, withTrace] = await Promise.all([
        loki(gateway, `sum by (service_name) (count_over_time(${selector}[${ADVISOR_WINDOW}]))`),
        loki(
          gateway,
          `sum by (service_name) (count_over_time(${selector} | trace_id != "" [${ADVISOR_WINDOW}]))`,
        ),
      ]);
      const traced = byService(withTrace);
      facts.logs = Object.fromEntries(
        Object.entries(byService(lines)).map(([svc, count]) => [
          svc,
          { lines: count, withTraceId: traced[svc] ?? 0 },
        ]),
      );
    }),

    attempt('service graph', async () => {
      if (!ws.services.some((s) => s.features.serviceGraph && s.features.traces)) return;
      const samples = await prom(
        gateway,
        `sum by (client, server) (rate(traces_service_graph_request_total[${ADVISOR_WINDOW}]))`,
      );
      facts.edges = samples
        .filter((s) => s.metric.client && s.metric.server)
        .map((s) => ({
          client: s.metric.client!,
          server: s.metric.server!,
          requestsPerSecond: s.value,
        }));
    }),

    attempt('collector', async () => {
      const [received, refused, exportFailed] = await Promise.all(
        [
          SIGNALS.flatMap((s) => [
            `otelcol_receiver_accepted_${s}`,
            `otelcol_receiver_refused_${s}`,
            `otelcol_receiver_failed_${s}`,
          ]),
          SIGNALS.flatMap((s) => [`otelcol_receiver_refused_${s}`, `otelcol_receiver_failed_${s}`]),
          SIGNALS.map((s) => `otelcol_exporter_send_failed_${s}`),
        ].map(async (metrics) => (await prom(gateway, sumIncrease(metrics)))[0]?.value ?? 0),
      );
      facts.collector = { received: received!, refused: refused!, exportFailed: exportFailed! };
    }),

    attempt('series counts', async () => {
      const body = await gateway.json<{
        data: {
          seriesCountByMetricName?: { name: string; value: number }[];
          labelValueCountByLabelName?: { name: string; value: number }[];
        };
      }>('/prometheus/api/v1/status/tsdb?limit=10', { timeoutMs: 15_000 });
      facts.cardinality = {
        metrics: (body.data.seriesCountByMetricName ?? []).map((m) => ({
          name: m.name,
          series: m.value,
        })),
        labels: (body.data.labelValueCountByLabelName ?? []).map((l) => ({
          name: l.name,
          values: l.value,
        })),
      };
    }),
  ]);
  return facts;
}
