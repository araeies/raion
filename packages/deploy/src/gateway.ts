import { RUNTIME_SECRETS } from '@raion/core';
import { readSecret, type StatePaths } from './state.js';

export const GATEWAY_TOKEN_HEADER = 'X-Raion-Gateway-Token';

/**
 * Client for the Raion gateway: the only way into the observability stack. Used by the CLI
 * and the server for readiness checks, status and queries.
 */
export class GatewayClient {
  constructor(
    readonly baseUrl: string,
    readonly token: string,
  ) {}

  static forWorkspace(paths: StatePaths, gatewayPort: number): GatewayClient {
    return new GatewayClient(
      `http://127.0.0.1:${gatewayPort}`,
      readSecret(paths, RUNTIME_SECRETS.gatewayToken),
    );
  }

  async fetch(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const { timeoutMs, ...rest } = init;
    const headers = new Headers(rest.headers);
    headers.set(GATEWAY_TOKEN_HEADER, this.token);
    return fetch(`${this.baseUrl}${path}`, {
      ...rest,
      headers,
      signal: AbortSignal.timeout(timeoutMs ?? 5000),
      redirect: 'manual',
    });
  }

  /** True when the path answers with a 2xx status. Never throws. */
  async isReady(path: string): Promise<{ ready: boolean; detail: string }> {
    try {
      const res = await this.fetch(path);
      await res.body?.cancel();
      return { ready: res.ok, detail: `HTTP ${res.status}` };
    } catch (error) {
      return { ready: false, detail: (error as Error).message };
    }
  }

  async json<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
    const res = await this.fetch(path, init);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }
}

export interface ScrapeTargetHealth {
  job: string;
  health: 'up' | 'down' | 'unknown';
  lastError: string;
  lastScrape: string;
}

/** Prometheus's view of every scrape target: detects monitoring that is silently broken. */
export async function scrapeHealth(gateway: GatewayClient): Promise<ScrapeTargetHealth[]> {
  const body = await gateway.json<{
    data: {
      activeTargets: {
        labels: { job: string };
        health: ScrapeTargetHealth['health'];
        lastError: string;
        lastScrape: string;
      }[];
    };
  }>('/prometheus/api/v1/targets?state=active');
  return body.data.activeTargets
    .map((t) => ({
      job: t.labels.job,
      health: t.health,
      lastError: t.lastError,
      lastScrape: t.lastScrape,
    }))
    .sort((a, b) => a.job.localeCompare(b.job));
}
