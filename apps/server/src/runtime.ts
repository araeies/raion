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
  OperationJournal,
  StatePaths,
  verifyPipeline,
  type OperationKind,
  type OperationRecord,
  type Runner,
} from '@raion/deploy';

export interface RuntimeContext {
  workspace: ResolvedWorkspace;
  bundle: RuntimeBundle;
  target: DockerComposeTarget;
}

/** A long-running operation, as the web UI shows it. Started from the web UI or the CLI. */
export type Job = OperationRecord;

/** Access to the deployed runtime for the server: workspace context, gateway client and background jobs. */
export class RuntimeService {
  #cache: { key: string; context: RuntimeContext | undefined; at: number } | undefined;
  /** Shared with the CLI: both record their operations here. */
  readonly journal: OperationJournal;

  constructor(
    readonly workspaceDir: string,
    readonly runner?: Runner,
  ) {
    this.journal = new OperationJournal(new StatePaths(workspaceDir));
  }

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

  /** Forgets the cached workspace, after Raion itself changed its files. */
  invalidate(): void {
    this.#cache = undefined;
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
    return this.journal.get(id);
  }

  /** The operation changing the stack right now, started from here or from the CLI. */
  runningJob(): Job | undefined {
    return this.journal.active();
  }

  /** Recent operations from every interface, newest first. */
  jobs(limit = 30): Job[] {
    return this.journal.list(limit);
  }

  /** Starts work in the background as a recorded operation; progress is read with job(id). */
  start(
    kind: OperationKind,
    startedBy: string,
    work: (log: (m: string) => void) => Promise<unknown>,
  ): Job {
    const handle = this.journal.begin({ kind, via: 'web', actor: startedBy });
    work((m) => handle.log(m)).then(
      (result) => handle.succeed(result),
      (error: unknown) =>
        handle.fail(error, error instanceof ApplyError ? error.details : undefined),
    );
    return this.journal.get(handle.id)!;
  }

  verify(ctx: RuntimeContext) {
    return verifyPipeline(ctx.target.gateway(), ctx.workspace.target.compose.otlpHttpPort, {
      traces: ctx.bundle.components.some((c) => c.id === 'tempo'),
      environment: ctx.workspace.environment,
    });
  }
}
