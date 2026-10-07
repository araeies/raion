import { generateRuntime, validateSources } from '@raion/core';
import { describe, expect, it } from 'vitest';
import { compareBundles, comparisonMarkdown } from '../src/index.js';

function bundle(extra = '') {
  const ws = validateSources([
    {
      path: 'raion.yaml',
      content: `apiVersion: raion/v1alpha1\nkind: Workspace\nmetadata:\n  name: t\nspec:\n${extra}  services:\n    - name: shop\n      type: api\n      language: nodejs\n`,
    },
  ]).workspace!;
  return generateRuntime(ws);
}

describe('comparing workspace versions', () => {
  it('reports nothing for identical versions', () => {
    const c = compareBundles(bundle(), bundle());
    expect(c.plan.noChanges).toBe(true);
    expect(comparisonMarkdown(c)).toContain('No change to the generated configuration.');
  });

  it('treats a missing base as everything new', () => {
    const c = compareBundles(undefined, bundle());
    expect(c.plan.files.every((f) => f.change === 'add')).toBe(true);
    expect(c.diffs[0]!.diff.startsWith('--- /dev/null')).toBe(true);
  });

  it('flags a change that needs privileges, and shows the diff of what changes', () => {
    const c = compareBundles(bundle(), bundle('  infrastructure:\n    containers: true\n'));
    expect(c.plan.components.find((x) => x.component === 'cadvisor')!.action).toBe('add');
    const md = comparisonMarkdown(c);
    expect(md).toContain('**Security-relevant:** applying needs `--allow-privileged`.');
    expect(md).toContain('<details><summary><code>compose.yaml</code></summary>');
  });

  it('stays under the comment size limit and says what it left out', () => {
    const c = compareBundles(undefined, bundle());
    const md = comparisonMarkdown(c, { limit: 4000 });
    expect(md.length).toBeLessThan(6000);
    expect(md).toMatch(/\d+ more file diffs? omitted/);
  });
});
