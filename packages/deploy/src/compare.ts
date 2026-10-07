import { unifiedDiff, type RuntimeBundle } from '@raion/core';
import { computePlan, formatPlan, type DeployPlan } from './plan.js';
import { manifestFor } from './releases.js';

/**
 * What deploying one version of a workspace would change compared with another, without any
 * deployment state: used to review pull requests ("raion diff base head").
 */
export interface WorkspaceComparison {
  plan: DeployPlan;
  /** Unified diffs of the generated files that differ. */
  diffs: { path: string; component: string; diff: string }[];
}

export function compareBundles(
  base: RuntimeBundle | undefined,
  head: RuntimeBundle,
): WorkspaceComparison {
  const plan = computePlan(
    head,
    base ? manifestFor(base, { seq: 0, createdBy: '', workspace: '' }) : undefined,
  );
  const before = new Map((base?.artifacts ?? []).map((a) => [a.path, a.content]));
  const after = new Map(head.artifacts.map((a) => [a.path, a.content]));
  const diffs = plan.files.map((f) => ({
    path: f.path,
    component: f.component,
    diff: unifiedDiff(f.path, before.get(f.path) ?? null, after.get(f.path) ?? ''),
  }));
  return { plan: { ...plan, ...(base ? { from: 'base' } : {}) }, diffs };
}

export function formatComparison(c: WorkspaceComparison, showDiffs: boolean): string {
  const text = formatPlan(c.plan).replace(
    /^(Deployed release: base|Nothing is deployed yet\.)/,
    c.plan.from
      ? 'Compared with the base workspace.'
      : 'The base has no workspace: everything is new.',
  );
  if (!showDiffs || c.diffs.length === 0) return text;
  return `${text}\n\n${c.diffs.map((d) => d.diff.trimEnd()).join('\n\n')}`;
}

/** Markdown for a pull-request comment. GitHub limits comments to 65,536 characters. */
export function comparisonMarkdown(
  c: WorkspaceComparison,
  extra: { title?: string; sections?: string[]; limit?: number } = {},
): string {
  const limit = extra.limit ?? 60_000;
  const lines: string[] = [`### ${extra.title ?? 'Raion: observability changes'}`, ''];
  const changed = c.plan.components.filter((x) => x.action !== 'unchanged');
  if (c.plan.noChanges) {
    lines.push('No change to the generated configuration.');
  } else {
    lines.push(
      `${c.plan.files.length} generated file${c.plan.files.length === 1 ? '' : 's'} change; ` +
        `${changed.length} component${changed.length === 1 ? '' : 's'} affected.`,
      '',
      '| Component | Change | Why |',
      '| --- | --- | --- |',
      ...changed.map((x) => `| ${x.component} | ${x.action} | ${x.reasons.join(', ') || '–'} |`),
    );
  }
  if (c.plan.securityRelevant.length > 0) {
    lines.push(
      '',
      '> [!WARNING]',
      '> **Security-relevant:** applying needs `--allow-privileged`.',
      ...c.plan.securityRelevant.map((s) => `> - ${s}`),
    );
  }
  if (c.plan.dataAffecting.length > 0) {
    lines.push(
      '',
      '> [!CAUTION]',
      '> **Affects stored data:** applying needs `--allow-data-changes`.',
      ...c.plan.dataAffecting.map((s) => `> - ${s}`),
    );
  }
  if (c.plan.notes.length > 0) {
    lines.push(
      '',
      ...c.plan.notes.map((n) => `- ${n.severity === 'warning' ? '⚠️' : 'ℹ️'} ${n.message}`),
    );
  }
  for (const section of extra.sections ?? []) lines.push('', section);

  let body = lines.join('\n');
  if (c.diffs.length > 0) {
    const parts: string[] = [];
    let omitted = 0;
    for (const d of c.diffs) {
      const capped = capLines(d.diff, 300);
      const part = `<details><summary><code>${d.path}</code></summary>\n\n\`\`\`diff\n${capped.trimEnd()}\n\`\`\`\n\n</details>`;
      if (body.length + parts.join('\n').length + part.length > limit) {
        omitted++;
        continue;
      }
      parts.push(part);
    }
    body += `\n\n**Generated files**\n\n${parts.join('\n')}`;
    if (omitted > 0) {
      body += `\n\n${omitted} more file diff${omitted === 1 ? '' : 's'} omitted (comment size limit); run \`raion diff\` locally to see them.`;
    }
  }
  return `${body}\n`;
}

function capLines(text: string, max: number): string {
  const lines = text.split('\n');
  if (lines.length <= max) return text;
  return `${lines.slice(0, max).join('\n')}\n… ${lines.length - max} more lines`;
}
