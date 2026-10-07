// Unit tests for the generated alert rules, run with Prometheus' own `promtool test rules`
// against synthetic series: each alert must fire when it should, with the right labels, and
// stay quiet when it should. Needs Docker.
//
//   node e2e/rules.e2e.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const core = await import(new URL('../packages/core/dist/index.js', import.meta.url).href);

const { files } = await core.readWorkspaceSources(
  join(root, 'examples', 'nodejs-express', 'observability'),
);
const result = core.validateSources([
  ...files.map((f) =>
    f.path === 'raion.yaml' ? { ...f, content: f.content.replace('level: 2', 'level: 3') } : f,
  ),
  {
    path: 'slos/payment-api-availability.yaml',
    content: [
      'apiVersion: raion/v1alpha1',
      'kind: SLO',
      'metadata:',
      '  name: availability',
      'spec:',
      '  service: payment-api',
      '  sli: { type: availability }',
      '  target: 99.9',
      '  window: 30d',
    ].join('\n'),
  },
]);
if (!result.workspace)
  throw new Error(`example workspace is invalid: ${JSON.stringify(result.diagnostics)}`);
const bundle = core.generateRuntime(result.workspace);

const dir = mkdtempSync(join(tmpdir(), 'raion-rules-'));
const ruleFiles = bundle.artifacts.filter((a) => a.path.startsWith('prometheus/rules/'));
for (const f of ruleFiles) writeFileSync(join(dir, f.path.split('/').pop()), f.content);

// The polyglot example adds databases and a proxy read by the collector.
const polyglot = core.validateSources(
  (await core.readWorkspaceSources(join(root, 'examples', 'polyglot', 'observability'))).files,
);
if (!polyglot.workspace) throw new Error('polyglot example workspace is invalid');
const polyglotRules = core
  .generateRuntime(polyglot.workspace)
  .artifacts.find((a) => a.path === 'prometheus/rules/raion-services.yml');
writeFileSync(join(dir, 'polyglot-services.yml'), polyglotRules.content);

const count = 'http_server_request_duration_seconds_count';
const svc = (labels) => `{service_name="payment-api",${labels}}`;

const tests = [
  {
    name: 'service errors: fires above 5% failed requests (payment-api is critical-tier)',
    interval: '1m',
    input_series: [
      // 3 requests/s, of which 0.6/s fail (20%).
      { series: `${count}${svc('http_response_status_code="200"')}`, values: '0+144x30' },
      { series: `${count}${svc('http_response_status_code="500"')}`, values: '0+36x30' },
    ],
    alert_rule_test: [
      { eval_time: '3m', alertname: 'ServiceHighErrorRate', exp_alerts: [] }, // condition must hold for 5m
      {
        eval_time: '12m',
        alertname: 'ServiceHighErrorRate',
        exp_alerts: [
          {
            exp_labels: {
              severity: 'critical',
              service_name: 'payment-api',
              team: 'payments',
              raion_scope: 'service',
            },
          },
        ],
      },
    ],
  },
  {
    name: 'service errors: quiet at very low traffic, where one failure is a large percentage',
    interval: '1m',
    input_series: [
      { series: `${count}${svc('http_response_status_code="200"')}`, values: '0+1x30' },
      { series: `${count}${svc('http_response_status_code="500"')}`, values: '0+1x30' },
    ],
    alert_rule_test: [{ eval_time: '20m', alertname: 'ServiceHighErrorRate', exp_alerts: [] }],
  },
  {
    name: 'service errors: quiet when everything succeeds',
    interval: '1m',
    input_series: [
      { series: `${count}${svc('http_response_status_code="200"')}`, values: '0+300x30' },
    ],
    alert_rule_test: [{ eval_time: '20m', alertname: 'ServiceHighErrorRate', exp_alerts: [] }],
  },
  {
    name: 'missing telemetry: fires when a service that was sending stops',
    interval: '1m',
    input_series: [
      { series: `${count}${svc('http_response_status_code="200"')}`, values: '0+60x30 _x60' },
    ],
    alert_rule_test: [
      { eval_time: '35m', alertname: 'ServiceTelemetryMissing', exp_alerts: [] },
      {
        eval_time: '50m',
        alertname: 'ServiceTelemetryMissing',
        exp_alerts: [
          {
            exp_labels: {
              severity: 'critical',
              service_name: 'payment-api',
              team: 'payments',
              raion_scope: 'service',
            },
          },
        ],
      },
    ],
  },
  {
    name: 'missing telemetry: quiet for a service that never sent anything',
    interval: '1m',
    input_series: [{ series: 'up{job="prometheus"}', values: '1x60' }],
    alert_rule_test: [{ eval_time: '50m', alertname: 'ServiceTelemetryMissing', exp_alerts: [] }],
  },
  {
    name: 'stack: a component that cannot be scraped for 2 minutes',
    interval: '1m',
    input_series: [{ series: 'up{job="loki"}', values: '1 1 0 0 0 0 0' }],
    alert_rule_test: [
      { eval_time: '3m', alertname: 'RaionComponentDown', exp_alerts: [] },
      {
        eval_time: '5m',
        alertname: 'RaionComponentDown',
        exp_alerts: [
          { exp_labels: { severity: 'critical', raion_scope: 'platform', job: 'loki' } },
        ],
      },
    ],
  },
  {
    name: 'stack: the Watchdog always fires',
    interval: '1m',
    input_series: [],
    alert_rule_test: [
      {
        eval_time: '1m',
        alertname: 'Watchdog',
        exp_alerts: [{ exp_labels: { severity: 'none', raion_scope: 'platform' } }],
      },
    ],
  },
  {
    name: 'host: a filesystem over 90% full',
    interval: '1m',
    input_series: [
      {
        series: 'node_filesystem_avail_bytes{device="/dev/sda1",fstype="ext4",mountpoint="/"}',
        values: '5x20',
      },
      {
        series: 'node_filesystem_size_bytes{device="/dev/sda1",fstype="ext4",mountpoint="/"}',
        values: '100x20',
      },
      // In-memory filesystems are ignored even when full.
      {
        series: 'node_filesystem_avail_bytes{device="tmpfs",fstype="tmpfs",mountpoint="/run"}',
        values: '0x20',
      },
      {
        series: 'node_filesystem_size_bytes{device="tmpfs",fstype="tmpfs",mountpoint="/run"}',
        values: '100x20',
      },
    ],
    alert_rule_test: [
      {
        eval_time: '10m',
        alertname: 'HostDiskAlmostFull',
        exp_alerts: [
          {
            exp_labels: {
              severity: 'critical',
              raion_scope: 'infrastructure',
              device: '/dev/sda1',
              fstype: 'ext4',
              mountpoint: '/',
            },
          },
        ],
      },
    ],
  },
  {
    name: 'collector: refused telemetry',
    interval: '1m',
    input_series: [
      { series: 'otelcol_receiver_refused_spans{receiver="otlp"}', values: '0+10x15' },
    ],
    alert_rule_test: [
      {
        eval_time: '12m',
        alertname: 'RaionTelemetryRefused',
        exp_alerts: [{ exp_labels: { severity: 'warning', raion_scope: 'platform' } }],
      },
    ],
  },
  {
    name: 'SLO: 20% failures burn a 99.9% budget fast enough to page',
    interval: '1m',
    input_series: [
      { series: `${count}${svc('http_response_status_code="200"')}`, values: '0+144x40' },
      { series: `${count}${svc('http_response_status_code="500"')}`, values: '0+36x40' },
    ],
    promql_expr_test: [
      {
        // Traffic-weighted ratio of good requests over the SLO window: 80%.
        expr: 'round(raion_slo:sli:ratio, 0.001)',
        eval_time: '30m',
        exp_samples: [
          {
            labels: '{service_name="payment-api",slo="availability",slo_window="30d"}',
            value: 0.8,
          },
        ],
      },
      {
        // The burn rate shown in Raion: 20% failures / 0.1% budget = 200x the sustainable pace.
        expr: `round(${core.BURN_RATE_1H_QUERY})`,
        eval_time: '30m',
        exp_samples: [{ labels: '{service_name="payment-api",slo="availability"}', value: 200 }],
      },
      {
        // 20% failures against a 0.1% budget: 200 budgets spent, so 1 - 200 = -199 remaining.
        expr: 'round(raion_slo:error_budget_remaining:ratio)',
        eval_time: '30m',
        exp_samples: [
          {
            labels: '{service_name="payment-api",slo="availability",slo_window="30d"}',
            value: -199,
          },
        ],
      },
    ],
    alert_rule_test: [
      {
        eval_time: '12m',
        alertname: 'SLOErrorBudgetBurnFast',
        exp_alerts: [
          {
            exp_labels: {
              severity: 'critical',
              service_name: 'payment-api',
              slo: 'availability',
              slo_window: '30d',
              team: 'payments',
              raion_scope: 'slo',
            },
          },
        ],
      },
    ],
  },
  {
    name: 'SLO: 0.05% failures stay within a 99.9% budget and do not alert',
    interval: '1m',
    input_series: [
      { series: `${count}${svc('http_response_status_code="200"')}`, values: '0+19990x70' },
      { series: `${count}${svc('http_response_status_code="500"')}`, values: '0+10x70' },
    ],
    promql_expr_test: [
      {
        expr: 'round(raion_slo:error_budget_remaining:ratio, 0.01)',
        eval_time: '60m',
        exp_samples: [
          {
            labels: '{service_name="payment-api",slo="availability",slo_window="30d"}',
            value: 0.5,
          },
        ],
      },
    ],
    alert_rule_test: [
      { eval_time: '60m', alertname: 'SLOErrorBudgetBurnFast', exp_alerts: [] },
      { eval_time: '60m', alertname: 'SLOErrorBudgetBurnSlow', exp_alerts: [] },
    ],
  },
  {
    name: 'database: fires when the collector stops reading it (catalog-db is critical-tier)',
    interval: '1m',
    input_series: [
      // Points read grow for 5 minutes, then stop: the database went away.
      {
        series: 'otelcol_scraper_scraped_metric_points{receiver="postgresql/catalog-db"}',
        values: '0+10x5 50x25',
      },
    ],
    alert_rule_test: [
      { eval_time: '8m', alertname: 'ServiceUnreachable', exp_alerts: [] },
      {
        eval_time: '20m',
        alertname: 'ServiceUnreachable',
        exp_alerts: [
          {
            exp_labels: {
              severity: 'critical',
              service_name: 'catalog-db',
              team: 'shop',
              raion_scope: 'service',
            },
          },
        ],
      },
    ],
  },
  {
    name: 'database: quiet while the collector keeps reading it',
    interval: '1m',
    input_series: [
      {
        series: 'otelcol_scraper_scraped_metric_points{receiver="postgresql/catalog-db"}',
        values: '0+10x30',
      },
    ],
    alert_rule_test: [{ eval_time: '25m', alertname: 'ServiceUnreachable', exp_alerts: [] }],
  },
  {
    name: 'PostgreSQL: 90% of max_connections in use for 10 minutes',
    interval: '1m',
    input_series: [
      {
        series: 'postgresql_backends{service_name="catalog-db",postgresql_database_name="catalog"}',
        values: '90x20',
      },
      { series: 'postgresql_connection_max{service_name="catalog-db"}', values: '100x20' },
    ],
    alert_rule_test: [
      { eval_time: '5m', alertname: 'PostgresConnectionsNearLimit', exp_alerts: [] },
      {
        eval_time: '15m',
        alertname: 'PostgresConnectionsNearLimit',
        exp_alerts: [
          {
            exp_labels: {
              severity: 'warning',
              service_name: 'catalog-db',
              team: 'shop',
              raion_scope: 'service',
            },
          },
        ],
      },
    ],
  },
  {
    name: 'Nginx: connections accepted but not handled',
    interval: '1m',
    input_series: [
      { series: 'nginx_connections_accepted_total{service_name="edge"}', values: '0+10x20' },
      { series: 'nginx_connections_handled_total{service_name="edge"}', values: '0+9x20' },
    ],
    alert_rule_test: [
      {
        eval_time: '10m',
        alertname: 'NginxDroppingConnections',
        exp_alerts: [
          {
            exp_labels: {
              severity: 'warning',
              service_name: 'edge',
              team: 'shop',
              raion_scope: 'service',
            },
          },
        ],
      },
    ],
  },
];

// promtool compares annotations exactly. Expected annotations come from the generated rules,
// with {{ $labels.x }} filled in from the expected labels; summaries that depend on the
// measured value are stated explicitly below, so the text users read is tested too.
const generated = [result.workspace, polyglot.workspace].flatMap((ws) =>
  core.ruleArtifacts({ ws, hostMetrics: true }).groups.flatMap((g) => g.rules),
);
const SUMMARIES = {
  ServiceHighErrorRate: 'payment-api: 20% of requests are failing',
  HostDiskAlmostFull: 'Disk /dev/sda1 is 95% full',
  RaionTelemetryRefused: 'The collector refused 50 telemetry items in 5 minutes',
  PostgresConnectionsNearLimit: 'catalog-db: 90% of connections in use',
  NginxDroppingConnections: 'edge dropped 5 connections',
};
for (const test of tests) {
  for (const check of test.alert_rule_test) {
    for (const expected of check.exp_alerts) {
      const rule = generated.find(
        (r) =>
          r.alert === check.alertname &&
          (!expected.exp_labels.service_name ||
            r.labels.service_name === expected.exp_labels.service_name),
      );
      if (!rule) throw new Error(`no generated rule ${check.alertname}`);
      const render = (text) =>
        text.replace(/\{\{ \$labels\.(\w+) \}\}/g, (_, k) => expected.exp_labels[k] ?? '');
      const annotations = Object.fromEntries(
        Object.entries(rule.annotations).map(([k, v]) => [k, render(v)]),
      );
      if (SUMMARIES[check.alertname]) annotations.summary = SUMMARIES[check.alertname];
      for (const [k, v] of Object.entries(annotations)) {
        if (v.includes('{{'))
          throw new Error(`${check.alertname}: state the expected ${k} explicitly`);
      }
      expected.exp_annotations = annotations;
    }
  }
}
writeFileSync(
  join(dir, 'tests.yml'),
  // YAML is a superset of JSON, so promtool reads this directly.
  JSON.stringify(
    {
      rule_files: [...ruleFiles.map((f) => f.path.split('/').pop()), 'polyglot-services.yml'],
      evaluation_interval: '30s',
      tests,
    },
    null,
    2,
  ),
);

const prometheus = (
  await import(new URL('../packages/core/dist/index.js', import.meta.url).href)
).imageRef('prometheus');
const run = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    '--network',
    'none',
    '--mount',
    `type=bind,src=${dir},dst=/rules,readonly`,
    '--entrypoint',
    'promtool',
    prometheus,
    'test',
    'rules',
    '/rules/tests.yml',
  ],
  { encoding: 'utf8' },
);
console.log(`${run.stdout}${run.stderr}`.trim());
rmSync(dir, { recursive: true, force: true });
if (run.status !== 0) {
  console.error('\n✗ generated alert rules failed their unit tests');
  process.exit(1);
}
console.log(`\n✓ ${tests.length} alert rule unit tests passed`);
