import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, parseAllDocuments } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addSlo,
  burnConditions,
  fromOpenSlo,
  generateRuntime,
  renderWorkspace,
  ruleArtifacts,
  SloAuthoringError,
  toOpenSlo,
  validateSources,
  writeWorkspace,
  type SourceFile,
} from '../src/index.js';

const DAY = 86_400_000;

function workspace(slos: string, level = 3) {
  const result = validateSources([
    {
      path: 'raion.yaml',
      content: `apiVersion: raion/v1alpha1\nkind: Workspace\nmetadata:\n  name: t\nspec:\n  level: ${level}\n  services:\n    - name: shop\n      type: api\n      language: nodejs\n      team: web\n      slos:\n${slos}`,
    },
  ]);
  if (!result.workspace) throw new Error(JSON.stringify(result.diagnostics));
  return result.workspace;
}

const AVAILABILITY =
  '        - name: availability\n          sli: { type: availability }\n          target: 99.9\n';

describe('burn-rate conditions', () => {
  it('match the SRE Workbook for a 30-day window', () => {
    expect(burnConditions(30 * DAY)).toEqual([
      { severity: 'page', long: '1h', short: '5m', budget: 0.02, factor: 14.4 },
      { severity: 'page', long: '6h', short: '30m', budget: 0.05, factor: 6 },
      { severity: 'ticket', long: '1d', short: '2h', budget: 0.1, factor: 3 },
      { severity: 'ticket', long: '3d', short: '6h', budget: 0.1, factor: 1 },
    ]);
  });

  it('rescale for shorter windows and drop conditions that would fire within budget', () => {
    expect(burnConditions(7 * DAY).map((c) => [c.long, c.factor])).toEqual([
      ['1h', 3.36],
      ['6h', 1.4],
    ]);
    expect(burnConditions(1 * DAY)).toEqual([]);
  });
});

describe('SLO rules', () => {
  const rules = (slos: string) =>
    ruleArtifacts({ ws: workspace(slos), hostMetrics: false }).groups.filter((g) =>
      g.name.startsWith('raion-slo-'),
    );

  it('records traffic-weighted error ratios for every window', () => {
    const [group] = rules(AVAILABILITY);
    const records = group!.recording!.map((r) => r.record);
    expect(records).toEqual([
      'raion_slo:bad:rate5m',
      'raion_slo:total:rate5m',
      ...['5m', '30m', '1h', '2h', '6h', '1d', '3d'].map((w) => `raion_slo:error_ratio:rate${w}`),
      'raion_slo:error_ratio:window',
      'raion_slo:sli:ratio',
      'raion_slo:objective:ratio',
      'raion_slo:error_budget_remaining:ratio',
    ]);
    const window = group!.recording!.find((r) => r.record === 'raion_slo:error_ratio:window')!;
    expect(window.expr).toBe(
      'sum_over_time(raion_slo:bad:rate5m{service_name="shop",slo="availability"}[30d]) / sum_over_time(raion_slo:total:rate5m{service_name="shop",slo="availability"}[30d])',
    );
    expect(group!.recording!.find((r) => r.record === 'raion_slo:objective:ratio')!.expr).toBe(
      'vector(0.999)',
    );
  });

  it('pages and tickets with multi-window conditions', () => {
    const alerts = rules(AVAILABILITY)[0]!.rules;
    expect(alerts.map((a) => [a.alert, a.labels.severity])).toEqual([
      ['SLOErrorBudgetBurnFast', 'critical'],
      ['SLOErrorBudgetBurnSlow', 'warning'],
      ['SLOErrorBudgetExhausted', 'warning'],
    ]);
    expect(alerts[0]!.expr).toContain(
      'raion_slo:error_ratio:rate1h{service_name="shop",slo="availability"} > 0.0144 and',
    );
    expect(alerts[0]!.expr).toContain(
      'raion_slo:error_ratio:rate5m{service_name="shop",slo="availability"} > 0.0144',
    );
    expect(alerts[0]!.labels).toMatchObject({
      service_name: 'shop',
      slo: 'availability',
      team: 'web',
    });
  });

  it('keeps tiny budgets exact', () => {
    const alerts = rules(
      '        - name: a\n          sli: { type: availability }\n          target: 99.99\n',
    )[0]!.rules;
    expect(alerts[0]!.expr).toContain('> 0.00144 and');
  });

  it('derives each SLI from the HTTP metric', () => {
    const bad = (slo: string) =>
      rules(slo)[0]!.recording!.find((r) => r.record === 'raion_slo:bad:rate5m')!.expr;
    expect(bad(AVAILABILITY)).toContain('http_response_status_code=~"5.."');
    expect(
      bad(
        '        - name: l\n          sli: { type: latency, thresholdMs: 250 }\n          target: 99\n',
      ),
    ).toContain('le="0.25"');
    expect(
      bad(
        '        - name: t\n          sli: { type: throughput, minRequestsPerSecond: 2 }\n          target: 95\n',
      ),
    ).toContain('< bool 2');
  });

  it('adds the error budget policy to alerts', () => {
    const alerts = rules(`${AVAILABILITY}          policy: Freeze releases.\n`)[0]!.rules;
    expect(alerts[0]!.annotations.description).toContain('Error budget policy: Freeze releases.');
  });

  it('only generates SLO rules from level 3', () => {
    expect(
      ruleArtifacts({ ws: workspace(AVAILABILITY, 2), hostMetrics: false }).groups.some((g) =>
        g.name.startsWith('raion-slo-'),
      ),
    ).toBe(false);
  });

  it('adds SLO dashboards when SLOs are evaluated', () => {
    const uids = generateRuntime(workspace(AVAILABILITY)).dashboards.map((d) => d.uid);
    expect(uids).toContain('raion-slos');
    expect(generateRuntime(workspace(AVAILABILITY, 2)).dashboards.map((d) => d.uid)).not.toContain(
      'raion-slos',
    );
  });
});

describe('OpenSLO', () => {
  it('exports ratio and threshold SLOs as OpenSLO v1', () => {
    const text = toOpenSlo(
      workspace(
        `${AVAILABILITY}        - name: busy\n          sli: { type: throughput, minRequestsPerSecond: 3 }\n          target: 95\n          window: 7d\n`,
      ),
    );
    interface ExportedDoc {
      kind: string;
      metadata: { name: string };
      spec: {
        objectives: Record<string, unknown>[];
        indicator: { spec: { ratioMetric: { counter: boolean } } };
        budgetingMethod: string;
      };
    }
    const docs = parseAllDocuments(text).map((d) => d.toJS() as ExportedDoc);
    expect(docs.map((d) => `${d.kind}/${d.metadata.name}`)).toEqual([
      'Service/shop',
      'SLO/shop-availability',
      'SLO/shop-busy',
    ]);
    expect(docs[1]!.spec.objectives).toEqual([{ displayName: 'availability', target: 0.999 }]);
    expect(docs[1]!.spec.indicator.spec.ratioMetric.counter).toBe(false);
    expect(docs[2]!.spec.budgetingMethod).toBe('Timeslices');
    expect(docs[2]!.spec.objectives[0]).toMatchObject({
      op: 'gte',
      value: 3,
      target: 0.95,
      timeSliceWindow: '5m',
    });
  });

  it('imports ratio SLOs as custom SLIs and reports what it cannot import', () => {
    const exported = toOpenSlo(
      workspace(
        `${AVAILABILITY}        - name: busy\n          sli: { type: throughput, minRequestsPerSecond: 3 }\n          target: 95\n`,
      ),
    );
    const imported = fromOpenSlo(exported);
    expect(imported.slos.map((s) => s.path)).toEqual(['slos/shop-availability.yaml']);
    expect(imported.problems).toEqual([
      'SLO "shop-busy": only ratioMetric indicators can be imported (thresholdMetric and missing indicators cannot)',
    ]);
    const doc = parse(imported.slos[0]!.content) as {
      spec: { sli: { type: string; bad: string }; target: number; window: string };
    };
    expect(doc.spec).toMatchObject({ target: 99.9, window: '30d', sli: { type: 'custom' } });
    expect(doc.spec.sli.bad).toContain('5..');
  });

  it('refuses counters, calendar windows and unknown versions', () => {
    const base = (spec: string) =>
      `apiVersion: openslo/v1\nkind: SLO\nmetadata: { name: x }\nspec:\n  service: shop\n${spec}`;
    const ratio =
      '  indicator:\n    spec:\n      ratioMetric:\n        COUNTER\n        good: { metricSource: { type: Prometheus, spec: { query: g } } }\n        total: { metricSource: { type: Prometheus, spec: { query: t } } }\n';
    expect(
      fromOpenSlo(
        base(
          `${ratio.replace('COUNTER', 'counter: true')}  timeWindow: [{ duration: 30d, isRolling: true }]\n  objectives: [{ target: 0.99 }]\n`,
        ),
      ).problems[0],
    ).toContain('counter: true');
    expect(
      fromOpenSlo(
        base(
          `${ratio.replace('COUNTER', 'counter: false')}  timeWindow: [{ duration: 1M, isRolling: false }]\n  objectives: [{ target: 0.99 }]\n`,
        ),
      ).problems[0],
    ).toContain('rolling time window');
    expect(
      fromOpenSlo('apiVersion: openslo/v2alpha\nkind: SLO\nmetadata: { name: x }\n').problems[0],
    ).toContain('only openslo/v1');
  });
});

describe('creating SLOs', () => {
  let dir: string;
  let files: SourceFile[];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'raion-slo-'));
    files = renderWorkspace({
      name: 'acme',
      level: 3,
      environment: 'production',
      service: { name: 'shop', type: 'api', language: 'nodejs', runtime: 'compose' },
    });
    await writeWorkspace(dir, files);
    files = files.filter((f) => f.path.endsWith('.yaml'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a new, valid SLO file', async () => {
    const { file } = await addSlo(dir, files, {
      service: 'shop',
      name: 'checkout',
      sli: { type: 'latency', thresholdMs: 250 },
      target: 99.5,
      window: '28d',
      policy: 'Stop releases',
    });
    expect(file.path).toBe('slos/shop-checkout.yaml');
    expect(await readFile(join(dir, file.path), 'utf8')).toContain('policy: Stop releases');
  });

  it('refuses SLOs that would make the workspace invalid, and writes nothing', async () => {
    const error = await addSlo(dir, files, {
      service: 'shop',
      name: 'odd',
      sli: { type: 'latency', thresholdMs: 450 },
      target: 99,
      window: '30d',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SloAuthoringError);
    expect((error as SloAuthoringError).diagnostics[0]!.code).toBe('RAI-E022');
    await expect(readFile(join(dir, 'slos/shop-odd.yaml'))).rejects.toThrow();
  });

  it('never overwrites an existing file', async () => {
    await addSlo(dir, files, {
      service: 'shop',
      name: 'a',
      sli: { type: 'availability' },
      target: 99,
      window: '30d',
    });
    await expect(
      addSlo(dir, files, {
        service: 'shop',
        name: 'a',
        sli: { type: 'availability' },
        target: 99.9,
        window: '30d',
      }),
    ).rejects.toThrow(/already exists/);
  });
});
