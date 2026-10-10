/**
 * Workspace changes from the command line, through the same editing engine as the web UI: the
 * whole workspace is validated with the change before anything is written, files keep their
 * comments, and a file changed meanwhile is never overwritten.
 */
import { join } from 'node:path';
import {
  loadWorkspace,
  planEdit,
  WorkspaceEditError,
  writeEdit,
  type EditAction,
  type NewService,
} from '@raion/core';
import { stateRoot } from '@raion/deploy';
import { Store } from '@raion/server';
import { parse } from 'yaml';
import { EXIT, resolveWorkspaceDir, structured, UsageError, type Output } from './commands.js';
import { actor } from './runtime.js';

type Format = 'text' | 'json';

export interface EditFlags {
  workspace?: string;
  dryRun?: boolean;
  format?: Format;
}

/** "key=value" pairs; values are read as YAML, so numbers, booleans and lists work. */
export function parseAssignments(pairs: string[], unset: string[] = []): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const pair of pairs) {
    const i = pair.indexOf('=');
    if (i <= 0) throw new UsageError(`"${pair}" must look like key=value, e.g. tier=critical`);
    const raw = pair.slice(i + 1);
    set[pair.slice(0, i)] = raw === '' ? '' : (parse(raw) as unknown);
  }
  for (const key of unset) set[key] = null;
  if (Object.keys(set).length === 0)
    throw new UsageError('nothing to change: give key=value pairs');
  return set;
}

/** Plans, shows and (unless --dry-run) writes one change. */
export async function runEdit(
  action: EditAction,
  flags: EditFlags,
  rawIo: Output,
): Promise<number> {
  const { io, emit } = structured(rawIo, flags.format);
  const dir = resolveWorkspaceDir(flags.workspace);
  const { files } = await loadWorkspace(dir);
  try {
    const edit = planEdit(files, action);
    io.out(`${edit.summary}:\n`);
    for (const c of edit.changes) io.out(c.diff.trimEnd());
    for (const w of edit.warnings) io.out(`\n  warning: ${w.message}`);
    if (flags.dryRun) {
      emit({ summary: edit.summary, changes: edit.changes, written: [] });
      io.out('\nNothing was written (--dry-run).');
      return EXIT.OK;
    }
    const written = await writeEdit(dir, edit);
    try {
      const store = new Store(join(stateRoot(dir), 'raion.db'));
      try {
        store.audit({
          actor: actor(),
          action: 'workspace.edit',
          target: null,
          outcome: 'success',
          ip: null,
          details: { change: action.kind, files: written },
        });
      } finally {
        store.close();
      }
    } catch {
      // Auditing never blocks a change made on the machine itself.
    }
    emit({ summary: edit.summary, changes: edit.changes, written });
    io.out(`\n✓ Saved. Run "raion plan" to see what it changes, and "raion apply" to deploy it.`);
    return EXIT.OK;
  } catch (error) {
    if (error instanceof WorkspaceEditError) {
      emit({ ok: false, error: error.message, code: error.code, diagnostics: error.diagnostics });
      io.err(`✗ ${error.message}`);
      return error.code === 'invalid' || error.code === 'unsupported' ? EXIT.INVALID : EXIT.USAGE;
    }
    throw error;
  }
}

// ----- services ------------------------------------------------------------------------------

export async function servicesListCommand(
  opts: { workspace?: string; format: Format },
  io: Output,
): Promise<number> {
  const result = await loadWorkspace(resolveWorkspaceDir(opts.workspace));
  if (!result.workspace) {
    io.err('✗ The workspace has errors; run "raion validate".');
    return EXIT.INVALID;
  }
  const services = result.workspace.services.map((s) => ({
    name: s.name,
    type: s.type,
    language: s.language ?? null,
    team: s.team ?? null,
    tier: s.tier,
    runtime: s.runtime.type,
    slos: s.slos.map((x) => x.name),
    file: s.source.file,
  }));
  if (opts.format === 'json') io.out(JSON.stringify({ services }, null, 2));
  else if (services.length === 0) io.out('No applications yet. Add one with "raion services add".');
  else
    for (const s of services)
      io.out(
        `${s.name.padEnd(24)} ${s.type.padEnd(13)} ${(s.language ?? '').padEnd(8)} ${s.tier.padEnd(12)} ${s.slos.length} goal(s)`,
      );
  return EXIT.OK;
}

export function servicesAddCommand(
  name: string,
  opts: EditFlags & {
    type: string;
    language?: string;
    team?: string;
    tier?: string;
    description?: string;
    runtime?: string;
    composeService?: string;
    containerLogs?: boolean;
    check?: string[];
  },
  io: Output,
): Promise<number> {
  const runtime =
    opts.runtime === 'remote'
      ? { type: 'remote' as const }
      : opts.runtime === 'host'
        ? { type: 'host' as const }
        : {
            type: 'compose' as const,
            ...(opts.composeService ? { composeService: opts.composeService } : {}),
          };
  const service: NewService = {
    name,
    type: opts.type,
    ...(opts.language ? { language: opts.language } : {}),
    ...(opts.team ? { team: opts.team } : {}),
    ...(opts.tier ? { tier: opts.tier as NewService['tier'] } : {}),
    ...(opts.description ? { description: opts.description } : {}),
    runtime,
    ...(opts.containerLogs ? { containerLogs: true } : {}),
    ...(opts.check?.length ? { checks: opts.check.map((url) => ({ url })) } : {}),
  };
  return runEdit({ kind: 'service.add', service }, opts, io);
}

// ----- receivers -----------------------------------------------------------------------------

export function receiverFromFlags(
  name: string,
  opts: {
    type: string;
    webhookSecret?: string;
    channel?: string;
    to?: string[];
    from?: string;
    smarthost?: string;
    username?: string;
    passwordSecret?: string;
    url?: string;
    tokenSecret?: string;
  },
): Record<string, unknown> {
  const secret = (key: string | undefined, flag: string) => {
    if (!key) throw new UsageError(`${flag} is required`);
    return `\${secret:${key}}`;
  };
  switch (opts.type) {
    case 'slack':
      return {
        name,
        type: 'slack',
        webhookUrl: secret(opts.webhookSecret, '--webhook-secret'),
        ...(opts.channel ? { channel: opts.channel } : {}),
      };
    case 'email':
      if (!opts.to?.length || !opts.from || !opts.smarthost)
        throw new UsageError('email needs --to, --from and --smarthost');
      return {
        name,
        type: 'email',
        to: opts.to,
        from: opts.from,
        smarthost: opts.smarthost,
        ...(opts.username ? { username: opts.username } : {}),
        ...(opts.passwordSecret
          ? { password: secret(opts.passwordSecret, '--password-secret') }
          : {}),
      };
    case 'webhook':
      if (!opts.url) throw new UsageError('webhook needs --url');
      return {
        name,
        type: 'webhook',
        url: opts.url,
        ...(opts.tokenSecret ? { bearerToken: secret(opts.tokenSecret, '--token-secret') } : {}),
      };
    default:
      throw new UsageError('--type must be slack, email or webhook');
  }
}

export async function receiversListCommand(
  opts: { workspace?: string; format: Format },
  io: Output,
): Promise<number> {
  const result = await loadWorkspace(resolveWorkspaceDir(opts.workspace));
  if (!result.workspace) {
    io.err('✗ The workspace has errors; run "raion validate".');
    return EXIT.INVALID;
  }
  const receivers = result.workspace.receivers;
  if (opts.format === 'json') io.out(JSON.stringify({ receivers }, null, 2));
  else if (receivers.length === 0)
    io.out('No notification channels. Alerts appear in the Raion inbox only.');
  else for (const r of receivers) io.out(`${r.name.padEnd(24)} ${r.type}`);
  return EXIT.OK;
}

export async function teamsListCommand(
  opts: { workspace?: string; format: Format },
  io: Output,
): Promise<number> {
  const result = await loadWorkspace(resolveWorkspaceDir(opts.workspace));
  if (!result.workspace) {
    io.err('✗ The workspace has errors; run "raion validate".');
    return EXIT.INVALID;
  }
  const teams = result.workspace.teams;
  if (opts.format === 'json') io.out(JSON.stringify({ teams }, null, 2));
  else if (teams.length === 0) io.out('No teams yet.');
  else
    for (const t of teams)
      io.out(`${t.name.padEnd(24)} alerts to: ${t.route ?? 'the Raion inbox'}`);
  return EXIT.OK;
}
