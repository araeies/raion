import type { GatewayClient } from './gateway.js';
import { WATCHDOG_ALERT } from './alertmanager.js';

/**
 * An alert as Prometheus evaluates it. Prometheus holds an alert as "pending" while its
 * condition is true but has not lasted the rule's "for" duration yet; only "firing" alerts are
 * sent to Alertmanager.
 */
export interface RuleAlert {
  alertname: string;
  state: 'pending' | 'firing';
  labels: Record<string, string>;
  annotations: Record<string, string>;
  /** When the condition became true. */
  activeAt: string;
  /** The value that triggered it, as Prometheus formats it. */
  value: string;
}

interface RulesResponse {
  data: {
    groups: {
      rules: {
        type: string;
        name: string;
        alerts?: {
          labels: Record<string, string>;
          annotations: Record<string, string>;
          state: string;
          activeAt: string;
          value: string;
        }[];
      }[];
    }[];
  };
}

/** Every alert Prometheus currently holds, pending or firing, except the Watchdog. */
export async function fetchRuleAlerts(gateway: GatewayClient): Promise<RuleAlert[]> {
  const res = await gateway.json<RulesResponse>('/prometheus/api/v1/rules?type=alert', {
    timeoutMs: 10_000,
  });
  const alerts: RuleAlert[] = [];
  for (const group of res.data.groups) {
    for (const rule of group.rules) {
      if (rule.type !== 'alerting' || rule.name === WATCHDOG_ALERT) continue;
      for (const a of rule.alerts ?? []) {
        if (a.state !== 'pending' && a.state !== 'firing') continue;
        alerts.push({
          alertname: rule.name,
          state: a.state,
          labels: a.labels,
          annotations: a.annotations,
          activeAt: a.activeAt,
          value: a.value,
        });
      }
    }
  }
  return alerts;
}

/** A period during which an alert was firing, reconstructed from Prometheus' ALERTS series. */
export interface AlertInterval {
  labels: Record<string, string>;
  start: Date;
  end: Date;
  /** Still firing at the end of the queried range. */
  ongoing: boolean;
}

interface RangeResponse {
  data: { result: { metric: Record<string, string>; values: [number, string][] }[] };
}

/**
 * When alerts were firing between `from` and `to`, from Prometheus' own record (the ALERTS
 * series). Used to fill gaps in the Raion inbox while the Raion server was not running.
 */
export async function fetchAlertHistory(
  gateway: GatewayClient,
  from: Date,
  to: Date,
): Promise<AlertInterval[]> {
  // Prometheus answers at most 11,000 points per series.
  const stepSeconds = Math.max(30, Math.ceil((to.getTime() - from.getTime()) / 1000 / 10_000));
  const query = `ALERTS{alertstate="firing",alertname!="${WATCHDOG_ALERT}"}`;
  const res = await gateway.json<RangeResponse>(
    `/prometheus/api/v1/query_range?query=${encodeURIComponent(query)}&start=${from.getTime() / 1000}&end=${to.getTime() / 1000}&step=${stepSeconds}`,
    { timeoutMs: 30_000 },
  );
  const intervals: AlertInterval[] = [];
  const endSeconds = to.getTime() / 1000;
  for (const series of res.data.result) {
    const { __name__: _name, alertstate: _state, ...labels } = series.metric;
    let start: number | undefined;
    let previous: number | undefined;
    const close = (ongoing: boolean) => {
      if (start === undefined || previous === undefined) return;
      intervals.push({
        labels,
        start: new Date(start * 1000),
        end: new Date(previous * 1000),
        ongoing,
      });
      start = undefined;
    };
    for (const [t] of series.values) {
      // A missing step means the alert stopped firing in between.
      if (previous !== undefined && t - previous > stepSeconds * 1.5) close(false);
      start ??= t;
      previous = t;
    }
    close(previous !== undefined && endSeconds - previous <= stepSeconds * 1.5);
  }
  return intervals;
}
