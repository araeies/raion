import {
  advise,
  AdvisorConflictError,
  applyAutofix,
  formatDiagnostic,
  loadWorkspace,
  type AdvisorReport,
  type Finding,
  type FindingSeverity,
  type LiveFacts,
} from '@raion/core';
import { collectLiveFacts, DockerComposeTarget } from '@raion/deploy';
import { EXIT, resolveWorkspaceDir, UsageError, type Output } from './commands.js';
import { confirm } from './prompt.js';

export interface AdviseFlags {
  format: 'text' | 'json';
  /** Skip live data even when the stack is deployed. */
  offline?: boolean;
  /** Also show ignored findings. */
  all?: boolean;
  /** Exit with 1 when a finding of this severity or worse exists (for CI). */
  failOn?: FindingSeverity;
  apply?: string;
  yes?: boolean;
}

const RANK: Record<FindingSeverity, number> = { critical: 0, warning: 1, info: 2 };
const MARK: Record<FindingSeverity, string> = { critical: '✗', warning: '!', info: '·' };

async function buildReport(
  dirArg: string | undefined,
  flags: Pick<AdviseFlags, 'offline'>,
  io: Output,
): Promise<{ dir: string; report: AdvisorReport; live: boolean; name: string }> {
  const dir = resolveWorkspaceDir(dirArg);
  const result = await loadWorkspace(dir);
  if (!result.workspace) {
    for (const d of result.diagnostics) io.err(formatDiagnostic(d));
    throw new UsageError('the workspace has configuration errors; run "raion validate"');
  }
  const ws = result.workspace;
  let facts: LiveFacts | undefined;
  const target = new DockerComposeTarget(dir, ws);
  if (!flags.offline && target.releases.currentId()) {
    facts = await collectLiveFacts(target.gateway(), ws);
    for (const p of facts.problems) io.err(`warning: live data unavailable (${p})`);
  }
  return {
    dir,
    report: advise(ws, result.files, facts ? { facts } : {}),
    live: facts !== undefined,
    name: ws.name,
  };
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((l) => `${prefix}${l}`)
    .join('\n');
}

function printFinding(f: Finding, io: Output): void {
  const pad = '              ';
  io.out(`  ${MARK[f.severity]} ${f.severity.padEnd(9)} ${f.title}`);
  io.out(`${pad}Why: ${f.why}`);
  io.out(`${pad}Fix: ${f.fix}`);
  if (f.evidence) io.out(`${pad}Details: ${f.evidence}`);
  if (f.query) io.out(`${pad}Explore: ${f.query}`);
  if (f.ignored) io.out(`${pad}Ignored: ${f.ignored.reason}`);
  else if (f.autofix) io.out(`${pad}Raion can do this: raion advise --apply ${f.id}`);
  io.out('');
}

export async function adviseCommand(
  dirArg: string | undefined,
  flags: AdviseFlags,
  io: Output,
  interactive: boolean,
): Promise<number> {
  if (flags.apply) return applyFinding(dirArg, flags.apply, flags, io, interactive);

  const { report, live, name } = await buildReport(dirArg, flags, io);
  const shown = report.findings.filter((f) => flags.all || !f.ignored);
  if (flags.format === 'json') {
    io.out(JSON.stringify({ ...report, findings: shown }, null, 2));
  } else {
    io.out(
      `Observability advisor · ${name} · ${live ? `configuration and live data from the last ${report.facts!.window}` : 'configuration only (the stack is not deployed, or --offline)'}`,
    );
    io.out('');
    if (shown.length === 0) io.out('  ✓ No gaps found.\n');
    for (const f of shown) printFinding(f, io);
    const s = report.summary;
    const active = s.critical + s.warning + s.info;
    io.out(
      `${active} finding${active === 1 ? '' : 's'} (${s.critical} critical, ${s.warning} warning, ${s.info} info)` +
        (s.fixable ? `, ${s.fixable} Raion can fix` : '') +
        (s.ignored ? `, ${s.ignored} ignored${flags.all ? '' : ' (--all to show)'}` : ''),
    );
  }
  if (flags.failOn) {
    const limit = RANK[flags.failOn];
    if (report.findings.some((f) => !f.ignored && RANK[f.severity] <= limit)) return EXIT.INVALID;
  }
  return EXIT.OK;
}

async function applyFinding(
  dirArg: string | undefined,
  id: string,
  flags: AdviseFlags,
  io: Output,
  interactive: boolean,
): Promise<number> {
  const { dir, report } = await buildReport(dirArg, flags, io);
  const finding = report.findings.find((f) => f.id === id);
  if (!finding) {
    throw new UsageError(
      `no finding "${id}" (any more); run "raion advise" to see the current ones`,
    );
  }
  if (!finding.autofix) {
    throw new UsageError(`Raion cannot fix "${id}" automatically. ${finding.fix}`);
  }
  io.out(`${finding.title}\n\n${finding.autofix.summary}:\n`);
  for (const c of finding.autofix.changes) io.out(indent(c.diff.trimEnd(), '  '));
  io.out('');
  if (!flags.yes) {
    if (!interactive) throw new UsageError('pass --yes to apply without a prompt');
    if (!(await confirm('Write these changes to the workspace?'))) {
      io.out('Nothing changed.');
      return EXIT.OK;
    }
  }
  try {
    const files = await applyAutofix(dir, finding.autofix);
    io.out(`Updated ${files.join(', ')}.`);
    io.out('Review the change (and commit it), then run "raion plan" and "raion apply".');
    return EXIT.OK;
  } catch (error) {
    if (error instanceof AdvisorConflictError) throw new UsageError(error.message);
    throw error;
  }
}
