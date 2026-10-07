import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { z } from 'zod';
import { CODES, type Diagnostic } from './diagnostics.js';
import {
  builtinRegistry,
  IntegrationLoadError,
  parseIntegration,
  type LoadedIntegration,
} from './integrations.js';
import type { SourceFile } from './loader.js';
import { toYaml } from './runtime/yaml.js';

/**
 * A workspace's own integration packages: `integrations/<name>/integration.yaml` (plus its
 * documentation), pinned by checksum in `integrations.lock.yaml`. A package that is new or
 * changed since the lock was written is refused, so every change to one is a deliberate,
 * reviewable step ("raion integrations lock"), and CI catches a package changed without it.
 */
export const PACKAGES_DIR = 'integrations';
export const LOCK_FILE = 'integrations.lock.yaml';

const PACKAGE_FILE = /^integrations\/([a-z][a-z0-9-]{0,62})\/([A-Za-z0-9_.-]+)$/;

/** Files that belong to integration packages rather than to the configuration documents. */
export function isPackageFile(path: string): boolean {
  return path === LOCK_FILE || path.startsWith(`${PACKAGES_DIR}/`);
}

const lockSchema = z.strictObject({
  apiVersion: z.literal('raion/v1alpha1'),
  kind: z.literal('IntegrationLock'),
  packages: z.record(
    z.string(),
    z.strictObject({
      version: z.string(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
});

/** Checksum of a package: its manifest and documentation, with line endings normalized. */
export function packageChecksum(manifest: string, docs: string): string {
  const lf = (text: string) => text.replaceAll('\r\n', '\n');
  return createHash('sha256')
    .update('integration.yaml\n')
    .update(lf(manifest))
    .update('\0docs\n')
    .update(lf(docs))
    .digest('hex');
}

interface Candidate {
  name: string;
  manifestFile: SourceFile;
  files: Map<string, string>;
}

interface PartialCandidate {
  manifestFile?: SourceFile;
  files: Map<string, string>;
}

function candidates(files: readonly SourceFile[]): Candidate[] {
  const byName = new Map<string, PartialCandidate>();
  for (const f of files) {
    const match = PACKAGE_FILE.exec(f.path);
    if (!match) continue;
    const name = match[1]!;
    const file = match[2]!;
    const entry = byName.get(name) ?? { files: new Map<string, string>() };
    entry.files.set(file, f.content);
    if (file === 'integration.yaml') entry.manifestFile = f;
    byName.set(name, entry);
  }
  return [...byName].flatMap(([name, e]) =>
    e.manifestFile ? [{ name, manifestFile: e.manifestFile, files: e.files }] : [],
  );
}

interface Checked {
  name: string;
  loaded?: LoadedIntegration;
  checksum?: string;
}

function check(files: readonly SourceFile[], diag: (d: Diagnostic) => void): Checked[] {
  return candidates(files).map((c) => {
    const file = c.manifestFile.path;
    try {
      const loaded = parseIntegration(
        c.manifestFile.content,
        file,
        `${PACKAGES_DIR}/${c.name}`,
        (docs) => c.files.get(docs),
      );
      if (loaded.manifest.metadata.name !== c.name) {
        throw new IntegrationLoadError(
          `${file}: the package is named "${loaded.manifest.metadata.name}", but its directory is "${c.name}"; they must match`,
        );
      }
      if (builtinRegistry().get(c.name)) {
        throw new IntegrationLoadError(
          `${file}: "${c.name}" is a built-in integration; choose another name`,
        );
      }
      return {
        name: c.name,
        loaded,
        checksum: packageChecksum(
          c.manifestFile.content,
          c.files.get(loaded.manifest.spec.docs) ?? '',
        ),
      };
    } catch (error) {
      diag({
        severity: 'error',
        code: CODES.INTEGRATION_PACKAGE,
        file,
        message: (error as Error).message,
      });
      return { name: c.name };
    }
  });
}

/**
 * The workspace's integration packages that may be used: valid, and matching the lock file.
 * Pure: reads only the given files.
 */
export function loadWorkspacePackages(files: readonly SourceFile[]): {
  packages: LoadedIntegration[];
  diagnostics: Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const checked = check(files, (d) => diagnostics.push(d));
  if (checked.length === 0) return { packages: [], diagnostics };

  const lockFile = files.find((f) => f.path === LOCK_FILE);
  let lock: z.output<typeof lockSchema> | undefined;
  if (lockFile) {
    const parsed = lockSchema.safeParse(parse(lockFile.content));
    if (parsed.success) lock = parsed.data;
    else {
      diagnostics.push({
        severity: 'error',
        code: CODES.INTEGRATION_NOT_LOCKED,
        file: LOCK_FILE,
        message: `${LOCK_FILE} is not a valid lock file`,
        hint: 'run "raion integrations lock" to write it again',
      });
    }
  }

  const packages: LoadedIntegration[] = [];
  for (const c of checked) {
    if (!c.loaded || !c.checksum) continue;
    const entry = lock?.packages[c.name];
    if (!entry || entry.sha256 !== c.checksum) {
      diagnostics.push({
        severity: 'error',
        code: CODES.INTEGRATION_NOT_LOCKED,
        file: `${PACKAGES_DIR}/${c.name}/integration.yaml`,
        message: entry
          ? `integration package "${c.name}" changed since it was locked`
          : `integration package "${c.name}" is not in ${LOCK_FILE}`,
        hint: 'review the package (it configures how your services are instrumented), then run "raion integrations lock"',
      });
      continue;
    }
    packages.push(c.loaded);
  }
  return { packages, diagnostics };
}

/** The lock file for the workspace's current packages. Refuses packages that do not load. */
export function renderLock(files: readonly SourceFile[]): {
  content: string;
  packages: { name: string; version: string; sha256: string }[];
  diagnostics: Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const checked = check(files, (d) => diagnostics.push(d));
  const packages = checked
    .filter((c): c is Required<Checked> => c.loaded !== undefined && c.checksum !== undefined)
    .map((c) => ({ name: c.name, version: c.loaded.manifest.metadata.version, sha256: c.checksum }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const content = toYaml(
    {
      apiVersion: 'raion/v1alpha1',
      kind: 'IntegrationLock',
      packages: Object.fromEntries(
        packages.map((p) => [p.name, { version: p.version, sha256: p.sha256 }]),
      ),
    },
    'Checksums of the integration packages in integrations/.\nWritten by "raion integrations lock" after reviewing a package. Commit this file.',
  );
  return { content, packages, diagnostics };
}
