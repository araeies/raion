import { isIP } from 'node:net';
import * as client from 'openid-client';
import type { OidcSettings } from '@raion/schema';
import { USERNAME } from './auth.js';
import { ROLES, type Role } from './store.js';

/** How long someone has to complete the sign-in at the provider. */
const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING = 1000;

interface Pending {
  verifier: string;
  nonce: string;
  next: string;
  expires: number;
}

export class SsoError extends Error {
  constructor(
    /** Shown to the person as a fixed message; never provider-supplied text. */
    readonly code:
      'provider_unavailable' | 'invalid_state' | 'provider_rejected' | 'no_role' | 'no_username',
    message: string,
  ) {
    super(message);
  }
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
}

/** Only local paths, so the sign-in cannot be used to redirect someone elsewhere. */
export function safeNext(next: string | undefined): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\')
    ? next
    : '/';
}

/**
 * OpenID Connect sign-in: authorization code flow with PKCE, state and nonce. Token and ID
 * token validation are done by openid-client.
 */
export class OidcService {
  #config: client.Configuration | undefined;
  readonly #pending = new Map<string, Pending>();

  constructor(
    readonly settings: OidcSettings,
    readonly clientSecret: string,
    /** The callback URL registered at the provider: <publicUrl>/api/v1/auth/oidc/callback. */
    readonly redirectUri: string,
  ) {
    const issuer = new URL(settings.issuer);
    if (issuer.protocol !== 'https:' && !isLoopback(issuer.hostname)) {
      throw new Error(
        'the single sign-on issuer must use https:// (http is allowed for localhost only)',
      );
    }
  }

  async #configuration(): Promise<client.Configuration> {
    if (this.#config) return this.#config;
    const issuer = new URL(this.settings.issuer);
    try {
      this.#config = await client.discovery(
        issuer,
        this.settings.clientId,
        undefined,
        client.ClientSecretPost(this.clientSecret),
        {
          timeout: 10,
          // Plain http is accepted only for a provider on this machine (checked above).
          // eslint-disable-next-line @typescript-eslint/no-deprecated
          ...(issuer.protocol === 'http:' ? { execute: [client.allowInsecureRequests] } : {}),
        },
      );
    } catch (error) {
      throw new SsoError(
        'provider_unavailable',
        `could not read the identity provider's configuration: ${(error as Error).message}`,
      );
    }
    return this.#config;
  }

  /** Where to send the browser to sign in, and the state to keep in a cookie. */
  async start(next: string): Promise<{ url: URL; state: string }> {
    const config = await this.#configuration();
    this.#prune();
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    this.#pending.set(state, {
      verifier,
      nonce,
      next: safeNext(next),
      expires: Date.now() + PENDING_TTL_MS,
    });
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: this.redirectUri,
      scope: this.settings.scopes.includes('openid')
        ? this.settings.scopes.join(' ')
        : ['openid', ...this.settings.scopes].join(' '),
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    return { url, state };
  }

  /**
   * Completes the sign-in from the provider's redirect. `cookieState` is the state kept in the
   * browser; it must match the one in the URL, which must be one this server issued.
   */
  async finish(
    callbackUrl: URL,
    cookieState: string | undefined,
  ): Promise<{ issuer: string; subject: string; username: string; role: Role; next: string }> {
    const state = callbackUrl.searchParams.get('state');
    const pending = state ? this.#pending.get(state) : undefined;
    if (state) this.#pending.delete(state);
    if (!state || !pending || cookieState !== state || pending.expires < Date.now()) {
      throw new SsoError('invalid_state', 'the sign-in expired or did not start here');
    }
    const config = await this.#configuration();
    let claims: Record<string, unknown> | undefined;
    try {
      const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: pending.verifier,
        expectedState: state,
        expectedNonce: pending.nonce,
        idTokenExpected: true,
      });
      claims = tokens.claims();
    } catch (error) {
      throw new SsoError(
        'provider_rejected',
        `the identity provider's answer was refused: ${(error as Error).message}`,
      );
    }
    if (!claims || typeof claims.sub !== 'string' || typeof claims.iss !== 'string') {
      throw new SsoError('provider_rejected', 'the identity provider sent no identity');
    }
    const role = this.role(claims);
    if (!role) throw new SsoError('no_role', 'the person is in no group that maps to a Raion role');
    const username = this.username(claims);
    if (!username)
      throw new SsoError('no_username', 'the identity provider sent no usable username');
    return { issuer: claims.iss, subject: claims.sub, username, role, next: pending.next };
  }

  /** The highest role any of the person's groups maps to, or the default. */
  role(claims: Record<string, unknown>): Role | undefined {
    const value = claims[this.settings.roles.claim];
    const groups = Array.isArray(value)
      ? value.filter((g): g is string => typeof g === 'string')
      : typeof value === 'string'
        ? [value]
        : [];
    for (const role of [...ROLES].reverse()) {
      if (this.settings.roles[role].some((g) => groups.includes(g))) return role;
    }
    return this.settings.roles.default;
  }

  /** A Raion username from the configured claim, falling back to the email's local part, then the subject. */
  username(claims: Record<string, unknown>): string | undefined {
    const candidates = [
      claims[this.settings.usernameClaim],
      claims.preferred_username,
      claims.email,
      claims.sub,
    ];
    for (const c of candidates) {
      if (typeof c !== 'string') continue;
      const name = c
        .toLowerCase()
        .split('@')[0]!
        .replace(/[^a-z0-9._-]/g, '-');
      if (USERNAME.test(name)) return name;
    }
    return undefined;
  }

  #prune(): void {
    const now = Date.now();
    for (const [state, p] of this.#pending) if (p.expires < now) this.#pending.delete(state);
    // Bound memory if someone starts many sign-ins without finishing them.
    while (this.#pending.size >= MAX_PENDING) {
      this.#pending.delete(this.#pending.keys().next().value!);
    }
  }
}
