import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkspace } from '@raion/core';
import { stateRoot } from '@raion/deploy';
import { buildApp } from './app.js';
import { AlertInbox } from './inbox.js';
import { RuntimeService } from './runtime.js';
import { AuthService, DEFAULT_AUTH } from './auth.js';
import { Store } from './store.js';

export interface ServerOptions {
  workspaceDir: string;
  host: string;
  port: number;
  tls?: { certFile: string; keyFile: string };
  /** Set when a TLS-terminating reverse proxy sits in front of Raion. */
  trustProxy: boolean;
  /** Public URL users open, e.g. https://raion.example.com. Required off-loopback. */
  publicUrl?: string;
  uiDir?: string;
  logger?: boolean;
}

export class ServerConfigError extends Error {}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || host.startsWith('127.');
}

/**
 * Validates the network exposure of the server. Raion can deploy containers, so it must
 * never be reachable over plain HTTP from the network.
 */
export function resolveExposure(options: ServerOptions): {
  allowedHosts: string[];
  secure: boolean;
  url: string;
} {
  const loopback = isLoopbackHost(options.host);
  if (options.tls && options.trustProxy) {
    throw new ServerConfigError('use either --tls-cert/--tls-key or --trust-proxy, not both');
  }
  if (!loopback && !options.tls && !options.trustProxy) {
    throw new ServerConfigError(
      `refusing to serve plain HTTP on non-loopback address ${options.host}. ` +
        'Provide --tls-cert and --tls-key, or put Raion behind a TLS-terminating reverse proxy and pass --trust-proxy',
    );
  }
  if (!loopback && !options.publicUrl) {
    throw new ServerConfigError(
      '--public-url is required when listening on a non-loopback address',
    );
  }

  let publicUrl: URL | undefined;
  if (options.publicUrl) {
    try {
      publicUrl = new URL(options.publicUrl);
    } catch {
      throw new ServerConfigError(`--public-url "${options.publicUrl}" is not a valid URL`);
    }
    if (!loopback && publicUrl.protocol !== 'https:') {
      throw new ServerConfigError(
        '--public-url must use https:// when listening on a non-loopback address',
      );
    }
  }

  const secure = Boolean(options.tls) || options.trustProxy;
  const hosts = new Set<string>();
  if (publicUrl) hosts.add(publicUrl.host);
  if (loopback) {
    for (const name of ['localhost', '127.0.0.1', '[::1]']) hosts.add(`${name}:${options.port}`);
  }
  const scheme = secure ? 'https' : 'http';
  const hostForUrl = isIP(options.host) === 6 ? `[${options.host}]` : options.host;
  return {
    allowedHosts: [...hosts],
    secure,
    url: publicUrl ? publicUrl.origin : `${scheme}://${hostForUrl}:${options.port}`,
  };
}

export function defaultUiDir(): string {
  return fileURLToPath(new URL('../../web/dist', import.meta.url));
}

export async function startServer(
  options: ServerOptions,
): Promise<{ url: string; close: () => Promise<void> }> {
  const exposure = resolveExposure(options);
  const workspaceDir = resolve(options.workspaceDir);
  let https: { cert: Buffer; key: Buffer } | undefined;
  if (options.tls) {
    try {
      https = { cert: readFileSync(options.tls.certFile), key: readFileSync(options.tls.keyFile) };
    } catch (error) {
      throw new ServerConfigError(
        `cannot read TLS certificate or key: ${(error as Error).message}`,
      );
    }
  }
  const store = new Store(join(stateRoot(workspaceDir), 'raion.db'));
  const auth = new AuthService(store, DEFAULT_AUTH);

  const runtime = new RuntimeService(workspaceDir);
  const inbox = new AlertInbox(store, runtime);
  const app = await buildApp({
    runtime,
    inbox,
    workspaceDir,
    store,
    auth,
    allowedHosts: exposure.allowedHosts,
    secure: exposure.secure,
    trustProxy: options.trustProxy,
    uiDir: options.uiDir ?? defaultUiDir(),
    logger: options.logger ?? true,
    ...(https ? { https } : {}),
  });

  await app.listen({ host: options.host, port: options.port });

  // Grafana builds its links from the workspace's server.publicUrl; warn when they disagree.
  const ws = await loadWorkspace(workspaceDir);
  if (ws.workspace) {
    const configured = new URL(ws.workspace.server.publicUrl).origin;
    if (configured !== new URL(exposure.url).origin) {
      process.stderr.write(
        `\nWarning: raion.yaml sets server.publicUrl to ${configured}, but this server is reached at ${exposure.url}.\n` +
          'Grafana links and redirects use server.publicUrl; update it and run "raion apply".\n',
      );
    }
  }

  inbox.start();
  const prune = setInterval(() => auth.pruneSessions(), 60 * 60_000);
  prune.unref();

  const setupToken = auth.issueSetupToken();
  if (setupToken) {
    // The token is in the URL fragment, so it never reaches server or proxy access logs.
    process.stdout.write(
      `\nNo users exist yet. Create the first admin within 30 minutes:\n  ${exposure.url}/setup#token=${setupToken}\n\n`,
    );
  }

  return {
    url: exposure.url,
    close: async () => {
      clearInterval(prune);
      inbox.stop();
      await app.close();
      store.close();
    },
  };
}

export function readPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}
