import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { isProcessAlive } from './lock.js';
import type { StatePaths } from './state.js';

/** Long-running work on the observability stack, from any interface. */
export type OperationKind = 'apply' | 'rollback' | 'repair' | 'destroy' | 'verify' | 'connect';
/** Where the operation was started. */
export type OperationInterface = 'cli' | 'web' | 'api';
export type OperationState = 'running' | 'succeeded' | 'failed' | 'interrupted';

/** Operations that change the running stack; only one runs at a time. */
export const CHANGING_OPERATIONS: readonly OperationKind[] = [
  'apply',
  'rollback',
  'repair',
  'destroy',
  // Restarting an application with Raion's settings, so two people never do it at once.
  'connect',
];

export interface OperationRecord {
  id: string;
  kind: OperationKind;
  via: OperationInterface;
  actor: string;
  host: string;
  pid: number;
  startedAt: string;
  /** Refreshed while the operation runs, so other processes can tell it is still alive. */
  heartbeatAt: string;
  finishedAt?: string;
  state: OperationState;
  log: string[];
  error?: string;
  /** A short, structured outcome (release id, failed checks, …). */
  result?: unknown;
}

const HEARTBEAT_MS = 15_000;
/** Without a heartbeat for this long, a "running" operation on another host is considered dead. */
const DEAD_AFTER_MS = 90_000;
const KEEP = 200;
let sequence = 0;
const MAX_LOG_LINES = 2000;

export interface OperationHandle {
  readonly id: string;
  log(message: string): void;
  succeed(result?: unknown): void;
  fail(error: unknown, result?: unknown): void;
}

/**
 * The record of long-running operations, shared by the CLI and the web server: both write here
 * through the same functions, and both read it, so a deployment started in a terminal is visible
 * (and blocks a second one) in the web UI, and the other way round.
 */
export class OperationJournal {
  readonly dir: string;

  constructor(paths: StatePaths) {
    this.dir = join(paths.root, 'operations');
  }

  /** Records a new operation and returns the handle to report its progress and outcome. */
  begin(meta: { kind: OperationKind; via: OperationInterface; actor: string }): OperationHandle {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const now = new Date();
    const record: OperationRecord = {
      // Sorts by start time: milliseconds, then a per-process sequence for the same millisecond.
      id: `${now.toISOString().replace(/[-:.]/g, '')}${String(sequence++ % 100).padStart(2, '0')}-${randomBytes(3).toString('hex')}`,
      ...meta,
      host: hostname(),
      pid: process.pid,
      startedAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      state: 'running',
      log: [],
    };
    let pending: NodeJS.Timeout | undefined;
    const flush = () => {
      if (pending) clearTimeout(pending);
      pending = undefined;
      record.heartbeatAt = new Date().toISOString();
      this.#write(record);
    };
    flush();
    const heartbeat = setInterval(flush, HEARTBEAT_MS);
    heartbeat.unref();
    const end = (state: 'succeeded' | 'failed', extra: Partial<OperationRecord>) => {
      if (record.state !== 'running') return;
      clearInterval(heartbeat);
      Object.assign(record, extra, { state, finishedAt: new Date().toISOString() });
      flush();
      this.#prune();
    };
    return {
      id: record.id,
      log: (message) => {
        if (record.state !== 'running') return;
        if (record.log.length < MAX_LOG_LINES) record.log.push(message);
        // Batch writes: progress lines often come in bursts.
        pending ??= setTimeout(flush, 300);
      },
      succeed: (result) => end('succeeded', result === undefined ? {} : { result }),
      fail: (error, result) =>
        end('failed', {
          error: error instanceof Error ? error.message : String(error),
          ...(result === undefined ? {} : { result }),
        }),
    };
  }

  /** Runs `work` as a recorded operation; its outcome is recorded whatever happens. */
  async run<T>(
    meta: { kind: OperationKind; via: OperationInterface; actor: string },
    work: (log: (message: string) => void, handle: OperationHandle) => Promise<T>,
    outcome: (result: T) => unknown = () => undefined,
  ): Promise<T> {
    const handle = this.begin(meta);
    try {
      const result = await work((m) => handle.log(m), handle);
      handle.succeed(outcome(result));
      return result;
    } catch (error) {
      handle.fail(error, (error as { details?: unknown }).details);
      throw error;
    }
  }

  get(id: string): OperationRecord | undefined {
    if (!/^[0-9TZ]+-[0-9a-f]{6}$/.test(id)) return undefined;
    try {
      return this.#current(
        JSON.parse(readFileSync(join(this.dir, `${id}.json`), 'utf8')) as OperationRecord,
      );
    } catch {
      return undefined;
    }
  }

  /** Most recent first. */
  list(limit = 50): OperationRecord[] {
    return this.#ids()
      .slice(-limit)
      .reverse()
      .map((id) => this.get(id))
      .filter((r): r is OperationRecord => r !== undefined);
  }

  /** An operation that changes the stack and is still running, in any process. */
  active(): OperationRecord | undefined {
    return this.list(20).find((r) => r.state === 'running' && CHANGING_OPERATIONS.includes(r.kind));
  }

  /** A "running" record whose process is gone is reported as interrupted. */
  #current(record: OperationRecord): OperationRecord {
    if (record.state !== 'running') return record;
    const silent = Date.now() - Date.parse(record.heartbeatAt) > DEAD_AFTER_MS;
    const dead = record.host === hostname() && !isProcessAlive(record.pid);
    return dead || silent ? { ...record, state: 'interrupted' } : record;
  }

  #ids(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5))
        .sort();
    } catch {
      return [];
    }
  }

  #write(record: OperationRecord): void {
    // Write then rename, so readers never see a half-written file.
    const file = join(this.dir, `${record.id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    renameSync(tmp, file);
  }

  #prune(): void {
    const ids = this.#ids();
    for (const id of ids.slice(0, Math.max(0, ids.length - KEEP))) {
      rmSync(join(this.dir, `${id}.json`), { force: true });
    }
  }
}
