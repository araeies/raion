import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadWorkspace,
  renderWorkspace,
  ServiceRegistry,
  validateSources,
  WorkspaceExistsError,
  writeWorkspace,
} from '../src/index.js';

const HEADER = 'apiVersion: raion/v1alpha1\nkind: Workspace\nmetadata:\n  name: test\nspec:\n';

describe('ServiceRegistry', () => {
  const result = validateSources([
    {
      path: 'raion.yaml',
      content: `${HEADER}  services:
    - name: a
      type: api
      dependencies: [{ service: b }, { external: { name: db, kind: postgresql } }]
    - name: b
      type: api
      dependencies: [{ service: c }]
    - name: c
      type: worker
      dependencies: [{ service: a }]
    - name: d
      type: web
      dependencies: [{ service: a }]
`,
    },
  ]);
  const registry = new ServiceRegistry(result.workspace!);

  it('lists and finds services', () => {
    expect(registry.list().map((s) => s.name)).toEqual(['a', 'b', 'c', 'd']);
    expect(registry.get('c')!.type).toBe('worker');
    expect(registry.get('missing')).toBeUndefined();
  });

  it('resolves dependencies and dependents (ignoring externals)', () => {
    expect(registry.dependenciesOf('a').map((s) => s.name)).toEqual(['b']);
    expect(registry.dependentsOf('a').map((s) => s.name)).toEqual(['c', 'd']);
  });

  it('detects dependency cycles', () => {
    expect(registry.cycles()).toEqual([['a', 'b', 'c']]);
  });
});

describe('workspace init', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  for (const level of [1, 2, 3] as const) {
    it(`renders a valid level ${level} workspace with no warnings`, () => {
      const files = renderWorkspace({
        name: 'acme',
        level,
        environment: 'production',
        service: { name: 'payment-api', type: 'api', language: 'nodejs', runtime: 'compose' },
      });
      const result = validateSources(files.filter((f) => f.path.endsWith('.yaml')));
      expect(result.diagnostics).toEqual([]);
      expect(result.workspace!.services[0]!.slos).toHaveLength(level === 3 ? 2 : 0);
    });
  }

  it('writes files and refuses to overwrite', async () => {
    dir = await mkdtemp(join(tmpdir(), 'raion-init-'));
    const files = renderWorkspace({ name: 'acme', level: 1, environment: 'production' });
    await writeWorkspace(dir, files);
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toContain('.raion/');
    const loaded = await loadWorkspace(dir);
    expect(loaded.ok).toBe(true);
    await expect(writeWorkspace(dir, files)).rejects.toBeInstanceOf(WorkspaceExistsError);
  });
});
