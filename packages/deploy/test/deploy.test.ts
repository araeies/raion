import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateRuntime, validateSources, type ResolvedWorkspace } from '@raion/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireLock,
  ApplyError,
  computePlan,
  DockerComposeTarget,
  LockedError,
  lockHolder,
  OperationJournal,
  ReleaseStore,
  StatePaths,
  type ExecResult,
  type Runner,
} from '../src/index.js';

function workspace(spec = '', gatewayPort = 7601): ResolvedWorkspace {
  const result = validateSources([
    {
      path: 'raion.yaml',
      content: `apiVersion: raion/v1alpha1\nkind: Workspace\nmetadata:\n  name: t\nspec:\n  target:\n    type: docker-compose\n    compose: { gatewayPort: ${gatewayPort} }\n${spec}`,
    },
  ]);
  if (!result.workspace) throw new Error(JSON.stringify(result.diagnostics));
  return result.workspace;
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'raion-deploy-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('computePlan', () => {
  it('starts everything on first deployment', () => {
    const plan = computePlan(generateRuntime(workspace()), undefined);
    expect(plan.from).toBeUndefined();
    expect(plan.components.every((c) => c.action === 'add')).toBe(true);
    expect(plan.hostAccess).toEqual([
      'node-exporter: shares the host PID namespace; reads the host filesystem (read-only)',
    ]);
    expect(plan.securityRelevant).toEqual([]);
  });

  it('is empty when nothing changed', () => {
    const store = new ReleaseStore(new StatePaths(dir));
    const bundle = generateRuntime(workspace());
    const release = store.create(bundle, { createdBy: 'test', workspace: dir });
    const plan = computePlan(bundle, release);
    expect(plan.noChanges).toBe(true);
    expect(plan.components.every((c) => c.action === 'unchanged')).toBe(true);
  });

  it('restarts only the component whose configuration changed', () => {
    const store = new ReleaseStore(new StatePaths(dir));
    const before = store.create(generateRuntime(workspace()), {
      createdBy: 'test',
      workspace: dir,
    });
    const plan = computePlan(generateRuntime(workspace('  retention: { logs: 14d }\n')), before);
    const changed = plan.components.filter((c) => c.action !== 'unchanged');
    expect(changed).toEqual([
      { component: 'loki', action: 'restart', reasons: ['loki/loki.yaml changed'], privileges: [] },
    ]);
  });

  it('recreates a component whose container settings changed', () => {
    const store = new ReleaseStore(new StatePaths(dir));
    const before = store.create(generateRuntime(workspace()), {
      createdBy: 'test',
      workspace: dir,
    });
    const plan = computePlan(generateRuntime(workspace('  retention: { metrics: 30d }\n')), before);
    expect(plan.components.find((c) => c.component === 'prometheus')!.action).toBe('recreate');
  });

  it('flags privileged components and shrinking retention for approval', () => {
    const store = new ReleaseStore(new StatePaths(dir));
    const before = store.create(generateRuntime(workspace('  retention: { logs: 30d }\n')), {
      createdBy: 't',
      workspace: dir,
    });
    const plan = computePlan(
      generateRuntime(
        workspace('  retention: { logs: 7d }\n  infrastructure: { containers: true }\n'),
      ),
      before,
    );
    expect(plan.securityRelevant).toEqual([
      'cadvisor: runs privileged; reads Docker state and host /sys (read-only)',
    ]);
    expect(plan.dataAffecting).toEqual([
      'logs retention shrinks from 30d to 7d: older logs will be deleted',
    ]);
  });

  it('reports components that are no longer needed', () => {
    const store = new ReleaseStore(new StatePaths(dir));
    const before = store.create(generateRuntime(workspace('  features: { traces: true }\n')), {
      createdBy: 't',
      workspace: dir,
    });
    const plan = computePlan(generateRuntime(workspace()), before);
    expect(plan.components.find((c) => c.component === 'tempo')!.action).toBe('remove');
    expect(plan.dataAffecting[0]).toContain('tempo will be stopped');
  });
});

describe('ReleaseStore', () => {
  it('numbers releases, activates them into the runtime directory and removes stale files', async () => {
    const paths = new StatePaths(dir);
    const store = new ReleaseStore(paths);
    const first = store.create(generateRuntime(workspace('  features: { traces: true }\n')), {
      createdBy: 'a',
      workspace: dir,
    });
    store.activate(first.id);
    expect(store.currentId()).toBe(first.id);
    const second = store.create(generateRuntime(workspace()), { createdBy: 'b', workspace: dir });
    expect(second.seq).toBe(first.seq + 1);
    store.activate(second.id);
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(paths.runtime, 'tempo', 'tempo.yaml'))).toBe(false);
    expect(existsSync(join(paths.runtime, 'compose.yaml'))).toBe(true);
    expect(store.list().map((r) => r.id)).toEqual([second.id, first.id]);
  });

  it('rejects release ids that are not release ids', () => {
    expect(new ReleaseStore(new StatePaths(dir)).read('../secrets')).toBeUndefined();
  });
});

describe('workspace lock', () => {
  it('prevents concurrent operations and releases cleanly', () => {
    const path = join(dir, 'apply.lock');
    const release = acquireLock(path, 'alice', 'apply');
    expect(() => acquireLock(path, 'bob', 'apply')).toThrow(LockedError);
    release();
    acquireLock(path, 'bob', 'apply')();
  });

  it('takes over a lock left by a process that no longer exists', async () => {
    const path = join(dir, 'apply.lock');
    const { hostname } = await import('node:os');
    await writeFile(
      path,
      JSON.stringify({
        pid: 999_999_999,
        host: hostname(),
        owner: 'ghost',
        operation: 'apply',
        startedAt: new Date().toISOString(),
      }),
    );
    acquireLock(path, 'alice', 'apply')();
  });
});

describe('workspace lock over long operations', () => {
  const holderFile = (extra: Record<string, unknown>) =>
    JSON.stringify({
      pid: 12345,
      host: 'another-machine',
      owner: 'ci',
      operation: 'apply',
      startedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      ...extra,
    });

  it('never takes over a lock whose holder is still refreshing it, however long it runs', async () => {
    const path = join(dir, 'apply.lock');
    await writeFile(path, holderFile({ heartbeatAt: new Date().toISOString() }));
    expect(() => acquireLock(path, 'alice', 'apply')).toThrow(LockedError);
    expect(lockHolder(path)?.owner).toBe('ci');
  });

  it('takes over a lock that stopped being refreshed', async () => {
    const path = join(dir, 'apply.lock');
    await writeFile(
      path,
      holderFile({ heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString() }),
    );
    expect(lockHolder(path)).toBeUndefined();
    acquireLock(path, 'alice', 'apply')();
  });

  it('refreshes the lock while held', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'Date'] });
    try {
      const path = join(dir, 'apply.lock');
      const release = acquireLock(path, 'alice', 'apply');
      const before = JSON.parse(await readFile(path, 'utf8')) as { heartbeatAt: string };
      vi.advanceTimersByTime(31_000);
      const after = JSON.parse(await readFile(path, 'utf8')) as { heartbeatAt: string };
      expect(Date.parse(after.heartbeatAt)).toBeGreaterThan(Date.parse(before.heartbeatAt));
      release();
      expect(lockHolder(path)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('operation journal', () => {
  it('records operations from any interface, newest first, with their outcome', async () => {
    const journal = new OperationJournal(new StatePaths(dir));
    const result = await journal.run(
      { kind: 'apply', via: 'cli', actor: 'alice' },
      async (log) => {
        log('Starting components…');
        return { release: '0001' };
      },
      (r) => r,
    );
    expect(result).toEqual({ release: '0001' });
    await expect(
      journal.run({ kind: 'verify', via: 'web', actor: 'bob' }, () =>
        Promise.reject(new Error('traces did not arrive')),
      ),
    ).rejects.toThrow('traces did not arrive');
    const [verify, apply] = journal.list();
    expect(verify).toMatchObject({
      kind: 'verify',
      via: 'web',
      state: 'failed',
      error: 'traces did not arrive',
    });
    expect(apply).toMatchObject({
      kind: 'apply',
      via: 'cli',
      actor: 'alice',
      state: 'succeeded',
      log: ['Starting components…'],
      result: { release: '0001' },
    });
    expect(journal.get(apply!.id)?.finishedAt).toBeTruthy();
    expect(journal.active()).toBeUndefined();
  });

  it('shows a running change to every process, and spots one whose process died', async () => {
    const journal = new OperationJournal(new StatePaths(dir));
    const handle = journal.begin({ kind: 'apply', via: 'web', actor: 'alice' });
    // Another process (the CLI, say) reading the same folder sees it running.
    expect(new OperationJournal(new StatePaths(dir)).active()?.id).toBe(handle.id);
    handle.succeed();
    expect(journal.active()).toBeUndefined();

    const { hostname } = await import('node:os');
    await mkdir(journal.dir, { recursive: true });
    await writeFile(
      join(journal.dir, '20260101T000000Z-abcdef.json'),
      JSON.stringify({
        id: '20260101T000000Z-abcdef',
        kind: 'rollback',
        via: 'cli',
        actor: 'ghost',
        host: hostname(),
        pid: 999_999_999,
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        state: 'running',
        log: [],
      }),
    );
    expect(journal.get('20260101T000000Z-abcdef')?.state).toBe('interrupted');
    expect(journal.active()).toBeUndefined();
    expect(journal.get('../../etc/passwd')).toBeUndefined();
  });
});

// ----- apply / rollback with a fake Docker and a fake gateway ------------------------------

const portsFree = { isPortFree: () => Promise.resolve(true) };

class FakeDocker implements Runner {
  calls: string[][] = [];
  failValidationFor?: string;
  onUp?: (count: number) => void;
  ups = 0;
  services = new Set<string>();
  run(args: string[]): Promise<ExecResult> {
    this.calls.push(args);
    const ok = (stdout = ''): Promise<ExecResult> =>
      Promise.resolve({ stdout, stderr: '', code: 0 });
    if (args[0] === 'version') return ok('29.0.0');
    if (args[0] === 'run') {
      const image = args.find((a) => a.includes('@sha256:')) ?? '';
      if (this.failValidationFor && image.includes(this.failValidationFor)) {
        return Promise.resolve({ stdout: '', stderr: 'FAILED: invalid config', code: 1 });
      }
      return ok();
    }
    if (args[0] === 'compose') {
      if (args.includes('version')) return ok('2.40.0');
      if (args.includes('ps')) {
        return ok(
          [...this.services]
            .map((s) => JSON.stringify({ Service: s, State: 'running' }))
            .join('\n'),
        );
      }
      if (args.includes('up')) {
        this.ups += 1;
        this.onUp?.(this.ups);
        for (const s of [
          'otel-collector',
          'prometheus',
          'loki',
          'grafana',
          'alertmanager',
          'node-exporter',
          'gateway',
        ])
          this.services.add(s);
      }
      return ok();
    }
    return ok();
  }
}

/** Answers readiness checks like the real gateway would, if the token matches. */
async function fakeGateway(
  isReady: (path: string) => boolean,
): Promise<{ server: Server; port: number; tokenSeen: string[] }> {
  const tokenSeen: string[] = [];
  const server = createServer((req, res) => {
    tokenSeen.push(String(req.headers['x-raion-gateway-token'] ?? ''));
    if (req.url?.startsWith('/prometheus/api/v1/targets')) {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          data: {
            activeTargets: [
              { labels: { job: 'prometheus' }, health: 'up', lastError: '', lastScrape: '' },
            ],
          },
        }),
      );
      return;
    }
    if (req.url === '/alertmanager/api/v2/alerts') {
      // A healthy stack: the Watchdog alert has reached Alertmanager.
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([{ labels: { alertname: 'Watchdog' }, status: { state: 'active' } }]));
      return;
    }
    res.statusCode = isReady(req.url ?? '') ? 200 : 503;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, tokenSeen };
}

describe('DockerComposeTarget', () => {
  it('validates, deploys, waits for readiness and records the release', async () => {
    const gw = await fakeGateway(() => true);
    try {
      const ws = workspace('', gw.port);
      const docker = new FakeDocker();
      const target = new DockerComposeTarget(dir, ws, docker, portsFree);
      const result = await target.apply(generateRuntime(ws), {
        actor: 'test',
        readinessTimeoutMs: 5000,
      });
      expect(target.releases.currentId()).toBe(result.release.id);
      expect(result.toolChecks.every((c) => c.ok)).toBe(true);
      expect(docker.calls.some((c) => c.includes('up'))).toBe(true);
      // Readiness checks carried the secret gateway token.
      expect(new Set(gw.tokenSeen).size).toBe(1);
      expect(gw.tokenSeen[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // Validation containers have no network.
      for (const call of docker.calls.filter((c) => c[0] === 'run')) expect(call).toContain('none');
    } finally {
      gw.server.close();
    }
  });

  it('changes nothing when a component validator rejects the configuration', async () => {
    const ws = workspace();
    const docker = new FakeDocker();
    docker.failValidationFor = 'prom/prometheus';
    const target = new DockerComposeTarget(dir, ws, docker, portsFree);
    const error = await target
      .apply(generateRuntime(ws), { actor: 'test' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApplyError);
    expect((error as ApplyError).message).toContain('promtool check config');
    expect(target.releases.currentId()).toBeUndefined();
    expect(docker.calls.some((c) => c.includes('up'))).toBe(false);
  });

  it('rolls back to the previous release when the new one does not become ready', async () => {
    let lokiReady = true;
    const gw = await fakeGateway((path) => !path.startsWith('/loki') || lokiReady);
    try {
      const ws1 = workspace('', gw.port);
      const docker = new FakeDocker();
      const first = await new DockerComposeTarget(dir, ws1, docker, portsFree).apply(
        generateRuntime(ws1),
        { actor: 't', readinessTimeoutMs: 5000 },
      );

      lokiReady = false;
      const ws2 = workspace('  retention: { logs: 14d }\n', gw.port);
      const target = new DockerComposeTarget(dir, ws2, docker, portsFree);
      // Loki recovers once the old configuration is back (third "up": apply, apply, rollback).
      docker.onUp = (count) => {
        if (count === 3) lokiReady = true;
      };
      const error = (await target
        .apply(generateRuntime(ws2), { actor: 't', readinessTimeoutMs: 3000 })
        .catch((e: unknown) => e)) as ApplyError;
      expect(error).toBeInstanceOf(ApplyError);
      expect(error.message).toContain('did not become ready');
      expect(error.message).toContain(`Rolled back to release ${first.release.id}.`);
      expect(error.details.rolledBackTo).toBe(first.release.id);
      expect(target.releases.currentId()).toBe(first.release.id);
    } finally {
      gw.server.close();
    }
  }, 30_000);

  it('refuses privileged components without approval', async () => {
    const ws = workspace('  infrastructure: { containers: true }\n');
    const target = new DockerComposeTarget(dir, ws, new FakeDocker(), portsFree);
    await expect(target.apply(generateRuntime(ws), { actor: 't' })).rejects.toThrow(
      /--allow-privileged/,
    );
  });
});

describe('first run on a new machine', () => {
  /** A machine with no images yet; pulling either works or fails. */
  class EmptyDocker extends FakeDocker {
    present = new Set<string>();
    pullFails = false;
    override run(args: string[]): Promise<ExecResult> {
      if (args[0] === 'image' && args[1] === 'inspect') {
        this.calls.push(args);
        const found = this.present.has(args.at(-1)!);
        return Promise.resolve({
          stdout: '',
          stderr: found ? '' : 'No such image',
          code: found ? 0 : 1,
        });
      }
      if (args[0] === 'pull') {
        this.calls.push(args);
        if (this.pullFails) {
          return Promise.resolve({
            stdout: '',
            stderr:
              'Error response from daemon: Get "https://registry-1.docker.io/v2/": dial tcp: i/o timeout',
            code: 1,
          });
        }
        this.present.add(args.at(-1)!);
        return Promise.resolve({ stdout: args.at(-1)!, stderr: '', code: 0 });
      }
      return super.run(args);
    }
  }

  it('downloads missing images one at a time before validating', async () => {
    const gw = await fakeGateway(() => true);
    try {
      const ws = workspace('', gw.port);
      const docker = new EmptyDocker();
      const log: string[] = [];
      const target = new DockerComposeTarget(dir, ws, docker, portsFree);
      await target.apply(generateRuntime(ws), {
        actor: 'test',
        readinessTimeoutMs: 5000,
        onProgress: (m: string) => log.push(m),
      });
      const pulls = docker.calls.filter((c) => c[0] === 'pull');
      expect(pulls.length).toBeGreaterThan(5);
      const firstValidation = docker.calls.findIndex((c) => c[0] === 'run');
      const lastPull = docker.calls.findLastIndex((c) => c[0] === 'pull');
      expect(lastPull).toBeLessThan(firstValidation);
      expect(log.some((m) => /^Downloading image 1 of \d+: /.test(m))).toBe(true);

      // The next apply finds them all and downloads nothing.
      docker.calls = [];
      await target.apply(generateRuntime(ws), { actor: 'test', readinessTimeoutMs: 5000 });
      expect(docker.calls.some((c) => c[0] === 'pull')).toBe(false);
    } finally {
      gw.server.close();
    }
  });

  it('stops with a clear message when an image cannot be downloaded', async () => {
    const ws = workspace();
    const docker = new EmptyDocker();
    docker.pullFails = true;
    const target = new DockerComposeTarget(dir, ws, docker, portsFree);
    const error = await target
      .apply(generateRuntime(ws), { actor: 'test' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApplyError);
    expect((error as Error).message).toMatch(/could not download .*\n.*i\/o timeout/s);
    expect((error as Error).message).toMatch(/Docker Hub/);
    expect((error as Error).message).toMatch(/Nothing was changed/);
    // Nothing was validated or started.
    expect(docker.calls.some((c) => c[0] === 'run' || c.includes('up'))).toBe(false);
  });
});
