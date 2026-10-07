import type { RuntimeBundle } from '@raion/core';
import type { DeployPlan } from './plan.js';
import type { ReleaseManifest } from './releases.js';
import type { ToolCheck } from './tools.js';

export interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
}

export interface ComponentStatus {
  component: string;
  /** Container state as reported by the target (running, exited, missing…). */
  state: string;
  /** Result of the component's readiness endpoint, when it has one. */
  ready?: boolean;
  detail?: string;
}

export interface RuntimeStatus {
  deployed?: { id: string; createdAt: string; createdBy: string };
  components: ComponentStatus[];
  /** Prometheus scrape health per job, when Prometheus is reachable. */
  scrapeTargets?: { job: string; health: string; lastError: string }[];
  /** False when any expected component is not running or not ready. */
  healthy: boolean;
}

export interface ApplyOptions {
  actor: string;
  allowPrivileged?: boolean;
  allowDataChanges?: boolean;
  /** Skip running the components' own validators (not recommended). */
  skipToolValidation?: boolean;
  readinessTimeoutMs?: number;
  onProgress?: (message: string) => void;
}

export interface ApplyResult {
  release: ReleaseManifest;
  plan: DeployPlan;
  toolChecks: ToolCheck[];
  restarted: string[];
}

/**
 * A place the observability runtime can run. Docker Compose is implemented; Kubernetes,
 * VM and cloud targets implement the same contract later. Generators never know which
 * target is used: they produce a target-agnostic RuntimeBundle.
 */
export interface DeploymentTarget {
  readonly type: string;
  preflight(bundle: RuntimeBundle): Promise<CheckResult[]>;
  validate(bundle: RuntimeBundle): Promise<ToolCheck[]>;
  plan(bundle: RuntimeBundle): DeployPlan;
  apply(bundle: RuntimeBundle, options: ApplyOptions): Promise<ApplyResult>;
  rollback(options: ApplyOptions & { to?: string }): Promise<ReleaseManifest>;
  status(bundle?: RuntimeBundle): Promise<RuntimeStatus>;
  destroy(options: { actor: string; deleteData: boolean }): Promise<void>;
}

export class ApplyError extends Error {
  constructor(
    message: string,
    readonly details: {
      toolChecks?: ToolCheck[];
      failedComponents?: ComponentStatus[];
      rolledBackTo?: string;
    } = {},
  ) {
    super(message);
  }
}
