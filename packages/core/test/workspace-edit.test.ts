import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  planEdit,
  readWorkspaceSources,
  validateSources,
  withEdit,
  WorkspaceEditError,
  writeEdit,
  type EditAction,
} from '../src/index.js';

const example = join(import.meta.dirname, '..', '..', '..', 'examples', 'workspaces', 'level3-sre');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'raion-edit-'));
  await cp(example, dir, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function files() {
  return (await readWorkspaceSources(dir)).files;
}

/** Plans the edit, checks the result is valid, and returns the resolved workspace. */
async function edited(action: EditAction) {
  const edit = planEdit(await files(), action);
  const result = validateSources(withEdit(await files(), edit.changes));
  expect(result.workspace, JSON.stringify(result.diagnostics)).toBeDefined();
  return { edit, workspace: result.workspace! };
}

function refused(action: EditAction, code: WorkspaceEditError['code'], message?: RegExp) {
  return files().then((f) => {
    let error: unknown;
    try {
      planEdit(f, action);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(WorkspaceEditError);
    expect((error as WorkspaceEditError).code).toBe(code);
    if (message) expect((error as Error).message).toMatch(message);
  });
}

describe('editing applications', () => {
  it('adds an application as its own file', async () => {
    const { edit, workspace } = await edited({
      kind: 'service.add',
      service: {
        name: 'checkout',
        type: 'api',
        language: 'python',
        team: 'payments',
        runtime: { type: 'compose' },
      },
    });
    expect(edit.summary).toBe('Add the application checkout');
    expect(edit.changes.map((c) => [c.path, c.before])).toEqual([['services/checkout.yaml', null]]);
    expect(workspace.services.find((s) => s.name === 'checkout')).toMatchObject({
      type: 'api',
      language: 'python',
      team: 'payments',
    });
    expect(edit.changes[0]!.diff).toContain('+  name: checkout');
  });

  it('refuses a name that is taken, or an invalid application', async () => {
    await refused({ kind: 'service.add', service: { name: 'payment-api', type: 'api' } }, 'exists');
    await refused(
      { kind: 'service.add', service: { name: 'checkout', type: 'api', team: 'nobody' } },
      'invalid',
      /team/,
    );
  });

  it('changes settings and keeps comments and formatting', async () => {
    const { edit, workspace } = await edited({
      kind: 'service.update',
      name: 'payment-api',
      set: { tier: 'standard', 'alerts.errorRatePercent': 2, owner: null },
    });
    const svc = workspace.services.find((s) => s.name === 'payment-api')!;
    expect(svc.tier).toBe('standard');
    expect(svc.alerts.errorRatePercent).toBe(2);
    expect(svc.owner).toBeUndefined();
    const after = edit.changes[0]!.after!;
    // Untouched parts read exactly as before.
    expect(after).toContain('    - external: { name: postgres-main, kind: postgresql }');
    expect(after).toContain('      target: 99.9%');
    expect(edit.changes[0]!.diff).toContain('-  tier: critical');
  });

  it('only changes the fields a service has', async () => {
    await refused(
      { kind: 'service.update', name: 'payment-api', set: { 'metadata.name': 'x' } },
      'unsupported',
    );
    await refused(
      { kind: 'service.update', name: 'payment-api', set: { tier: 'super' } },
      'invalid',
    );
    await refused({ kind: 'service.update', name: 'nope', set: { tier: 'standard' } }, 'not_found');
  });

  it('removes an application with its reliability goals, unless another one depends on it', async () => {
    await refused({ kind: 'service.remove', name: 'ledger-api' }, 'invalid', /ledger-api/);
    const { edit, workspace } = await edited({ kind: 'service.remove', name: 'payment-api' });
    expect(edit.changes.map((c) => [c.path, c.after])).toEqual([
      ['services/payment-api.yaml', null],
      ['slos/payment-api-latency.yaml', null],
    ]);
    expect(workspace.services.map((s) => s.name)).toEqual(['ledger-api']);
  });
});

describe('editing reliability goals', () => {
  it('changes a goal defined inside the service file and one in its own file', async () => {
    const inline = await edited({
      kind: 'slo.update',
      service: 'payment-api',
      name: 'availability',
      set: { target: 99.5 },
    });
    expect(inline.edit.changes[0]!.path).toBe('services/payment-api.yaml');
    const standalone = await edited({
      kind: 'slo.update',
      service: 'payment-api',
      name: 'latency',
      set: { target: 98, window: '28d' },
    });
    expect(standalone.edit.changes[0]!.path).toBe('slos/payment-api-latency.yaml');
    const slo = standalone.workspace.services
      .find((s) => s.name === 'payment-api')!
      .slos.find((s) => s.name === 'latency')!;
    expect([slo.target, slo.window]).toEqual([98, '28d']);
  });

  it('removes goals, wherever they are written', async () => {
    const { edit } = await edited({ kind: 'slo.remove', service: 'payment-api', name: 'latency' });
    expect(edit.changes).toEqual([
      expect.objectContaining({ path: 'slos/payment-api-latency.yaml', after: null }),
    ]);
    // The runbook of the availability goal refers to it, so removing it is refused.
    await refused({ kind: 'slo.remove', service: 'payment-api', name: 'availability' }, 'invalid');
  });

  it('adds a goal as its own file', async () => {
    const { workspace } = await edited({
      kind: 'slo.add',
      slo: {
        service: 'ledger-api',
        name: 'availability',
        sli: { type: 'availability' },
        target: 99.9,
        window: '30d',
      },
    });
    expect(workspace.services.find((s) => s.name === 'ledger-api')!.slos).toHaveLength(1);
  });
});

describe('editing workspace settings, teams and notification channels', () => {
  it('changes settings', async () => {
    const { workspace } = await edited({
      kind: 'workspace.update',
      set: { level: 2, 'retention.logs': '14d', 'infrastructure.containers': true },
    });
    expect(workspace.level).toBe(2);
    expect(workspace.retention.logs).toBe('14d');
  });

  it('adds and removes notification channels, never one a team still uses', async () => {
    const { workspace } = await edited({
      kind: 'receiver.add',
      receiver: { name: 'ops-webhook', type: 'webhook', url: 'https://hooks.example.com/raion' },
    });
    expect(workspace.receivers.map((r) => r.name)).toContain('ops-webhook');
    await refused({ kind: 'receiver.remove', name: 'payments-slack' }, 'invalid', /payments-slack/);
    await refused(
      {
        kind: 'receiver.add',
        receiver: { name: 'leak', type: 'slack', webhookUrl: 'https://hooks.slack.com/x' },
      },
      'invalid',
    );
  });

  it('adds teams and refuses to remove one that owns applications', async () => {
    await edited({ kind: 'team.add', team: { name: 'data', route: 'payments-slack' } });
    await refused({ kind: 'team.remove', name: 'payments' }, 'invalid', /payments/);
  });
});

describe('writing edits', () => {
  it('writes, deletes, and never overwrites a file someone else changed', async () => {
    const edit = planEdit(await files(), { kind: 'service.remove', name: 'payment-api' });
    await writeEdit(dir, edit);
    expect(existsSync(join(dir, 'services', 'payment-api.yaml'))).toBe(false);

    const update = planEdit(await files(), {
      kind: 'service.update',
      name: 'ledger-api',
      set: { tier: 'critical' },
    });
    const path = join(dir, 'services', 'ledger-api.yaml');
    await writeFile(path, `${await readFile(path, 'utf8')}# a colleague's edit\n`);
    await expect(writeEdit(dir, update)).rejects.toMatchObject({ code: 'conflict' });
    expect(await readFile(path, 'utf8')).toContain("a colleague's edit");
  });
});

describe('editing outside checks', () => {
  it('adds checks to an application and turns one into a remote application', async () => {
    const { workspace } = await edited({
      kind: 'service.update',
      name: 'ledger-api',
      set: { checks: [{ url: 'https://ledger.example.com/health' }] },
    });
    expect(workspace.services.find((s) => s.name === 'ledger-api')!.checks).toHaveLength(1);
    const remote = await edited({
      kind: 'service.add',
      service: {
        name: 'storefront',
        type: 'web',
        runtime: { type: 'remote' },
        checks: [{ url: 'https://shop.example.com' }],
      },
    });
    expect(remote.workspace.services.find((s) => s.name === 'storefront')!.runtime.type).toBe(
      'remote',
    );
  });
});
