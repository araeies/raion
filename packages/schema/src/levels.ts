import { z } from 'zod';

/**
 * Observability maturity levels. A level is a *preset* of feature flags; any flag can be
 * overridden per workspace (`spec.features`) or per service (`spec.features`).
 * Level 4 (advanced) is reserved and not accepted yet.
 */
export const LEVELS = [1, 2, 3] as const;
export type Level = (typeof LEVELS)[number];

export const level = z.union([z.literal(1), z.literal(2), z.literal(3)], {
  error: (issue) =>
    issue.input === 4
      ? 'level 4 is not available. Use 1 (basic), 2 (production) or 3 (SRE)'
      : 'must be 1 (basic), 2 (production) or 3 (SRE)',
});

export const FEATURE_FLAGS = {
  logs: { level: 1, description: 'Collect application logs' },
  hostMetrics: { level: 1, description: 'CPU, memory, disk and network metrics for the host' },
  httpMetrics: { level: 1, description: 'Request rate, error rate and latency for HTTP services' },
  basicAlerts: {
    level: 1,
    description: 'Alerts for errors, latency, missing telemetry and host resources',
  },
  basicDashboards: { level: 1, description: 'Overview, service and infrastructure dashboards' },
  traces: { level: 2, description: 'Distributed tracing' },
  traceLogCorrelation: { level: 2, description: 'Link logs and traces via trace and span IDs' },
  serviceGraph: { level: 2, description: 'Service dependency map derived from traces' },
  goldenSignalDashboards: { level: 2, description: 'Golden-signal and RED dashboards per service' },
  databaseMonitoring: { level: 2, description: 'Database integrations (PostgreSQL, MySQL, Redis)' },
  slos: { level: 3, description: 'SLIs, SLOs, error budgets and burn-rate alerts' },
  ownershipRouting: { level: 3, description: 'Route alerts to the owning team' },
  runbookLinks: { level: 3, description: 'Attach runbook links to alerts and SLOs' },
} as const satisfies Record<string, { level: Level; description: string }>;

export type FeatureFlag = keyof typeof FEATURE_FLAGS;
export type FeatureFlags = Record<FeatureFlag, boolean>;

const flagNames = Object.keys(FEATURE_FLAGS) as [FeatureFlag, ...FeatureFlag[]];

export const featureOverrides = z.strictObject(
  Object.fromEntries(flagNames.map((flag) => [flag, z.boolean().optional()])) as Record<
    FeatureFlag,
    z.ZodOptional<z.ZodBoolean>
  >,
);

export function presetFor(lvl: Level): FeatureFlags {
  return Object.fromEntries(
    flagNames.map((flag) => [flag, FEATURE_FLAGS[flag].level <= lvl]),
  ) as FeatureFlags;
}
