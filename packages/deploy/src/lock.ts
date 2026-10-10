import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';

export interface LockInfo {
  pid: number;
  host: string;
  owner: string;
  operation: string;
  startedAt: string;
  /** Refreshed while the lock is held. Older locks do not have it. */
  heartbeatAt?: string;
}

const HEARTBEAT_MS = 30_000;
/** A lock not refreshed for this long belongs to a process that died or hung. */
const STALE_MS = 2 * 60_000;

export class LockedError extends Error {
  constructor(readonly holder: LockInfo) {
    super(`${holder.operation} already in progress by ${holder.owner} (since ${holder.startedAt})`);
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(path: string): LockInfo | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LockInfo;
  } catch {
    return undefined;
  }
}

function isStale(holder: LockInfo | undefined): boolean {
  if (!holder) return true;
  if (holder.host === hostname() && !isProcessAlive(holder.pid)) return true;
  return Date.now() - Date.parse(holder.heartbeatAt ?? holder.startedAt) > STALE_MS;
}

/** Who holds the lock now, if anyone (a stale lock counts as free). */
export function lockHolder(path: string): LockInfo | undefined {
  const holder = readLock(path);
  return holder && !isStale(holder) ? holder : undefined;
}

/**
 * Exclusive lock for operations that change the runtime (apply, rollback, repair, destroy), so
 * two people, or a person and CI, cannot change it at the same time. The holder refreshes the
 * lock while it works, however long that takes; a lock is only taken over when its process has
 * died (same host) or it has not been refreshed for 2 minutes.
 */
export function acquireLock(path: string, owner: string, operation: string): () => void {
  mkdirSync(dirname(path), { recursive: true });
  const info: LockInfo = {
    pid: process.pid,
    host: hostname(),
    owner,
    operation,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, JSON.stringify(info));
      closeSync(fd);
      const heartbeat = setInterval(() => {
        // Only refresh a lock that is still ours.
        if (readLock(path)?.pid !== info.pid) return;
        info.heartbeatAt = new Date().toISOString();
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(info));
        renameSync(tmp, path);
      }, HEARTBEAT_MS);
      heartbeat.unref();
      return () => {
        clearInterval(heartbeat);
        if (readLock(path)?.pid === info.pid) rmSync(path, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = readLock(path);
      if (!isStale(holder)) throw new LockedError(holder!);
      rmSync(path, { force: true });
    }
  }
  throw new Error('could not acquire the workspace lock');
}
