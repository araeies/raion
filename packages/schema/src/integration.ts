import { z } from 'zod';
import { API_VERSION, name } from './common.js';
import { LANGUAGES } from './service.js';

/**
 * Integration packages are data, not code: a manifest plus documentation. Raion never
 * executes anything from an integration. Values may contain ${placeholders}, which are
 * substituted into string values only, after parsing (see core/integrations.ts).
 */

export const CAPABILITIES = [
  'http.server',
  'http.client',
  'logs.otlp',
  'traces.otlp',
  'runtime.nodejs',
  'database.postgresql',
  'cache.redis',
  'proxy.nginx',
] as const;
export type CapabilityId = (typeof CAPABILITIES)[number];

const promName = z
  .string()
  .regex(/^[a-zA-Z_:][a-zA-Z0-9_:]*$/, 'must be a Prometheus metric or label name');

const histogramMetric = z.strictObject({
  name: promName,
  type: z.literal('histogram'),
  unit: z.enum(['seconds']),
  /** Canonical role -> label name actually emitted. */
  labels: z.strictObject({
    method: promName.optional(),
    status: promName,
    route: promName.optional(),
  }),
  /** Histogram bucket boundaries (in `unit`) the instrumentation emits by default. */
  buckets: z.array(z.number().positive()).min(1),
});

const capability = z.discriminatedUnion('id', [
  z.strictObject({
    id: z.literal('http.server'),
    metrics: z.strictObject({ requestDuration: histogramMetric }),
  }),
  z.strictObject({
    id: z.literal('http.client'),
    metrics: z.strictObject({ requestDuration: histogramMetric }),
  }),
  z.strictObject({ id: z.literal('logs.otlp') }),
  z.strictObject({ id: z.literal('traces.otlp') }),
  z.strictObject({ id: z.literal('runtime.nodejs') }),
  z.strictObject({ id: z.literal('database.postgresql') }),
  z.strictObject({ id: z.literal('cache.redis') }),
  z.strictObject({ id: z.literal('proxy.nginx') }),
]);

/**
 * Receivers of the OpenTelemetry Collector that integrations may use. Their configuration is
 * built by Raion's own code from the integration's parameters, never copied from a manifest,
 * so an integration cannot add arbitrary collector configuration.
 */
export const COLLECTOR_RECEIVERS = ['postgresql', 'redis', 'nginx'] as const;
export type CollectorReceiver = (typeof COLLECTOR_RECEIVERS)[number];

/** Parameter names are camelCase identifiers, e.g. esmHook. */
const paramName = z.string().regex(/^[a-z][a-zA-Z0-9]{0,62}$/, 'must be a camelCase identifier');

/**
 * Formats a string parameter may require; checked when a service sets it. None of them allows
 * "$", because the collector would expand ${...} in a value (e.g. ${file:...}).
 */
export const STRING_FORMATS = ['hostPort', 'url', 'identifier'] as const;

const parameter = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('boolean'),
    default: z.boolean(),
    description: z.string().max(500),
  }),
  z.strictObject({
    type: z.literal('string'),
    format: z.enum(STRING_FORMATS),
    default: z.string().max(500).optional(),
    required: z.boolean().default(false),
    description: z.string().max(500),
  }),
  /** A credential: services must pass a ${secret:NAME} or ${env:NAME} reference, never a value. */
  z.strictObject({
    type: z.literal('secret'),
    required: z.boolean().default(false),
    description: z.string().max(500),
  }),
]);

export type IntegrationParameter = z.output<typeof parameter>;
export type ParamValue = boolean | string;

/** A condition on a boolean parameter. */
const when = z.strictObject({ param: paramName, equals: z.boolean() });

/** What the user must do once. Shown to the user; Raion never runs install commands. */
const requirement = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('packages'),
    manager: z.enum(['npm', 'pip', 'go']),
    packages: z.array(z.string().regex(/^(@[a-z0-9-]+\/)?[a-zA-Z0-9._/-]+$/)).min(1),
    description: z.string().max(500),
    /** Only needed when this condition holds (e.g. not when the agent is injected). */
    when: when.optional(),
  }),
  /** A change to how the application is started, e.g. "opentelemetry-instrument python app.py". */
  z.strictObject({
    kind: z.literal('command'),
    description: z.string().max(500),
    when: when.optional(),
  }),
  /** A code change, explained in the integration's documentation. */
  z.strictObject({
    kind: z.literal('code'),
    description: z.string().max(500),
    when: when.optional(),
  }),
  /** Something to set up in the monitored system, e.g. a read-only monitoring user. */
  z.strictObject({
    kind: z.literal('setup'),
    description: z.string().max(1000),
    when: when.optional(),
  }),
]);

/**
 * OpenTelemetry agents Raion can add to a container when it starts, so the application's image
 * needs no change. The images themselves are pinned by Raion (never named by a package), so an
 * integration can only choose among these.
 */
export const AGENTS = ['nodejs', 'python', 'java'] as const;
export type AgentName = (typeof AGENTS)[number];

/** Where the copied agent appears inside the application's container. */
export const AGENT_MOUNT = '/otel-auto-instrumentation';

const agentPath = z
  .string()
  .regex(/^\/[A-Za-z0-9/_.-]+$/, 'must be an absolute path inside the agent image');

const envValue = z.union([
  z.string().max(2000),
  /** Alternatives chosen by boolean parameters; the first matching case wins. */
  z.strictObject({
    cases: z
      .array(
        z.strictObject({
          when: z.strictObject({ param: paramName, equals: z.boolean() }).optional(),
          value: z.string().max(2000),
        }),
      )
      .min(1),
  }),
]);

export const integrationManifest = z.strictObject({
  apiVersion: z.literal(API_VERSION),
  kind: z.literal('Integration'),
  metadata: z.strictObject({
    name,
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
  }),
  spec: z.strictObject({
    kind: z.enum(['application', 'infrastructure', 'database', 'edge', 'cloud', 'platform']),
    displayName: z.string().max(100),
    description: z.string().max(1000),
    /** Languages this integration instruments; a service with one of these languages uses it by default. */
    languages: z.array(z.enum(LANGUAGES)).default([]),
    parameters: z.record(paramName, parameter).default({}),
    requirements: z.array(requirement).default([]),
    instrumentation: z
      .strictObject({
        /** Environment variables for the instrumented process, in the order they are emitted. */
        env: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), envValue),
        /**
         * An agent copied into the container when it starts (Docker Compose only), from one of
         * Raion's pinned agent images. `path` is what is copied, e.g. "/autoinstrumentation/.".
         */
        agent: z
          .strictObject({
            image: z.enum(AGENTS),
            path: z.union([
              agentPath,
              z.strictObject({
                cases: z.array(z.strictObject({ when: when.optional(), value: agentPath })).min(1),
              }),
            ]),
            when: when.optional(),
          })
          .optional(),
      })
      .optional(),
    /** Telemetry the collector pulls from the system (databases, proxies), instead of the app pushing it. */
    collector: z.strictObject({ receiver: z.enum(COLLECTOR_RECEIVERS) }).optional(),
    capabilities: z.array(capability).default([]),
    /** Documentation file inside the package. */
    docs: z.string().regex(/^[A-Za-z0-9_.-]+\.md$/),
  }),
});

export type IntegrationManifest = z.output<typeof integrationManifest>;
export type IntegrationCapability = IntegrationManifest['spec']['capabilities'][number];
export type HistogramMetric = z.output<typeof histogramMetric>;
