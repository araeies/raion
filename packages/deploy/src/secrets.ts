import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { RuntimeBundle } from '@raion/core';
import { parseSecretRef } from '@raion/schema';
import type { StatePaths } from './state.js';

/** Names users can store: the NAME in ${secret:NAME}. Runtime-generated secrets are lowercase, so never clash. */
export const SECRET_KEY = /^[A-Z][A-Z0-9_]{0,127}$/;
const MAX_SECRET_BYTES = 64 * 1024;

export class SecretError extends Error {}

function ensureDir(paths: StatePaths) {
  mkdirSync(paths.secrets, { recursive: true, mode: 0o700 });
  chmodSync(paths.secrets, 0o700);
}

/** Stores a user secret. The value is never logged or written anywhere else. */
export function setSecret(paths: StatePaths, key: string, value: string): void {
  if (!SECRET_KEY.test(key))
    throw new SecretError(
      'secret names use A-Z, 0-9 and _, starting with a letter (e.g. SLACK_WEBHOOK)',
    );
  const trimmed = value.replace(/\r?\n$/, '');
  if (trimmed.length === 0) throw new SecretError('the secret value is empty');
  if (Buffer.byteLength(trimmed) > MAX_SECRET_BYTES)
    throw new SecretError('the secret value is too large');
  ensureDir(paths);
  // Readable by containers through the bind mount; the directory itself is owner-only.
  writeFileSync(paths.secret(key), trimmed, { mode: 0o644 });
}

export function removeSecret(paths: StatePaths, key: string): boolean {
  if (!SECRET_KEY.test(key) || !existsSync(paths.secret(key))) return false;
  rmSync(paths.secret(key));
  return true;
}

/** Names of stored user secrets (never their values). */
export function listSecrets(paths: StatePaths): string[] {
  if (!existsSync(paths.secrets)) return [];
  return readdirSync(paths.secrets)
    .filter((f) => SECRET_KEY.test(f))
    .sort();
}

export interface SecretStatus {
  key: string;
  source: 'secret' | 'env';
  present: boolean;
}

/** Which secrets the runtime needs, and whether each one is available right now. */
export function secretStatus(
  paths: StatePaths,
  bundle: RuntimeBundle,
  env: NodeJS.ProcessEnv = process.env,
): SecretStatus[] {
  return bundle.secrets.map((s) => ({
    key: s.key,
    source: s.source,
    present: s.source === 'secret' ? existsSync(paths.secret(s.key)) : Boolean(env[s.key]),
  }));
}

/** Fingerprint of the current secret values, or undefined if some are missing. Writes nothing. */
export function fingerprintSecrets(
  paths: StatePaths,
  bundle: RuntimeBundle,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (secretStatus(paths, bundle, env).some((s) => !s.present)) return undefined;
  if (bundle.secrets.length === 0) return '';
  const hash = createHash('sha256');
  for (const s of bundle.secrets) {
    const value = s.source === 'env' ? env[s.key]! : readFileSync(paths.secret(s.key), 'utf8');
    hash.update(`${s.file}\0${value}\0`);
  }
  return hash.digest('hex');
}

/**
 * Makes every secret the runtime needs available as a file in the secret store, copying
 * ${env:NAME} values from the environment. Returns a fingerprint of the values, stored only in
 * the (private) release record, so a changed credential restarts Alertmanager.
 */
export function materializeSecrets(
  paths: StatePaths,
  bundle: RuntimeBundle,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const missing = secretStatus(paths, bundle, env).filter((s) => !s.present);
  if (missing.length > 0) {
    throw new SecretError(
      `missing secrets:\n  ${missing
        .map((m) =>
          m.source === 'secret'
            ? `${m.key}: run "raion secrets set ${m.key}"`
            : `${m.key}: set the environment variable ${m.key}`,
        )
        .join('\n  ')}`,
    );
  }
  ensureDir(paths);
  for (const s of bundle.secrets) {
    if (s.source !== 'env') continue;
    const value = env[s.key]!;
    const file = paths.secret(s.file);
    if (!existsSync(file) || readFileSync(file, 'utf8') !== value)
      writeFileSync(file, value, { mode: 0o644 });
  }
  return fingerprintSecrets(paths, bundle, env) ?? '';
}

/**
 * The value behind a ${secret:NAME} or ${env:NAME} reference, for Raion's own use (for
 * example the single sign-on client secret). Throws when it is not set.
 */
export function resolveSecretRef(
  paths: StatePaths,
  ref: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const parsed = parseSecretRef(ref);
  if (!parsed) throw new SecretError(`${ref} is not a secret reference`);
  if (parsed.source === 'env') {
    const value = env[parsed.key];
    if (!value) throw new SecretError(`environment variable ${parsed.key} is not set`);
    return value;
  }
  const file = paths.secret(parsed.key);
  if (!existsSync(file)) {
    throw new SecretError(`secret ${parsed.key} is not set; run "raion secrets set ${parsed.key}"`);
  }
  return readFileSync(file, 'utf8').replace(/\r?\n$/, '');
}
