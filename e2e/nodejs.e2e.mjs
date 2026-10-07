// End-to-end test of the Node.js integration with the example application, driven through
// the real CLI and Docker Compose, exactly as a user would:
//
//   raion apply → raion connect --out … → docker compose -f compose.yaml -f override up
//   → raion verify --service (metrics, logs, traces, logs linked to traces)
//
//   node e2e/nodejs.e2e.mjs [--keep]
//
// Uses its own project names and ports, so it can run next to a real Raion stack.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = join(import.meta.dirname, '..');
const cli = join(root, 'apps', 'cli', 'dist', 'index.js');
const tmp = mkdtempSync(join(tmpdir(), 'raion-e2e-node-'));
const app = join(tmp, 'app');
const ws = join(app, 'observability');
const appProject = 'raion-e2e-app';
const keep = process.argv.includes('--keep');
const WEBHOOK = 'raion-e2e-webhook';
const OSLO_IMAGE =
  'ghcr.io/openslo/oslo:0.9.0@sha256:29d5b6959d406e15ee01cf511a916d82aca689103c9ef544345011083a8cfa1c';
const NODE_IMAGE =
  'node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1';

/** Polls `raion alerts --format json` until `predicate` holds. */
async function waitForAlerts(what, predicate, timeoutMs = 360_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { output, code } = raion(['alerts', 'observability', '--format', 'json'], {
      expectCode: null,
      quiet: true,
    });
    let state;
    try {
      state = JSON.parse(output.slice(output.indexOf('{')));
    } catch {
      state = undefined;
    }
    if (state && predicate(state, code)) {
      console.log(`    ✓ ${what}`);
      return state;
    }
    if (Date.now() > deadline) {
      console.log(output);
      throw new Error(`timed out waiting for: ${what}`);
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

const firing = (state, alertname, labels = {}) =>
  state.alerts.some(
    (a) =>
      a.labels.alertname === alertname &&
      a.status.state === 'active' &&
      Object.entries(labels).every(([k, v]) => a.labels[k] === v),
  );

function run(command, args, { cwd = app, expectCode = 0, quiet = false, input } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 900_000,
    ...(input !== undefined ? { input } : {}),
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (!quiet || (expectCode !== null && result.status !== expectCode)) {
    console.log(
      `\n$ ${command === process.execPath ? 'raion' : command} ${args.slice(command === process.execPath ? 1 : 0).join(' ')}`,
    );
    console.log(
      output
        .trim()
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n'),
    );
  }
  if (expectCode !== null && result.status !== expectCode) {
    throw new Error(`expected exit code ${expectCode}, got ${result.status}`);
  }
  return { output, stdout: result.stdout ?? '', code: result.status };
}

const raion = (args, options) => run(process.execPath, [cli, ...args], options);
/** Runs the advisor and returns its findings (ignored ones included). */
const advise = (...flags) => {
  const { stdout, output } = raion(
    ['advise', 'observability', '--format', 'json', '--all', ...flags],
    { quiet: true },
  );
  // Warnings about live data that could not be read go to stderr.
  const warnings = output.slice(stdout.length).trim();
  if (warnings) console.log(`    ${warnings}`);
  return JSON.parse(stdout).findings;
};
const compose = (args, options) =>
  run(
    'docker',
    [
      'compose',
      '-p',
      appProject,
      '-f',
      'compose.yaml',
      '-f',
      'observability.override.yaml',
      ...args,
    ],
    options,
  );

try {
  cpSync(join(root, 'examples', 'nodejs-express'), app, {
    recursive: true,
    filter: (src) =>
      !/[\\/](node_modules|\.raion)([\\/]|$)|observability\.override\.yaml$/.test(src),
  });

  // Isolate from any other Raion stack and from the example app if it is running.
  writeFileSync(
    join(ws, 'raion.yaml'),
    readFileSync(join(ws, 'raion.yaml'), 'utf8').replace(
      '  level: 2\n',
      '  level: 3\n  target:\n    type: docker-compose\n    compose:\n      projectName: raion-e2e-node\n      gatewayPort: 17602\n      otlpGrpcPort: 14327\n      otlpHttpPort: 14328\n' +
        '  notifications:\n    defaultReceiver: e2e-hook\n    receivers:\n      - name: e2e-hook\n        type: webhook\n        url: ${secret:E2E_HOOK_URL}\n',
    ),
  );
  // Alert after one minute instead of five, to keep the test short. The dependency on
  // ledger-api is left out: the advisor must discover it from traces.
  const paymentApi = readFileSync(join(ws, 'services', 'payment-api.yaml'), 'utf8');
  const declared = '  dependencies:\n    - service: ledger-api\n';
  if (!paymentApi.includes(declared)) {
    throw new Error('the example no longer declares payment-api -> ledger-api');
  }
  writeFileSync(
    join(ws, 'services', 'payment-api.yaml'),
    `${paymentApi.replace(declared, '')}  alerts:\n    for: 1m\n`,
  );
  writeFileSync(
    join(app, 'compose.yaml'),
    readFileSync(join(app, 'compose.yaml'), 'utf8').replace(
      / {4}ports:\n {6}- 127\.0\.0\.1:3000:3000\n/,
      '',
    ),
  );

  raion(['validate', 'observability']);
  // The advisor notices the critical service without an SLO, from the configuration alone.
  {
    const before = advise('--offline');
    const missing = before.find((f) => f.id === 'critical-service-without-slo/payment-api');
    if (!missing?.autofix) throw new Error('advisor: missing SLO on payment-api not reported');
    console.log(`    ✓ advisor: ${missing.title}`);
  }
  // The receiver URL is a secret: it never appears in generated configuration.
  raion(['secrets', 'set', 'E2E_HOOK_URL', '-w', 'observability', '--value-stdin'], {
    input: `http://${WEBHOOK}:8080/alerts\n`,
  });
  // Create SLOs the way a user would (no YAML editing).
  raion([
    'slo',
    'add',
    'payment-api',
    '-w',
    'observability',
    '--type',
    'availability',
    '--target',
    '99.9',
  ]);
  raion([
    'slo',
    'add',
    'payment-api',
    '-w',
    'observability',
    '--type',
    'latency',
    '--threshold-ms',
    '500',
    '--target',
    '99',
    '--policy',
    'Freeze feature releases until the budget recovers.',
  ]);
  // A threshold the metrics cannot measure is refused, and nothing is written.
  raion(
    [
      'slo',
      'add',
      'payment-api',
      '-w',
      'observability',
      '--name',
      'odd',
      '--type',
      'latency',
      '--threshold-ms',
      '450',
      '--target',
      '99',
    ],
    {
      expectCode: 1,
    },
  );
  // The SLOs export as valid OpenSLO.
  raion(['slo', 'export', 'observability', '--out', 'openslo.yaml']);
  run('docker', [
    'run',
    '--rm',
    '--network',
    'none',
    '--mount',
    `type=bind,src=${app},dst=/w,readonly`,
    OSLO_IMAGE,
    'validate',
    '/w/openslo.yaml',
  ]);

  if (advise('--offline').some((f) => f.rule === 'critical-service-without-slo')) {
    throw new Error('advisor: finding still reported after the SLOs were added');
  }

  raion(['apply', 'observability', '--yes']);
  // A tiny webhook receiver on the stack's outbound network, standing in for Slack or PagerDuty.
  run('docker', ['rm', '-f', WEBHOOK], { expectCode: null, quiet: true });
  run('docker', [
    'run',
    '-d',
    '--name',
    WEBHOOK,
    '--network',
    'raion-e2e-node_edge',
    NODE_IMAGE,
    'node',
    '-e',
    "require('http').createServer((q,s)=>{let b='';q.on('data',d=>b+=d);q.on('end',()=>{console.log('WEBHOOK '+b);s.end('ok')})}).listen(8080)",
  ]);
  if (
    readFileSync(
      join(ws, '.raion', 'runtime', 'alertmanager', 'alertmanager.yml'),
      'utf8',
    ).includes(WEBHOOK)
  ) {
    throw new Error('the secret receiver URL leaked into generated configuration');
  }
  const connect = raion(['connect', 'observability', '--out', 'observability.override.yaml']);
  if (!connect.output.includes('Integration: Node.js (OpenTelemetry)'))
    throw new Error('nodejs integration not chosen');
  if (
    !readFileSync(join(app, 'observability.override.yaml'), 'utf8').includes(
      'raion-e2e-node-ingest',
    )
  ) {
    throw new Error('override does not join the project ingest network');
  }

  compose(['up', '-d', '--build', '--wait']);

  // Telemetry needs a little time: metrics are exported every 15 s.
  for (const service of ['payment-api', 'ledger-api']) {
    const deadline = Date.now() + 240_000;
    let last;
    for (;;) {
      last = raion(['verify', 'observability', '--service', service], {
        expectCode: null,
        quiet: true,
      });
      if (last.code === 0) break;
      if (Date.now() > deadline) {
        console.log(last.output);
        throw new Error(`${service} did not become fully connected`);
      }
      await new Promise((r) => setTimeout(r, 10_000));
    }
    console.log(
      last.output
        .trim()
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n'),
    );
    for (const expected of ['✓ metrics', '✓ logs', '✓ traces', '✓ linking', 'is fully connected']) {
      if (!last.output.includes(expected)) throw new Error(`${service}: expected "${expected}"`);
    }
  }

  // ----- Advisor (live data) ---------------------------------------------------------------
  // payment-api calls ledger-api, but the dependency is not declared: the service graph shows it.
  {
    const id = 'undeclared-dependency/payment-api->ledger-api';
    const deadline = Date.now() + 240_000;
    let findings;
    for (;;) {
      findings = advise();
      if (findings.some((f) => f.id === id)) break;
      if (Date.now() > deadline) {
        console.log(JSON.stringify(findings, null, 2));
        throw new Error('advisor: the undeclared dependency was not found');
      }
      await new Promise((r) => setTimeout(r, 15_000));
    }
    console.log(`    ✓ advisor: ${findings.find((f) => f.id === id).title}`);
    // No false alarms on a healthy, fully instrumented example.
    for (const rule of ['low-log-trace-correlation', 'collector-dropping-telemetry']) {
      const unexpected = findings.filter((f) => f.rule === rule);
      if (unexpected.length > 0) {
        throw new Error(`advisor: unexpected ${unexpected.map((f) => f.title).join('; ')}`);
      }
    }
    // The fix is a reviewable workspace change that goes through the normal plan and apply.
    raion(['advise', 'observability', '--apply', id, '--yes']);
    raion(['validate', 'observability']);
    raion(['plan', 'observability', '--detailed-exitcode'], { expectCode: 3 });
    raion(['apply', 'observability', '--yes']);
    if (advise().some((f) => f.id === id)) {
      throw new Error('advisor: dependency still reported as undeclared after the fix');
    }
    console.log('    ✓ advisor: the fix was applied, planned and deployed');
  }

  // Every generated dashboard must load in Grafana, and every panel that should show data must.
  {
    const deadline = Date.now() + 240_000;
    let last;
    for (;;) {
      last = raion(['verify', 'observability', '--dashboards'], { expectCode: null, quiet: true });
      if (last.code === 0) break;
      if (Date.now() > deadline) {
        console.log(last.output);
        throw new Error('generated dashboards are missing data');
      }
      await new Promise((r) => setTimeout(r, 15_000));
    }
    console.log(
      last.output
        .trim()
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n'),
    );
  }

  // ----- SLOs ------------------------------------------------------------------------------
  {
    const deadline = Date.now() + 240_000;
    for (;;) {
      const { output } = raion(['slo', 'list', 'observability', '--format', 'json'], {
        expectCode: null,
        quiet: true,
      });
      let status = [];
      try {
        status = JSON.parse(output.slice(output.indexOf('[')));
      } catch {
        status = [];
      }
      const measured = status.filter(
        (x) => x.service === 'payment-api' && x.budgetRemaining !== null && x.sli !== null,
      );
      if (measured.length === 2) {
        for (const x of measured)
          console.log(
            `    ✓ ${x.service} · ${x.slo}: SLI ${(x.sli * 100).toFixed(3)}%, ${x.message}`,
          );
        break;
      }
      if (Date.now() > deadline) {
        console.log(output);
        throw new Error('SLOs were not measured');
      }
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }

  // ----- Alerting ------------------------------------------------------------------------
  console.log('\n$ alerting');
  await waitForAlerts(
    'the Watchdog reaches Alertmanager: the alerting pipeline works',
    (state, code) => code === 0 && state.health.ok,
  );

  // Make 60% of payment requests fail.
  run('docker', [
    'compose',
    '-p',
    appProject,
    'exec',
    '-T',
    'payment-api',
    'node',
    '-e',
    "fetch('http://localhost:3000/admin/faults',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({failureRate:0.6})}).then(r=>r.text()).then(console.log)",
  ]);
  await waitForAlerts('ServiceHighErrorRate fires for payment-api', (state) =>
    firing(state, 'ServiceHighErrorRate', {
      service_name: 'payment-api',
      team: 'payments',
      severity: 'critical',
    }),
  );
  await waitForAlerts(
    'SLOErrorBudgetBurnFast pages for the payment-api availability SLO',
    (state) =>
      firing(state, 'SLOErrorBudgetBurnFast', {
        service_name: 'payment-api',
        slo: 'availability',
        severity: 'critical',
      }),
  );
  {
    const deadline = Date.now() + 180_000;
    for (;;) {
      const logs = run('docker', ['logs', WEBHOOK], { expectCode: null, quiet: true }).output;
      if (
        logs.includes('"alertname":"ServiceHighErrorRate"') &&
        logs.includes('"alertname":"SLOErrorBudgetBurnFast"')
      ) {
        console.log('    ✓ both notifications were delivered to the webhook receiver');
        break;
      }
      if (Date.now() > deadline) throw new Error('no notification reached the webhook receiver');
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  run(
    'docker',
    [
      'compose',
      '-p',
      appProject,
      'exec',
      '-T',
      'payment-api',
      'node',
      '-e',
      "fetch('http://localhost:3000/admin/faults',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({failureRate:0})}).then(r=>r.text()).then(console.log)",
    ],
    { quiet: true },
  );

  // Break the stack itself: the collector stops.
  run('docker', ['stop', 'raion-e2e-node-otel-collector-1'], { quiet: true });
  await waitForAlerts('RaionComponentDown fires when the collector stops', (state) =>
    firing(state, 'RaionComponentDown', { job: 'otel-collector' }),
  );
  run('docker', ['start', 'raion-e2e-node-otel-collector-1'], { quiet: true });

  console.log('\n✓ Node.js end-to-end test passed');
} finally {
  if (!keep) {
    run('docker', ['rm', '-f', WEBHOOK], { expectCode: null, quiet: true });
    compose(['down', '--volumes', '--remove-orphans'], { expectCode: null, quiet: true });
    raion(['destroy', 'observability', '--yes', '--delete-data'], {
      expectCode: null,
      quiet: true,
    });
    rmSync(tmp, { recursive: true, force: true });
  }
}
