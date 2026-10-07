import {
  createSilence,
  deleteSilence,
  listSecrets,
  listSilences,
  removeSecret,
  SECRET_KEY,
  SecretError,
  secretStatus,
  setSecret,
  StatePaths,
} from '@raion/deploy';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from './errors.js';
import type { AlertInbox } from './inbox.js';
import type { RuntimeService } from './runtime.js';
import type { Role } from './store.js';

interface Helpers {
  requireRole: (role: Role) => (request: FastifyRequest) => Promise<void>;
  audit: (
    request: FastifyRequest,
    action: string,
    outcome: 'success' | 'failure',
    target?: string | null,
    details?: Record<string, unknown> | null,
  ) => void;
}

export function registerAlertRoutes(
  app: FastifyInstance,
  deps: { inbox: AlertInbox; runtime: RuntimeService; workspaceDir: string },
  { requireRole, audit }: Helpers,
): void {
  const { inbox, runtime } = deps;

  const gatewayOrFail = async () => {
    const gateway = await runtime.gateway();
    if (!gateway)
      throw new HttpError(409, 'not_deployed', 'the observability stack is not deployed');
    return gateway;
  };

  /** Firing alerts, recent history and the health of the alerting pipeline. */
  app.get('/api/v1/alerts', { preHandler: requireRole('viewer') }, async (request) => {
    const query = z.object({ service: z.string().max(63).optional() }).parse(request.query);
    await inbox.refresh().catch(() => undefined);
    const filter = query.service ? { service: query.service } : {};
    const ctx = await runtime.context();
    return {
      deployed: Boolean(ctx?.target.releases.currentId()),
      health: inbox.health() ?? null,
      firing: inbox.store.listAlerts({ open: true, limit: 200, ...filter }),
      resolved: inbox.store.listAlerts({ open: false, limit: 50, ...filter }),
      rules: ctx?.bundle.alerts.filter((a) => !query.service || a.service === query.service) ?? [],
    };
  });

  app.get('/api/v1/alerts/silences', { preHandler: requireRole('viewer') }, async () => ({
    silences: await listSilences(await gatewayOrFail()),
  }));

  /** Silence an alert (stop notifications) for a while. Alerts stay visible in the inbox. */
  app.post(
    '/api/v1/alerts/silences',
    { preHandler: requireRole('editor') },
    async (request, reply) => {
      const body = z
        .strictObject({
          alertname: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/),
          service: z.string().max(63).optional(),
          minutes: z
            .number()
            .int()
            .min(5)
            .max(7 * 24 * 60),
          comment: z.string().trim().min(1).max(500),
        })
        .parse(request.body);
      const matchers: Record<string, string> = {
        alertname: body.alertname,
        ...(body.service ? { service_name: body.service } : {}),
      };
      const id = await createSilence(await gatewayOrFail(), {
        matchers,
        minutes: body.minutes,
        createdBy: request.user!.username,
        comment: body.comment,
      });
      audit(request, 'alert.silence', 'success', id, { ...matchers, minutes: body.minutes });
      await inbox.poll().catch(() => undefined);
      return reply.status(201).send({ id });
    },
  );

  app.delete(
    '/api/v1/alerts/silences/:id',
    { preHandler: requireRole('editor') },
    async (request, reply) => {
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      await deleteSilence(await gatewayOrFail(), id);
      audit(request, 'alert.unsilence', 'success', id);
      await inbox.poll().catch(() => undefined);
      return reply.status(204).send();
    },
  );

  // ----- Secrets for notification receivers (admin) ------------------------------------

  const paths = new StatePaths(deps.workspaceDir);

  /** Which secrets receivers need and whether they are set. Values are never returned. */
  app.get('/api/v1/secrets', { preHandler: requireRole('admin') }, async () => {
    const ctx = await runtime.context();
    const needed = ctx ? secretStatus(paths, ctx.bundle) : [];
    return { needed, stored: listSecrets(paths) };
  });

  app.put('/api/v1/secrets/:key', { preHandler: requireRole('admin') }, async (request, reply) => {
    const { key } = z.object({ key: z.string().regex(SECRET_KEY) }).parse(request.params);
    const { value } = z.strictObject({ value: z.string().min(1).max(65_536) }).parse(request.body);
    try {
      setSecret(paths, key, value);
    } catch (error) {
      if (error instanceof SecretError) throw new HttpError(400, 'invalid_secret', error.message);
      throw error;
    }
    audit(request, 'secret.set', 'success', key);
    return reply.status(204).send();
  });

  app.delete(
    '/api/v1/secrets/:key',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      const { key } = z.object({ key: z.string().regex(SECRET_KEY) }).parse(request.params);
      if (!removeSecret(paths, key))
        throw new HttpError(404, 'not_found', `secret ${key} is not set`);
      audit(request, 'secret.remove', 'success', key);
      return reply.status(204).send();
    },
  );
}
