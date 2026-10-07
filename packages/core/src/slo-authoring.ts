import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Sli } from '@raion/schema';
import type { Diagnostic } from './diagnostics.js';
import type { SourceFile } from './loader.js';
import { toYaml } from './runtime/yaml.js';
import { validateSources } from './workspace.js';

export interface NewSlo {
  service: string;
  name: string;
  sli: Sli;
  target: number;
  window: string;
  description?: string;
  policy?: string;
}

export class SloAuthoringError extends Error {
  constructor(
    message: string,
    readonly diagnostics: Diagnostic[] = [],
  ) {
    super(message);
  }
}

/** The file a new SLO is written to (one standalone document per SLO). */
export function sloFilePath(slo: Pick<NewSlo, 'service' | 'name'>): string {
  return `slos/${slo.service}-${slo.name}.yaml`;
}

export function renderSloDocument(slo: NewSlo): SourceFile {
  return {
    path: sloFilePath(slo),
    content: toYaml(
      {
        apiVersion: 'raion/v1alpha1',
        kind: 'SLO',
        metadata: { name: slo.name },
        spec: {
          service: slo.service,
          ...(slo.description ? { description: slo.description } : {}),
          sli: slo.sli,
          target: slo.target,
          window: slo.window,
          ...(slo.policy ? { policy: slo.policy } : {}),
        },
      },
      'Service level objective. Created with Raion; edit freely, then run "raion plan".',
    ),
  };
}

/**
 * Adds an SLO as a new file, after validating the whole workspace with it. Never overwrites
 * or edits existing files, so it cannot clobber someone else's change.
 */
export async function addSlo(
  workspaceDir: string,
  currentFiles: readonly SourceFile[],
  slo: NewSlo,
): Promise<{ file: SourceFile; diagnostics: Diagnostic[] }> {
  const file = renderSloDocument(slo);
  if (existsSync(join(workspaceDir, file.path)) || currentFiles.some((f) => f.path === file.path)) {
    throw new SloAuthoringError(`${file.path} already exists; edit it instead`);
  }
  const result = validateSources([...currentFiles, file]);
  const problems = result.diagnostics.filter((d) => d.severity === 'error');
  if (problems.length > 0) {
    throw new SloAuthoringError(problems.map((d) => d.message).join('; '), problems);
  }
  await mkdir(dirname(join(workspaceDir, file.path)), { recursive: true });
  await writeFile(join(workspaceDir, file.path), file.content, { flag: 'wx' });
  return { file, diagnostics: result.diagnostics.filter((d) => d.file === file.path) };
}
