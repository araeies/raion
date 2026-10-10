import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { loadWorkspace, ServiceRegistry } from '@raion/core';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AccountError, Accounts } from './accounts.js';
import { MAX_TOKEN_DAYS, TokenError, USERNAME, type AuthService } from './auth.js';
import { HttpError } from './errors.js';
import { createMetrics } from './metrics.js';
import { safeNext, SsoError, type OidcService } from './oidc.js';
import { passwordProblem } from './passwords.js';
import { registerAlertRoutes } from './alerts-routes.js';
import { registerSloRoutes } from './slo-routes.js';
import { registerAdvisorRoutes } from './advisor-routes.js';
import { registerWorkspaceRoutes } from './workspace-routes.js';
import { registerGrafanaProxy } from './grafana-proxy.js';
import { AlertInbox } from './inbox.js';
import { registerRuntimeRoutes } from './runtime-routes.js';
import { RuntimeService } from './runtime.js';
import { ROLES, roleAtLeast, type ApiToken, type Role, type Store, type User } from './store.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
    /** Set when the request is authenticated with a personal API token instead of a session. */
    apiToken?: ApiToken;
  }
}

export interface AppOptions {
  workspaceDir: string;
  store: Store;
  auth: AuthService;
  /** Accepted Host header values (host:port). Protects against DNS rebinding. */
  allowedHosts: string[];
  /** True when users reach Raion over HTTPS (directly or via a TLS-terminating proxy). */
  secure: boolean;
  trustProxy: boolean;
  uiDir?: string;
  logger?: boolean;
  /** Built-in TLS. Alternatively terminate TLS in a reverse proxy and set trustProxy. */
  https?: { cert: Buffer; key: Buffer };
  /** Access to the deployed runtime. Defaults to one for workspaceDir. */
  runtime?: RuntimeService;
  /** The alert inbox. Defaults to one that is polled on demand (startServer also polls periodically). */
  inbox?: AlertInbox;
  /** Single sign-on with an OpenID Connect provider, when configured in raion.yaml. */
  oidc?: OidcService;
}

const CSRF_HEADER = 'x-raion-csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const UNAUTHENTICATED_PATHS = new Set(['/healthz', '/readyz', '/metrics']);

const credentials = z.strictObject({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(USERNAME, 'username must be 2-64 characters: a-z, 0-9, ".", "_" or "-"'),
  password: z.string().min(1).max(256),
});

const roleSchema = z.enum(ROLES);

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { store, auth } = options;
  const accounts = new Accounts(store, auth);
  const cookieName = options.secure ? '__Host-raion_session' : 'raion_session';
  const allowedHosts = new Set(options.allowedHosts.map((h) => h.toLowerCase()));

  const app = Fastify({
    ...(options.https ? { https: { ...options.https, minVersion: 'TLSv1.2' as const } } : {}),
    trustProxy: options.trustProxy,
    bodyLimit: 64 * 1024,
    logger: options.logger
      ? {
          redact: {
            paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
            censor: '[redacted]',
          },
        }
      : false,
  }) as unknown as FastifyInstance;

  const metrics = createMetrics();

  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: false });

  // ----- Error handling: consistent JSON, no internals leaked ---------------------------
  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, request, reply) => {
    if (error instanceof AccountError) {
      return reply
        .status(error.status)
        .send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof HttpError) {
      return reply
        .status(error.statusCode)
        .send({ error: { code: error.code, message: error.message, ...error.extra } });
    }
    if (error instanceof z.ZodError) {
      return reply.status(400).send({
        error: {
          code: 'invalid_request',
          message: error.issues
            .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
            .join('; '),
        },
      });
    }
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'request failed');
      return reply
        .status(500)
        .send({ error: { code: 'internal', message: 'internal server error' } });
    }
    return reply
      .status(status)
      .send({ error: { code: error.code ?? 'request_error', message: error.message } });
  });

  // ----- Request guards -----------------------------------------------------------------
  app.addHook('onRequest', async (request) => {
    if (UNAUTHENTICATED_PATHS.has(request.url.split('?')[0]!)) return;

    const host = (request.headers.host ?? '').toLowerCase();
    if (!allowedHosts.has(host)) {
      throw new HttpError(
        421,
        'host_not_allowed',
        `requests for host "${host}" are not accepted by this server`,
      );
    }

    // Personal API tokens, for scripts: only on the API, and never mixed with a session. A
    // browser never sends an Authorization header on its own, so these requests need no CSRF
    // protection; an invalid token is rejected outright rather than falling back to a cookie.
    const bearer = request.url.startsWith('/api/')
      ? /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '')?.[1]
      : undefined;
    if (bearer) {
      const result = auth.authenticateApiToken(bearer);
      if (!result) {
        throw new HttpError(401, 'invalid_token', 'the API token is invalid, expired or revoked');
      }
      request.user = result.user;
      request.apiToken = result.token;
      return;
    }

    if (request.url.startsWith('/api/') && !SAFE_METHODS.has(request.method)) {
      if (request.headers[CSRF_HEADER] !== '1') {
        throw new HttpError(403, 'csrf', `missing ${CSRF_HEADER} header`);
      }
      const origin = request.headers.origin;
      if (origin !== undefined) {
        let originHost: string;
        try {
          originHost = new URL(origin).host.toLowerCase();
        } catch {
          throw new HttpError(403, 'csrf', 'invalid Origin header');
        }
        if (!allowedHosts.has(originHost))
          throw new HttpError(403, 'csrf', 'cross-origin request rejected');
      }
    }

    const token = request.cookies[cookieName];
    if (token) {
      const user = auth.authenticate(token);
      if (user) request.user = user;
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // Grafana (proxied under /grafana) ships its own scripts and styles; Raion's strict CSP
    // applies to Raion's own pages.
    if (!request.url.startsWith('/grafana')) {
      reply.header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
      );
    }
    if (options.secure) reply.header('Strict-Transport-Security', 'max-age=31536000');
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.addHook('onResponse', async (request, reply) => {
    metrics.observe(
      request.method,
      request.routeOptions.url ?? 'unmatched',
      reply.statusCode,
      reply.elapsedTime / 1000,
    );
  });

  const requireRole =
    (role: Role) =>
    async (request: FastifyRequest): Promise<void> => {
      if (!request.user) throw new HttpError(401, 'unauthenticated', 'sign in required');
      if (!roleAtLeast(request.user.role, role)) {
        throw new HttpError(403, 'forbidden', `this action requires the ${role} role`);
      }
    };

  /** Accounts and tokens are managed by a signed-in person, never through an API token. */
  const requireSession = async (request: FastifyRequest): Promise<void> => {
    if (request.apiToken) {
      throw new HttpError(
        403,
        'session_required',
        'this action needs a signed-in person; API tokens cannot manage accounts or tokens',
      );
    }
  };

  const audit = (
    request: FastifyRequest,
    action: string,
    outcome: 'success' | 'failure',
    target: string | null = null,
    details: Record<string, unknown> | null = null,
    actor: string | null = request.user?.username ?? null,
  ) =>
    store.audit({
      actor,
      action,
      target,
      outcome,
      ip: request.ip,
      // Actions done with an API token say which one.
      details: request.apiToken ? { ...details, token: request.apiToken.name } : details,
    });

  const setSessionCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(cookieName, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: options.secure,
      path: '/',
      maxAge: Math.floor(auth.settings.sessionMaxMs / 1000),
    });

  // ----- Health and metrics ------------------------------------------------------------
  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_request, reply) => {
    const checks = {
      store: safe(() => store.ping()),
      workspace: existsSync(join(options.workspaceDir, 'raion.yaml')),
    };
    const ready = Object.values(checks).every(Boolean);
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks });
  });

  app.get('/metrics', async (request, reply) => {
    // Metrics are only served to local scrapers (the Raion runtime reaches them via loopback).
    if (!isLoopback(request.socket.remoteAddress)) {
      throw new HttpError(403, 'forbidden', 'metrics are only available from loopback addresses');
    }
    return reply.type(metrics.contentType).send(await metrics.render());
  });

  // ----- First-run setup ----------------------------------------------------------------
  app.get('/api/v1/setup', async () => ({ needed: auth.needsSetup() }));

  app.post(
    '/api/v1/setup',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = credentials.extend({ token: z.string().min(1).max(256) }).parse(request.body);
      if (!auth.needsSetup())
        throw new HttpError(409, 'setup_complete', 'setup has already been completed');
      // Check the password first so a rejected password does not burn the one-time token.
      const problem = passwordProblem(body.password, body.username);
      if (problem) throw new HttpError(400, 'weak_password', problem);
      if (!auth.consumeSetupToken(body.token)) {
        audit(request, 'setup', 'failure', body.username, null, null);
        throw new HttpError(
          403,
          'invalid_setup_token',
          'the setup link is invalid or has expired; restart the server for a new one',
        );
      }
      const user = await auth.createUser(body.username, body.password, 'admin');
      audit(request, 'setup', 'success', user.username, null, user.username);
      setSessionCookie(reply, auth.createSession(user.id));
      return reply.status(201).send({ user });
    },
  );

  // ----- Authentication ------------------------------------------------------------------
  app.post(
    '/api/v1/auth/login',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = credentials.parse(request.body);
      if (options.oidc && !options.oidc.settings.passwordLogin) {
        throw new HttpError(
          403,
          'password_login_disabled',
          `password sign-in is turned off; use ${options.oidc.settings.displayName}`,
        );
      }
      const result = await auth.login(body.username, body.password);
      if (!result.ok) {
        audit(request, 'login', 'failure', body.username, { reason: result.reason }, null);
        if (result.reason === 'locked') {
          throw new HttpError(429, 'locked', 'too many failed attempts; try again later');
        }
        // Same message for unknown user, wrong password and disabled account.
        throw new HttpError(401, 'invalid_credentials', 'invalid username or password');
      }
      audit(request, 'login', 'success', result.user.username, null, result.user.username);
      setSessionCookie(reply, result.token);
      return { user: result.user };
    },
  );

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const token = request.cookies[cookieName];
    if (token) auth.logout(token);
    if (request.user) audit(request, 'logout', 'success', request.user.username);
    reply.clearCookie(cookieName, {
      path: '/',
      secure: options.secure,
      sameSite: 'strict',
      httpOnly: true,
    });
    return reply.status(204).send();
  });

  // ----- Single sign-on (OpenID Connect) ------------------------------------------------
  const oidc = options.oidc;
  const oidcCookie = options.secure ? '__Secure-raion_oidc' : 'raion_oidc';
  const oidcCookiePath = '/api/v1/auth/oidc';

  /** How people can sign in; read by the sign-in page. */
  app.get('/api/v1/auth/methods', async () => ({
    password: !oidc || oidc.settings.passwordLogin,
    sso: oidc ? { displayName: oidc.settings.displayName } : null,
  }));

  if (oidc) {
    const failed = (reply: FastifyReply, code: string) =>
      reply
        .clearCookie(oidcCookie, { path: oidcCookiePath, secure: options.secure })
        .redirect(`/login?sso_error=${encodeURIComponent(code)}`, 303);

    app.get(
      '/api/v1/auth/oidc/start',
      { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
      async (request, reply) => {
        const { next } = z.object({ next: z.string().max(512).optional() }).parse(request.query);
        let started: { url: URL; state: string };
        try {
          started = await oidc.start(safeNext(next));
        } catch (error) {
          if (!(error instanceof SsoError)) throw error;
          request.log.warn({ err: error }, 'single sign-on could not start');
          return failed(reply, error.code);
        }
        // Lax, not Strict: the browser must send it back when the provider redirects here.
        reply.setCookie(oidcCookie, started.state, {
          httpOnly: true,
          sameSite: 'lax',
          secure: options.secure,
          path: oidcCookiePath,
          maxAge: 600,
        });
        return reply.redirect(started.url.href, 303);
      },
    );

    app.get(
      '/api/v1/auth/oidc/callback',
      { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
      async (request, reply) => {
        const callbackUrl = new URL(oidc.redirectUri);
        callbackUrl.search = new URL(request.url, 'http://callback').search;
        if (callbackUrl.searchParams.has('error')) {
          audit(
            request,
            'login',
            'failure',
            null,
            {
              method: 'sso',
              reason: 'provider_error',
            },
            null,
          );
          return failed(reply, 'provider_rejected');
        }
        let person: Awaited<ReturnType<OidcService['finish']>>;
        try {
          person = await oidc.finish(callbackUrl, request.cookies[oidcCookie]);
        } catch (error) {
          if (!(error instanceof SsoError)) throw error;
          request.log.warn({ err: error }, 'single sign-on failed');
          audit(request, 'login', 'failure', null, { method: 'sso', reason: error.code }, null);
          return failed(reply, error.code);
        }
        const result = auth.ssoSignIn(person);
        if (!result.ok) {
          audit(
            request,
            'login',
            'failure',
            person.username,
            {
              method: 'sso',
              reason: result.reason,
            },
            null,
          );
          return failed(reply, result.reason);
        }
        if (result.created) {
          audit(
            request,
            'user.create',
            'success',
            result.user.username,
            {
              role: result.user.role,
              sso: true,
            },
            result.user.username,
          );
        }
        audit(
          request,
          'login',
          'success',
          result.user.username,
          {
            method: 'sso',
            role: result.user.role,
          },
          result.user.username,
        );
        reply.clearCookie(oidcCookie, { path: oidcCookiePath, secure: options.secure });
        setSessionCookie(reply, result.token);
        // The session cookie is SameSite=Strict, and browsers withhold it for the rest of a
        // redirect chain that began at the provider. Ending the chain here with a page that
        // moves on by itself makes the next request a same-site one.
        const next = escapeHtml(person.next);
        return reply
          .type('text/html; charset=utf-8')
          .send(
            `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${next}">` +
              `<title>Signing in</title><p>Signed in. <a href="${next}">Continue to Raion</a></p>`,
          );
      },
    );
  }

  app.get('/api/v1/auth/me', { preHandler: requireRole('viewer') }, async (request) => ({
    user: request.user,
  }));

  app.post(
    '/api/v1/auth/password',
    { preHandler: [requireRole('viewer'), requireSession] },
    async (request, reply) => {
      const body = z
        .strictObject({
          currentPassword: z.string().min(1).max(256),
          newPassword: z.string().min(1).max(256),
        })
        .parse(request.body);
      const user = request.user!;
      if (user.sso) {
        throw new HttpError(
          409,
          'sso_account',
          'this account signs in with single sign-on; change the password at your identity provider',
        );
      }
      if (!(await auth.verifyUserPassword(user.username, body.currentPassword))) {
        audit(request, 'password.change', 'failure', user.username);
        throw new HttpError(403, 'invalid_credentials', 'current password is incorrect');
      }
      const problem = passwordProblem(body.newPassword, user.username);
      if (problem) throw new HttpError(400, 'weak_password', problem);
      store.updateUser(user.id, { passwordHash: await auth.hashPassword(body.newPassword) });
      store.deleteUserSessions(user.id);
      audit(request, 'password.change', 'success', user.username);
      setSessionCookie(reply, auth.createSession(user.id));
      return reply.status(204).send();
    },
  );

  // ----- User administration (admin) ----------------------------------------------------
  app.get('/api/v1/users', { preHandler: [requireRole('admin'), requireSession] }, async () => ({
    users: store.listUsers(),
  }));

  app.post(
    '/api/v1/users',
    { preHandler: [requireRole('admin'), requireSession] },
    async (request, reply) => {
      const body = credentials.extend({ role: roleSchema }).parse(request.body);
      const user = await accounts.create(body.username, body.password, body.role);
      audit(request, 'user.create', 'success', user.username, { role: user.role });
      return reply.status(201).send({ user });
    },
  );

  app.patch(
    '/api/v1/users/:username',
    { preHandler: [requireRole('admin'), requireSession] },
    async (request) => {
      const { username } = z.object({ username: z.string().max(64) }).parse(request.params);
      const body = z
        .strictObject({
          role: roleSchema.optional(),
          disabled: z.boolean().optional(),
          password: z.string().max(256).optional(),
        })
        .parse(request.body);
      const { user, details } = await accounts.update(username, body);
      audit(request, 'user.update', 'success', username, details);
      return { user };
    },
  );

  app.get('/api/v1/audit', { preHandler: requireRole('admin') }, async (request) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        before: z.coerce.number().int().positive().optional(),
        actor: z.string().max(64).optional(),
        action: z
          .string()
          .regex(/^[a-z][a-z.]{0,63}$/)
          .optional(),
      })
      .parse(request.query);
    return {
      entries: store.listAudit(query.limit, query.before, {
        ...(query.actor ? { actor: query.actor } : {}),
        ...(query.action ? { action: query.action } : {}),
      }),
    };
  });

  // ----- Personal API tokens (managed by a signed-in person) -------------------------------
  /** Your own tokens; admins can ask for everyone's with ?all=true. Secrets are never returned. */
  app.get(
    '/api/v1/tokens',
    { preHandler: [requireRole('viewer'), requireSession] },
    async (request) => {
      const { all } = z.object({ all: z.enum(['true', 'false']).optional() }).parse(request.query);
      const user = request.user!;
      if (all === 'true' && !roleAtLeast(user.role, 'admin')) {
        throw new HttpError(403, 'forbidden', "only admins can list everyone's tokens");
      }
      return { tokens: store.listApiTokens(all === 'true' ? undefined : user.id) };
    },
  );

  app.post(
    '/api/v1/tokens',
    { preHandler: [requireRole('viewer'), requireSession] },
    async (request, reply) => {
      const body = z
        .strictObject({
          name: z.string().trim().min(1).max(64),
          role: roleSchema,
          expiresInDays: z.number().int().min(1).max(MAX_TOKEN_DAYS),
        })
        .parse(request.body);
      try {
        const { token, record } = auth.createApiToken(request.user!, body);
        audit(request, 'token.create', 'success', body.name, {
          id: record.id,
          role: record.role,
          expiresAt: record.expiresAt,
        });
        // The only time the token is ever shown.
        return await reply.status(201).send({ token, record });
      } catch (error) {
        if (error instanceof TokenError)
          throw new HttpError(400, 'invalid_token_request', error.message);
        throw error;
      }
    },
  );

  /** Revokes one of your tokens; admins can revoke anyone's. */
  app.delete(
    '/api/v1/tokens/:id',
    { preHandler: [requireRole('viewer'), requireSession] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().regex(/^[0-9a-f]{16}$/) }).parse(request.params);
      const token = store.getApiToken(id);
      const user = request.user!;
      if (!token || (token.userId !== user.id && !roleAtLeast(user.role, 'admin'))) {
        throw new HttpError(404, 'not_found', 'no such token');
      }
      store.revokeApiToken(id);
      audit(request, 'token.revoke', 'success', token.name, { id, owner: token.username });
      return reply.status(204).send();
    },
  );

  // ----- Workspace and services (viewer) ------------------------------------------------
  app.get('/api/v1/workspace', { preHandler: requireRole('viewer') }, async () => {
    const result = await loadWorkspace(options.workspaceDir);
    const ws = result.workspace;
    return {
      valid: result.ok,
      diagnostics: result.diagnostics,
      workspace: ws
        ? {
            name: ws.name,
            description: ws.description,
            level: ws.level,
            environment: ws.environment,
            target: ws.target,
            infrastructure: ws.infrastructure,
            features: ws.features,
            teams: ws.teams,
            receivers: ws.receivers.map((r) => ({ name: r.name, type: r.type })),
            defaultReceiver: ws.defaultReceiver ?? null,
            retention: ws.retention,
            publicUrl: ws.server.publicUrl,
            sso: ws.server.sso?.oidc ? { displayName: ws.server.sso.oidc.displayName } : null,
            serviceCount: ws.services.length,
          }
        : null,
    };
  });

  app.get('/api/v1/services', { preHandler: requireRole('viewer') }, async () => {
    const result = await loadWorkspace(options.workspaceDir);
    return {
      valid: result.ok,
      diagnostics: result.diagnostics,
      services: (result.workspace?.services ?? []).map((s) => ({
        name: s.name,
        type: s.type,
        language: s.language,
        tier: s.tier,
        team: s.team,
        owner: s.owner,
        level: s.level,
        sloCount: s.slos.length,
        dependencyCount: s.dependencies.length,
      })),
    };
  });

  app.get('/api/v1/services/:name', { preHandler: requireRole('viewer') }, async (request) => {
    const { name } = z.object({ name: z.string().max(63) }).parse(request.params);
    const result = await loadWorkspace(options.workspaceDir);
    if (!result.workspace) {
      throw new HttpError(422, 'invalid_workspace', 'the workspace configuration has errors', {
        diagnostics: result.diagnostics,
      });
    }
    const registry = new ServiceRegistry(result.workspace);
    const service = registry.get(name);
    if (!service) throw new HttpError(404, 'not_found', `service "${name}" not found`);
    // The source shown is one of the files Raion itself loaded, never an arbitrary path.
    const sourceFiles = new Set([service.source.file, ...service.slos.map((s) => s.source.file)]);
    return {
      service,
      dependents: registry.dependentsOf(name).map((s) => s.name),
      sources: result.files.filter((f) => sourceFiles.has(f.path)),
    };
  });

  const runtime = options.runtime ?? new RuntimeService(options.workspaceDir);
  registerRuntimeRoutes(app, runtime, { requireRole, audit });
  const inbox = options.inbox ?? new AlertInbox(store, runtime);
  registerAlertRoutes(
    app,
    { inbox, runtime, workspaceDir: options.workspaceDir },
    { requireRole, audit },
  );
  registerSloRoutes(app, runtime, options.workspaceDir, { requireRole, audit });
  registerAdvisorRoutes(app, runtime, options.workspaceDir, { requireRole, audit });
  registerWorkspaceRoutes(app, runtime, options.workspaceDir, { requireRole, audit });
  await registerGrafanaProxy(app, runtime, cookieName);

  app.all('/api/*', async () => {
    throw new HttpError(404, 'not_found', 'unknown API endpoint');
  });

  // ----- Web UI -------------------------------------------------------------------------
  if (options.uiDir && existsSync(join(options.uiDir, 'index.html'))) {
    const uiDir = options.uiDir;
    await app.register(fastifyStatic, { root: uiDir, index: false, wildcard: false });
    const indexHtml = await readFile(join(uiDir, 'index.html'), 'utf8');
    const sendIndex = (_request: FastifyRequest, reply: FastifyReply) =>
      reply.type('text/html').send(indexHtml);
    app.get('/', sendIndex);
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        // Static files are matched first; everything else is a client-side route.
        if (/\.[a-z0-9]+$/i.test(request.url.split('?')[0]!)) {
          return reply.status(404).send({ error: { code: 'not_found', message: 'not found' } });
        }
        return sendIndex(request, reply);
      }
      return reply.status(404).send({ error: { code: 'not_found', message: 'not found' } });
    });
  }

  return app;
}

function safe(check: () => boolean): boolean {
  try {
    return check();
  } catch {
    return false;
  }
}

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
