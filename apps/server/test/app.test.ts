import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('filters the audit trail by person and by kind of action', async () => {
    const admin = await setupAdmin();
    await createUser(admin, 'val', 'viewer');
    const actions = async (query: string) =>
      (await request('GET', `/api/v1/audit?${query}`, { cookie: admin }))
        .json<{ entries: { action: string; actor: string | null }[] }>()
        .entries.map((e) => `${e.actor}:${e.action}`);
    // "user" matches user.create but not, for example, a hypothetical "users" action.
    expect(await actions('action=user')).toEqual(['admin:user.create']);
    expect(await actions('actor=val')).toEqual(['val:login']);
    expect((await request('GET', '/api/v1/audit?action=x%25', { cookie: admin })).statusCode).toBe(
      400,
    );
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

describe('personal API tokens', () => {
  const bearer = (
    token: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
  ) =>
    app.inject({
      method,
      url,
      // No CSRF header and no cookie: a script, not a browser.
      headers: { host: HOST, authorization: `Bearer ${token}` },
      ...(body !== undefined ? { payload: body as object } : {}),
    });

  async function createToken(cookie: string, role: string, name = 'ci') {
    const res = await request('POST', '/api/v1/tokens', {
      cookie,
      body: { name, role, expiresInDays: 30 },
    });
    return res;
  }

  it('is shown once, works without a session or CSRF header, and is audited with its name', async () => {
    const admin = await setupAdmin();
    const editor = await createUser(admin, 'erin', 'editor');
    const created = await createToken(editor, 'editor', 'deploy-bot');
    expect(created.statusCode).toBe(201);
    const { token } = created.json<{ token: string }>();
    expect(token).toMatch(/^raion_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);

    const list = await request('GET', '/api/v1/tokens', { cookie: editor });
    // The secret follows "raion_" and the 16-character ID; it may itself contain "_".
    const secret = token.slice('raion_'.length + 17);
    expect(secret).toHaveLength(43);
    expect(list.body).not.toContain(secret);
    expect(list.json<{ tokens: { name: string }[] }>().tokens.map((t) => t.name)).toEqual([
      'deploy-bot',
    ]);

    expect((await bearer(token, 'GET', '/api/v1/services')).statusCode).toBe(200);
    // A write without the CSRF header passes authentication (the finding simply does not exist).
    const write = await bearer(token, 'POST', '/api/v1/advisor/apply', { id: 'none/none' });
    expect(write.statusCode).toBe(409);

    const created2 = await request('GET', '/api/v1/audit?action=token', { cookie: admin });
    expect(
      created2.json<{ entries: { actor: string; target: string }[] }>().entries[0],
    ).toMatchObject({
      actor: 'erin',
      target: 'deploy-bot',
    });
  });

  it('never has more rights than its owner has now', async () => {
    const admin = await setupAdmin();
    const viewer = await createUser(admin, 'vic', 'viewer');
    expect((await createToken(viewer, 'admin')).statusCode).toBe(400);

    const sam = await createUser(admin, 'sam', 'admin');
    const { token } = (await createToken(sam, 'admin')).json<{ token: string }>();
    expect((await bearer(token, 'GET', '/api/v1/audit')).statusCode).toBe(200);
    await request('PATCH', '/api/v1/users/sam', { cookie: admin, body: { role: 'viewer' } });
    expect((await bearer(token, 'GET', '/api/v1/audit')).statusCode).toBe(403);
    expect((await bearer(token, 'GET', '/api/v1/services')).statusCode).toBe(200);

    await request('PATCH', '/api/v1/users/sam', { cookie: admin, body: { disabled: true } });
    expect((await bearer(token, 'GET', '/api/v1/services')).statusCode).toBe(401);
  });

  it('cannot manage accounts or tokens', async () => {
    const admin = await setupAdmin();
    const { token } = (await createToken(admin, 'admin')).json<{ token: string }>();
    for (const [method, url, body] of [
      ['POST', '/api/v1/tokens', { name: 'x', role: 'viewer', expiresInDays: 1 }],
      ['GET', '/api/v1/tokens', undefined],
      [
        'POST',
        '/api/v1/users',
        { username: 'mallory', password: 'long-enough-password', role: 'admin' },
      ],
      ['PATCH', '/api/v1/users/admin', { password: 'another-long-password' }],
      ['POST', '/api/v1/auth/password', { currentPassword: 'x', newPassword: 'y-long-enough-pw' }],
    ] as const) {
      const res = await bearer(token, method, url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('session_required');
    }
  });

  it('stops working when revoked or expired, and a bad token is never ignored', async () => {
    const admin = await setupAdmin();
    const valid = await setupSecondToken(admin);
    const revoked = (await createToken(admin, 'viewer', 'old')).json<{
      token: string;
      record: { id: string };
    }>();
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tokens/${revoked.record.id}`,
      headers: { host: HOST, cookie: admin, 'x-raion-csrf': '1' },
    });
    expect(del.statusCode).toBe(204);
    expect((await bearer(revoked.token, 'GET', '/api/v1/services')).statusCode).toBe(401);

    // A malformed or wrong token is rejected even when a valid session cookie is also sent.
    const mixed = await app.inject({
      method: 'GET',
      url: '/api/v1/services',
      headers: { host: HOST, cookie: admin, authorization: `Bearer ${valid.slice(0, -1)}x` },
    });
    expect(mixed.statusCode).toBe(401);

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 31 * 86_400_000);
      expect((await bearer(valid, 'GET', '/api/v1/services')).statusCode).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  async function setupSecondToken(cookie: string): Promise<string> {
    return (await createToken(cookie, 'viewer', 'reader')).json<{ token: string }>().token;
  }
});
