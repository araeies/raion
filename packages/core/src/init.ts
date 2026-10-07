import { mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LANGUAGES, SERVICE_TYPES, type Level } from '@raion/schema';
import type { SourceFile } from './loader.js';
import { WORKSPACE_FILE } from './loader.js';

export interface InitOptions {
  name: string;
  level: Level;
  environment: string;
  service?: {
    name: string;
    type: (typeof SERVICE_TYPES)[number];
    language?: (typeof LANGUAGES)[number];
    runtime: 'compose' | 'host';
  };
}

const LEVEL_NAMES: Record<Level, string> = { 1: 'basic', 2: 'production', 3: 'SRE' };

/** Renders the files of a new workspace. Pure; the output always passes validation. */
export function renderWorkspace(options: InitOptions): SourceFile[] {
  const files: SourceFile[] = [
    {
      path: WORKSPACE_FILE,
      content: `# Raion workspace. Everything Raion deploys is generated from the files in this folder.
# Commit this folder to Git. The .raion/ folder holds local state and secrets: never commit it.
apiVersion: raion/v1alpha1
kind: Workspace
metadata:
  name: ${options.name}
spec:
  # Observability level: 1 = basic, 2 = production, 3 = SRE (SLOs, error budgets, burn-rate alerts).
  level: ${options.level} # ${LEVEL_NAMES[options.level]}
  environment: ${options.environment}
  target:
    type: docker-compose
  infrastructure:
    host: true        # CPU, memory, disk and network of this machine (node_exporter)
    containers: false # per-container metrics (cAdvisor). Needs elevated privileges, so it is opt-in.
  # Teams own services and receive their alerts. Without teams, alerts go to the Raion inbox.
  teams: []
  notifications:
    # Extra places to send alerts. Secrets are referenced, never written here, e.g.
    #   - name: ops-slack
    #     type: slack
    #     webhookUrl: \${secret:OPS_SLACK_WEBHOOK}
    receivers: []
`,
    },
    {
      path: '.gitignore',
      content: '# Raion local state: secrets, releases and the operational database\n.raion/\n',
    },
  ];

  if (options.service) {
    const svc = options.service;
    const slos =
      options.level >= 3
        ? `  slos:
    - name: availability
      sli: { type: availability } # share of requests that did not fail with a 5xx error
      target: 99.9                # percent
      window: 30d
    - name: latency
      sli: { type: latency, thresholdMs: 500 } # share of requests faster than 500ms
      target: 99
      window: 30d
`
        : `  # SLOs are enabled at level 3. Example:
  # slos:
  #   - name: availability
  #     sli: { type: availability }
  #     target: 99.9
  #     window: 30d
`;
    files.push({
      path: `services/${svc.name}.yaml`,
      content: `apiVersion: raion/v1alpha1
kind: Service
metadata:
  name: ${svc.name}
spec:
  type: ${svc.type}
${svc.language ? `  language: ${svc.language}\n` : ''}  tier: standard # critical | standard | best-effort
  runtime:
    type: ${svc.runtime}
  signals:
    metrics: true
    logs: true
    traces: true
  dependencies: []
${slos}`,
    });
  }
  return files;
}

export class WorkspaceExistsError extends Error {
  constructor(readonly path: string) {
    super(`${path} already exists; refusing to overwrite it`);
  }
}

/** Writes files into `dir`. Never overwrites an existing file. */
export async function writeWorkspace(dir: string, files: readonly SourceFile[]): Promise<string[]> {
  for (const file of files) {
    const target = join(dir, file.path);
    if (await exists(target)) throw new WorkspaceExistsError(target);
  }
  const written: string[] = [];
  for (const file of files) {
    const target = join(dir, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, { encoding: 'utf8', flag: 'wx' });
    written.push(target);
  }
  return written;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
