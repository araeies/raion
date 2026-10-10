import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderWorkspace, writeWorkspace } from '@raion/core';
import { GatewayClient, type ActiveAlert, type ExecResult, type Runner } from '@raion/deploy';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { AuthService, DEFAULT_AUTH } from '../src/auth.js';
import { AlertInbox } from '../src/inbox.js';
import { RuntimeService } from '../src/runtime.js';
import { Store } from '../src/store.js';

const HOST = 'localhost:7600';

class FakeRuntime extends RuntimeService {
  constructor(
    dir: string,
    readonly fake: GatewayClient,
  ) {
    const noDocker: Runner = {
      run: () => Promise.resolve<ExecResult>({ stdout: '', stderr: '', code: 0 }),
    };
    super(dir, noDocker);
  }
  override gateway() {
    return Promise.resolve(this.fake);
  }
}

const alert = (
  name: string,
  extra: Partial<ActiveAlert> = {},
  labels: Record<string, string> = {},
): ActiveAlert => ({
  fingerprint: `fp-${name}`,
  startsAt: '2026-10-05T10:00:00.000Z',
  labels: { alertname: name, ...labels },
  annotations: { summary: `${name} summary` },
  status: { state: 'active', silencedBy: [], inhibitedBy: [] },
  ...extra,
});

let dir: string;
let app: FastifyInstance;
let store: Store;
let inbox: AlertInbox;
let am: Server;
let amAlerts: ActiveAlert[] | 'down';
/** What the fake Prometheus reports: rule alerts (pending or firing) and the ALERTS history. */
let promRules: { name: string; state: string; labels: Record<string, string>; activeAt: string }[];
let promHistory: { metric: Record<string, string>; values: [number, string][] }[] | 'down';
const amRequests: { method: string; url: string; body: string }[] = [];
let cookies: Record<string, string>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'raion-alerts-'));
  await writeWorkspace(dir, renderWorkspace({ name: 'acme', level: 1, environment: 'production' }));
  amAlerts = [];
  promRules = [];
  promHistory = [];
  amRequests.length = 0;
  am = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      amRequests.push({ method: req.method ?? '', url: req.url ?? '', body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/alertmanager/api/v2/alerts') {
        if (amAlerts === 'down') {
          res.statusCode = 503;
          res.end('{}');
        } else res.end(JSON.stringify(amAlerts));
      } else if (req.url === '/alertmanager/api/v2/silences' && req.method === 'POST') {
        res.end(JSON.stringify({ silenceID: 'c3a6c6ad-0000-4000-8000-000000000001' }));
      } else if (req.url === '/alertmanager/api/v2/silences') {
        res.end('[]');
      } else if (req.url?.startsWith('/prometheus/api/v1/rules')) {
        res.end(
          JSON.stringify({
            data: {
              groups: [
                {
                  rules: promRules.map((r) => ({
                    type: 'alerting',
                    name: r.name,
                    alerts: [
                      {
                        labels: { alertname: r.name, ...r.labels },
                        annotations: {},
                        state: r.state,
                        activeAt: r.activeAt,
                        value: '1',
                      },
                    ],
                  })),
                },
              ],
            },
          }),
        );
      } else if (req.url?.startsWith('/prometheus/api/v1/query_range')) {
        if (promHistory === 'down') {
          res.statusCode = 503;
          res.end('{}');
        } else res.end(JSON.stringify({ data: { result: promHistory } }));
      } else {
        res.end('{}');
      }
    });
  });
  await new Promise<void>((r) => am.listen(0, '127.0.0.1', r));
  const gateway = new GatewayClient(`http://127.0.0.1:${(am.address() as AddressInfo).port}`, 't');

  store = new Store(':memory:');
  const auth = new AuthService(store, { ...DEFAULT_AUTH, scrypt: { N: 1024, r: 8, p: 1 } });
  const runtime = new FakeRuntime(dir, gateway);
  inbox = new AlertInbox(store, runtime);
  app = await buildApp({
    workspaceDir: dir,
    store,
    auth,
    allowedHosts: [HOST],
    secure: false,
    trustProxy: false,
    runtime,
    inbox,
  });
  cookies = {};
  for (const role of ['viewer', 'editor', 'admin'] as const) {
    await auth.createUser(role, `${role}-password-123`, role);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { host: HOST, 'x-raion-csrf': '1' },
      payload: { username: role, password: `${role}-password-123` },
    });
    cookies[role] = `raion_session=${res.cookies.find((c) => c.name === 'raion_session')!.value}`;
  }
});

afterEach(async () => {
  await app.close();
  store.close();
  am.close();
  await rm(dir, { recursive: true, force: true });
});

function send(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  role: string,
  payload?: object,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: {
      host: HOST,
      cookie: cookies[role]!,
      ...(method === 'GET' ? {} : { 'x-raion-csrf': '1' }),
    },
    ...(payload ? { payload } : {}),
  });
}

describe('alert inbox', () => {
  it('records firing alerts, hides the Watchdog and reports a healthy pipeline', async () => {
    amAlerts = [
      alert('Watchdog'),
      alert('ServiceHighErrorRate', {}, { severity: 'critical', service_name: 'shop' }),
    ];
    await inbox.poll();
    const body = (await send('GET', '/api/v1/alerts', 'viewer')).json<{
      health: { ok: boolean };
      firing: { alertname: string; service: string; severity: string }[];
    }>();
    expect(body.health.ok).toBe(true);
    expect(body.firing.map((a) => [a.alertname, a.service, a.severity])).toEqual([
      ['ServiceHighErrorRate', 'shop', 'critical'],
    ]);
  });

  it('moves alerts that stop firing to the history', async () => {
    amAlerts = [alert('Watchdog'), alert('HostHighCpu')];
    await inbox.poll();
    amAlerts = [alert('Watchdog')];
    await inbox.poll();
    const body = (await send('GET', '/api/v1/alerts', 'viewer')).json<{
      firing: unknown[];
      resolved: { alertname: string; resolvedAt: string }[];
    }>();
    expect(body.firing).toEqual([]);
    expect(body.resolved.map((a) => a.alertname)).toEqual(['HostHighCpu']);
    expect(body.resolved[0]!.resolvedAt).toBeTruthy();
  });

  it('reports broken alerting when the Watchdog is missing', async () => {
    amAlerts = [];
    await inbox.poll();
    expect(inbox.health()).toMatchObject({
      alertmanagerReachable: true,
      watchdogReceived: false,
      ok: false,
    });
  });

  it('keeps open alerts open while Alertmanager is unreachable', async () => {
    amAlerts = [alert('Watchdog'), alert('HostHighCpu')];
    await inbox.poll();
    amAlerts = 'down';
    await inbox.poll();
    expect(inbox.health()).toMatchObject({ alertmanagerReachable: false, ok: false });
    expect(store.listAlerts({ open: true, limit: 10 }).map((a) => a.alertname)).toEqual([
      'HostHighCpu',
    ]);
  });
});

describe('silences', () => {
  it('lets editors silence an alert and records who did it', async () => {
    const res = await send('POST', '/api/v1/alerts/silences', 'editor', {
      alertname: 'ServiceHighErrorRate',
      service: 'shop',
      minutes: 60,
      comment: 'deploying a fix',
    });
    expect(res.statusCode).toBe(201);
    const posted = JSON.parse(amRequests.find((r) => r.method === 'POST')!.body) as {
      matchers: { name: string; value: string }[];
      createdBy: string;
    };
    expect(posted.createdBy).toBe('editor');
    expect(posted.matchers.map((m) => `${m.name}=${m.value}`)).toEqual([
      'alertname=ServiceHighErrorRate',
      'service_name=shop',
    ]);
    const audit = store.listAudit(5, undefined).map((e) => e.action);
    expect(audit).toContain('alert.silence');
  });

  it('does not let viewers silence alerts', async () => {
    const res = await send('POST', '/api/v1/alerts/silences', 'viewer', {
      alertname: 'X',
      minutes: 60,
      comment: 'x',
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('secrets API', () => {
  it('is admin-only and never returns values', async () => {
    expect((await send('GET', '/api/v1/secrets', 'editor')).statusCode).toBe(403);
    expect(
      (
        await send('PUT', '/api/v1/secrets/CHAT_WEBHOOK', 'admin', {
          value: 'https://hooks.example.com/super-secret',
        })
      ).statusCode,
    ).toBe(204);
    const list = await send('GET', '/api/v1/secrets', 'admin');
    expect(list.json()).toMatchObject({ stored: ['CHAT_WEBHOOK'] });
    expect(list.body).not.toContain('super-secret');
    const audit = await send('GET', '/api/v1/audit', 'admin');
    expect(audit.body).toContain('secret.set');
    expect(audit.body).not.toContain('super-secret');
  });

  it('rejects invalid secret names', async () => {
    expect(
      (await send('PUT', '/api/v1/secrets/gateway-token', 'admin', { value: 'x' })).statusCode,
    ).toBe(400);
  });
});

describe('one alert experience', () => {
  /** Samples every 30 s, as Prometheus would return them, from `from` to `to` (Date). */
  const samples = (from: Date, to: Date): [number, string][] => {
    const out: [number, string][] = [];
    for (let t = Math.ceil(from.getTime() / 30_000) * 30; t <= to.getTime() / 1000; t += 30) {
      out.push([t, '1']);
    }
    return out;
  };

  it('explains each alert and shows the self-test instead of hiding it', async () => {
    amAlerts = [alert('Watchdog'), alert('HostHighCpu', {}, { severity: 'warning' })];
    await inbox.poll();
    const body = (await send('GET', '/api/v1/alerts', 'viewer')).json<{
      selfTest: { firing: boolean; rule: { title: string; meaning: string } };
      firing: { alertname: string; rule: { title: string; condition: string; action: string[] } }[];
    }>();
    expect(body.selfTest.firing).toBe(true);
    expect(body.selfTest.rule.title).toBe('Alerting self-test');
    expect(body.selfTest.rule.meaning).toMatch(/fire all the time/);
    expect(body.firing).toHaveLength(1);
    expect(body.firing[0]!.rule.title).toBe('The processor is overloaded');
    expect(body.firing[0]!.rule.condition).toMatch(/90%/);
    expect(body.firing[0]!.rule.action.length).toBeGreaterThan(0);
  });

  it('shows alerts that are about to fire', async () => {
    amAlerts = [alert('Watchdog')];
    promRules = [
      {
        name: 'HostHighCpu',
        state: 'pending',
        labels: { severity: 'warning' },
        activeAt: '2026-10-07T10:00:00Z',
      },
      { name: 'HostMemoryPressure', state: 'firing', labels: {}, activeAt: '2026-10-07T09:00:00Z' },
    ];
    await inbox.poll();
    const body = (await send('GET', '/api/v1/alerts', 'viewer')).json<{
      pending: { alertname: string; activeAt: string; rule: { title: string } }[];
    }>();
    expect(body.pending.map((a) => a.alertname)).toEqual(['HostHighCpu']);
    expect(body.pending[0]!.activeAt).toBe('2026-10-07T10:00:00Z');
    expect(body.pending[0]!.rule.title).toBe('The processor is overloaded');
  });

  it('recovers alerts that fired and cleared while Raion was not running', async () => {
    const now = Date.now();
    store.setSetting('inbox.lastPollAt', new Date(now - 3 * 3_600_000).toISOString());
    amAlerts = [alert('Watchdog'), alert('HostMemoryPressure')];
    promHistory = [
      {
        metric: {
          __name__: 'ALERTS',
          alertname: 'HostDiskAlmostFull',
          alertstate: 'firing',
          severity: 'critical',
          device: '/dev/sda1',
        },
        values: samples(new Date(now - 2 * 3_600_000), new Date(now - 3_600_000)),
      },
      // Still firing: Alertmanager reports it, with its annotations.
      {
        metric: { __name__: 'ALERTS', alertname: 'HostMemoryPressure', alertstate: 'firing' },
        values: samples(new Date(now - 600_000), new Date(now)),
      },
    ];
    await inbox.poll();
    const body = (await send('GET', '/api/v1/alerts', 'viewer')).json<{
      firing: { alertname: string; source: string }[];
      resolved: {
        alertname: string;
        source: string;
        startsAt: string;
        resolvedAt: string;
        labels: Record<string, string>;
      }[];
    }>();
    expect(body.firing.map((a) => [a.alertname, a.source])).toEqual([
      ['HostMemoryPressure', 'alertmanager'],
    ]);
    expect(body.resolved).toHaveLength(1);
    const recovered = body.resolved[0]!;
    expect(recovered).toMatchObject({
      alertname: 'HostDiskAlmostFull',
      source: 'prometheus-history',
    });
    expect(recovered.labels.device).toBe('/dev/sda1');
    expect(Math.abs(Date.parse(recovered.startsAt) - (now - 2 * 3_600_000))).toBeLessThan(60_000);
    expect(Math.abs(Date.parse(recovered.resolvedAt) - (now - 3_600_000))).toBeLessThan(60_000);

    // A later restart does not record it twice.
    const again = new AlertInbox(store, (inbox as unknown as { runtime: RuntimeService }).runtime);
    store.setSetting('inbox.lastPollAt', new Date(now - 3 * 3_600_000).toISOString());
    await again.poll();
    expect(store.listAlerts({ open: false, limit: 10 })).toHaveLength(1);
  });

  it('gives an alert that was open when Raion stopped its real end time', async () => {
    const now = Date.now();
    amAlerts = [
      alert('Watchdog'),
      alert('HostHighCpu', { startsAt: new Date(now - 4 * 3_600_000).toISOString() }),
    ];
    await inbox.poll();
    // Raion stops; the alert clears 90 minutes ago; Raion starts again.
    store.setSetting('inbox.lastPollAt', new Date(now - 3 * 3_600_000).toISOString());
    amAlerts = [alert('Watchdog')];
    promHistory = [
      {
        metric: { __name__: 'ALERTS', alertname: 'HostHighCpu', alertstate: 'firing' },
        values: samples(new Date(now - 3 * 3_600_000), new Date(now - 90 * 60_000)),
      },
    ];
    const restarted = new AlertInbox(
      store,
      (inbox as unknown as { runtime: RuntimeService }).runtime,
    );
    await restarted.poll();
    const [resolved] = store.listAlerts({ open: false, limit: 10 });
    expect(resolved).toMatchObject({ alertname: 'HostHighCpu', source: 'alertmanager' });
    expect(Math.abs(Date.parse(resolved!.resolvedAt!) - (now - 90 * 60_000))).toBeLessThan(60_000);
  });

  it('keeps live alerts working when the history cannot be read', async () => {
    store.setSetting('inbox.lastPollAt', new Date(Date.now() - 3 * 3_600_000).toISOString());
    promHistory = 'down';
    amAlerts = [alert('Watchdog'), alert('HostHighCpu')];
    await inbox.poll();
    expect(inbox.health()).toMatchObject({ ok: true });
    expect(store.listAlerts({ open: true, limit: 10 }).map((a) => a.alertname)).toEqual([
      'HostHighCpu',
    ]);
  });
});
