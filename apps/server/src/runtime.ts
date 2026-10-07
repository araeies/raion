import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  generateRuntime,
  loadWorkspace,
  type ResolvedWorkspace,
  type RuntimeBundle,
} from '@raion/core';
import {
  ApplyError,
  DockerComposeTarget,
  GatewayClient,
  verifyPipeline,
  type Runner,
} from '@raion/deploy';

export interface RuntimeContext {
  workspace: ResolvedWorkspace;
  bundle: RuntimeBundle;
  target: DockerComposeTarget;
}

export interface Job {
  id: string;
  kind: 'apply' | 'verify' | 'repair';
  startedBy: string;
  startedAt: string;
  state: 'running' | 'succeeded' | 'failed';
  log: string[];
  result?: unknown;
  error?: string;
}

/** Access to the deployed runtime for the server: workspace context, gateway client and background jobs. */
export class RuntimeService {
  #cache: { key: string; context: RuntimeContext | undefined; at: number } | undefined;
  readonly #jobs = new Map<string, Job>();

  constructor(
    readonly workspaceDir: string,
    readonly runner?: Runner,
  ) {}

  /** Loads the workspace (cached briefly, invalidated when raion.yaml changes). Undefined if invalid. */
  async context(): Promise<RuntimeContext | undefined> {
    const info = await stat(join(this.workspaceDir, 'raion.yaml')).catch(() => undefined);
    const key = `${info?.mtimeMs ?? 0}`;
    if (this.#cache && this.#cache.key === key && Date.now() - this.#cache.at < 3000)
      return this.#cache.context;
    const result = await loadWorkspace(this.workspaceDir);
    const context = result.workspace
      ? {
          workspace: result.workspace,
          bundle: generateRuntime(result.workspace),
          target: new DockerComposeTarget(this.workspaceDir, result.workspace, this.runner),
        }
      : undefined;
    this.#cache = { key, context, at: Date.now() };
    return context;
  }

  async gateway(): Promise<GatewayClient | undefined> {
    const ctx = await this.context();
    if (!ctx?.target.releases.currentId()) return undefined;
    try {
      return ctx.target.gateway();
    } catch {
      return undefined;
    }
  }

  job(id: string): Job | undefined {
    return this.#jobs.get(id);
  }

  runningJob(): Job | undefined {
    return [...this.#jobs.values()].find((j) => j.state === 'running');
  }

  /** Starts work in the background; progress is read with job(id). */
  start(
    kind: Job['kind'],
    startedBy: string,
    work: (log: (m: string) => void) => Promise<unknown>,
  ): Job {
    const job: Job = {
      id: randomUUID(),
      kind,
      startedBy,
      startedAt: new Date().toISOString(),
      state: 'running',
      log: [],
    };
    this.#jobs.set(job.id, job);
    const log = (m: string) => job.log.push(m);
    work(log).then(
      (result) => {
        job.state = 'succeeded';
        job.result = result;
      },
      (error: unknown) => {
        job.state = 'failed';
        job.error = error instanceof Error ? error.message : String(error);
        if (error instanceof ApplyError) job.result = error.details;
      },
    );
    // Keep the 50 most recent jobs.
    for (const id of [...this.#jobs.keys()].slice(0, Math.max(0, this.#jobs.size - 50)))
      this.#jobs.delete(id);
    return job;
  }

  verify(ctx: RuntimeContext) {
    return verifyPipeline(ctx.target.gateway(), ctx.workspace.target.compose.otlpHttpPort, {
      traces: ctx.bundle.components.some((c) => c.id === 'tempo'),
      environment: ctx.workspace.environment,
    });
  }
}
