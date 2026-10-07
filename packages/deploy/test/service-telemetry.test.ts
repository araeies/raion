import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { validateSources } from '@raion/core';
import { afterEach, describe, expect, it } from 'vitest';
import { checkServiceTelemetry, GatewayClient, quote } from '../src/index.js';

const ws = validateSources([
  {
    path: 'raion.yaml',
    content:
      'apiVersion: raion/v1alpha1\nkind: Workspace\nmetadata:\n  name: t\nspec:\n  level: 2\n  services:\n    - name: shop\n      type: api\n      language: nodejs\n',
  },
]).workspace!;
const svc = ws.services[0]!;

interface Fake {
  prom: (query: string) => string | null;
  logs: (query: string) => number;
  logLines: string[];
  traces: boolean;
  knownTraces: Set<string>;
}

let server: Server | undefined;
const seen: string[] = [];

async function gateway(fake: Fake): Promise<GatewayClient> {
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    seen.push(url.pathname + url.search);
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/prometheus/api/v1/query') {
      const v = fake.prom(url.searchParams.get('query')!);
      res.end(JSON.stringify({ data: { result: v === null ? [] : [{ value: [0, v] }] } }));
    } else if (url.pathname === '/loki/loki/api/v1/query') {
      res.end(
        JSON.stringify({
          data: { result: [{ value: [0, String(fake.logs(url.searchParams.get('query')!))] }] },
        }),
      );
    } else if (url.pathname === '/loki/loki/api/v1/query_range') {
      res.end(
        JSON.stringify({
          data: { result: fake.logLines.map((id) => ({ stream: { trace_id: id } })) },
        }),
      );
    } else if (url.pathname === '/tempo/api/search') {
      res.end(JSON.stringify({ traces: fake.traces ? [{ traceID: 'x' }] : [] }));
    } else if (url.pathname.startsWith('/tempo/api/traces/')) {
      res.statusCode = fake.knownTraces.has(url.pathname.split('/').pop()!) ? 200 : 404;
      res.end('{}');
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
  seen.length = 0;
});

describe('checkServiceTelemetry', () => {
  it('reports a fully connected service with golden signals and log/trace linking', async () => {
    const g = await gateway({
      prom: (q) =>
        q.startsWith('count(')
          ? '6'
          : q.startsWith('histogram_quantile')
            ? '0.21'
            : q.startsWith('(sum')
              ? '0.01'
              : '4.5',
      logs: (q) => (q.includes('trace_id') ? 90 : 100),
      logLines: ['aaa', 'bbb'],
      traces: true,
      knownTraces: new Set(['bbb']),
    });
    const t = await checkServiceTelemetry(g, svc, { tracesDeployed: true });
    expect(t.signals.map((s) => [s.signal, s.ok])).toEqual([
      ['metrics', true],
      ['logs', true],
      ['traces', true],
    ]);
    expect(t.red).toMatchObject({ requestsPerSecond: 4.5, errorRatio: 0.01, p95Seconds: 0.21 });
    expect(t.red!.queries.requestsPerSecond).toBe(
      'sum(rate(http_server_request_duration_seconds_count{service_name="shop"}[5m]))',
    );
    expect(t.correlation).toEqual({
      logsWithTraceId: 0.9,
      linkedTraceFound: true,
      message: '90% of log lines carry a trace ID and open the matching trace',
    });
    // The linking check skips the newest log lines (spans are exported in batches).
    expect(seen.some((u) => u.includes('query_range') && u.includes('&end='))).toBe(true);
  });

  it('explains what is missing for a service that is not connected', async () => {
    const g = await gateway({
      prom: () => null,
      logs: () => 0,
      logLines: [],
      traces: false,
      knownTraces: new Set(),
    });
    const t = await checkServiceTelemetry(g, svc, { tracesDeployed: true });
    expect(t.signals.every((s) => !s.ok)).toBe(true);
    expect(t.signals[0]!.message).toContain('no HTTP request metrics');
    expect(t.red!.errorRatio).toBeNull();
    expect(t.correlation).toBeUndefined();
  });

  it('does not look for traces when tracing is not deployed', async () => {
    const g = await gateway({
      prom: () => '1',
      logs: () => 5,
      logLines: [],
      traces: true,
      knownTraces: new Set(),
    });
    const t = await checkServiceTelemetry(g, svc, { tracesDeployed: false });
    expect(t.signals.map((s) => s.signal)).toEqual(['metrics', 'logs']);
    expect(seen.some((u) => u.startsWith('/tempo'))).toBe(false);
  });
});

describe('quote', () => {
  it('escapes values for PromQL and LogQL strings', () => {
    expect(quote('a"b\\c')).toBe('"a\\"b\\\\c"');
  });
});
