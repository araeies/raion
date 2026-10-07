import { z } from 'zod';
import { API_VERSION, duration, metadata, name, secretRef } from './common.js';
import { advisorSettings } from './advisor.js';
import { featureOverrides, level } from './levels.js';
import { inlineService } from './service.js';

/** The built-in receiver: alerts are delivered to the Raion alert inbox. Always present. */
export const INBOX_RECEIVER = 'inbox';

const receiverName = name.refine((value) => value !== INBOX_RECEIVER, {
  message: `"${INBOX_RECEIVER}" is the built-in Raion alert inbox and cannot be redefined`,
});

const receiver = z.discriminatedUnion(
  'type',
  [
    z.strictObject({
      name: receiverName,
      type: z.literal('slack'),
      /** Slack incoming-webhook URLs are credentials, so only a secret reference is accepted. */
      webhookUrl: secretRef,
      channel: z
        .string()
        .regex(/^#?[a-z0-9._-]{1,80}$/)
        .optional(),
    }),
    z.strictObject({
      name: receiverName,
      type: z.literal('email'),
      to: z.array(z.email()).min(1),
      from: z.email(),
      smarthost: z
        .string()
        .regex(/^[A-Za-z0-9.-]+:\d{1,5}$/, 'must be host:port, e.g. "smtp.example.com:587"'),
      username: z.string().max(256).optional(),
      password: secretRef.optional(),
    }),
    z.strictObject({
      name: receiverName,
      type: z.literal('webhook'),
      url: z.union([z.url({ protocol: /^https?$/ }), secretRef]),
      bearerToken: secretRef.optional(),
    }),
  ],
  { error: 'receiver type must be one of: slack, email, webhook' },
);

const port = z.number().int().min(1024, 'use a port of 1024 or above').max(65535);

const retention = z.strictObject({
  /** Raised automatically to cover the longest SLO window. */
  metrics: duration.default('15d'),
  logs: duration.default('7d'),
  traces: duration.default('3d'),
});

const team = z.strictObject({
  name,
  /** Receiver that gets this team's alerts. Defaults to the built-in inbox. */
  route: name.optional(),
  contacts: z.array(z.string().max(256)).optional(),
});

const target = z.discriminatedUnion(
  'type',
  [
    z.strictObject({
      type: z.literal('docker-compose'),
      compose: z
        .strictObject({
          projectName: name.default('raion'),
          /**
           * Loopback port of the Raion gateway, the only way into the stack. It requires a
           * secret that only the Raion server and CLI hold.
           */
          gatewayPort: port.default(7601),
          /** Loopback ports where applications running on this host send OpenTelemetry data. */
          otlpGrpcPort: port.default(4317),
          otlpHttpPort: port.default(4318),
          /** Loopback port where Docker forwards container logs (services with containerLogs). */
          fluentForwardPort: port.default(24224),
        })
        .prefault({}),
    }),
  ],
  {
    error: 'target.type must be "docker-compose" (Raion deploys the stack with Docker Compose)',
  },
);

export const workspaceSpec = z.strictObject({
  level: level.default(1),
  environment: name.default('production'),
  target: target.prefault({ type: 'docker-compose' }),
  /** How long telemetry is kept. */
  retention: retention.prefault({}),
  server: z
    .strictObject({
      /** The URL people use to open Raion. Grafana is served under <publicUrl>/grafana/. */
      publicUrl: z.url({ protocol: /^https?$/ }).default('http://127.0.0.1:7600'),
    })
    .prefault({}),
  infrastructure: z
    .strictObject({
      /** Host metrics via node_exporter. */
      host: z.boolean().default(true),
      /** Container metrics via cAdvisor. Off by default because cAdvisor needs elevated privileges. */
      containers: z.boolean().default(false),
    })
    .default({ host: true, containers: false }),
  features: featureOverrides.optional(),
  notifications: z
    .strictObject({
      receivers: z.array(receiver).default([]),
      /**
       * Where alerts go that no team route claims. Every alert is also visible in the Raion
       * inbox, whatever its route.
       */
      defaultReceiver: name.optional(),
    })
    .default({ receivers: [] }),
  teams: z.array(team).default([]),
  /** Single-file form: services declared inline instead of as separate `kind: Service` documents. */
  services: z.array(inlineService).default([]),
  /** Settings of the Observability Advisor (`raion advise`). */
  advisor: advisorSettings.prefault({}),
});

export const workspaceDocument = z.strictObject({
  apiVersion: z.literal(API_VERSION),
  kind: z.literal('Workspace'),
  metadata,
  spec: workspaceSpec.default(workspaceSpec.parse({})),
});

export type WorkspaceSpec = z.output<typeof workspaceSpec>;
export type WorkspaceDocument = z.output<typeof workspaceDocument>;
export type Receiver = z.output<typeof receiver>;
export type Team = z.output<typeof team>;
