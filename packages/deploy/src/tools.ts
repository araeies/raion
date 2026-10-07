import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { imageRef, RUNTIME_SECRETS, type ComponentId, type RuntimeBundle } from '@raion/core';
import type { Runner } from './docker.js';
import { writeFiles } from './releases.js';
import type { StatePaths } from './state.js';

export interface ToolCheck {
  component: ComponentId | 'compose';
  tool: string;
  ok: boolean;
  output: string;
}

interface CheckSpec {
  component: ComponentId;
  tool: string;
  entrypoint?: string;
  args: string[];
  mounts: [string, string][];
}

/** Each component's own validator, run against the generated files before anything is deployed. */
function checks(paths: StatePaths, staging: string): CheckSpec[] {
  return [
    {
      component: 'otel-collector',
      tool: 'otelcol-contrib validate',
      args: ['validate', '--config=/etc/otelcol/config.yaml'],
      mounts: [
        [join(staging, 'otel-collector'), '/etc/otelcol'],
        // Placeholders for ${file:...} credentials: validation never sees real secrets.
        [join(staging, 'placeholder-secrets'), '/run/secrets'],
      ],
    },
    {
      component: 'prometheus',
      tool: 'promtool check config',
      entrypoint: 'promtool',
      args: ['check', 'config', '/etc/prometheus/prometheus.yml'],
      mounts: [[join(staging, 'prometheus'), '/etc/prometheus']],
    },
    {
      component: 'alertmanager',
      tool: 'amtool check-config',
      entrypoint: 'amtool',
      args: ['check-config', '/etc/alertmanager/alertmanager.yml'],
      mounts: [[join(staging, 'alertmanager'), '/etc/alertmanager']],
    },
    {
      component: 'loki',
      tool: 'loki -verify-config',
      args: ['-config.file=/etc/loki/loki.yaml', '-verify-config'],
      mounts: [[join(staging, 'loki'), '/etc/loki']],
    },
    {
      component: 'tempo',
      tool: 'tempo -config.verify',
      args: ['-config.file=/etc/tempo/tempo.yaml', '-config.verify=true'],
      mounts: [[join(staging, 'tempo'), '/etc/tempo']],
    },
    {
      component: 'gateway',
      tool: 'nginx -t',
      entrypoint: 'nginx',
      args: ['-t', '-q', '-c', '/etc/nginx/raion/nginx.conf'],
      mounts: [
        [join(staging, 'gateway'), '/etc/nginx/raion'],
        [paths.secret(RUNTIME_SECRETS.gatewayAuthConf), '/run/secrets/gateway_auth.conf'],
      ],
    },
  ];
}

/** How long one image may take to download: a first run fetches over a gigabyte in total. */
const PULL_TIMEOUT_MS = 20 * 60_000;

export class ImagePullError extends Error {}

/**
 * Downloads the images of `bundle` that are not on this machine yet, one at a time, so that a
 * first run shows its progress and no later step (validation, start-up) is cut short by a
 * download.
 */
export async function pullMissingImages(
  runner: Runner,
  bundle: RuntimeBundle,
  log: (message: string) => void,
): Promise<string[]> {
  const images = [...new Set(bundle.components.map((c) => imageRef(c.id)))];
  const missing: string[] = [];
  for (const image of images) {
    const inspect = await runner.run(['image', 'inspect', '--format', '{{.Id}}', image], {
      timeoutMs: 30_000,
    });
    if (inspect.code !== 0) missing.push(image);
  }
  for (const [i, image] of missing.entries()) {
    const name = image.split('@')[0]!;
    log(`Downloading image ${i + 1} of ${missing.length}: ${name}…`);
    const result = await runner.run(['pull', '--quiet', image], { timeoutMs: PULL_TIMEOUT_MS });
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().split('\n').slice(-4).join('\n    ');
      throw new ImagePullError(
        result.code === 124
          ? `downloading ${name} did not finish within ${PULL_TIMEOUT_MS / 60_000} minutes. Check your internet connection, then run apply again: images already downloaded are kept.`
          : `could not download ${name}:\n    ${detail}\nCheck that Docker can reach Docker Hub (internet connection, proxy or firewall settings, Docker Hub download limits), then run apply again.`,
      );
    }
  }
  return missing;
}

/**
 * Validates generated configuration with the real tools (in their pinned images, without
 * network access). Catches anything the generators got wrong before it reaches the runtime.
 */
export async function validateWithTools(
  runner: Runner,
  paths: StatePaths,
  bundle: RuntimeBundle,
): Promise<ToolCheck[]> {
  const staging = join(paths.root, `staging-${randomBytes(4).toString('hex')}`);
  writeFiles(staging, bundle.artifacts);
  mkdirSync(join(staging, 'placeholder-secrets'), { recursive: true });
  for (const s of bundle.secrets) {
    writeFileSync(join(staging, 'placeholder-secrets', s.composeName), 'placeholder');
  }
  const present = new Set(bundle.components.map((c) => c.id));
  try {
    const results = await Promise.all(
      checks(paths, staging)
        .filter((c) => present.has(c.component))
        .map(async (c): Promise<ToolCheck> => {
          const args = [
            'run',
            '--rm',
            '--network',
            'none',
            '--read-only',
            '--tmpfs',
            '/tmp',
            ...c.mounts.flatMap(([src, dst]) => [
              '--mount',
              `type=bind,src=${src},dst=${dst},readonly`,
            ]),
            ...(c.entrypoint ? ['--entrypoint', c.entrypoint] : []),
            imageRef(c.component),
            ...c.args,
          ];
          const result = await runner.run(args, { timeoutMs: 180_000 });
          return {
            component: c.component,
            tool: c.tool,
            ok: result.code === 0,
            output:
              result.code === 124
                ? 'the check did not finish within 3 minutes (is Docker overloaded or still downloading?)'
                : (result.stderr || result.stdout).trim().split('\n').slice(-10).join('\n'),
          };
        }),
    );
    const compose = await runner.run(
      ['compose', '-f', join(staging, 'compose.yaml'), 'config', '--quiet'],
      {
        timeoutMs: 60_000,
      },
    );
    results.push({
      component: 'compose',
      tool: 'docker compose config',
      ok: compose.code === 0,
      output: (compose.stderr || compose.stdout).trim(),
    });
    return results;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
