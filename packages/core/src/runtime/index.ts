import { parseDuration } from '@raion/schema';
import type { ResolvedWorkspace } from '../model.js';
import { selectBackends } from './backends.js';
import { alertmanagerArtifact, ruleArtifacts, secretFileName } from './alerts.js';
import { composeFile } from './compose.js';
import { receiverPipelines } from './receivers.js';
import { dashboardArtifacts, generateDashboards } from './dashboards.js';
import {
  collectorConfig,
  gatewayConfig,
  grafanaEnvironment,
  grafanaProvisioning,
  lokiConfig,
  prometheusConfig,
  tempoConfig,
  type GatewayRoute,
  type ScrapeTarget,
} from './generators.js';
import type { ComponentId } from './images.js';
import type { ComponentSpec, RuntimeBundle, RuntimeNote } from './types.js';

export * from './backends.js';
export * from './alerts.js';
export * from './slo.js';
export * from './compose.js';
export * from './dashboard-builder.js';
export * from './dashboards.js';
export * from './generators.js';
export * from './images.js';
export * from './types.js';
export * from './receivers.js';
export * from './integration-signals.js';

const DAY_MS = 86_400_000;

/** Path on the gateway that answers 2xx when a component is ready. */
export const READINESS_PATHS: Partial<Record<ComponentId, string>> = {
  'otel-collector': '/otel-collector/',
  prometheus: '/prometheus/-/ready',
  loki: '/loki/ready',
  tempo: '/tempo/ready',
  grafana: '/grafana/api/health',
  alertmanager: '/alertmanager/-/ready',
  gateway: '/healthz',
};

/**
 * Generates the complete observability runtime for a workspace. Pure and deterministic:
 * the same workspace always produces byte-identical artifacts.
 */
export function generateRuntime(ws: ResolvedWorkspace): RuntimeBundle {
  const notes: RuntimeNote[] = [];
  const backends = selectBackends(ws);
  const compose = ws.target.compose;

  // Metrics must be kept at least as long as the longest SLO window, or the SLO cannot be computed.
  let metricsRetention = ws.retention.metrics;
  const sloWindows = ws.services
    .filter((s) => s.features.slos)
    .flatMap((s) => s.slos.map((slo) => slo.windowMs));
  const longestWindow = Math.max(0, ...sloWindows);
  const configuredMs = parseDuration(metricsRetention) ?? 0;
  if (longestWindow > 0 && configuredMs < longestWindow * 1.1) {
    const days = Math.ceil((longestWindow * 1.1) / DAY_MS);
    notes.push({
      severity: 'info',
      message: `metrics retention raised from ${metricsRetention} to ${days}d so the longest SLO window (${longestWindow / DAY_MS}d) can be evaluated; expect more disk usage`,
    });
    metricsRetention = `${days}d`;
  }

  const components: ComponentSpec[] = [
    {
      id: 'otel-collector',
      purpose:
        'Receives metrics, logs and traces from your applications (OTLP) and sends them to storage',
      readinessPath: READINESS_PATHS['otel-collector']!,
      scrapeJob: 'otel-collector',
      privileges: [],
      requiresApproval: false,
    },
    {
      id: 'prometheus',
      purpose: 'Stores metrics, evaluates recording and alerting rules',
      readinessPath: READINESS_PATHS['prometheus']!,
      scrapeJob: 'prometheus',
      privileges: [],
      requiresApproval: false,
    },
    {
      id: 'loki',
      purpose: 'Stores logs',
      readinessPath: READINESS_PATHS['loki']!,
      scrapeJob: 'loki',
      privileges: [],
      requiresApproval: false,
    },
  ];
  if (backends.traces) {
    components.push({
      id: 'tempo',
      purpose: 'Stores distributed traces',
      readinessPath: READINESS_PATHS['tempo']!,
      scrapeJob: 'tempo',
      privileges: [],
      requiresApproval: false,
    });
  }
  components.push(
    {
      id: 'grafana',
      purpose: 'Dashboards and exploration of metrics, logs and traces',
      readinessPath: READINESS_PATHS['grafana']!,
      scrapeJob: 'grafana',
      privileges: [],
      requiresApproval: false,
    },
    {
      id: 'alertmanager',
      purpose: 'Groups, routes and silences alerts',
      readinessPath: READINESS_PATHS['alertmanager']!,
      scrapeJob: 'alertmanager',
      privileges: [],
      requiresApproval: false,
    },
  );
  if (ws.infrastructure.host) {
    components.push({
      id: 'node-exporter',
      purpose: 'Host metrics: CPU, memory, disk, network',
      scrapeJob: 'node-exporter',
      privileges: ['shares the host PID namespace', 'reads the host filesystem (read-only)'],
      requiresApproval: false,
    });
  }
  if (ws.infrastructure.containers) {
    components.push({
      id: 'cadvisor',
      purpose: 'Per-container CPU, memory and network metrics',
      scrapeJob: 'cadvisor',
      privileges: ['runs privileged', 'reads Docker state and host /sys (read-only)'],
      requiresApproval: true,
    });
  }
  components.push({
    id: 'gateway',
    purpose: 'Authenticated entry point: only Raion can reach the other components',
    readinessPath: READINESS_PATHS['gateway']!,
    privileges: [],
    requiresApproval: false,
  });

  const ids = new Set(components.map((c) => c.id));
  const scrapeTargets: ScrapeTarget[] = [
    { job: 'prometheus', target: 'localhost:9090' },
    { job: 'otel-collector', target: 'otel-collector:8888' },
    { job: 'loki', target: 'loki:3100' },
    ...(ids.has('tempo') ? [{ job: 'tempo', target: 'tempo:3200' }] : []),
    { job: 'grafana', target: 'grafana:3000', metricsPath: '/grafana/metrics' },
    { job: 'alertmanager', target: 'alertmanager:9093' },
    ...(ids.has('node-exporter') ? [{ job: 'node-exporter', target: 'node-exporter:9100' }] : []),
    ...(ids.has('cadvisor') ? [{ job: 'cadvisor', target: 'cadvisor:8080' }] : []),
  ];

  const routes: GatewayRoute[] = [
    { path: '/prometheus', upstream: 'prometheus:9090', stripPrefix: true },
    { path: '/loki', upstream: 'loki:3100', stripPrefix: true },
    ...(ids.has('tempo') ? [{ path: '/tempo', upstream: 'tempo:3200', stripPrefix: true }] : []),
    { path: '/alertmanager', upstream: 'alertmanager:9093', stripPrefix: true },
    { path: '/otel-collector', upstream: 'otel-collector:13133', stripPrefix: true },
    { path: '/grafana', upstream: 'grafana:3000', stripPrefix: false },
  ];

  const serviceGraph =
    backends.traces !== undefined &&
    ws.services.some(
      (svc) => svc.features.serviceGraph && svc.features.traces && svc.signals.traces,
    );
  const dashboards = generateDashboards({
    ws,
    traces: backends.traces !== undefined,
    serviceGraph,
    hostMetrics: ids.has('node-exporter'),
    containerMetrics: ids.has('cadvisor'),
  });

  const rules = ruleArtifacts({ ws, hostMetrics: ids.has('node-exporter') });
  const alertmanager = alertmanagerArtifact(ws);
  const pulled = receiverPipelines(ws, 'otlp_http/metrics');
  // A secret used by both Alertmanager and the collector is mounted once.
  const secretMounts = [...alertmanager.secrets, ...pulled.secrets].filter(
    (m, i, all) => all.findIndex((x) => x.composeName === m.composeName) === i,
  );

  const retention = {
    metrics: metricsRetention,
    logs: ws.retention.logs,
    traces: ws.retention.traces,
  };
  const artifacts = [
    collectorConfig(backends, { serviceGraph, pulled }),
    ...prometheusConfig(ws, scrapeTargets),
    lokiConfig(retention.logs),
    ...(backends.traces ? [tempoConfig(retention.traces)] : []),
    ...grafanaProvisioning(backends),
    ...dashboardArtifacts(dashboards),
    ...rules.artifacts,
    alertmanager.artifact,
    gatewayConfig(routes),
    composeFile(components, {
      alertmanagerSecrets: alertmanager.secrets,
      collectorSecrets: pulled.secrets,
      collectorHostAccess: pulled.hostAccess,
      ...(pulled.containerLogs ? { fluentForwardPort: compose.fluentForwardPort } : {}),
      projectName: compose.projectName,
      gatewayPort: compose.gatewayPort,
      otlpGrpcPort: compose.otlpGrpcPort,
      otlpHttpPort: compose.otlpHttpPort,
      metricsRetention,
      grafanaEnv: grafanaEnvironment(ws),
    }),
  ].sort((a, b) => a.path.localeCompare(b.path));

  if (ws.infrastructure.containers) {
    notes.push({
      severity: 'warning',
      message:
        'container metrics (cAdvisor) run a privileged container; apply requires --allow-privileged',
    });
  }

  return {
    components,
    artifacts,
    notes,
    retention,
    secrets: secretMounts.map((m) => ({
      key: m.key,
      source: m.source,
      file: secretFileName(m),
      composeName: m.composeName,
    })),
    alerts: rules.groups.flatMap((g) =>
      g.rules.map((r) => ({
        group: g.name,
        alert: r.alert,
        severity: r.labels.severity ?? 'none',
        ...(r.labels.service_name ? { service: r.labels.service_name } : {}),
        ...(r.for ? { for: r.for } : {}),
        summary: r.annotations.summary ?? '',
      })),
    ),
    dashboards: dashboards.map(({ uid, title, service }) => ({
      uid,
      title,
      ...(service ? { service } : {}),
    })),
  };
}
