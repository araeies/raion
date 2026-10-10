// End-to-end check that Raion's injected OpenTelemetry agents work in real containers: for
// Node.js, Python and Java, an application WITHOUT any OpenTelemetry in its image is started with
// the settings and agent helper Raion generates, and must send telemetry. A tiny OTLP receiver
// stands in for the collector. Needs Docker.
//
//   node e2e/agents.e2e.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const core = await import(new URL('../packages/core/dist/index.js', import.meta.url).href);
// yaml is a dependency of core, not of the repository root.
const { parse, stringify } = createRequire(
  new URL('../packages/core/package.json', import.meta.url),
)('yaml');
const dir = mkdtempSync(join(tmpdir(), 'raion-agents-'));
const project = `raion-agents-${process.pid}`;

const APPS = {
  nodejs: {
    image: 'node:24-slim',
    file: 'app.js',
    source: `const http = require('node:http');
http.createServer((req, res) => { console.log('request', req.url); res.end('ok'); }).listen(8080);
setInterval(() => http.get('http://localhost:8080/ping', (r) => r.resume()), 1000);`,
    command: ['node', '/app/app.js'],
    integration: { name: 'nodejs', params: { injectAgent: true } },
    expect: ['/v1/traces', '/v1/metrics'],
  },
  python: {
    image: 'python:3.12-slim',
    file: 'app.py',
    source: `import logging, time
logging.basicConfig(level=logging.INFO)
while True:
    logging.getLogger("shop").warning("still here")
    time.sleep(1)`,
    command: ['python', '/app/app.py'],
    integration: { name: 'python', params: { injectAgent: true } },
    expect: ['/v1/logs'],
  },
  java: {
    image: 'eclipse-temurin:21-jdk',
    file: 'App.java',
    source: `public class App {
  public static void main(String[] args) throws Exception {
    while (true) { System.out.println("still here"); Thread.sleep(1000); }
  }
}`,
    // Compiled first, like a real application: the agent stays off for JDK tools such as javac.
    command: ['sh', '-c', 'javac -d /tmp/classes /app/App.java && exec java -cp /tmp/classes App'],
    integration: { name: 'java' },
    // The JVM's own metrics are exported even when no library is instrumented.
    expect: ['/v1/metrics'],
  },
};

// An OTLP/HTTP receiver that just logs which endpoints were called.
writeFileSync(
  join(dir, 'sink.js'),
  // The service name is a plain string inside the protobuf payload: log who sent what.
  `const names = ${JSON.stringify(['nodejs', 'python', 'java'])};
require('node:http').createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('latin1');
    const zipped = req.headers['content-encoding'] === 'gzip';
    const text = zipped ? require('node:zlib').gunzipSync(Buffer.concat(chunks)).toString('latin1') : body;
    let found = false;
    for (const n of names) if (text.includes(n)) { console.log('OTLP', req.url, n); found = true; }
    if (!found) console.log('OTLP', req.url, 'unknown sender', zipped ? '(gzip)' : '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
}).listen(4318);`,
);

const services = {
  sink: { image: 'node:24-slim', command: ['node', '/app/sink.js'], volumes: [`${dir}:/app:ro`] },
};
let volumes = {};
for (const [name, app] of Object.entries(APPS)) {
  writeFileSync(join(dir, app.file), app.source);
  const ws = core.validateSources([
    {
      path: 'raion.yaml',
      content: stringify({
        apiVersion: 'raion/v1alpha1',
        kind: 'Workspace',
        metadata: { name: 'agents' },
        spec: {
          level: 2,
          services: [{ name, type: 'api', integrations: [app.integration] }],
        },
      }),
    },
  ]);
  if (!ws.workspace) throw new Error(JSON.stringify(ws.diagnostics));
  const connection = core.connectService(ws.workspace, ws.workspace.services[0]);
  if (!connection.agent) throw new Error(`${name}: Raion did not add an agent`);
  const override = parse(core.composeOverride(ws.workspace, [connection]));
  // Raion's override, pointed at the stand-in receiver instead of the collector.
  const env = Object.fromEntries(
    connection.env.map(([k, v]) => [
      k,
      k === 'OTEL_EXPORTER_OTLP_ENDPOINT' ? 'http://sink:4318' : v,
    ]),
  );
  services[`raion-agent-${name}`] = override.services[`raion-agent-${name}`];
  services[name] = {
    image: app.image,
    command: app.command,
    environment: env,
    volumes: [`${dir}:/app:ro`, ...override.services[name].volumes],
    depends_on: { ...override.services[name].depends_on, sink: { condition: 'service_started' } },
  };
  volumes = { ...volumes, ...override.volumes };
}
writeFileSync(join(dir, 'compose.yaml'), stringify({ name: project, services, volumes }));

const compose = (...args) =>
  spawnSync('docker', ['compose', '-f', join(dir, 'compose.yaml'), ...args], { encoding: 'utf8' });
let failed = false;
try {
  const up = compose('up', '-d');
  if (up.status !== 0) throw new Error(`docker compose up failed:\n${up.stderr}`);
  const deadline = Date.now() + 180_000;
  const pending = new Map(Object.entries(APPS).map(([n, a]) => [n, new Set(a.expect)]));
  while (Date.now() < deadline && [...pending.values()].some((s) => s.size > 0)) {
    await new Promise((r) => setTimeout(r, 5000));
    const logs = compose('logs', '--no-color', 'sink').stdout;
    for (const [name, wanted] of pending) {
      const own = compose('logs', '--no-color', name).stdout;
      if (/Error|exception|ERR_/.test(own) && !/still here|request/.test(own)) {
        console.log(own.split('\n').slice(-15).join('\n'));
      }
      for (const path of [...wanted])
        if (logs.includes(`OTLP ${path} ${name}`)) wanted.delete(path);
    }
  }
  for (const [name, wanted] of pending) {
    if (wanted.size > 0) {
      failed = true;
      console.log(`✗ ${name}: nothing received on ${[...wanted].join(', ')}`);
      const own = compose('logs', '--no-color', name).stdout.split('\n');
      console.log(
        own
          .filter((l) => !l.includes('still here'))
          .slice(0, 25)
          .join('\n'),
      );
      console.log(compose('logs', '--no-color', '--tail', '15', 'sink').stdout);
    } else console.log(`✓ ${name}: the injected agent sends telemetry`);
  }
  const helpers = compose('ps', '-a', '--format', '{{.Service}} {{.State}} {{.ExitCode}}').stdout;
  console.log(helpers.trim());
} finally {
  compose('down', '-v', '--remove-orphans');
  rmSync(dir, { recursive: true, force: true });
}
if (failed) {
  console.error('\n✗ injected agents did not all send telemetry');
  process.exit(1);
}
console.log('\n✓ every injected agent sends telemetry');
