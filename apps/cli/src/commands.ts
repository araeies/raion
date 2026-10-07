import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  formatDiagnostic,
  loadWorkspace,
  renderWorkspace,
  ServiceRegistry,
  WORKSPACE_FILE,
  WorkspaceExistsError,
  writeWorkspace,
  type InitOptions,
} from '@raion/core';
import { stateRoot } from '@raion/deploy';
import { DNS_LABEL, LANGUAGES, SERVICE_TYPES, toJsonSchema, type Level } from '@raion/schema';
import { AuthService, passwordProblem, ROLES, Store, USERNAME, type Role } from '@raion/server';
import { ask, askHidden, choose, readStdin } from './prompt.js';

export const EXIT = { OK: 0, INVALID: 1, USAGE: 2 } as const;

export class UsageError extends Error {}

export interface Output {
  out: (text: string) => void;
  err: (text: string) => void;
}

const DEFAULT_WORKSPACE_DIR = 'observability';

/** Uses `dir` if given; otherwise the current directory if it has raion.yaml, else ./observability. */
export function resolveWorkspaceDir(dir: string | undefined): string {
  if (dir) return resolve(dir);
  if (existsSync(WORKSPACE_FILE)) return resolve('.');
  return resolve(DEFAULT_WORKSPACE_DIR);
}

// ----- validate ------------------------------------------------------------------------

export async function validateCommand(
  dir: string | undefined,
  opts: { format: 'text' | 'json'; deep?: boolean },
  io: Output,
): Promise<number> {
  const workspaceDir = resolveWorkspaceDir(dir);
  const result = await loadWorkspace(workspaceDir);

  if (opts.format === 'json') {
    io.out(
      JSON.stringify({ valid: result.ok, workspaceDir, diagnostics: result.diagnostics }, null, 2),
    );
    return result.ok ? EXIT.OK : EXIT.INVALID;
  }

  for (const d of result.diagnostics) io.err(formatDiagnostic(d));
  const errors = result.diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = result.diagnostics.length - errors;

  if (!result.ok) {
    io.err(`\n✗ ${workspaceDir}: ${errors} error(s), ${warnings} warning(s)`);
    return EXIT.INVALID;
  }
  const ws = result.workspace!;
  const sloCount = ws.services.reduce((n, s) => n + s.slos.length, 0);
  io.out(
    `✓ ${workspaceDir} is valid: workspace "${ws.name}", level ${ws.level}, ` +
      `${ws.services.length} service(s), ${sloCount} SLO(s)${warnings ? `, ${warnings} warning(s)` : ''}`,
  );
  const cycles = new ServiceRegistry(ws).cycles();
  for (const cycle of cycles)
    io.out(`  note: dependency cycle ${[...cycle, cycle[0]].join(' → ')}`);
  return EXIT.OK;
}

// ----- init ----------------------------------------------------------------------------

export interface InitFlags {
  name?: string;
  level?: string;
  environment?: string;
  service?: string;
  type?: string;
  language?: string;
  runtime?: string;
  yes?: boolean;
}

export async function initCommand(
  dir: string | undefined,
  flags: InitFlags,
  io: Output,
  interactive: boolean,
): Promise<number> {
  const workspaceDir = resolve(dir ?? DEFAULT_WORKSPACE_DIR);
  if (existsSync(join(workspaceDir, WORKSPACE_FILE))) {
    io.err(`${join(workspaceDir, WORKSPACE_FILE)} already exists. Nothing was changed.`);
    return EXIT.USAGE;
  }
  const options = interactive && !flags.yes ? await askInitQuestions(flags) : initFromFlags(flags);
  const files = renderWorkspace(options);
  try {
    const written = await writeWorkspace(workspaceDir, files);
    io.out(`Created a Raion workspace in ${workspaceDir}:`);
    for (const path of written) io.out(`  ${path}`);
    io.out(
      `\nNext steps:\n  raion validate ${dir ?? DEFAULT_WORKSPACE_DIR}   # check the configuration`,
    );
    io.out(
      '  git add . && git commit        # keep your observability configuration in version control',
    );
    return EXIT.OK;
  } catch (error) {
    if (error instanceof WorkspaceExistsError) {
      io.err(`${error.message}. Nothing was changed.`);
      return EXIT.USAGE;
    }
    throw error;
  }
}

function parseLevel(value: string | undefined): Level {
  const level = Number(value ?? 1);
  if (level !== 1 && level !== 2 && level !== 3) throw new UsageError('--level must be 1, 2 or 3');
  return level;
}

function checkName(value: string, flag: string): string {
  if (!DNS_LABEL.test(value)) {
    throw new UsageError(
      `${flag} must be lowercase letters, digits and hyphens, starting with a letter (e.g. "payment-api")`,
    );
  }
  return value;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], flag: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new UsageError(`${flag} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

export function initFromFlags(flags: InitFlags): InitOptions {
  const options: InitOptions = {
    name: checkName(flags.name ?? 'my-observability', '--name'),
    level: parseLevel(flags.level),
    environment: checkName(flags.environment ?? 'production', '--environment'),
  };
  if (flags.service) {
    options.service = {
      name: checkName(flags.service, '--service'),
      type: oneOf(flags.type ?? 'api', SERVICE_TYPES, '--type'),
      ...(flags.language ? { language: oneOf(flags.language, LANGUAGES, '--language') } : {}),
      runtime: oneOf(flags.runtime ?? 'compose', ['compose', 'host'] as const, '--runtime'),
    };
  }
  return options;
}

async function askInitQuestions(flags: InitFlags): Promise<InitOptions> {
  const nameProblem = (v: string) =>
    DNS_LABEL.test(v)
      ? undefined
      : 'Use lowercase letters, digits and hyphens, starting with a letter.';
  process.stdout.write(
    'Welcome to Raion. A few questions, then we will create your observability workspace.\n',
  );
  process.stdout.write(
    'Nothing is deployed yet; you can review and change everything afterwards.\n',
  );

  const name = await ask(
    'Name for this workspace (usually your team or product):',
    flags.name ?? 'my-observability',
    nameProblem,
  );
  const type = await choose(
    'What are you monitoring?',
    [
      { value: 'web', label: 'Web application' },
      { value: 'api', label: 'API' },
      { value: 'worker', label: 'Background worker' },
      { value: 'database', label: 'Database' },
      { value: 'microservice', label: 'Microservice' },
      { value: 'infrastructure', label: 'Infrastructure only' },
    ],
    'api',
  );
  let service: InitOptions['service'];
  if (type !== 'infrastructure') {
    const serviceName = await ask(
      'Name of the service:',
      flags.service ?? 'my-service',
      nameProblem,
    );
    const runtime = await choose(
      'Where does it run?',
      [
        { value: 'compose', label: 'Docker Compose' },
        { value: 'host', label: 'Directly on this machine (VM or bare metal)' },
      ],
      'compose',
    );
    const language = await choose(
      'What language is it written in?',
      [
        { value: 'nodejs', label: 'Node.js' },
        { value: 'python', label: 'Python' },
        { value: 'go', label: 'Go' },
        { value: 'java', label: 'Java' },
        { value: 'dotnet', label: '.NET' },
        { value: 'php', label: 'PHP' },
        { value: 'other', label: 'Other' },
      ],
      'nodejs',
    );
    service = { name: serviceName, type, language, runtime };
  }
  const level = await choose(
    'How much do you want to set up?',
    [
      {
        value: '1',
        label:
          'Basic: logs, resource usage, request/error/latency metrics, basic alerts and dashboards',
      },
      {
        value: '2',
        label: 'Production: adds tracing, log/trace correlation, dependency map, golden signals',
      },
      { value: '3', label: 'SRE: adds SLOs, error budgets and burn-rate alerts' },
    ],
    '1',
  );
  return {
    name,
    level: parseLevel(level),
    environment: flags.environment ?? 'production',
    ...(service ? { service } : {}),
  };
}

// ----- schema --------------------------------------------------------------------------

export function schemaCommand(io: Output): number {
  io.out(JSON.stringify(toJsonSchema(), null, 2));
  return EXIT.OK;
}

// ----- users ---------------------------------------------------------------------------

function openStore(dir: string | undefined): Store {
  const workspaceDir = resolveWorkspaceDir(dir);
  if (!existsSync(join(workspaceDir, WORKSPACE_FILE))) {
    throw new UsageError(
      `no ${WORKSPACE_FILE} in ${workspaceDir}; pass --workspace or run "raion init"`,
    );
  }
  return new Store(join(stateRoot(workspaceDir), 'raion.db'));
}

export async function usersAddCommand(
  username: string,
  opts: { role: string; workspace?: string; passwordStdin?: boolean },
  io: Output,
): Promise<number> {
  const name = username.trim().toLowerCase();
  if (!USERNAME.test(name))
    throw new UsageError('username must be 2-64 characters: a-z, 0-9, ".", "_" or "-"');
  const role: Role = oneOf(opts.role, ROLES, '--role');
  const store = openStore(opts.workspace);
  try {
    if (store.findUser(name)) throw new UsageError(`user "${name}" already exists`);
    let password: string;
    if (opts.passwordStdin) {
      password = await readStdin();
    } else {
      password = await askHidden(`Password for ${name}: `);
      if ((await askHidden('Repeat password: ')) !== password)
        throw new UsageError('passwords do not match');
    }
    const problem = passwordProblem(password, name);
    if (problem) throw new UsageError(problem);
    const user = await new AuthService(store).createUser(name, password, role);
    store.audit({
      actor: 'cli',
      action: 'user.create',
      target: user.username,
      outcome: 'success',
      ip: null,
      details: { role },
    });
    io.out(`Created ${role} "${user.username}".`);
    return EXIT.OK;
  } finally {
    store.close();
  }
}

export function usersListCommand(opts: { workspace?: string }, io: Output): number {
  const store = openStore(opts.workspace);
  try {
    const users = store.listUsers();
    if (users.length === 0) io.out('No users yet. Start "raion server" to create the first admin.');
    for (const u of users)
      io.out(`${u.username.padEnd(24)} ${u.role.padEnd(8)} ${u.disabled ? 'disabled' : 'active'}`);
    return EXIT.OK;
  } finally {
    store.close();
  }
}
