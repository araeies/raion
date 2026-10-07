import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { AuthService, DEFAULT_AUTH } from '../src/auth.js';
import { resolveExposure, ServerConfigError } from '../src/server.js';
import { Store } from '../src/store.js';

const workspaceDir = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'examples',
  'workspaces',
  'level3-sre',
);
const HOST = 'localhost:7600';
const ADMIN_PASSWORD = 'correct horse battery';

let app: FastifyInstance;
let store: Store;
let auth: AuthService;

beforeEach(async () => {
  store = new Store(':memory:');
  // Cheap hashing parameters keep tests fast; production uses DEFAULT_SCRYPT.
  auth = new AuthService(store, {
    ...DEFAULT_AUTH,
    lockAfterFailures: 3,
    scrypt: { N: 1024, r: 8, p: 1 },
  });
  app = await buildApp({
    workspaceDir,
    store,
    auth,
    allowedHosts: [HOST],
    secure: false,
    trustProxy: false,
  });
});

afterEach(async () => {
  await app.close();
  store.close();
});

function request(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  options: {
    body?: unknown;
    cookie?: string;
    headers?: Record<string, string>;
    remoteAddress?: string;
  } = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    ...(options.remoteAddress ? { remoteAddress: options.remoteAddress } : {}),
    headers: {
      host: HOST,
      ...(method === 'GET' ? {} : { 'x-raion-csrf': '1' }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...options.headers,
    },
    ...(options.body !== undefined ? { payload: options.body as object } : {}),
  });
}

function sessionCookie(res: LightMyRequestResponse): string {
  const cookie = res.cookies.find((c) => c.name === 'raion_session');
  if (!cookie)
    throw new Error(`no session cookie in response (status ${res.statusCode}: ${res.body})`);
  return `raion_session=${cookie.value}`;
}

async function setupAdmin(): Promise<string> {
  const token = auth.issueSetupToken()!;
  const res = await request('POST', '/api/v1/setup', {
    body: { token, username: 'admin', password: ADMIN_PASSWORD },
  });
  expect(res.statusCode).toBe(201);
  return sessionCookie(res);
}

async function createUser(adminCookie: string, username: string, role: string): Promise<string> {
  const password = `${role}-password-123`;
  const res = await request('POST', '/api/v1/users', {
    cookie: adminCookie,
    body: { username, password, role },
  });
  expect(res.statusCode).toBe(201);
  const login = await request('POST', '/api/v1/auth/login', { body: { username, password } });
  expect(login.statusCode).toBe(200);
  return sessionCookie(login);
}

describe('health', () => {
  it('reports liveness and readiness', async () => {
    expect((await request('GET', '/healthz')).json()).toEqual({ status: 'ok' });
    const ready = await request('GET', '/readyz');
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ready', checks: { store: true, workspace: true } });
  });

  it('serves metrics to loopback only', async () => {
    const local = await request('GET', '/metrics');
    expect(local.statusCode).toBe(200);
    expect(local.body).toContain('raion_http_requests_total');
    const remote = await request('GET', '/metrics', { remoteAddress: '10.1.2.3' });
    expect(remote.statusCode).toBe(403);
  });

  it('sets security headers', async () => {
    const res = await request('GET', '/api/v1/setup');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('first-run setup', () => {
  it('creates the first admin with a valid one-time token', async () => {
    expect((await request('GET', '/api/v1/setup')).json()).toEqual({ needed: true });
    const cookie = await setupAdmin();
    expect((await request('GET', '/api/v1/setup')).json()).toEqual({ needed: false });
    const me = await request('GET', '/api/v1/auth/me', { cookie });
    expect(me.json()).toMatchObject({ user: { username: 'admin', role: 'admin' } });
  });

  it('rejects wrong tokens, weak passwords and a second setup', async () => {
    const token = auth.issueSetupToken()!;
    const wrong = await request('POST', '/api/v1/setup', {
      body: { token: 'nope', username: 'admin', password: ADMIN_PASSWORD },
    });
    expect(wrong.statusCode).toBe(403);
    const weak = await request('POST', '/api/v1/setup', {
      body: { token, username: 'admin', password: 'short' },
    });
    expect(weak.statusCode).toBe(400);
    // Neither failure consumed the one-time token.
    const ok = await request('POST', '/api/v1/setup', {
      body: { token, username: 'admin', password: ADMIN_PASSWORD },
    });
    expect(ok.statusCode).toBe(201);
    const again = await request('POST', '/api/v1/setup', {
      body: { token: 'x', username: 'other', password: ADMIN_PASSWORD },
    });
    expect(again.statusCode).toBe(409);
  });
});

describe('authentication', () => {
  it('uses the same error for unknown users and wrong passwords', async () => {
    await setupAdmin();
    const unknown = await request('POST', '/api/v1/auth/login', {
      body: { username: 'ghost', password: 'whatever-123' },
    });
    const wrong = await request('POST', '/api/v1/auth/login', {
      body: { username: 'admin', password: 'wrong-password' },
    });
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrong.json());
  });

  it('locks an account after repeated failures', async () => {
    await setupAdmin();
    for (let i = 0; i < 3; i++) {
      await request('POST', '/api/v1/auth/login', {
        body: { username: 'admin', password: 'wrong-password' },
      });
    }
    const locked = await request('POST', '/api/v1/auth/login', {
      body: { username: 'admin', password: ADMIN_PASSWORD },
    });
    expect(locked.statusCode).toBe(429);
  });

  it('ends the session on logout', async () => {
    const cookie = await setupAdmin();
    expect((await request('POST', '/api/v1/auth/logout', { cookie })).statusCode).toBe(204);
    expect((await request('GET', '/api/v1/auth/me', { cookie })).statusCode).toBe(401);
  });

  it('sets an HttpOnly, SameSite=Strict session cookie', async () => {
    const token = auth.issueSetupToken()!;
    const res = await request('POST', '/api/v1/setup', {
      body: { token, username: 'admin', password: ADMIN_PASSWORD },
    });
    const cookie = res.cookies.find((c) => c.name === 'raion_session')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Strict');
  });
});

describe('request guards', () => {
  it('rejects unknown Host headers (DNS rebinding)', async () => {
    const res = await request('GET', '/api/v1/setup', { headers: { host: 'evil.example:7600' } });
    expect(res.statusCode).toBe(421);
  });

  it('requires the CSRF header on mutations', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { host: HOST },
      payload: { username: 'admin', password: ADMIN_PASSWORD },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'csrf' } });
  });

  it('rejects cross-origin mutations', async () => {
    const res = await request('POST', '/api/v1/auth/login', {
      headers: { origin: 'https://evil.example' },
      body: { username: 'admin', password: ADMIN_PASSWORD },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns JSON 404 for unknown API routes', async () => {
    const res = await request('GET', '/api/v1/nope');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});

describe('roles', () => {
  it('requires sign-in for workspace data', async () => {
    expect((await request('GET', '/api/v1/services')).statusCode).toBe(401);
  });

  it('lets viewers read services but not manage users', async () => {
    const admin = await setupAdmin();
    const viewer = await createUser(admin, 'val', 'viewer');
    expect((await request('GET', '/api/v1/services', { cookie: viewer })).statusCode).toBe(200);
    expect((await request('GET', '/api/v1/users', { cookie: viewer })).statusCode).toBe(403);
    const create = await request('POST', '/api/v1/users', {
      cookie: viewer,
      body: { username: 'x1', password: 'long-enough-pw', role: 'admin' },
    });
    expect(create.statusCode).toBe(403);
  });

  it('protects the last admin', async () => {
    const admin = await setupAdmin();
    const res = await request('PATCH', '/api/v1/users/admin', {
      cookie: admin,
      body: { role: 'viewer' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('ends existing sessions when a user is disabled', async () => {
    const admin = await setupAdmin();
    const editor = await createUser(admin, 'eddie', 'editor');
    expect((await request('GET', '/api/v1/auth/me', { cookie: editor })).statusCode).toBe(200);
    const res = await request('PATCH', '/api/v1/users/eddie', {
      cookie: admin,
      body: { disabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect((await request('GET', '/api/v1/auth/me', { cookie: editor })).statusCode).toBe(401);
  });

  it('records an audit trail', async () => {
    const admin = await setupAdmin();
    await createUser(admin, 'val', 'viewer');
    await request('POST', '/api/v1/auth/login', {
      body: { username: 'val', password: 'bad-password' },
    });
    const res = await request('GET', '/api/v1/audit', { cookie: admin });
    const actions = res
      .json<{ entries: { action: string; outcome: string }[] }>()
      .entries.map((e) => `${e.action}:${e.outcome}`);
    expect(actions).toEqual([
      'login:failure',
      'login:success',
      'user.create:success',
      'setup:success',
    ]);
  });
});

describe('workspace API', () => {
  it('lists services from the workspace files', async () => {
    const cookie = await setupAdmin();
    const res = await request('GET', '/api/v1/services', { cookie });
    const body = res.json<{ valid: boolean; services: { name: string; sloCount: number }[] }>();
    expect(body.valid).toBe(true);
    expect(body.services.map((s) => [s.name, s.sloCount])).toEqual([
      ['ledger-api', 0],
      ['payment-api', 2],
    ]);
  });

  it('returns a service with its dependents and source files', async () => {
    const cookie = await setupAdmin();
    const res = await request('GET', '/api/v1/services/ledger-api', { cookie });
    const body = res.json<{ dependents: string[]; sources: { path: string }[] }>();
    expect(body.dependents).toEqual(['payment-api']);
    expect(body.sources.map((s) => s.path)).toEqual(['services/ledger-api.yaml']);
    expect((await request('GET', '/api/v1/services/missing', { cookie })).statusCode).toBe(404);
  });

  it('summarizes the workspace without exposing receiver secrets', async () => {
    const cookie = await setupAdmin();
    const res = await request('GET', '/api/v1/workspace', { cookie });
    expect(res.body).not.toContain('PAYMENTS_SLACK_WEBHOOK');
    expect(res.json()).toMatchObject({
      valid: true,
      workspace: { name: 'acme', level: 3, serviceCount: 2 },
    });
  });
});

describe('network exposure', () => {
  const base = { workspaceDir: '.', port: 7600, trustProxy: false };

  it('allows plain HTTP on loopback', () => {
    expect(resolveExposure({ ...base, host: '127.0.0.1' })).toMatchObject({
      secure: false,
      url: 'http://127.0.0.1:7600',
    });
  });

  it('refuses plain HTTP on a network address', () => {
    expect(() =>
      resolveExposure({ ...base, host: '0.0.0.0', publicUrl: 'https://raion.example.com' }),
    ).toThrow(ServerConfigError);
  });

  it('requires an https public URL off-loopback', () => {
    expect(() => resolveExposure({ ...base, host: '0.0.0.0', trustProxy: true })).toThrow(
      /public-url/,
    );
    expect(() =>
      resolveExposure({
        ...base,
        host: '0.0.0.0',
        trustProxy: true,
        publicUrl: 'http://raion.example.com',
      }),
    ).toThrow(/https/);
    expect(
      resolveExposure({
        ...base,
        host: '0.0.0.0',
        trustProxy: true,
        publicUrl: 'https://raion.example.com',
      }),
    ).toEqual({
      allowedHosts: ['raion.example.com'],
      secure: true,
      url: 'https://raion.example.com',
    });
  });
});
