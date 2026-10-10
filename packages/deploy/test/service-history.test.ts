import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { validateSources } from '@raion/core';
import { afterEach, describe, expect, it } from 'vitest';
import { GatewayClient, serviceHistory } from '../src/index.js';

function workspace(services: string) {
  return validateSources([
    {
      path: 'raion.yaml',
      content: `apiVersion: raion/v1alpha1\nkind: Workspace\nmetadata:\n  name: t\nspec:\n  level: 2\n  services:\n${services}`,
    },
  ]).workspace!;
}

let server: Server | undefined;
const queries: URLSearchParams[] = [];

async function gateway(values: (query: string) => [number, string][]): Promise<GatewayClient> {
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('content-type', 'application/json');
    if (url.pathname !== '/prometheus/api/v1/query_range') {
      res.statusCode = 404;
      res.end('{}');
      return;
    }
    queries.push(url.searchParams);
    const v = values(url.searchParams.get('query')!);
    res.end(JSON.stringify({ data: { result: v.length ? [{ values: v }] : [] } }));
  });
  server = srv;
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return new GatewayClient(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`, 't');
}

afterEach(() => {
  server?.close();
  queries.length = 0;
});

describe('serviceHistory', () => {
  it('charts requests, failures and response time of an API over the chosen period', async () => {
    const svc = workspace('    - name: shop\n      type: api\n      language: nodejs\n')
      .services[0]!;
    const g = await gateway((q) =>
      q.startsWith('sum(rate')
        ? [
            [1000, '4.5'],
            [1030, 'NaN'],
            [1060, '5'],
          ]
        : [],
    );
    const h = await serviceHistory(g, svc, 360, 3_600_000);
    expect(h).toMatchObject({ from: 3600 - 21600, to: 3600, step: 180 });
    expect(h.series.map((s) => [s.key, s.unit])).toEqual([
      ['requests', 'perSecond'],
      ['errors', 'ratio'],
      ['p95', 'seconds'],
    ]);
    // Values Prometheus cannot compute (NaN) are gaps, not points.
    expect(h.series[0]!.points).toEqual([
      [1000, 4.5],
      [1060, 5],
    ]);
    expect(h.series[2]!.points).toEqual([]);
    expect(queries.map((q) => q.get('step'))).toEqual(['180', '180', '180']);
    expect(queries[0]!.get('query')).toBe(
      'sum(rate(http_server_request_duration_seconds_count{service_name="shop"}[360s]))',
    );
  });

  it('charts outside checks of an application that runs elsewhere', async () => {
    const svc = workspace(
      '    - name: site\n      type: web\n      runtime:\n        type: remote\n      checks:\n        - url: https://example.com/health\n',
    ).services[0]!;
    const g = await gateway(() => [[1000, '1']]);
    const h = await serviceHistory(g, svc, 60, 3_600_000);
    expect(h.series.map((s) => s.key)).toEqual(['up', 'answer']);
    expect(queries[0]!.get('query')).toContain('probe_success{');
    expect(h.step).toBe(30);
  });
});
