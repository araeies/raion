import { Readable } from 'node:stream';
import { GATEWAY_TOKEN_HEADER } from '@raion/deploy';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RuntimeService } from './runtime.js';
import type { Role } from './store.js';

const GRAFANA_ROLE: Record<Role, string> = { viewer: 'Viewer', editor: 'Editor', admin: 'Admin' };

/** Headers that must never be forwarded in either direction. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

/**
 * Grafana single sign-on: Raion authenticates the user, then forwards the request through
 * the gateway with the user's identity and role. Grafana trusts these headers only because
 * nothing but the gateway can reach it, and only Raion holds the gateway secret.
 */
export async function registerGrafanaProxy(
  app: FastifyInstance,
  runtime: RuntimeService,
  sessionCookie: string,
): Promise<void> {
  await app.register(async (scope) => {
    // Stream request bodies through untouched.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_request, payload, done) => {
      done(null, payload);
    });

    const handler = async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user) {
        if (request.method === 'GET' && (request.headers.accept ?? '').includes('text/html')) {
          return reply.redirect(`/login?next=${encodeURIComponent(request.url)}`);
        }
        return reply
          .status(401)
          .send({ error: { code: 'unauthenticated', message: 'sign in to Raion first' } });
      }
      const gateway = await runtime.gateway();
      if (!gateway) {
        return reply
          .status(503)
          .type('text/html')
          .send(
            '<!doctype html><title>Grafana unavailable</title><p>The observability stack is not deployed yet. Run <code>raion apply</code>, or open <a href="/runtime">Runtime</a> in Raion.</p>',
          );
      }

      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        const lower = name.toLowerCase();
        if (value === undefined || HOP_BY_HOP.has(lower)) continue;
        // Identity headers are set by Raion only; anything the browser sent is dropped.
        if (lower.startsWith('x-webauth-') || lower === GATEWAY_TOKEN_HEADER.toLowerCase())
          continue;
        if (lower === 'cookie') {
          const kept = String(value)
            .split(';')
            .map((c) => c.trim())
            .filter((c) => c && !c.startsWith(`${sessionCookie}=`));
          if (kept.length > 0) headers.set('cookie', kept.join('; '));
          continue;
        }
        headers.set(lower, Array.isArray(value) ? value.join(', ') : value);
      }
      headers.set('accept-encoding', 'identity');
      headers.set('x-webauth-user', user.username);
      headers.set('x-webauth-role', GRAFANA_ROLE[user.role]);

      const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
      let upstream: Response;
      try {
        upstream = await gateway.fetch(request.url, {
          method: request.method,
          headers,
          ...(hasBody
            ? { body: Readable.toWeb(request.body as Readable) as ReadableStream, duplex: 'half' }
            : {}),
          timeoutMs: 120_000,
        });
      } catch (error) {
        request.log.warn({ err: error }, 'grafana proxy request failed');
        return reply.status(502).send({
          error: { code: 'bad_gateway', message: 'Grafana is not reachable; run "raion status"' },
        });
      }

      reply.status(upstream.status);
      upstream.headers.forEach((value, name) => {
        if (HOP_BY_HOP.has(name) || name === 'content-encoding' || name === 'set-cookie') return;
        reply.header(name, value);
      });
      for (const cookie of upstream.headers.getSetCookie()) reply.header('set-cookie', cookie);
      if (!upstream.body) return reply.send();
      return reply.send(Readable.fromWeb(upstream.body as never));
    };

    scope.all('/grafana', handler);
    scope.all('/grafana/*', handler);
  });
}
