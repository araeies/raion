import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { ADVISOR_RULES } from '@raion/schema';
import type { SourceFile } from '../loader.js';
import type { ResolvedWorkspace } from '../model.js';
import { validateSources } from '../workspace.js';
import { withChanges } from './patch.js';
import { RULES } from './rules.js';
import {
  DEFAULT_THRESHOLDS,
  type AdvisorThresholds,
  type Autofix,
  type Finding,
  type FindingSeverity,
  type LiveFacts,
} from './types.js';

export * from './types.js';
export { unifiedDiff } from './diff.js';

export interface AdvisorReport {
  findings: Finding[];
  /** Live data the report is based on; absent when the stack was not consulted. */
  facts?: LiveFacts;
  summary: Record<FindingSeverity, number> & { ignored: number; fixable: number };
}

const SEVERITY_ORDER: Record<FindingSeverity, number> = { critical: 0, warning: 1, info: 2 };

/**
 * Detects common observability gaps. Pure: reads the workspace (and, when given, what the
 * running stack reports) and returns findings. A finding's autofix is only offered when the
 * workspace still validates with it applied.
 */
export function advise(
  ws: ResolvedWorkspace,
  files: readonly SourceFile[],
  options: { facts?: LiveFacts; thresholds?: Partial<AdvisorThresholds> } = {},
): AdvisorReport {
  const ctx = {
    ws,
    files,
    ...(options.facts ? { facts: options.facts } : {}),
    thresholds: { ...DEFAULT_THRESHOLDS, ...options.thresholds },
  };
  const findings = ADVISOR_RULES.flatMap((rule) => RULES[rule](ctx)).map((f) => {
    let result = f;
    if (result.autofix && !validateSources(withChanges(files, result.autofix.changes)).ok) {
      const { autofix: _invalid, ...rest } = result;
      result = rest;
    }
    const ignore = ws.advisor.ignore.find(
      (i) => i.rule === f.rule && (i.subject === undefined || i.subject === f.subject),
    );
    return ignore ? { ...result, ignored: { reason: ignore.reason } } : result;
  });
  findings.sort(
    (a, b) =>
      Number(a.ignored !== undefined) - Number(b.ignored !== undefined) ||
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      ADVISOR_RULES.indexOf(a.rule) - ADVISOR_RULES.indexOf(b.rule) ||
      a.subject.localeCompare(b.subject),
  );
  const active = findings.filter((f) => !f.ignored);
  return {
    findings,
    ...(options.facts ? { facts: options.facts } : {}),
    summary: {
      critical: active.filter((f) => f.severity === 'critical').length,
      warning: active.filter((f) => f.severity === 'warning').length,
      info: active.filter((f) => f.severity === 'info').length,
      ignored: findings.length - active.length,
      fixable: active.filter((f) => f.autofix).length,
    },
  };
}

export class AdvisorConflictError extends Error {}

/**
 * Writes an autofix to the workspace. Refuses when any file changed since the fix was
 * computed (another user, an editor, a git pull), so nobody's edit is overwritten. Only
 * workspace files change; the stack is updated by the normal plan and apply.
 */
export async function applyAutofix(workspaceDir: string, autofix: Autofix): Promise<string[]> {
  const root = resolve(workspaceDir);
  const targets = autofix.changes.map((c) => {
    const target = resolve(root, c.path);
    const rel = relative(root, target);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`refusing to write outside the workspace: ${c.path}`);
    }
    return { change: c, target };
  });
  for (const { change, target } of targets) {
    const current = existsSync(target) ? await readFile(target, 'utf8') : null;
    if (current !== change.before) {
      throw new AdvisorConflictError(
        `${change.path} changed since the fix was computed; review the findings again`,
      );
    }
  }
  for (const { change, target } of targets) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, change.after, change.before === null ? { flag: 'wx' } : {});
  }
  return targets.map((t) => t.change.path);
}
