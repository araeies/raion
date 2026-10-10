import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  advise,
  AdvisorConflictError,
  applyAutofix,
  unifiedDiff,
  validateSources,
  type Finding,
  type LiveFacts,
  type SourceFile,
} from '../src/index.js';

const WORKSPACE = `# The Acme workspace.
apiVersion: raion/v1alpha1
kind: Workspace
metadata:
  name: acme
spec:
  level: 2 # production
  services:
    # Nightly reports; alerts were turned off while it was being rewritten.
    - name: reports
      type: worker
      language: nodejs
      alerts: { enabled: false }
`;

const PAYMENT = `apiVersion: raion/v1alpha1
kind: Service
metadata:
  name: payment-api
spec:
  tier: critical
  team: payments
  type: api
  # Chosen automatically from the language.
  language: nodejs
  dependencies:
    - service: ledger-api
    - external: { name: postgres-main, kind: postgresql }
`;

const LEDGER = `apiVersion: raion/v1alpha1
kind: Service
metadata:
  name: ledger-api
spec:
  type: api
  language: nodejs
---
apiVersion: raion/v1alpha1
kind: Service
metadata:
  name: fraud-api
spec:
  type: api
  language: php
`;

function files(overrides: Record<string, string> = {}): SourceFile[] {
  const all: Record<string, string> = {
    'raion.yaml': WORKSPACE,
    'services/payment-api.yaml': PAYMENT,
    'services/ledger.yaml': LEDGER,
    ...overrides,
  };
  return Object.entries(all).map(([path, content]) => ({ path, content }));
}

function run(sources: SourceFile[], facts?: Partial<LiveFacts>) {
  const result = validateSources(sources);
  if (!result.workspace) throw new Error(JSON.stringify(result.diagnostics));
  return advise(result.workspace, sources, {
    ...(facts ? { facts: { collectedAt: 'now', window: '1h', problems: [], ...facts } } : {}),
  });
}

function find(findings: Finding[], id: string): Finding {
  const f = findings.find((x) => x.id === id);
  if (!f) throw new Error(`no finding ${id}; got ${findings.map((x) => x.id).join(', ')}`);
  return f;
}

/** Applies an autofix in memory and validates the result, like `raion plan` would. */
function applied(sources: SourceFile[], f: Finding) {
  expect(f.autofix).toBeDefined();
  const next = new Map(sources.map((s) => [s.path, s.content]));
  for (const c of f.autofix!.changes) {
    expect(c.before).toBe(next.get(c.path) ?? null);
    next.set(c.path, c.after);
  }
  const updated = [...next].map(([path, content]) => ({ path, content }));
  const result = validateSources(updated);
  expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return { files: updated, ws: result.workspace!, content: (p: string) => next.get(p)! };
}

describe('advisor rules (configuration only)', () => {
  const report = run(files());

  it('critical-service-without-slo: offers an availability SLO that is measured after apply', () => {
    const f = find(report.findings, 'critical-service-without-slo/payment-api');
    expect(f.severity).toBe('warning');
    expect(f.autofix!.changes.map((c) => c.path)).toEqual([
      'slos/payment-api-availability.yaml',
      'services/payment-api.yaml',
    ]);
    const after = applied(files(), f);
    const svc = after.ws.services.find((s) => s.name === 'payment-api')!;
    expect(svc.slos.map((s) => [s.name, s.target, s.window])).toEqual([
      ['availability', 99.9, '30d'],
    ]);
    expect(svc.features.slos).toBe(true);
    // A hand-written comment survives the edit, and only the new lines are added.
    expect(after.content('services/payment-api.yaml')).toContain(
      '  # Chosen automatically from the language.\n',
    );
    const edit = f.autofix!.changes[1]!;
    expect(edit.diff.split('\n').filter((l) => /^[+-][^+-]/.test(l))).toEqual([
      '+  features:',
      '+    slos: true',
    ]);
    expect(run(after.files).findings.map((x) => x.rule)).not.toContain(
      'critical-service-without-slo',
    );
  });

  it('service-without-alerts: edits an inline service in raion.yaml, keeping its comments', () => {
    const f = find(report.findings, 'service-without-alerts/reports');
    const after = applied(files(), f);
    expect(after.ws.services.find((s) => s.name === 'reports')!.alerts.enabled).toBe(true);
    expect(after.content('raion.yaml')).toContain('  level: 2 # production\n');
    expect(after.content('raion.yaml')).toContain('    # Nightly reports;');
  });

  it('service-without-golden-signals: explains that the language has no integration yet', () => {
    const f = find(report.findings, 'service-without-golden-signals/fraud-api');
    expect(f.fix).toContain('Raion has no php integration');
    expect(f.autofix).toBeUndefined();
  });

  it('page-alert-without-runbook: lists the paging alerts of a critical service', () => {
    const f = find(report.findings, 'page-alert-without-runbook/payment-api');
    expect(f.evidence).toBe('Without a runbook: ServiceHighErrorRate, ServiceTelemetryMissing');
  });

  it('database-not-monitored: reports external databases once, with their users', () => {
    const f = find(report.findings, 'database-not-monitored/postgres-main');
    expect(f.title).toBe('PostgreSQL "postgres-main" is not monitored');
    expect(f.why).toContain('payment-api depends on it');
  });

  it('dependencies-not-traced: offers traces and the service graph at level 1', () => {
    const level1 = files({ 'raion.yaml': WORKSPACE.replace('level: 2', 'level: 1') });
    const f = find(run(level1).findings, 'dependencies-not-traced/payment-api');
    const svc = applied(level1, f).ws.services.find((s) => s.name === 'payment-api')!;
    expect([svc.features.traces, svc.features.serviceGraph]).toEqual([true, true]);
  });

  it('slos-not-evaluated: turns SLOs on for the service only', () => {
    const withSlo = files({
      'slos/ledger.yaml':
        'apiVersion: raion/v1alpha1\nkind: SLO\nmetadata:\n  name: availability\nspec:\n  service: ledger-api\n  sli: { type: availability }\n  target: 99\n',
    });
    const f = find(run(withSlo).findings, 'slos-not-evaluated/ledger-api');
    const after = applied(withSlo, f);
    expect(after.ws.services.find((s) => s.name === 'ledger-api')!.features.slos).toBe(true);
    expect(after.ws.services.find((s) => s.name === 'payment-api')!.features.slos).toBe(false);
  });

  it('every offered autofix produces a valid workspace', () => {
    for (const f of report.findings.filter((x) => x.autofix)) applied(files(), f);
    expect(report.summary.fixable).toBeGreaterThanOrEqual(2);
  });

  it('live rules stay silent without live data', () => {
    const live = [
      'busiest-service-without-slo',
      'undeclared-dependency',
      'unused-dependency',
      'low-log-trace-correlation',
      'collector-dropping-telemetry',
      'high-cardinality-metric',
    ];
    expect(report.findings.filter((f) => live.includes(f.rule))).toEqual([]);
    expect(report.facts).toBeUndefined();
  });
});

describe('advisor rules (live data)', () => {
  it('busiest-service-without-slo: reports the service with the most traffic', () => {
    // When the busiest service is critical, its own rule already reports it.
    const critical = run(files(), { requestRates: { 'ledger-api': 12, 'payment-api': 40 } });
    expect(critical.findings.some((f) => f.rule === 'busiest-service-without-slo')).toBe(false);
    const r = run(files(), { requestRates: { 'ledger-api': 40, 'payment-api': 12, reports: 0 } });
    const f = find(r.findings, 'busiest-service-without-slo/ledger-api');
    expect(f.evidence).toBe('40/s requests over the last 1h');
    expect(applied(files(), f).ws.services.find((s) => s.name === 'ledger-api')!.slos).toHaveLength(
      1,
    );
  });

  it('undeclared-dependency: declares a dependency seen in traces', () => {
    const r = run(files(), {
      edges: [
        { client: 'payment-api', server: 'fraud-api', requestsPerSecond: 3 },
        { client: 'payment-api', server: 'ledger-api', requestsPerSecond: 3 },
        { client: 'user', server: 'payment-api', requestsPerSecond: 3 },
      ],
    });
    expect(r.findings.filter((f) => f.rule === 'undeclared-dependency').map((f) => f.id)).toEqual([
      'undeclared-dependency/payment-api->fraud-api',
    ]);
    const f = find(r.findings, 'undeclared-dependency/payment-api->fraud-api');
    const after = applied(files(), f);
    expect(after.ws.services.find((s) => s.name === 'payment-api')!.dependencies).toContainEqual({
      service: 'fraud-api',
    });
    expect(f.autofix!.changes[0]!.diff).toContain('+    - service: fraud-api');
  });

  it('unused-dependency: only when the client had traffic but never called', () => {
    const quiet = run(files(), { requestRates: { 'payment-api': 0 }, edges: [] });
    expect(quiet.findings.some((f) => f.rule === 'unused-dependency')).toBe(false);
    const busy = run(files(), { requestRates: { 'payment-api': 2 }, edges: [] });
    expect(
      find(busy.findings, 'unused-dependency/payment-api->ledger-api').autofix,
    ).toBeUndefined();
  });

  it('low-log-trace-correlation: reports the share of lines without a trace ID', () => {
    const r = run(files(), {
      logs: {
        'payment-api': { lines: 100, withTraceId: 37 },
        'ledger-api': { lines: 100, withTraceId: 95 },
        reports: { lines: 5, withTraceId: 0 },
      },
    });
    const f = find(r.findings, 'low-log-trace-correlation/payment-api');
    expect(f.title).toBe("63% of payment-api's log lines do not contain a trace ID");
    expect(f.fix).toContain('pino, winston or bunyan');
    expect(r.findings.filter((x) => x.rule === 'low-log-trace-correlation')).toHaveLength(1);
  });

  it('collector-dropping-telemetry: reports refused and undelivered telemetry', () => {
    const ok = run(files(), { collector: { received: 10_000, refused: 5, exportFailed: 0 } });
    expect(ok.findings.some((f) => f.rule === 'collector-dropping-telemetry')).toBe(false);
    const r = run(files(), { collector: { received: 1000, refused: 30, exportFailed: 120 } });
    const f = find(r.findings, 'collector-dropping-telemetry/otel-collector');
    expect(f.severity).toBe('critical');
    expect(f.title).toBe('The collector lost 15% of the telemetry it received');
    expect(f.fix).toContain('30 items were refused');
    expect(f.fix).toContain('120 items could not be delivered');
  });

  it('high-cardinality-metric: reports metrics and labels over the limits', () => {
    const r = run(files(), {
      cardinality: {
        metrics: [
          { name: 'checkout_items_total', series: 25_000 },
          { name: 'up', series: 12 },
        ],
        labels: [
          { name: '__name__', values: 90_000 },
          { name: 'user_id', values: 8_000 },
        ],
      },
    });
    expect(r.findings.filter((f) => f.rule === 'high-cardinality-metric').map((f) => f.id)).toEqual(
      ['high-cardinality-metric/checkout_items_total', 'high-cardinality-metric/label:user_id'],
    );
  });
});

describe('ignoring findings', () => {
  it('marks ignored findings with the reason and leaves them out of the summary', () => {
    const ignored = files({
      'raion.yaml': `${WORKSPACE}  advisor:\n    ignore:\n      - rule: database-not-monitored\n        reason: The DBA team monitors it\n      - rule: service-without-golden-signals\n        subject: fraud-api\n        reason: Rewritten in Node.js next quarter\n`,
    });
    const r = run(ignored);
    expect(find(r.findings, 'database-not-monitored/postgres-main').ignored).toEqual({
      reason: 'The DBA team monitors it',
    });
    expect(r.summary.ignored).toBe(2);
    expect(r.findings.at(-1)!.ignored).toBeDefined();
  });

  it('rejects unknown rules in advisor.ignore', () => {
    const result = validateSources(
      files({
        'raion.yaml': `${WORKSPACE}  advisor:\n    ignore:\n      - rule: no-such-rule\n        reason: x\n`,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]!.message).toContain('rule must be one of');
  });
});

describe('applying an autofix', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'raion-advisor-'));
    for (const f of files()) {
      await mkdir(join(dir, f.path, '..'), { recursive: true });
      await writeFile(join(dir, f.path), f.content);
    }
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it('writes the new and changed files', async () => {
    const f = find(run(files()).findings, 'critical-service-without-slo/payment-api');
    expect(await applyAutofix(dir, f.autofix!)).toEqual([
      'slos/payment-api-availability.yaml',
      'services/payment-api.yaml',
    ]);
    expect(await readFile(join(dir, 'services/payment-api.yaml'), 'utf8')).toContain('slos: true');
  });

  it('refuses when a file changed since the fix was computed, and writes nothing', async () => {
    const f = find(run(files()).findings, 'critical-service-without-slo/payment-api');
    await writeFile(join(dir, 'services/payment-api.yaml'), `${PAYMENT}# edited by someone else\n`);
    await expect(applyAutofix(dir, f.autofix!)).rejects.toBeInstanceOf(AdvisorConflictError);
    await expect(readFile(join(dir, 'slos/payment-api-availability.yaml'))).rejects.toThrow();
  });

  it('refuses paths outside the workspace', async () => {
    await expect(
      applyAutofix(dir, {
        summary: 'x',
        changes: [{ path: '../evil.yaml', before: null, after: 'x', diff: '' }],
      }),
    ).rejects.toThrow('outside the workspace');
  });

  it('keeps Windows line endings', () => {
    const crlf = files({ 'services/payment-api.yaml': PAYMENT.replaceAll('\n', '\r\n') });
    const f = find(run(crlf).findings, 'critical-service-without-slo/payment-api');
    const edit = f.autofix!.changes.find((c) => c.path === 'services/payment-api.yaml')!;
    expect(edit.after).toContain('  features:\r\n    slos: true\r\n');
    expect(edit.after.replaceAll('\r\n', '')).not.toContain('\n');
  });
});

describe('unifiedDiff', () => {
  it('shows a hunk with context around the change', () => {
    expect(unifiedDiff('a.yaml', 'a\nb\nc\nd\ne\nf\ng\n', 'a\nb\nc\nd\nX\nf\ng\n')).toBe(
      '--- a/a.yaml\n+++ b/a.yaml\n@@ -2,6 +2,6 @@\n b\n c\n d\n-e\n+X\n f\n g\n',
    );
  });

  it('shows a new file', () => {
    expect(unifiedDiff('n.yaml', null, 'x\ny\n')).toBe(
      '--- /dev/null\n+++ b/n.yaml\n@@ -0,0 +1,2 @@\n+x\n+y\n',
    );
  });
});
