/**
 * Connects an application that is already running in Docker Compose: restarts it once with
 * Raion's settings, without editing the project's own files. The settings live in Raion's state
 * folder and are added to the project's own compose files with an extra -f.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  composeOverride,
  connectService,
  ingestNetworkName,
  type ResolvedWorkspace,
  type ServiceConnection,
} from '@raion/core';
import { discoverContainers } from './discovery.js';
import type { Runner } from './docker.js';
import { StatePaths } from './state.js';

export interface ComposeProject {
  project: string;
  workingDir: string;
  configFiles: string[];
}

export class ConnectRunningError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'not_compose' | 'not_running' | 'ambiguous' | 'failed' = 'failed',
  ) {
    super(message);
  }
}

/** Where Raion keeps the settings it adds to a project. */
export function connectOverridePath(paths: StatePaths, project: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project))
    throw new ConnectRunningError(`unusual project name "${project}"`);
  return join(paths.root, 'connect', `${project}.raion.yaml`);
}

/** The command that starts `service` with Raion's settings, as a person would type it. */
export function connectCommand(
  target: ComposeProject,
  overridePath: string,
  service: string,
): string[] {
  return [
    'compose',
    '-p',
    target.project,
    '--project-directory',
    target.workingDir,
    ...target.configFiles.flatMap((f) => ['-f', f]),
    '-f',
    overridePath,
    'up',
    '-d',
    service,
  ];
}

/**
 * Restarts `service` with the override. Only its container (and, when an agent is added, the
 * helper that copies it) is recreated; the project's other services are left as they are.
 */
export async function connectRunning(
  runner: Runner,
  paths: StatePaths,
  target: ComposeProject,
  service: string,
  override: string,
  log: (message: string) => void,
  options: { network?: string } = {},
): Promise<void> {
  if (target.configFiles.length === 0)
    throw new ConnectRunningError(
      'Docker does not know which compose files started this application',
    );
  for (const file of target.configFiles) {
    if (!existsSync(file)) {
      throw new ConnectRunningError(
        `${file} (the compose file this application was started with) is not on this machine, so Raion cannot restart it`,
      );
    }
  }
  // The settings join Raion's network; without it, Compose fails with "network not found".
  if (options.network) {
    const network = await runner.run(['network', 'inspect', options.network], {
      timeoutMs: 20_000,
    });
    if (network.code !== 0) {
      throw new ConnectRunningError(
        'Raion is not running yet, so there is nothing to connect to. Start monitoring first (Observability stack → Deploy), then connect again.',
      );
    }
  }
  const overridePath = connectOverridePath(paths, target.project);
  mkdirSync(join(paths.root, 'connect'), { recursive: true, mode: 0o700 });
  writeFileSync(overridePath, override, { mode: 0o600 });
  log(`Raion's settings for ${target.project}: ${overridePath}`);
  log(`Restarting ${service} with them…`);
  const result = await runner.run(connectCommand(target, overridePath, service), {
    timeoutMs: 15 * 60_000,
    cwd: target.workingDir,
  });
  for (const line of `${result.stdout}\n${result.stderr}`.split('\n'))
    if (line.trim()) log(line.trim());
  if (result.code !== 0)
    throw new ConnectRunningError(`docker compose could not restart ${service}`);
  log(`${service} is running with Raion's settings.`);
}

/** Everything needed to connect one running application, shown to the person before it runs. */
export interface ConnectRunningPlan {
  service: string;
  composeService: string;
  target: ComposeProject;
  override: string;
  overridePath: string;
  connection: ServiceConnection;
  /** Raion's network the application joins; it must exist (monitoring is running). */
  network: string;
  command: string[];
}

/**
 * Finds the running container of `name` and computes the settings to add. The override covers
 * every application of that Compose project Raion knows, so restarting one keeps the others'.
 */
export async function planConnectRunning(
  runner: Runner,
  ws: ResolvedWorkspace,
  workspaceDir: string,
  name: string,
): Promise<ConnectRunningPlan> {
  const svc = ws.services.find((s) => s.name === name);
  if (!svc) throw new ConnectRunningError(`there is no application named "${name}"`, 'not_found');
  if (svc.runtime.type !== 'compose') {
    throw new ConnectRunningError(
      `${name} does not run in Docker Compose, so Raion cannot restart it`,
      'not_compose',
    );
  }
  const composeService = svc.runtime.composeService ?? svc.name;
  const containers = await discoverContainers(runner, {
    excludeProjects: [ws.target.compose.projectName],
  });
  const running = containers.filter((c) => c.compose?.service === composeService);
  const projects = [...new Set(running.map((c) => c.compose!.project))];
  if (projects.length === 0) {
    throw new ConnectRunningError(
      `no running container is the Compose service "${composeService}". Start ${name} first, or set its name in your compose file in its settings.`,
      'not_running',
    );
  }
  if (projects.length > 1) {
    throw new ConnectRunningError(
      `"${composeService}" runs in several Compose projects (${projects.join(', ')}); connect it with "raion connect --out" and restart it yourself`,
      'ambiguous',
    );
  }
  const target = running[0]!.compose!;
  const inProject = new Set(
    containers.filter((c) => c.compose?.project === target.project).map((c) => c.compose!.service),
  );
  const connections = ws.services
    .filter(
      (s) => s.runtime.type === 'compose' && inProject.has(s.runtime.composeService ?? s.name),
    )
    .map((s) => connectService(ws, s));
  const overridePath = connectOverridePath(new StatePaths(workspaceDir), target.project);
  return {
    service: name,
    composeService,
    target,
    override: composeOverride(ws, connections),
    overridePath,
    connection: connections.find((c) => c.service === name)!,
    network: ingestNetworkName(ws.target.compose.projectName),
    command: connectCommand(target, overridePath, composeService),
  };
}
