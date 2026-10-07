import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateRuntime, validateSources } from '@raion/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computePlan,
  fingerprintSecrets,
  listSecrets,
  materializeSecrets,
  ReleaseStore,
  removeSecret,
  SecretError,
  secretStatus,
  setSecret,
  StatePaths,
} from '../src/index.js';

const bundle = generateRuntime(
  validateSources([
    {
      path: 'raion.yaml',
      content: `apiVersion: raion/v1alpha1
kind: Workspace
metadata:
  name: t
spec:
  notifications:
    receivers:
      - name: chat
        type: slack
        webhookUrl: \${secret:CHAT_WEBHOOK}
      - name: mail
        type: email
        to: [ops@example.com]
        from: raion@example.com
        smarthost: smtp.example.com:587
        password: \${env:MAIL_PASSWORD}
`,
    },
  ]).workspace!,
);

let dir: string;
let paths: StatePaths;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'raion-secrets-'));
  paths = new StatePaths(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('secret store', () => {
  it('stores, lists and removes user secrets by name only', () => {
    setSecret(paths, 'CHAT_WEBHOOK', 'https://hooks.example.com/abc\n');
    expect(readFileSync(paths.secret('CHAT_WEBHOOK'), 'utf8')).toBe(
      'https://hooks.example.com/abc',
    );
    expect(listSecrets(paths)).toEqual(['CHAT_WEBHOOK']);
    expect(removeSecret(paths, 'CHAT_WEBHOOK')).toBe(true);
    expect(listSecrets(paths)).toEqual([]);
  });

  it('rejects invalid names and empty values, and never collides with runtime secrets', () => {
    expect(() => setSecret(paths, 'gateway-token', 'x')).toThrow(SecretError);
    expect(() => setSecret(paths, '../ESCAPE', 'x')).toThrow(SecretError);
    expect(() => setSecret(paths, 'EMPTY', '\n')).toThrow(/empty/);
  });

  it('reports which secrets receivers need', () => {
    setSecret(paths, 'CHAT_WEBHOOK', 'https://hooks.example.com/abc');
    expect(secretStatus(paths, bundle, {})).toEqual([
      { key: 'MAIL_PASSWORD', source: 'env', present: false },
      { key: 'CHAT_WEBHOOK', source: 'secret', present: true },
    ]);
  });

  it('refuses to deploy with missing secrets and explains how to set them', () => {
    expect(() => materializeSecrets(paths, bundle, {})).toThrow(
      /MAIL_PASSWORD: set the environment variable MAIL_PASSWORD[\s\S]*CHAT_WEBHOOK: run "raion secrets set CHAT_WEBHOOK"/,
    );
  });

  it('copies environment secrets into the store and fingerprints the values', () => {
    setSecret(paths, 'CHAT_WEBHOOK', 'https://hooks.example.com/abc');
    const env = { MAIL_PASSWORD: 's3cret' };
    const first = materializeSecrets(paths, bundle, env);
    expect(readFileSync(paths.secret('env.MAIL_PASSWORD'), 'utf8')).toBe('s3cret');
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toContain('s3cret');
    expect(fingerprintSecrets(paths, bundle, env)).toBe(first);
    expect(fingerprintSecrets(paths, bundle, { MAIL_PASSWORD: 'changed' })).not.toBe(first);
    expect(fingerprintSecrets(paths, bundle, {})).toBeUndefined();
  });
});

describe('plan: changed credentials restart Alertmanager', () => {
  it('restarts only Alertmanager when a secret value changes', () => {
    setSecret(paths, 'CHAT_WEBHOOK', 'https://hooks.example.com/abc');
    const env = { MAIL_PASSWORD: 'pw-7f3a9c-one' };
    const store = new ReleaseStore(paths);
    const release = store.create(bundle, {
      createdBy: 't',
      workspace: dir,
      secretsFingerprint: materializeSecrets(paths, bundle, env),
    });
    expect(existsSync(join(paths.releases, release.id, 'release.json'))).toBe(true);
    expect(readFileSync(join(paths.releases, release.id, 'release.json'), 'utf8')).not.toContain(
      'pw-7f3a9c-one',
    );

    const same = computePlan(bundle, release, fingerprintSecrets(paths, bundle, env));
    expect(same.noChanges).toBe(true);

    const changed = computePlan(
      bundle,
      release,
      fingerprintSecrets(paths, bundle, { MAIL_PASSWORD: 'two' }),
    );
    expect(changed.noChanges).toBe(false);
    expect(changed.components.filter((c) => c.action !== 'unchanged')).toEqual([
      {
        component: 'alertmanager',
        action: 'restart',
        reasons: ['notification credentials changed'],
        privileges: [],
      },
    ]);
  });
});
