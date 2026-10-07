import { secretFileName, type SecretMount } from './alerts.js';
import { FLUENT_FORWARD_PORT } from './receivers.js';
import { imageRef, type ComponentId } from './images.js';
import type { Artifact, ComponentSpec } from './types.js';
import { GENERATED_HEADER, toYaml } from './yaml.js';

/** Network keys inside the Compose project. */
export const NETWORKS = {
  /** Backends only; no route to the internet. */
  backend: 'backend',
  /** Collector + user applications. Applications can reach the collector and nothing else. */
  ingest: 'ingest',
  /** Components that publish a loopback port or need outbound access (gateway, Alertmanager). */
  edge: 'edge',
} as const;

/**
 * Docker name of the ingest network. Fixed (not prefixed by Compose) so that application
 * Compose files can join it as an external network; includes the project name so several
 * Raion projects can share a host.
 */
export function ingestNetworkName(projectName: string): string {
  return `${projectName}-ingest`;
}

export interface ComposeOptions {
  /** Secrets Alertmanager receivers need (files, never inlined). */
  alertmanagerSecrets: SecretMount[];
  /** Credentials the collector needs to read databases (files, never inlined). */
  collectorSecrets: SecretMount[];
  /** A monitored service runs on the host: let the collector resolve host.docker.internal. */
  collectorHostAccess: boolean;
  /** Publish the Fluent Forward receiver on loopback, for Docker's fluentd logging driver. */
  fluentForwardPort?: number;
  projectName: string;
  gatewayPort: number;
  otlpGrpcPort: number;
  otlpHttpPort: number;
  metricsRetention: string;
  grafanaEnv: Record<string, string>;
}

type Service = Record<string, unknown>;

/** Security defaults applied to every container unless a component documents an exception. */
function hardened(
  component: ComponentId,
  extra: Service,
  opts: { readOnly?: boolean; memory: string },
): Service {
  return {
    image: imageRef(component),
    restart: 'unless-stopped',
    ...(opts.readOnly === false ? {} : { read_only: true }),
    tmpfs: ['/tmp'],
    cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'],
    mem_limit: opts.memory,
    labels: { 'dev.raion.component': component },
    logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
    ...extra,
  };
}

export function composeFile(components: ComponentSpec[], o: ComposeOptions): Artifact {
  const ids = new Set(components.map((c) => c.id));
  const services: Record<string, Service> = {};

  services['otel-collector'] = hardened(
    'otel-collector',
    {
      command: ['--config=/etc/otelcol/config.yaml'],
      volumes: ['./otel-collector:/etc/otelcol:ro'],
      ports: [
        `127.0.0.1:${o.otlpGrpcPort}:4317`,
        `127.0.0.1:${o.otlpHttpPort}:4318`,
        // Docker's logging driver connects from the host side, so this port is on loopback too.
        ...(o.fluentForwardPort ? [`127.0.0.1:${o.fluentForwardPort}:${FLUENT_FORWARD_PORT}`] : []),
      ],
      networks: [NETWORKS.backend, NETWORKS.ingest],
      ...(o.collectorSecrets.length > 0
        ? { secrets: o.collectorSecrets.map((m) => m.composeName) }
        : {}),
      // Built into Docker Desktop; on Linux this maps the name to the host's gateway address.
      ...(o.collectorHostAccess ? { extra_hosts: ['host.docker.internal:host-gateway'] } : {}),
    },
    { memory: '512m' },
  );

  services.prometheus = hardened(
    'prometheus',
    {
      command: [
        '--config.file=/etc/prometheus/prometheus.yml',
        '--storage.tsdb.path=/prometheus',
        `--storage.tsdb.retention.time=${o.metricsRetention}`,
        '--web.enable-otlp-receiver',
        '--web.enable-lifecycle',
      ],
      volumes: ['./prometheus:/etc/prometheus:ro', 'prometheus-data:/prometheus'],
      networks: [NETWORKS.backend],
    },
    { memory: '1g' },
  );

  services.loki = hardened(
    'loki',
    {
      command: ['-config.file=/etc/loki/loki.yaml'],
      volumes: ['./loki:/etc/loki:ro', 'loki-data:/loki'],
      networks: [NETWORKS.backend],
    },
    { memory: '1g' },
  );

  if (ids.has('tempo')) {
    services.tempo = hardened(
      'tempo',
      {
        command: ['-config.file=/etc/tempo/tempo.yaml'],
        volumes: ['./tempo:/etc/tempo:ro', 'tempo-data:/var/tempo'],
        networks: [NETWORKS.backend],
      },
      { memory: '1g' },
    );
  }

  services.grafana = hardened(
    'grafana',
    {
      environment: o.grafanaEnv,
      volumes: [
        './grafana/provisioning:/etc/grafana/provisioning:ro',
        'grafana-data:/var/lib/grafana',
      ],
      secrets: ['grafana_admin_password'],
      networks: [NETWORKS.backend],
    },
    { memory: '512m' },
  );

  services.alertmanager = hardened(
    'alertmanager',
    {
      command: [
        '--config.file=/etc/alertmanager/alertmanager.yml',
        '--storage.path=/alertmanager',
        // Single instance: disable clustering (gossip) entirely.
        '--cluster.listen-address=',
      ],
      volumes: ['./alertmanager:/etc/alertmanager:ro', 'alertmanager-data:/alertmanager'],
      ...(o.alertmanagerSecrets.length > 0
        ? { secrets: o.alertmanagerSecrets.map((m) => m.composeName) }
        : {}),
      // Edge network: outbound access for Slack, email and webhook receivers.
      networks: [NETWORKS.backend, NETWORKS.edge],
    },
    { memory: '256m' },
  );

  if (ids.has('node-exporter')) {
    services['node-exporter'] = hardened(
      'node-exporter',
      {
        command: ['--path.rootfs=/host'],
        // Documented exception: host PID namespace and a read-only view of the host filesystem.
        pid: 'host',
        // No mount propagation (rslave): not supported by Docker Desktop. Filesystems mounted
        // after node-exporter starts are picked up on its next restart.
        volumes: ['/:/host:ro'],
        networks: [NETWORKS.backend],
      },
      { memory: '128m' },
    );
  }

  if (ids.has('cadvisor')) {
    services.cadvisor = {
      // Documented exception: cAdvisor needs privileged access to read container statistics.
      // Only deployed when infrastructure.containers is true and --allow-privileged is given.
      image: imageRef('cadvisor'),
      restart: 'unless-stopped',
      privileged: true,
      devices: ['/dev/kmsg'],
      command: ['--docker_only=true', '--housekeeping_interval=30s'],
      volumes: [
        '/:/rootfs:ro',
        '/var/run:/var/run:ro',
        '/sys:/sys:ro',
        '/var/lib/docker/:/var/lib/docker:ro',
        '/dev/disk/:/dev/disk:ro',
      ],
      mem_limit: '256m',
      labels: { 'dev.raion.component': 'cadvisor' },
      networks: [NETWORKS.backend],
    };
  }

  services.gateway = hardened(
    'gateway',
    {
      command: ['nginx', '-c', '/etc/nginx/raion/nginx.conf', '-g', 'daemon off;'],
      volumes: ['./gateway:/etc/nginx/raion:ro'],
      secrets: ['gateway_auth.conf'],
      ports: [`127.0.0.1:${o.gatewayPort}:8080`],
      networks: [NETWORKS.backend, NETWORKS.edge],
      healthcheck: {
        test: ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8080/healthz'],
        interval: '10s',
        timeout: '3s',
        retries: 3,
      },
    },
    { memory: '64m' },
  );

  const volumes: Record<string, object> = {
    'prometheus-data': {},
    'loki-data': {},
    'grafana-data': {},
    'alertmanager-data': {},
  };
  if (ids.has('tempo')) volumes['tempo-data'] = {};

  const compose = {
    name: o.projectName,
    services,
    networks: {
      [NETWORKS.backend]: { internal: true },
      [NETWORKS.ingest]: { name: ingestNetworkName(o.projectName) },
      [NETWORKS.edge]: {},
    },
    volumes,
    secrets: {
      grafana_admin_password: { file: '../secrets/grafana-admin-password' },
      'gateway_auth.conf': { file: '../secrets/gateway_auth.conf' },
      // ${secret:NAME} lives in the secret store; ${env:NAME} is written there from the
      // environment by "raion apply". Either way the components only ever see a file.
      ...Object.fromEntries(
        [...o.alertmanagerSecrets, ...o.collectorSecrets].map((m) => [
          m.composeName,
          { file: `../secrets/${secretFileName(m)}` },
        ]),
      ),
    },
  };

  return {
    path: 'compose.yaml',
    component: 'compose',
    description: 'Docker Compose project for the whole observability stack',
    content: toYaml(
      compose,
      GENERATED_HEADER(
        'Docker Compose project for the Raion observability runtime.\nUsable without Raion: docker compose -f compose.yaml up -d (requires the secret files in ../secrets).',
      ),
    ),
  };
}
