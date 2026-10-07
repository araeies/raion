import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { gatewayAuthInclude, RUNTIME_SECRETS } from '@raion/core';

/**
 * Layout of Raion's local state inside a workspace (never committed):
 *
 *   .raion/secrets/      generated credentials (directory is owner-only)
 *   .raion/releases/     immutable copies of every applied configuration, for rollback
 *   .raion/runtime/      the currently deployed configuration (the Compose project directory)
 *   .raion/current       id of the release in runtime/
 *   .raion/apply.lock    held while an apply, rollback or destroy is running
 */
/**
 * Where a workspace's state lives: `<workspace>/.raion`, or RAION_STATE_DIR when set. A CI
 * runner that deploys from a fresh checkout sets RAION_STATE_DIR to a directory outside the
 * checkout, so cleaning the checkout never deletes releases or secrets. One directory per
 * workspace.
 */
export function stateRoot(workspaceDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.RAION_STATE_DIR?.trim();
  if (override) {
    if (!isAbsolute(override)) throw new Error('RAION_STATE_DIR must be an absolute path');
    return resolve(override);
  }
  return join(workspaceDir, '.raion');
}

export class StatePaths {
  readonly root: string;
  constructor(readonly workspaceDir: string) {
    this.root = stateRoot(workspaceDir);
  }
  get secrets() {
    return join(this.root, 'secrets');
  }
  get releases() {
    return join(this.root, 'releases');
  }
  get runtime() {
    return join(this.root, 'runtime');
  }
  get staging() {
    return join(this.root, 'staging');
  }
  get current() {
    return join(this.root, 'current');
  }
  get lock() {
    return join(this.root, 'apply.lock');
  }
  secret(name: string) {
    return join(this.secrets, name);
  }
}

/**
 * Creates the runtime secrets on first use. Files are readable by containers (they are
 * bind-mounted), so access control comes from the owner-only secrets directory.
 */
export function ensureRuntimeSecrets(paths: StatePaths): { created: string[] } {
  mkdirSync(paths.secrets, { recursive: true, mode: 0o700 });
  chmodSync(paths.secrets, 0o700);
  const created: string[] = [];
  const write = (name: string, content: string) => {
    writeFileSync(paths.secret(name), content, { mode: 0o644 });
    created.push(name);
  };
  if (!existsSync(paths.secret(RUNTIME_SECRETS.gatewayToken))) {
    write(RUNTIME_SECRETS.gatewayToken, randomBytes(32).toString('base64url'));
  }
  const token = readSecret(paths, RUNTIME_SECRETS.gatewayToken);
  const include = gatewayAuthInclude(token);
  const includePath = paths.secret(RUNTIME_SECRETS.gatewayAuthConf);
  if (!existsSync(includePath) || readFileSync(includePath, 'utf8') !== include) {
    write(RUNTIME_SECRETS.gatewayAuthConf, include);
  }
  if (!existsSync(paths.secret(RUNTIME_SECRETS.grafanaAdminPassword))) {
    write(RUNTIME_SECRETS.grafanaAdminPassword, randomBytes(24).toString('base64url'));
  }
  return { created };
}

export function readSecret(paths: StatePaths, name: string): string {
  return readFileSync(paths.secret(name), 'utf8').trim();
}

export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
