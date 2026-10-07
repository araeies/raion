import {
  alertingHealth,
  fetchActiveAlerts,
  WATCHDOG_ALERT,
  type AlertingHealth,
} from '@raion/deploy';
import type { RuntimeService } from './runtime.js';
import type { Store } from './store.js';

const RETENTION_DAYS = 30;

/**
 * The Raion alert inbox. Polls Alertmanager through the gateway (Raion is never called by the
 * stack) and keeps a history of every alert, independent of any notification receiver.
 */
export class AlertInbox {
  #health: AlertingHealth | undefined;
  #lastPoll = 0;
  #timer: NodeJS.Timeout | undefined;
  #polling: Promise<void> | undefined;

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

  async #poll(): Promise<void> {
    const gateway = await this.runtime.gateway();
    this.#lastPoll = Date.now();
    if (!gateway) {
      this.#health = undefined;
      return;
    }
    try {
      const alerts = await fetchActiveAlerts(gateway);
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
    } catch (error) {
      // Keep the history as it is: an unreachable Alertmanager must not resolve alerts.
      this.#health = alertingHealth(undefined, (error as Error).message);
    }
  }
}
