import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DEFAULT_SCRYPT, hashPassword, verifyPassword, type ScryptParams } from './passwords.js';
import type { Role, Store, User } from './store.js';

export const USERNAME = /^[a-z0-9][a-z0-9._-]{1,63}$/;

export interface AuthSettings {
  sessionIdleMs: number;
  sessionMaxMs: number;
  lockAfterFailures: number;
  lockForMs: number;
  setupTokenTtlMs: number;
  scrypt: ScryptParams;
}

export const DEFAULT_AUTH: AuthSettings = {
  sessionIdleMs: 12 * 3_600_000,
  sessionMaxMs: 7 * 86_400_000,
  lockAfterFailures: 10,
  lockForMs: 15 * 60_000,
  setupTokenTtlMs: 30 * 60_000,
  scrypt: DEFAULT_SCRYPT,
};

export type LoginResult =
  | { ok: true; user: User; token: string }
  | { ok: false; reason: 'invalid' | 'locked' | 'disabled' };

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export class AuthService {
  #setup: { hash: Buffer; expiresAt: number } | undefined;
  /** Precomputed hash for unknown users, so response time does not reveal which usernames exist. */
  #dummyHash: Promise<string> | undefined;

  constructor(
    readonly store: Store,
    readonly settings: AuthSettings = DEFAULT_AUTH,
  ) {}

  hashPassword(password: string): Promise<string> {
    return hashPassword(password, this.settings.scrypt);
  }

  // First-run setup -----------------------------------------------------------------------

  needsSetup(): boolean {
    return this.store.countUsers() === 0;
  }

  /** Issues a one-time setup token. Only possible while no users exist. */
  issueSetupToken(): string | undefined {
    if (!this.needsSetup()) return undefined;
    const token = newToken();
    this.#setup = {
      hash: createHash('sha256').update(token).digest(),
      expiresAt: Date.now() + this.settings.setupTokenTtlMs,
    };
    return token;
  }

  consumeSetupToken(token: string): boolean {
    const setup = this.#setup;
    if (!setup || Date.now() > setup.expiresAt || !this.needsSetup()) return false;
    const candidate = createHash('sha256').update(token).digest();
    if (!timingSafeEqual(candidate, setup.hash)) return false;
    this.#setup = undefined;
    return true;
  }

  // Login and sessions ------------------------------------------------------------------

  async login(username: string, password: string): Promise<LoginResult> {
    const user = this.store.findUser(username);
    if (!user) {
      this.#dummyHash ??= hashPassword(randomBytes(16).toString('hex'), this.settings.scrypt);
      await verifyPassword(password, await this.#dummyHash);
      return { ok: false, reason: 'invalid' };
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      return { ok: false, reason: 'locked' };
    }
    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      this.store.recordLoginFailure(
        user.id,
        this.settings.lockAfterFailures,
        this.settings.lockForMs,
      );
      return { ok: false, reason: 'invalid' };
    }
    if (user.disabled) return { ok: false, reason: 'disabled' };
    this.store.recordLoginSuccess(user.id);
    const token = this.createSession(user.id);
    const {
      passwordHash: _hash,
      failedAttempts: _failed,
      lockedUntil: _locked,
      ...publicUser
    } = user;
    return { ok: true, user: publicUser, token };
  }

  async verifyUserPassword(username: string, password: string): Promise<boolean> {
    const user = this.store.findUser(username);
    return user ? verifyPassword(password, user.passwordHash) : false;
  }

  createSession(userId: number): string {
    const token = newToken();
    this.store.createSession(sha256(token), userId);
    return token;
  }

  /** Resolves a session token to an active user, enforcing idle and absolute expiry. */
  authenticate(token: string): User | undefined {
    const hash = sha256(token);
    const session = this.store.getSession(hash);
    if (!session) return undefined;
    const now = Date.now();
    if (
      now - session.lastSeenAt.getTime() > this.settings.sessionIdleMs ||
      now - session.createdAt.getTime() > this.settings.sessionMaxMs
    ) {
      this.store.deleteSession(hash);
      return undefined;
    }
    const user = this.store.getUser(session.userId);
    if (!user || user.disabled) {
      this.store.deleteSession(hash);
      return undefined;
    }
    // Throttle writes: refresh last-seen at most once a minute.
    if (now - session.lastSeenAt.getTime() > 60_000) this.store.touchSession(hash);
    return user;
  }

  logout(token: string): void {
    this.store.deleteSession(sha256(token));
  }

  pruneSessions(): number {
    const now = Date.now();
    return this.store.deleteExpiredSessions(
      new Date(now - this.settings.sessionIdleMs),
      new Date(now - this.settings.sessionMaxMs),
    );
  }

  async createUser(username: string, password: string, role: Role): Promise<User> {
    return this.store.createUser(username, await this.hashPassword(password), role);
  }
}
