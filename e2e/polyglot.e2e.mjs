// End-to-end test of the Python, Go, PostgreSQL, Redis and Nginx integrations with the
// polyglot example, driven through the real CLI and Docker Compose, as a user would:
//
//   raion secrets set → raion apply → raion connect --out … → docker compose up
//   → raion verify --service (each service) → raion verify --dashboards
//   → the stopped database raises ServiceUnreachable
//
//   node e2e/polyglot.e2e.mjs [--keep]
//
// Uses its own project names and ports, so it can run next to a real Raion stack.
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = join(import.meta.dirname, '..');
const cli = join(root, 'apps', 'cli', 'dist', 'index.js');
const tmp = mkdtempSync(join(tmpdir(), 'raion-e2e-poly-'));
const app = join(tmp, 'app');
const ws = join(app, 'observability');
const project = 'raion-e2e-poly';
const appProject = 'raion-e2e-polyapp';
const keep = process.argv.includes('--keep');

// Fresh passwords for every run: nothing secret is stored in the example.
const env = {
  ...process.env,
  CATALOG_DB_PASSWORD: randomBytes(12).toString('hex'),
  CATALOG_DB_MONITOR_PASSWORD: randomBytes(12).toString('hex'),
};

function run(command, args, { cwd = app, expectCode = 0, quiet = false, input } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
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
const indent = (text) =>
  text
    .trim()
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');

/** Runs a PromQL query inside the stack (not through a published port). */
function promql(query) {
  const { stdout } = run(
    'docker',
    [
      'exec',
      `${project}-prometheus-1`,
      'wget',
      '-qO-',
      `http://localhost:9090/api/v1/query?query=${encodeURIComponent(query)}`,
    ],
    { quiet: true },
  );
  return JSON.parse(stdout).data.result;
}

/** Prometheus' view of the ServiceUnreachable rule for catalog-db, for a failed wait. */
function diagnoseUnreachable() {
  try {
    const { stdout } = run(
      'docker',
      [
        'exec',
        `${project}-prometheus-1`,
        'wget',
        '-qO-',
        'http://localhost:9090/api/v1/rules?type=alert',
      ],
      { quiet: true },
    );
    const rule = JSON.parse(stdout)
      .data.groups.flatMap((g) => g.rules)
      .find((r) => r.name === 'ServiceUnreachable' && r.query.includes('catalog-db'));
    const value = promql(
      'sum(increase(otelcol_scraper_scraped_metric_points{receiver="postgresql/catalog-db"}[2m]))',
    );
    return `rule: state=${rule?.state} health=${rule?.health} lastError=${rule?.lastError ?? ''} lastEvaluation=${rule?.lastEvaluation}; reads in 2m: ${JSON.stringify(value.map((v) => v.value[1]))}`;
  } catch (error) {
    return `could not read the rule state: ${error.message}`;
  }
}

async function until(what, check, timeoutMs = 300_000, intervalMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result.ok) {
      if (result.output) console.log(indent(result.output));
      console.log(`    ✓ ${what}`);
      return;
    }
    if (Date.now() > deadline) {
      if (result.output) console.log(result.output);
      throw new Error(`timed out waiting for: ${what}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

try {
  cpSync(join(root, 'examples', 'polyglot'), app, {
    recursive: true,
    filter: (src) => !/[\\/]\.raion([\\/]|$)|observability\.override\.yaml$/.test(src),
  });
  // Isolate from any other Raion stack, and do not publish the example's port.
  writeFileSync(
    join(ws, 'raion.yaml'),
    readFileSync(join(ws, 'raion.yaml'), 'utf8').replace(
      '  level: 2\n',
      `  level: 2\n  infrastructure:\n    containers: true\n  target:\n    type: docker-compose\n    compose:\n      projectName: ${project}\n      gatewayPort: 17603\n      otlpGrpcPort: 14337\n      otlpHttpPort: 14338\n      fluentForwardPort: 24237\n`,
    ),
  );
  writeFileSync(
    join(app, 'compose.yaml'),
    readFileSync(join(app, 'compose.yaml'), 'utf8').replace(
      "    ports: ['127.0.0.1:8088:8080']\n",
      '',
    ),
  );

  raion(['validate', 'observability']);
  // Monitoring credentials go into the secret store, never into the workspace.
  raion(['secrets', 'set', 'CATALOG_DB_MONITOR_PASSWORD', '-w', 'observability', '--value-stdin'], {
    input: `${env.CATALOG_DB_MONITOR_PASSWORD}\n`,
  });
  // Container metrics (cAdvisor) need a privileged container: an explicit approval.
  raion(['apply', 'observability', '--yes', '--allow-privileged']);
  const collectorConfig = readFileSync(
    join(ws, '.raion', 'runtime', 'otel-collector', 'config.yaml'),
    'utf8',
  );
  if (collectorConfig.includes(env.CATALOG_DB_MONITOR_PASSWORD)) {
    throw new Error('the database password leaked into generated configuration');
  }

  raion(['connect', 'observability', '--out', 'observability.override.yaml']);
  compose(['up', '-d', '--build', '--wait']);

  // ----- Every service is connected ----------------------------------------------------------
  const apps = ['catalog-api', 'pricing-api'];
  const pulled = ['edge', 'catalog-db', 'pricing-cache'];
  for (const service of [...apps, ...pulled]) {
    await until(
      `${service} is fully connected`,
      () => {
        const r = raion(['verify', 'observability', '--service', service], {
          expectCode: null,
          quiet: true,
        });
        const expected = apps.includes(service)
          ? ['✓ metrics', '✓ logs', '✓ traces', '✓ linking']
          : ['edge', 'catalog-db'].includes(service)
            ? ['✓ metrics', '✓ logs'] // container logs
            : ['✓ metrics'];
        return {
          ok: r.code === 0 && expected.every((e) => r.output.includes(e)),
          output: r.output,
        };
      },
      300_000,
    );
  }

  // ----- What the integration manifests promise is what the applications emit -------------------
  {
    const manifestBuckets = (name) => {
      const text = readFileSync(
        join(root, 'packages', 'integrations', name, 'integration.yaml'),
        'utf8',
      );
      const list = /buckets: \[([^\]]+)\]/
        .exec(text)[1]
        .split(',')
        .map((v) => Number(v));
      return [...list, Infinity];
    };
    for (const [service, integration, route] of [
      ['catalog-api', 'python', '/products/<int:product_id>'],
      ['pricing-api', 'go', '/prices/{id}'],
    ]) {
      const buckets = promql(
        `count by (le) (http_server_request_duration_seconds_bucket{service_name="${service}"})`,
      )
        .map((s) => Number(s.metric.le === '+Inf' ? Infinity : s.metric.le))
        .sort((a, b) => a - b);
      const expected = manifestBuckets(integration);
      if (JSON.stringify(buckets) !== JSON.stringify(expected)) {
        throw new Error(
          `${service}: histogram buckets ${JSON.stringify(buckets)} differ from the ${integration} manifest ${JSON.stringify(expected)}`,
        );
      }
      const routes = promql(
        `count by (http_route) (http_server_request_duration_seconds_count{service_name="${service}"})`,
      ).map((s) => s.metric.http_route);
      if (!routes.includes(route)) {
        throw new Error(`${service}: expected route ${route}, got ${JSON.stringify(routes)}`);
      }
      console.log(
        `    ✓ ${service}: buckets match the ${integration} manifest; routes ${routes.join(', ')}`,
      );
    }
    // One series per database, labelled with its name.
    const databases = promql('sum by (postgresql_database_name) (postgresql_backends)').map(
      (s) => s.metric.postgresql_database_name,
    );
    if (!databases.includes('catalog')) {
      throw new Error(`expected per-database series, got ${JSON.stringify(databases)}`);
    }
    console.log(`    ✓ catalog-db: per-database metrics (${databases.join(', ')})`);
  }

  // ----- Dashboards ----------------------------------------------------------------------------
  await until(
    'every generated dashboard shows data',
    () => {
      const r = raion(['verify', 'observability', '--dashboards'], {
        expectCode: null,
        quiet: true,
      });
      return { ok: r.code === 0, output: r.output };
    },
    300_000,
    15_000,
  );

  // ----- The advisor sees nothing missing in coverage --------------------------------------------
  {
    const findings = JSON.parse(
      raion(['advise', 'observability', '--format', 'json'], { quiet: true }).stdout,
    ).findings;
    const unexpected = findings.filter((f) =>
      [
        'database-not-monitored',
        'service-without-golden-signals',
        'low-log-trace-correlation',
        'collector-dropping-telemetry',
        'undeclared-dependency',
      ].includes(f.rule),
    );
    if (unexpected.length > 0) {
      throw new Error(`advisor: unexpected ${unexpected.map((f) => f.id).join(', ')}`);
    }
    console.log(`    ✓ advisor: no coverage gaps (${findings.length} other findings)`);
  }

  // ----- A database that cannot be read raises an alert -----------------------------------------
  run('docker', ['compose', '-p', appProject, 'stop', 'catalog-db'], { quiet: true });
  await until(
    'ServiceUnreachable fires for the stopped catalog-db',
    () => {
      const r = raion(['alerts', 'observability', '--format', 'json'], {
        expectCode: null,
        quiet: true,
      });
      let state;
      try {
        state = JSON.parse(r.output.slice(r.output.indexOf('{')));
      } catch {
        state = undefined;
      }
      const ok =
        state?.alerts.some(
          (a) =>
            a.labels.alertname === 'ServiceUnreachable' &&
            a.labels.service_name === 'catalog-db' &&
            a.labels.severity === 'critical' &&
            a.status.state === 'active',
        ) ?? false;
      // Shown only on timeout: whether the rule fired, and what Alertmanager listed.
      return {
        ok,
        output: ok
          ? ''
          : `${r.output}
${diagnoseUnreachable()}`,
      };
    },
    // Fires about 6 minutes after the stop (2-minute window, held 3 minutes); CI is slower.
    900_000,
    15_000,
  );
  const verify = raion(['verify', 'observability', '--service', 'catalog-db'], {
    expectCode: null,
    quiet: true,
  });
  if (!verify.output.includes('the collector fails to read catalog-db')) {
    console.log(verify.output);
    throw new Error('verify --service does not explain why catalog-db cannot be read');
  }
  console.log('    ✓ raion verify explains that the collector fails to read catalog-db');

  console.log('\n✓ Polyglot end-to-end test passed');
} finally {
  if (!keep) {
    compose(['down', '--volumes', '--remove-orphans'], { expectCode: null, quiet: true });
    raion(['destroy', 'observability', '--yes', '--delete-data'], {
      expectCode: null,
      quiet: true,
    });
    rmSync(tmp, { recursive: true, force: true });
  }
}
