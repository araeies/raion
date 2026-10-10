import { capabilityOf, checkSelector, type ResolvedService } from '@raion/core';
import type { GatewayClient } from './gateway.js';
import { quote } from './service-telemetry.js';

/** One line of a chart: [unix seconds, value] points. */
export interface HistorySeries {
  key: 'requests' | 'errors' | 'p95' | 'up' | 'answer';
  label: string;
  unit: 'perSecond' | 'ratio' | 'seconds';
  points: [number, number][];
}

export interface ServiceHistory {
  from: number;
  to: number;
  step: number;
  series: HistorySeries[];
}

interface RangeResponse {
  data: { result: { values: [number, string][] }[] };
}

async function range(
  gateway: GatewayClient,
  query: string,
  from: number,
  to: number,
  step: number,
) {
  const body = await gateway.json<RangeResponse>(
    `/prometheus/api/v1/query_range?query=${encodeURIComponent(query)}&start=${from}&end=${to}&step=${step}`,
    { timeoutMs: 15_000 },
  );
  return (body.data.result[0]?.values ?? [])
    .map(([t, v]): [number, number] => [t, Number(v)])
    .filter(([, v]) => Number.isFinite(v));
}

/** The recent history of an application, for the charts on its page. */
export async function serviceHistory(
  gateway: GatewayClient,
  svc: ResolvedService,
  minutes: 60 | 360 | 1440,
  now = Date.now(),
): Promise<ServiceHistory> {
  const to = Math.floor(now / 1000);
  const from = to - minutes * 60;
  // About 120 points per chart, whatever the period.
  const step = Math.max(15, Math.round((minutes * 60) / 120));
  const window = `${Math.max(60, step * 2)}s`;
  const series: HistorySeries[] = [];
  const http = capabilityOf(svc.capabilities, 'http.server');
  if (http) {
    const m = http.metrics.requestDuration;
    const sel = `service_name=${quote(svc.name)}`;
    const status = m.labels.status;
    const [requests, errors, p95] = await Promise.all([
      range(gateway, `sum(rate(${m.name}_count{${sel}}[${window}]))`, from, to, step),
      range(
        gateway,
        `(sum(rate(${m.name}_count{${sel},${status}=~"5.."}[${window}])) or vector(0)) / sum(rate(${m.name}_count{${sel}}[${window}]))`,
        from,
        to,
        step,
      ),
      range(
        gateway,
        `histogram_quantile(0.95, sum by (le) (rate(${m.name}_bucket{${sel}}[${window}])))`,
        from,
        to,
        step,
      ),
    ]);
    series.push(
      { key: 'requests', label: 'Requests per second', unit: 'perSecond', points: requests },
      { key: 'errors', label: 'Share failing', unit: 'ratio', points: errors },
      { key: 'p95', label: 'Slowest 1 in 20', unit: 'seconds', points: p95 },
    );
  }
  if (svc.checks.length > 0) {
    const sel = checkSelector(svc);
    const [up, answer] = await Promise.all([
      range(gateway, `avg(avg_over_time(probe_success{${sel}}[${window}]))`, from, to, step),
      range(
        gateway,
        `max(max_over_time(probe_duration_seconds{${sel}}[${window}]))`,
        from,
        to,
        step,
      ),
    ]);
    series.push(
      { key: 'up', label: 'Checks that succeeded', unit: 'ratio', points: up },
      { key: 'answer', label: 'Answer time', unit: 'seconds', points: answer },
    );
  }
  return { from, to, step, series };
}
