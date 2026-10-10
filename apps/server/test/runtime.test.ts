import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderWorkspace, writeWorkspace } from '@raion/core';
import {
  GatewayClient,
  OperationJournal,
  StatePaths,
  type ExecResult,
  type Runner,
} from '@raion/deploy';
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
    docker?: Runner,
  ) {
    const noDocker: Runner = {
      run: () => Promise.resolve<ExecResult>({ stdout: '', stderr: '', code: 0 }),
    };
    super(dir, docker ?? noDocker);
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

async function start(withGateway: boolean, docker?: Runner) {
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
    runtime: new TestRuntime(dir, withGateway ? gateway : undefined, docker),
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

  it('returns no history before the stack is deployed, and only offers known periods', async () => {
    const users = await start(false);
    const res = await get('/api/v1/services/shop/history?minutes=360', users.viewer);
    expect(res.json()).toEqual({ deployed: false, history: null });
    expect((await get('/api/v1/services/shop/history?minutes=7', users.viewer)).statusCode).toBe(
      400,
    );
    expect((await get('/api/v1/services/shop/history')).statusCode).toBe(401);
    expect((await get('/api/v1/services/nope/history', users.viewer)).statusCode).toBe(404);
  });

  it('lists integrations with their documentation', async () => {
    const users = await start(false);
    const res = await get('/api/v1/integrations', users.viewer);
    const body = res.json<{ integrations: { name: string; source: string; docs: string }[] }>();
    expect(body.integrations.map((i) => i.name)).toEqual([
      'go',
      'java',
      'nginx',
      'nodejs',
      'postgresql',
      'python',
      'redis',
    ]);
    const nodejs = body.integrations.find((i) => i.name === 'nodejs')!;
    expect(nodejs.source).toBe('built-in');
    expect(nodejs.docs).toContain('Troubleshooting');
    const full = res.json<{
      integrations: {
        name: string;
        services: string[];
        collects: string;
        parameters: { name: string; type: string; required: boolean }[];
      }[];
    }>().integrations;
    // The workspace's shop service is a Node.js service.
    expect(full.find((i) => i.name === 'nodejs')!.services).toEqual(['shop']);
    const pg = full.find((i) => i.name === 'postgresql')!;
    expect(pg.collects).toBe('pull');
    expect(pg.parameters.find((p) => p.name === 'password')).toMatchObject({
      type: 'secret',
      required: true,
    });
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

describe('API tokens in use', () => {
  it('create an SLO from a script, audited with the token name', async () => {
    const users = await start(false);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/tokens',
      headers: { host: HOST, cookie: users.editor!, 'x-raion-csrf': '1' },
      payload: { name: 'slo-bot', role: 'editor', expiresInDays: 7 },
    });
    const { token } = created.json<{ token: string }>();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/slos',
      headers: { host: HOST, authorization: `Bearer ${token}` },
      payload: {
        service: 'shop',
        name: 'availability',
        sli: { type: 'availability' },
        target: 99.9,
        window: '30d',
      },
    });
    expect(res.statusCode).toBe(201);
    const entry = store.listAudit(10).find((e) => e.action === 'slo.create')!;
    expect(entry.actor).toBe('editor');
    expect(entry.details).toMatchObject({ token: 'slo-bot' });
  });
});

describe('operations from the CLI and the web UI', () => {
  it('shows a CLI operation in the web UI and refuses a second change while it runs', async () => {
    const users = await start(false);
    const journal = new OperationJournal(new StatePaths(dir));
    const cli = journal.begin({ kind: 'apply', via: 'cli', actor: 'cli:alice' });
    cli.log('Starting components…');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runtime/apply',
      headers: { host: HOST, cookie: users.admin, 'x-raion-csrf': '1' },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { message: string } }>().error.message).toBe(
      'apply started from the command line by cli:alice is still running; wait for it to finish',
    );

    const list = (await get('/api/v1/runtime/jobs', users.viewer)).json<{
      jobs: { id: string; via: string; state: string; log?: unknown }[];
    }>();
    expect(list.jobs[0]).toMatchObject({ id: cli.id, via: 'cli', state: 'running' });
    expect(list.jobs[0]!.log).toBeUndefined();
    await new Promise((r) => setTimeout(r, 400));
    const one = (await get(`/api/v1/runtime/jobs/${cli.id}`, users.viewer)).json<{
      log: string[];
    }>();
    expect(one.log).toEqual(['Starting components…']);

    cli.succeed({ release: '0001' });
    expect((await get(`/api/v1/runtime/jobs/${cli.id}`, users.viewer)).json()).toMatchObject({
      state: 'succeeded',
      result: { release: '0001' },
    });
    expect((await get('/api/v1/runtime/jobs/not-an-id', users.viewer)).statusCode).toBe(400);
  });
});

describe('editing the workspace from the web UI', () => {
  const edit = (cookie: string, action: object, preview = false) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/workspace/edits${preview ? '/preview' : ''}`,
      headers: { host: HOST, cookie, 'x-raion-csrf': '1' },
      payload: { action },
    });

  it('previews without writing, then writes, and audits the change', async () => {
    const users = await start(false);
    const action = {
      kind: 'service.add',
      service: { name: 'checkout', type: 'api', language: 'python' },
    };
    const preview = await edit(users.editor!, action, true);
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      summary: 'Add the application checkout',
      changes: [{ path: 'services/checkout.yaml', kind: 'add' }],
    });
    await expect(readFile(join(dir, 'services', 'checkout.yaml'), 'utf8')).rejects.toThrow();

    const written = await edit(users.editor!, action);
    expect(written.statusCode).toBe(201);
    expect(await readFile(join(dir, 'services', 'checkout.yaml'), 'utf8')).toContain(
      'name: checkout',
    );
    const services = (await get('/api/v1/services', users.viewer)).json<{
      services: { name: string }[];
    }>();
    expect(services.services.map((s) => s.name)).toContain('checkout');
    expect(store.listAudit(5)[0]).toMatchObject({
      actor: 'editor',
      action: 'workspace.edit',
      target: 'checkout',
      details: { change: 'service.add', files: ['services/checkout.yaml'] },
    });
  });

  it('keeps viewers read-only and workspace-wide settings for admins', async () => {
    const users = await start(false);
    expect((await edit(users.viewer!, { kind: 'service.remove', name: 'shop' })).statusCode).toBe(
      403,
    );
    const settings = { kind: 'workspace.update', set: { level: 2 } };
    expect((await edit(users.editor!, settings)).statusCode).toBe(403);
    expect((await edit(users.admin!, settings)).statusCode).toBe(201);
  });

  it('explains why a change is refused', async () => {
    const users = await start(false);
    const res = await edit(users.editor!, {
      kind: 'service.update',
      name: 'shop',
      set: { tier: 'super-important' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: string; message: string; diagnostics: unknown[] } }>();
    expect(body.error.code).toBe('edit_invalid');
    expect(body.error.message).toMatch(/tier/);
    expect(body.error.diagnostics.length).toBeGreaterThan(0);
    expect((await edit(users.editor!, { kind: 'service.remove', name: 'nope' })).statusCode).toBe(
      404,
    );
  });
});

describe('connecting applications that already run', () => {
  /** A Docker with one running Compose application and one Raion component. */
  function fakeDocker(composeFile: string) {
    const calls: string[][] = [];
    const runner: Runner = {
      run: (args) => {
        calls.push(args);
        const ok = (stdout: string) => Promise.resolve<ExecResult>({ stdout, stderr: '', code: 0 });
        if (args[0] === 'ps') return ok('aaa\nbbb\n');
        if (args[0] === 'inspect') {
          return ok(
            JSON.stringify([
              {
                Name: '/shopapp-shop-1',
                Config: {
                  Image: 'node:24-slim',
                  Env: ['NODE_VERSION=24.1.0'],
                  Cmd: ['node', 'server.js'],
                  Labels: {
                    'com.docker.compose.project': 'shopapp',
                    'com.docker.compose.service': 'shop',
                    'com.docker.compose.project.config_files': composeFile,
                    'com.docker.compose.project.working_dir': dir,
                  },
                },
                State: { Status: 'running' },
              },
              {
                Name: '/raion-prometheus-1',
                Config: {
                  Image: 'prom/prometheus',
                  Labels: { 'dev.raion.component': 'prometheus' },
                },
                State: { Status: 'running' },
              },
            ]),
          );
        }
        return ok('');
      },
    };
    return { runner, calls };
  }

  it('lists running applications, guesses what they are, and leaves Raion itself out', async () => {
    const composeFile = join(dir, 'compose.yaml');
    await writeFile(composeFile, 'services: {}\n');
    const users = await start(false, fakeDocker(composeFile).runner);
    const body = (await get('/api/v1/discovery', users.editor)).json<{
      containers: { container: string; monitoredAs: string | null; guess: { language?: string } }[];
    }>();
    expect(body.containers).toEqual([
      expect.objectContaining({
        container: 'shopapp-shop-1',
        monitoredAs: 'shop',
        guess: { language: 'nodejs' },
      }),
    ]);
    expect((await get('/api/v1/discovery', users.viewer)).statusCode).toBe(403);
  });

  it('shows admins exactly what it will do, then restarts the application with the settings', async () => {
    const composeFile = join(dir, 'compose.yaml');
    await writeFile(composeFile, 'services: {}\n');
    const docker = fakeDocker(composeFile);
    const users = await start(false, docker.runner);
    expect((await get('/api/v1/services/shop/connect-running', users.editor)).statusCode).toBe(403);
    const preview = (await get('/api/v1/services/shop/connect-running', users.admin)).json<{
      project: string;
      command: string;
      override: string;
      settings: string[];
    }>();
    expect(preview.project).toBe('shopapp');
    expect(preview.command).toContain(`-f ${composeFile} -f `);
    expect(preview.command).toMatch(/up -d shop$/);
    expect(preview.settings).toContain('OTEL_SERVICE_NAME');
    expect(preview.override).toContain('shop:');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/services/shop/connect-running',
      headers: { host: HOST, cookie: users.admin, 'x-raion-csrf': '1' },
      payload: {},
    });
    expect(res.statusCode).toBe(202);
    const { job } = res.json<{ job: string }>();
    for (let i = 0; i < 50; i++) {
      const state = (await get(`/api/v1/runtime/jobs/${job}`, users.viewer)).json<{
        state: string;
      }>().state;
      if (state !== 'running') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect((await get(`/api/v1/runtime/jobs/${job}`, users.viewer)).json()).toMatchObject({
      kind: 'connect',
      state: 'succeeded',
    });
    const up = docker.calls.find((c) => c[0] === 'compose')!;
    expect(up.slice(0, 3)).toEqual(['compose', '-p', 'shopapp']);
    expect(up.slice(-3)).toEqual(['up', '-d', 'shop']);
    expect(await readFile(join(dir, '.raion', 'connect', 'shopapp.raion.yaml'), 'utf8')).toContain(
      'OTEL_SERVICE_NAME',
    );
    expect(
      store.listAudit(5).some((e) => e.action === 'service.connect' && e.outcome === 'success'),
    ).toBe(true);
  });

  it('explains when the application is not running', async () => {
    const users = await start(false);
    const res = await get('/api/v1/services/shop/connect-running', users.admin);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('not_running');
  });
});
