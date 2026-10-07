import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  generateRuntime,
  loadWorkspace,
  validateSources,
  type RuntimeBundle,
} from '../src/index.js';

const examples = join(import.meta.dirname, '..', '..', '..', 'examples', 'workspaces');

async function bundleFor(example: string): Promise<RuntimeBundle> {
  const result = await loadWorkspace(join(examples, example));
  return generateRuntime(result.workspace!);
}

function workspace(spec: string) {
  const result = validateSources([
    {
      path: 'raion.yaml',
      content: `apiVersion: raion/v1alpha1\nkind: Workspace\nmetadata:\n  name: t\nspec:\n${spec}`,
    },
  ]);
  if (!result.workspace) throw new Error(JSON.stringify(result.diagnostics));
  return result.workspace;
}

function compose(bundle: RuntimeBundle) {
  const file = bundle.artifacts.find((a) => a.path === 'compose.yaml')!;
  return parse(file.content) as {
    services: Record<string, Record<string, unknown>>;
    networks: Record<string, { internal?: boolean; name?: string }>;
    secrets: Record<string, { file: string }>;
  };
}

describe('generated runtime', () => {
  it('is deterministic', async () => {
    const a = await bundleFor('level3-sre');
    const b = await bundleFor('level3-sre');
    expect(a.artifacts).toEqual(b.artifacts);
  });

  for (const example of ['level1-basic', 'level3-sre']) {
    it(`matches the reviewed golden files for ${example}`, async () => {
      const bundle = await bundleFor(example);
      for (const artifact of bundle.artifacts) {
        await expect(artifact.content).toMatchFileSnapshot(
          join('__golden__', example, `${artifact.path.replaceAll('/', '__')}.txt`),
        );
      }
    });
  }

  it('deploys tracing storage only when some service uses traces', async () => {
    expect((await bundleFor('level1-basic')).components.map((c) => c.id)).not.toContain('tempo');
    expect((await bundleFor('level3-sre')).components.map((c) => c.id)).toContain('tempo');
  });

  it('raises metrics retention to cover the longest SLO window', async () => {
    const bundle = await bundleFor('level3-sre');
    expect(bundle.retention.metrics).toBe('33d');
    expect(bundle.notes[0]!.message).toContain('raised from 15d to 33d');
    expect(compose(bundle).services.prometheus!.command).toContain(
      '--storage.tsdb.retention.time=33d',
    );
  });

  it('keeps configured retention when no SLO needs more', async () => {
    const bundle = generateRuntime(workspace('  retention: { metrics: 45d }\n'));
    expect(bundle.retention.metrics).toBe('45d');
    expect(bundle.notes).toEqual([]);
  });

  it('only deploys cAdvisor when containers are enabled, and requires approval for it', () => {
    expect(
      generateRuntime(workspace('  level: 1\n')).components.some((c) => c.id === 'cadvisor'),
    ).toBe(false);
    const bundle = generateRuntime(workspace('  infrastructure: { containers: true }\n'));
    const cadvisor = bundle.components.find((c) => c.id === 'cadvisor')!;
    expect(cadvisor.requiresApproval).toBe(true);
    expect(bundle.components.filter((c) => c.requiresApproval).map((c) => c.id)).toEqual([
      'cadvisor',
    ]);
  });
});

describe('security defaults of the generated stack', () => {
  it('hardens every container except documented exceptions', async () => {
    const { services } = compose(await bundleFor('level3-sre'));
    for (const [name, svc] of Object.entries(services)) {
      expect(svc.cap_drop, name).toEqual(['ALL']);
      expect(svc.security_opt, name).toEqual(['no-new-privileges:true']);
      expect(svc.read_only, name).toBe(true);
      expect(svc.privileged, name).toBeUndefined();
      expect(svc.mem_limit, name).toBeDefined();
      expect(String(svc.image), name).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
  });

  it('publishes only the gateway and the OTLP receiver, and only on loopback', async () => {
    const { services } = compose(await bundleFor('level3-sre'));
    const published = Object.entries(services).filter(([, s]) => s.ports !== undefined);
    expect(published.map(([n]) => n).sort()).toEqual(['gateway', 'otel-collector']);
    for (const [, s] of published) {
      for (const port of s.ports as string[]) expect(port).toMatch(/^127\.0\.0\.1:/);
    }
  });

  it('isolates backends on an internal network that applications cannot join', async () => {
    const { services, networks } = compose(await bundleFor('level3-sre'));
    expect(networks.backend!.internal).toBe(true);
    expect(networks.ingest!.name).toBe('raion-ingest');
    const onIngest = Object.entries(services).filter(([, s]) =>
      (s.networks as string[]).includes('ingest'),
    );
    expect(onIngest.map(([n]) => n)).toEqual(['otel-collector']);
    expect(services.grafana!.networks as string[]).toEqual(['backend']);
  });

  it('never mounts the Docker socket and references secrets only by file', async () => {
    const bundle = await bundleFor('level3-sre');
    for (const artifact of bundle.artifacts) {
      expect(artifact.content, artifact.path).not.toContain('docker.sock');
    }
    const { secrets } = compose(bundle);
    expect(
      Object.values(secrets)
        .map((s) => s.file)
        .sort(),
    ).toEqual([
      '../secrets/PAYMENTS_SLACK_WEBHOOK',
      '../secrets/gateway_auth.conf',
      '../secrets/grafana-admin-password',
    ]);
  });

  it('protects every gateway route with the token check', async () => {
    const nginx = (await bundleFor('level3-sre')).artifacts.find(
      (a) => a.path === 'gateway/nginx.conf',
    )!.content;
    const locations = nginx
      .split('location ')
      .slice(1)
      .filter((l) => !l.startsWith('= /healthz') && !l.startsWith('/ {'));
    expect(locations.length).toBeGreaterThan(4);
    for (const location of locations)
      expect(location).toContain('if ($raion_authorized = 0) { return 401; }');
    expect(nginx).toContain('proxy_set_header X-Raion-Gateway-Token "";');
  });

  it('configures Grafana for Raion single sign-on only', async () => {
    const { services } = compose(await bundleFor('level3-sre'));
    const env = services.grafana!.environment as Record<string, string>;
    expect(env.GF_AUTH_PROXY_ENABLED).toBe('true');
    expect(env.GF_AUTH_DISABLE_LOGIN_FORM).toBe('true');
    expect(env.GF_AUTH_ANONYMOUS_ENABLED).toBe('false');
    expect(env.GF_AUTH_BASIC_ENABLED).toBe('false');
    expect(env.GF_SECURITY_ADMIN_PASSWORD__FILE).toBe('/run/secrets/grafana_admin_password');
    expect(Object.keys(env).some((k) => k === 'GF_SECURITY_ADMIN_PASSWORD')).toBe(false);
  });
});
