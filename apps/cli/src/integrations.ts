import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  builtinRegistry,
  formatDiagnostic,
  LOCK_FILE,
  readWorkspaceSources,
  registryFor,
  renderLock,
  validateSources,
} from '@raion/core';
import { EXIT, resolveWorkspaceDir, UsageError, type Output } from './commands.js';

/** Built-in integrations and the workspace's own packages, with what each one does. */
export async function integrationsListCommand(
  dirArg: string | undefined,
  opts: { format: 'text' | 'json' },
  io: Output,
): Promise<number> {
  const dir = resolveWorkspaceDir(dirArg);
  const local = existsSync(join(dir, 'raion.yaml'))
    ? (validateSources((await readWorkspaceSources(dir)).files).workspace?.integrationPackages ??
      [])
    : [];
  const registry = registryFor({ integrationPackages: local });
  const rows = registry.names().map((name) => {
    const { manifest } = registry.get(name)!;
    return {
      name,
      version: manifest.metadata.version,
      source: builtinRegistry().get(name) ? 'built-in' : 'workspace',
      kind: manifest.spec.kind,
      displayName: manifest.spec.displayName,
      languages: manifest.spec.languages,
      collects: manifest.spec.collector ? 'read by the collector' : 'sent by the application',
    };
  });
  if (opts.format === 'json') {
    io.out(JSON.stringify(rows, null, 2));
    return EXIT.OK;
  }
  for (const r of rows) {
    io.out(
      `  ${r.name.padEnd(14)} ${r.version.padEnd(8)} ${r.source.padEnd(10)} ${r.displayName}` +
        (r.languages.length > 0 ? ` (language: ${r.languages.join(', ')})` : ''),
    );
  }
  return EXIT.OK;
}

/**
 * Writes integrations.lock.yaml with the checksums of the packages in integrations/. Run it
 * after reviewing a new or changed package; commit the lock file with the package.
 */
export async function integrationsLockCommand(
  dirArg: string | undefined,
  io: Output,
): Promise<number> {
  const dir = resolveWorkspaceDir(dirArg);
  const { files, diagnostics } = await readWorkspaceSources(dir);
  if (diagnostics.some((d) => d.severity === 'error')) {
    for (const d of diagnostics) io.err(formatDiagnostic(d));
    return EXIT.INVALID;
  }
  const lock = renderLock(files);
  if (lock.diagnostics.length > 0) {
    for (const d of lock.diagnostics) io.err(formatDiagnostic(d));
    throw new UsageError('fix the integration packages above before locking them');
  }
  const path = join(dir, LOCK_FILE);
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (lock.packages.length === 0 && !before) {
    io.out('No integration packages in integrations/; nothing to lock.');
    return EXIT.OK;
  }
  if (before === lock.content) {
    io.out(`${LOCK_FILE} is up to date.`);
    return EXIT.OK;
  }
  writeFileSync(path, lock.content);
  for (const p of lock.packages)
    io.out(`  locked ${p.name} ${p.version}  sha256:${p.sha256.slice(0, 12)}…`);
  io.out(`Wrote ${LOCK_FILE}. Commit it together with the packages.`);
  return EXIT.OK;
}
