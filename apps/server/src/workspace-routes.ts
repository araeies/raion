import {
  loadWorkspace,
  planEdit,
  WorkspaceEditError,
  writeEdit,
  type EditAction,
  type WorkspaceEdit,
} from '@raion/core';
import { DNS_LABEL } from '@raion/schema';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from './errors.js';
import type { RuntimeService } from './runtime.js';
import { roleAtLeast, type Role } from './store.js';

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

const nameField = z.string().regex(DNS_LABEL, 'use lowercase letters, digits and hyphens');
const object = z.record(z.string().max(64), z.unknown());

/** The edits the API accepts. Values are validated again by the workspace schema. */
export const editAction = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('service.add'),
    service: z.object({ name: nameField, type: z.string().max(32) }).catchall(z.unknown()),
  }),
  z.strictObject({ kind: z.literal('service.update'), name: nameField, set: object }),
  z.strictObject({ kind: z.literal('service.remove'), name: nameField }),
  z.strictObject({
    kind: z.literal('slo.add'),
    slo: z
      .object({
        service: nameField,
        name: nameField,
        target: z.number(),
        window: z.string().max(8),
      })
      .catchall(z.unknown()),
  }),
  z.strictObject({
    kind: z.literal('slo.update'),
    service: nameField,
    name: nameField,
    set: object,
  }),
  z.strictObject({ kind: z.literal('slo.remove'), service: nameField, name: nameField }),
  z.strictObject({ kind: z.literal('workspace.update'), set: object }),
  z.strictObject({ kind: z.literal('receiver.add'), receiver: object }),
  z.strictObject({ kind: z.literal('receiver.update'), name: nameField, receiver: object }),
  z.strictObject({ kind: z.literal('receiver.remove'), name: nameField }),
  z.strictObject({
    kind: z.literal('team.add'),
    team: z.object({ name: nameField }).catchall(z.unknown()),
  }),
  z.strictObject({ kind: z.literal('team.update'), name: nameField, set: object }),
  z.strictObject({ kind: z.literal('team.remove'), name: nameField }),
]);

/**
 * Who may make each kind of change. Applications and reliability goals are everyday work
 * (editors); workspace-wide settings, teams and where alerts are sent affect everyone (admins).
 */
export function roleForEdit(kind: EditAction['kind']): Role {
  return kind.startsWith('service.') || kind.startsWith('slo.') ? 'editor' : 'admin';
}

export function auditTarget(action: EditAction): string {
  switch (action.kind) {
    case 'service.add':
      return action.service.name;
    case 'slo.add':
      return `${action.slo.service}/${action.slo.name}`;
    case 'slo.update':
    case 'slo.remove':
      return `${action.service}/${action.name}`;
    case 'workspace.update':
      return Object.keys(action.set).join(',');
    case 'receiver.add':
      return String(action.receiver.name);
    case 'team.add':
      return action.team.name;
    default:
      return action.name;
  }
}

/** Changes to workspace files from the web UI, through the same engine as the CLI. */
export function registerWorkspaceRoutes(
  app: FastifyInstance,
  runtime: RuntimeService,
  workspaceDir: string,
  { requireRole, audit }: Helpers,
): void {
  const plan = async (
    request: FastifyRequest,
  ): Promise<{ action: EditAction; edit: WorkspaceEdit }> => {
    const action = editAction.parse(
      (request.body as { action?: unknown } | undefined)?.action,
    ) as EditAction;
    const needed = roleForEdit(action.kind);
    if (!roleAtLeast(request.user!.role, needed)) {
      throw new HttpError(403, 'forbidden', `this change needs the ${needed} role`);
    }
    const result = await loadWorkspace(workspaceDir);
    if (!result.files.length)
      throw new HttpError(409, 'no_workspace', 'the workspace has no files');
    try {
      return { action, edit: planEdit(result.files, action) };
    } catch (error) {
      if (error instanceof WorkspaceEditError) {
        const status = {
          not_found: 404,
          exists: 409,
          conflict: 409,
          invalid: 400,
          unsupported: 400,
        }[error.code];
        throw new HttpError(status, `edit_${error.code}`, error.message, {
          diagnostics: error.diagnostics,
        });
      }
      throw error;
    }
  };

  const view = (edit: WorkspaceEdit) => ({
    summary: edit.summary,
    changes: edit.changes.map((c) => ({
      path: c.path,
      kind: c.before === null ? 'add' : c.after === null ? 'remove' : 'modify',
      diff: c.diff,
    })),
    warnings: edit.warnings,
  });

  /** What a change would do to the workspace files, without writing anything. */
  app.post(
    '/api/v1/workspace/edits/preview',
    { preHandler: requireRole('editor') },
    async (request) => view((await plan(request)).edit),
  );

  /** Makes a change. It takes effect on the stack at the next deployment. */
  app.post(
    '/api/v1/workspace/edits',
    { preHandler: requireRole('editor') },
    async (request, reply) => {
      const { action, edit } = await plan(request);
      try {
        const files = await writeEdit(workspaceDir, edit);
        audit(request, 'workspace.edit', 'success', auditTarget(action), {
          change: action.kind,
          files,
        });
        runtime.invalidate();
        return await reply.status(201).send({ ...view(edit), written: files });
      } catch (error) {
        if (error instanceof WorkspaceEditError) {
          audit(request, 'workspace.edit', 'failure', auditTarget(action), {
            change: action.kind,
            error: error.message,
          });
          throw new HttpError(409, `edit_${error.code}`, error.message);
        }
        throw error;
      }
    },
  );
}
