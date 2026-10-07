import {
  interpolate,
  registryFor,
  type IntegrationRegistry,
  type IntegrationVariable,
} from './integrations.js';
import type { ResolvedService, ResolvedWorkspace } from './model.js';
import { ingestNetworkName } from './runtime/compose.js';
import { toYaml } from './runtime/yaml.js';

export interface Requirement {
  kind: 'packages' | 'command' | 'code' | 'setup';
  description: string;
  packages?: string[];
  /** Suggested install command. Shown to the user; Raion never runs it. */
  command?: string;
}

const INSTALL: Record<'npm' | 'pip' | 'go', string> = {
  npm: 'npm install',
  pip: 'pip install',
  go: 'go get',
};

/** Everything needed to connect one service to the observability stack. */
export interface ServiceConnection {
  service: string;
  runtime: 'compose' | 'host';
  /** Name of the service in the user's compose file (compose runtime only). */
  composeService?: string;
  integration?: { name: string; displayName: string; implicit: boolean };
  /**
   * push: the service sends telemetry (environment variables configure its SDK).
   * pull: the collector reads the service's metrics (databases, proxies); the service only
   * has to be reachable from the collector.
   */
  mode?: 'push' | 'pull';
  /** False when no integration can instrument this service yet. */
  supported: boolean;
  /** Environment variables, in a stable order. */
  env: [string, string][];
  /** Docker logging driver that sends the container's stdout/stderr to the collector. */
  logging?: { driver: 'fluentd'; options: Record<string, string> };
  requirements: Requirement[];
  notes: string[];
}

function variables(
  ws: ResolvedWorkspace,
  svc: ResolvedService,
): Record<IntegrationVariable, string> {
  const inCompose = svc.runtime.type === 'compose';
  const { otlpGrpcPort, otlpHttpPort } = ws.target.compose;
  const exporter = (on: boolean) => (on ? 'otlp' : 'none');
  return {
    'service.name': svc.name,
    'service.namespace': ws.name,
    environment: ws.environment,
    // Names are DNS labels, so no value needs percent-encoding.
    'resource.attributes': `service.namespace=${ws.name},deployment.environment.name=${ws.environment}`,
    'otlp.httpEndpoint': inCompose
      ? 'http://otel-collector:4318'
      : `http://127.0.0.1:${otlpHttpPort}`,
    'otlp.grpcEndpoint': inCompose
      ? 'http://otel-collector:4317'
      : `http://127.0.0.1:${otlpGrpcPort}`,
    'signals.metrics': exporter(svc.signals.metrics),
    'signals.logs': exporter(svc.signals.logs && svc.features.logs),
    'signals.traces': exporter(svc.signals.traces && svc.features.traces),
  };
}

/** The logging driver for a service with containerLogs (Compose only). */
function containerLogging(
  ws: ResolvedWorkspace,
  svc: ResolvedService,
): ServiceConnection['logging'] {
  if (!svc.containerLogs || svc.runtime.type !== 'compose') return undefined;
  return {
    driver: 'fluentd',
    options: {
      // Docker connects from the host, where the collector listens on loopback only.
      'fluentd-address': `127.0.0.1:${ws.target.compose.fluentForwardPort}`,
      // Never block or fail the container when the collector is down; "docker logs" keeps working.
      'fluentd-async': 'true',
      tag: svc.name,
    },
  };
}

export function connectService(
  ws: ResolvedWorkspace,
  svc: ResolvedService,
  registry: IntegrationRegistry = registryFor(ws),
): ServiceConnection {
  const runtime = svc.runtime.type;
  const base = {
    service: svc.name,
    runtime,
    ...(svc.runtime.type === 'compose'
      ? { composeService: svc.runtime.composeService ?? svc.name }
      : {}),
  };
  const ref = svc.integrations.find((i) => {
    const spec = registry.get(i.name)?.manifest.spec;
    return spec?.instrumentation ?? spec?.collector;
  });
  const logging = containerLogging(ws, svc);
  if (!ref) {
    return {
      ...base,
      supported: false,
      env: [],
      ...(logging ? { logging } : {}),
      requirements: [],
      notes: [
        svc.language && !registry.defaultFor(svc.language)
          ? `There is no ${svc.language} integration yet. Until then, instrument the service with the OpenTelemetry SDK for ${svc.language} and send OTLP to ${variables(ws, svc)['otlp.httpEndpoint']}.`
          : `Set "language" on service "${svc.name}" (for example "nodejs") so Raion can choose an integration.`,
      ],
    };
  }

  const manifest = registry.get(ref.name)!.manifest;
  const vars = variables(ws, svc);
  const env: [string, string][] = [];
  for (const [key, value] of Object.entries(manifest.spec.instrumentation?.env ?? {})) {
    const template =
      typeof value === 'string'
        ? value
        : value.cases.find((c) => !c.when || ref.params[c.when.param] === c.when.equals)?.value;
    if (template !== undefined) env.push([key, interpolate(template, vars)]);
  }

  const notes: string[] = [];
  if (env.some(([key]) => key === 'NODE_OPTIONS')) {
    notes.push(
      'NODE_OPTIONS is set by Raion. If your service already sets NODE_OPTIONS, combine both values.',
    );
  }
  const pull = manifest.spec.collector !== undefined;
  if (pull) {
    notes.push(
      svc.runtime.type === 'compose'
        ? "The collector reads this service's metrics over the observability network; the override only connects the container to it."
        : 'The collector reads this service\'s metrics. For a service on this computer, use host.docker.internal as the host in "endpoint".',
    );
  }
  if (logging) {
    notes.push(
      "Docker sends this container's output to the collector (fluentd logging driver); docker logs keeps working.",
    );
  }
  if (!pull && !svc.features.traces) {
    notes.push(
      `Tracing is off for this service (level ${svc.level}); set level 2 or features.traces to turn it on.`,
    );
  }

  return {
    ...base,
    integration: { name: ref.name, displayName: manifest.spec.displayName, implicit: ref.implicit },
    mode: pull ? 'pull' : 'push',
    supported: true,
    env,
    ...(logging ? { logging } : {}),
    requirements: manifest.spec.requirements.map((r) =>
      r.kind === 'packages'
        ? {
            kind: r.kind,
            description: r.description,
            packages: r.packages,
            command: `${INSTALL[r.manager]} ${r.packages.join(' ')}`,
          }
        : { kind: r.kind, description: r.description },
    ),
    notes,
  };
}

/**
 * A Docker Compose override file that connects the user's own services, without editing
 * their compose file: docker compose -f compose.yaml -f observability.override.yaml up -d
 */
export function composeOverride(
  ws: ResolvedWorkspace,
  connections: readonly ServiceConnection[],
): string {
  const network = ingestNetworkName(ws.target.compose.projectName);
  const services: Record<string, unknown> = {};
  for (const c of connections) {
    if (c.runtime !== 'compose' || !(c.supported || c.logging)) continue;
    services[c.composeService!] = {
      ...(c.logging ? { logging: c.logging } : {}),
      // Compose interpolates "$", so literal dollars are escaped.
      ...(c.env.length > 0
        ? { environment: Object.fromEntries(c.env.map(([k, v]) => [k, v.replaceAll('$', '$$$$')])) }
        : {}),
      // Listing "default" keeps the service on its project network; Compose replaces the
      // service's network list when an override defines one.
      networks: { default: {}, [network]: {} },
    };
  }
  return toYaml(
    { services, networks: { [network]: { external: true, name: network } } },
    `Raion: connects your services to the observability stack (workspace "${ws.name}").
Generated by "raion connect". Regenerate it after changing services; do not edit.
Use it next to your own compose file:
  docker compose -f compose.yaml -f observability.override.yaml up -d`,
  );
}

/** KEY=value lines (dotenv / docker --env-file format). */
export function envFile(connection: ServiceConnection): string {
  return `${connection.env.map(([k, v]) => `${k}=${v}`).join('\n')}\n`;
}

/** POSIX shell export lines, safely single-quoted. */
export function shellExports(connection: ServiceConnection): string {
  return `${connection.env.map(([k, v]) => `export ${k}='${v.replaceAll("'", "'\\''")}'`).join('\n')}\n`;
}
