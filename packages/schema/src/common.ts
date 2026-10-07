import { z } from 'zod';

export const API_VERSION = 'raion/v1alpha1';

/**
 * Names become Prometheus label values, Grafana UIDs, file names and Compose service
 * names, so they are restricted to DNS labels (RFC 1123). This also keeps them safe to
 * interpolate anywhere without escaping surprises.
 */
export const DNS_LABEL = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

export const name = z
  .string()
  .regex(
    DNS_LABEL,
    'must be lowercase letters, digits and hyphens, start with a letter, and be at most 63 characters (e.g. "payment-api")',
  );

export const metadata = z.strictObject({
  name,
  description: z.string().max(1024).optional(),
  labels: z.record(z.string().regex(/^[a-z][a-z0-9_.-]{0,62}$/), z.string().max(256)).optional(),
});

const DURATION = /^(\d+)(ms|s|m|h|d|w)$/;
const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;

/** Parses "500ms", "5m", "30d" etc. into milliseconds. Returns undefined when invalid. */
export function parseDuration(input: string): number | undefined {
  const match = DURATION.exec(input);
  if (!match) return undefined;
  const [, amount, unit] = match;
  return Number(amount) * UNIT_MS[unit as keyof typeof UNIT_MS];
}

/** A duration string such as "30d". Kept as a string in the model (it is what users wrote). */
export const duration = z
  .string()
  .regex(DURATION, 'must be a duration such as "500ms", "5m", "1h" or "30d"');

/**
 * Percentages may be written as 99.9 or "99.9%". Both normalize to the number 99.9.
 * Exclusive bounds: a 100% objective leaves no error budget, so it can never be met.
 */
export const objectivePercent = z
  .union([
    z.number(),
    z.string().regex(/^\d+(\.\d+)?%?$/, 'must be a percentage such as 99.9 or "99.9%"'),
  ])
  .transform((value) => (typeof value === 'number' ? value : Number(value.replace('%', ''))))
  .pipe(
    z
      .number()
      .gt(0, 'must be greater than 0%')
      .lt(100, 'must be below 100% (a 100% objective leaves no error budget and can never be met)'),
  );

/**
 * A reference to a secret. Secret values are never accepted inline in configuration:
 *  - ${secret:NAME} is read from the Raion secret store (.raion/secrets/NAME)
 *  - ${env:NAME}    is read from the environment of the process running Raion
 */
export const SECRET_REF = /^\$\{(secret|env):([A-Z][A-Z0-9_]{0,127})\}$/;

export const secretRef = z
  .string()
  .regex(
    SECRET_REF,
    'must be a secret reference such as "${secret:SLACK_WEBHOOK}" or "${env:SMTP_PASSWORD}". Secret values are never stored in configuration files',
  );

export function parseSecretRef(ref: string): { source: 'secret' | 'env'; key: string } | undefined {
  const match = SECRET_REF.exec(ref);
  if (!match) return undefined;
  return { source: match[1] as 'secret' | 'env', key: match[2] as string };
}
