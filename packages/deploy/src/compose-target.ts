import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import {
  ingestNetworkName,
  READINESS_PATHS,
  type ResolvedWorkspace,
  type RuntimeBundle,
} from '@raion/core';
import { dockerRunner, DockerError, mustRun, type Runner } from './docker.js';
import { GatewayClient, scrapeHealth } from './gateway.js';
import { alertingHealth, fetchActiveAlerts } from './alertmanager.js';
import { acquireLock } from './lock.js';
import { computePlan, type DeployPlan } from './plan.js';
import { compareRuntime, type DriftReport } from './drift.js';
import { listFiles, ReleaseStore, type ReleaseManifest } from './releases.js';
import { fingerprintSecrets, materializeSecrets, SecretError, secretStatus } from './secrets.js';
import { ensureRuntimeSecrets, StatePaths } from './state.js';
import {
  ApplyError,
  type ApplyOptions,
  type ApplyResult,
  type CheckResult,
  type ComponentStatus,
  type DeploymentTarget,
  type RuntimeStatus,
} from './target.js';
import { ImagePullError, pullMissingImages, validateWithTools, type ToolCheck } from './tools.js';

interface ComposePsEntry {
  Service: string;
  State: string;
  Health?: string;
  Image?: string;
}

/** Deploys the runtime as a Docker Compose project on this machine. */
export class DockerComposeTarget implements DeploymentTarget {
  readonly type = 'docker-compose';
  readonly paths: StatePaths;
  readonly releases: ReleaseStore;
  readonly #project: string;
  readonly #gatewayPort: number;
  readonly #ports: number[];

  readonly #isPortFree: (port: number) => Promise<boolean>;

  constructor(
    readonly workspaceDir: string,
    workspace: ResolvedWorkspace,
    readonly runner: Runner = dockerRunner,
    options: { isPortFree?: (port: number) => Promise<boolean> } = {},
  ) {
    this.#isPortFree = options.isPortFree ?? isPortFree;
    this.paths = new StatePaths(workspaceDir);
    this.releases = new ReleaseStore(this.paths);
    const compose = workspace.target.compose;
    this.#project = compose.projectName;
    this.#gatewayPort = compose.gatewayPort;
    this.#ports = [compose.gatewayPort, compose.otlpGrpcPort, compose.otlpHttpPort];
  }

  gateway(): GatewayClient {
    return GatewayClient.forWorkspace(this.paths, this.#gatewayPort);
  }

  #compose(...args: string[]): string[] {
    return [
      'compose',
      '--project-name',
      this.#project,
      '--project-directory',
      this.paths.runtime,
      '-f',
      join(this.paths.runtime, 'compose.yaml'),
      ...args,
    ];
  }

  // ----- checks ---------------------------------------------------------------------------

  async preflight(bundle: RuntimeBundle): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    const docker = await this.runner.run(['version', '--format', '{{.Server.Version}}'], {
      timeoutMs: 20_000,
    });
    results.push({
      name: 'docker',
      ok: docker.code === 0,
      message:
        docker.code === 0
          ? `Docker Engine ${docker.stdout.trim()}`
          : 'Docker is not available. Install Docker (or start Docker Desktop) and make sure your user can run "docker version"',
    });
    if (docker.code !== 0) return results;

    const compose = await this.runner.run(['compose', 'version', '--short'], { timeoutMs: 20_000 });
    results.push({
      name: 'docker compose',
      ok: compose.code === 0,
      message:
        compose.code === 0
          ? `Compose ${compose.stdout.trim()}`
          : 'the Docker Compose plugin (docker compose) is not installed',
    });

    const running = new Set(
      (await this.#ps()).filter((e) => e.State === 'running').map((e) => e.Service),
    );
    for (const port of this.#ports) {
      const ours = running.has('gateway') || running.has('otel-collector');
      const free = await this.#isPortFree(port);
      results.push({
        name: `port ${port}`,
        ok: free || ours,
        message:
          free || ours
            ? `127.0.0.1:${port} available`
            : `127.0.0.1:${port} is already used by another program; change the port in raion.yaml (spec.target.compose)`,
      });
    }
    for (const secret of secretStatus(this.paths, bundle)) {
      results.push({
        name: `secret ${secret.key}`,
        ok: secret.present,
        message: secret.present
          ? `secret ${secret.key} is set`
          : secret.source === 'secret'
            ? `secret ${secret.key} is not set: run "raion secrets set ${secret.key}"`
            : `environment variable ${secret.key} is not set`,
      });
    }
    const privileged = bundle.components.filter((c) => c.requiresApproval);
    for (const c of privileged) {
      results.push({ name: c.id, ok: true, message: `${c.id} needs: ${c.privileges.join('; ')}` });
    }
    return results;
  }

  /** Checks the generated configuration with each component's own validator. */
  async validate(
    bundle: RuntimeBundle,
    onProgress: (message: string) => void = () => undefined,
  ): Promise<ToolCheck[]> {
    ensureRuntimeSecrets(this.paths);
    // The validators run in the components' images: download them first, so no check is
    // cut short by a download.
    await pullMissingImages(this.runner, bundle, onProgress);
    return validateWithTools(this.runner, this.paths, bundle);
  }

  plan(bundle: RuntimeBundle): DeployPlan {
    return computePlan(bundle, this.releases.current(), fingerprintSecrets(this.paths, bundle));
  }

  // ----- apply ----------------------------------------------------------------------------

  async apply(bundle: RuntimeBundle, options: ApplyOptions): Promise<ApplyResult> {
    const log = options.onProgress ?? (() => undefined);
    const release = acquireLock(this.paths.lock, options.actor, 'apply');
    try {
      const plan = this.plan(bundle);
      if (plan.securityRelevant.length > 0 && !options.allowPrivileged) {
        throw new ApplyError(
          `this change needs elevated privileges and was not applied:\n  ${plan.securityRelevant.join('\n  ')}\nRe-run with --allow-privileged to approve it.`,
        );
      }
      if (plan.dataAffecting.length > 0 && !options.allowDataChanges) {
        throw new ApplyError(
          `this change affects stored data and was not applied:\n  ${plan.dataAffecting.join('\n  ')}\nRe-run with --allow-data-changes to approve it.`,
        );
      }

      log('Checking prerequisites…');
      const preflight = await this.preflight(bundle);
      const failed = preflight.filter((c) => !c.ok);
      if (failed.length > 0) {
        throw new ApplyError(
          `prerequisites not met:\n  ${failed.map((c) => c.message).join('\n  ')}`,
        );
      }

      ensureRuntimeSecrets(this.paths);
      let secretsFingerprint: string;
      try {
        secretsFingerprint = materializeSecrets(this.paths, bundle);
      } catch (error) {
        if (error instanceof SecretError) throw new ApplyError(error.message);
        throw error;
      }
      try {
        const pulled = await pullMissingImages(this.runner, bundle, log);
        if (pulled.length > 0) log(`Downloaded ${pulled.length} image(s).`);
      } catch (error) {
        if (error instanceof ImagePullError)
          throw new ApplyError(`${error.message}\nNothing was changed.`);
        throw error;
      }
      let toolChecks: ToolCheck[] = [];
      if (!options.skipToolValidation) {
        log('Validating generated configuration with each component’s own tools…');
        toolChecks = await validateWithTools(this.runner, this.paths, bundle);
        const bad = toolChecks.filter((c) => !c.ok);
        if (bad.length > 0) {
          throw new ApplyError(
            `generated configuration was rejected by ${bad.map((c) => c.tool).join(', ')}; nothing was changed`,
            { toolChecks },
          );
        }
      }

      const previous = this.releases.current();
      const manifest =
        plan.noChanges && previous
          ? previous
          : this.releases.create(bundle, {
              secretsFingerprint,
              createdBy: options.actor,
              workspace: this.workspaceDir,
            });
      this.releases.activate(manifest.id);

      try {
        // Containers left behind by an earlier, unrecorded deployment would keep running stale
        // configuration, so "new" components with an existing container are restarted as well.
        const existing = new Set((await this.#ps()).map((e) => e.Service));
        log(`Starting components (release ${manifest.id})…`);
        await mustRun(
          this.runner,
          this.#compose('up', '-d', '--remove-orphans', '--wait', '--wait-timeout', '240'),
          'docker compose up',
          600_000,
        );
        const restarted = plan.components
          .filter(
            (c) => c.action === 'restart' || (c.action === 'add' && existing.has(c.component)),
          )
          .map((c) => c.component);
        if (restarted.length > 0) {
          log(`Restarting components with changed configuration: ${restarted.join(', ')}…`);
          await mustRun(
            this.runner,
            this.#compose('restart', ...restarted),
            'docker compose restart',
            300_000,
          );
        }
        log('Waiting for components to become ready…');
        await this.#waitReady(bundle.components, options.readinessTimeoutMs ?? 180_000);
        log('Checking that Prometheus monitors every component…');
        await this.#waitForScrapes(options.readinessTimeoutMs ?? 180_000);
        log('Checking that alerting works (the Watchdog alert reaches Alertmanager)…');
        await this.#waitForWatchdog(options.readinessTimeoutMs ?? 180_000);
        return { release: manifest, plan, toolChecks, restarted };
      } catch (error) {
        const failedComponents = await this.#failedComponents(bundle);
        if (previous && previous.id !== manifest.id) {
          log(`Apply failed; rolling back to release ${previous.id}…`);
          let outcome = `Rolled back to release ${previous.id}.`;
          try {
            await this.#deploy(
              previous.id,
              bundle.components.map((c) => c.id),
            );
            await this.#waitReady(
              previous.components.map((c) => ({ id: c.id, readinessPath: READINESS_PATHS[c.id] })),
              options.readinessTimeoutMs ?? 180_000,
            );
          } catch (rollbackError) {
            outcome = `Rollback to release ${previous.id} did not fully recover: ${(rollbackError as Error).message}. Run "raion status".`;
          }
          throw new ApplyError(`${(error as Error).message}\n${outcome}`, {
            failedComponents,
            rolledBackTo: previous.id,
          });
        }
        // First deployment: nothing to roll back to. Leave containers for inspection.
        if (!previous) this.releases.clearCurrent();
        throw new ApplyError((error as Error).message, { failedComponents });
      }
    } finally {
      release();
    }
  }

  async rollback(options: ApplyOptions & { to?: string }): Promise<ReleaseManifest> {
    const release = acquireLock(this.paths.lock, options.actor, 'rollback');
    try {
      const current = this.releases.current();
      const all = this.releases.list();
      const target = options.to
        ? this.releases.read(options.to)
        : all.find((r) => current && r.seq < current.seq);
      if (!target)
        throw new ApplyError(
          options.to
            ? `release ${options.to} not found`
            : 'there is no earlier release to roll back to',
        );
      options.onProgress?.(`Rolling back to release ${target.id}…`);
      await this.#deploy(
        target.id,
        target.components.map((c) => c.id),
      );
      options.onProgress?.('Waiting for components to become ready…');
      await this.#waitReady(
        target.components.map((c) => ({ id: c.id, readinessPath: READINESS_PATHS[c.id] })),
        options.readinessTimeoutMs ?? 180_000,
      );
      return target;
    } finally {
      release();
    }
  }

  /** Activates a release and restarts every listed component. */
  async #deploy(id: string, components: string[]): Promise<void> {
    this.releases.activate(id);
    await mustRun(
      this.runner,
      this.#compose('up', '-d', '--remove-orphans', '--wait', '--wait-timeout', '240'),
      'docker compose up',
      600_000,
    );
    const running = (await this.#ps()).map((e) => e.Service).filter((s) => components.includes(s));
    if (running.length > 0)
      await mustRun(
        this.runner,
        this.#compose('restart', ...running),
        'docker compose restart',
        300_000,
      );
  }

  /**
   * A deployment is only complete when the stack monitors itself: every scrape target has
   * been scraped successfully since the components became ready.
   */
  async #waitForScrapes(timeoutMs: number): Promise<void> {
    const gateway = this.gateway();
    const deadline = Date.now() + timeoutMs;
    let down: string[];
    for (;;) {
      try {
        const targets = await scrapeHealth(gateway);
        down = targets
          .filter((t) => t.health !== 'up')
          .map((t) => `${t.job} (${t.lastError || t.health})`);
        if (targets.length > 0 && down.length === 0) return;
      } catch (error) {
        down = [(error as Error).message];
      }
      if (Date.now() > deadline) {
        throw new Error(`Prometheus cannot monitor: ${down.join(', ')}`);
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  /** A deployment is only complete when alerts are evaluated and delivered. */
  async #waitForWatchdog(timeoutMs: number): Promise<void> {
    const gateway = this.gateway();
    const deadline = Date.now() + timeoutMs;
    let last: string;
    for (;;) {
      try {
        const health = alertingHealth(await fetchActiveAlerts(gateway));
        if (health.ok) return;
        last = health.message;
      } catch (error) {
        last = (error as Error).message;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `alerting did not start working within ${Math.round(timeoutMs / 1000)}s: ${last}`,
        );
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  async #waitReady(
    components: readonly { id: string; readinessPath?: string | undefined }[],
    timeoutMs: number,
  ): Promise<void> {
    const gateway = this.gateway();
    const deadline = Date.now() + timeoutMs;
    const pending = new Map(
      components.filter((c) => c.readinessPath).map((c) => [c.id, c.readinessPath!] as const),
    );
    while (pending.size > 0) {
      for (const [id, path] of [...pending]) {
        if ((await gateway.isReady(path)).ready) pending.delete(id);
      }
      if (pending.size === 0) break;
      if (Date.now() > deadline) {
        throw new Error(
          `components did not become ready within ${Math.round(timeoutMs / 1000)}s: ${[...pending.keys()].join(', ')}`,
        );
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  async #failedComponents(bundle: RuntimeBundle): Promise<ComponentStatus[]> {
    try {
      const status = await this.status(bundle);
      const failed = status.components.filter((c) => c.state !== 'running' || c.ready === false);
      for (const c of failed) {
        const logs = await this.runner.run(
          this.#compose('logs', '--no-color', '--tail', '15', c.component),
          { timeoutMs: 30_000 },
        );
        c.detail = `${c.detail ?? ''}\n${logs.stdout.trim()}`.trim();
      }
      return failed;
    } catch {
      return [];
    }
  }

  // ----- status and destroy -------------------------------------------------------------

  async #ps(): Promise<ComposePsEntry[]> {
    if (!existsSync(join(this.paths.runtime, 'compose.yaml'))) return [];
    const result = await this.runner.run(this.#compose('ps', '--all', '--format', 'json'), {
      timeoutMs: 30_000,
    });
    if (result.code !== 0) return [];
    const text = result.stdout.trim();
    if (!text) return [];
    // Compose prints either a JSON array or one JSON object per line, depending on version.
    if (text.startsWith('[')) return JSON.parse(text) as ComposePsEntry[];
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ComposePsEntry);
  }

  async status(bundle?: RuntimeBundle): Promise<RuntimeStatus> {
    const current = this.releases.current();
    const ps = await this.#ps();
    const expected =
      bundle?.components ??
      current?.components.map((c) => ({ id: c.id, readinessPath: undefined })) ??
      [];
    const byService = new Map(ps.map((e) => [e.Service, e]));
    const gateway = existsSync(this.paths.secret('gateway-token')) ? this.gateway() : undefined;

    const components: ComponentStatus[] = [];
    for (const c of expected) {
      const entry = byService.get(c.id);
      const status: ComponentStatus = { component: c.id, state: entry?.State ?? 'missing' };
      if (entry?.Health) status.detail = `container health: ${entry.Health}`;
      if (c.readinessPath && gateway && entry?.State === 'running') {
        const r = await gateway.isReady(c.readinessPath);
        status.ready = r.ready;
        if (!r.ready) status.detail = `not ready (${r.detail})`;
      }
      components.push(status);
    }

    let scrapeTargets: RuntimeStatus['scrapeTargets'];
    if (gateway && byService.get('prometheus')?.State === 'running') {
      try {
        scrapeTargets = (await scrapeHealth(gateway)).map(({ job, health, lastError }) => ({
          job,
          health,
          lastError,
        }));
      } catch {
        scrapeTargets = undefined;
      }
    }

    return {
      ...(current
        ? {
            deployed: {
              id: current.id,
              createdAt: current.createdAt,
              createdBy: current.createdBy,
            },
          }
        : {}),
      components,
      ...(scrapeTargets ? { scrapeTargets } : {}),
      healthy:
        current !== undefined &&
        components.length > 0 &&
        components.every((c) => c.state === 'running' && c.ready !== false),
    };
  }

  /** What changed in the running stack since Raion deployed the current release. */
  async drift(): Promise<DriftReport> {
    const current = this.releases.current();
    if (!current) return { items: [] };
    const actual = new Map(
      listFiles(this.paths.runtime).map((path) => [
        path,
        readFileSync(join(this.paths.runtime, ...path.split('/')), 'utf8'),
      ]),
    );
    const containers = (await this.#ps()).map((e) => ({
      service: e.Service,
      state: e.State,
      ...(e.Image ? { image: e.Image } : {}),
    }));
    return compareRuntime({
      release: current.id,
      expected: this.releases.files(current.id),
      actual,
      components: current.components.map((c) => c.id),
      containers,
    });
  }

  /** Puts the running stack back to the current release: its files and its containers. */
  async repair(options: ApplyOptions): Promise<ReleaseManifest> {
    const current = this.releases.current();
    if (!current) throw new ApplyError('nothing is deployed; run "raion apply"');
    return this.rollback({ ...options, to: current.id });
  }

  async destroy(options: { actor: string; deleteData: boolean }): Promise<void> {
    const release = acquireLock(this.paths.lock, options.actor, 'destroy');
    try {
      if (!existsSync(join(this.paths.runtime, 'compose.yaml'))) return;
      try {
        await mustRun(
          this.runner,
          this.#compose('down', '--remove-orphans', ...(options.deleteData ? ['--volumes'] : [])),
          'docker compose down',
          300_000,
        );
      } catch (error) {
        if (
          error instanceof DockerError &&
          /network .* (has active endpoints|is in use)/i.test(error.message)
        ) {
          throw new ApplyError(
            `components were stopped, but the ${ingestNetworkName(this.#project)} network is still used by your application containers; stop them (or remove them from the network) and run destroy again`,
          );
        }
        throw error;
      }
      this.releases.clearCurrent();
    } finally {
      release();
    }
  }
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.listen(port, '127.0.0.1', () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}
