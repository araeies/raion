import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DATASOURCE_UIDS,
  generateRuntime,
  loadWorkspace,
  validateSources,
  type RuntimeBundle,
} from '../src/index.js';

const examples = join(import.meta.dirname, '..', '..', '..', 'examples');

interface Panel {
  id: number;
  type: string;
  title: string;
  gridPos: { x: number; y: number; w: number; h: number };
  datasource?: { type: string; uid: string };
  targets?: { refId: string; expr?: string; query?: string; queryType?: string }[];
  raion?: { expect: string };
}

function dashboards(bundle: RuntimeBundle) {
  return bundle.artifacts
    .filter((a) => a.path.startsWith('grafana/provisioning/dashboards/raion/'))
    .map((a) => ({
      path: a.path,
      live: a.live,
      json: JSON.parse(a.content) as { uid: string; title: string; panels: Panel[] },
    }));
}

function workspace(spec: string) {
  const result = validateSources([
    {
      path: 'raion.yaml',
      content: `apiVersion: raion/v1alpha1\nkind: Workspace\nmetadata:\n  name: t\nspec:\n${spec}`,
    },
  ]);
  if (!result.workspace) throw new Error(JSON.stringify(result.diagnostics));
  return result.workspace;
}

describe('generated dashboards', async () => {
  const result = await loadWorkspace(join(examples, 'nodejs-express', 'observability'));
  const bundle = generateRuntime(result.workspace!);
  const all = dashboards(bundle);

  it('creates the workspace dashboards plus one per service', () => {
    expect(all.map((d) => d.json.uid).sort()).toEqual([
      'raion-alerts',
      'raion-dependencies',
      'raion-infrastructure',
      'raion-logs',
      'raion-overview',
      'raion-stack-health',
      'raion-svc-ledger-api',
      'raion-svc-payment-api',
      'raion-traces',
    ]);
    expect(bundle.dashboards.find((d) => d.uid === 'raion-svc-payment-api')).toEqual({
      uid: 'raion-svc-payment-api',
      title: 'Service · payment-api',
      service: 'payment-api',
    });
  });

  it('matches the reviewed golden files', async () => {
    for (const d of all) {
      await expect(`${JSON.stringify(d.json, null, 2)}\n`).toMatchFileSnapshot(
        join('__golden__', 'nodejs-express', 'dashboards', `${d.json.uid}.json.txt`),
      );
    }
  });

  it('is picked up by Grafana without a restart', () => {
    expect(all.every((d) => d.live)).toBe(true);
  });

  it('only uses provisioned datasources and gives every data panel a query', () => {
    const uids = new Set(Object.values(DATASOURCE_UIDS));
    for (const d of all) {
      const ids = new Set<number>();
      for (const p of d.json.panels) {
        expect(ids.has(p.id), `${d.json.uid}: duplicate panel id ${p.id}`).toBe(false);
        ids.add(p.id);
        expect(p.gridPos.x + p.gridPos.w, `${d.json.uid}/${p.title}`).toBeLessThanOrEqual(24);
        if (p.type === 'row' || p.type === 'text') continue;
        expect(uids.has(p.datasource!.uid), `${d.json.uid}/${p.title}`).toBe(true);
        expect(p.targets!.length, `${d.json.uid}/${p.title}`).toBeGreaterThan(0);
        for (const t of p.targets!)
          expect(t.expr ?? t.query ?? t.queryType, `${d.json.uid}/${p.title}`).toBeTruthy();
        expect(['data', 'optional']).toContain(p.raion!.expect);
      }
    }
  });

  it('builds service panels from capabilities and filters telemetry export out of dependencies', () => {
    const payment = all.find((d) => d.json.uid === 'raion-svc-payment-api')!.json;
    const titles = payment.panels.map((p) => p.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        'Requests',
        'Error rate',
        'p95 latency',
        'Event loop delay (p99)',
        'Called by',
      ]),
    );
    const outgoing = payment.panels.find((p) => p.title === 'Outgoing calls by destination')!;
    expect(outgoing.targets![0]!.expr).toContain('server_address!="otel-collector"');
    expect(outgoing.raion!.expect).toBe('data'); // payment-api declares a dependency
    const ledger = all.find((d) => d.json.uid === 'raion-svc-ledger-api')!.json;
    expect(
      ledger.panels.find((p) => p.title === 'Outgoing calls by destination')!.raion!.expect,
    ).toBe('optional');
  });
});

describe('dashboards follow the workspace', () => {
  it('has no golden-signal panels for a service without HTTP metrics', () => {
    const bundle = generateRuntime(
      workspace('  services:\n    - name: batch\n      type: worker\n      language: java\n'),
    );
    const svc = dashboards(bundle).find((d) => d.json.uid === 'raion-svc-batch')!.json;
    const titles = svc.panels.map((p) => p.title);
    expect(titles).not.toContain('Requests');
    expect(titles).toContain('Recent logs');
  });

  it('leaves out trace, dependency and container dashboards when those are off', () => {
    const level1 = dashboards(generateRuntime(workspace('  level: 1\n'))).map((d) => d.json.uid);
    expect(level1).not.toContain('raion-traces');
    expect(level1).not.toContain('raion-dependencies');
    expect(level1).not.toContain('raion-containers');
    const withContainers = dashboards(
      generateRuntime(workspace('  infrastructure: { containers: true }\n')),
    ).map((d) => d.json.uid);
    expect(withContainers).toContain('raion-containers');
  });

  it('adds the service-graph connector to the collector only when dependencies are traced', () => {
    const collector = (b: RuntimeBundle) =>
      b.artifacts.find((a) => a.path === 'otel-collector/config.yaml')!.content;
    expect(collector(generateRuntime(workspace('  level: 1\n')))).not.toContain('servicegraph');
    expect(
      collector(
        generateRuntime(
          workspace(
            '  level: 2\n  services:\n    - name: a\n      type: api\n      language: nodejs\n',
          ),
        ),
      ),
    ).toContain('metrics_flush_interval: 15s');
  });
});
