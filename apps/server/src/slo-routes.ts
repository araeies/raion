import { addSlo, loadWorkspace, SloAuthoringError, sloSupported, toOpenSlo } from '@raion/core';
import { fetchSloStatus, type SloStatus } from '@raion/deploy';
import { DNS_LABEL } from '@raion/schema';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from './errors.js';
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

const newSlo = z.strictObject({
  service: z.string().regex(DNS_LABEL),
  name: z.string().regex(DNS_LABEL),
  description: z.string().trim().max(1024).optional(),
  policy: z.string().trim().max(2000).optional(),
  sli: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('availability') }),
    z.strictObject({
      type: z.literal('latency'),
      thresholdMs: z.number().int().positive().max(600_000),
    }),
    z.strictObject({ type: z.literal('throughput'), minRequestsPerSecond: z.number().positive() }),
  ]),
  target: z.number().gt(0).lt(100),
  window: z.enum(['7d', '14d', '28d', '30d', '90d']),
});

export function registerSloRoutes(
  app: FastifyInstance,
  runtime: RuntimeService,
  workspaceDir: string,
  { requireRole, audit }: Helpers,
): void {
  /** Every SLO with its definition, whether it is deployed, and its live status. */
  app.get('/api/v1/slos', { preHandler: requireRole('viewer') }, async (request) => {
    const { service } = z.object({ service: z.string().max(63).optional() }).parse(request.query);
    const ctx = await runtime.context();
    if (!ctx)
      throw new HttpError(422, 'invalid_workspace', 'the workspace configuration has errors');
    const slos = ctx.workspace.services
      .filter((svc) => !service || svc.name === service)
      .flatMap((svc) =>
        svc.slos.map((slo) => ({
          service: svc.name,
          name: slo.name,
          description: slo.description ?? null,
          policy: slo.policy ?? null,
          sli: slo.sli,
          target: slo.target,
          window: slo.window,
          errorBudgetRatio: slo.errorBudgetRatio,
          source: slo.source,
          evaluated: svc.features.slos && svc.signals.metrics && sloSupported(svc, slo),
          reason: !svc.features.slos
            ? `SLOs are evaluated from level 3; ${svc.name} is at level ${svc.level}`
            : !sloSupported(svc, slo)
              ? `no integration of ${svc.name} provides the HTTP metrics this SLI needs`
              : null,
        })),
      );

    let status: SloStatus[] = [];
    const gateway = await runtime.gateway();
    if (gateway) {
      try {
        status = await fetchSloStatus(
          gateway,
          slos.filter((s) => s.evaluated).map((s) => ({ service: s.service, slo: s.name })),
        );
      } catch (error) {
        request.log.warn({ err: error }, 'could not read SLO status');
        status = [];
      }
    }
    return {
      deployed: gateway !== undefined,
      slos: slos.map((s) => ({
        ...s,
        status: status.find((x) => x.service === s.service && x.slo === s.name) ?? null,
      })),
    };
  });

  /** The workspace's SLOs in OpenSLO v1 format. */
  app.get(
    '/api/v1/slos/openslo',
    { preHandler: requireRole('viewer') },
    async (_request, reply) => {
      const ctx = await runtime.context();
      if (!ctx)
        throw new HttpError(422, 'invalid_workspace', 'the workspace configuration has errors');
      return reply.type('application/yaml; charset=utf-8').send(toOpenSlo(ctx.workspace));
    },
  );

  /** Creates an SLO as a new file in slos/; never edits existing files. */
  app.post('/api/v1/slos', { preHandler: requireRole('editor') }, async (request, reply) => {
    const body = newSlo.parse(request.body);
    const result = await loadWorkspace(workspaceDir);
    if (!result.ok)
      throw new HttpError(422, 'invalid_workspace', 'fix the existing configuration errors first');
    try {
      const { file, diagnostics } = await addSlo(workspaceDir, result.files, body);
      audit(request, 'slo.create', 'success', `${body.service}/${body.name}`, {
        file: file.path,
        target: body.target,
      });
      return await reply
        .status(201)
        .send({ file: file.path, content: file.content, warnings: diagnostics });
    } catch (error) {
      if (error instanceof SloAuthoringError) {
        throw new HttpError(400, 'invalid_slo', error.message, { diagnostics: error.diagnostics });
      }
      throw error;
    }
  });
}
