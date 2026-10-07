import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { oidcSettings } from '@raion/schema';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { AuthService, DEFAULT_AUTH } from '../src/auth.js';
import { OidcService, safeNext } from '../src/oidc.js';
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
const REDIRECT_URI = `http://${HOST}/api/v1/auth/oidc/callback`;
const CLIENT_ID = 'raion';
const CLIENT_SECRET = 'fake-client-secret';

const b64url = (value: Buffer | string) => Buffer.from(value).toString('base64url');

/**
 * A minimal OpenID Connect provider: discovery, keys, and a token endpoint that checks the
 * client secret and PKCE and issues an RS256-signed ID token.
 */
class FakeProvider {
  readonly #server: Server;
  readonly #key: KeyObject;
  readonly #jwk: Record<string, unknown>;
  readonly #codes = new Map<
    string,
    { challenge: string; nonce: string; claims: Record<string, unknown> }
  >();
  issuer = '';
  tokenRequests = 0;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.#key = privateKey;
    this.#jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
    this.#server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', this.issuer);
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/.well-known/openid-configuration') {
        return json(200, {
          issuer: this.issuer,
          authorization_endpoint: `${this.issuer}/authorize`,
          token_endpoint: `${this.issuer}/token`,
          jwks_uri: `${this.issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_post'],
        });
      }
      if (url.pathname === '/jwks') return json(200, { keys: [this.#jwk] });
      if (url.pathname === '/token' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
          this.tokenRequests++;
          const form = new URLSearchParams(body);
          const grant = this.#codes.get(form.get('code') ?? '');
          this.#codes.delete(form.get('code') ?? '');
          const verifier = form.get('code_verifier') ?? '';
          if (
            !grant ||
            form.get('client_id') !== CLIENT_ID ||
            form.get('client_secret') !== CLIENT_SECRET ||
            form.get('redirect_uri') !== REDIRECT_URI ||
            b64url(createHash('sha256').update(verifier).digest()) !== grant.challenge
          ) {
            return json(400, { error: 'invalid_grant' });
          }
          const now = Math.floor(Date.now() / 1000);
          json(200, {
            access_token: b64url(randomBytes(16)),
            token_type: 'Bearer',
            expires_in: 300,
            id_token: this.idToken({
              iss: this.issuer,
              aud: CLIENT_ID,
              iat: now,
              exp: now + 300,
              nonce: grant.nonce,
              ...grant.claims,
            }),
          });
        });
        return;
      }
      json(404, { error: 'not_found' });
    });
  }

  idToken(payload: Record<string, unknown>): string {
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' }));
    const body = b64url(JSON.stringify(payload));
    const signature = sign('sha256', Buffer.from(`${head}.${body}`), this.#key);
    return `${head}.${body}.${b64url(signature)}`;
  }

  /** What the provider does when the person signs in: hands out a code for the redirect. */
  authorize(authorizeUrl: URL, claims: Record<string, unknown>): string {
    const code = b64url(randomBytes(16));
    this.#codes.set(code, {
      challenge: authorizeUrl.searchParams.get('code_challenge')!,
      nonce: authorizeUrl.searchParams.get('nonce')!,
      claims,
    });
    return code;
  }

  async listen(): Promise<void> {
    await new Promise<void>((done) => this.#server.listen(0, '127.0.0.1', done));
    this.issuer = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  close(): Promise<void> {
    return new Promise((done) => this.#server.close(() => done()));
  }
}

const provider = new FakeProvider();
beforeAll(() => provider.listen());
afterAll(() => provider.close());

let app: FastifyInstance;
let store: Store;
let auth: AuthService;

async function start(settings: Record<string, unknown> = {}): Promise<void> {
  store = new Store(':memory:');
  auth = new AuthService(store, { ...DEFAULT_AUTH, scrypt: { N: 1024, r: 8, p: 1 } });
  const oidc = new OidcService(
    oidcSettings.parse({
      issuer: provider.issuer,
      clientId: CLIENT_ID,
      clientSecret: '${secret:OIDC_CLIENT_SECRET}',
      displayName: 'Example SSO',
      roles: { admin: ['raion-admins'], editor: ['raion-editors'] },
      ...settings,
    }),
    CLIENT_SECRET,
    REDIRECT_URI,
  );
  app = await buildApp({
    workspaceDir,
    store,
    auth,
    allowedHosts: [HOST],
    secure: false,
    trustProxy: false,
    oidc,
  });
}

function get(url: string, cookie?: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'GET',
    url,
    headers: { host: HOST, ...(cookie ? { cookie } : {}) },
  });
}

function cookieOf(res: LightMyRequestResponse, name: string): string | undefined {
  return res.cookies.find((c) => c.name === name && c.value)?.value;
}

/** Runs the whole browser round trip; returns the callback response. */
async function signIn(
  claims: Record<string, unknown>,
  next = '/services',
): Promise<LightMyRequestResponse> {
  const started = await get(`/api/v1/auth/oidc/start?next=${encodeURIComponent(next)}`);
  expect(started.statusCode).toBe(303);
  const authorizeUrl = new URL(started.headers.location as string);
  const code = provider.authorize(authorizeUrl, claims);
  const state = authorizeUrl.searchParams.get('state')!;
  return get(
    `/api/v1/auth/oidc/callback?code=${code}&state=${state}`,
    `raion_oidc=${cookieOf(started, 'raion_oidc')}`,
  );
}

const alice = {
  sub: 'user-0001',
  preferred_username: 'Alice@Example.com',
  groups: ['staff', 'raion-editors'],
};

describe('single sign-on', () => {
  afterEach(async () => {
    await app.close();
    store.close();
  });

  it('tells the sign-in page which methods exist', async () => {
    await start();
    expect((await get('/api/v1/auth/methods')).json()).toEqual({
      password: true,
      sso: { displayName: 'Example SSO' },
    });
  });

  it('sends the browser to the provider with PKCE, state and nonce', async () => {
    await start();
    const res = await get('/api/v1/auth/oidc/start');
    const url = new URL(res.headers.location as string);
    expect(url.origin + url.pathname).toBe(`${provider.issuer}/authorize`);
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();
    const cookie = res.cookies.find((c) => c.name === 'raion_oidc')!;
    expect(cookie.value).toBe(url.searchParams.get('state'));
    expect(cookie.sameSite).toBe('Lax');
    expect(cookie.httpOnly).toBe(true);
  });

  it('creates the account on first sign-in, with the role from the groups', async () => {
    await start();
    const res = await signIn(alice);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('content="0;url=/services"');
    const session = cookieOf(res, 'raion_session');
    expect(session).toBeTruthy();

    const me = await get('/api/v1/auth/me', `raion_session=${session}`);
    expect(me.json().user).toMatchObject({ username: 'alice', role: 'editor', sso: true });

    const actions = store.listAudit(10).map((e) => `${e.action}:${e.outcome}`);
    expect(actions).toEqual(expect.arrayContaining(['user.create:success', 'login:success']));
  });

  it('follows role changes at the provider and reuses the account', async () => {
    await start();
    await signIn(alice);
    const res = await signIn({ ...alice, preferred_username: 'renamed', groups: ['raion-admins'] });
    const me = await get('/api/v1/auth/me', `raion_session=${cookieOf(res, 'raion_session')}`);
    // Linked by the provider's subject, so a renamed person keeps their account.
    expect(me.json().user).toMatchObject({ username: 'alice', role: 'admin' });
    expect(store.listUsers()).toHaveLength(1);
  });

  it('refuses people in no mapped group, unless there is a default role', async () => {
    await start();
    const res = await signIn({ ...alice, groups: ['staff'] });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/login?sso_error=no_role');
    expect(cookieOf(res, 'raion_session')).toBeUndefined();
    await app.close();
    store.close();

    await start({ roles: { default: 'viewer' } });
    const ok = await signIn({ ...alice, groups: ['staff'] });
    expect(ok.statusCode).toBe(200);
    expect(store.findUser('alice')?.role).toBe('viewer');
  });

  it('never takes over an existing password account', async () => {
    await start();
    await auth.createUser('alice', 'correct horse battery', 'admin');
    const res = await signIn(alice);
    expect(res.headers.location).toBe('/login?sso_error=username_taken');
    expect(store.findUser('alice')?.sso).toBeUndefined();
  });

  it('rejects a callback without the matching state cookie', async () => {
    await start();
    const started = await get('/api/v1/auth/oidc/start');
    const authorizeUrl = new URL(started.headers.location as string);
    const code = provider.authorize(authorizeUrl, alice);
    const state = authorizeUrl.searchParams.get('state')!;
    const before = provider.tokenRequests;
    const res = await get(`/api/v1/auth/oidc/callback?code=${code}&state=${state}`);
    expect(res.headers.location).toBe('/login?sso_error=invalid_state');
    // The code is never redeemed for someone whose browser did not start the sign-in.
    expect(provider.tokenRequests).toBe(before);
    // And the state cannot be replayed afterwards, even with the cookie.
    const again = await get(
      `/api/v1/auth/oidc/callback?code=${code}&state=${state}`,
      `raion_oidc=${state}`,
    );
    expect(again.headers.location).toBe('/login?sso_error=invalid_state');
  });

  it('reports a provider error without details', async () => {
    await start();
    const res = await get('/api/v1/auth/oidc/callback?error=access_denied&state=x');
    expect(res.headers.location).toBe('/login?sso_error=provider_rejected');
  });

  it('can turn password sign-in off', async () => {
    await start({ passwordLogin: false });
    await auth.createUser('bob', 'correct horse battery', 'admin');
    expect((await get('/api/v1/auth/methods')).json().password).toBe(false);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { host: HOST, 'x-raion-csrf': '1' },
      payload: { username: 'bob', password: 'correct horse battery' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('password_login_disabled');
  });

  it('leaves the password and role of a single sign-on account to the provider', async () => {
    await start();
    const signedIn = await signIn({ ...alice, groups: ['raion-admins'] });
    const cookie = `raion_session=${cookieOf(signedIn, 'raion_session')}`;
    const post = (method: 'POST' | 'PATCH', url: string, payload: object) =>
      app.inject({
        method,
        url,
        headers: { host: HOST, 'x-raion-csrf': '1', cookie },
        payload,
      });
    const change = await post('POST', '/api/v1/auth/password', {
      currentPassword: 'anything',
      newPassword: 'a new long password',
    });
    expect(change.statusCode).toBe(409);
    expect(change.json().error.code).toBe('sso_account');
    // A password account can still never sign in as the SSO account.
    expect((await auth.login('alice', '!sso')).ok).toBe(false);

    const reset = await post('PATCH', '/api/v1/users/alice', { role: 'viewer' });
    expect(reset.statusCode).toBe(409);
  });
});

describe('single sign-on safety checks', () => {
  it('only redirects to local paths after sign-in', () => {
    expect(safeNext('/services/shop')).toBe('/services/shop');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('/\\evil.example')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext(undefined)).toBe('/');
  });

  it('requires https for a provider that is not on this machine', () => {
    const settings = oidcSettings.parse({
      issuer: 'http://idp.example.com',
      clientId: CLIENT_ID,
      clientSecret: '${env:SECRET}',
    });
    expect(() => new OidcService(settings, 's', REDIRECT_URI)).toThrow(/https/);
  });

  it('maps groups to the highest role and derives a valid username', () => {
    const service = new OidcService(
      oidcSettings.parse({
        issuer: 'https://idp.example.com',
        clientId: CLIENT_ID,
        clientSecret: '${env:SECRET}',
        roles: { admin: ['ops'], viewer: ['staff'] },
      }),
      's',
      REDIRECT_URI,
    );
    expect(service.role({ groups: ['staff', 'ops'] })).toBe('admin');
    expect(service.role({ groups: 'staff' })).toBe('viewer');
    expect(service.role({})).toBeUndefined();
    expect(service.username({ preferred_username: 'Jo Smith' })).toBe('jo-smith');
    expect(service.username({ email: 'jo@example.com' })).toBe('jo');
    expect(service.username({ preferred_username: '!' })).toBeUndefined();
  });
});
