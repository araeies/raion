import { z } from 'zod';

/** Every check the Observability Advisor runs. Listed here so `advisor.ignore` is validated. */
export const ADVISOR_RULES = [
  'critical-service-without-slo',
  'busiest-service-without-slo',
  'slos-not-evaluated',
  'service-without-alerts',
  'service-without-golden-signals',
  'page-alert-without-runbook',
  'database-not-monitored',
  'dependencies-not-traced',
  'undeclared-dependency',
  'unused-dependency',
  'low-log-trace-correlation',
  'collector-dropping-telemetry',
  'high-cardinality-metric',
] as const;

export type AdvisorRule = (typeof ADVISOR_RULES)[number];

/** Workspace settings of the Observability Advisor. */
export const advisorSettings = z.strictObject({
  /**
   * Findings the team has decided not to act on. Kept in Git, with the reason, so the
   * decision is visible to everyone instead of living in one person's browser.
   */
  ignore: z
    .array(
      z.strictObject({
        rule: z.enum(ADVISOR_RULES, {
          error: `rule must be one of: ${ADVISOR_RULES.join(', ')}`,
        }),
        /** What the finding is about (a service, metric or dependency). Omit to ignore the rule entirely. */
        subject: z.string().min(1).max(253).optional(),
        reason: z.string().trim().min(1, 'say why the finding is ignored').max(500),
      }),
    )
    .default([]),
});

export type AdvisorSettings = z.output<typeof advisorSettings>;
