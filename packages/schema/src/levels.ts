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
  basicAlerts: {
    level: 1,
    description: 'Alerts for errors, latency, missing telemetry and host resources',
  },
  traces: { level: 2, description: 'Distributed tracing' },
  traceLogCorrelation: { level: 2, description: 'Link logs and traces via trace and span IDs' },
  serviceGraph: { level: 2, description: 'Service dependency map derived from traces' },
  slos: { level: 3, description: 'SLIs, SLOs, error budgets and burn-rate alerts' },
  ownershipRouting: { level: 3, description: 'Route alerts to the owning team' },
} as const satisfies Record<string, { level: Level; description: string }>;

export type FeatureFlag = keyof typeof FEATURE_FLAGS;
export type FeatureFlags = Record<FeatureFlag, boolean>;

const flagNames = Object.keys(FEATURE_FLAGS) as [FeatureFlag, ...FeatureFlag[]];

/**
 * Feature names that are no longer accepted, with what controls the behaviour instead. They
 * get a specific message rather than "unknown field".
 */
export const REMOVED_FEATURES = {
  hostMetrics: 'host metrics are controlled by infrastructure.host',
  httpMetrics:
    "HTTP metrics come from the service's integration; signals.metrics turns metrics off",
  basicDashboards: 'dashboards are always generated',
  goldenSignalDashboards: "golden-signal panels come from the service's integration",
  databaseMonitoring: 'databases are monitored through their integration (e.g. postgresql)',
  runbookLinks: 'runbook links are added whenever runbooks are set',
} as const;

export const featureOverrides = z.strictObject({
  ...(Object.fromEntries(flagNames.map((flag) => [flag, z.boolean().optional()])) as Record<
    FeatureFlag,
    z.ZodOptional<z.ZodBoolean>
  >),
  ...(Object.fromEntries(
    Object.entries(REMOVED_FEATURES).map(([name, instead]) => [
      name,
      z
        .never({ error: `"${name}" is no longer a feature switch: ${instead}. Remove it.` })
        .optional(),
    ]),
  ) as Record<keyof typeof REMOVED_FEATURES, z.ZodOptional<z.ZodNever>>),
});

export function presetFor(lvl: Level): FeatureFlags {
  return Object.fromEntries(
    flagNames.map((flag) => [flag, FEATURE_FLAGS[flag].level <= lvl]),
  ) as FeatureFlags;
}
