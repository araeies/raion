import { z } from 'zod';
import {
  API_VERSION,
  duration,
  metadata,
  name,
  objectivePercent,
  parseDuration,
} from './common.js';

const DAY_MS = 86_400_000;

/** Rolling SLO window. Bounded so retention and query cost stay predictable. */
export const sloWindow = duration.refine(
  (value) => {
    const ms = parseDuration(value);
    return ms !== undefined && ms >= DAY_MS && ms <= 90 * DAY_MS && ms % DAY_MS === 0;
  },
  { message: 'SLO window must be a whole number of days between 1d and 90d (e.g. "28d" or "30d")' },
);

const availabilitySli = z.strictObject({
  type: z.literal('availability'),
});

const latencySli = z.strictObject({
  type: z.literal('latency'),
  /** Requests faster than this count as "good". */
  thresholdMs: z.number().int().positive().max(600_000),
});

/**
 * Throughput: the share of 5-minute intervals in which the service handled at least this many
 * requests per second. A time-based SLI, useful for pipelines that must keep up with a rate.
 */
const throughputSli = z.strictObject({
  type: z.literal('throughput'),
  minRequestsPerSecond: z.number().positive().max(1_000_000),
});

/** Advanced escape hatch: user-supplied PromQL. Exactly one of `good` or `bad` is required. */
const customSli = z
  .strictObject({
    type: z.literal('custom'),
    good: z.string().min(1).optional(),
    bad: z.string().min(1).optional(),
    total: z.string().min(1),
  })
  .refine((sli) => (sli.good === undefined) !== (sli.bad === undefined), {
    message: 'a custom SLI needs exactly one of "good" or "bad", plus "total"',
  });

export const SLI_TYPES = ['availability', 'latency', 'throughput', 'custom'] as const;

export const sli = z.discriminatedUnion(
  'type',
  [availabilitySli, latencySli, throughputSli, customSli],
  {
    error: (issue) => {
      const type = (issue.input as { type?: unknown } | undefined)?.type;
      if (type === 'error-rate') {
        return `use type "availability" for an error-rate objective (good = non-5xx responses). Supported types: ${SLI_TYPES.join(', ')}`;
      }
      return `SLI type must be one of: ${SLI_TYPES.join(', ')}`;
    },
  },
);

const sloBody = {
  description: z.string().max(1024).optional(),
  sli,
  target: objectivePercent,
  window: sloWindow.default('30d'),
  /**
   * What the team does when the error budget is spent, e.g. "freeze feature releases until the
   * budget recovers". Shown with the SLO and in its alerts.
   */
  policy: z.string().max(2000).optional(),
};

/** An SLO written inside a Service (`spec.slos[]`). */
export const inlineSlo = z.strictObject({ name, ...sloBody });

/** A standalone SLO document (`kind: SLO`), used in split GitOps layouts. */
export const sloDocument = z.strictObject({
  apiVersion: z.literal(API_VERSION),
  kind: z.literal('SLO'),
  metadata,
  spec: z.strictObject({ service: name, ...sloBody }),
});

export type Sli = z.output<typeof sli>;
export type InlineSlo = z.output<typeof inlineSlo>;
export type SloDocument = z.output<typeof sloDocument>;
