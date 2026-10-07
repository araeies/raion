import { parseSecretRef, type Receiver } from '@raion/schema';
import { capabilityOf } from '../integrations.js';
import type { ResolvedService, ResolvedWorkspace } from '../model.js';
import { q } from './dashboard-builder.js';
import { REAL_FS, serviceDashboardUid } from './dashboards.js';
import { integrationAlerts } from './integration-signals.js';
import { sloRules, sloSupported } from './slo.js';
import type { Artifact } from './types.js';
import { GENERATED_HEADER, toYaml } from './yaml.js';

export interface AlertRule {
  alert: string;
  expr: string;
  for?: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

export interface RecordingRule {
  record: string;
  expr: string;
  labels: Record<string, string>;
}

export interface RuleGroup {
  name: string;
  rules: AlertRule[];
  /** Recording rules, evaluated before the alerts of the group. */
  recording?: RecordingRule[];
}

/** Alerts that must never page anyone: they exist to prove the alerting pipeline works. */
export const WATCHDOG = 'Watchdog';

export interface AlertingContext {
  ws: ResolvedWorkspace;
  hostMetrics: boolean;
}

function baseUrl(ws: ResolvedWorkspace): string {
  return ws.server.publicUrl.replace(/\/$/, '');
}

// ----- services -------------------------------------------------------------------------------

export function serviceRules(ws: ResolvedWorkspace, svc: ResolvedService): AlertRule[] {
  if (!svc.alerts.enabled || !svc.features.basicAlerts || !svc.signals.metrics) return [];
  const http = capabilityOf(svc.capabilities, 'http.server');
  const pulled = integrationAlerts(svc);
  if (!http && pulled.length === 0) return [];
  const severity = svc.tier === 'critical' ? 'critical' : 'warning';

  const labels = (sev: string) => ({
    severity: sev,
    service_name: svc.name,
    ...(svc.team ? { team: svc.team } : {}),
    raion_scope: 'service',
  });
  const runbook = (alert: string) => svc.runbooks.find((r) => r.alert === alert)?.url;
  const annotations = (alert: string, summary: string, description: string) => ({
    summary,
    description,
    dashboard_url: `${baseUrl(ws)}/grafana/d/${serviceDashboardUid(svc.name)}`,
    raion_url: `${baseUrl(ws)}/services/${svc.name}`,
    ...(runbook(alert) ? { runbook_url: runbook(alert)! } : {}),
  });

  // Databases, caches and proxies read by the collector.
  if (!http) {
    return pulled.map((a) => ({
      alert: a.alert,
      expr: a.expr,
      for: a.for,
      labels: labels(a.severity),
      annotations: annotations(a.alert, a.summary, a.description),
    }));
  }
  const m = http.metrics.requestDuration;
  const sel = `service_name=${q(svc.name)}`;
  const status = m.labels.status;
  const total = `sum(rate(${m.name}_count{${sel}}[5m]))`;
  // Below ~3 requests per minute a single failure is a large percentage: do not alert on noise.
  const enoughTraffic = `${total} > 0.05`;

  const rules: AlertRule[] = [
    {
      alert: 'ServiceHighErrorRate',
      expr: `((sum(rate(${m.name}_count{${sel},${status}=~"5.."}[5m])) or vector(0)) / ${total}) > ${svc.alerts.errorRatePercent / 100} and ${enoughTraffic}`,
      for: svc.alerts.for,
      labels: labels(severity),
      annotations: annotations(
        'ServiceHighErrorRate',
        `${svc.name}: {{ $value | humanizePercentage }} of requests are failing`,
        `More than ${svc.alerts.errorRatePercent}% of requests to ${svc.name} have failed with a server error (HTTP 5xx) for ${svc.alerts.for}. ` +
          'Open the service dashboard to see which routes fail, then the error logs and failed traces.',
      ),
    },
    {
      alert: 'ServiceHighLatency',
      expr: `histogram_quantile(0.95, sum by (le) (rate(${m.name}_bucket{${sel}}[5m]))) > ${svc.alerts.latencyP95Ms / 1000} and ${enoughTraffic}`,
      for: svc.alerts.for,
      labels: labels('warning'),
      annotations: annotations(
        'ServiceHighLatency',
        `${svc.name}: 95% of requests take up to {{ $value | humanizeDuration }}`,
        `The 95th-percentile response time of ${svc.name} has been above ${svc.alerts.latencyP95Ms} ms for ${svc.alerts.for}. ` +
          'Check "p95 latency by route" and the slow-request traces on the service dashboard.',
      ),
    },
  ];
  if (svc.alerts.missingTelemetry) {
    rules.push({
      alert: 'ServiceTelemetryMissing',
      // Fires only for a service that was sending data in the last 6 hours and stopped:
      // a service that was never connected does not alert.
      expr: `(sum(count_over_time(${m.name}_count{${sel}}[6h])) > 0) unless (sum(count_over_time(${m.name}_count{${sel}}[10m])) > 0)`,
      for: '5m',
      labels: labels(severity),
      annotations: annotations(
        'ServiceTelemetryMissing',
        `${svc.name} stopped sending telemetry`,
        `No request metrics have arrived from ${svc.name} for 15 minutes, although it was sending them earlier. ` +
          'Either the service is down, or it can no longer reach the collector. Check the service, then "raion verify --service".',
      ),
    });
  }
  return rules;
}

// ----- infrastructure ---------------------------------------------------------------------

export function infrastructureRules(ws: ResolvedWorkspace): AlertRule[] {
  const url = `${baseUrl(ws)}/grafana/d/raion-infrastructure`;
  const labels = (severity: string) => ({ severity, raion_scope: 'infrastructure' });
  const fsUsed = `1 - node_filesystem_avail_bytes{${REAL_FS}} / node_filesystem_size_bytes{${REAL_FS}}`;
  return [
    {
      alert: 'HostDiskAlmostFull',
      expr: `(${fsUsed}) > 0.9`,
      for: '5m',
      labels: labels('critical'),
      annotations: {
        summary: 'Disk {{ $labels.device }} is {{ $value | humanizePercentage }} full',
        description:
          'A filesystem on the host is over 90% full. When it is full, storage components (Prometheus, Loki, Tempo) and your services stop working. Free space or lower retention in raion.yaml.',
        dashboard_url: url,
      },
    },
    {
      alert: 'HostDiskWillFillIn24Hours',
      expr: `(${fsUsed}) > 0.7 and predict_linear(node_filesystem_avail_bytes{${REAL_FS}}[6h], 24 * 3600) < 0`,
      for: '30m',
      labels: labels('warning'),
      annotations: {
        summary: 'Disk {{ $labels.device }} will be full within 24 hours at the current rate',
        description: 'Based on the last 6 hours, this filesystem runs out of space within a day.',
        dashboard_url: url,
      },
    },
    {
      alert: 'HostMemoryPressure',
      expr: 'sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes) < 0.1',
      for: '10m',
      labels: labels('warning'),
      annotations: {
        summary: 'Only {{ $value | humanizePercentage }} of memory is available',
        description:
          'The host is close to running out of memory; processes may be killed. Look for the process using the most memory.',
        dashboard_url: url,
      },
    },
    {
      alert: 'HostHighCpu',
      expr: '1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) > 0.9',
      for: '15m',
      labels: labels('warning'),
      annotations: {
        summary: 'CPU has been {{ $value | humanizePercentage }} busy for 15 minutes',
        description: 'Sustained high CPU slows everything on the host, including request handling.',
        dashboard_url: url,
      },
    },
  ];
}

// ----- the observability stack itself -----------------------------------------------------

function sumCounters(metrics: string[], range: string): string {
  return metrics.map((m) => `(sum(increase(${m}[${range}])) or vector(0))`).join(' + ');
}

export function platformRules(ws: ResolvedWorkspace): AlertRule[] {
  const url = `${baseUrl(ws)}/grafana/d/raion-stack-health`;
  const labels = (severity: string) => ({ severity, raion_scope: 'platform' });
  const signals = ['spans', 'metric_points', 'log_records'];
  return [
    {
      alert: WATCHDOG,
      expr: 'vector(1)',
      labels: { severity: 'none', raion_scope: 'platform' },
      annotations: {
        summary: 'The alerting pipeline is working',
        description:
          'This alert always fires. Raion checks that it reaches Alertmanager; if it stops arriving, alerts are not being evaluated or delivered.',
      },
    },
    {
      alert: 'RaionComponentDown',
      expr: 'up == 0',
      for: '2m',
      labels: labels('critical'),
      annotations: {
        summary: '{{ $labels.job }} is down or cannot be monitored',
        description:
          'Prometheus has not been able to reach {{ $labels.job }} for 2 minutes. Telemetry handled by it may be lost. Run "raion status".',
        dashboard_url: url,
      },
    },
    {
      alert: 'RaionTelemetryRefused',
      expr: `(${sumCounters(
        signals.flatMap((s) => [`otelcol_receiver_refused_${s}`, `otelcol_receiver_failed_${s}`]),
        '5m',
      )}) > 0`,
      for: '5m',
      labels: labels('warning'),
      annotations: {
        summary: 'The collector refused {{ $value | humanize }} telemetry items in 5 minutes',
        description:
          'Applications are sending more than the collector can accept (memory limit) or sending malformed data. The applications retry, but data can be lost.',
        dashboard_url: url,
      },
    },
    {
      alert: 'RaionTelemetryNotDelivered',
      expr: `(${sumCounters(
        signals.map((s) => `otelcol_exporter_send_failed_${s}`),
        '5m',
      )}) > 0`,
      for: '5m',
      labels: labels('critical'),
      annotations: {
        summary: 'The collector could not deliver {{ $value | humanize }} items to storage',
        description:
          'Prometheus, Loki or Tempo is rejecting or not answering the collector. Telemetry is being lost. Run "raion status".',
        dashboard_url: url,
      },
    },
    {
      alert: 'RaionCollectorQueueNearlyFull',
      expr: 'max by (exporter) (otelcol_exporter_queue_size / otelcol_exporter_queue_capacity) > 0.8',
      for: '5m',
      labels: labels('warning'),
      annotations: {
        summary:
          'Collector queue for {{ $labels.exporter }} is {{ $value | humanizePercentage }} full',
        description:
          'Storage is not keeping up with incoming telemetry. When the queue is full, new data is dropped.',
        dashboard_url: url,
      },
    },
    {
      alert: 'RaionRuleEvaluationFailing',
      expr: 'sum(increase(prometheus_rule_evaluation_failures_total[10m])) > 0',
      labels: labels('warning'),
      annotations: {
        summary: 'Prometheus failed to evaluate some rules',
        description:
          'Alerts depending on those rules cannot fire. This usually indicates a bug; please report it with "raion status" output.',
        dashboard_url: url,
      },
    },
    {
      alert: 'RaionNotificationsFailing',
      expr: 'sum by (integration) (increase(alertmanager_notifications_failed_total[15m])) > 0',
      labels: labels('warning'),
      annotations: {
        summary: 'Alert notifications via {{ $labels.integration }} are failing',
        description:
          'Alertmanager could not deliver notifications. Check the receiver settings and secrets (raion secrets list). Alerts are still visible in the Raion inbox.',
        dashboard_url: url,
      },
    },
    {
      alert: 'RaionAlertmanagerUnreachable',
      expr: 'max(prometheus_notifications_alertmanagers_discovered) < 1',
      for: '5m',
      labels: labels('critical'),
      annotations: {
        summary: 'Prometheus cannot send alerts to Alertmanager',
        description: 'Alerts are evaluated but not delivered. Run "raion status".',
      },
    },
  ];
}

/** Prometheus rule files for a workspace. */
export function ruleArtifacts(ctx: AlertingContext): {
  artifacts: Artifact[];
  groups: RuleGroup[];
} {
  const groups: RuleGroup[] = [{ name: 'raion-platform', rules: platformRules(ctx.ws) }];
  if (ctx.hostMetrics && ctx.ws.features.basicAlerts) {
    groups.push({ name: 'raion-infrastructure', rules: infrastructureRules(ctx.ws) });
  }
  const serviceGroups = ctx.ws.services
    .map((svc) => ({ name: `raion-service-${svc.name}`, rules: serviceRules(ctx.ws, svc) }))
    .filter((g) => g.rules.length > 0);
  const sloGroups: RuleGroup[] = ctx.ws.services.flatMap((svc) =>
    svc.features.slos && svc.signals.metrics
      ? svc.slos
          .filter((slo) => sloSupported(svc, slo))
          .map((slo) => {
            const r = sloRules(ctx.ws, svc, slo);
            return {
              name: `raion-slo-${svc.name}-${slo.name}`,
              recording: r.recording,
              rules: r.alerts,
            };
          })
      : [],
  );
  const file = (name: string, description: string, list: RuleGroup[]): Artifact => ({
    path: `prometheus/rules/${name}.yml`,
    component: 'prometheus',
    description,
    content: toYaml(
      {
        groups: list.map((g) => ({
          name: g.name,
          interval: '30s',
          rules: [...(g.recording ?? []), ...g.rules],
        })),
      },
      GENERATED_HEADER(`Prometheus rules: ${description}.`),
    ),
  });
  return {
    groups: [...groups, ...serviceGroups, ...sloGroups],
    artifacts: [
      file('raion-platform', 'alerts about the observability stack and host', groups),
      file('raion-services', 'alerts for your services', serviceGroups),
      file('raion-slos', 'SLIs, error budgets and burn-rate alerts for your SLOs', sloGroups),
    ],
  };
}

// ----- Alertmanager -----------------------------------------------------------------------

/** A secret a receiver needs, and where Alertmanager reads it. */
export interface SecretMount {
  /** Name in the secret store / environment variable name. */
  key: string;
  source: 'secret' | 'env';
  /** Compose secret name. */
  composeName: string;
  /** Path inside the Alertmanager container. */
  containerPath: string;
}

/** File in .raion/secrets/ holding a receiver secret. */
export function secretFileName(m: Pick<SecretMount, 'key' | 'source'>): string {
  return m.source === 'env' ? `env.${m.key}` : m.key;
}

export function secretMount(ref: string): SecretMount {
  const parsed = parseSecretRef(ref);
  if (!parsed) throw new Error(`not a secret reference: ${ref}`);
  const composeName = `raion_${parsed.source}_${parsed.key.toLowerCase()}`;
  return {
    key: parsed.key,
    source: parsed.source,
    composeName,
    containerPath: `/run/secrets/${composeName}`,
  };
}

function receiverConfig(r: Receiver, mounts: Map<string, SecretMount>): Record<string, unknown> {
  const file = (ref: string) => {
    const m = secretMount(ref);
    mounts.set(m.composeName, m);
    return m.containerPath;
  };
  switch (r.type) {
    case 'slack':
      return {
        name: r.name,
        slack_configs: [
          {
            api_url_file: file(r.webhookUrl),
            ...(r.channel
              ? { channel: r.channel.startsWith('#') ? r.channel : `#${r.channel}` }
              : {}),
            send_resolved: true,
            title:
              '{{ if eq .Status "firing" }}🔥{{ else }}✅{{ end }} {{ .CommonLabels.alertname }}{{ if .CommonLabels.service_name }} · {{ .CommonLabels.service_name }}{{ end }}',
            text: '{{ range .Alerts }}*{{ .Annotations.summary }}*\n{{ .Annotations.description }}{{ if .Annotations.dashboard_url }}\n<{{ .Annotations.dashboard_url }}|Dashboard>{{ end }}{{ if .Annotations.runbook_url }} · <{{ .Annotations.runbook_url }}|Runbook>{{ end }}\n{{ end }}',
          },
        ],
      };
    case 'email':
      return {
        name: r.name,
        email_configs: [
          {
            to: r.to.join(', '),
            from: r.from,
            smarthost: r.smarthost,
            ...(r.username ? { auth_username: r.username } : {}),
            ...(r.password ? { auth_password_file: file(r.password) } : {}),
            require_tls: true,
            send_resolved: true,
          },
        ],
      };
    case 'webhook':
      return {
        name: r.name,
        webhook_configs: [
          {
            ...(parseSecretRef(r.url) ? { url_file: file(r.url) } : { url: r.url }),
            send_resolved: true,
            ...(r.bearerToken
              ? {
                  http_config: {
                    authorization: { type: 'Bearer', credentials_file: file(r.bearerToken) },
                  },
                }
              : {}),
          },
        ],
      };
  }
}

/**
 * Alertmanager routing. Every alert is visible in the Raion inbox (which reads Alertmanager's
 * API); routes decide who is *notified*. Secrets are referenced as files, never inlined.
 */
export function alertmanagerArtifact(ws: ResolvedWorkspace): {
  artifact: Artifact;
  secrets: SecretMount[];
} {
  const mounts = new Map<string, SecretMount>();
  const receivers = [{ name: 'inbox' }, ...ws.receivers.map((r) => receiverConfig(r, mounts))];
  const ownership =
    ws.features.ownershipRouting || ws.services.some((s) => s.features.ownershipRouting);
  const teamRoutes = ownership
    ? ws.teams
        .filter((t) => t.route && t.route !== 'inbox')
        .map((t) => ({ receiver: t.route, matchers: [`team="${t.name}"`], continue: false }))
    : [];
  const config = {
    route: {
      receiver: ws.defaultReceiver ?? 'inbox',
      group_by: ['alertname', 'service_name'],
      group_wait: '30s',
      group_interval: '5m',
      repeat_interval: '4h',
      routes: [
        { receiver: 'inbox', matchers: [`alertname="${WATCHDOG}"`], repeat_interval: '1m' },
        ...teamRoutes,
      ],
    },
    inhibit_rules: [
      // A critical alert makes the warning version of the same problem redundant.
      {
        source_matchers: ['severity="critical"'],
        target_matchers: ['severity="warning"'],
        equal: ['alertname', 'service_name'],
      },
      // If the collector is down, every service "stops sending telemetry": report the cause only.
      {
        source_matchers: ['alertname="RaionComponentDown"', 'job="otel-collector"'],
        target_matchers: ['alertname="ServiceTelemetryMissing"'],
      },
    ],
    receivers,
  };
  return {
    secrets: [...mounts.values()].sort((a, b) => a.composeName.localeCompare(b.composeName)),
    artifact: {
      path: 'alertmanager/alertmanager.yml',
      component: 'alertmanager',
      description: 'Alertmanager: who is notified about which alerts, and how',
      content: toYaml(config, GENERATED_HEADER('Alertmanager configuration.')),
    },
  };
}
