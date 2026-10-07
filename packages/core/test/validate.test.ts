import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CODES, loadWorkspace, validateSources, type SourceFile } from '../src/index.js';

const examples = join(import.meta.dirname, '..', '..', '..', 'examples', 'workspaces');

const HEADER = 'apiVersion: raion/v1alpha1\nkind: Workspace\nmetadata:\n  name: test\n';

function workspace(spec: string, extra: SourceFile[] = []) {
  return validateSources([{ path: 'raion.yaml', content: `${HEADER}spec:\n${spec}` }, ...extra]);
}

function codes(result: ReturnType<typeof validateSources>) {
  return result.diagnostics.map((d) => d.code);
}

describe('example workspaces', () => {
  it('level1-basic is valid and resolves level 1 features', async () => {
    const result = await loadWorkspace(join(examples, 'level1-basic'));
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    const svc = result.workspace!.services[0]!;
    expect(svc.name).toBe('hello-api');
    expect(svc.features.logs).toBe(true);
    expect(svc.features.traces).toBe(false);
    expect(svc.features.slos).toBe(false);
    expect(svc.signals).toEqual({ metrics: true, logs: true, traces: true });
  });

  it('level3-sre merges split files and attaches standalone SLOs', async () => {
    const result = await loadWorkspace(join(examples, 'level3-sre'));
    expect(result.diagnostics).toEqual([]);
    const payment = result.workspace!.services.find((s) => s.name === 'payment-api')!;
    expect(payment.slos.map((s) => s.name).sort()).toEqual(['availability', 'latency']);
    const availability = payment.slos.find((s) => s.name === 'availability')!;
    expect(availability.target).toBe(99.9);
    expect(availability.errorBudgetRatio).toBe(0.001);
    expect(availability.windowMs).toBe(30 * 86_400_000);
    expect(availability.source).toEqual({ file: 'services/payment-api.yaml', line: 19 });
    const latency = payment.slos.find((s) => s.name === 'latency')!;
    expect(latency.source.file).toBe('slos/payment-api-latency.yaml');
    expect(payment.features.slos).toBe(true);
  });

  it('reports a missing workspace directory clearly', async () => {
    const result = await loadWorkspace(join(examples, 'does-not-exist'));
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual([CODES.MISSING_WORKSPACE_FILE]);
    expect(result.diagnostics[0]!.hint).toContain('raion init');
  });
});

describe('schema errors point at the right line', () => {
  it('flags unknown fields (typos) with their location', () => {
    const result = workspace('  levle: 2\n');
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({
      code: CODES.SCHEMA,
      file: 'raion.yaml',
      line: 6,
      message: 'spec: unknown field: levle',
    });
  });

  it('explains that level 4 is not available', () => {
    const result = workspace('  level: 4\n');
    expect(result.diagnostics[0]!.message).toContain('level 4 is not available');
    expect(result.diagnostics[0]!.line).toBe(6);
  });

  it('rejects inline secrets in receivers', () => {
    const result = workspace(
      '  notifications:\n    receivers:\n      - name: ops\n        type: slack\n        webhookUrl: https://hooks.slack.com/services/T000/B000/XXXX\n',
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]!.message).toContain('secret reference');
    expect(result.diagnostics[0]!.line).toBe(10);
  });

  it('rejects a 100% objective and explains why', () => {
    const result = workspace(
      '  services:\n    - name: api\n      type: api\n      slos:\n        - name: a\n          sli: { type: availability }\n          target: 100\n',
    );
    expect(result.diagnostics[0]!.message).toContain('no error budget');
    expect(result.diagnostics[0]!.line).toBe(12);
  });

  it('requires a minimum rate for throughput SLIs', () => {
    const result = workspace(
      '  services:\n    - name: api\n      type: api\n      slos:\n        - name: a\n          sli: { type: throughput }\n          target: 99\n',
    );
    expect(result.diagnostics[0]!.message).toContain(
      'sli.minRequestsPerSecond: this field is required',
    );
  });

  it('requires a threshold for latency SLIs', () => {
    const result = workspace(
      '  services:\n    - name: api\n      type: api\n      slos:\n        - name: a\n          sli: { type: latency }\n          target: 99\n',
    );
    expect(result.diagnostics[0]!.message).toBe(
      'spec.services[0].slos[0].sli.thresholdMs: this field is required',
    );
  });

  it('rejects SLO windows that are not whole days', () => {
    const result = workspace(
      '  services:\n    - name: api\n      type: api\n      slos:\n        - name: a\n          sli: { type: availability }\n          target: 99\n          window: 12h\n',
    );
    expect(result.diagnostics[0]!.message).toContain('whole number of days');
  });

  it('rejects invalid names', () => {
    const result = workspace('  services:\n    - name: Payment_API\n      type: api\n');
    expect(result.diagnostics[0]!.message).toContain('lowercase letters, digits and hyphens');
  });

  it('reports YAML syntax errors with position', () => {
    const result = validateSources([
      { path: 'raion.yaml', content: `${HEADER}spec:\n  level: [1\n` },
    ]);
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]!.code).toBe(CODES.YAML_SYNTAX);
    expect(result.diagnostics[0]!.line).toBeGreaterThan(0);
  });

  it('rejects documents with a wrong apiVersion or kind', () => {
    const result = validateSources([
      { path: 'raion.yaml', content: HEADER },
      { path: 'services/x.yaml', content: 'apiVersion: v1\nkind: Deployment\n' },
    ]);
    expect(codes(result)).toEqual([CODES.INVALID_HEADER, CODES.INVALID_HEADER]);
  });

  it('limits YAML alias expansion', () => {
    const bomb = [
      'a: &a [x, x, x, x, x, x, x, x, x, x]',
      'b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]',
      'c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]',
      'd: [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]',
    ].join('\n');
    const result = validateSources([{ path: 'raion.yaml', content: `${HEADER}${bomb}\n` }]);
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]!.code).toBe(CODES.YAML_SYNTAX);
  });
});

describe('cross-reference checks', () => {
  it('suggests the closest service name for unknown dependencies', () => {
    const result = workspace(
      '  services:\n    - name: ledger-api\n      type: api\n    - name: payment-api\n      type: api\n      dependencies:\n        - service: ledgr-api\n',
    );
    expect(result.diagnostics[0]).toMatchObject({
      code: CODES.UNKNOWN_DEPENDENCY,
      line: 12,
      hint: 'did you mean "ledger-api"?',
    });
  });

  it('detects duplicate services across files', () => {
    const result = workspace('  services:\n    - name: api\n      type: api\n', [
      {
        path: 'services/api.yaml',
        content:
          'apiVersion: raion/v1alpha1\nkind: Service\nmetadata:\n  name: api\nspec:\n  type: api\n',
      },
    ]);
    expect(codes(result)).toEqual([CODES.DUPLICATE_SERVICE]);
    expect(result.diagnostics[0]!.message).toContain('also in raion.yaml');
  });

  it('detects SLOs for unknown services', () => {
    const result = workspace('  services:\n    - name: api\n      type: api\n', [
      {
        path: 'slos/x.yaml',
        content:
          'apiVersion: raion/v1alpha1\nkind: SLO\nmetadata:\n  name: x\nspec:\n  service: apu\n  sli: { type: availability }\n  target: 99\n',
      },
    ]);
    expect(result.diagnostics[0]).toMatchObject({
      code: CODES.SLO_UNKNOWN_SERVICE,
      file: 'slos/x.yaml',
      line: 6,
      hint: 'did you mean "api"?',
    });
  });

  it('detects unknown teams and receivers', () => {
    const result = workspace(
      '  teams:\n    - name: payments\n      route: payments-slak\n  services:\n    - name: api\n      type: api\n      team: paymnts\n',
    );
    // The route is also ignored below level 3 (RAI-W107).
    expect(codes(result).sort()).toEqual(
      [CODES.UNKNOWN_TEAM, CODES.UNKNOWN_RECEIVER, CODES.TEAM_ROUTE_IGNORED].sort(),
    );
  });

  it('rejects a Workspace document outside raion.yaml', () => {
    const result = validateSources([
      { path: 'raion.yaml', content: HEADER },
      { path: 'services/ws.yaml', content: HEADER },
    ]);
    expect(codes(result)).toContain(CODES.WORKSPACE_PLACEMENT);
  });

  it('rejects services in another environment', () => {
    const result = workspace(
      '  services:\n    - name: api\n      type: api\n      environment: staging\n',
    );
    expect(codes(result)).toEqual([CODES.ENVIRONMENT_MISMATCH]);
  });

  it('rejects SLOs on services without metrics', () => {
    const result = workspace(
      '  level: 3\n  services:\n    - name: api\n      type: api\n      language: nodejs\n      signals: { metrics: false }\n      slos:\n        - name: a\n          sli: { type: availability }\n          target: 99\n',
    );
    expect(codes(result)).toEqual([CODES.SLO_WITHOUT_METRICS]);
  });

  it('warns (but passes) when SLOs are defined below level 3', () => {
    const result = workspace(
      '  services:\n    - name: api\n      type: api\n      language: nodejs\n      slos:\n        - name: a\n          sli: { type: availability }\n          target: 99\n',
    );
    expect(result.ok).toBe(true);
    expect(codes(result)).toEqual([CODES.SLO_FEATURE_DISABLED]);
  });

  it('lets a service override features of its level', () => {
    const result = workspace(
      '  level: 1\n  services:\n    - name: api\n      type: api\n      features: { traces: true }\n',
    );
    expect(result.workspace!.services[0]!.features.traces).toBe(true);
    expect(result.workspace!.features.traces).toBe(false);
  });

  it('warns about an empty workspace', () => {
    const result = workspace('  level: 1\n');
    expect(result.ok).toBe(true);
    expect(codes(result)).toEqual([CODES.NO_SERVICES]);
  });
});
