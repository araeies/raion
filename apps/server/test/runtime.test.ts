import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderWorkspace, writeWorkspace } from '@raion/core';
import { GatewayClient, type ExecResult, type Runner } from '@raion/deploy';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { AuthService, DEFAULT_AUTH } from '../src/auth.js';
import { RuntimeService } from '../src/runtime.js';
import { Store } from '../src/store.js';

const HOST = 'localhost:7600';

/** A runtime whose gateway is a local fake that records what it receives. */
class TestRuntime extends RuntimeService {
  constructor(
    dir: string,
    readonly fakeGateway: GatewayClient | undefined,
  ) {
    const noDocker: Runner = {
      run: () => Promise.resolve<ExecResult>({ stdout: '', stderr: '', code: 0 }),
    };
    super(dir, noDocker);
  }
  override gateway() {
    return Promise.resolve(this.fakeGateway);
  }
}

let dir: string;
let app: FastifyInstance;
let store: Store;
let upstream: Server;
let received: { url: string; method: string; headers: IncomingHttpHeaders; body: string }[];

async function start(withGateway: boolean) {
  received = [];
  upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      received.push({ url: req.url ?? '', method: req.method ?? '', headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      res.setHeader('set-cookie', ['grafana_a=1; Path=/grafana', 'grafana_b=2; Path=/grafana']);
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const gateway = new GatewayClient(
    `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    'gateway-secret',
  );

  store = new Store(':memory:');
  const auth = new AuthService(store, { ...DEFAULT_AUTH, scrypt: { N: 1024, r: 8, p: 1 } });
  app = await buildApp({
    workspaceDir: dir,
    store,
    auth,
    allowedHosts: [HOST],
    secure: false,
    trustProxy: false,
    runtime: new TestRuntime(dir, withGateway ? gateway : undefined),
  });
  const users: Record<string, string> = {};
  for (const role of ['viewer', 'editor', 'admin'] as const) {
    await auth.createUser(role, `${role}-password-123`, role);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { host: HOST, 'x-raion-csrf': '1' },
      payload: { username: role, password: `${role}-password-123` },
    });
    users[role] = `raion_session=${res.cookies.find((c) => c.name === 'raion_session')!.value}`;
  }
  return users;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'raion-server-rt-'));
  await writeWorkspace(
    dir,
    renderWorkspace({
      name: 'acme',
      level: 1,
      environment: 'production',
      service: { name: 'shop', type: 'api', language: 'nodejs', runtime: 'compose' },
    }),
  );
});

afterEach(async () => {
  await app.close();
  store.close();
  upstream.close();
  await rm(dir, { recursive: true, force: true });
});

function get(
  url: string,
  cookie?: string,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'GET',
    url,
    headers: { host: HOST, ...(cookie ? { cookie } : {}), ...headers },
  });
}

describe('Grafana single sign-on proxy', () => {
  it('forwards the Raion identity and role, and the gateway secret', async () => {
    const users = await start(true);
    const res = await get('/grafana/api/user', users.editor);
    expect(res.statusCode).toBe(200);
    const sent = received[0]!;
    expect(sent.url).toBe('/grafana/api/user');
    expect(sent.headers['x-webauth-user']).toBe('editor');
    expect(sent.headers['x-webauth-role']).toBe('Editor');
    expect(sent.headers['x-raion-gateway-token']).toBe('gateway-secret');
  });

  it('ignores identity headers sent by the browser and never forwards the Raion session', async () => {
    const users = await start(true);
    await get('/grafana/api/user', `${users.viewer}; other=1`, {
      'x-webauth-user': 'admin',
      'x-webauth-role': 'Admin',
      'x-raion-gateway-token': 'guess',
    });
    const sent = received[0]!;
    expect(sent.headers['x-webauth-user']).toBe('viewer');
    expect(sent.headers['x-webauth-role']).toBe('Viewer');
    expect(sent.headers['x-raion-gateway-token']).toBe('gateway-secret');
    expect(sent.headers.cookie).toBe('other=1');
  });

  it('passes request bodies and every Set-Cookie header through', async () => {
    const users = await start(true);
    const res = await app.inject({
      method: 'POST',
      url: '/grafana/api/ds/query',
      headers: { host: HOST, cookie: users.viewer, 'content-type': 'application/json' },
      payload: '{"queries":[]}',
    });
    expect(res.statusCode).toBe(200);
    expect(received[0]!.body).toBe('{"queries":[]}');
    expect(res.headers['set-cookie']).toEqual([
      'grafana_a=1; Path=/grafana',
      'grafana_b=2; Path=/grafana',
    ]);
    expect(res.headers['content-security-policy']).toBeUndefined();
  });

  it('sends signed-out browsers to the Raion sign-in page', async () => {
    await start(true);
    const page = await get('/grafana/d/abc', undefined, { accept: 'text/html' });
    expect(page.statusCode).toBe(302);
    expect(page.headers.location).toBe('/login?next=%2Fgrafana%2Fd%2Fabc');
    expect((await get('/grafana/api/user')).statusCode).toBe(401);
    expect(received).toEqual([]);
  });

  it('explains when the stack is not deployed', async () => {
    const users = await start(false);
    const res = await get('/grafana/', users.viewer);
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('not deployed yet');
  });
});

describe('runtime API', () => {
  it('shows the plan and generated files to viewers', async () => {
    const users = await start(false);
    const res = await get('/api/v1/runtime', users.viewer);
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      status: { deployed?: unknown };
      plan: { noChanges: boolean };
      files: { path: string }[];
    }>();
    expect(body.status.deployed).toBeUndefined();
    expect(body.plan.noChanges).toBe(false);
    expect(body.files.map((f) => f.path)).toContain('compose.yaml');
    const file = await get('/api/v1/runtime/files/prometheus/prometheus.yml', users.viewer);
    expect(file.json<{ content: string }>().content).toContain('scrape_configs');
  });

  it('only serves files Raion generated', async () => {
    const users = await start(false);
    expect(
      (await get('/api/v1/runtime/files/../secrets/gateway-token', users.viewer)).statusCode,
    ).toBe(404);
    expect((await get('/api/v1/runtime/files/..%2F..%2Fraion.yaml', users.viewer)).statusCode).toBe(
      404,
    );
  });

  it('does not let viewers deploy', async () => {
    const users = await start(false);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runtime/apply',
      headers: { host: HOST, cookie: users.viewer, 'x-raion-csrf': '1' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('service connection API', () => {
  it('returns connection steps and a Compose override', async () => {
    const users = await start(false);
    const res = await get('/api/v1/services/shop/connect', users.viewer);
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      connection: {
        supported: boolean;
        integration: { name: string };
        requirements: { command: string }[];
      };
      override: string;
    }>();
    expect(body.connection.supported).toBe(true);
    expect(body.connection.integration.name).toBe('nodejs');
    expect(body.connection.requirements[0]!.command).toBe(
      'npm install @opentelemetry/api @opentelemetry/auto-instrumentations-node',
    );
    expect(body.override).toContain('OTEL_SERVICE_NAME: shop');
    expect((await get('/api/v1/services/nope/connect', users.viewer)).statusCode).toBe(404);
  });

  it('reports that nothing is measured before the stack is deployed', async () => {
    const users = await start(false);
    const res = await get('/api/v1/services/shop/telemetry', users.viewer);
    expect(res.json()).toEqual({ deployed: false, telemetry: null });
  });

  it('lists integrations with their documentation', async () => {
    const users = await start(false);
    const res = await get('/api/v1/integrations', users.viewer);
    const body = res.json<{ integrations: { name: string; source: string; docs: string }[] }>();
    expect(body.integrations.map((i) => i.name)).toEqual([
      'go',
      'nginx',
      'nodejs',
      'postgresql',
      'python',
      'redis',
    ]);
    const nodejs = body.integrations.find((i) => i.name === 'nodejs')!;
    expect(nodejs.source).toBe('built-in');
    expect(nodejs.docs).toContain('Troubleshooting');
  });
});

describe('SLO API', () => {
  it('lists SLOs with why they are not evaluated yet', async () => {
    const users = await start(false);
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/slos',
      headers: { host: HOST, cookie: users.editor, 'x-raion-csrf': '1' },
      payload: {
        service: 'shop',
        name: 'availability',
        sli: { type: 'availability' },
        target: 99.9,
        window: '30d',
      },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json<{ file: string }>().file).toBe('slos/shop-availability.yaml');

    const list = await get('/api/v1/slos', users.viewer);
    const body = list.json<{
      slos: { name: string; evaluated: boolean; reason: string; status: unknown }[];
    }>();
    expect(body.slos).toHaveLength(1);
    expect(body.slos[0]).toMatchObject({ name: 'availability', evaluated: false, status: null });
    expect(body.slos[0]!.reason).toContain('level 3');
  });

  it('rejects SLOs that cannot be measured, and viewers', async () => {
    const users = await start(false);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/slos',
      headers: { host: HOST, cookie: users.editor, 'x-raion-csrf': '1' },
      payload: {
        service: 'shop',
        name: 'fast',
        sli: { type: 'latency', thresholdMs: 450 },
        target: 99,
        window: '30d',
      },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ error: { code: string } }>().error.code).toBe('invalid_slo');
    const viewer = await app.inject({
      method: 'POST',
      url: '/api/v1/slos',
      headers: { host: HOST, cookie: users.viewer, 'x-raion-csrf': '1' },
      payload: {
        service: 'shop',
        name: 'x',
        sli: { type: 'availability' },
        target: 99,
        window: '30d',
      },
    });
    expect(viewer.statusCode).toBe(403);
  });

  it('exports OpenSLO', async () => {
    const users = await start(false);
    await app.inject({
      method: 'POST',
      url: '/api/v1/slos',
      headers: { host: HOST, cookie: users.editor, 'x-raion-csrf': '1' },
      payload: {
        service: 'shop',
        name: 'availability',
        sli: { type: 'availability' },
        target: 99.9,
        window: '30d',
      },
    });
    const res = await get('/api/v1/slos/openslo', users.viewer);
    expect(res.headers['content-type']).toContain('application/yaml');
    expect(res.body).toContain('apiVersion: openslo/v1');
  });
});

describe('Advisor API', () => {
  const PAY =
    'apiVersion: raion/v1alpha1\nkind: Service\nmetadata:\n  name: pay\nspec:\n  tier: critical\n  team: payments\n  type: api\n  language: nodejs\n';

  function apply(cookie: string, id: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/advisor/apply',
      headers: { host: HOST, cookie, 'x-raion-csrf': '1' },
      payload: { id },
    });
  }

  interface Report {
    deployed: boolean;
    facts: { problems: string[] } | null;
    findings: {
      id: string;
      autofix: {
        summary: string;
        changes: { path: string; created: boolean; diff: string }[];
      } | null;
    }[];
  }

  it('lists findings with reviewable fixes and applies one for editors only', async () => {
    await mkdir(join(dir, 'services'), { recursive: true });
    await writeFile(join(dir, 'services/pay.yaml'), PAY);
    const users = await start(false);

    const body = (await get('/api/v1/advisor', users.viewer)).json<Report>();
    expect(body.deployed).toBe(false);
    expect(body.facts).toBeNull();
    const finding = body.findings.find((f) => f.id === 'critical-service-without-slo/pay')!;
    expect(finding.autofix!.changes.map((c) => [c.path, c.created])).toEqual([
      ['slos/pay-availability.yaml', true],
      ['services/pay.yaml', false],
    ]);
    expect(finding.autofix!.changes[1]!.diff).toContain('+  features:');

    expect((await apply(users.viewer!, finding.id)).statusCode).toBe(403);
    const ok = await apply(users.editor!, finding.id);
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ files: string[] }>().files).toEqual([
      'slos/pay-availability.yaml',
      'services/pay.yaml',
    ]);
    expect(await readFile(join(dir, 'services/pay.yaml'), 'utf8')).toContain('slos: true');
    expect(store.listAudit(5).map((a) => a.action)).toContain('advisor.apply');

    const again = await apply(users.editor!, finding.id);
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: { code: string } }>().error.code).toBe('finding_gone');
    const manual = await apply(users.editor!, 'page-alert-without-runbook/pay');
    expect(manual.json<{ error: { code: string } }>().error.code).toBe('no_autofix');
  });

  it('still answers when live data cannot be read', async () => {
    const users = await start(true);
    const body = (await get('/api/v1/advisor', users.viewer)).json<Report>();
    expect(body.deployed).toBe(true);
    expect(body.facts!.problems.length).toBeGreaterThan(0);
    expect(received.every((r) => r.headers['x-raion-gateway-token'] === 'gateway-secret')).toBe(
      true,
    );
  });
});

describe('Drift repair API', () => {
  it('is for editors, and only when something is deployed', async () => {
    const users = await start(false);
    const post = (cookie: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/runtime/repair',
        headers: { host: HOST, cookie, 'x-raion-csrf': '1' },
        payload: {},
      });
    expect((await post(users.viewer!)).statusCode).toBe(403);
    const res = await post(users.editor!);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('not_deployed');
  });
});
