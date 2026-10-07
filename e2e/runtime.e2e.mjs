// Full-stack end-to-end test of the Docker Compose runtime, driven through the real CLI
// exactly as a user would. Needs Docker. Run after "pnpm run build":
//
//   node e2e/runtime.e2e.mjs
//
// Uses its own Compose project name and ports, so it can run next to a real Raion stack.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const cli = join(root, 'apps', 'cli', 'dist', 'index.js');
const tmp = mkdtempSync(join(tmpdir(), 'raion-e2e-'));
const ws = join(tmp, 'observability');
const keep = process.argv.includes('--keep');

let step = 0;
function raion(args, { expectCode = 0 } = {}) {
  step += 1;
  console.log(`\n[${step}] raion ${args.join(' ')}`);
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    timeout: 900_000,
  });
  const output = `${result.stdout}${result.stderr}`;
  console.log(
    output
      .trim()
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n'),
  );
  if (result.status !== expectCode) {
    throw new Error(`expected exit code ${expectCode}, got ${result.status}`);
  }
  return output;
}

function expectContains(output, text) {
  if (!output.includes(text)) throw new Error(`expected output to contain: ${text}`);
}

try {
  raion([
    'init',
    ws,
    '--yes',
    '--name',
    'e2e',
    '--level',
    '2',
    '--service',
    'demo-api',
    '--type',
    'api',
    '--language',
    'nodejs',
  ]);

  // Isolate from any other Raion stack on this machine.
  const config = readFileSync(join(ws, 'raion.yaml'), 'utf8').replace(
    '  target:\n    type: docker-compose\n',
    '  target:\n    type: docker-compose\n    compose:\n      projectName: raion-e2e\n      gatewayPort: 17601\n      otlpGrpcPort: 14317\n      otlpHttpPort: 14318\n',
  );
  writeFileSync(join(ws, 'raion.yaml'), config);

  raion(['validate', ws, '--deep']);
  expectContains(raion(['plan', ws, '--no-tool-validation']), 'Plan: 8 to start');

  const apply = raion(['apply', ws, '--yes']);
  expectContains(apply, 'is deployed and every component is ready');

  const status = raion(['status', ws]);
  expectContains(status, 'The observability stack is healthy.');
  for (const job of [
    'otel-collector',
    'prometheus',
    'loki',
    'tempo',
    'grafana',
    'alertmanager',
    'node-exporter',
  ]) {
    if (!new RegExp(`✓ ${job}\\s+up`).test(status))
      throw new Error(`scrape target ${job} is not up`);
  }

  expectContains(raion(['verify', ws]), 'The telemetry pipeline works end to end.');

  // Idempotency: nothing changed, nothing restarts.
  raion(['plan', ws, '--no-tool-validation', '--detailed-exitcode']);
  const reapply = raion(['apply', ws, '--yes']);
  if (reapply.includes('Restarting'))
    throw new Error('re-applying an unchanged workspace restarted components');

  // A targeted change restarts only the affected component.
  writeFileSync(
    join(ws, 'raion.yaml'),
    `${readFileSync(join(ws, 'raion.yaml'), 'utf8')}  retention:\n    logs: 14d\n`,
  );
  raion(['plan', ws, '--no-tool-validation', '--detailed-exitcode'], { expectCode: 3 });
  expectContains(
    raion(['apply', ws, '--yes']),
    'Restarting components with changed configuration: loki',
  );
  expectContains(raion(['status', ws]), 'The observability stack is healthy.');

  // Drift: changes made behind Raion's back are found, and repaired.
  expectContains(raion(['drift', ws]), 'The running stack matches release');
  const generated = join(ws, '.raion', 'runtime', 'prometheus', 'prometheus.yml');
  writeFileSync(generated, `${readFileSync(generated, 'utf8')}# edited by hand\n`);
  execFileSync('docker', ['stop', 'raion-e2e-loki-1'], { stdio: 'ignore' });
  const drifted = raion(['drift', ws], { expectCode: 3 });
  expectContains(drifted, 'file changed');
  expectContains(drifted, 'prometheus/prometheus.yml');
  expectContains(drifted, 'container stopped');
  expectContains(raion(['drift', ws, '--repair', '--yes']), 'is restored');
  expectContains(raion(['drift', ws]), 'The running stack matches release');
  if (readFileSync(generated, 'utf8').includes('# edited by hand')) {
    throw new Error('repair did not restore the generated file');
  }
  expectContains(raion(['status', ws]), 'The observability stack is healthy.');

  // Gateway refuses requests without the secret.
  const anonymous = spawnSync(
    'curl',
    ['-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://127.0.0.1:17601/prometheus/-/ready'],
    { encoding: 'utf8' },
  );
  if (anonymous.status === 0 && anonymous.stdout !== '401')
    throw new Error(`gateway answered ${anonymous.stdout} without a token`);

  console.log('\n✓ runtime end-to-end test passed');
} finally {
  if (!keep) {
    try {
      raion(['destroy', ws, '--yes', '--delete-data']);
    } catch (error) {
      console.error(`cleanup failed: ${error.message}`);
      execFileSync(
        'docker',
        ['compose', '-p', 'raion-e2e', 'down', '--volumes', '--remove-orphans'],
        { stdio: 'inherit' },
      );
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}
