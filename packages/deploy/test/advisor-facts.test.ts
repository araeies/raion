import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { advise, validateSources } from '@raion/core';
import { afterEach, describe, expect, it } from 'vitest';
import { collectLiveFacts, GatewayClient } from '../src/index.js';

const files = [
  {
    path: 'raion.yaml',
    content:
      'apiVersion: raion/v1alpha1\nkind: Workspace\nmetadata:\n  name: t\nspec:\n  level: 2\n  services:\n    - name: shop\n      type: api\n      language: nodejs\n    - name: cart\n      type: api\n      language: nodejs\n',
  },
];
const ws = validateSources(files).workspace!;

type Vector = { metric: Record<string, string>; value: [number, string] }[];

let server: Server | undefined;
const queries: string[] = [];

async function gateway(handlers: {
  prom: (query: string) => Vector;
  loki: (query: string) => Vector;
  tsdb?: number;
}): Promise<GatewayClient> {
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const query = url.searchParams.get('query') ?? '';
    queries.push(query);
    res.setHeader('content-type', 'application/json');
    if (req.headers['x-raion-gateway-token'] !== 't') {
      res.statusCode = 401;
      res.end('{}');
    } else if (url.pathname === '/prometheus/api/v1/query') {
      res.end(JSON.stringify({ data: { result: handlers.prom(query) } }));
    } else if (url.pathname === '/loki/loki/api/v1/query') {
      res.end(JSON.stringify({ data: { result: handlers.loki(query) } }));
    } else if (url.pathname === '/prometheus/api/v1/status/tsdb') {
      res.statusCode = handlers.tsdb ?? 200;
      res.end(
        JSON.stringify({
          data: {
            seriesCountByMetricName: [
              { name: 'http_server_request_duration_seconds_bucket', value: 480 },
            ],
            labelValueCountByLabelName: [{ name: '__name__', value: 900 }],
          },
        }),
      );
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  server = srv;
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return new GatewayClient(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`, 't');
}

afterEach(() => {
  server?.close();
  queries.length = 0;
});

const sample = (metric: Record<string, string>, value: number) => ({
  metric,
  value: [0, String(value)] as [number, string],
});

describe('collectLiveFacts', () => {
  it('reads request rates, log correlation, edges, collector losses and series counts', async () => {
    const g = await gateway({
      prom: (q) => {
        if (q.includes('http_server_request_duration_seconds_count')) {
          return [sample({ service_name: 'shop' }, 4), sample({ service_name: 'cart' }, 1.5)];
        }
        if (q.includes('traces_service_graph_request_total')) {
          return [sample({ client: 'shop', server: 'cart' }, 1.2)];
        }
        if (q.includes('otelcol_exporter_send_failed_spans')) return [sample({}, 7)];
        if (q.includes('otelcol_receiver_accepted_spans')) return [sample({}, 1000)];
        if (q.includes('otelcol_receiver_refused_spans')) return [sample({}, 3)];
        return [];
      },
      loki: (q) =>
        q.includes('trace_id')
          ? [sample({ service_name: 'shop' }, 40)]
          : [sample({ service_name: 'shop' }, 100), sample({ service_name: 'cart' }, 50)],
    });
    const facts = await collectLiveFacts(g, ws);
    expect(facts.problems).toEqual([]);
    expect(facts.requestRates).toEqual({ shop: 4, cart: 1.5 });
    expect(facts.logs).toEqual({
      shop: { lines: 100, withTraceId: 40 },
      cart: { lines: 50, withTraceId: 0 },
    });
    expect(facts.edges).toEqual([{ client: 'shop', server: 'cart', requestsPerSecond: 1.2 }]);
    expect(facts.collector).toEqual({ received: 1000, refused: 3, exportFailed: 7 });
    expect(facts.cardinality!.metrics[0]!.series).toBe(480);
    // One query per metric; Prometheus anchors regex matchers, so names match exactly.
    expect(queries).toContain(
      'sum by (service_name) (rate(http_server_request_duration_seconds_count{service_name=~"cart|shop"}[1h]))',
    );

    // The facts feed straight into the advisor.
    const ids = advise(ws, files, { facts }).findings.map((f) => f.id);
    expect(ids).toContain('undeclared-dependency/shop->cart');
    expect(ids).toContain('low-log-trace-correlation/shop');
    expect(ids).toContain('busiest-service-without-slo/shop');
  });

  it('reports a part that fails and still returns the others', async () => {
    const g = await gateway({ prom: () => [], loki: () => [], tsdb: 503 });
    const facts = await collectLiveFacts(g, ws);
    expect(facts.problems).toEqual([expect.stringMatching(/^series counts: .*HTTP 503/)]);
    expect(facts.cardinality).toBeUndefined();
    expect(facts.requestRates).toEqual({});
    expect(facts.collector).toEqual({ received: 0, refused: 0, exportFailed: 0 });
  });
});
