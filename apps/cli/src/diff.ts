import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { advise, formatDiagnostic, generateRuntime, loadWorkspace } from '@raion/core';
import { compareBundles, comparisonMarkdown, formatComparison } from '@raion/deploy';
import { EXIT, resolveWorkspaceDir, UsageError, type Output } from './commands.js';

export interface DiffFlags {
  format: 'text' | 'markdown' | 'json';
  /** Include the generated files' diffs in text output. */
  files?: boolean;
  /** Add the advisor's configuration-only findings (markdown and json). */
  advise?: boolean;
}

async function bundleOf(dir: string, label: string, io: Output) {
  const result = await loadWorkspace(dir);
  if (!result.workspace) {
    for (const d of result.diagnostics) io.err(formatDiagnostic(d));
    throw new UsageError(`the ${label} workspace (${dir}) has configuration errors`);
  }
  return {
    workspace: result.workspace,
    files: result.files,
    bundle: generateRuntime(result.workspace),
  };
}

/**
 * Compares two versions of a workspace (for example a pull request and its base branch):
 * which generated files and components would change. Needs no deployment.
 */
export async function diffCommand(
  baseArg: string,
  headArg: string | undefined,
  flags: DiffFlags,
  io: Output,
): Promise<number> {
  const baseDir = resolve(baseArg);
  const headDir = resolveWorkspaceDir(headArg);
  const head = await bundleOf(headDir, 'head', io);
  // A pull request may add the workspace: then everything is new.
  const base = existsSync(join(baseDir, 'raion.yaml'))
    ? (await bundleOf(baseDir, 'base', io)).bundle
    : undefined;
  const comparison = compareBundles(base, head.bundle);

  const findings = flags.advise
    ? advise(head.workspace, head.files).findings.filter((f) => !f.ignored)
    : [];
  if (flags.format === 'json') {
    io.out(JSON.stringify({ ...comparison, ...(flags.advise ? { findings } : {}) }, null, 2));
  } else if (flags.format === 'markdown') {
    const sections: string[] = [];
    if (flags.advise) {
      sections.push(
        findings.length === 0
          ? '**Advisor:** no gaps found in the configuration.'
          : `**Advisor** (configuration only):\n\n${findings
              .map(
                (f) =>
                  `- ${f.severity === 'critical' ? '🔴' : f.severity === 'warning' ? '🟠' : '🔵'} ${f.title}${f.autofix ? ` — fix: \`raion advise --apply ${f.id}\`` : ''}`,
              )
              .join('\n')}`,
      );
    }
    io.out(comparisonMarkdown(comparison, { sections }));
  } else {
    io.out(formatComparison(comparison, flags.files === true));
  }
  return EXIT.OK;
}
