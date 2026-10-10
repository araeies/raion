import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adviseCommand } from '../src/advise.js';
import { sparkline } from '../src/runtime.js';
import { integrationsListCommand, integrationsLockCommand } from '../src/integrations.js';
import { EXIT, initCommand, UsageError, validateCommand, type Output } from '../src/commands.js';

const examples = join(import.meta.dirname, '..', '..', '..', 'examples', 'workspaces');

function capture(): Output & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (t) => stdout.push(t), err: (t) => stderr.push(t) };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'raion-cli-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('raion validate', () => {
  it('exits 0 and summarizes a valid workspace', async () => {
    const io = capture();
    expect(await validateCommand(join(examples, 'level3-sre'), { format: 'text' }, io)).toBe(
      EXIT.OK,
    );
    expect(io.stdout[0]).toContain('workspace "acme", level 3, 2 service(s), 2 SLO(s)');
  });

  it('exits 1 with located errors for an invalid workspace', async () => {
    await writeFile(
      join(dir, 'raion.yaml'),
      'apiVersion: raion/v1alpha1\nkind: Workspace\nmetadata:\n  name: x\nspec:\n  level: 7\n',
    );
    const io = capture();
    expect(await validateCommand(dir, { format: 'text' }, io)).toBe(EXIT.INVALID);
    expect(io.stderr[0]).toContain('error RAI-E004 raion.yaml:6:10');
    expect(io.stderr.at(-1)).toContain('1 error(s)');
  });

  it('emits machine-readable JSON', async () => {
    const io = capture();
    await validateCommand(join(examples, 'level1-basic'), { format: 'json' }, io);
    expect(JSON.parse(io.stdout[0]!)).toMatchObject({ valid: true, diagnostics: [] });
  });
});

describe('raion init', () => {
  it('creates a valid workspace from flags', async () => {
    const target = join(dir, 'observability');
    const io = capture();
    const code = await initCommand(
      target,
      {
        name: 'acme',
        level: '3',
        service: 'payment-api',
        type: 'api',
        language: 'nodejs',
        runtime: 'compose',
        yes: true,
      },
      io,
      false,
    );
    expect(code).toBe(EXIT.OK);
    expect(await readFile(join(target, 'services', 'payment-api.yaml'), 'utf8')).toContain(
      'thresholdMs: 500',
    );
    expect(await validateCommand(target, { format: 'text' }, capture())).toBe(EXIT.OK);
  });

  it('never overwrites an existing workspace', async () => {
    await writeFile(join(dir, 'raion.yaml'), 'keep me');
    const io = capture();
    expect(await initCommand(dir, { yes: true }, io, false)).toBe(EXIT.USAGE);
    expect(await readFile(join(dir, 'raion.yaml'), 'utf8')).toBe('keep me');
  });

  it('rejects invalid flag values with a usage error', async () => {
    await expect(
      initCommand(join(dir, 'x'), { level: '9', yes: true }, capture(), false),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(
      initCommand(join(dir, 'y'), { service: 'Bad_Name', yes: true }, capture(), false),
    ).rejects.toThrow(/--service/);
  });
});

describe('raion advise', () => {
  async function workspace() {
    await writeFile(
      join(dir, 'raion.yaml'),
      'apiVersion: raion/v1alpha1\nkind: Workspace\nmetadata:\n  name: x\nspec:\n  services:\n    - name: pay\n      tier: critical\n      team: payments\n      type: api\n      language: nodejs\n',
    );
  }

  it('lists findings and fails CI only at the requested severity', async () => {
    await workspace();
    const io = capture();
    expect(await adviseCommand(dir, { format: 'text', failOn: 'critical' }, io, false)).toBe(
      EXIT.OK,
    );
    expect(io.stdout.join('\n')).toContain('pay is a critical service but has no SLO');
    expect(io.stdout.join('\n')).toContain('raion advise --apply critical-service-without-slo/pay');
    expect(await adviseCommand(dir, { format: 'json', failOn: 'warning' }, capture(), false)).toBe(
      EXIT.INVALID,
    );
  });

  it('applies a fix only with confirmation, then the finding is gone', async () => {
    await workspace();
    const id = 'critical-service-without-slo/pay';
    await expect(
      adviseCommand(dir, { format: 'text', apply: id }, capture(), false),
    ).rejects.toThrow('--yes');
    const io = capture();
    expect(await adviseCommand(dir, { format: 'text', apply: id, yes: true }, io, false)).toBe(
      EXIT.OK,
    );
    expect(io.stdout.join('\n')).toContain('+++ b/slos/pay-availability.yaml');
    expect(await readFile(join(dir, 'raion.yaml'), 'utf8')).toContain('slos: true');
    const after = capture();
    await adviseCommand(dir, { format: 'json' }, after, false);
    const ids = (JSON.parse(after.stdout[0]!) as { findings: { id: string }[] }).findings.map(
      (f) => f.id,
    );
    expect(ids).not.toContain(id);
    await expect(
      adviseCommand(dir, { format: 'text', apply: id, yes: true }, capture(), false),
    ).rejects.toBeInstanceOf(UsageError);
  });
});

describe('raion integrations', () => {
  it('locks a reviewed workspace package, after which the workspace validates', async () => {
    await writeFile(
      join(dir, 'raion.yaml'),
      'apiVersion: raion/v1alpha1\nkind: Workspace\nmetadata:\n  name: x\nspec:\n  services:\n    - name: billing\n      type: api\n      language: java\n',
    );
    await mkdir(join(dir, 'integrations', 'acme-java'), { recursive: true });
    await writeFile(
      join(dir, 'integrations', 'acme-java', 'integration.yaml'),
      'apiVersion: raion/v1alpha1\nkind: Integration\nmetadata:\n  name: acme-java\n  version: 1.0.0\nspec:\n  kind: application\n  displayName: Java\n  description: Java agent\n  languages: [java]\n  instrumentation:\n    env:\n      OTEL_SERVICE_NAME: ${service.name}\n  docs: README.md\n',
    );
    await writeFile(join(dir, 'integrations', 'acme-java', 'README.md'), '# Java\n');

    expect(await validateCommand(dir, { format: 'text' }, capture())).toBe(EXIT.INVALID);
    const io = capture();
    expect(await integrationsLockCommand(dir, io)).toBe(EXIT.OK);
    expect(io.stdout.join('\n')).toContain('locked acme-java 1.0.0');
    expect(await validateCommand(dir, { format: 'text' }, capture())).toBe(EXIT.OK);
    const again = capture();
    await integrationsLockCommand(dir, again);
    expect(again.stdout[0]).toBe('integrations.lock.yaml is up to date.');

    const list = capture();
    await integrationsListCommand(dir, { format: 'json' }, list);
    const rows = JSON.parse(list.stdout[0]!) as { name: string; source: string }[];
    expect(rows.find((r) => r.name === 'acme-java')!.source).toBe('workspace');
  });
});

describe('cancelling with Ctrl+C', () => {
  it('recognises the error a question raises when Ctrl+C is pressed', async () => {
    const { PassThrough } = await import('node:stream');
    const { createInterface } = await import('node:readline/promises');
    const { Cancelled, isCancellation } = await import('../src/prompt.js');
    const input = new PassThrough();
    const rl = createInterface({ input, output: new PassThrough(), terminal: true });
    const answer = rl.question('> ');
    input.write('\u0003');
    const error: unknown = await answer.catch((e: unknown) => e);
    rl.close();
    expect(isCancellation(error)).toBe(true);
    expect(isCancellation(new Cancelled())).toBe(true);
    expect(isCancellation(new Error('disk full'))).toBe(false);
  });
});

describe('operations shared with the web UI', () => {
  it('refuses to change the stack while the web UI is changing it', async () => {
    const { renderWorkspace, writeWorkspace } = await import('@raion/core');
    const { OperationJournal, StatePaths } = await import('@raion/deploy');
    const { applyCommand } = await import('../src/runtime.js');
    await writeWorkspace(
      dir,
      renderWorkspace({ name: 'acme', level: 1, environment: 'production' }),
    );
    const web = new OperationJournal(new StatePaths(dir)).begin({
      kind: 'apply',
      via: 'web',
      actor: 'alice',
    });
    const io = capture();
    const code = await applyCommand(dir, { yes: true }, io, false);
    web.succeed();
    expect(code).toBe(EXIT.USAGE);
    expect(io.stderr.join('\n')).toMatch(/apply already in progress by alice \(web UI\)/);
    // Nothing else was recorded: the refused attempt never started.
    expect(new OperationJournal(new StatePaths(dir)).list()).toHaveLength(1);
  });
});

describe('web UI and command line parity', () => {
  it('documents every command in the parity reference', async () => {
    const { createProgram } = await import('../src/program.js');
    type Cmd = { name(): string; commands: readonly Cmd[] };
    const walk = (cmd: Cmd, prefix: string): string[] =>
      cmd.commands.flatMap((c) => {
        const name = prefix ? `${prefix} ${c.name()}` : c.name();
        return c.commands.length > 0 ? [name, ...walk(c, name)] : [name];
      });
    const commands = walk(createProgram(capture()), '');
    const doc = await readFile(
      join(import.meta.dirname, '..', '..', '..', 'docs', 'reference', 'ui-and-cli.md'),
      'utf8',
    );
    const missing = commands.filter((c) => !doc.includes(`\`raion ${c}`));
    expect(missing).toEqual([]);
  });
});

describe('raion history', () => {
  it('draws a terminal sparkline with gaps where nothing arrived', () => {
    expect(
      sparkline(
        [
          [0, 1],
          [10, 4],
          [30, 8],
        ],
        0,
        40,
        4,
      ),
    ).toBe('▂▅ █');
    expect(sparkline([], 0, 40, 3)).toBe('   ');
  });
});
