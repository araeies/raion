import { z } from 'zod';
import { API_VERSION, duration, metadata, name, parseDuration } from './common.js';
import { featureOverrides, level } from './levels.js';
import { inlineSlo } from './slo.js';

export const SERVICE_TYPES = [
  'web',
  'api',
  'worker',
  'database',
  'microservice',
  'infrastructure',
] as const;
export const LANGUAGES = ['nodejs', 'python', 'go', 'java', 'dotnet', 'php', 'other'] as const;
export const TIERS = ['critical', 'standard', 'best-effort'] as const;

const runtime = z.discriminatedUnion(
  'type',
  [
    z.strictObject({
      type: z.literal('compose'),
      /** The service name inside the user's own compose file. Defaults to the Raion service name. */
      composeService: name.optional(),
    }),
    z.strictObject({ type: z.literal('host') }),
  ],
  {
    error: 'runtime.type must be "compose" (Docker Compose) or "host" (a process on this machine)',
  },
);

const integrationRef = z.union([
  name,
  z.strictObject({
    name,
    version: z.string().max(64).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
  }),
]);

const dependency = z.union([
  z.strictObject({ service: name }),
  z.strictObject({
    external: z.strictObject({
      name,
      kind: z
        .string()
        .regex(/^[a-z][a-z0-9-]{0,62}$/, 'must be a lowercase kind such as "postgresql"'),
    }),
  }),
]);

const runbook = z
  .strictObject({
    slo: name.optional(),
    alert: z.string().max(128).optional(),
    url: z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' }),
  })
  .refine((rb) => rb.slo !== undefined || rb.alert !== undefined, {
    message: 'a runbook must reference an "slo" or an "alert"',
  });

const alertDuration = duration.refine(
  (value) => {
    const ms = parseDuration(value);
    return ms !== undefined && ms >= 60_000 && ms <= 86_400_000;
  },
  { message: 'must be between 1m and 24h' },
);

/** Thresholds of the service's generated alerts. Every field has a sensible default. */
export const serviceAlerts = z.strictObject({
  /** Turn this service's alerts off entirely. */
  enabled: z.boolean().default(true),
  /** Alert when more than this percentage of requests fail with HTTP 5xx. */
  errorRatePercent: z.number().gt(0).lt(100).default(5),
  /** Alert when the 95th-percentile response time is above this. */
  latencyP95Ms: z.number().int().positive().max(600_000).default(1000),
  /** How long a condition must hold before the alert fires (avoids alerts for blips). */
  for: alertDuration.default('5m'),
  /** Alert when a service that was sending telemetry stops. */
  missingTelemetry: z.boolean().default(true),
});

/** Fields shared by `kind: Service` documents and inline `services[]` entries in a Workspace. */
export const serviceSpec = z.strictObject({
  team: name.optional(),
  owner: z.string().max(256).optional(),
  description: z.string().max(1024).optional(),
  environment: name.optional(),
  tier: z.enum(TIERS).default('standard'),
  type: z.enum(SERVICE_TYPES),
  language: z.enum(LANGUAGES).optional(),
  repository: z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' }).optional(),
  runtime: runtime.optional(),
  /**
   * Collect what the container writes to stdout and stderr (Compose only). For services that
   * do not send logs themselves, such as Nginx or PostgreSQL. "raion connect" points the
   * container's Docker logging driver at the collector; no privileges are needed.
   */
  containerLogs: z.boolean().default(false),
  level: level.optional(),
  features: featureOverrides.optional(),
  integrations: z.array(integrationRef).default([]),
  signals: z
    .strictObject({
      metrics: z.boolean().default(true),
      logs: z.boolean().default(true),
      traces: z.boolean().default(true),
    })
    .default({ metrics: true, logs: true, traces: true }),
  dependencies: z.array(dependency).default([]),
  slos: z.array(inlineSlo).default([]),
  runbooks: z.array(runbook).default([]),
  alerts: serviceAlerts.prefault({}),
});

export const serviceDocument = z.strictObject({
  apiVersion: z.literal(API_VERSION),
  kind: z.literal('Service'),
  metadata,
  spec: serviceSpec,
});

/** Inline form used in single-file workspaces: `services: [{ name: payment-api, type: api, ... }]`. */
export const inlineService = serviceSpec.extend({ name });

export type ServiceSpec = z.output<typeof serviceSpec>;
export type ServiceDocument = z.output<typeof serviceDocument>;
export type InlineService = z.output<typeof inlineService>;
export type Dependency = z.output<typeof dependency>;
export type IntegrationRef = z.output<typeof integrationRef>;
