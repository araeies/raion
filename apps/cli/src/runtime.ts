import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import {
  composeOverride,
  connectService,
  envFile,
  formatDiagnostic,
  generateRuntime,
  shellExports,
  loadWorkspace,
  type ResolvedWorkspace,
  type RuntimeBundle,
} from '@raion/core';
import {
  alertingHealth,
  ApplyError,
  checkDashboards,
  checkServiceTelemetry,
  DockerComposeTarget,
  fetchActiveAlerts,
  formatPlan,
  LockedError,
  verifyPipeline,
  writeFiles,
  stateRoot,
  type DriftKind,
  type ToolCheck,
} from '@raion/deploy';
import { Store } from '@raion/server';
import { EXIT, resolveWorkspaceDir, UsageError, type Output } from './commands.js';
import { confirm } from './prompt.js';

interface Loaded {
  dir: string;
  workspace: ResolvedWorkspace;
  bundle: RuntimeBundle;
  target: DockerComposeTarget;
}

/** Loads and validates the workspace; prints problems and returns undefined if it is invalid. */
async function load(dirArg: string | undefined, io: Output): Promise<Loaded | undefined> {
  const dir = resolveWorkspaceDir(dirArg);
  const result = await loadWorkspace(dir);
  for (const d of result.diagnostics) io.err(formatDiagnostic(d));
  if (!result.workspace) {
    io.err(`\n✗ ${dir} has configuration errors; fix them first (see "raion validate").`);
    return undefined;
  }
  const bundle = generateRuntime(result.workspace);
  return {
    dir,
    workspace: result.workspace,
    bundle,
    target: new DockerComposeTarget(dir, result.workspace),
  };
}

export function actor(): string {
  return `cli:${userInfo().username}`;
}

function audit(
  dir: string,
  action: string,
  outcome: 'success' | 'failure',
  target: string | null,
  details: Record<string, unknown> | null,
) {
  try {
    const store = new Store(join(stateRoot(dir), 'raion.db'));
    try {
      store.audit({ actor: actor(), action, target, outcome, ip: null, details });
    } finally {
      store.close();
    }
  } catch {
    // Auditing must never block an operation; the server records its own actions.
  }
}

function printToolChecks(checks: ToolCheck[], io: Output) {
  for (const c of checks) {
    io.out(`  ${c.ok ? '✓' : '✗'} ${c.tool}`);
    if (!c.ok && c.output)
      io.out(
        c.output
          .split('\n')
          .map((l) => `      ${l}`)
          .join('\n'),
      );
  }
}

// ----- render ------------------------------------------------------------------------------

export async function renderCommand(
  dirArg: string | undefined,
  opts: { out: string },
  io: Output,
): Promise<number> {
  const loaded = await load(dirArg, io);
  if (!loaded) return EXIT.INVALID;
  const out = resolve(opts.out);
  if (existsSync(out) && readdirSync(out).length > 0) {
    throw new UsageError(`${out} is not empty; choose an empty or new directory`);
  }
  mkdirSync(out, { recursive: true });
  writeFiles(out, loaded.bundle.artifacts);
  io.out(`Wrote ${loaded.bundle.artifacts.length} files to ${out}:`);
  for (const a of loaded.bundle.artifacts) io.out(`  ${a.path.padEnd(48)} ${a.description}`);
  io.out(
    '\nThese are standard configuration files. The Compose project expects its secret files in ../secrets.',
  );
  return EXIT.OK;
}

// ----- validate --deep ---------------------------------------------------------------------

export async function deepValidateCommand(dirArg: string | undefined, io: Output): Promise<number> {
  const loaded = await load(dirArg, io);
  if (!loaded) return EXIT.INVALID;
  io.out('Checking generated configuration with each component’s own validator…');
  const checks = await loaded.target.validate(loaded.bundle);
  printToolChecks(checks, io);
  return checks.every((c) => c.ok) ? EXIT.OK : EXIT.INVALID;
}

// ----- plan ----------------------------------------------------------------------------------

export async function planCommand(
  dirArg: string | undefined,
  opts: { toolValidation: boolean; detailedExitcode?: boolean },
  io: Output,
): Promise<number> {
  const loaded = await load(dirArg, io);
  if (!loaded) return EXIT.INVALID;
  const plan = loaded.target.plan(loaded.bundle);
  io.out(formatPlan(plan));
  if (opts.toolValidation) {
    io.out('\nValidating generated configuration with each component’s own tools…');
    const checks = await loaded.target.validate(loaded.bundle);
    printToolChecks(checks, io);
    if (checks.some((c) => !c.ok)) return EXIT.INVALID;
  }
  // --detailed-exitcode: 0 = no changes, 3 = changes pending (for CI drift detection).
  return opts.detailedExitcode && !plan.noChanges ? 3 : EXIT.OK;
}

// ----- apply ---------------------------------------------------------------------------------

export async function applyCommand(
  dirArg: string | undefined,
  opts: {
    yes?: boolean;
    allowPrivileged?: boolean;
    allowDataChanges?: boolean;
    skipToolValidation?: boolean;
  },
  io: Output,
  interactive: boolean,
): Promise<number> {
  const loaded = await load(dirArg, io);
  if (!loaded) return EXIT.INVALID;
  const plan = loaded.target.plan(loaded.bundle);
  io.out(formatPlan(plan));
  io.out('');
  if (!opts.yes) {
    if (!interactive)
      throw new UsageError('refusing to apply without confirmation; pass --yes in scripts');
    if (!(await confirm('Apply these changes?'))) {
      io.out('Nothing was changed.');
      return EXIT.OK;
    }
  }
  try {
    const result = await loaded.target.apply(loaded.bundle, {
      actor: actor(),
      ...(opts.allowPrivileged ? { allowPrivileged: true } : {}),
      ...(opts.allowDataChanges ? { allowDataChanges: true } : {}),
      ...(opts.skipToolValidation ? { skipToolValidation: true } : {}),
      onProgress: (m) => io.out(m),
    });
    audit(loaded.dir, 'runtime.apply', 'success', result.release.id, {
      restarted: result.restarted,
    });
    io.out(`\n✓ Release ${result.release.id} is deployed and every component is ready.`);
    io.out(
      `  Grafana: ${loaded.workspace.server.publicUrl.replace(/\/$/, '')}/grafana/ (sign in through "raion server")`,
    );
    io.out(
      `  Send telemetry to: OTLP gRPC 127.0.0.1:${loaded.workspace.target.compose.otlpGrpcPort}, OTLP HTTP http://127.0.0.1:${loaded.workspace.target.compose.otlpHttpPort}`,
    );
    io.out('  Check the whole pipeline with: raion verify');
    return EXIT.OK;
  } catch (error) {
    if (error instanceof LockedError) {
      io.err(`✗ ${error.message}`);
      return EXIT.USAGE;
    }
    if (error instanceof ApplyError) {
      audit(loaded.dir, 'runtime.apply', 'failure', null, {
        error: error.message,
        rolledBackTo: error.details.rolledBackTo ?? null,
      });
      io.err(`\n✗ Apply failed: ${error.message}`);
      if (error.details.toolChecks) printToolChecks(error.details.toolChecks, io);
      for (const c of error.details.failedComponents ?? []) {
        io.err(`\n  ${c.component}: ${c.state}${c.ready === false ? ', not ready' : ''}`);
        if (c.detail)
          io.err(
            c.detail
              .split('\n')
              .map((l) => `      ${l}`)
              .join('\n'),
          );
      }
      return EXIT.INVALID;
    }
    throw error;
  }
}

// ----- status ----------------------------------------------------------------------------------

export async function statusCommand(
  dirArg: string | undefined,
  opts: { format: 'text' | 'json' },
  io: Output,
): Promise<number> {
  const loaded = await load(dirArg, io);
  if (!loaded) return EXIT.INVALID;
  const status = await loaded.target.status(loaded.bundle);
  if (opts.format === 'json') {
    io.out(JSON.stringify(status, null, 2));
    return status.healthy ? EXIT.OK : EXIT.INVALID;
  }
  if (!status.deployed) {
    io.out('Nothing is deployed yet. Run "raion plan" and "raion apply".');
    return EXIT.INVALID;
  }
  io.out(
    `Release ${status.deployed.id}, applied ${status.deployed.createdAt} by ${status.deployed.createdBy}\n`,
  );
  const purposes = new Map(loaded.bundle.components.map((c) => [c.id as string, c.purpose]));
  for (const c of status.components) {
    const ok = c.state === 'running' && c.ready !== false;
    io.out(
      `  ${ok ? '✓' : '✗'} ${c.component.padEnd(15)} ${c.state}${c.ready === false ? ', not ready' : ''}   ${purposes.get(c.component) ?? ''}`,
    );
    if (!ok && c.detail) io.out(`      ${c.detail}`);
  }
  if (status.scrapeTargets) {
    io.out('\nMonitoring of the stack itself (Prometheus scrape targets):');
    for (const t of status.scrapeTargets) {
      io.out(
        `  ${t.health === 'up' ? '✓' : '✗'} ${t.job.padEnd(15)} ${t.health}${t.lastError ? `  ${t.lastError}` : ''}`,
      );
    }
  }
  let alerting: ReturnType<typeof alertingHealth>;
  try {
    alerting = alertingHealth(await fetchActiveAlerts(loaded.target.gateway()));
  } catch (error) {
    alerting = alertingHealth(undefined, (error as Error).message);
  }
  io.out(`\nAlerting: ${alerting.ok ? '✓' : '✗'} ${alerting.message}`);
  const drift = await loaded.target.drift();
  io.out(
    drift.items.length === 0
      ? 'Drift: ✓ the running stack matches the deployed release'
      : `Drift: ✗ ${drift.items.length} change(s) made outside Raion; see "raion drift"`,
  );
  const healthy = status.healthy && alerting.ok;
  io.out(
    healthy ? '\nThe observability stack is healthy.' : '\nThe observability stack is NOT healthy.',
  );
  return healthy ? EXIT.OK : EXIT.INVALID;
}

// ----- rollback ------------------------------------------------------------------------------

export async function rollbackCommand(
  dirArg: string | undefined,
  opts: { to?: string; yes?: boolean },
  io: Output,
  interactive: boolean,
): Promise<number> {
  const loaded = await load(dirArg, io);
  if (!loaded) return EXIT.INVALID;
  const releases = loaded.target.releases.list();
  const current = loaded.target.releases.currentId();
  io.out('Releases (newest first):');
  for (const r of releases.slice(0, 10))
    io.out(`  ${r.id === current ? '*' : ' '} ${r.id}  ${r.createdAt}  ${r.createdBy}`);
  if (!opts.yes) {
    if (!interactive)
      throw new UsageError('refusing to roll back without confirmation; pass --yes in scripts');
    if (!(await confirm(`Roll back to ${opts.to ?? 'the previous release'}?`))) return EXIT.OK;
  }
  try {
    const target = await loaded.target.rollback({
      actor: actor(),
      ...(opts.to ? { to: opts.to } : {}),
      onProgress: (m) => io.out(m),
    });
    audit(loaded.dir, 'runtime.rollback', 'success', target.id, null);
    io.out(
      `✓ Release ${target.id} is deployed. Note: your workspace files still describe the newer configuration; "raion plan" will show the difference.`,
    );
    return EXIT.OK;
  } catch (error) {
    if (error instanceof ApplyError || error instanceof LockedError) {
      audit(loaded.dir, 'runtime.rollback', 'failure', opts.to ?? null, { error: error.message });
      io.err(`✗ ${error.message}`);
      return EXIT.INVALID;
    }
    throw error;
  }
}

// ----- drift -----------------------------------------------------------------------------------

const DRIFT_LABELS: Record<DriftKind, string> = {
  'file-modified': 'file changed',
  'file-missing': 'file missing',
  'file-extra': 'file added',
  'component-missing': 'container missing',
  'component-stopped': 'container stopped',
  'component-extra': 'container added',
  'image-changed': 'image changed',
};

/**
 * Compares the running stack with the release Raion deployed. Exit code 3 means drift, so a
 * scheduled CI job can alert on it. --repair puts the release back.
 */
export async function driftCommand(
  dirArg: string | undefined,
  opts: { format: 'text' | 'json'; repair?: boolean; yes?: boolean },
  io: Output,
  interactive: boolean,
): Promise<number> {
  const loaded = await load(dirArg, io);
  if (!loaded) return EXIT.INVALID;
  const report = await loaded.target.drift();
  if (opts.format === 'json') {
    io.out(JSON.stringify(report, null, 2));
  } else if (!report.release) {
    io.out('Nothing is deployed.');
  } else if (report.items.length === 0) {
    io.out(`✓ The running stack matches release ${report.release}.`);
  } else {
    io.out(`The running stack differs from release ${report.release}:`);
    for (const item of report.items) {
      io.out(`  ✗ ${DRIFT_LABELS[item.kind].padEnd(18)} ${item.subject}: ${item.detail}`);
    }
  }
  if (report.items.length === 0) return EXIT.OK;
  if (!opts.repair) {
    if (opts.format === 'text') {
      io.out('');
      io.out(
        'Run "raion drift --repair" to restore the release, or "raion plan" for workspace changes.',
      );
    }
    return 3;
  }
  if (!opts.yes) {
    if (!interactive) throw new UsageError('refusing to repair without confirmation; pass --yes');
    if (!(await confirm(`Restore release ${report.release} (its files and containers)?`))) {
      return 3;
    }
  }
  try {
    const release = await loaded.target.repair({ actor: actor(), onProgress: (m) => io.out(m) });
    audit(loaded.dir, 'runtime.repair', 'success', release.id, {
      drift: report.items.map((i) => `${i.kind}:${i.subject}`),
    });
    const after = await loaded.target.drift();
    if (after.items.length > 0) {
      io.err(`✗ ${after.items.length} difference(s) remain; see "raion drift"`);
      return 3;
    }
    io.out(`✓ Release ${release.id} is restored.`);
    return EXIT.OK;
  } catch (error) {
    if (error instanceof ApplyError || error instanceof LockedError) {
      audit(loaded.dir, 'runtime.repair', 'failure', report.release ?? null, {
        error: error.message,
      });
      io.err(`✗ ${error.message}`);
      return EXIT.INVALID;
    }
    throw error;
  }
}

// ----- destroy ---------------------------------------------------------------------------------

export async function destroyCommand(
  dirArg: string | undefined,
  opts: { deleteData?: boolean; yes?: boolean },
  io: Output,
  interactive: boolean,
): Promise<number> {
  const loaded = await load(dirArg, io);
  if (!loaded) return EXIT.INVALID;
  io.out(
    opts.deleteData
      ? 'This stops every component AND permanently deletes all stored metrics, logs, traces and Grafana data.'
      : 'This stops every component. Stored data is kept and will be there after the next "raion apply".',
  );
  if (!opts.yes) {
    if (!interactive)
      throw new UsageError('refusing to destroy without confirmation; pass --yes in scripts');
    if (!(await confirm('Continue?'))) return EXIT.OK;
  }
  try {
    await loaded.target.destroy({ actor: actor(), deleteData: Boolean(opts.deleteData) });
    audit(loaded.dir, 'runtime.destroy', 'success', null, { deleteData: Boolean(opts.deleteData) });
    io.out('✓ The observability stack was stopped.');
    return EXIT.OK;
  } catch (error) {
    if (error instanceof ApplyError || error instanceof LockedError) {
      io.err(`✗ ${error.message}`);
      return EXIT.INVALID;
    }
    throw error;
  }
}

// ----- verify ----------------------------------------------------------------------------------

export async function verifyCommand(
  dirArg: string | undefined,
  opts: { service?: string; dashboards?: boolean },
  io: Output,
): Promise<number> {
  const loaded = await load(dirArg, io);
  if (!loaded) return EXIT.INVALID;
  if (!loaded.target.releases.currentId()) {
    io.err('Nothing is deployed yet. Run "raion apply" first.');
    return EXIT.INVALID;
  }
  if (opts.service) return verifyService(loaded, opts.service, io);
  if (opts.dashboards) return verifyDashboards(loaded, io);
  const traces = loaded.bundle.components.some((c) => c.id === 'tempo');
  io.out(
    'Sending a test metric, log line' +
      (traces ? ' and trace' : '') +
      ' through the collector, exactly like an application would…',
  );
  const results = await verifyPipeline(
    loaded.target.gateway(),
    loaded.workspace.target.compose.otlpHttpPort,
    {
      traces,
      environment: loaded.workspace.environment,
    },
  );
  for (const r of results) {
    io.out(`  ${r.ok ? '✓' : '✗'} ${r.signal.padEnd(8)} ${r.message}`);
    if (r.query) io.out(`             query: ${r.query}`);
  }
  const ok = results.every((r) => r.ok);
  io.out(
    ok
      ? '\nThe telemetry pipeline works end to end.'
      : '\nSome signals did not arrive. Run "raion status" to see which component is unhealthy.',
  );
  return ok ? EXIT.OK : EXIT.INVALID;
}

async function verifyService(loaded: Loaded, name: string, io: Output): Promise<number> {
  const svc = loaded.workspace.services.find((s) => s.name === name);
  if (!svc) throw new UsageError(`no service "${name}" in this workspace`);
  io.out(`Checking what service "${name}" sends to the observability stack…`);
  const t = await checkServiceTelemetry(loaded.target.gateway(), svc, {
    tracesDeployed: loaded.bundle.components.some((c) => c.id === 'tempo'),
  });
  for (const s of t.signals) {
    io.out(`  ${s.ok ? '✓' : '✗'} ${s.signal.padEnd(8)} ${s.message}`);
    io.out(`             query: ${s.query}`);
  }
  if (t.correlation) {
    const linked = t.correlation.logsWithTraceId > 0.5 && t.correlation.linkedTraceFound;
    io.out(`  ${linked ? '✓' : '✗'} ${'linking'.padEnd(8)} ${t.correlation.message}`);
  }
  if (t.red) {
    const pct = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(2)}%`);
    const ms = (v: number | null) =>
      v === null || Number.isNaN(v) ? 'n/a' : `${Math.round(v * 1000)} ms`;
    io.out('\nLast 5 minutes:');
    io.out(
      `  requests/s ${t.red.requestsPerSecond?.toFixed(2) ?? 'n/a'}   errors ${pct(t.red.errorRatio)}   p95 latency ${ms(t.red.p95Seconds)}`,
    );
  }
  const ok = t.signals.every((s) => s.ok) && (!t.correlation || t.correlation.linkedTraceFound);
  io.out(
    ok
      ? `\nService "${name}" is fully connected.`
      : `\nService "${name}" is not fully connected. Run "raion connect --service ${name}" for the setup steps.`,
  );
  return ok ? EXIT.OK : EXIT.INVALID;
}

// ----- connect -------------------------------------------------------------------------------

const OVERRIDE_MARKER = 'Raion: connects your services to the observability stack';

export async function connectCommand(
  dirArg: string | undefined,
  opts: { service?: string[]; out?: string; format: 'compose' | 'env' | 'shell' },
  io: Output,
): Promise<number> {
  const loaded = await load(dirArg, io);
  if (!loaded) return EXIT.INVALID;
  const ws = loaded.workspace;
  const selected = opts.service?.length
    ? opts.service.map((n) => {
        const svc = ws.services.find((s) => s.name === n);
        if (!svc) throw new UsageError(`no service "${n}" in this workspace`);
        return svc;
      })
    : ws.services;
  if (selected.length === 0) throw new UsageError('the workspace has no services to connect');
  const connections = selected.map((svc) => connectService(ws, svc));

  if (opts.format !== 'compose') {
    for (const c of connections) {
      if (!c.supported) continue;
      io.out(`# ${c.service}`);
      io.out((opts.format === 'env' ? envFile(c) : shellExports(c)).trimEnd());
      io.out('');
    }
    return EXIT.OK;
  }

  for (const c of connections) {
    io.out(`\n${c.service}`);
    if (!c.supported) {
      for (const n of c.notes) io.out(`  ! ${n}`);
      if (c.logging) io.out('  i Container logs: collected through the override file.');
      continue;
    }
    const integration = c.integration!;
    io.out(
      `  Integration: ${integration.displayName}${integration.implicit ? ' (chosen from the service language)' : ''}`,
    );
    c.requirements.forEach((r, i) => {
      io.out(`  ${i + 1}. ${r.description}`);
      if (r.command) io.out(`       ${r.command}`);
    });
    const step = c.requirements.length + 1;
    if (c.mode === 'pull') {
      io.out(
        c.runtime === 'compose'
          ? `  ${step}. Start it with the generated override file, which connects "${c.composeService}" to the observability network.`
          : `  ${step}. Make sure the collector can reach it at the configured endpoint.`,
      );
    } else if (c.runtime === 'compose') {
      io.out(
        `  ${step}. Start it with the generated override file (service "${c.composeService}" in your compose file).`,
      );
    } else {
      io.out(`  ${step}. Set these environment variables before starting it:`);
      for (const [k, v] of c.env) io.out(`       ${k}=${v}`);
      io.out(`     (as shell commands: raion connect --service ${c.service} --format shell)`);
    }
    for (const n of c.notes) io.out(`  i ${n}`);
  }

  const composeConnections = connections.filter(
    (c) => c.runtime === 'compose' && (c.supported || c.logging),
  );
  if (composeConnections.length === 0) return EXIT.OK;
  const override = composeOverride(ws, composeConnections);
  if (!opts.out) {
    io.out('\nobservability.override.yaml (write it with --out observability.override.yaml):\n');
    io.out(override);
    return EXIT.OK;
  }
  const out = resolve(opts.out);
  if (existsSync(out) && !readFileSync(out, 'utf8').includes(OVERRIDE_MARKER)) {
    throw new UsageError(`${out} exists and was not generated by Raion; refusing to overwrite it`);
  }
  writeFileSync(out, override);
  io.out(`\nWrote ${out}. Start your services with:`);
  io.out(`  docker compose -f compose.yaml -f ${opts.out} up -d`);
  io.out(
    `Then check them with: raion verify ${dirArg ? `${dirArg} ` : ''}--service ${composeConnections[0]!.service}`,
  );
  return EXIT.OK;
}

async function verifyDashboards(loaded: Loaded, io: Output): Promise<number> {
  const dashboards = loaded.bundle.artifacts
    .filter(
      (a) =>
        a.path.startsWith('grafana/provisioning/dashboards/raion/') && a.path.endsWith('.json'),
    )
    .map((a) => {
      const json = JSON.parse(a.content) as Record<string, unknown> & {
        uid: string;
        title: string;
      };
      return { uid: json.uid, title: json.title, json };
    });
  io.out(
    `Running every panel query of ${dashboards.length} generated dashboards through Grafana (last 15 minutes)…`,
  );
  const result = await checkDashboards(loaded.target.gateway(), dashboards);
  for (const d of result.dashboards) {
    const panels = result.panels.filter((p) => p.dashboardUid === d.uid);
    const failing = panels.filter((p) => !p.ok);
    const empty = panels.filter((p) => p.ok && p.status === 'empty');
    const mark = d.loaded && failing.length === 0 ? '✓' : '✗';
    io.out(
      `  ${mark} ${d.title.padEnd(42)} ${d.loaded ? `${panels.length - failing.length - empty.length}/${panels.length} panels with data` : 'not loaded by Grafana'}${empty.length ? `, ${empty.length} empty (allowed: e.g. no errors)` : ''}`,
    );
    for (const p of failing) {
      io.out(
        `      ✗ ${p.panel}: ${p.status === 'error' ? `query failed: ${p.detail ?? ''}` : 'no data'}`,
      );
    }
  }
  io.out(
    result.ok
      ? '\nEvery dashboard is loaded and every panel that should show data does.'
      : '\nSome panels have no data. If your services were just connected, wait a few minutes; otherwise run "raion verify --service <name>".',
  );
  return result.ok ? EXIT.OK : EXIT.INVALID;
}
