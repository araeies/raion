import { capabilityOf } from '../integrations.js';
import type { ResolvedService, ResolvedSlo, ResolvedWorkspace } from '../model.js';
import type { AlertRule } from './alerts.js';
import { q } from './dashboard-builder.js';
import { serviceDashboardUid } from './dashboards.js';

/**
 * SLOs as plain Prometheus rules (Google SRE Workbook, chapter 5: multi-window, multi-burn-rate).
 *
 * For every SLO, two series are recorded every 30 s — "bad events per second" and "all events
 * per second" over the last 5 minutes. Every window's error ratio is then
 *
 *     sum_over_time(bad[W]) / sum_over_time(all[W])
 *
 * which weights each moment by its traffic (a quiet night does not count as much as a busy
 * day), and costs the same for a 5-minute window as for a 30-day one.
 */

export const SLO_METRICS = {
  bad: 'raion_slo:bad:rate5m',
  total: 'raion_slo:total:rate5m',
  /** Error ratio over a burn-rate window, e.g. raion_slo:error_ratio:rate1h. */
  errorRatio: (window: string) => `raion_slo:error_ratio:rate${window}`,
  /** Error ratio over the SLO's own window (e.g. 30 days). */
  windowErrorRatio: 'raion_slo:error_ratio:window',
  /** Share of good events over the SLO window: what the SLO promises. */
  sli: 'raion_slo:sli:ratio',
  objective: 'raion_slo:objective:ratio',
  /** 1 = untouched, 0 = spent, negative = overspent. */
  budgetRemaining: 'raion_slo:error_budget_remaining:ratio',
} as const;

/**
 * Burn rate over the last hour for every SLO: how many times faster than sustainable the error
 * budget is being used (1 = exactly on budget).
 */
export const BURN_RATE_1H_QUERY = `${SLO_METRICS.errorRatio('1h')} / on (service_name, slo) (1 - ${SLO_METRICS.objective})`;

/** Burn-rate windows, from the SRE Workbook. */
const BURN_WINDOWS = ['5m', '30m', '1h', '2h', '6h', '1d', '3d'] as const;

/**
 * Alert conditions for a 30-day window: a page when 2% of the budget burns in an hour or 5% in
 * six hours; a ticket when 10% burns in a day or in three days. Factors are rescaled for other
 * SLO windows, so "2% of the budget in an hour" means the same thing for a 7-day SLO.
 */
const CONDITIONS = [
  { severity: 'page', long: '1h', short: '5m', budget: 0.02, longHours: 1 },
  { severity: 'page', long: '6h', short: '30m', budget: 0.05, longHours: 6 },
  { severity: 'ticket', long: '1d', short: '2h', budget: 0.1, longHours: 24 },
  { severity: 'ticket', long: '3d', short: '6h', budget: 0.1, longHours: 72 },
] as const;

export interface BurnCondition {
  severity: 'page' | 'ticket';
  long: string;
  short: string;
  /** Burn rate (multiple of the sustainable rate) that triggers the condition. */
  factor: number;
  /** Share of the whole budget consumed when the condition holds for the long window. */
  budget: number;
}

/** Burn-rate conditions for an SLO window; conditions longer than the window are skipped. */
export function burnConditions(windowMs: number): BurnCondition[] {
  const windowHours = windowMs / 3_600_000;
  return CONDITIONS.filter((c) => c.longHours < windowHours)
    .map((c) => ({
      severity: c.severity,
      long: c.long,
      short: c.short,
      budget: c.budget,
      factor: round((c.budget * windowHours) / c.longHours),
    }))
    .filter((c) => c.factor >= 1);
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Thresholds keep 6 significant digits, so tiny budgets (99.99%) stay exact. */
function num(n: number): number {
  return Number(n.toPrecision(6));
}

/** Whether Raion can compute this SLO for this service. */
export function sloSupported(svc: ResolvedService, slo: ResolvedSlo): boolean {
  return slo.sli.type === 'custom' || capabilityOf(svc.capabilities, 'http.server') !== undefined;
}

/** PromQL for bad and total events per second (5-minute rate) of an SLI. */
export function sliQueries(
  svc: ResolvedService,
  slo: ResolvedSlo,
): { bad: string; total: string; method: 'Occurrences' | 'Timeslices' } {
  const sli = slo.sli;
  if (sli.type === 'custom') {
    return sli.bad
      ? { bad: sli.bad, total: sli.total, method: 'Occurrences' }
      : { bad: `(${sli.total}) - (${sli.good!})`, total: sli.total, method: 'Occurrences' };
  }
  const m = capabilityOf(svc.capabilities, 'http.server')!.metrics.requestDuration;
  const sel = `service_name=${q(svc.name)}`;
  const total = `sum(rate(${m.name}_count{${sel}}[5m]))`;
  switch (sli.type) {
    case 'availability':
      return {
        bad: `sum(rate(${m.name}_count{${sel},${m.labels.status}=~"5.."}[5m])) or vector(0)`,
        total,
        method: 'Occurrences',
      };
    case 'latency':
      return {
        // Requests slower than the threshold = all requests - requests in buckets <= threshold.
        bad: `${total} - sum(rate(${m.name}_bucket{${sel},le="${sli.thresholdMs / 1000}"}[5m]))`,
        total,
        method: 'Occurrences',
      };
    case 'throughput':
      // Time-based: each 5-minute interval counts once; it is bad when traffic is below the minimum.
      return {
        bad: `(${total} or vector(0)) < bool ${sli.minRequestsPerSecond}`,
        total: 'vector(1)',
        method: 'Timeslices',
      };
  }
}

export interface SloRules {
  recording: { record: string; expr: string; labels: Record<string, string> }[];
  alerts: AlertRule[];
}

function describeSli(slo: ResolvedSlo): string {
  switch (slo.sli.type) {
    case 'availability':
      return 'requests that did not fail with a server error';
    case 'latency':
      return `requests faster than ${slo.sli.thresholdMs} ms`;
    case 'throughput':
      return `5-minute intervals with at least ${slo.sli.minRequestsPerSecond} requests per second`;
    case 'custom':
      return 'good events (custom query)';
  }
}

function hoursText(hours: number): string {
  return hours < 48 ? `${Math.round(hours)} hours` : `${Math.round(hours / 24)} days`;
}

/** Recording rules and burn-rate alerts for one SLO. */
export function sloRules(ws: ResolvedWorkspace, svc: ResolvedService, slo: ResolvedSlo): SloRules {
  const labels = { service_name: svc.name, slo: slo.name, slo_window: slo.window };
  const sel = `service_name=${q(svc.name)},slo=${q(slo.name)}`;
  const { bad, total } = sliQueries(svc, slo);
  const objective = Number((slo.target / 100).toPrecision(10));
  const budget = slo.errorBudgetRatio;
  const ratio = (w: string) =>
    `sum_over_time(${SLO_METRICS.bad}{${sel}}[${w}]) / sum_over_time(${SLO_METRICS.total}{${sel}}[${w}])`;

  const recording = [
    { record: SLO_METRICS.bad, expr: bad, labels },
    { record: SLO_METRICS.total, expr: total, labels },
    ...BURN_WINDOWS.map((w) => ({ record: SLO_METRICS.errorRatio(w), expr: ratio(w), labels })),
    { record: SLO_METRICS.windowErrorRatio, expr: ratio(slo.window), labels },
    { record: SLO_METRICS.sli, expr: `1 - ${SLO_METRICS.windowErrorRatio}{${sel}}`, labels },
    { record: SLO_METRICS.objective, expr: `vector(${objective})`, labels },
    {
      record: SLO_METRICS.budgetRemaining,
      expr: `1 - ${SLO_METRICS.windowErrorRatio}{${sel}} / ${budget}`,
      labels,
    },
  ];

  const base = ws.server.publicUrl.replace(/\/$/, '');
  const alertLabels = (severity: string) => ({
    severity,
    service_name: svc.name,
    slo: slo.name,
    ...(svc.team ? { team: svc.team } : {}),
    raion_scope: 'slo',
  });
  const annotations = (summary: string, description: string) => ({
    summary,
    description: `${description}${slo.policy ? ` Error budget policy: ${slo.policy}` : ''}`,
    dashboard_url: `${base}/grafana/d/raion-slos`,
    service_dashboard_url: `${base}/grafana/d/${serviceDashboardUid(svc.name)}`,
    raion_url: `${base}/services/${svc.name}`,
    ...(svc.runbooks.find((r) => r.slo === slo.name)
      ? { runbook_url: svc.runbooks.find((r) => r.slo === slo.name)!.url }
      : {}),
  });

  const conditions = burnConditions(slo.windowMs);
  const windowHours = slo.windowMs / 3_600_000;
  const alerts: AlertRule[] = [];
  for (const severity of ['page', 'ticket'] as const) {
    const matching = conditions.filter((c) => c.severity === severity);
    if (matching.length === 0) continue;
    const expr = matching
      .map(
        (c) =>
          `(${SLO_METRICS.errorRatio(c.long)}{${sel}} > ${num(c.factor * budget)} and ${SLO_METRICS.errorRatio(c.short)}{${sel}} > ${num(c.factor * budget)})`,
      )
      .join(' or ');
    const fastest = Math.max(...matching.map((c) => c.factor));
    alerts.push({
      alert: severity === 'page' ? 'SLOErrorBudgetBurnFast' : 'SLOErrorBudgetBurnSlow',
      expr,
      for: severity === 'page' ? '2m' : '15m',
      labels: alertLabels(severity === 'page' ? 'critical' : 'warning'),
      annotations: annotations(
        `${svc.name}: the "${slo.name}" SLO is using its error budget ${severity === 'page' ? 'fast' : 'steadily'}`,
        severity === 'page'
          ? `${svc.name} is failing its ${slo.target}% objective (${describeSli(slo)}) at ${fastest}× or more the sustainable rate: at this pace the ${slo.window} error budget is gone in about ${hoursText(windowHours / fastest)}. Act now.`
          : `${svc.name} has been using its ${slo.window} error budget faster than it can afford for hours (${describeSli(slo)}, objective ${slo.target}%). Not urgent, but plan a fix before the budget runs out.`,
      ),
    });
  }
  alerts.push({
    alert: 'SLOErrorBudgetExhausted',
    expr: `${SLO_METRICS.budgetRemaining}{${sel}} < 0`,
    for: '10m',
    labels: alertLabels('warning'),
    annotations: annotations(
      `${svc.name}: the "${slo.name}" error budget is spent`,
      `${svc.name} has missed its ${slo.target}% objective over the last ${slo.window} (${describeSli(slo)}).`,
    ),
  });

  return { recording, alerts };
}
