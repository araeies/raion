import { hasErrors, type Diagnostic } from './diagnostics.js';
import { loadWorkspacePackages } from './integration-packages.js';
import { registryFor } from './integrations.js';
import { parseSources, readWorkspaceSources, type SourceFile } from './loader.js';
import type { ResolvedWorkspace } from './model.js';
import { resolveWorkspace } from './resolve.js';

export interface ValidationResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  workspace?: ResolvedWorkspace;
  files: SourceFile[];
}

/** Validates in-memory sources. Pure, so it can run in the API, the CLI and tests alike. */
export function validateSources(files: readonly SourceFile[]): ValidationResult {
  const parsed = parseSources(files);
  const local = loadWorkspacePackages(files);
  const registry = registryFor({ integrationPackages: local.packages });
  const resolved =
    hasErrors(parsed.diagnostics) || hasErrors(local.diagnostics)
      ? { diagnostics: [] }
      : resolveWorkspace(parsed, registry, local.packages);
  const diagnostics = sortDiagnostics([
    ...parsed.diagnostics,
    ...local.diagnostics,
    ...resolved.diagnostics,
  ]);
  return {
    ok: !hasErrors(diagnostics),
    diagnostics,
    ...('workspace' in resolved && resolved.workspace ? { workspace: resolved.workspace } : {}),
    files: [...files],
  };
}

/** Loads and validates the workspace in `dir` (the directory containing raion.yaml). */
export async function loadWorkspace(dir: string): Promise<ValidationResult> {
  const { files, diagnostics } = await readWorkspaceSources(dir);
  if (hasErrors(diagnostics)) {
    return { ok: false, diagnostics, files };
  }
  return validateSources(files);
}

function sortDiagnostics(list: Diagnostic[]): Diagnostic[] {
  return list.sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1) ||
      (a.file ?? '').localeCompare(b.file ?? '') ||
      (a.line ?? 0) - (b.line ?? 0),
  );
}
