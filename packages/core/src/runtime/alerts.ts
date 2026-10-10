import { parseSecretRef, type Receiver } from '@raion/schema';
import { capabilityOf } from '../integrations.js';
import { checkSelector } from './checks.js';
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
  /** The explanation Raion shows; not part of the Prometheus rule. */
  guide?: AlertGuide;
}

/** An alert explained for someone new to monitoring. */
export interface AlertGuide {
  /** A short name, e.g. "Many requests are failing". */
  title: string;
  /** What it means and why it matters. */
  meaning: string;
  /** When it fires, in words. */
  condition: string;
  /** What to do, first step first. */
  action: string[];
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
  if (!svc.alerts.enabled || !svc.features.basicAlerts) return [];
  return [...checkRules(ws, svc), ...metricRules(ws, svc)];
}

/** Alerts from outside checks: down, slow, certificate about to expire. */
function checkRules(ws: ResolvedWorkspace, svc: ResolvedService): AlertRule[] {
  if (svc.checks.length === 0) return [];
  const sel = checkSelector(svc);
  const labels = (severity: string) => ({
    severity,
    service_name: svc.name,
    ...(svc.team ? { team: svc.team } : {}),
    raion_scope: 'service',
  });
  const annotations = (summary: string, description: string) => ({
    summary,
    description,
    dashboard_url: `${baseUrl(ws)}/grafana/d/${serviceDashboardUid(svc.name)}`,
    raion_url: `${baseUrl(ws)}/services/${svc.name}`,
  });
  const addresses = svc.checks.map((c) => c.url).join(', ');
  const slowSeconds = svc.alerts.latencyP95Ms / 1000;
  return [
    {
      alert: 'EndpointDown',
      expr: `max by (instance) (probe_success{${sel}}) == 0`,
      for: '2m',
      labels: labels(svc.tier === 'critical' ? 'critical' : 'warning'),
      annotations: annotations(
        `${svc.name} does not answer at {{ $labels.instance }}`,
        `Raion's outside check of {{ $labels.instance }} has failed for 2 minutes: it did not answer, answered with an error status, or its certificate is invalid.`,
      ),
      guide: {
        title: `${svc.name} is down`,
        meaning: `When Raion visits ${svc.name}'s address, like a user would, it gets no good answer. Users are most likely affected right now.`,
        condition: `Every check of ${addresses} has failed for 2 minutes: no answer within the time limit, an error status, or an invalid HTTPS certificate.`,
        action: [
          `Open ${addresses} in your browser to see what users see.`,
          `Open ${svc.name} in Raion: its Health section shows the last status code and response time.`,
          'If it runs elsewhere (Kubernetes, the cloud), check it there: was it redeployed, did it run out of resources?',
        ],
      },
    },
    {
      alert: 'EndpointSlow',
      expr: `avg by (instance) (avg_over_time(probe_duration_seconds{${sel}}[5m])) > ${slowSeconds} and max by (instance) (probe_success{${sel}}) == 1`,
      for: svc.alerts.for,
      labels: labels('warning'),
      annotations: annotations(
        `${svc.name} answers slowly: {{ $value | humanizeDuration }} at {{ $labels.instance }}`,
        `Raion's outside check of {{ $labels.instance }} has taken more than ${svc.alerts.latencyP95Ms} ms on average for ${svc.alerts.for}.`,
      ),
      guide: {
        title: `${svc.name} is slow`,
        meaning: `${svc.name} answers, but slowly: users wait.`,
        condition: `Over the last 5 minutes, answering Raion's check took more than ${svc.alerts.latencyP95Ms} ms on average, for ${svc.alerts.for}.`,
        action: [
          `Open ${svc.name} in Raion to see when it started and how slow it is.`,
          'Check whether it is short of resources (CPU, memory) or waiting for something it depends on.',
        ],
      },
    },
    {
      alert: 'CertificateExpiresSoon',
      expr: `min by (instance) (probe_ssl_earliest_cert_expiry{${sel}}) - time() < 14 * 86400`,
      for: '1h',
      labels: labels('warning'),
      annotations: annotations(
        `The HTTPS certificate of {{ $labels.instance }} expires in {{ $value | humanizeDuration }}`,
        'Renew it before it expires: browsers refuse sites whose certificate has expired.',
      ),
      guide: {
        title: 'A security certificate expires soon',
        meaning: `The HTTPS certificate of ${svc.name} expires in less than two weeks. After that, browsers show a security warning and refuse to open it.`,
        condition:
          'The certificate seen by the check expires within 14 days. This has held for an hour.',
        action: [
          'Renew the certificate where it is managed (your hosting provider, load balancer, or certificate tool such as Let’s Encrypt).',
          'If renewal is automatic, check why it has not happened yet.',
        ],
      },
    },
  ];
}

/** Alerts from the service's own metrics (requests, or statistics the collector reads). */
function metricRules(ws: ResolvedWorkspace, svc: ResolvedService): AlertRule[] {
  if (!svc.signals.metrics) return [];
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
      guide: a.guide,
    }));
  }
  const lookAtService = `Open ${svc.name} in Raion: its Health section shows requests, errors and response times.`;
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
      guide: {
        title: 'Many requests are failing',
        meaning: `People or programs using ${svc.name} are getting errors: their requests end with a server error (HTTP 5xx) instead of an answer.`,
        condition: `More than ${svc.alerts.errorRatePercent}% of requests have failed for ${svc.alerts.for} in a row. Raion only checks this while ${svc.name} handles at least about 3 requests a minute, so a single failure on a quiet service does not alert.`,
        action: [
          lookAtService,
          'Open its dashboard in Grafana to see which routes fail, then read the error logs and the traces of failed requests: they usually name the cause.',
          'If something was changed recently (a new version, a configuration change), consider undoing it.',
        ],
      },
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
      guide: {
        title: 'Requests are slow',
        meaning: `${svc.name} is answering more slowly than it should: people wait, and programs calling it may give up.`,
        condition: `For ${svc.alerts.for}, the slowest 1 in 20 requests took longer than ${svc.alerts.latencyP95Ms} ms (this is called the 95th-percentile, or p95, response time).`,
        action: [
          lookAtService,
          'On its Grafana dashboard, "p95 latency by route" shows which routes are slow; the traces of slow requests show where the time goes (often a database or another service).',
          'Check whether the host is short of CPU or memory (Infrastructure dashboard).',
        ],
      },
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
      guide: {
        title: `${svc.name} stopped reporting`,
        meaning: `Raion has stopped receiving measurements from ${svc.name}. Either it is down, or it is running but can no longer send its data to Raion. While this lasts, Raion cannot tell whether ${svc.name} is healthy.`,
        condition: `${svc.name} sent request measurements during the last 6 hours, but none for 15 minutes. A service that was never connected does not trigger this.`,
        action: [
          `Check that ${svc.name} is running (for example "docker compose ps").`,
          `If it is running, open ${svc.name} in Raion and use "Check the connection": it tests whether its data arrives.`,
          'If several services stopped at once, check the Observability stack page: the collector may be down.',
        ],
      },
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
      guide: {
        title: 'A disk is almost full',
        meaning:
          'A disk on this machine has less than 10% free space. When it is full, Raion stops storing data and your applications may fail to write files or logs.',
        condition: 'A disk has been more than 90% full for 5 minutes.',
        action: [
          'Open the Infrastructure dashboard in Grafana to see which disk is full.',
          'Delete files you no longer need, such as old logs or unused Docker images ("docker image prune").',
          "If Raion's own data is the largest, keep data for a shorter time in the workspace settings.",
        ],
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
      guide: {
        title: 'A disk will be full within a day',
        meaning:
          'At the rate it has been filling up, a disk on this machine runs out of space within 24 hours.',
        condition:
          'A disk is more than 70% full, and the last 6 hours predict it will be full within 24 hours. This has held for 30 minutes.',
        action: [
          'Open the Infrastructure dashboard in Grafana to see which disk is filling up and how fast.',
          'Find what is writing so much (often logs or a growing database) and free space before it is full.',
        ],
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
      guide: {
        title: 'Memory is running out',
        meaning:
          'This machine has almost no free memory. When it runs out, the system stops programs to free memory, which can take down your applications or Raion.',
        condition: 'Less than 10% of the memory has been available for 10 minutes.',
        action: [
          'Open the Infrastructure dashboard in Grafana and see which process or container uses the most memory ("docker stats" lists containers).',
          'Restart a program that keeps growing (a memory leak), or give the machine more memory.',
        ],
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
      guide: {
        title: 'The processor is overloaded',
        meaning:
          "This machine's processor (CPU) is almost fully busy, which slows down everything running on it, including your applications.",
        condition: 'The CPU has been more than 90% busy for 15 minutes.',
        action: [
          'Open the Infrastructure dashboard in Grafana to see when it started.',
          'Find the busiest process or container ("docker stats") and check whether that load is expected.',
        ],
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
      guide: {
        title: 'Alerting self-test',
        meaning:
          "Raion's test that alerting works. It is meant to fire all the time, and is never sent to anyone. As long as it arrives, Raion knows its alert checks run and alerts can be delivered.",
        condition: 'Always firing, by design.',
        action: [
          'Nothing to do while it is firing.',
          'If Raion says the self-test is missing, alerts are not being delivered: open the Observability stack page to see which component has a problem.',
        ],
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
      guide: {
        title: 'A part of Raion is down',
        meaning:
          'One of the components Raion runs for you cannot be reached. Data it handles, such as metrics, logs or traces, may be missing while it is down.',
        condition: 'Raion could not reach the component for 2 minutes in a row.',
        action: [
          'Open the Observability stack page in Raion: it shows which component is down.',
          'If it does not recover, restore the last working release from that page.',
        ],
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
      guide: {
        title: 'Raion is refusing some incoming data',
        meaning:
          "Your applications are sending data that Raion's collector cannot accept, either because too much arrives at once or because it is malformed. Applications retry, but some data can be lost.",
        condition: 'The collector has refused data for 5 minutes.',
        action: [
          'Open the "Raion · Stack health" dashboard in Grafana to see which kind of data (metrics, logs or traces) is refused.',
          'If one application suddenly sends much more than usual, check that application.',
        ],
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
      guide: {
        title: 'Data is being lost',
        meaning:
          "Raion's collector receives your applications' data but cannot store it, because one of the storage components is not accepting it. That data is lost.",
        condition: 'The collector has failed to store data for 5 minutes.',
        action: [
          'Open the Observability stack page in Raion to see which storage component has a problem.',
          'Check that the disk is not full (Infrastructure dashboard).',
        ],
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
      guide: {
        title: 'Raion is falling behind',
        meaning:
          'Data is arriving faster than Raion can store it, so it is piling up in a waiting line (a queue). When the queue is full, new data is dropped.',
        condition: 'A queue has been more than 80% full for 5 minutes.',
        action: [
          'Check whether the host is short of CPU, memory or disk (Infrastructure dashboard).',
          'If an application suddenly sends much more data than usual, check that application.',
        ],
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
      guide: {
        title: 'Some alert checks are failing',
        meaning:
          "Some of the checks behind Raion's alerts could not run, so those alerts cannot fire. This is most likely a bug in Raion.",
        condition: 'At least one check failed in the last 10 minutes.',
        action: ['Report it to the Raion project, with the output of "raion status".'],
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
      guide: {
        title: 'Alert messages are not being sent',
        meaning:
          'Raion could not send alert messages to one of your notification channels, such as Slack or email. Alerts still appear in Raion, but people relying on messages will not hear about them.',
        condition: 'At least one message failed in the last 15 minutes.',
        action: [
          "Check the notification channel's settings, and that its secret (webhook address or password) is set and still valid.",
        ],
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
      guide: {
        title: 'Alerts cannot be delivered',
        meaning:
          'Raion checks for problems, but the component that delivers alerts (Alertmanager) cannot be reached. Problems are detected, but nobody is told.',
        condition: 'The alert delivery component has been unreachable for 5 minutes.',
        action: [
          'Open the Observability stack page in Raion and check the alert delivery component (Alertmanager).',
        ],
      },
    },
  ];
}

function prometheusRule(rule: AlertRule): Omit<AlertRule, 'guide'> {
  return {
    alert: rule.alert,
    expr: rule.expr,
    ...(rule.for ? { for: rule.for } : {}),
    labels: rule.labels,
    annotations: rule.annotations,
  };
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
          // Guides are Raion's own explanations, not part of the Prometheus rule.
          rules: [...(g.recording ?? []), ...g.rules.map(prometheusRule)],
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
