import {
  advise,
  AdvisorConflictError,
  applyAutofix,
  loadWorkspace,
  type AdvisorReport,
  type Finding,
} from '@raion/core';
import { collectLiveFacts } from '@raion/deploy';
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

/** A finding as the API returns it: the fix as diffs to review, not whole files. */
function present(f: Finding) {
  const { autofix, ...rest } = f;
  return {
    ...rest,
    autofix: autofix
      ? {
          summary: autofix.summary,
          changes: autofix.changes.map((c) => ({
            path: c.path,
            created: c.before === null,
            diff: c.diff,
          })),
        }
      : null,
  };
}

export function registerAdvisorRoutes(
  app: FastifyInstance,
  runtime: RuntimeService,
  workspaceDir: string,
  { requireRole, audit }: Helpers,
): void {
  /** Findings for the workspace, plus live data from the stack when it is deployed. */
  async function report(request: FastifyRequest): Promise<{
    deployed: boolean;
    report: AdvisorReport;
  }> {
    const result = await loadWorkspace(workspaceDir);
    if (!result.workspace) {
      throw new HttpError(422, 'invalid_workspace', 'the workspace configuration has errors');
    }
    const gateway = await runtime.gateway();
    let facts;
    if (gateway) {
      facts = await collectLiveFacts(gateway, result.workspace);
      if (facts.problems.length > 0) {
        request.log.warn({ problems: facts.problems }, 'advisor: some live data is unavailable');
      }
    }
    return {
      deployed: gateway !== undefined,
      report: advise(result.workspace, result.files, facts ? { facts } : {}),
    };
  }

  app.get('/api/v1/advisor', { preHandler: requireRole('viewer') }, async (request) => {
    const { deployed, report: r } = await report(request);
    return {
      deployed,
      summary: r.summary,
      facts: r.facts
        ? { collectedAt: r.facts.collectedAt, window: r.facts.window, problems: r.facts.problems }
        : null,
      findings: r.findings.map(present),
    };
  });

  // One fix at a time, so two editors cannot interleave writes to the same files.
  let applying: Promise<unknown> = Promise.resolve();

  /**
   * Applies a finding's fix to the workspace files. The client sends only the finding's id:
   * the server recomputes the findings and applies its own fix, so a request cannot smuggle
   * in arbitrary file content. The stack itself changes only with the next plan and apply.
   */
  app.post('/api/v1/advisor/apply', { preHandler: requireRole('editor') }, async (request) => {
    const { id } = z.strictObject({ id: z.string().min(1).max(400) }).parse(request.body);
    const run = applying.then(async () => {
      const { report: r } = await report(request);
      const finding = r.findings.find((f) => f.id === id);
      if (!finding) {
        throw new HttpError(
          409,
          'finding_gone',
          'this finding no longer applies; refresh the list',
        );
      }
      if (!finding.autofix) {
        throw new HttpError(
          400,
          'no_autofix',
          'Raion cannot fix this automatically; follow the recommendation',
        );
      }
      try {
        const files = await applyAutofix(workspaceDir, finding.autofix);
        audit(request, 'advisor.apply', 'success', id, { files });
        return { id, summary: finding.autofix.summary, files };
      } catch (error) {
        if (error instanceof AdvisorConflictError) {
          audit(request, 'advisor.apply', 'failure', id, { reason: error.message });
          throw new HttpError(409, 'conflict', error.message);
        }
        throw error;
      }
    });
    applying = run.catch(() => undefined);
    return run;
  });
}
