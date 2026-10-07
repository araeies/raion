import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { ComponentId, RuntimeBundle } from '@raion/core';
import { parse } from 'yaml';
import { sha256, type StatePaths } from './state.js';

export interface ReleaseManifest {
  id: string;
  seq: number;
  createdAt: string;
  createdBy: string;
  workspace: string;
  configHash: string;
  retention: RuntimeBundle['retention'];
  artifacts: {
    path: string;
    sha256: string;
    component: string;
    description: string;
    live?: boolean;
  }[];
  components: {
    id: ComponentId;
    serviceHash: string;
    privileges: string[];
    requiresApproval: boolean;
  }[];
  /** Fingerprint of receiver credentials (never the values); a change restarts Alertmanager. */
  secretsFingerprint?: string;
}

const MANIFEST = 'release.json';

/** Hash of each component's Compose service definition (image, flags, mounts, ports…). */
export function serviceHashes(bundle: RuntimeBundle): Map<string, string> {
  const compose = bundle.artifacts.find((a) => a.path === 'compose.yaml');
  const services = compose
    ? ((parse(compose.content) as { services?: Record<string, unknown> }).services ?? {})
    : {};
  return new Map(Object.entries(services).map(([id, def]) => [id, sha256(JSON.stringify(def))]));
}

export function manifestFor(
  bundle: RuntimeBundle,
  meta: { seq: number; createdBy: string; workspace: string; secretsFingerprint?: string },
): ReleaseManifest {
  const artifacts = bundle.artifacts.map((a) => ({
    path: a.path,
    sha256: sha256(a.content),
    component: a.component,
    description: a.description,
    ...(a.live ? { live: true } : {}),
  }));
  const configHash = sha256(artifacts.map((a) => `${a.path}:${a.sha256}`).join('\n'));
  const hashes = serviceHashes(bundle);
  return {
    id: `${String(meta.seq).padStart(4, '0')}-${configHash.slice(0, 8)}`,
    seq: meta.seq,
    createdAt: new Date().toISOString(),
    createdBy: meta.createdBy,
    workspace: meta.workspace,
    configHash,
    retention: bundle.retention,
    ...(meta.secretsFingerprint ? { secretsFingerprint: meta.secretsFingerprint } : {}),
    artifacts,
    components: bundle.components.map((c) => ({
      id: c.id,
      serviceHash: hashes.get(c.id) ?? '',
      privileges: c.privileges,
      requiresApproval: c.requiresApproval,
    })),
  };
}

/** Immutable, numbered releases plus the "current" pointer. */
export class ReleaseStore {
  constructor(readonly paths: StatePaths) {}

  currentId(): string | undefined {
    if (!existsSync(this.paths.current)) return undefined;
    const id = readFileSync(this.paths.current, 'utf8').trim();
    return id || undefined;
  }

  current(): ReleaseManifest | undefined {
    const id = this.currentId();
    return id ? this.read(id) : undefined;
  }

  read(id: string): ReleaseManifest | undefined {
    if (!/^\d{4,}-[0-9a-f]{8}$/.test(id)) return undefined;
    const file = join(this.paths.releases, id, MANIFEST);
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, 'utf8')) as ReleaseManifest;
  }

  list(): ReleaseManifest[] {
    if (!existsSync(this.paths.releases)) return [];
    return readdirSync(this.paths.releases)
      .map((id) => this.read(id))
      .filter((m): m is ReleaseManifest => m !== undefined)
      .sort((a, b) => b.seq - a.seq);
  }

  nextSeq(): number {
    return (this.list()[0]?.seq ?? 0) + 1;
  }

  /** Writes a new release directory atomically (temp directory + rename). */
  create(
    bundle: RuntimeBundle,
    meta: { createdBy: string; workspace: string; secretsFingerprint?: string },
  ): ReleaseManifest {
    const manifest = manifestFor(bundle, { ...meta, seq: this.nextSeq() });
    const final = join(this.paths.releases, manifest.id);
    const temp = `${final}.tmp-${process.pid}`;
    rmSync(temp, { recursive: true, force: true });
    writeFiles(temp, bundle.artifacts);
    writeFileSync(join(temp, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(temp, final);
    return manifest;
  }

  /** Files of a release, read back from disk. */
  files(id: string): { path: string; content: string }[] {
    const manifest = this.read(id);
    if (!manifest) throw new Error(`release ${id} not found`);
    return manifest.artifacts.map((a) => ({
      path: a.path,
      content: readFileSync(join(this.paths.releases, id, ...a.path.split('/')), 'utf8'),
    }));
  }

  /**
   * Makes a release the deployed configuration: syncs its files into the runtime directory
   * (in place, so bind-mounted directories see the change) and moves the current pointer.
   */
  activate(id: string): void {
    const files = this.files(id);
    mkdirSync(this.paths.runtime, { recursive: true });
    const wanted = new Set(files.map((f) => f.path));
    for (const existing of listFiles(this.paths.runtime)) {
      if (!wanted.has(existing))
        rmSync(join(this.paths.runtime, ...existing.split('/')), { force: true });
    }
    for (const file of files) {
      const target = join(this.paths.runtime, ...file.path.split('/'));
      if (existsSync(target) && readFileSync(target, 'utf8') === file.content) continue;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content);
    }
    writeFileSync(this.paths.current, `${id}\n`);
  }

  clearCurrent(): void {
    rmSync(this.paths.current, { force: true });
  }
}

export function writeFiles(dir: string, files: readonly { path: string; content: string }[]): void {
  for (const file of files) {
    const target = join(dir, ...file.path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
}

/** Files under a directory, as forward-slash relative paths. */
export function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join('/'));
}
