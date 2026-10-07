import { BURN_RATE_1H_QUERY, SLO_METRICS } from '@raion/core';
import type { GatewayClient } from './gateway.js';

export type SloHealth = 'no-data' | 'healthy' | 'at-risk' | 'exhausted';

export interface SloStatus {
  service: string;
  slo: string;
  /** Share of good events over the SLO window (0..1). */
  sli: number | null;
  objective: number | null;
  /** 1 = untouched, 0 = spent, negative = overspent. */
  budgetRemaining: number | null;
  /** How many times faster than sustainable the budget burned over the last hour. */
  burnRate1h: number | null;
  health: SloHealth;
  /** Plain-language summary. */
  message: string;
  queries: { sli: string; budgetRemaining: string; burnRate1h: string };
}

type Series = { metric: Record<string, string>; value: [number, string] }[];

async function vector(gateway: GatewayClient, query: string): Promise<Map<string, number>> {
  const body = await gateway.json<{ data: { result: Series } }>(
    `/prometheus/api/v1/query?query=${encodeURIComponent(query)}`,
  );
  const map = new Map<string, number>();
  for (const s of body.data.result) {
    const n = Number(s.value[1]);
    if (Number.isFinite(n)) map.set(`${s.metric.service_name}/${s.metric.slo}`, n);
  }
  return map;
}

export function classify(budgetRemaining: number | null, burnRate1h: number | null): SloHealth {
  if (budgetRemaining === null) return 'no-data';
  if (budgetRemaining < 0) return 'exhausted';
  if (budgetRemaining < 0.25 || (burnRate1h ?? 0) >= 2) return 'at-risk';
  return 'healthy';
}

function message(s: Omit<SloStatus, 'message' | 'health' | 'queries'>, health: SloHealth): string {
  const pct = (v: number) => `${(v * 100).toFixed(v > 0.999 ? 3 : 2)}%`;
  switch (health) {
    case 'no-data':
      return 'No data yet: the SLO is measured once the service handles requests.';
    case 'exhausted':
      return `The error budget is spent: ${s.sli !== null ? pct(s.sli) : 'n/a'} against an objective of ${s.objective !== null ? pct(s.objective) : 'n/a'}.`;
    case 'at-risk':
      return `At risk: ${Math.max(0, Math.round((s.budgetRemaining ?? 0) * 100))}% of the error budget left${s.burnRate1h !== null ? `, burning ${s.burnRate1h.toFixed(1)}× the sustainable rate` : ''}.`;
    case 'healthy':
      return `Healthy: ${Math.round((s.budgetRemaining ?? 0) * 100)}% of the error budget left.`;
  }
}

/** Live status of every SLO, from the recording rules Raion generates. */
export async function fetchSloStatus(
  gateway: GatewayClient,
  slos: { service: string; slo: string }[],
): Promise<SloStatus[]> {
  const [sli, objective, remaining, burn1h] = await Promise.all([
    vector(gateway, SLO_METRICS.sli),
    vector(gateway, SLO_METRICS.objective),
    vector(gateway, SLO_METRICS.budgetRemaining),
    vector(gateway, BURN_RATE_1H_QUERY),
  ]);
  return slos.map(({ service, slo }) => {
    const key = `${service}/${slo}`;
    const sel = `{service_name="${service}",slo="${slo}"}`;
    const base = {
      service,
      slo,
      sli: sli.get(key) ?? null,
      objective: objective.get(key) ?? null,
      budgetRemaining: remaining.get(key) ?? null,
      burnRate1h: burn1h.get(key) ?? null,
    };
    const health = classify(base.budgetRemaining, base.burnRate1h);
    return {
      ...base,
      health,
      message: message(base, health),
      queries: {
        sli: `${SLO_METRICS.sli}${sel}`,
        budgetRemaining: `${SLO_METRICS.budgetRemaining}${sel}`,
        burnRate1h: `${SLO_METRICS.errorRatio('1h')}${sel} / (1 - ${SLO_METRICS.objective}${sel})`,
      },
    };
  });
}
