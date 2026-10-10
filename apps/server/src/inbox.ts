import {
  alertingHealth,
  fetchActiveAlerts,
  fetchAlertHistory,
  fetchRuleAlerts,
  WATCHDOG_ALERT,
  type AlertingHealth,
  type GatewayClient,
  type RuleAlert,
} from '@raion/deploy';
import type { RuntimeService } from './runtime.js';
import type { Store } from './store.js';

const RETENTION_DAYS = 30;
const LAST_POLL_KEY = 'inbox.lastPollAt';
/** On the very first start, look back this far for alerts that fired before Raion was watching. */
const FIRST_RUN_HISTORY_MS = 24 * 3_600_000;
/** Never look back further than this (Prometheus keeps 15 days by default). */
const MAX_HISTORY_GAP_MS = 7 * 86_400_000;

/**
 * The Raion alert inbox. Polls Alertmanager through the gateway (Raion is never called by the
 * stack) and keeps a history of every alert, independent of any notification receiver.
 */
export class AlertInbox {
  #health: AlertingHealth | undefined;
  #lastPoll = 0;
  #timer: NodeJS.Timeout | undefined;
  #polling: Promise<void> | undefined;
  #pending: RuleAlert[] = [];
  #historyChecked = false;

  constructor(
    readonly store: Store,
    readonly runtime: RuntimeService,
  ) {}

  start(intervalMs = 30_000): void {
    this.#timer = setInterval(() => void this.poll().catch(() => undefined), intervalMs);
    this.#timer.unref();
    void this.poll().catch(() => undefined);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  /** Health of the alerting pipeline at the last poll (undefined: nothing deployed). */
  health(): AlertingHealth | undefined {
    return this.#health;
  }

  /** Polls unless a poll ran within `maxAgeMs`. Concurrent callers share one poll. */
  async refresh(maxAgeMs = 10_000): Promise<void> {
    if (Date.now() - this.#lastPoll < maxAgeMs) return;
    await this.poll();
  }

  poll(): Promise<void> {
    this.#polling ??= this.#poll().finally(() => {
      this.#polling = undefined;
    });
    return this.#polling;
  }

  /** Alerts whose condition is true but has not lasted long enough to fire yet. */
  pending(): RuleAlert[] {
    return this.#pending;
  }

  async #poll(): Promise<void> {
    const gateway = await this.runtime.gateway();
    this.#lastPoll = Date.now();
    if (!gateway) {
      this.#health = undefined;
      this.#pending = [];
      return;
    }
    try {
      const now = new Date();
      // Filling the history must never hold up live alerts; it is retried at the next poll.
      if (!this.#historyChecked) await this.#fillHistoryGap(gateway, now).catch(() => undefined);
      const alerts = await fetchActiveAlerts(gateway);
      this.#pending = await fetchRuleAlerts(gateway)
        .then((all) => all.filter((a) => a.state === 'pending'))
        .catch(() => []);
      this.#health = alertingHealth(alerts);
      this.store.syncAlerts(
        alerts
          .filter((a) => a.labels.alertname !== WATCHDOG_ALERT)
          .map((a) => ({
            fingerprint: a.fingerprint,
            startsAt: a.startsAt,
            alertname: a.labels.alertname ?? 'unknown',
            ...(a.labels.severity ? { severity: a.labels.severity } : {}),
            ...(a.labels.service_name ? { service: a.labels.service_name } : {}),
            labels: a.labels,
            annotations: a.annotations,
            state: a.status.state,
          })),
      );
      this.store.pruneAlerts(new Date(Date.now() - RETENTION_DAYS * 86_400_000));
      this.store.setSetting(LAST_POLL_KEY, now.toISOString());
    } catch (error) {
      // Keep the history as it is: an unreachable Alertmanager must not resolve alerts.
      this.#health = alertingHealth(undefined, (error as Error).message);
    }
  }

  /**
   * Alertmanager only knows the alerts firing now. For the time the Raion server was not
   * running, the history comes from Prometheus' own record of firing alerts.
   */
  async #fillHistoryGap(gateway: GatewayClient, now: Date): Promise<void> {
    const last = this.store.getSetting(LAST_POLL_KEY);
    const from = new Date(
      Math.max(
        last ? Date.parse(last) - 60_000 : now.getTime() - FIRST_RUN_HISTORY_MS,
        now.getTime() - MAX_HISTORY_GAP_MS,
      ),
    );
    if (now.getTime() - from.getTime() > 2 * 60_000) {
      const periods = await fetchAlertHistory(gateway, from, now);
      // Alerts still firing are recorded from Alertmanager, with their annotations.
      this.store.recordAlertHistory(periods.filter((p) => !p.ongoing));
    }
    this.#historyChecked = true;
  }
}
