import {
  builtinRegistry,
  composeOverride,
  connectService,
  ingestNetworkName,
  registryFor,
} from '@raion/core';
import {
  ApplyError,
  checkServiceTelemetry,
  connectRunning,
  ConnectRunningError,
  planConnectRunning,
  serviceHistory,
  discoverContainers,
  dockerRunner,
  LockedError,
  lockHolder,
  StatePaths,
  type DiscoveredContainer,
} from '@raion/deploy';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from './errors.js';
import type { RuntimeService } from './runtime.js';
import { roleAtLeast, type Role } from './store.js';

interface Helpers {
  requireRole: (role: Role) => (request: FastifyRequest) => Promise<void>;
  audit: (
    request: FastifyRequest,
    action: string,
    outcome: 'success' | 'failure',
    target?: string | null,
    details?: Record<string, unknown> | null,
  ) => void;
}

export function registerRuntimeRoutes(
  app: FastifyInstance,
  runtime: RuntimeService,
  { requireRole, audit }: Helpers,
): void {
  const contextOrFail = async () => {
    const ctx = await runtime.context();
    if (!ctx) {
      throw new HttpError(
        422,
        'invalid_workspace',
        'the workspace configuration has errors; fix them before deploying',
      );
    }
    return ctx;
  };

  /** Overview: what is deployed, whether it is healthy, and what applying would change. */
  app.get('/api/v1/runtime', { preHandler: requireRole('viewer') }, async () => {
    const ctx = await contextOrFail();
    const [status, plan] = [await ctx.target.status(ctx.bundle), ctx.target.plan(ctx.bundle)];
    return {
      status,
      plan,
      // Changes to the running stack made behind Raion's back (not workspace changes).
      drift: await ctx.target.drift(),
      components: ctx.bundle.components.map((c) => ({
        id: c.id,
        purpose: c.purpose,
        privileges: c.privileges,
      })),
      files: ctx.bundle.artifacts.map((a) => ({
        path: a.path,
        component: a.component,
        description: a.description,
      })),
      releases: ctx.target.releases
        .list()
        .slice(0, 20)
        .map((r) => ({ id: r.id, createdAt: r.createdAt, createdBy: r.createdBy })),
      grafanaUrl: '/grafana/',
      dashboards: ctx.bundle.dashboards.map((d) => ({ ...d, url: `/grafana/d/${d.uid}` })),
      otlp: {
        grpc: `127.0.0.1:${ctx.workspace.target.compose.otlpGrpcPort}`,
        http: `http://127.0.0.1:${ctx.workspace.target.compose.otlpHttpPort}`,
      },
      ingestNetwork: ingestNetworkName(ctx.workspace.target.compose.projectName),
      runningJob: runtime.runningJob()?.id ?? null,
    };
  });

  /** One generated file, as it would be deployed ("Show generated configuration"). */
  app.get('/api/v1/runtime/files/*', { preHandler: requireRole('viewer') }, async (request) => {
    const path = (request.params as { '*': string })['*'];
    const ctx = await contextOrFail();
    // Only files Raion generated can be returned; the path is never used to read the disk.
    const artifact = ctx.bundle.artifacts.find((a) => a.path === path);
    if (!artifact) throw new HttpError(404, 'not_found', `no generated file "${path}"`);
    return artifact;
  });

  /** Refuses to start a change while another one runs, from any interface. */
  const ensureIdle = () => {
    const running = runtime.runningJob();
    if (running) {
      const where = running.via === 'cli' ? 'from the command line' : 'from the web UI';
      throw new HttpError(
        409,
        'busy',
        `${running.kind} started ${where} by ${running.actor} is still running; wait for it to finish`,
        { job: running.id },
      );
    }
    const holder = lockHolder(new StatePaths(runtime.workspaceDir).lock);
    if (holder) {
      throw new HttpError(
        409,
        'busy',
        `${holder.operation} by ${holder.owner} is still running; wait for it to finish`,
      );
    }
  };

  app.post(
    '/api/v1/runtime/apply',
    { preHandler: requireRole('editor') },
    async (request, reply) => {
      const body = z
        .strictObject({
          allowPrivileged: z.boolean().default(false),
          allowDataChanges: z.boolean().default(false),
        })
        .parse(request.body ?? {});
      const ctx = await contextOrFail();
      const plan = ctx.target.plan(ctx.bundle);
      const user = request.user!;
      // Security-relevant and data-affecting changes need an admin and an explicit approval.
      if (
        (plan.securityRelevant.length > 0 || plan.dataAffecting.length > 0) &&
        !roleAtLeast(user.role, 'admin')
      ) {
        throw new HttpError(
          403,
          'admin_required',
          'this change needs elevated privileges or affects stored data; an admin must apply it',
        );
      }
      ensureIdle();

      const job = runtime.start('apply', user.username, async (log) => {
        try {
          const result = await ctx.target.apply(ctx.bundle, {
            actor: user.username,
            allowPrivileged: body.allowPrivileged,
            allowDataChanges: body.allowDataChanges,
            onProgress: log,
          });
          audit(request, 'runtime.apply', 'success', result.release.id, {
            restarted: result.restarted,
          });
          log(`Release ${result.release.id} is deployed and every component is ready.`);
          return { release: result.release.id, restarted: result.restarted };
        } catch (error) {
          audit(request, 'runtime.apply', 'failure', null, { error: (error as Error).message });
          if (error instanceof ApplyError || error instanceof LockedError) log(error.message);
          throw error;
        }
      });
      return reply.status(202).send({ job: job.id });
    },
  );

  /**
   * Restores the deployed release (its files and containers) after drift. It deploys only
   * what was already approved and applied, so it needs no more than the editor role.
   */
  app.post(
    '/api/v1/runtime/repair',
    { preHandler: requireRole('editor') },
    async (request, reply) => {
      const ctx = await contextOrFail();
      if (!ctx.target.releases.currentId())
        throw new HttpError(409, 'not_deployed', 'nothing is deployed yet');
      ensureIdle();
      const user = request.user!;
      const drift = await ctx.target.drift();
      const job = runtime.start('repair', user.username, async (log) => {
        try {
          const release = await ctx.target.repair({ actor: user.username, onProgress: log });
          audit(request, 'runtime.repair', 'success', release.id, {
            drift: drift.items.map((i) => `${i.kind}:${i.subject}`),
          });
          log(`Release ${release.id} is restored.`);
          return { release: release.id };
        } catch (error) {
          audit(request, 'runtime.repair', 'failure', null, { error: (error as Error).message });
          if (error instanceof ApplyError || error instanceof LockedError) log(error.message);
          throw error;
        }
      });
      return reply.status(202).send({ job: job.id });
    },
  );

  /**
   * Deploys an earlier release again (the CLI's "raion rollback"). Every release was approved
   * when it was first applied, so this needs no more than the editor role.
   */
  app.post(
    '/api/v1/runtime/rollback',
    { preHandler: requireRole('editor') },
    async (request, reply) => {
      const body = z
        .strictObject({
          to: z
            .string()
            .regex(/^[0-9a-z-]{1,64}$/)
            .optional(),
        })
        .parse(request.body ?? {});
      const ctx = await contextOrFail();
      if (!ctx.target.releases.currentId())
        throw new HttpError(409, 'not_deployed', 'nothing is deployed yet');
      if (body.to && !ctx.target.releases.list().some((r) => r.id === body.to))
        throw new HttpError(404, 'not_found', `release "${body.to}" does not exist`);
      ensureIdle();
      const user = request.user!;
      const job = runtime.start('rollback', user.username, async (log) => {
        try {
          const release = await ctx.target.rollback({
            actor: user.username,
            ...(body.to ? { to: body.to } : {}),
            onProgress: log,
          });
          audit(request, 'runtime.rollback', 'success', release.id, null);
          log(
            `Release ${release.id} is deployed. Your workspace files still describe the newer configuration: the next deploy brings it back.`,
          );
          return { release: release.id };
        } catch (error) {
          audit(request, 'runtime.rollback', 'failure', body.to ?? null, {
            error: (error as Error).message,
          });
          if (error instanceof ApplyError || error instanceof LockedError) log(error.message);
          throw error;
        }
      });
      return reply.status(202).send({ job: job.id });
    },
  );

  /**
   * Stops the observability stack (the CLI's "raion destroy"). Monitoring stops for everyone, so
   * it is for admins; deleting the stored data as well must be confirmed by typing the workspace
   * name.
   */
  app.post('/api/v1/runtime/stop', { preHandler: requireRole('admin') }, async (request, reply) => {
    const body = z
      .strictObject({
        deleteData: z.boolean().default(false),
        confirm: z.string().max(128).optional(),
      })
      .parse(request.body ?? {});
    const ctx = await contextOrFail();
    if (body.deleteData && body.confirm !== ctx.workspace.name) {
      throw new HttpError(
        400,
        'confirmation_required',
        `type the workspace name "${ctx.workspace.name}" to confirm deleting all stored data`,
      );
    }
    ensureIdle();
    const user = request.user!;
    const job = runtime.start('destroy', user.username, async (log) => {
      log(
        body.deleteData
          ? 'Stopping every component and deleting all stored data…'
          : 'Stopping every component. Stored data is kept.',
      );
      await ctx.target.destroy({ actor: user.username, deleteData: body.deleteData });
      audit(request, 'runtime.destroy', 'success', null, { deleteData: body.deleteData });
      log('The observability stack is stopped. Deploy again to start it.');
      return { deleteData: body.deleteData };
    });
    return reply.status(202).send({ job: job.id });
  });

  // ----- Running applications: find them, and connect them for the user ---------------------

  const runner = () => runtime.runner ?? dockerRunner;

  /** Containers running on this machine, and which application each one is in Raion. */
  app.get('/api/v1/discovery', { preHandler: requireRole('editor') }, async () => {
    const ctx = await contextOrFail();
    let containers: DiscoveredContainer[];
    try {
      containers = await discoverContainers(runner(), {
        excludeProjects: [ctx.workspace.target.compose.projectName],
      });
    } catch (error) {
      throw new HttpError(
        503,
        'docker_unavailable',
        `Raion cannot list containers: ${(error as Error).message}`,
      );
    }
    const monitored = (c: DiscoveredContainer) =>
      ctx.workspace.services.find(
        (s) =>
          s.runtime.type === 'compose' &&
          c.compose !== undefined &&
          (s.runtime.composeService ?? s.name) === c.compose.service,
      )?.name ?? null;
    return { containers: containers.map((c) => ({ ...c, monitoredAs: monitored(c) })) };
  });

  /** The Compose project an application runs in, and the settings Raion would add to it. */
  const connectPlan = async (name: string) => {
    const ctx = await contextOrFail();
    try {
      return await planConnectRunning(runner(), ctx.workspace, runtime.workspaceDir, name);
    } catch (error) {
      if (error instanceof ConnectRunningError) {
        throw new HttpError(error.code === 'not_found' ? 404 : 409, error.code, error.message);
      }
      throw error;
    }
  };

  app.get(
    '/api/v1/services/:name/connect-running',
    { preHandler: requireRole('admin') },
    async (request) => {
      const { name } = z.object({ name: z.string().max(63) }).parse(request.params);
      const plan = await connectPlan(name);
      return {
        service: name,
        project: plan.target.project,
        workingDir: plan.target.workingDir,
        configFiles: plan.target.configFiles,
        overridePath: plan.overridePath,
        command: `docker ${plan.command.join(' ')}`,
        override: plan.override,
        settings: plan.connection.env.map(([k]) => k),
        agent: plan.connection.agent?.name ?? null,
        logs: Boolean(plan.connection.logging),
      };
    },
  );

  app.post(
    '/api/v1/services/:name/connect-running',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      const { name } = z.object({ name: z.string().max(63) }).parse(request.params);
      const plan = await connectPlan(name);
      ensureIdle();
      const user = request.user!;
      const job = runtime.start('connect', user.username, async (log) => {
        try {
          await connectRunning(
            runner(),
            new StatePaths(runtime.workspaceDir),
            plan.target,
            plan.composeService,
            plan.override,
            log,
            { network: plan.network },
          );
          audit(request, 'service.connect', 'success', name, { project: plan.target.project });
          return { service: name, project: plan.target.project };
        } catch (error) {
          audit(request, 'service.connect', 'failure', name, { error: (error as Error).message });
          log((error as Error).message);
          throw error;
        }
      });
      return reply.status(202).send({ job: job.id });
    },
  );

  app.post(
    '/api/v1/runtime/verify',
    { preHandler: requireRole('editor') },
    async (request, reply) => {
      const ctx = await contextOrFail();
      if (!ctx.target.releases.currentId())
        throw new HttpError(409, 'not_deployed', 'nothing is deployed yet');
      const job = runtime.start('verify', request.user!.username, async (log) => {
        log('Sending a test metric, log line and trace through the collector…');
        const results = await runtime.verify(ctx);
        for (const r of results) log(`${r.ok ? '✓' : '✗'} ${r.signal}: ${r.message}`);
        if (!results.every((r) => r.ok)) throw new Error('some signals did not arrive in storage');
        return results;
      });
      return reply.status(202).send({ job: job.id });
    },
  );

  app.get('/api/v1/runtime/jobs/:id', { preHandler: requireRole('viewer') }, async (request) => {
    const { id } = z
      .object({ id: z.string().regex(/^[0-9TZ]+-[0-9a-f]{6}$/) })
      .parse(request.params);
    const job = runtime.job(id);
    if (!job) throw new HttpError(404, 'not_found', 'operation not found');
    return job;
  });

  /** Recent operations on the stack, started from the web UI, the API or the CLI. */
  app.get('/api/v1/runtime/jobs', { preHandler: requireRole('viewer') }, async () => ({
    jobs: runtime.jobs().map(({ log: _log, ...summary }) => summary),
  }));

  // ----- Services: connection instructions and live telemetry ---------------------------

  const serviceOrFail = async (name: string) => {
    const ctx = await contextOrFail();
    const svc = ctx.workspace.services.find((s) => s.name === name);
    if (!svc) throw new HttpError(404, 'not_found', `service "${name}" not found`);
    return { ctx, svc };
  };

  /** How to connect a service: packages to install, environment, and the Compose override. */
  app.get(
    '/api/v1/services/:name/connect',
    { preHandler: requireRole('viewer') },
    async (request) => {
      const { name } = z.object({ name: z.string().max(63) }).parse(request.params);
      const { ctx, svc } = await serviceOrFail(name);
      const connection = connectService(ctx.workspace, svc);
      return {
        connection,
        override:
          connection.runtime === 'compose' && connection.supported
            ? composeOverride(ctx.workspace, [connection])
            : null,
      };
    },
  );

  /** What the service is actually sending, plus request rate, errors and latency. */
  app.get(
    '/api/v1/services/:name/telemetry',
    { preHandler: requireRole('viewer') },
    async (request) => {
      const { name } = z.object({ name: z.string().max(63) }).parse(request.params);
      const { ctx, svc } = await serviceOrFail(name);
      if (!ctx.target.releases.currentId()) return { deployed: false, telemetry: null };
      try {
        const telemetry = await checkServiceTelemetry(ctx.target.gateway(), svc, {
          tracesDeployed: ctx.bundle.components.some((c) => c.id === 'tempo'),
        });
        return { deployed: true, telemetry };
      } catch (error) {
        throw new HttpError(
          503,
          'stack_unavailable',
          `the observability stack could not be queried: ${(error as Error).message}`,
        );
      }
    },
  );

  /** An application's recent history, for the charts on its page. */
  app.get(
    '/api/v1/services/:name/history',
    { preHandler: requireRole('viewer') },
    async (request) => {
      const { name } = z.object({ name: z.string().max(63) }).parse(request.params);
      const { minutes } = z
        .object({
          minutes: z.coerce
            .number()
            .pipe(z.union([z.literal(60), z.literal(360), z.literal(1440)]))
            .default(60),
        })
        .parse(request.query);
      const { ctx, svc } = await serviceOrFail(name);
      if (!ctx.target.releases.currentId()) return { deployed: false, history: null };
      try {
        return {
          deployed: true,
          history: await serviceHistory(ctx.target.gateway(), svc, minutes),
        };
      } catch (error) {
        throw new HttpError(
          503,
          'stack_unavailable',
          `the observability stack could not be queried: ${(error as Error).message}`,
        );
      }
    },
  );

  /** Integrations available: built-in and the workspace's own packages, with documentation. */
  app.get('/api/v1/integrations', { preHandler: requireRole('viewer') }, async () => {
    const ctx = await runtime.context();
    const registry = ctx ? registryFor(ctx.workspace) : builtinRegistry();
    return {
      integrations: registry.names().map((n) => {
        const { manifest, docs } = registry.get(n)!;
        return {
          name: n,
          version: manifest.metadata.version,
          source: builtinRegistry().get(n) ? 'built-in' : 'workspace',
          kind: manifest.spec.kind,
          displayName: manifest.spec.displayName,
          description: manifest.spec.description,
          languages: manifest.spec.languages,
          capabilities: manifest.spec.capabilities.map((c) => c.id),
          // How telemetry arrives: the application sends it, or the collector reads it.
          collects: manifest.spec.collector ? 'pull' : 'push',
          parameters: Object.entries(manifest.spec.parameters).map(([param, p]) => ({
            name: param,
            type: p.type,
            description: p.description,
            required: p.type !== 'boolean' && p.required,
            ...(p.type === 'string' ? { format: p.format } : {}),
            ...('default' in p && p.default !== undefined ? { default: p.default } : {}),
          })),
          requirements: manifest.spec.requirements.map((r) => ({
            kind: r.kind,
            description: r.description,
            ...(r.kind === 'packages' ? { packages: r.packages, manager: r.manager } : {}),
          })),
          // Services of this workspace that use it.
          services: (ctx?.workspace.services ?? [])
            .filter((svc) => svc.integrations.some((i) => i.name === n))
            .map((svc) => svc.name),
          docs,
        };
      }),
    };
  });
}
