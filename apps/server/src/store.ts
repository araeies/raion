import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const ROLES = ['viewer', 'editor', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export function roleAtLeast(role: Role, required: Role): boolean {
  return ROLES.indexOf(role) >= ROLES.indexOf(required);
}

export interface User {
  id: number;
  username: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
}

interface UserRow {
  id: number;
  username: string;
  role: Role;
  disabled: number;
  created_at: string;
  password_hash: string;
  failed_attempts: number;
  locked_until: string | null;
}

export interface UserWithSecrets extends User {
  passwordHash: string;
  failedAttempts: number;
  lockedUntil: Date | null;
}

export interface SessionRow {
  userId: number;
  createdAt: Date;
  lastSeenAt: Date;
}

export interface AlertRecordInput {
  fingerprint: string;
  startsAt: string;
  alertname: string;
  severity?: string;
  service?: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  /** active, suppressed (silenced or inhibited) */
  state: string;
}

export interface AlertRecord extends Omit<AlertRecordInput, 'severity' | 'service'> {
  severity: string | null;
  service: string | null;
  firstSeen: string;
  lastSeen: string;
  resolvedAt: string | null;
}

interface AlertRow {
  fingerprint: string;
  starts_at: string;
  alertname: string;
  severity: string | null;
  service: string | null;
  labels: string;
  annotations: string;
  first_seen: string;
  last_seen: string;
  resolved_at: string | null;
  state: string;
}

export interface AuditEntry {
  id: number;
  ts: string;
  actor: string | null;
  action: string;
  target: string | null;
  outcome: 'success' | 'failure';
  ip: string | null;
  details: Record<string, unknown> | null;
}

const MIGRATIONS = [
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY,
     username TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'admin')),
     disabled INTEGER NOT NULL DEFAULT 0,
     failed_attempts INTEGER NOT NULL DEFAULT 0,
     locked_until TEXT,
     created_at TEXT NOT NULL
   );
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at TEXT NOT NULL,
     last_seen_at TEXT NOT NULL
   );
   CREATE INDEX sessions_user ON sessions(user_id);
   CREATE TABLE audit_log (
     id INTEGER PRIMARY KEY,
     ts TEXT NOT NULL,
     actor TEXT,
     action TEXT NOT NULL,
     target TEXT,
     outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
     ip TEXT,
     details TEXT
   );`,
  `CREATE TABLE alerts (
     fingerprint TEXT NOT NULL,
     starts_at TEXT NOT NULL,
     alertname TEXT NOT NULL,
     severity TEXT,
     service TEXT,
     labels TEXT NOT NULL,
     annotations TEXT NOT NULL,
     first_seen TEXT NOT NULL,
     last_seen TEXT NOT NULL,
     resolved_at TEXT,
     state TEXT NOT NULL,
     PRIMARY KEY (fingerprint, starts_at)
   );
   CREATE INDEX alerts_resolved ON alerts(resolved_at);`,
];

/**
 * Operational data only (users, sessions, audit log). Observability configuration never
 * lives here; it lives in the workspace files.
 */
export class Store {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.#db = new DatabaseSync(path);
    if (path !== ':memory:') {
      chmodSync(path, 0o600);
    }
    this.#db.exec(
      'PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;',
    );
    this.#migrate();
  }

  #migrate(): void {
    const version = (this.#db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    for (let i = version; i < MIGRATIONS.length; i++) {
      this.#db.exec('BEGIN');
      try {
        this.#db.exec(MIGRATIONS[i]!);
        this.#db.exec(`PRAGMA user_version = ${i + 1}`);
        this.#db.exec('COMMIT');
      } catch (error) {
        this.#db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  close(): void {
    this.#db.close();
  }

  ping(): boolean {
    return (this.#db.prepare('SELECT 1 AS ok').get() as { ok: number }).ok === 1;
  }

  // Users --------------------------------------------------------------------------------

  countUsers(): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  countActiveAdmins(): number {
    return (
      this.#db
        .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0")
        .get() as {
        n: number;
      }
    ).n;
  }

  createUser(username: string, passwordHash: string, role: Role): User {
    const createdAt = new Date().toISOString();
    const info = this.#db
      .prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
      .run(username, passwordHash, role, createdAt);
    return { id: Number(info.lastInsertRowid), username, role, disabled: false, createdAt };
  }

  findUser(username: string): UserWithSecrets | undefined {
    const row = this.#db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
      UserRow | undefined;
    return row ? toUserWithSecrets(row) : undefined;
  }

  getUser(id: number): User | undefined {
    const row = this.#db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? toUser(row) : undefined;
  }

  listUsers(): User[] {
    return (
      this.#db.prepare('SELECT * FROM users ORDER BY username').all() as unknown as UserRow[]
    ).map(toUser);
  }

  updateUser(
    id: number,
    changes: { role?: Role; disabled?: boolean; passwordHash?: string },
  ): void {
    if (changes.role !== undefined) {
      this.#db.prepare('UPDATE users SET role = ? WHERE id = ?').run(changes.role, id);
    }
    if (changes.disabled !== undefined) {
      this.#db
        .prepare('UPDATE users SET disabled = ? WHERE id = ?')
        .run(changes.disabled ? 1 : 0, id);
    }
    if (changes.passwordHash !== undefined) {
      this.#db
        .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
        .run(changes.passwordHash, id);
    }
  }

  recordLoginFailure(id: number, lockAfter: number, lockForMs: number): void {
    const row = this.#db.prepare('SELECT failed_attempts FROM users WHERE id = ?').get(id) as
      { failed_attempts: number } | undefined;
    const attempts = (row?.failed_attempts ?? 0) + 1;
    const lockedUntil =
      attempts >= lockAfter ? new Date(Date.now() + lockForMs).toISOString() : null;
    this.#db
      .prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
      .run(lockedUntil ? 0 : attempts, lockedUntil, id);
  }

  recordLoginSuccess(id: number): void {
    this.#db
      .prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?')
      .run(id);
  }

  // Sessions -----------------------------------------------------------------------------

  createSession(tokenHash: string, userId: number): void {
    const now = new Date().toISOString();
    this.#db
      .prepare(
        'INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)',
      )
      .run(tokenHash, userId, now, now);
  }

  getSession(tokenHash: string): SessionRow | undefined {
    const row = this.#db
      .prepare('SELECT user_id, created_at, last_seen_at FROM sessions WHERE token_hash = ?')
      .get(tokenHash) as { user_id: number; created_at: string; last_seen_at: string } | undefined;
    return row
      ? {
          userId: row.user_id,
          createdAt: new Date(row.created_at),
          lastSeenAt: new Date(row.last_seen_at),
        }
      : undefined;
  }

  touchSession(tokenHash: string): void {
    this.#db
      .prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?')
      .run(new Date().toISOString(), tokenHash);
  }

  deleteSession(tokenHash: string): void {
    this.#db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteUserSessions(userId: number): void {
    this.#db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  deleteExpiredSessions(idleBefore: Date, createdBefore: Date): number {
    const info = this.#db
      .prepare('DELETE FROM sessions WHERE last_seen_at < ? OR created_at < ?')
      .run(idleBefore.toISOString(), createdBefore.toISOString());
    return Number(info.changes);
  }

  // Alert history ------------------------------------------------------------------------

  /** Records the alerts Alertmanager currently holds and resolves the ones that disappeared. */
  syncAlerts(current: AlertRecordInput[], now = new Date()): void {
    const ts = now.toISOString();
    this.#db.exec('BEGIN');
    try {
      const upsert = this.#db.prepare(
        `INSERT INTO alerts (fingerprint, starts_at, alertname, severity, service, labels, annotations, first_seen, last_seen, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (fingerprint, starts_at) DO UPDATE SET
           last_seen = excluded.last_seen, annotations = excluded.annotations, state = excluded.state, resolved_at = NULL`,
      );
      for (const a of current) {
        upsert.run(
          a.fingerprint,
          a.startsAt,
          a.alertname,
          a.severity ?? null,
          a.service ?? null,
          JSON.stringify(a.labels),
          JSON.stringify(a.annotations),
          ts,
          ts,
          a.state,
        );
      }
      const keys = new Set(current.map((a) => `${a.fingerprint}|${a.startsAt}`));
      const open = this.#db
        .prepare('SELECT fingerprint, starts_at FROM alerts WHERE resolved_at IS NULL')
        .all() as {
        fingerprint: string;
        starts_at: string;
      }[];
      const resolve = this.#db.prepare(
        'UPDATE alerts SET resolved_at = ? WHERE fingerprint = ? AND starts_at = ?',
      );
      for (const row of open) {
        if (!keys.has(`${row.fingerprint}|${row.starts_at}`))
          resolve.run(ts, row.fingerprint, row.starts_at);
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  listAlerts(options: { open: boolean; limit: number; service?: string }): AlertRecord[] {
    const where = [options.open ? 'resolved_at IS NULL' : 'resolved_at IS NOT NULL'];
    const params: (string | number)[] = [];
    if (options.service) {
      where.push('service = ?');
      params.push(options.service);
    }
    const rows = this.#db
      .prepare(
        `SELECT * FROM alerts WHERE ${where.join(' AND ')} ORDER BY ${options.open ? 'starts_at' : 'resolved_at'} DESC LIMIT ?`,
      )
      .all(...params, options.limit) as unknown as AlertRow[];
    return rows.map((r) => ({
      fingerprint: r.fingerprint,
      alertname: r.alertname,
      severity: r.severity,
      service: r.service,
      labels: JSON.parse(r.labels) as Record<string, string>,
      annotations: JSON.parse(r.annotations) as Record<string, string>,
      startsAt: r.starts_at,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      resolvedAt: r.resolved_at,
      state: r.state,
    }));
  }

  pruneAlerts(olderThan: Date): void {
    this.#db
      .prepare('DELETE FROM alerts WHERE resolved_at IS NOT NULL AND resolved_at < ?')
      .run(olderThan.toISOString());
  }

  // Audit --------------------------------------------------------------------------------

  audit(entry: Omit<AuditEntry, 'id' | 'ts'>): void {
    this.#db
      .prepare(
        'INSERT INTO audit_log (ts, actor, action, target, outcome, ip, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        new Date().toISOString(),
        entry.actor,
        entry.action,
        entry.target,
        entry.outcome,
        entry.ip,
        entry.details ? JSON.stringify(entry.details) : null,
      );
  }

  listAudit(limit: number, beforeId?: number): AuditEntry[] {
    const rows = (beforeId
      ? this.#db
          .prepare('SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?')
          .all(beforeId, limit)
      : this.#db
          .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?')
          .all(limit)) as unknown as (Omit<AuditEntry, 'details'> & { details: string | null })[];
    return rows.map((r) => ({
      ...r,
      details: r.details ? (JSON.parse(r.details) as Record<string, unknown>) : null,
    }));
  }
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    disabled: row.disabled === 1,
    createdAt: row.created_at,
  };
}

function toUserWithSecrets(row: UserRow): UserWithSecrets {
  return {
    ...toUser(row),
    passwordHash: row.password_hash,
    failedAttempts: row.failed_attempts,
    lockedUntil: row.locked_until ? new Date(row.locked_until) : null,
  };
}
