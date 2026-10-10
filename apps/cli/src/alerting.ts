import { formatDiagnostic, generateRuntime, loadWorkspace } from '@raion/core';
import {
  alertingHealth,
  DockerComposeTarget,
  fetchActiveAlerts,
  fetchRuleAlerts,
  listSecrets,
  removeSecret,
  SecretError,
  secretStatus,
  setSecret,
  StatePaths,
  userAlerts,
  type ActiveAlert,
  type RuleAlert,
} from '@raion/deploy';
import { structured, EXIT, resolveWorkspaceDir, UsageError, type Output } from './commands.js';
import { askHidden, readStdin } from './prompt.js';

const SEVERITY_ORDER = ['critical', 'warning', 'info', 'none'];

function since(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} d`;
}

/** raion alerts: what is firing now and what is about to, explained. */
export async function alertsCommand(
  dirArg: string | undefined,
  opts: { format: 'text' | 'json' },
  io: Output,
): Promise<number> {
  const dir = resolveWorkspaceDir(dirArg);
  const result = await loadWorkspace(dir);
  for (const d of result.diagnostics.filter((x) => x.severity === 'error'))
    io.err(formatDiagnostic(d));
  if (!result.workspace) return EXIT.INVALID;
  const target = new DockerComposeTarget(dir, result.workspace);
  if (!target.releases.currentId()) {
    io.err('Nothing is deployed yet. Run "raion apply" first.');
    return EXIT.INVALID;
  }
  const catalog = generateRuntime(result.workspace).alerts;
  const ruleFor = (name: string, labels: Record<string, string>) =>
    catalog.find(
      (r) => r.alert === name && (!labels.service_name || r.service === labels.service_name),
    ) ?? catalog.find((r) => r.alert === name);
  let alerts: ActiveAlert[] | undefined;
  let pending: RuleAlert[] = [];
  let error: string | undefined;
  try {
    alerts = await fetchActiveAlerts(target.gateway());
    pending = (await fetchRuleAlerts(target.gateway())).filter((a) => a.state === 'pending');
  } catch (e) {
    error = (e as Error).message;
  }
  const health = alertingHealth(alerts, error);
  const visible = alerts ? userAlerts(alerts) : [];

  if (opts.format === 'json') {
    io.out(JSON.stringify({ health, alerts: visible, pending }, null, 2));
    return health.ok ? EXIT.OK : EXIT.INVALID;
  }
  io.out(`${health.ok ? '✓' : '✗'} ${health.message}`);
  io.out(
    '  (Raion proves this with an alerting self-test, "Watchdog", that always fires and is never sent to anyone.)\n',
  );
  if (visible.length === 0) {
    io.out(alerts ? 'No alerts are firing.' : '');
  } else {
    const sorted = [...visible].sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.labels.severity ?? 'none') -
        SEVERITY_ORDER.indexOf(b.labels.severity ?? 'none'),
    );
    io.out('Firing now:');
    for (const a of sorted) {
      const rule = ruleFor(a.labels.alertname ?? '', a.labels);
      const muted = a.status.state === 'suppressed' ? ' (silenced)' : '';
      io.out(
        `  ${(a.labels.severity ?? '').padEnd(8)} ${rule?.title ?? a.labels.alertname}${a.labels.service_name ? ` · ${a.labels.service_name}` : ''}${muted}  — for ${since(a.startsAt)}`,
      );
      if (a.annotations.summary) io.out(`           ${a.annotations.summary}`);
      if (rule?.action[0]) io.out(`           What to do: ${rule.action[0]}`);
      if (a.annotations.dashboard_url) io.out(`           ${a.annotations.dashboard_url}`);
      if (a.annotations.runbook_url) io.out(`           runbook: ${a.annotations.runbook_url}`);
    }
  }
  if (pending.length > 0) {
    io.out('\nAbout to fire (the condition is true, but has not lasted long enough yet):');
    for (const a of pending) {
      const rule = ruleFor(a.alertname, a.labels);
      io.out(
        `  ${rule?.title ?? a.alertname}${a.labels.service_name ? ` · ${a.labels.service_name}` : ''}  — for ${since(a.activeAt)}`,
      );
    }
  }
  return health.ok ? EXIT.OK : EXIT.INVALID;
}

// ----- secrets --------------------------------------------------------------------------------

export async function secretsSetCommand(
  key: string,
  opts: { workspace?: string; valueStdin?: boolean },
  io: Output,
): Promise<number> {
  const paths = new StatePaths(resolveWorkspaceDir(opts.workspace));
  const value = opts.valueStdin
    ? await readStdin()
    : await askHidden(`Value for ${key} (input is hidden): `);
  try {
    setSecret(paths, key, value);
  } catch (error) {
    if (error instanceof SecretError) throw new UsageError(error.message);
    throw error;
  }
  io.out(`Stored secret ${key}. Run "raion apply" so receivers use it.`);
  return EXIT.OK;
}

export async function secretsListCommand(
  opts: { workspace?: string; format?: 'text' | 'json' },
  rawIo: Output,
): Promise<number> {
  const { io, emit } = structured(rawIo, opts.format);
  const dir = resolveWorkspaceDir(opts.workspace);
  const paths = new StatePaths(dir);
  const result = await loadWorkspace(dir);
  const needed = result.workspace ? secretStatus(paths, generateRuntime(result.workspace)) : [];
  if (needed.length > 0) {
    io.out('Needed by notification receivers:');
    for (const s of needed) {
      io.out(
        `  ${s.present ? '✓' : '✗'} ${s.key.padEnd(32)} ${s.source === 'env' ? 'environment variable' : 'secret store'}${s.present ? '' : ' (missing)'}`,
      );
    }
  } else {
    io.out('No receiver needs a secret.');
  }
  const extra = listSecrets(paths).filter((k) => !needed.some((n) => n.key === k));
  emit({ needed, unused: extra });
  if (extra.length > 0) io.out(`\nStored but unused: ${extra.join(', ')}`);
  return needed.every((s) => s.present) ? EXIT.OK : EXIT.INVALID;
}

export function secretsRemoveCommand(
  key: string,
  opts: { workspace?: string },
  io: Output,
): number {
  const paths = new StatePaths(resolveWorkspaceDir(opts.workspace));
  if (!removeSecret(paths, key)) throw new UsageError(`secret ${key} is not set`);
  io.out(`Removed secret ${key}.`);
  return EXIT.OK;
}
