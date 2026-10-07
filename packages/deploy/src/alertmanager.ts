import type { GatewayClient } from './gateway.js';

/** An alert as Alertmanager reports it (API v2). */
export interface ActiveAlert {
  fingerprint: string;
  startsAt: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  status: {
    state: 'active' | 'suppressed' | 'unprocessed';
    silencedBy: string[];
    inhibitedBy: string[];
  };
}

export interface Silence {
  id: string;
  matchers: { name: string; value: string; isRegex: boolean; isEqual?: boolean }[];
  startsAt: string;
  endsAt: string;
  createdBy: string;
  comment: string;
  status: { state: 'active' | 'pending' | 'expired' };
}

export const WATCHDOG_ALERT = 'Watchdog';

export async function fetchActiveAlerts(gateway: GatewayClient): Promise<ActiveAlert[]> {
  return gateway.json<ActiveAlert[]>('/alertmanager/api/v2/alerts', { timeoutMs: 10_000 });
}

export interface AlertingHealth {
  /** Alertmanager answered. */
  alertmanagerReachable: boolean;
  /** The always-firing Watchdog alert reached Alertmanager: rules are evaluated and delivered. */
  watchdogReceived: boolean;
  ok: boolean;
  message: string;
}

/** The out-of-band check that the alerting pipeline (Prometheus → Alertmanager) works. */
export function alertingHealth(alerts: ActiveAlert[] | undefined, error?: string): AlertingHealth {
  if (!alerts) {
    return {
      alertmanagerReachable: false,
      watchdogReceived: false,
      ok: false,
      message: `Alertmanager is not reachable${error ? ` (${error})` : ''}: alerts cannot be delivered.`,
    };
  }
  const watchdog = alerts.some((a) => a.labels.alertname === WATCHDOG_ALERT);
  return {
    alertmanagerReachable: true,
    watchdogReceived: watchdog,
    ok: watchdog,
    message: watchdog
      ? 'Alerting works: rules are evaluated and alerts reach Alertmanager.'
      : 'The Watchdog alert is missing: Prometheus is not evaluating rules or cannot reach Alertmanager. Alerts are not being delivered.',
  };
}

/** Alerts people should see (everything except the Watchdog). */
export function userAlerts(alerts: ActiveAlert[]): ActiveAlert[] {
  return alerts.filter((a) => a.labels.alertname !== WATCHDOG_ALERT);
}

export async function listSilences(gateway: GatewayClient): Promise<Silence[]> {
  const all = await gateway.json<Silence[]>('/alertmanager/api/v2/silences', { timeoutMs: 10_000 });
  return all.filter((s) => s.status.state !== 'expired');
}

export async function createSilence(
  gateway: GatewayClient,
  silence: {
    matchers: Record<string, string>;
    minutes: number;
    createdBy: string;
    comment: string;
  },
): Promise<string> {
  const now = Date.now();
  const res = await gateway.fetch('/alertmanager/api/v2/silences', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    timeoutMs: 10_000,
    body: JSON.stringify({
      matchers: Object.entries(silence.matchers).map(([name, value]) => ({
        name,
        value,
        isRegex: false,
        isEqual: true,
      })),
      startsAt: new Date(now).toISOString(),
      endsAt: new Date(now + silence.minutes * 60_000).toISOString(),
      createdBy: silence.createdBy,
      comment: silence.comment,
    }),
  });
  if (!res.ok)
    throw new Error(`Alertmanager rejected the silence: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { silenceID: string }).silenceID;
}

export async function deleteSilence(gateway: GatewayClient, id: string): Promise<void> {
  const res = await gateway.fetch(`/alertmanager/api/v2/silence/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    timeoutMs: 10_000,
  });
  await res.body?.cancel();
  if (!res.ok) throw new Error(`Alertmanager could not remove silence ${id} (HTTP ${res.status})`);
}
