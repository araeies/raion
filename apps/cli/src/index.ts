#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command, InvalidArgumentError, Option } from 'commander';
import { ServerConfigError, startServer } from '@raion/server';
import {
  EXIT,
  UsageError,
  initCommand,
  resolveWorkspaceDir,
  schemaCommand,
  usersAddCommand,
  usersListCommand,
  validateCommand,
  type InitFlags,
  type Output,
} from './commands.js';
import {
  applyCommand,
  connectCommand,
  deepValidateCommand,
  destroyCommand,
  driftCommand,
  planCommand,
  renderCommand,
  rollbackCommand,
  statusCommand,
  verifyCommand,
} from './runtime.js';
import {
  sloAddCommand,
  sloExportCommand,
  sloImportCommand,
  sloListCommand,
  type SloAddFlags,
} from './slo.js';
import {
  alertsCommand,
  secretsListCommand,
  secretsRemoveCommand,
  secretsSetCommand,
} from './alerting.js';
import { adviseCommand, type AdviseFlags } from './advise.js';
import { diffCommand, type DiffFlags } from './diff.js';
import { integrationsListCommand, integrationsLockCommand } from './integrations.js';

const interactive = () => process.stdin.isTTY;

const io: Output = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
};

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  version: string;
};

function port(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535)
    throw new InvalidArgumentError('must be a port number (1-65535)');
  return n;
}

const program = new Command()
  .name('raion')
  .description(
    'Raion: observability as a platform. Describe your services; Raion configures the open-source stack.',
  )
  .version(version);

program
  .command('init')
  .description('create a new workspace (asks a few questions unless --yes is given)')
  .argument('[dir]', 'directory to create', 'observability')
  .option('--name <name>', 'workspace name')
  .option('--level <level>', 'observability level: 1 basic, 2 production, 3 SRE')
  .option('--environment <name>', 'environment name', 'production')
  .option('--service <name>', 'add a first service with this name')
  .option('--type <type>', 'service type: web, api, worker, database, microservice, infrastructure')
  .option('--language <language>', 'service language: nodejs, python, go, java, dotnet, php, other')
  .option('--runtime <runtime>', 'where the service runs: compose or host')
  .option('-y, --yes', 'do not ask questions; use flags and defaults')
  .action(async (dir: string, flags: InitFlags) => {
    process.exitCode = await initCommand(dir, flags, io, process.stdin.isTTY);
  });

program
  .command('validate')
  .description('check the workspace configuration for errors (suitable for CI)')
  .argument('[dir]', 'workspace directory (default: current directory or ./observability)')
  .addOption(
    new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
  )
  .option(
    '--deep',
    'also check generated configuration with each component’s own validator (needs Docker)',
  )
  .action(async (dir: string | undefined, opts: { format: 'text' | 'json'; deep?: boolean }) => {
    process.exitCode = await validateCommand(dir, opts, io);
    if (opts.deep && process.exitCode === EXIT.OK)
      process.exitCode = await deepValidateCommand(dir, io);
  });

program
  .command('render')
  .description('write the generated configuration to a directory, to inspect or use without Raion')
  .argument('[dir]', 'workspace directory')
  .requiredOption('-o, --out <dir>', 'output directory (must be empty or new)')
  .action(async (dir: string | undefined, opts: { out: string }) => {
    process.exitCode = await renderCommand(dir, opts, io);
  });

program
  .command('plan')
  .description('show what "raion apply" would change, without changing anything')
  .argument('[dir]', 'workspace directory')
  .option(
    '--no-tool-validation',
    'skip checking generated files with each component’s own validator',
  )
  .option('--detailed-exitcode', 'exit 3 when changes are pending (for CI drift detection)')
  .action(
    async (
      dir: string | undefined,
      opts: { toolValidation: boolean; detailedExitcode?: boolean },
    ) => {
      process.exitCode = await planCommand(dir, opts, io);
    },
  );

program
  .command('apply')
  .description('deploy or update the observability stack (shows the plan and asks first)')
  .argument('[dir]', 'workspace directory')
  .option('-y, --yes', 'do not ask for confirmation')
  .option('--allow-privileged', 'approve components that need elevated privileges (e.g. cAdvisor)')
  .option('--allow-data-changes', 'approve changes that delete or stop collecting stored data')
  .option('--skip-tool-validation', 'do not run component validators first (not recommended)')
  .action(
    async (
      dir: string | undefined,
      opts: {
        yes?: boolean;
        allowPrivileged?: boolean;
        allowDataChanges?: boolean;
        skipToolValidation?: boolean;
      },
    ) => {
      process.exitCode = await applyCommand(dir, opts, io, interactive());
    },
  );

program
  .command('status')
  .description('show whether every component of the observability stack is running and healthy')
  .argument('[dir]', 'workspace directory')
  .addOption(
    new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
  )
  .action(async (dir: string | undefined, opts: { format: 'text' | 'json' }) => {
    process.exitCode = await statusCommand(dir, opts, io);
  });

program
  .command('verify')
  .description(
    'send test telemetry through the pipeline, or check what one service sends (--service)',
  )
  .argument('[dir]', 'workspace directory')
  .option('-s, --service <name>', 'check one connected service instead of the pipeline')
  .option('--dashboards', 'check that every generated dashboard loads and its panels show data')
  .action(async (dir: string | undefined, opts: { service?: string; dashboards?: boolean }) => {
    process.exitCode = await verifyCommand(dir, opts, io);
  });

program
  .command('connect')
  .description('show how to connect services to the stack and generate a Compose override file')
  .argument('[dir]', 'workspace directory')
  .option('-s, --service <name...>', 'only these services')
  .option('-o, --out <file>', 'write the Compose override file (e.g. observability.override.yaml)')
  .addOption(
    new Option(
      '--format <format>',
      'compose: steps and override file; env or shell: environment variables only',
    )
      .choices(['compose', 'env', 'shell'])
      .default('compose'),
  )
  .action(
    async (
      dir: string | undefined,
      opts: { service?: string[]; out?: string; format: 'compose' | 'env' | 'shell' },
    ) => {
      process.exitCode = await connectCommand(dir, opts, io);
    },
  );

program
  .command('alerts')
  .description('show firing alerts and whether the alerting pipeline works')
  .argument('[dir]', 'workspace directory')
  .addOption(
    new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
  )
  .action(async (dir: string | undefined, opts: { format: 'text' | 'json' }) => {
    process.exitCode = await alertsCommand(dir, opts, io);
  });

const secrets = program
  .command('secrets')
  .description(
    'manage secrets: notification receivers (Slack webhooks, SMTP passwords…) and database monitoring credentials',
  );

secrets
  .command('set')
  .description('store a secret, referenced in raion.yaml as ${secret:NAME} (prompts for the value)')
  .argument('<name>', 'e.g. SLACK_WEBHOOK')
  .option('-w, --workspace <dir>', 'workspace directory')
  .option('--value-stdin', 'read the value from standard input (for scripts)')
  .action(async (name: string, opts: { workspace?: string; valueStdin?: boolean }) => {
    process.exitCode = await secretsSetCommand(name, opts, io);
  });

secrets
  .command('list')
  .description('show which secrets receivers need and whether they are set (never shows values)')
  .option('-w, --workspace <dir>', 'workspace directory')
  .action(async (opts: { workspace?: string }) => {
    process.exitCode = await secretsListCommand(opts, io);
  });

secrets
  .command('remove')
  .description('delete a stored secret')
  .argument('<name>')
  .option('-w, --workspace <dir>', 'workspace directory')
  .action((name: string, opts: { workspace?: string }) => {
    process.exitCode = secretsRemoveCommand(name, opts, io);
  });

const slo = program
  .command('slo')
  .description('service level objectives: list, add, export and import (OpenSLO)');

slo
  .command('list')
  .description('show every SLO with its error budget and status')
  .argument('[dir]', 'workspace directory')
  .addOption(
    new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
  )
  .action(async (dir: string | undefined, opts: { format: 'text' | 'json' }) => {
    process.exitCode = await sloListCommand(dir, opts, io);
  });

slo
  .command('add')
  .description('create an SLO for a service (asks questions when run interactively)')
  .argument('<service>')
  .option('-w, --workspace <dir>', 'workspace directory')
  .option('--name <name>', 'SLO name (default: the SLI type)')
  .option('--type <type>', 'availability, latency or throughput')
  .option('--target <percent>', 'objective in percent, e.g. 99.9')
  .option('--window <days>', 'rolling window: 7d, 14d, 28d, 30d or 90d', '30d')
  .option('--threshold-ms <ms>', 'latency SLOs: requests faster than this are good')
  .option('--min-rps <rate>', 'throughput SLOs: minimum requests per second')
  .option('--description <text>', 'what the SLO protects, in plain words')
  .option('--policy <text>', 'what the team does when the error budget is spent')
  .action(async (service: string, opts: SloAddFlags & { workspace?: string }) => {
    process.exitCode = await sloAddCommand(opts.workspace, service, opts, io, interactive());
  });

slo
  .command('export')
  .description('write the SLOs in OpenSLO v1 format')
  .argument('[dir]', 'workspace directory')
  .option('-o, --out <file>', 'file to write (default: print)')
  .action(async (dir: string | undefined, opts: { out?: string }) => {
    process.exitCode = await sloExportCommand(dir, opts, io);
  });

slo
  .command('import')
  .description(
    'import OpenSLO v1 SLOs (ratio metrics with Prometheus queries) as new files in slos/',
  )
  .argument('<file>', 'OpenSLO YAML file')
  .option('-w, --workspace <dir>', 'workspace directory')
  .option('--service <name>', 'Raion service the SLOs belong to (default: the OpenSLO service)')
  .action(async (file: string, opts: { workspace?: string; service?: string }) => {
    process.exitCode = await sloImportCommand(opts.workspace, file, opts, io);
  });

const integrations = program
  .command('integrations')
  .description("the integrations available to services: built-in and the workspace's own packages");

integrations
  .command('list')
  .description('list the available integrations')
  .argument('[dir]', 'workspace directory')
  .addOption(
    new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
  )
  .action(async (dir: string | undefined, opts: { format: 'text' | 'json' }) => {
    process.exitCode = await integrationsListCommand(dir, opts, io);
  });

integrations
  .command('lock')
  .description(
    'record the checksums of the packages in integrations/ (after reviewing them) in integrations.lock.yaml',
  )
  .argument('[dir]', 'workspace directory')
  .action(async (dir: string | undefined) => {
    process.exitCode = await integrationsLockCommand(dir, io);
  });

program
  .command('advise')
  .description(
    'find observability gaps (missing SLOs, alerts, runbooks, correlation, dropped telemetry)',
  )
  .argument('[dir]', 'workspace directory')
  .addOption(
    new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
  )
  .option('--offline', 'check the configuration only, without querying the running stack')
  .option('--all', 'also show findings ignored in advisor.ignore')
  .addOption(
    new Option(
      '--fail-on <severity>',
      'exit with 1 when a finding this severe exists (for CI)',
    ).choices(['critical', 'warning', 'info']),
  )
  .option('--apply <finding>', 'write the fix Raion offers for a finding to the workspace')
  .option('-y, --yes', 'with --apply: do not ask for confirmation')
  .action(async (dir: string | undefined, opts: AdviseFlags) => {
    process.exitCode = await adviseCommand(dir, opts, io, interactive());
  });

program
  .command('diff')
  .description(
    'compare two versions of a workspace (e.g. a pull request and its base): generated files and components that change',
  )
  .argument('<base>', 'the base workspace directory (e.g. a checkout of the target branch)')
  .argument('[head]', 'the changed workspace directory (default: ./observability)')
  .addOption(
    new Option('--format <format>', 'output format')
      .choices(['text', 'markdown', 'json'])
      .default('text'),
  )
  .option('--files', 'text format: also print the diff of each generated file')
  .option('--advise', 'markdown and json: add the advisor findings of the changed workspace')
  .action(async (base: string, head: string | undefined, opts: DiffFlags) => {
    process.exitCode = await diffCommand(base, head, opts, io);
  });

program
  .command('drift')
  .description(
    'compare the running stack with the deployed release (exit code 3 on drift); --repair restores it',
  )
  .argument('[dir]', 'workspace directory')
  .addOption(
    new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
  )
  .option('--repair', 'restore the deployed release: its files and containers')
  .option('-y, --yes', 'with --repair: do not ask for confirmation')
  .action(
    async (
      dir: string | undefined,
      opts: { format: 'text' | 'json'; repair?: boolean; yes?: boolean },
    ) => {
      process.exitCode = await driftCommand(dir, opts, io, interactive());
    },
  );

program
  .command('rollback')
  .description('redeploy an earlier release')
  .argument('[dir]', 'workspace directory')
  .option('--to <release>', 'release id (default: the one before the current release)')
  .option('-y, --yes', 'do not ask for confirmation')
  .action(async (dir: string | undefined, opts: { to?: string; yes?: boolean }) => {
    process.exitCode = await rollbackCommand(dir, opts, io, interactive());
  });

program
  .command('destroy')
  .description('stop the observability stack (keeps stored data unless --delete-data)')
  .argument('[dir]', 'workspace directory')
  .option('--delete-data', 'also delete all stored metrics, logs, traces and Grafana data')
  .option('-y, --yes', 'do not ask for confirmation')
  .action(async (dir: string | undefined, opts: { deleteData?: boolean; yes?: boolean }) => {
    process.exitCode = await destroyCommand(dir, opts, io, interactive());
  });

program
  .command('schema')
  .description('print the JSON Schema for Raion configuration files (for editors and CI)')
  .action(() => {
    process.exitCode = schemaCommand(io);
  });

program
  .command('server')
  .description('start the Raion server (API and web UI)')
  .option('-w, --workspace <dir>', 'workspace directory')
  .option('--host <address>', 'address to listen on', '127.0.0.1')
  .option('--port <port>', 'port to listen on', port, 7600)
  .option('--public-url <url>', 'URL users open (required when not listening on loopback)')
  .option('--tls-cert <file>', 'TLS certificate (PEM)')
  .option('--tls-key <file>', 'TLS private key (PEM)')
  .option('--trust-proxy', 'Raion is behind a TLS-terminating reverse proxy', false)
  .action(
    async (opts: {
      workspace?: string;
      host: string;
      port: number;
      publicUrl?: string;
      tlsCert?: string;
      tlsKey?: string;
      trustProxy: boolean;
    }) => {
      if (Boolean(opts.tlsCert) !== Boolean(opts.tlsKey)) {
        throw new UsageError('--tls-cert and --tls-key must be given together');
      }
      const server = await startServer({
        workspaceDir: resolveWorkspaceDir(opts.workspace),
        host: opts.host,
        port: opts.port,
        trustProxy: opts.trustProxy,
        ...(opts.publicUrl ? { publicUrl: opts.publicUrl } : {}),
        ...(opts.tlsCert && opts.tlsKey
          ? { tls: { certFile: opts.tlsCert, keyFile: opts.tlsKey } }
          : {}),
      });
      io.err(`Raion server listening on ${server.url}`);
      const shutdown = () => {
        void server.close().then(() => process.exit(0));
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    },
  );

const users = program.command('users').description('manage Raion user accounts');

users
  .command('add')
  .description('create a user (prompts for the password)')
  .argument('<username>')
  .addOption(
    new Option('--role <role>', 'role').choices(['viewer', 'editor', 'admin']).default('viewer'),
  )
  .option('-w, --workspace <dir>', 'workspace directory')
  .option('--password-stdin', 'read the password from standard input (for scripts)')
  .action(
    async (
      username: string,
      opts: { role: string; workspace?: string; passwordStdin?: boolean },
    ) => {
      process.exitCode = await usersAddCommand(username, opts, io);
    },
  );

users
  .command('list')
  .description('list users')
  .option('-w, --workspace <dir>', 'workspace directory')
  .action((opts: { workspace?: string }) => {
    process.exitCode = usersListCommand(opts, io);
  });

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof UsageError || error instanceof ServerConfigError) {
    io.err(`error: ${error.message}`);
    process.exitCode = EXIT.USAGE;
  } else {
    io.err(`unexpected error: ${(error as Error).stack ?? String(error)}`);
    process.exitCode = 70;
  }
}
