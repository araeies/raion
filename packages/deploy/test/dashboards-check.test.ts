import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateRuntime, validateSources } from '@raion/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkDashboards,
  computePlan,
  GatewayClient,
  ReleaseStore,
  StatePaths,
} from '../src/index.js';

const dashboard = {
  uid: 'd1',
  title: 'Test',
  json: {
    panels: [
      { id: 1, type: 'row', title: 'Row' },
      { id: 2, type: 'text', title: 'About' },
      {
        id: 3,
        type: 'stat',
        title: 'Requests',
        datasource: { type: 'prometheus', uid: 'raion-prometheus' },
        targets: [{ refId: 'A', expr: 'up' }],
        raion: { expect: 'data' },
      },
      {
        id: 4,
        type: 'logs',
        title: 'Errors',
        datasource: { type: 'loki', uid: 'raion-loki' },
        targets: [{ refId: 'A', expr: '{a="b"} |= "error"' }],
        raion: { expect: 'optional' },
      },
      {
        id: 5,
        type: 'timeseries',
        title: 'Broken',
        datasource: { type: 'prometheus', uid: 'raion-prometheus' },
        targets: [{ refId: 'A', expr: 'sum(' }],
        raion: { expect: 'data' },
      },
      {
        id: 6,
        type: 'nodeGraph',
        title: 'Service map',
        datasource: { type: 'tempo', uid: 'raion-tempo' },
        targets: [{ refId: 'A', queryType: 'serviceMap' }],
        raion: { expect: 'data' },
      },
    ],
  },
};

let server: Server | undefined;
const requests: { url: string; headers: IncomingHttpHeaders; body: string }[] = [];

/** A fake Grafana behind the gateway: answers /api/ds/query per query expression. */
async function fakeGrafana(loaded: boolean): Promise<GatewayClient> {
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      requests.push({ url: req.url ?? '', headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/grafana/api/dashboards/uid/')) {
        res.statusCode = loaded ? 200 : 404;
        res.end('{}');
        return;
      }
      const { queries } = JSON.parse(body) as { queries: { refId: string; expr?: string }[] };
      const q = queries[0]!;
      if (q.expr === 'sum(') {
        res.statusCode = 400;
        res.end(JSON.stringify({ results: { A: { error: 'parse error: unclosed parenthesis' } } }));
      } else if (q.expr?.startsWith('{a="b"}')) {
        res.end(JSON.stringify({ results: { A: { frames: [{ data: { values: [[]] } }] } } }));
      } else {
        res.end(
          JSON.stringify({ results: { A: { frames: [{ data: { values: [[1], [42]] } }] } } }),
        );
      }
    });
  });
  server = srv;
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return new GatewayClient(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`, 'secret');
}

afterEach(() => {
  server?.close();
  requests.length = 0;
});

describe('checkDashboards', () => {
  it('runs every panel through Grafana and classifies the results', async () => {
    const result = await checkDashboards(await fakeGrafana(true), [dashboard]);
    expect(result.dashboards).toEqual([{ uid: 'd1', title: 'Test', loaded: true }]);
    expect(result.panels.map((p) => [p.panel, p.status, p.ok])).toEqual([
      ['Requests', 'data', true],
      ['Errors', 'empty', true],
      ['Broken', 'error', false],
      ['Service map', 'data', true],
    ]);
    expect(result.panels.find((p) => p.panel === 'Broken')!.detail).toContain(
      'unclosed parenthesis',
    );
    expect(result.ok).toBe(false);
  });

  it('queries as a read-only Grafana user and checks the service map through its metrics', async () => {
    await checkDashboards(await fakeGrafana(true), [dashboard]);
    const query = requests.find((r) => r.url === '/grafana/api/ds/query')!;
    expect(query.headers['x-webauth-user']).toBe('raion-system');
    expect(query.headers['x-webauth-role']).toBe('Viewer');
    expect(query.headers['x-raion-gateway-token']).toBe('secret');
    expect(requests.some((r) => r.body.includes('traces_service_graph_request_total'))).toBe(true);
  });

  it('reports dashboards Grafana did not load', async () => {
    const result = await checkDashboards(await fakeGrafana(false), [dashboard]);
    expect(result.dashboards[0]!.loaded).toBe(false);
    expect(result.ok).toBe(false);
  });
});

describe('plan: dashboards refresh without a restart', () => {
  it('marks dashboard-only changes as "refresh"', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'raion-plan-'));
    try {
      const ws = (services: string) =>
        validateSources([
          {
            path: 'raion.yaml',
            content: `apiVersion: raion/v1alpha1\nkind: Workspace\nmetadata:\n  name: t\nspec:\n  level: 2\n  services:\n${services}`,
          },
        ]).workspace!;
      const store = new ReleaseStore(new StatePaths(dir));
      const before = store.create(
        generateRuntime(ws('    - name: a\n      type: api\n      language: nodejs\n')),
        {
          createdBy: 't',
          workspace: dir,
        },
      );
      // Changing a description only changes that service's dashboard.
      const plan = computePlan(
        generateRuntime(
          ws(
            '    - name: a\n      type: api\n      language: nodejs\n      description: Shop front\n',
          ),
        ),
        before,
      );
      expect(plan.components.filter((c) => c.action !== 'unchanged')).toEqual([
        {
          component: 'grafana',
          action: 'refresh',
          reasons: ['1 file(s) picked up without a restart'],
          privileges: [],
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
