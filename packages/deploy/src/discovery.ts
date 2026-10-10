/**
 * Finds the applications running on this machine, so people can pick one instead of typing its
 * details. Read-only: it lists and inspects containers, nothing else.
 */
import type { Runner } from './docker.js';

export interface DiscoveredContainer {
  /** Container name, without the leading "/". */
  container: string;
  image: string;
  state: string;
  /** Set when the container was started by Docker Compose. */
  compose?: {
    project: string;
    service: string;
    /** The compose files it was started with (absolute paths, as Docker recorded them). */
    configFiles: string[];
    workingDir: string;
  };
  /** Raion's best guess at what it is, from its image, environment and command. */
  guess: {
    language?: 'nodejs' | 'python' | 'java' | 'go' | 'dotnet' | 'php';
    integration?: 'postgresql' | 'redis' | 'nginx';
  };
}

interface Inspected {
  Name: string;
  Config: {
    Image: string;
    Env?: string[] | null;
    Cmd?: string[] | null;
    Entrypoint?: string[] | null;
    Labels?: Record<string, string> | null;
  };
  State: { Status: string };
}

/** What a container most likely is. Order matters: databases first, then languages. */
export function guessContainer(
  image: string,
  env: string[],
  command: string[],
): DiscoveredContainer['guess'] {
  const img = image.toLowerCase();
  const names = new Set(env.map((e) => e.split('=')[0]!));
  const cmd = command.join(' ').toLowerCase();
  if (/(^|\/)postgres(ql)?[:@]|(^|\/)postgres(ql)?$|postgis/.test(img))
    return { integration: 'postgresql' };
  if (/(^|\/)(redis|valkey)([:@]|$)/.test(img)) return { integration: 'redis' };
  if (/(^|\/)(nginx|nginx-unprivileged)([:@]|$)/.test(img)) return { integration: 'nginx' };
  if (
    names.has('NODE_VERSION') ||
    /(^|\/)node([:@]|$)/.test(img) ||
    /^node\b|\bnpm\b|\bnext\b/.test(cmd)
  )
    return { language: 'nodejs' };
  if (
    names.has('PYTHON_VERSION') ||
    /(^|\/)python([:@]|$)/.test(img) ||
    /\b(python3?|gunicorn|uvicorn|flask|django)\b/.test(cmd)
  )
    return { language: 'python' };
  if (
    names.has('JAVA_HOME') ||
    names.has('JAVA_VERSION') ||
    /temurin|openjdk|(^|\/)java([:@]|$)|corretto/.test(img) ||
    /\bjava\b/.test(cmd)
  )
    return { language: 'java' };
  if (names.has('GOLANG_VERSION') || /(^|\/)golang([:@]|$)/.test(img)) return { language: 'go' };
  if (names.has('DOTNET_VERSION') || names.has('ASPNETCORE_URLS') || /dotnet|aspnet/.test(img))
    return { language: 'dotnet' };
  if (names.has('PHP_VERSION') || /(^|\/)php([:@]|$)/.test(img)) return { language: 'php' };
  return {};
}

/**
 * The containers running on this machine, except Raion's own (its stack, and the helpers that
 * copy agents into applications).
 */
export async function discoverContainers(
  runner: Runner,
  options: { excludeProjects: string[] },
): Promise<DiscoveredContainer[]> {
  const ids = await runner.run(['ps', '-q', '--no-trunc'], { timeoutMs: 20_000 });
  if (ids.code !== 0) throw new Error(`docker ps failed: ${ids.stderr.trim()}`);
  const list = ids.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) return [];
  const inspected = await runner.run(['inspect', ...list.slice(0, 200)], { timeoutMs: 30_000 });
  if (inspected.code !== 0) throw new Error(`docker inspect failed: ${inspected.stderr.trim()}`);
  const containers = JSON.parse(inspected.stdout) as Inspected[];
  const found: DiscoveredContainer[] = [];
  for (const c of containers) {
    const labels = c.Config.Labels ?? {};
    // Raion's own components are not applications to monitor.
    if (labels['dev.raion.component']) continue;
    const project = labels['com.docker.compose.project'];
    const service = labels['com.docker.compose.service'];
    if (project && options.excludeProjects.includes(project)) continue;
    if (service?.startsWith('raion-agent-')) continue;
    found.push({
      container: c.Name.replace(/^\//, ''),
      image: c.Config.Image,
      state: c.State.Status,
      ...(project && service
        ? {
            compose: {
              project,
              service,
              configFiles: (labels['com.docker.compose.project.config_files'] ?? '')
                .split(',')
                .map((f) => f.trim())
                .filter(Boolean),
              workingDir: labels['com.docker.compose.project.working_dir'] ?? '',
            },
          }
        : {}),
      guess: guessContainer(c.Config.Image, c.Config.Env ?? [], [
        ...(c.Config.Entrypoint ?? []),
        ...(c.Config.Cmd ?? []),
      ]),
    });
  }
  return found.sort((a, b) => a.container.localeCompare(b.container));
}
