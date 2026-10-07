import { describe, expect, it } from 'vitest';
import { connectService, renderLock, validateSources, type SourceFile } from '../src/index.js';

const WORKSPACE = {
  path: 'raion.yaml',
  content:
    'apiVersion: raion/v1alpha1\nkind: Workspace\nmetadata:\n  name: acme\nspec:\n  services:\n    - name: billing\n      type: api\n      language: java\n',
};

const MANIFEST = `apiVersion: raion/v1alpha1
kind: Integration
metadata:
  name: acme-java
  version: 1.0.0
spec:
  kind: application
  displayName: Java (Acme agent)
  description: The OpenTelemetry Java agent, the way Acme runs it.
  languages: [java]
  instrumentation:
    env:
      JAVA_TOOL_OPTIONS: -javaagent:/otel/opentelemetry-javaagent.jar
      OTEL_SERVICE_NAME: \${service.name}
      OTEL_EXPORTER_OTLP_ENDPOINT: \${otlp.httpEndpoint}
  capabilities:
    - id: traces.otlp
  docs: README.md
`;

function files(manifest = MANIFEST, name = 'acme-java'): SourceFile[] {
  return [
    WORKSPACE,
    { path: `integrations/${name}/integration.yaml`, content: manifest },
    { path: `integrations/${name}/README.md`, content: '# Acme Java\n' },
  ];
}

const locked = (sources: SourceFile[]): SourceFile[] => [
  ...sources,
  { path: 'integrations.lock.yaml', content: renderLock(sources).content },
];

const codes = (sources: SourceFile[]) =>
  validateSources(sources).diagnostics.map((d) => `${d.code} ${d.message}`);

describe('workspace integration packages', () => {
  it('are refused until they are locked', () => {
    expect(codes(files())).toEqual([
      'RAI-E026 integration package "acme-java" is not in integrations.lock.yaml',
    ]);
  });

  it('are used once locked: chosen from the language, and connected with their settings', () => {
    const result = validateSources(locked(files()));
    expect(result.diagnostics).toEqual([]);
    const billing = result.workspace!.services[0]!;
    expect(billing.integrations.map((i) => [i.name, i.implicit])).toEqual([['acme-java', true]]);
    const connection = connectService(result.workspace!, billing);
    expect(connection.integration!.displayName).toBe('Java (Acme agent)');
    expect(connection.env).toContainEqual(['OTEL_SERVICE_NAME', 'billing']);
  });

  it('are refused again when changed after locking', () => {
    const lock = renderLock(files()).content;
    const changed = [
      ...files(MANIFEST.replace('-javaagent:/otel/', '-javaagent:/tmp/')),
      { path: 'integrations.lock.yaml', content: lock },
    ];
    expect(codes(changed)).toEqual([
      'RAI-E026 integration package "acme-java" changed since it was locked',
    ]);
  });

  it('match regardless of line endings, so Windows checkouts verify', () => {
    const crlf = files().map((f) => ({ ...f, content: f.content.replaceAll('\n', '\r\n') }));
    expect(
      validateSources([
        ...crlf,
        { path: 'integrations.lock.yaml', content: renderLock(files()).content },
      ]).ok,
    ).toBe(true);
  });

  it('must not shadow a built-in, must match their directory, and stay within the placeholders', () => {
    expect(
      codes(files(MANIFEST.replace('name: acme-java', 'name: nodejs'), 'nodejs'))[0],
    ).toContain('"nodejs" is a built-in integration');
    expect(codes(files(MANIFEST, 'other'))[0]).toContain('its directory is "other"');
    const reads = MANIFEST.replace('${service.name}', '${env:AWS_SECRET_ACCESS_KEY}');
    expect(codes(files(reads))[0]).toMatch(/^RAI-E025 .*env:AWS_SECRET_ACCESS_KEY/);
  });

  it('cannot add collector receivers outside the allow-list', () => {
    const receiver = MANIFEST.replace(
      '  capabilities:',
      '  collector:\n    receiver: filelog\n  capabilities:',
    );
    expect(codes(files(receiver))[0]).toMatch(/^RAI-E025 .*collector\.receiver/);
  });

  it('write a lock file that lists each package with its version and checksum', () => {
    const lock = renderLock(files());
    expect(lock.packages).toEqual([
      { name: 'acme-java', version: '1.0.0', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
    expect(lock.content).toContain('kind: IntegrationLock');
  });
});
