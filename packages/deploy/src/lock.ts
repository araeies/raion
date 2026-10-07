import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';

interface LockInfo {
  pid: number;
  host: string;
  owner: string;
  operation: string;
  startedAt: string;
}

const STALE_MS = 30 * 60_000;

export class LockedError extends Error {
  constructor(readonly holder: LockInfo) {
    super(`${holder.operation} already in progress by ${holder.owner} (since ${holder.startedAt})`);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Exclusive lock for operations that change the runtime (apply, rollback, destroy), so two
 * people (or a person and CI) cannot deploy at the same time. Stale locks left by a crashed
 * process on this host, or older than 30 minutes, are taken over.
 */
export function acquireLock(path: string, owner: string, operation: string): () => void {
  mkdirSync(dirname(path), { recursive: true });
  const info: LockInfo = {
    pid: process.pid,
    host: hostname(),
    owner,
    operation,
    startedAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, JSON.stringify(info));
      closeSync(fd);
      return () => {
        rmSync(path, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let holder: LockInfo | undefined;
      try {
        holder = JSON.parse(readFileSync(path, 'utf8')) as LockInfo;
      } catch {
        holder = undefined;
      }
      const stale =
        !holder ||
        Date.now() - Date.parse(holder.startedAt) > STALE_MS ||
        (holder.host === info.host && !isAlive(holder.pid));
      if (!stale) throw new LockedError(holder!);
      rmSync(path, { force: true });
    }
  }
  throw new Error('could not acquire the workspace lock');
}
