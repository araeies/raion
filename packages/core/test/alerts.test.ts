import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  CODES,
  generateRuntime,
  ruleArtifacts,
  validateSources,
  type RuntimeBundle,
} from '../src/index.js';

function workspace(spec: string) {
  return validateSources([
    {
      path: 'raion.yaml',
      content: `apiVersion: raion/v1alpha1\nkind: Workspace\nmetadata:\n  name: t\nspec:\n${spec}`,
    },
  ]);
}

function resolved(spec: string) {
  const r = workspace(spec);
  if (!r.workspace) throw new Error(JSON.stringify(r.diagnostics));
  return r.workspace;
}

const SERVICE = `  services:
    - name: shop
      type: api
      language: nodejs
      team: web
      tier: critical
`;

function alertmanager(bundle: RuntimeBundle) {
  return parse(
    bundle.artifacts.find((a) => a.path === 'alertmanager/alertmanager.yml')!.content,
  ) as {
    route: { receiver: string; routes: { receiver: string; matchers: string[] }[] };
    receivers: Record<string, unknown>[];
  };
}

describe('alert rules', () => {
  it('generates service alerts from HTTP metrics, with ownership and links', () => {
    const ws = resolved(
      `  teams: [{ name: web }]\n${SERVICE}      runbooks:\n        - alert: ServiceHighErrorRate\n          url: https://wiki.example.com/shop\n`,
    );
    const rules = ruleArtifacts({ ws, hostMetrics: true }).groups.find(
      (g) => g.name === 'raion-service-shop',
    )!.rules;
    expect(rules.map((r) => r.alert)).toEqual([
      'ServiceHighErrorRate',
      'ServiceHighLatency',
      'ServiceTelemetryMissing',
    ]);
    const errors = rules[0]!;
    expect(errors.labels).toEqual({
      severity: 'critical',
      service_name: 'shop',
      team: 'web',
      raion_scope: 'service',
    });
    expect(errors.for).toBe('5m');
    expect(errors.expr).toContain(
      '> 0.05 and sum(rate(http_server_request_duration_seconds_count{service_name="shop"}[5m])) > 0.05',
    );
    expect(errors.annotations.runbook_url).toBe('https://wiki.example.com/shop');
    expect(errors.annotations.dashboard_url).toBe('http://127.0.0.1:7600/grafana/d/raion-svc-shop');
    expect(rules[1]!.labels.severity).toBe('warning');
  });

  it('applies per-service thresholds', () => {
    const ws = resolved(
      `${SERVICE}      alerts: { errorRatePercent: 1, latencyP95Ms: 300, for: 10m, missingTelemetry: false }\n`,
    );
    const rules = ruleArtifacts({ ws, hostMetrics: false }).groups.find(
      (g) => g.name === 'raion-service-shop',
    )!.rules;
    expect(rules.map((r) => r.alert)).toEqual(['ServiceHighErrorRate', 'ServiceHighLatency']);
    expect(rules[0]!.expr).toContain('> 0.01 and');
    expect(rules[1]!.expr).toContain('> 0.3 and');
    expect(rules[0]!.for).toBe('10m');
  });

  it('generates no service alerts when disabled or without HTTP metrics', () => {
    const off = resolved(`${SERVICE}      alerts: { enabled: false }\n`);
    expect(ruleArtifacts({ ws: off, hostMetrics: false }).groups.map((g) => g.name)).toEqual([
      'raion-platform',
    ]);
    const java = resolved(
      '  services:\n    - name: batch\n      type: worker\n      language: java\n',
    );
    expect(ruleArtifacts({ ws: java, hostMetrics: false }).groups.map((g) => g.name)).toEqual([
      'raion-platform',
    ]);
  });

  it('always watches the stack itself, including the Watchdog', () => {
    const groups = ruleArtifacts({ ws: resolved('  level: 1\n'), hostMetrics: true }).groups;
    const platform = groups.find((g) => g.name === 'raion-platform')!.rules.map((r) => r.alert);
    expect(platform).toEqual(
      expect.arrayContaining([
        'Watchdog',
        'RaionComponentDown',
        'RaionTelemetryNotDelivered',
        'RaionNotificationsFailing',
      ]),
    );
    expect(
      groups.find((g) => g.name === 'raion-infrastructure')!.rules.map((r) => r.alert),
    ).toContain('HostDiskAlmostFull');
  });

  it('summarizes rules on the bundle for the UI', () => {
    const bundle = generateRuntime(resolved(SERVICE));
    expect(bundle.alerts.find((a) => a.alert === 'ServiceHighErrorRate')).toMatchObject({
      group: 'raion-service-shop',
      severity: 'critical',
      service: 'shop',
      for: '5m',
    });
  });
});

describe('alert routing', () => {
  const receivers = `  notifications:
    defaultReceiver: ops
    receivers:
      - name: ops
        type: email
        to: [ops@example.com]
        from: raion@example.com
        smarthost: smtp.example.com:587
        password: \${env:SMTP_PASSWORD}
      - name: web-slack
        type: slack
        webhookUrl: \${secret:WEB_SLACK}
  teams:
    - name: web
      route: web-slack
`;

  it('routes team alerts at level 3 and everything else to the default receiver', () => {
    const am = alertmanager(generateRuntime(resolved(`  level: 3\n${receivers}${SERVICE}`)));
    expect(am.route.receiver).toBe('ops');
    expect(am.route.routes).toEqual([
      { receiver: 'inbox', matchers: ['alertname="Watchdog"'], repeat_interval: '1m' },
      { receiver: 'web-slack', matchers: ['team="web"'], continue: false },
    ]);
  });

  it('ignores team routes below level 3, and says so', () => {
    const result = workspace(`  level: 2\n${receivers}${SERVICE}`);
    expect(result.diagnostics.map((d) => d.code)).toEqual([CODES.TEAM_ROUTE_IGNORED]);
    const am = alertmanager(generateRuntime(result.workspace!));
    expect(am.route.routes.map((r) => r.receiver)).toEqual(['inbox']);
  });

  it('reads credentials from secret files, never from configuration', () => {
    const bundle = generateRuntime(resolved(`  level: 3\n${receivers}${SERVICE}`));
    const amText = bundle.artifacts.find(
      (a) => a.path === 'alertmanager/alertmanager.yml',
    )!.content;
    expect(amText).toContain('api_url_file: /run/secrets/raion_secret_web_slack');
    expect(amText).toContain('auth_password_file: /run/secrets/raion_env_smtp_password');
    expect(bundle.secrets).toEqual([
      {
        key: 'SMTP_PASSWORD',
        source: 'env',
        file: 'env.SMTP_PASSWORD',
        composeName: 'raion_env_smtp_password',
      },
      {
        key: 'WEB_SLACK',
        source: 'secret',
        file: 'WEB_SLACK',
        composeName: 'raion_secret_web_slack',
      },
    ]);
    const compose = parse(bundle.artifacts.find((a) => a.path === 'compose.yaml')!.content) as {
      services: { alertmanager: { secrets: string[] } };
      secrets: Record<string, { file: string }>;
    };
    expect(compose.services.alertmanager.secrets).toEqual([
      'raion_env_smtp_password',
      'raion_secret_web_slack',
    ]);
    expect(compose.secrets.raion_secret_web_slack).toEqual({ file: '../secrets/WEB_SLACK' });
  });

  it('rejects an unknown default receiver and warns about runbooks for unknown alerts', () => {
    const bad = workspace('  notifications: { defaultReceiver: pager }\n');
    expect(bad.diagnostics[0]).toMatchObject({
      code: CODES.UNKNOWN_RECEIVER,
      message: 'default receiver "pager" is not defined',
    });
    const runbook = workspace(
      `${SERVICE}      runbooks:\n        - alert: HighErrors\n          url: https://x.example.com\n`,
    );
    expect(runbook.diagnostics.map((d) => d.code)).toEqual([CODES.RUNBOOK_UNKNOWN_ALERT]);
  });
});
