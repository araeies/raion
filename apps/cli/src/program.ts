import { readFileSync } from 'node:fs';
import { Argument, Command, InvalidArgumentError, Option } from 'commander';
import { startServer } from '@raion/server';
import {
  EXIT,
  UsageError,
  initCommand,
  resolveWorkspaceDir,
  schemaCommand,
  validateCommand,
  type InitFlags,
  type Output,
} from './commands.js';
import {
  applyCommand,
  connectCommand,
  connectRestartCommand,
  discoverCommand,
  historyCommand,
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
import {
  activityCommand,
  auditCommand,
  silenceCommand,
  silencesCommand,
  tokensCreateCommand,
  tokensListCommand,
  tokensRevokeCommand,
  unsilenceCommand,
  usersAddCommand,
  usersListCommand,
  usersUpdateCommand,
} from './admin.js';
import { adviseCommand, type AdviseFlags } from './advise.js';
import {
  parseAssignments,
  receiverFromFlags,
  receiversListCommand,
  runEdit,
  servicesAddCommand,
  servicesListCommand,
  teamsListCommand,
  type EditFlags,
} from './edit.js';
import { diffCommand, type DiffFlags } from './diff.js';
import { integrationsListCommand, integrationsLockCommand } from './integrations.js';

const interactive = () => process.stdin.isTTY;

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

/** The raion command tree. The web server exposes the same capabilities (see docs/reference/ui-and-cli.md). */
export function createProgram(io: Output): Command {
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
    .option(
      '--type <type>',
      'service type: web, api, worker, database, microservice, infrastructure',
    )
    .option(
      '--language <language>',
      'service language: nodejs, python, go, java, dotnet, php, other',
    )
    .option('--runtime <runtime>', 'where the service runs: compose or host')
    .option('-y, --yes', 'do not ask questions; use flags and defaults')
    .addOption(
      new Option(
        '--format <format>',
        'output format: json prints one JSON document to standard output, progress to standard error',
      )
        .choices(['text', 'json'])
        .default('text'),
    )
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
    .description(
      'write the generated configuration to a directory, to inspect or use without Raion',
    )
    .argument('[dir]', 'workspace directory')
    .requiredOption('-o, --out <dir>', 'output directory (must be empty or new)')
    .addOption(
      new Option(
        '--format <format>',
        'output format: json prints one JSON document to standard output, progress to standard error',
      )
        .choices(['text', 'json'])
        .default('text'),
    )
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
    .addOption(
      new Option(
        '--format <format>',
        'output format: json prints one JSON document to standard output, progress to standard error',
      )
        .choices(['text', 'json'])
        .default('text'),
    )
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
    .option(
      '--allow-privileged',
      'approve components that need elevated privileges (e.g. cAdvisor)',
    )
    .option('--allow-data-changes', 'approve changes that delete or stop collecting stored data')
    .option('--skip-tool-validation', 'do not run component validators first (not recommended)')
    .addOption(
      new Option(
        '--format <format>',
        'output format: json prints one JSON document to standard output, progress to standard error',
      )
        .choices(['text', 'json'])
        .default('text'),
    )
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
    .addOption(
      new Option(
        '--format <format>',
        'output format: json prints one JSON document to standard output, progress to standard error',
      )
        .choices(['text', 'json'])
        .default('text'),
    )
    .action(async (dir: string | undefined, opts: { service?: string; dashboards?: boolean }) => {
      process.exitCode = await verifyCommand(dir, opts, io);
    });

  program
    .command('history')
    .description(
      'show how one application behaved recently: requests, failures, response time, checks',
    )
    .argument('<service>', 'the application')
    .argument('[dir]', 'workspace directory')
    .addOption(
      new Option('-p, --period <period>', 'how far back')
        .choices(['1h', '6h', '24h'])
        .default('1h'),
    )
    .addOption(
      new Option(
        '--format <format>',
        'output format: json prints one JSON document to standard output, progress to standard error',
      )
        .choices(['text', 'json'])
        .default('text'),
    )
    .action(
      async (
        service: string,
        dir: string | undefined,
        opts: { period: '1h' | '6h' | '24h'; format: 'text' | 'json' },
      ) => {
        process.exitCode = await historyCommand(service, dir, opts, io);
      },
    );

  program
    .command('connect')
    .description('show how to connect services to the stack and generate a Compose override file')
    .argument('[dir]', 'workspace directory')
    .option('-s, --service <name...>', 'only these services')
    .option(
      '-o, --out <file>',
      'write the Compose override file (e.g. observability.override.yaml)',
    )
    .option(
      '--restart <service>',
      'restart this running Compose application with Raion settings (asks first)',
    )
    .option('-y, --yes', 'with --restart: do not ask')
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
        opts: {
          service?: string[];
          out?: string;
          format: 'compose' | 'env' | 'shell';
          restart?: string;
          yes?: boolean;
        },
      ) => {
        process.exitCode = opts.restart
          ? await connectRestartCommand(dir, opts.restart, opts, io, interactive())
          : await connectCommand(dir, opts, io);
      },
    );

  program
    .command('discover')
    .description('list the applications running on this machine, and which Raion monitors')
    .argument('[dir]', 'workspace directory')
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
    )
    .action(async (dir: string | undefined, opts: { format: 'text' | 'json' }) => {
      process.exitCode = await discoverCommand(dir, opts, io);
    });

  const alerts = program
    .command('alerts')
    .description('show firing alerts and whether alerting works; silence alerts')
    .argument('[dir]', 'workspace directory')
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
    )
    .action(async (dir: string | undefined, opts: { format: 'text' | 'json' }) => {
      process.exitCode = await alertsCommand(dir, opts, io);
    });

  alerts
    .command('silence')
    .description('stop notifications for an alert for a while (it stays visible)')
    .argument('<alert>', 'the alert name, e.g. ServiceHighErrorRate')
    .option('--service <name>', 'only for this application')
    .requiredOption('--for <duration>', 'how long, e.g. 1h, 4h, 2d (at most 7d)')
    .requiredOption('--reason <text>', 'why; everyone sees it')
    .option('-w, --workspace <dir>', 'workspace directory')
    .action(
      async (
        alert: string,
        opts: { service?: string; for: string; reason: string; workspace?: string },
      ) => {
        process.exitCode = await silenceCommand(alert, opts, io);
      },
    );

  alerts
    .command('silences')
    .description('list active silences')
    .option('-w, --workspace <dir>', 'workspace directory')
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
    )
    .action(async (opts: { workspace?: string; format: 'text' | 'json' }) => {
      process.exitCode = await silencesCommand(opts, io);
    });

  alerts
    .command('unsilence')
    .description('end a silence early')
    .argument('<id>', 'the silence id shown by "raion alerts silences"')
    .option('-w, --workspace <dir>', 'workspace directory')
    .action(async (id: string, opts: { workspace?: string }) => {
      process.exitCode = await unsilenceCommand(id, opts, io);
    });

  const secrets = program
    .command('secrets')
    .description(
      'manage secrets: notification receivers (Slack webhooks, SMTP passwords…) and database monitoring credentials',
    );

  secrets
    .command('set')
    .description(
      'store a secret, referenced in raion.yaml as ${secret:NAME} (prompts for the value)',
    )
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
    .addOption(
      new Option(
        '--format <format>',
        'output format: json prints one JSON document to standard output, progress to standard error',
      )
        .choices(['text', 'json'])
        .default('text'),
    )
    .action(async (opts: { workspace?: string; format: 'text' | 'json' }) => {
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

  slo
    .command('set')
    .description('change a reliability goal, e.g. target=99.5 window=28d')
    .argument('<service>')
    .argument('<name>')
    .argument('<changes...>', 'key=value pairs: target, window, description, policy, sli')
    .option('-w, --workspace <dir>', 'workspace directory')
    .option('--dry-run', 'show the change without writing it')
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
    )
    .action(async (service: string, name: string, changes: string[], opts: EditFlags) => {
      process.exitCode = await runEdit(
        { kind: 'slo.update', service, name, set: parseAssignments(changes) },
        opts,
        io,
      );
    });

  slo
    .command('remove')
    .description('remove a reliability goal')
    .argument('<service>')
    .argument('<name>')
    .option('-w, --workspace <dir>', 'workspace directory')
    .option('--dry-run', 'show the change without writing it')
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
    )
    .action(async (service: string, name: string, opts: EditFlags) => {
      process.exitCode = await runEdit({ kind: 'slo.remove', service, name }, opts, io);
    });

  const integrations = program
    .command('integrations')
    .description(
      "the integrations available to services: built-in and the workspace's own packages",
    );

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
    .addOption(
      new Option(
        '--format <format>',
        'output format: json prints one JSON document to standard output, progress to standard error',
      )
        .choices(['text', 'json'])
        .default('text'),
    )
    .action(async (dir: string | undefined, opts: { to?: string; yes?: boolean }) => {
      process.exitCode = await rollbackCommand(dir, opts, io, interactive());
    });

  program
    .command('destroy')
    .description('stop the observability stack (keeps stored data unless --delete-data)')
    .argument('[dir]', 'workspace directory')
    .option('--delete-data', 'also delete all stored metrics, logs, traces and Grafana data')
    .option('-y, --yes', 'do not ask for confirmation')
    .addOption(
      new Option(
        '--format <format>',
        'output format: json prints one JSON document to standard output, progress to standard error',
      )
        .choices(['text', 'json'])
        .default('text'),
    )
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

  const services = program
    .command('services')
    .description('the applications Raion monitors (same as the Applications page)');

  services
    .command('list')
    .description('list applications')
    .option('-w, --workspace <dir>', 'workspace directory')
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
    )
    .action(async (opts: { workspace?: string; format: 'text' | 'json' }) => {
      process.exitCode = await servicesListCommand(opts, io);
    });

  services
    .command('add')
    .description('add an application')
    .argument('<name>', 'e.g. payment-api')
    .requiredOption('--type <type>', 'web, api, worker, database, microservice or infrastructure')
    .option('--language <language>', 'nodejs, python, go, java, dotnet, php or other')
    .option('--team <team>', 'the team that owns it')
    .option('--tier <tier>', 'critical, standard or best-effort')
    .option('--description <text>', 'what it does')
    .addOption(
      new Option('--runtime <where>', 'where it runs; remote: elsewhere, watched with --check')
        .choices(['compose', 'host', 'remote'])
        .default('compose'),
    )
    .option('--compose-service <name>', 'its name in your compose file, if different')
    .option('--container-logs', "collect what the container prints (for apps that don't send logs)")
    .option(
      '--check <addresses...>',
      'addresses Raion visits from outside, e.g. https://shop.example.com/health',
    )
    .option('-w, --workspace <dir>', 'workspace directory')
    .option('--dry-run', 'show the change without writing it')
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
    )
    .action(async (name: string, opts: Parameters<typeof servicesAddCommand>[1]) => {
      process.exitCode = await servicesAddCommand(name, opts, io);
    });

  services
    .command('set')
    .description('change an application, e.g. tier=critical alerts.errorRatePercent=2')
    .argument('<name>')
    .argument('[changes...]', 'key=value pairs; values are read as YAML')
    .option('--unset <keys...>', 'remove settings, going back to the defaults')
    .option('-w, --workspace <dir>', 'workspace directory')
    .option('--dry-run', 'show the change without writing it')
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
    )
    .action(async (name: string, changes: string[], opts: EditFlags & { unset?: string[] }) => {
      process.exitCode = await runEdit(
        { kind: 'service.update', name, set: parseAssignments(changes, opts.unset) },
        opts,
        io,
      );
    });

  services
    .command('remove')
    .description('stop monitoring an application (its reliability goals go too)')
    .argument('<name>')
    .option('-w, --workspace <dir>', 'workspace directory')
    .option('--dry-run', 'show the change without writing it')
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
    )
    .action(async (name: string, opts: EditFlags) => {
      process.exitCode = await runEdit({ kind: 'service.remove', name }, opts, io);
    });

  program
    .command('settings')
    .description('change workspace settings, e.g. level=3 retention.logs=14d')
    .argument('<changes...>', 'key=value pairs; values are read as YAML')
    .option('--unset <keys...>', 'remove settings, going back to the defaults')
    .option('-w, --workspace <dir>', 'workspace directory')
    .option('--dry-run', 'show the change without writing it')
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
    )
    .action(async (changes: string[], opts: EditFlags & { unset?: string[] }) => {
      process.exitCode = await runEdit(
        { kind: 'workspace.update', set: parseAssignments(changes, opts.unset) },
        opts,
        io,
      );
    });

  const receivers = program
    .command('receivers')
    .description('notification channels: where alerts are sent besides the Raion inbox');

  receivers
    .command('list')
    .description('list notification channels')
    .option('-w, --workspace <dir>', 'workspace directory')
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
    )
    .action(async (opts: { workspace?: string; format: 'text' | 'json' }) => {
      process.exitCode = await receiversListCommand(opts, io);
    });

  receivers
    .command('add')
    .description('add a notification channel; credentials are read from Raion secrets')
    .argument('<name>', 'e.g. ops-slack')
    .addOption(
      new Option('--type <type>', 'kind of channel')
        .choices(['slack', 'email', 'webhook'])
        .makeOptionMandatory(),
    )
    .option('--webhook-secret <secret>', 'slack: the secret holding the webhook address')
    .option('--channel <channel>', 'slack: channel, e.g. #ops')
    .option('--to <addresses...>', 'email: recipients')
    .option('--from <address>', 'email: sender')
    .option('--smarthost <host:port>', 'email: SMTP server')
    .option('--username <name>', 'email: SMTP user')
    .option('--password-secret <secret>', 'email: the secret holding the SMTP password')
    .option('--url <url>', 'webhook: address to call')
    .option('--token-secret <secret>', 'webhook: the secret holding a bearer token')
    .option('-w, --workspace <dir>', 'workspace directory')
    .option('--dry-run', 'show the change without writing it')
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
    )
    .action(async (name: string, opts: EditFlags & Parameters<typeof receiverFromFlags>[1]) => {
      process.exitCode = await runEdit(
        { kind: 'receiver.add', receiver: receiverFromFlags(name, opts) },
        opts,
        io,
      );
    });

  receivers
    .command('remove')
    .description('remove a notification channel')
    .argument('<name>')
    .option('-w, --workspace <dir>', 'workspace directory')
    .option('--dry-run', 'show the change without writing it')
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
    )
    .action(async (name: string, opts: EditFlags) => {
      process.exitCode = await runEdit({ kind: 'receiver.remove', name }, opts, io);
    });

  const teams = program
    .command('teams')
    .description('teams own applications and receive their alerts');

  teams
    .command('list')
    .description('list teams')
    .option('-w, --workspace <dir>', 'workspace directory')
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
    )
    .action(async (opts: { workspace?: string; format: 'text' | 'json' }) => {
      process.exitCode = await teamsListCommand(opts, io);
    });

  teams
    .command('add')
    .description('add a team')
    .argument('<name>')
    .option('--route <receiver>', "notification channel for the team's alerts")
    .option('-w, --workspace <dir>', 'workspace directory')
    .option('--dry-run', 'show the change without writing it')
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
    )
    .action(async (name: string, opts: EditFlags & { route?: string }) => {
      process.exitCode = await runEdit(
        { kind: 'team.add', team: { name, ...(opts.route ? { route: opts.route } : {}) } },
        opts,
        io,
      );
    });

  teams
    .command('set')
    .description('change a team, e.g. route=ops-slack')
    .argument('<name>')
    .argument('[changes...]', 'key=value pairs')
    .option('--unset <keys...>', 'remove settings')
    .option('-w, --workspace <dir>', 'workspace directory')
    .option('--dry-run', 'show the change without writing it')
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
    )
    .action(async (name: string, changes: string[], opts: EditFlags & { unset?: string[] }) => {
      process.exitCode = await runEdit(
        {
          kind: 'team.update',
          name,
          set: parseAssignments(changes, opts.unset),
        },
        opts,
        io,
      );
    });

  teams
    .command('remove')
    .description('remove a team (no application may still belong to it)')
    .argument('<name>')
    .option('-w, --workspace <dir>', 'workspace directory')
    .option('--dry-run', 'show the change without writing it')
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
    )
    .action(async (name: string, opts: EditFlags) => {
      process.exitCode = await runEdit({ kind: 'team.remove', name }, opts, io);
    });

  const users = program
    .command('users')
    .description('manage Raion user accounts (same rules as the People page)');

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
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
    )
    .action((opts: { workspace?: string; format: 'text' | 'json' }) => {
      process.exitCode = usersListCommand(opts, io);
    });

  users
    .command('set-role')
    .description("change someone's role; signs them out everywhere")
    .argument('<username>')
    .addArgument(new Argument('<role>').choices(['viewer', 'editor', 'admin']))
    .option('-w, --workspace <dir>', 'workspace directory')
    .action(async (username: string, role: string, opts: { workspace?: string }) => {
      process.exitCode = await usersUpdateCommand(username, { role }, opts, io);
    });

  users
    .command('disable')
    .description('stop someone from signing in; signs them out everywhere')
    .argument('<username>')
    .option('-w, --workspace <dir>', 'workspace directory')
    .action(async (username: string, opts: { workspace?: string }) => {
      process.exitCode = await usersUpdateCommand(username, { disabled: true }, opts, io);
    });

  users
    .command('enable')
    .description('let a disabled user sign in again')
    .argument('<username>')
    .option('-w, --workspace <dir>', 'workspace directory')
    .action(async (username: string, opts: { workspace?: string }) => {
      process.exitCode = await usersUpdateCommand(username, { disabled: false }, opts, io);
    });

  users
    .command('reset-password')
    .description('set a new password for someone (prompts for it); signs them out everywhere')
    .argument('<username>')
    .option('-w, --workspace <dir>', 'workspace directory')
    .option('--password-stdin', 'read the password from standard input (for scripts)')
    .action(async (username: string, opts: { workspace?: string; passwordStdin?: boolean }) => {
      process.exitCode = await usersUpdateCommand(
        username,
        { resetPassword: true, ...(opts.passwordStdin ? { passwordStdin: true } : {}) },
        opts,
        io,
      );
    });

  const tokens = program
    .command('tokens')
    .description('personal API tokens for scripts (same as the account and People pages)');

  tokens
    .command('list')
    .description("everyone's active API tokens")
    .option('-w, --workspace <dir>', 'workspace directory')
    .option('--all', 'include revoked and expired tokens')
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
    )
    .action((opts: { workspace?: string; all?: boolean; format: 'text' | 'json' }) => {
      process.exitCode = tokensListCommand(opts, io);
    });

  tokens
    .command('create')
    .description('create an API token for a user; it can never have more rights than that user')
    .requiredOption('--user <username>', 'whose token it is')
    .requiredOption('--name <name>', 'what it is for, e.g. ci-deploy')
    .addOption(
      new Option('--role <role>', 'its role')
        .choices(['viewer', 'editor', 'admin'])
        .default('viewer'),
    )
    .option('--days <days>', 'days until it expires (1-366)', '90')
    .option('-w, --workspace <dir>', 'workspace directory')
    .action(
      async (opts: {
        user: string;
        name: string;
        role: string;
        days: string;
        workspace?: string;
      }) => {
        process.exitCode = await tokensCreateCommand(opts, io);
      },
    );

  tokens
    .command('revoke')
    .description('revoke an API token; it stops working at once')
    .argument('<id>', 'the token id shown by "raion tokens list"')
    .option('-w, --workspace <dir>', 'workspace directory')
    .action(async (id: string, opts: { workspace?: string }) => {
      process.exitCode = await tokensRevokeCommand(id, opts, io);
    });

  program
    .command('audit')
    .description('who did what, newest first (same as the Audit log page)')
    .option('-w, --workspace <dir>', 'workspace directory')
    .option('--actor <username>', 'only this person (CLI actions are "cli:<user>")')
    .option('--action <action>', 'only this kind of action, e.g. login, user, token, runtime')
    .option('--limit <n>', 'how many entries', '50')
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
    )
    .action(
      (opts: {
        workspace?: string;
        actor?: string;
        action?: string;
        limit: string;
        format: 'text' | 'json';
      }) => {
        process.exitCode = auditCommand(opts, io);
      },
    );

  program
    .command('activity')
    .description(
      'deployments, rollbacks, repairs and checks from the CLI and the web UI, or one of them in detail',
    )
    .argument('[id]', 'an operation id, to see its full log')
    .option('-w, --workspace <dir>', 'workspace directory')
    .option('--limit <n>', 'how many operations', '20')
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
    )
    .action(
      (
        id: string | undefined,
        opts: { workspace?: string; limit: string; format: 'text' | 'json' },
      ) => {
        process.exitCode = activityCommand(id, opts, io);
      },
    );
  return program;
}
