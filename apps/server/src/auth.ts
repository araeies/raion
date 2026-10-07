import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DEFAULT_SCRYPT, hashPassword, verifyPassword, type ScryptParams } from './passwords.js';
import { NO_PASSWORD, ROLES, type ApiToken, type Role, type Store, type User } from './store.js';

export const USERNAME = /^[a-z0-9][a-z0-9._-]{1,63}$/;

/** "raion_<id>_<secret>": the id finds the token, the secret proves possession. */
const API_TOKEN = /^raion_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;
export const MAX_TOKEN_DAYS = 366;
export const MAX_TOKENS_PER_USER = 20;

export class TokenError extends Error {}

/** The lower of two roles. */
function minRole(a: Role, b: Role): Role {
  return ROLES.indexOf(a) <= ROLES.indexOf(b) ? a : b;
}

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
    // Accounts that sign in through single sign-on have no password. Answer exactly like an
    // unknown user, in the same time, so their existence is not revealed.
    if (!user || user.passwordHash === NO_PASSWORD) {
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

  // ----- Single sign-on --------------------------------------------------------------------

  /**
   * Signs in a person the identity provider vouched for: their existing linked account, or a
   * new one. The provider decides the role, every time. A username that already belongs to
   * someone else (a password account, or another person at the provider) is refused rather
   * than taken over.
   */
  ssoSignIn(person: {
    issuer: string;
    subject: string;
    username: string;
    role: Role;
  }):
    | { ok: true; user: User; token: string; created: boolean }
    | { ok: false; reason: 'disabled' | 'username_taken' } {
    const linked = this.store.findSsoUser(person.issuer, person.subject);
    let user: User;
    let created = false;
    if (linked) {
      if (linked.disabled) return { ok: false, reason: 'disabled' };
      if (linked.role !== person.role) this.store.updateUser(linked.id, { role: person.role });
      user = { ...this.store.getUser(linked.id)! };
    } else {
      if (this.store.findUser(person.username)) return { ok: false, reason: 'username_taken' };
      user = this.store.createSsoUser(person.username, person.role, person.issuer, person.subject);
      created = true;
    }
    return { ok: true, user, token: this.createSession(user.id), created };
  }

  // ----- API tokens -----------------------------------------------------------------------

  /** Creates a token for `user`; the returned value is shown once and never stored. */
  createApiToken(
    user: User,
    options: { name: string; role: Role; expiresInDays: number },
  ): { token: string; record: ApiToken } {
    if (ROLES.indexOf(options.role) > ROLES.indexOf(user.role)) {
      throw new TokenError(`a token cannot have more rights than you: your role is ${user.role}`);
    }
    if (
      !Number.isInteger(options.expiresInDays) ||
      options.expiresInDays < 1 ||
      options.expiresInDays > MAX_TOKEN_DAYS
    ) {
      throw new TokenError(`a token must expire within 1 to ${MAX_TOKEN_DAYS} days`);
    }
    if (this.store.countActiveApiTokens(user.id) >= MAX_TOKENS_PER_USER) {
      throw new TokenError(`you have ${MAX_TOKENS_PER_USER} active tokens; revoke one first`);
    }
    const id = randomBytes(8).toString('hex');
    const secret = newToken();
    this.store.createApiToken({
      id,
      userId: user.id,
      name: options.name,
      secretHash: sha256(secret),
      role: options.role,
      expiresAt: new Date(Date.now() + options.expiresInDays * 86_400_000),
    });
    return { token: `raion_${id}_${secret}`, record: this.store.getApiToken(id)! };
  }

  /**
   * Resolves a bearer token to its owner, with the lower of the token's role and the owner's
   * current role. Undefined for anything malformed, unknown, revoked, expired or disabled.
   */
  authenticateApiToken(value: string): { user: User; token: ApiToken } | undefined {
    const match = API_TOKEN.exec(value);
    if (!match) return undefined;
    const record = this.store.getApiToken(match[1]!);
    if (!record) return undefined;
    const presented = Buffer.from(sha256(match[2]!), 'hex');
    const stored = Buffer.from(record.secretHash, 'hex');
    if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) return undefined;
    if (record.revokedAt || Date.parse(record.expiresAt) <= Date.now()) return undefined;
    const owner = this.store.getUser(record.userId);
    if (!owner || owner.disabled) return undefined;
    // Throttle writes: record the last use at most once a minute.
    if (!record.lastUsedAt || Date.now() - Date.parse(record.lastUsedAt) > 60_000) {
      this.store.touchApiToken(record.id);
    }
    const { secretHash: _hash, ...token } = record;
    return { user: { ...owner, role: minRole(owner.role, record.role) }, token };
  }

  async createUser(username: string, password: string, role: Role): Promise<User> {
    return this.store.createUser(username, await this.hashPassword(password), role);
  }
}
