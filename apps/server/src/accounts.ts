import type { AuthService } from './auth.js';
import { passwordProblem } from './passwords.js';
import type { Role, Store, User } from './store.js';

/** A refused account change, with an HTTP status for the API and a code for scripts. */
export class AccountError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface AccountChanges {
  role?: Role;
  disabled?: boolean;
  password?: string;
}

/**
 * Account management, shared by the HTTP API and the CLI so both enforce the same rules: the
 * password policy, never removing the last active admin, leaving single sign-on accounts to
 * their identity provider, and signing people out when their access changes.
 */
export class Accounts {
  constructor(
    readonly store: Store,
    readonly auth: AuthService,
  ) {}

  async create(username: string, password: string, role: Role): Promise<User> {
    if (this.store.findUser(username))
      throw new AccountError(409, 'user_exists', `user "${username}" already exists`);
    const problem = passwordProblem(password, username);
    if (problem) throw new AccountError(400, 'weak_password', problem);
    return this.auth.createUser(username, password, role);
  }

  /** Applies the changes and returns the updated user and what changed, for the audit log. */
  async update(
    username: string,
    changes: AccountChanges,
  ): Promise<{ user: User; details: Record<string, unknown> }> {
    const target = this.store.findUser(username);
    if (!target) throw new AccountError(404, 'not_found', `user "${username}" not found`);
    if (target.sso && (changes.role !== undefined || changes.password !== undefined)) {
      throw new AccountError(
        409,
        'sso_account',
        `"${username}" signs in with single sign-on; the identity provider decides the role and password`,
      );
    }
    const losesAdmin =
      target.role === 'admin' &&
      !target.disabled &&
      ((changes.role && changes.role !== 'admin') || changes.disabled === true);
    if (losesAdmin && this.store.countActiveAdmins() <= 1) {
      throw new AccountError(409, 'last_admin', 'cannot remove the last active admin');
    }
    let passwordHash: string | undefined;
    if (changes.password !== undefined) {
      const problem = passwordProblem(changes.password, username);
      if (problem) throw new AccountError(400, 'weak_password', problem);
      passwordHash = await this.auth.hashPassword(changes.password);
    }
    this.store.updateUser(target.id, {
      ...(changes.role ? { role: changes.role } : {}),
      ...(changes.disabled !== undefined ? { disabled: changes.disabled } : {}),
      ...(passwordHash ? { passwordHash } : {}),
    });
    // Any change of privileges or credentials ends the person's existing sessions.
    this.store.deleteUserSessions(target.id);
    return {
      user: this.store.getUser(target.id)!,
      details: {
        ...(changes.role ? { role: changes.role } : {}),
        ...(changes.disabled !== undefined ? { disabled: changes.disabled } : {}),
        ...(passwordHash ? { passwordReset: true } : {}),
      },
    };
  }
}
