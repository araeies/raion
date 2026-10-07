import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  addSlo,
  formatDiagnostic,
  fromOpenSlo,
  loadWorkspace,
  SloAuthoringError,
  sloSupported,
  toOpenSlo,
  type NewSlo,
} from '@raion/core';
import { DockerComposeTarget, fetchSloStatus } from '@raion/deploy';
import { DNS_LABEL, type Sli } from '@raion/schema';
import { EXIT, resolveWorkspaceDir, UsageError, type Output } from './commands.js';
import { ask, choose } from './prompt.js';

async function loadValid(dirArg: string | undefined, io: Output) {
  const dir = resolveWorkspaceDir(dirArg);
  const result = await loadWorkspace(dir);
  if (!result.workspace) {
    for (const d of result.diagnostics) io.err(formatDiagnostic(d));
    throw new UsageError('the workspace has configuration errors; run "raion validate"');
  }
  return { dir, result, ws: result.workspace };
}

function describe(sli: Sli): string {
  switch (sli.type) {
    case 'availability':
      return 'requests without server errors';
    case 'latency':
      return `requests under ${sli.thresholdMs} ms`;
    case 'throughput':
      return `≥ ${sli.minRequestsPerSecond} req/s per 5 min`;
    case 'custom':
      return 'custom query';
  }
}

// ----- list ------------------------------------------------------------------------------------

export async function sloListCommand(
  dirArg: string | undefined,
  opts: { format: 'text' | 'json' },
  io: Output,
): Promise<number> {
  const { dir, ws } = await loadValid(dirArg, io);
  const target = new DockerComposeTarget(dir, ws);
  const all = ws.services.flatMap((svc) =>
    svc.slos.map((slo) => ({ svc, slo, evaluated: svc.features.slos && sloSupported(svc, slo) })),
  );
  let status: Awaited<ReturnType<typeof fetchSloStatus>> = [];
  if (target.releases.currentId()) {
    try {
      status = await fetchSloStatus(
        target.gateway(),
        all.filter((s) => s.evaluated).map((s) => ({ service: s.svc.name, slo: s.slo.name })),
      );
    } catch (error) {
      io.err(`warning: could not read SLO status from Prometheus: ${(error as Error).message}`);
    }
  }

  if (opts.format === 'json') {
    io.out(JSON.stringify(status, null, 2));
    return EXIT.OK;
  }
  if (all.length === 0) {
    io.out('No SLOs yet. Add one with: raion slo add <service>');
    return EXIT.OK;
  }
  for (const { svc, slo, evaluated } of all) {
    const s = status.find((x) => x.service === svc.name && x.slo === slo.name);
    const mark = !evaluated
      ? '·'
      : s?.health === 'healthy'
        ? '✓'
        : s?.health === 'no-data' || !s
          ? '?'
          : '✗';
    io.out(
      `  ${mark} ${`${svc.name} · ${slo.name}`.padEnd(32)} ${`${slo.target}% over ${slo.window}`.padEnd(18)} ${describe(slo.sli)}`,
    );
    if (!evaluated) {
      io.out(
        `      not evaluated: ${svc.features.slos ? 'no integration provides the HTTP metrics it needs' : `SLOs start at level 3 (${svc.name} is level ${svc.level})`}`,
      );
    } else if (s) {
      io.out(`      ${s.message}`);
    } else {
      io.out('      not deployed yet: run "raion apply"');
    }
  }
  return EXIT.OK;
}

// ----- add -------------------------------------------------------------------------------------

export interface SloAddFlags {
  name?: string;
  type?: string;
  target?: string;
  window?: string;
  thresholdMs?: string;
  minRps?: string;
  description?: string;
  policy?: string;
}

const LATENCY_THRESHOLDS = ['100', '250', '500', '1000', '2500'];

export async function sloAddCommand(
  dirArg: string | undefined,
  service: string,
  flags: SloAddFlags,
  io: Output,
  interactive: boolean,
): Promise<number> {
  const { dir, result, ws } = await loadValid(dirArg, io);
  const svc = ws.services.find((s) => s.name === service);
  if (!svc) throw new UsageError(`no service "${service}" in this workspace`);

  let type = flags.type;
  if (!type && interactive) {
    io.out(
      `Creating an SLO for ${service}. An SLO says how reliable it must be, from its users' point of view.`,
    );
    type = await choose(
      'What should it measure?',
      [
        { value: 'availability', label: 'Availability: requests succeed (no server errors)' },
        { value: 'latency', label: 'Latency: requests are fast enough' },
        {
          value: 'throughput',
          label: 'Throughput: the service keeps handling at least a minimum rate',
        },
      ],
      'availability',
    );
  }
  if (!type) throw new UsageError('--type is required (availability, latency or throughput)');

  let sli: Sli;
  if (type === 'availability') sli = { type: 'availability' };
  else if (type === 'latency') {
    const threshold =
      flags.thresholdMs ??
      (interactive
        ? await ask(
            `Requests faster than how many milliseconds count as good? (${LATENCY_THRESHOLDS.join(', ')})`,
            '500',
            (v) => (/^\d+$/.test(v) ? undefined : 'Enter a number of milliseconds.'),
          )
        : undefined);
    if (!threshold) throw new UsageError('--threshold-ms is required for latency SLOs');
    sli = { type: 'latency', thresholdMs: Number(threshold) };
  } else if (type === 'throughput') {
    const rps =
      flags.minRps ??
      (interactive
        ? await ask('Minimum requests per second the service must keep handling:', '1', (v) =>
            Number(v) > 0 ? undefined : 'Enter a positive number.',
          )
        : undefined);
    if (!rps) throw new UsageError('--min-rps is required for throughput SLOs');
    sli = { type: 'throughput', minRequestsPerSecond: Number(rps) };
  } else {
    throw new UsageError(
      '--type must be availability, latency or throughput (custom SLIs are written in YAML)',
    );
  }

  const target = Number(
    flags.target ??
      (interactive
        ? await ask(
            'Objective, in percent (99.9 allows about 43 minutes of failure per 30 days):',
            type === 'latency' ? '99' : '99.9',
            (v) =>
              Number(v) > 0 && Number(v) < 100
                ? undefined
                : 'Enter a percentage between 0 and 100, e.g. 99.9.',
          )
        : '99.9'),
  );
  const window = flags.window ?? '30d';
  const name = flags.name ?? type;
  if (!DNS_LABEL.test(name))
    throw new UsageError('--name must be lowercase letters, digits and hyphens');

  const slo: NewSlo = {
    service,
    name,
    sli,
    target,
    window,
    ...(flags.description ? { description: flags.description } : {}),
    ...(flags.policy ? { policy: flags.policy } : {}),
  };
  try {
    const { file, diagnostics } = await addSlo(dir, result.files, slo);
    io.out(`Created ${file.path}:\n`);
    io.out(file.content);
    for (const d of diagnostics) io.err(formatDiagnostic(d));
    io.out('Run "raion plan" to see the rules, alerts and dashboards it adds, then "raion apply".');
    return EXIT.OK;
  } catch (error) {
    if (error instanceof SloAuthoringError) {
      for (const d of error.diagnostics) io.err(formatDiagnostic(d));
      io.err(`✗ ${error.diagnostics.length === 0 ? error.message : 'the SLO was not created'}`);
      return EXIT.INVALID;
    }
    throw error;
  }
}

// ----- export / import -----------------------------------------------------------------------

export async function sloExportCommand(
  dirArg: string | undefined,
  opts: { out?: string },
  io: Output,
): Promise<number> {
  const { ws } = await loadValid(dirArg, io);
  const text = toOpenSlo(ws);
  if (!text) {
    io.err('No SLOs to export.');
    return EXIT.INVALID;
  }
  if (opts.out) {
    await writeFile(resolve(opts.out), text);
    io.out(`Wrote OpenSLO v1 definitions to ${opts.out}.`);
  } else {
    io.out(text);
  }
  return EXIT.OK;
}

export async function sloImportCommand(
  dirArg: string | undefined,
  file: string,
  opts: { service?: string },
  io: Output,
): Promise<number> {
  const { dir } = await loadValid(dirArg, io);
  const imported = fromOpenSlo(
    await readFile(resolve(file), 'utf8'),
    opts.service ? { service: opts.service } : {},
  );
  for (const p of imported.problems) io.err(`  ! ${p}`);
  if (imported.slos.length === 0) {
    io.err('✗ nothing could be imported');
    return EXIT.INVALID;
  }
  const written: string[] = [];
  for (const slo of imported.slos) {
    const path = join(dir, slo.path);
    if (existsSync(path)) {
      io.err(`  ! ${slo.path} already exists; skipped`);
      continue;
    }
    await writeFile(path, slo.content, { flag: 'wx' });
    written.push(path);
    io.out(`  + ${slo.path} (${slo.service} · ${slo.name})`);
  }
  // The imported SLOs must leave the workspace valid; otherwise undo.
  const check = await loadWorkspace(dir);
  if (!check.ok) {
    for (const d of check.diagnostics.filter((x) => x.severity === 'error'))
      io.err(formatDiagnostic(d));
    for (const path of written) await rm(path);
    io.err('✗ the imported SLOs made the workspace invalid; nothing was kept');
    return EXIT.INVALID;
  }
  io.out(`\nImported ${written.length} SLO(s) as custom SLIs. Review them, then "raion plan".`);
  return imported.problems.length > 0 ? EXIT.INVALID : EXIT.OK;
}
