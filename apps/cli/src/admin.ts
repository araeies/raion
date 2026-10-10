/**
 * Administration commands with the same behaviour as the web UI: they call the same account,
 * token, audit, alert and operation functions as the Raion server. The CLI runs on the machine
 * that holds the workspace, with access to its state, so it acts as a local administrator; every
 * change is audited as "cli:<operating-system user>".
 */
import { join } from 'node:path';
import { formatDiagnostic, loadWorkspace } from '@raion/core';
import {
  createSilence,
  deleteSilence,
  DockerComposeTarget,
  listSilences,
  OperationJournal,
  StatePaths,
  stateRoot,
  type OperationRecord,
} from '@raion/deploy';
import {
  AccountError,
  Accounts,
  AuthService,
  ROLES,
  Store,
  TokenError,
  USERNAME,
  type Role,
} from '@raion/server';
import { EXIT, resolveWorkspaceDir, UsageError, type Output } from './commands.js';
import { askHidden, readStdin } from './prompt.js';
import { actor } from './runtime.js';

type Format = 'text' | 'json';

function openStore(dirArg: string | undefined): { store: Store; dir: string } {
  const dir = resolveWorkspaceDir(dirArg);
  return { store: new Store(join(stateRoot(dir), 'raion.db')), dir };
}

function role(value: string): Role {
  if (!(ROLES as readonly string[]).includes(value))
    throw new UsageError(`role must be one of: ${ROLES.join(', ')}`);
  return value as Role;
}

function username(value: string): string {
  const name = value.trim().toLowerCase();
  if (!USERNAME.test(name))
    throw new UsageError('username must be 2-64 characters: a-z, 0-9, ".", "_" or "-"');
  return name;
}

async function readPassword(stdin: boolean | undefined, who: string): Promise<string> {
  if (stdin) return readStdin();
  const password = await askHidden(`Password for ${who}: `);
  if ((await askHidden('Repeat password: ')) !== password)
    throw new UsageError('passwords do not match');
  return password;
}

/** Runs an account change, turning refusals into the same messages the web UI shows. */
async function withAccounts(
  dirArg: string | undefined,
  io: Output,
  work: (accounts: Accounts, store: Store) => Promise<string>,
): Promise<number> {
  const { store } = openStore(dirArg);
  try {
    io.out(await work(new Accounts(store, new AuthService(store)), store));
    return EXIT.OK;
  } catch (error) {
    if (error instanceof AccountError) {
      io.err(`✗ ${error.message}`);
      return error.status === 404 ? EXIT.INVALID : EXIT.USAGE;
    }
    throw error;
  } finally {
    store.close();
  }
}

const audited = (
  store: Store,
  action: string,
  target: string | null,
  details: Record<string, unknown> | null,
) => store.audit({ actor: actor(), action, target, outcome: 'success', ip: null, details });

// ----- users -----------------------------------------------------------------------------------

export function usersAddCommand(
  name: string,
  opts: { role: string; workspace?: string; passwordStdin?: boolean },
  io: Output,
): Promise<number> {
  const user = username(name);
  const r = role(opts.role);
  return withAccounts(opts.workspace, io, async (accounts, store) => {
    const password = await readPassword(opts.passwordStdin, user);
    const created = await accounts.create(user, password, r);
    audited(store, 'user.create', created.username, { role: r });
    return `Created ${r} "${created.username}".`;
  });
}

export function usersListCommand(opts: { workspace?: string; format: Format }, io: Output): number {
  const { store } = openStore(opts.workspace);
  try {
    const users = store.listUsers();
    if (opts.format === 'json') {
      io.out(JSON.stringify({ users }, null, 2));
      return EXIT.OK;
    }
    if (users.length === 0) io.out('No users yet. Start "raion server" to create the first admin.');
    for (const u of users)
      io.out(
        `${u.username.padEnd(24)} ${u.role.padEnd(8)} ${u.disabled ? 'disabled' : 'active'}${u.sso ? '  (single sign-on)' : ''}`,
      );
    return EXIT.OK;
  } finally {
    store.close();
  }
}

export function usersUpdateCommand(
  name: string,
  change: { role?: string; disabled?: boolean; resetPassword?: boolean; passwordStdin?: boolean },
  opts: { workspace?: string },
  io: Output,
): Promise<number> {
  const user = username(name);
  return withAccounts(opts.workspace, io, async (accounts, store) => {
    const password = change.resetPassword
      ? await readPassword(change.passwordStdin, user)
      : undefined;
    const { details } = await accounts.update(user, {
      ...(change.role ? { role: role(change.role) } : {}),
      ...(change.disabled !== undefined ? { disabled: change.disabled } : {}),
      ...(password !== undefined ? { password } : {}),
    });
    audited(store, 'user.update', user, details);
    if (change.role) return `${user} is now ${change.role}. They were signed out everywhere.`;
    if (change.disabled === true) return `${user} is disabled and was signed out everywhere.`;
    if (change.disabled === false) return `${user} can sign in again.`;
    return `${user}'s password was reset and they were signed out. Share it with them privately.`;
  });
}

// ----- API tokens ------------------------------------------------------------------------------

export function tokensListCommand(
  opts: { workspace?: string; format: Format; all?: boolean },
  io: Output,
): number {
  const { store } = openStore(opts.workspace);
  try {
    const now = Date.now();
    const tokens = store
      .listApiTokens()
      .filter((t) => opts.all || (!t.revokedAt && Date.parse(t.expiresAt) > now));
    if (opts.format === 'json') {
      io.out(JSON.stringify({ tokens }, null, 2));
      return EXIT.OK;
    }
    if (tokens.length === 0) io.out('No active API tokens.');
    for (const t of tokens) {
      const state = t.revokedAt
        ? 'revoked'
        : Date.parse(t.expiresAt) <= now
          ? 'expired'
          : `expires ${t.expiresAt.slice(0, 10)}`;
      io.out(`${t.id}  ${t.username.padEnd(16)} ${t.name.padEnd(20)} ${t.role.padEnd(7)} ${state}`);
    }
    return EXIT.OK;
  } finally {
    store.close();
  }
}

export function tokensCreateCommand(
  opts: { workspace?: string; user: string; name: string; role: string; days: string },
  io: Output,
): Promise<number> {
  const user = username(opts.user);
  return withAccounts(opts.workspace, io, async (_accounts, store) => {
    const owner = store.findUser(user);
    if (!owner) throw new AccountError(404, 'not_found', `user "${user}" not found`);
    const days = Number(opts.days);
    try {
      const { token, record } = new AuthService(store).createApiToken(owner, {
        name: opts.name,
        role: role(opts.role),
        expiresInDays: days,
      });
      audited(store, 'token.create', record.name, { owner: user, role: record.role });
      return `${token}\n\nThis is ${user}'s new API token "${record.name}" (${record.role}, expires ${record.expiresAt.slice(0, 10)}).\nCopy it now: it is shown only once.`;
    } catch (error) {
      if (error instanceof TokenError) throw new AccountError(400, 'invalid_token', error.message);
      throw error;
    }
  });
}

export function tokensRevokeCommand(
  id: string,
  opts: { workspace?: string },
  io: Output,
): Promise<number> {
  return withAccounts(opts.workspace, io, async (_accounts, store) => {
    const token = store.getApiToken(id);
    if (!token) throw new AccountError(404, 'not_found', `no API token with id "${id}"`);
    store.revokeApiToken(id);
    audited(store, 'token.revoke', token.name, { owner: token.username });
    return `Revoked "${token.name}" of ${token.username}.`;
  });
}

// ----- audit log -------------------------------------------------------------------------------

export function auditCommand(
  opts: { workspace?: string; format: Format; actor?: string; action?: string; limit: string },
  io: Output,
): number {
  const limit = Number(opts.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new UsageError('--limit must be between 1 and 1000');
  const { store } = openStore(opts.workspace);
  try {
    const entries = store.listAudit(limit, undefined, {
      ...(opts.actor ? { actor: opts.actor } : {}),
      ...(opts.action ? { action: opts.action } : {}),
    });
    if (opts.format === 'json') {
      io.out(JSON.stringify({ entries }, null, 2));
      return EXIT.OK;
    }
    if (entries.length === 0) io.out('No matching entries.');
    for (const e of entries) {
      io.out(
        `${e.ts.slice(0, 19).replace('T', ' ')}  ${(e.actor ?? '-').padEnd(18)} ${e.outcome === 'success' ? '✓' : '✗'} ${e.action}${e.target ? ` ${e.target}` : ''}${e.details ? `  ${JSON.stringify(e.details)}` : ''}`,
      );
    }
    return EXIT.OK;
  } finally {
    store.close();
  }
}

// ----- operations ------------------------------------------------------------------------------

function describeOperation(r: OperationRecord): string {
  const where = r.via === 'cli' ? 'command line' : r.via === 'api' ? 'API' : 'web UI';
  const mark = { running: '…', succeeded: '✓', failed: '✗', interrupted: '!' }[r.state];
  return `${mark} ${r.id}  ${r.kind.padEnd(8)} ${r.state.padEnd(11)} by ${r.actor} (${where})${r.error ? `: ${r.error}` : ''}`;
}

/** raion activity: deployments, verifications and repairs from every interface. */
export function activityCommand(
  id: string | undefined,
  opts: { workspace?: string; format: Format; limit: string },
  io: Output,
): number {
  const journal = new OperationJournal(new StatePaths(resolveWorkspaceDir(opts.workspace)));
  if (id) {
    const record = journal.get(id);
    if (!record) {
      io.err(`✗ no operation with id "${id}"; "raion activity" lists them`);
      return EXIT.INVALID;
    }
    if (opts.format === 'json') io.out(JSON.stringify(record, null, 2));
    else {
      io.out(describeOperation(record));
      io.out(
        `  started ${record.startedAt}${record.finishedAt ? `, finished ${record.finishedAt}` : ''}`,
      );
      for (const line of record.log) io.out(`  ${line}`);
    }
    return EXIT.OK;
  }
  const list = journal.list(Number(opts.limit) || 20);
  if (opts.format === 'json') {
    io.out(JSON.stringify({ operations: list.map(({ log: _log, ...r }) => r) }, null, 2));
    return EXIT.OK;
  }
  if (list.length === 0) io.out('Nothing has been run yet.');
  for (const r of list) io.out(describeOperation(r));
  return EXIT.OK;
}

// ----- silences --------------------------------------------------------------------------------

async function gatewayFor(dirArg: string | undefined, io: Output) {
  const dir = resolveWorkspaceDir(dirArg);
  const result = await loadWorkspace(dir);
  for (const d of result.diagnostics.filter((x) => x.severity === 'error'))
    io.err(formatDiagnostic(d));
  if (!result.workspace) return undefined;
  const target = new DockerComposeTarget(dir, result.workspace);
  if (!target.releases.currentId()) {
    io.err('Nothing is deployed yet. Run "raion apply" first.');
    return undefined;
  }
  return { gateway: target.gateway(), dir };
}

const DURATION = /^(\d+)(m|h|d)$/;

export async function silenceCommand(
  alertname: string,
  opts: { workspace?: string; service?: string; for: string; reason?: string },
  io: Output,
): Promise<number> {
  const match = DURATION.exec(opts.for);
  if (!match) throw new UsageError('--for must look like 30m, 4h or 2d');
  const minutes = Number(match[1]) * { m: 1, h: 60, d: 1440 }[match[2] as 'm' | 'h' | 'd'];
  if (minutes < 5 || minutes > 7 * 1440)
    throw new UsageError('--for must be between 5 minutes and 7 days');
  if (!opts.reason?.trim()) throw new UsageError('--reason is required: everyone sees why');
  const ctx = await gatewayFor(opts.workspace, io);
  if (!ctx) return EXIT.INVALID;
  const id = await createSilence(ctx.gateway, {
    matchers: { alertname, ...(opts.service ? { service_name: opts.service } : {}) },
    minutes,
    createdBy: actor(),
    comment: opts.reason.trim(),
  });
  const { store } = openStore(opts.workspace);
  try {
    // Recorded exactly as the web UI records it.
    audited(store, 'alert.silence', id, {
      alertname,
      ...(opts.service ? { service_name: opts.service } : {}),
      minutes,
    });
  } finally {
    store.close();
  }
  io.out(
    `✓ Silenced ${alertname}${opts.service ? ` for ${opts.service}` : ''} for ${opts.for} (id ${id}).`,
  );
  return EXIT.OK;
}

export async function silencesCommand(
  opts: { workspace?: string; format: Format },
  io: Output,
): Promise<number> {
  const ctx = await gatewayFor(opts.workspace, io);
  if (!ctx) return EXIT.INVALID;
  const silences = await listSilences(ctx.gateway);
  if (opts.format === 'json') {
    io.out(JSON.stringify({ silences }, null, 2));
    return EXIT.OK;
  }
  if (silences.length === 0) io.out('No active silences.');
  for (const s of silences)
    io.out(
      `${s.id}  ${s.matchers.map((m) => `${m.name}=${m.value}`).join(',')}  until ${s.endsAt}  by ${s.createdBy}: ${s.comment}`,
    );
  return EXIT.OK;
}

export async function unsilenceCommand(
  id: string,
  opts: { workspace?: string },
  io: Output,
): Promise<number> {
  const ctx = await gatewayFor(opts.workspace, io);
  if (!ctx) return EXIT.INVALID;
  await deleteSilence(ctx.gateway, id);
  const { store } = openStore(opts.workspace);
  try {
    audited(store, 'alert.unsilence', id, null);
  } finally {
    store.close();
  }
  io.out(`✓ Silence ${id} ended.`);
  return EXIT.OK;
}
