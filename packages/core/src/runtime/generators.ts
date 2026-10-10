import { parseDuration } from '@raion/schema';
import type { ResolvedWorkspace } from '../model.js';
import type { Backends } from './backends.js';
import { RECEIVER_RESOURCE_LABELS, type ReceiverPipelines } from './receivers.js';
import type { Artifact } from './types.js';
import { GENERATED_HEADER, toYaml } from './yaml.js';

/** OTLP resource attributes promoted to Prometheus labels, so every metric carries service identity. */
export const PROMOTED_RESOURCE_ATTRIBUTES = [
  'service.name',
  'service.namespace',
  'service.version',
  'deployment.environment.name',
  ...RECEIVER_RESOURCE_LABELS,
];

// ----- OpenTelemetry Collector ------------------------------------------------------------

export function collectorConfig(
  backends: Backends,
  options: { serviceGraph: boolean; pulled?: Omit<ReceiverPipelines, 'secrets' | 'hostAccess'> } = {
    serviceGraph: false,
  },
): Artifact {
  const connectors: Record<string, unknown> = {};
  const exporters: Record<string, unknown> = {
    'otlp_http/metrics': {
      metrics_endpoint: backends.metrics.otlpMetricsEndpoint,
      tls: { insecure: true },
    },
    'otlp_http/logs': {
      logs_endpoint: backends.logs.otlpLogsEndpoint,
      tls: { insecure: true },
    },
  };
  const pipelines: Record<string, unknown> = {
    metrics: {
      receivers: ['otlp'],
      processors: ['memory_limiter', 'batch'],
      exporters: ['otlp_http/metrics'],
    },
    logs: {
      receivers: ['otlp'],
      processors: ['memory_limiter', 'batch'],
      exporters: ['otlp_http/logs'],
    },
  };
  if (backends.traces) {
    exporters['otlp_grpc/traces'] = {
      endpoint: backends.traces.otlpGrpcEndpoint,
      tls: { insecure: true },
    };
    pipelines.traces = {
      receivers: ['otlp'],
      processors: ['memory_limiter', 'batch'],
      exporters: ['otlp_grpc/traces'],
    };
    if (options.serviceGraph) {
      // Derives "who calls whom" request, error and latency metrics from traces. Grafana's
      // service map and Raion's dependency dashboard read these traces_service_graph_* metrics.
      connectors.servicegraph = {
        latency_histogram_buckets: [
          '5ms',
          '10ms',
          '25ms',
          '50ms',
          '100ms',
          '250ms',
          '500ms',
          '1s',
          '2.5s',
          '5s',
          '10s',
        ],
        store: { ttl: '5s', max_items: 5000 },
        // Flush at Prometheus' resolution (default is once a minute).
        metrics_flush_interval: '15s',
      };
      (pipelines.traces as { exporters: string[] }).exporters.push('servicegraph');
      pipelines['metrics/servicegraph'] = {
        receivers: ['servicegraph'],
        processors: ['batch'],
        exporters: ['otlp_http/metrics'],
      };
    }
  }

  // Databases, caches and proxies: the collector pulls their metrics (one pipeline each).
  Object.assign(pipelines, options.pulled?.pipelines);
  const config = {
    extensions: { health_check: { endpoint: '0.0.0.0:13133' } },
    receivers: {
      otlp: {
        protocols: {
          grpc: { endpoint: '0.0.0.0:4317' },
          http: { endpoint: '0.0.0.0:4318' },
        },
      },
      ...options.pulled?.receivers,
    },
    processors: {
      // Refuse data instead of crashing when memory runs short; senders retry.
      memory_limiter: { check_interval: '1s', limit_percentage: 80, spike_limit_percentage: 20 },
      batch: {},
      ...options.pulled?.processors,
    },
    ...(Object.keys(connectors).length > 0 ? { connectors } : {}),
    exporters,
    service: {
      extensions: ['health_check'],
      telemetry: {
        logs: { level: 'warn' },
        // The collector's own metrics (accepted/refused/dropped telemetry), scraped by Prometheus.
        metrics: {
          level: 'detailed',
          readers: [{ pull: { exporter: { prometheus: { host: '0.0.0.0', port: 8888 } } } }],
        },
      },
      pipelines,
    },
  };
  return {
    path: 'otel-collector/config.yaml',
    component: 'otel-collector',
    description:
      'OpenTelemetry Collector: receives OTLP from applications and routes it to storage',
    content: toYaml(config, GENERATED_HEADER('OpenTelemetry Collector configuration.')),
  };
}

// ----- Prometheus -------------------------------------------------------------------------

export interface ScrapeTarget {
  job: string;
  target: string;
  metricsPath?: string;
}

export function prometheusConfig(
  ws: ResolvedWorkspace,
  scrapeTargets: ScrapeTarget[],
  /** Complete scrape jobs (outside checks), appended as they are. */
  extraScrapeConfigs: Record<string, unknown>[] = [],
): Artifact[] {
  const config = {
    global: {
      scrape_interval: '15s',
      evaluation_interval: '15s',
      external_labels: { raion_workspace: ws.name, deployment_environment_name: ws.environment },
    },
    otlp: {
      promote_resource_attributes: PROMOTED_RESOURCE_ATTRIBUTES,
      keep_identifying_resource_attributes: true,
    },
    storage: {
      // OTLP senders batch and retry, so samples can arrive slightly out of order.
      tsdb: { out_of_order_time_window: '30m' },
    },
    rule_files: ['/etc/prometheus/rules/*.yml'],
    alerting: {
      alertmanagers: [{ static_configs: [{ targets: ['alertmanager:9093'] }] }],
    },
    scrape_configs: [
      ...scrapeTargets.map((t) => ({
        job_name: t.job,
        ...(t.metricsPath ? { metrics_path: t.metricsPath } : {}),
        static_configs: [{ targets: [t.target] }],
      })),
      ...extraScrapeConfigs,
    ],
  };
  return [
    {
      path: 'prometheus/prometheus.yml',
      component: 'prometheus',
      description: 'Prometheus: scrape targets, OTLP ingestion settings and rule files',
      content: toYaml(config, GENERATED_HEADER('Prometheus configuration.')),
    },
  ];
}

// ----- Loki -------------------------------------------------------------------------------

export function lokiConfig(retention: string): Artifact {
  const config = {
    auth_enabled: false,
    server: { http_listen_port: 3100, grpc_listen_port: 9096, log_level: 'warn' },
    common: {
      instance_addr: '127.0.0.1',
      path_prefix: '/loki',
      storage: { filesystem: { chunks_directory: '/loki/chunks', rules_directory: '/loki/rules' } },
      replication_factor: 1,
      ring: { kvstore: { store: 'inmemory' } },
    },
    schema_config: {
      configs: [
        {
          from: '2024-01-01',
          store: 'tsdb',
          object_store: 'filesystem',
          schema: 'v13',
          index: { prefix: 'index_', period: '24h' },
        },
      ],
    },
    limits_config: {
      retention_period: hours(retention),
      // Keeps trace_id/span_id from OTLP logs as structured metadata for log-trace correlation.
      allow_structured_metadata: true,
      volume_enabled: true,
    },
    compactor: {
      working_directory: '/loki/compactor',
      retention_enabled: true,
      delete_request_store: 'filesystem',
    },
    analytics: { reporting_enabled: false },
  };
  return {
    path: 'loki/loki.yaml',
    component: 'loki',
    description: 'Loki: log storage (single binary, local filesystem)',
    content: toYaml(config, GENERATED_HEADER('Loki configuration.')),
  };
}

// ----- Tempo ------------------------------------------------------------------------------

export function tempoConfig(retention: string): Artifact {
  const config = {
    stream_over_http_enabled: true,
    server: { http_listen_port: 3200, log_level: 'warn' },
    distributor: {
      receivers: { otlp: { protocols: { grpc: { endpoint: '0.0.0.0:4317' } } } },
    },
    storage: {
      trace: {
        backend: 'local',
        wal: { path: '/var/tempo/wal' },
        local: { path: '/var/tempo/blocks' },
      },
    },
    // Tempo 3 runs retention as scheduled backend jobs; both sides carry the setting.
    backend_scheduler: {
      provider: { compaction: { compaction: { block_retention: hours(retention) } } },
    },
    backend_worker: { compaction: { block_retention: hours(retention) } },
    usage_report: { reporting_enabled: false },
  };
  return {
    path: 'tempo/tempo.yaml',
    component: 'tempo',
    description: 'Tempo: trace storage (single binary, local filesystem)',
    content: toYaml(config, GENERATED_HEADER('Tempo configuration.')),
  };
}

// ----- Grafana ----------------------------------------------------------------------------

export function grafanaProvisioning(backends: Backends): Artifact[] {
  const { metrics, logs, traces } = backends;
  const datasources: Record<string, unknown>[] = [
    {
      name: 'Prometheus',
      uid: metrics.datasourceUid,
      type: 'prometheus',
      access: 'proxy',
      url: metrics.internalUrl,
      isDefault: true,
      editable: false,
      jsonData: {
        httpMethod: 'POST',
        ...(traces
          ? {
              exemplarTraceIdDestinations: [
                { name: 'trace_id', datasourceUid: traces.datasourceUid },
              ],
            }
          : {}),
      },
    },
    {
      name: 'Loki',
      uid: logs.datasourceUid,
      type: 'loki',
      access: 'proxy',
      url: logs.internalUrl,
      editable: false,
      jsonData: traces
        ? {
            derivedFields: [
              {
                name: 'TraceID',
                matcherType: 'label',
                matcherRegex: 'trace_id',
                url: '${__value.raw}',
                datasourceUid: traces.datasourceUid,
              },
            ],
          }
        : {},
    },
  ];
  if (traces) {
    datasources.push({
      name: 'Tempo',
      uid: traces.datasourceUid,
      type: 'tempo',
      access: 'proxy',
      url: traces.internalUrl,
      editable: false,
      jsonData: {
        tracesToLogsV2: {
          datasourceUid: logs.datasourceUid,
          spanStartTimeShift: '-5m',
          spanEndTimeShift: '5m',
          filterByTraceID: true,
          tags: [{ key: 'service.name', value: 'service_name' }],
        },
        tracesToMetrics: { datasourceUid: metrics.datasourceUid },
        serviceMap: { datasourceUid: metrics.datasourceUid },
        nodeGraph: { enabled: true },
      },
    });
  }
  return [
    {
      path: 'grafana/provisioning/datasources/raion.yaml',
      component: 'grafana',
      description: 'Grafana datasources for Prometheus, Loki and Tempo, linked for correlation',
      content: toYaml(
        { apiVersion: 1, prune: true, datasources },
        GENERATED_HEADER('Grafana datasources.'),
      ),
    },
    // Grafana expects these provisioning folders; Raion provisions nothing there.
    {
      path: 'grafana/provisioning/plugins/raion.yaml',
      component: 'grafana',
      description: 'Grafana plugin provisioning (none)',
      content: toYaml(
        { apiVersion: 1, apps: [] },
        GENERATED_HEADER('Grafana plugin provisioning.'),
      ),
    },
    {
      path: 'grafana/provisioning/dashboards/raion.yaml',
      component: 'grafana',
      description:
        'Grafana dashboard provider: loads the generated dashboards into the "Raion" folder',
      content: toYaml(
        {
          apiVersion: 1,
          providers: [
            {
              name: 'raion',
              folder: 'Raion',
              type: 'file',
              disableDeletion: true,
              allowUiUpdates: false,
              // Grafana re-reads the folder, so dashboard changes need no restart.
              updateIntervalSeconds: 10,
              options: {
                path: '/etc/grafana/provisioning/dashboards/raion',
                foldersFromFilesStructure: false,
              },
            },
          ],
        },
        GENERATED_HEADER('Grafana dashboard provisioning.'),
      ),
    },
  ];
}

/** Grafana settings, passed as environment variables. No secret values: those come from files. */
export function grafanaEnvironment(ws: ResolvedWorkspace): Record<string, string> {
  const root = `${ws.server.publicUrl.replace(/\/$/, '')}/grafana/`;
  return {
    GF_SERVER_ROOT_URL: root,
    GF_SERVER_SERVE_FROM_SUB_PATH: 'true',
    GF_SECURITY_ADMIN_USER: 'raion-admin',
    GF_SECURITY_ADMIN_PASSWORD__FILE: '/run/secrets/grafana_admin_password',
    GF_SECURITY_DISABLE_GRAVATAR: 'true',
    GF_SECURITY_COOKIE_SAMESITE: 'strict',
    // Sign-in is done by Raion: the gateway forwards the Raion user and role.
    GF_AUTH_PROXY_ENABLED: 'true',
    GF_AUTH_PROXY_HEADER_NAME: 'X-WEBAUTH-USER',
    GF_AUTH_PROXY_HEADER_PROPERTY: 'username',
    GF_AUTH_PROXY_HEADERS: 'Role:X-WEBAUTH-ROLE',
    GF_AUTH_PROXY_AUTO_SIGN_UP: 'true',
    GF_AUTH_PROXY_ENABLE_LOGIN_TOKEN: 'false',
    GF_AUTH_DISABLE_LOGIN_FORM: 'true',
    GF_AUTH_DISABLE_SIGNOUT_MENU: 'true',
    GF_AUTH_ANONYMOUS_ENABLED: 'false',
    GF_AUTH_BASIC_ENABLED: 'false',
    GF_USERS_ALLOW_SIGN_UP: 'false',
    GF_USERS_ALLOW_ORG_CREATE: 'false',
    GF_LIVE_MAX_CONNECTIONS: '0',
    GF_ANALYTICS_REPORTING_ENABLED: 'false',
    GF_ANALYTICS_CHECK_FOR_UPDATES: 'false',
    GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES: 'false',
    // Grafana has no internet access (backend network); do not try to download plugins.
    GF_PLUGINS_PREINSTALL_DISABLED: 'true',
    GF_NEWS_NEWS_FEED_ENABLED: 'false',
    GF_LOG_LEVEL: 'warn',
    // Alerts live in Raion: Prometheus rules, delivered by Alertmanager and shown in the Raion
    // inbox. Grafana's own alerting would be a second, different list of the same alerts.
    GF_UNIFIED_ALERTING_ENABLED: 'false',
    // Grafana opens on the generated overview dashboard.
    GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH:
      '/etc/grafana/provisioning/dashboards/raion/raion-overview.json',
  };
}

// ----- Gateway ----------------------------------------------------------------------------

export interface GatewayRoute {
  /** Path prefix on the gateway, e.g. /prometheus. */
  path: string;
  upstream: string;
  /** Strip the prefix before forwarding (true for everything except Grafana, which runs under /grafana). */
  stripPrefix: boolean;
}

export function gatewayConfig(routes: GatewayRoute[]): Artifact {
  const locations = routes
    .map((r) => {
      const rewrite = r.stripPrefix ? `      rewrite ^${r.path}/(.*)$ /$1 break;\n` : '';
      // "set" must precede "rewrite … break", which stops later rewrite-module directives.
      return `    location ${r.path}/ {
      if ($raion_authorized = 0) { return 401; }
      set $upstream ${r.upstream};
${rewrite}      proxy_pass http://$upstream;
    }`;
    })
    .join('\n\n');

  const content = `# Raion gateway (nginx).
# Generated by Raion. Do not edit: changes are overwritten on the next "raion apply".
#
# The only entry point into the observability stack. Every request must carry the
# X-Raion-Gateway-Token header; the expected value is defined in a secret file that is
# mounted at runtime and never written into generated configuration.
worker_processes 1;
pid /tmp/nginx.pid;
error_log /dev/stderr warn;

events {
  worker_connections 512;
}

http {
  client_body_temp_path /tmp/client_temp;
  proxy_temp_path /tmp/proxy_temp;
  fastcgi_temp_path /tmp/fastcgi_temp;
  uwsgi_temp_path /tmp/uwsgi_temp;
  scgi_temp_path /tmp/scgi_temp;

  access_log off;
  server_tokens off;
  client_max_body_size 16m;

  # Docker's embedded DNS: upstreams are resolved per request, so restarted containers are found.
  resolver 127.0.0.11 valid=10s ipv6=off;

  # Defines $raion_authorized from the X-Raion-Gateway-Token header.
  include /run/secrets/gateway_auth.conf;

  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header Connection "";
  # The token is for the gateway only; never pass it on.
  proxy_set_header X-Raion-Gateway-Token "";
  proxy_read_timeout 300s;

  server {
    listen 8080;

    location = /healthz {
      return 200 "ok\\n";
    }

${locations}

    location / {
      return 404;
    }
  }
}
`;
  return {
    path: 'gateway/nginx.conf',
    component: 'gateway',
    description: 'Raion gateway: authenticated reverse proxy in front of every component',
    content,
  };
}

/** The nginx include that checks the gateway token. Written to the secret store, never to artifacts. */
export function gatewayAuthInclude(token: string): string {
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) throw new Error('invalid gateway token format');
  return `map $http_x_raion_gateway_token $raion_authorized {\n  default 0;\n  "${token}" 1;\n}\n`;
}

// ----- helpers ----------------------------------------------------------------------------

/** Converts a duration like "7d" to hours ("168h"), the unit Loki and Tempo expect. */
export function hours(duration: string): string {
  const ms = parseDuration(duration);
  if (ms === undefined) throw new Error(`invalid duration ${duration}`);
  return `${Math.max(1, Math.round(ms / 3_600_000))}h`;
}
