# Deploying the observability stack

This guide explains what `raion apply` runs, how to check it is working, and what to do when it is not.

## What gets deployed

Raion runs these open-source components as one Docker Compose project, configured from your workspace:

| Component      | What it does                                                                       | Underlying project                                                       |
| -------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| otel-collector | Receives metrics, logs and traces from your applications and sends them to storage | [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/)      |
| prometheus     | Stores metrics and evaluates alert and recording rules                             | [Prometheus](https://prometheus.io)                                      |
| loki           | Stores logs                                                                        | [Grafana Loki](https://grafana.com/oss/loki/)                            |
| tempo          | Stores traces (only when a service uses tracing, level 2+)                         | [Grafana Tempo](https://grafana.com/oss/tempo/)                          |
| grafana        | Dashboards and exploration                                                         | [Grafana](https://grafana.com/oss/grafana/)                              |
| alertmanager   | Groups and routes alerts ([Alerting](alerting.md))                                 | [Alertmanager](https://prometheus.io/docs/alerting/latest/alertmanager/) |
| node-exporter  | Host CPU, memory, disk and filesystem metrics                                      | [node_exporter](https://github.com/prometheus/node_exporter)             |
| cadvisor       | Per-container metrics (only with `infrastructure.containers: true`)                | [cAdvisor](https://github.com/google/cadvisor)                           |
| gateway        | The only way in: only Raion holds its key                                          | [nginx](https://nginx.org)                                               |

Every image is pinned by digest, and every container drops all Linux capabilities and runs with a read-only filesystem. Nothing except the gateway and the telemetry receiver is reachable from your machine, and both listen on `127.0.0.1` only.

## The workflow

```sh
raion plan       # what would change, and is the generated configuration valid?
raion apply      # show the plan, ask, then deploy
raion status     # is every component running and ready? is the stack monitoring itself?
raion verify     # send test telemetry and confirm it is stored
```

### `raion plan`

`raion plan` shows:

- each component that will start, restart, be recreated or stop, and why
- each generated file that changes
- anything that needs your approval

It also runs each component's own validator on the generated files, for example `promtool check config` and `otelcol-contrib validate`. Nothing is changed.

Use `raion plan --detailed-exitcode` in CI. It exits with code 3 when the deployed stack differs from the workspace.

### `raion apply`

`raion apply` runs these steps in order:

1. Checks prerequisites: Docker, Docker Compose, and whether the ports are free.
2. Validates the generated configuration with each component's own tool. If anything is rejected, it stops with **nothing changed**.
3. Saves the configuration as a numbered **release** in `.raion/releases/`.
4. Starts or updates containers, and restarts only the components whose configuration changed.
5. Waits until every component reports ready, Prometheus has successfully scraped every component, and alerting works (the Watchdog alert reaches Alertmanager).
6. If the new release does not become ready, it **automatically restores the previous release** and tells you what failed.

Running `apply` again with no changes does nothing, so it is safe to re-run.

Some changes need explicit approval:

| Flag                   | Needed when                                                        |
| ---------------------- | ------------------------------------------------------------------ |
| `--allow-privileged`   | A component needs elevated privileges (cAdvisor runs privileged)   |
| `--allow-data-changes` | Retention gets shorter, or a component that stores data is removed |

In the web UI, these changes can only be applied by an admin.

### `raion status`

`raion status` lists every component with its state and readiness. It also shows **monitoring of the stack itself**: whether Prometheus can scrape each component. A target that is down means part of your monitoring is broken, even if your applications are fine.

### `raion verify`

Three checks:

- `raion verify`: the pipeline itself (below)
- `raion verify --service <name>`: what one service sends ([Connecting applications](connecting-applications.md))
- `raion verify --dashboards`: every generated dashboard loads and shows data ([Dashboards](dashboards.md))

`raion verify` sends one metric, one log line and one trace span to the collector, exactly like an instrumented application would. It then checks that each one arrived in Prometheus, Loki and Tempo. It prints the queries it used, so you can repeat them in Grafana.

### Rolling back and stopping

```sh
raion rollback                # redeploy the previous release
raion rollback --to 0003-ab12cd34
raion destroy                 # stop everything, keep stored data
raion destroy --delete-data   # stop everything and delete all stored data
```

### Drift

If someone edits a generated file or stops, removes or replaces a container behind Raion's back, the stack no longer matches the release:

```sh
raion drift            # lists each difference; exit code 3 when there is drift
raion drift --repair   # restore the deployed release (files and containers)
```

`raion status` and the Observability stack page show drift too. See [GitOps](gitops.md).

## Opening Grafana

Start the Raion server (`raion server`), sign in, and open **Grafana** from the top bar, or go to `http://127.0.0.1:7600/grafana/`. You are signed in to Grafana automatically, with a role that matches your Raion role.

Grafana is not reachable directly: requests go through Raion, which checks your Raion session first.

## Sending telemetry

| From                                    | Send OTLP to                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| A program on this machine               | gRPC `127.0.0.1:4317`, HTTP `http://127.0.0.1:4318`                                                           |
| A container in your own Compose project | Join the `raion-ingest` network, then use `otel-collector:4317` (gRPC) or `http://otel-collector:4318` (HTTP) |

```yaml
# In your application's compose file
services:
  my-api:
    networks: [default, raion-ingest]
    environment:
      OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318
      OTEL_SERVICE_NAME: my-api
networks:
  raion-ingest:
    external: true
```

Phase 3 generates this for Node.js services automatically.

## Seeing and reusing the generated configuration

- `raion render --out ./generated` writes every generated file to a folder.
- In the web UI, the **Observability stack** page shows each file.

These are standard files. You can run the stack without Raion with `docker compose -f compose.yaml up -d`; it needs the secret files in `../secrets`, which `raion apply` creates.

## Where things live

```
observability/
  raion.yaml, services/, slos/      your configuration (commit this)
  .raion/                           local state (never commit)
    secrets/                        generated credentials
    releases/                       every configuration ever applied
    runtime/                        the configuration currently deployed
    raion.db                        users, sessions, audit log
```

Set `RAION_STATE_DIR` to an absolute path to keep this state elsewhere, for example on a CI runner whose checkout is cleaned on every run. Use one directory per workspace.

## Troubleshooting

| Symptom                                                      | What to do                                                                                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Docker is not available`                                    | Start Docker Desktop, or check that your user can run `docker version`.                                                                           |
| `127.0.0.1:4317 is already used by another program`          | Another collector or agent is running. Stop it, or change the port in `raion.yaml` (`spec.target.compose.otlpGrpcPort`).                          |
| `generated configuration was rejected by …`                  | Nothing was changed. The message contains the tool's own output. Please report it as a bug, since generated configuration should always be valid. |
| `components did not become ready … Rolled back to release …` | Your previous configuration is running again. Run `raion status`; the apply output includes the last log lines of the failing component.          |
| `raion status` shows a scrape target `down`                  | Part of the monitoring is broken. The error column says why, usually a component that is restarting.                                              |
| `raion verify` reports a signal missing                      | Run `raion status`; the component that stores that signal is usually not ready.                                                                   |
| `apply already in progress by …`                             | Someone else is deploying. Wait, or if their process crashed, the lock is taken over automatically after 30 minutes.                              |

## Known limitations

- **Host network metrics.** Network metrics describe node-exporter's own container interface, not the host's network. CPU, memory, disk and filesystem metrics are the host's.
- **Docker Desktop (Windows/macOS).** "Host" metrics describe Docker's Linux VM, not your laptop.
- **Grafana Live** (instant streaming updates) is off. Dashboards refresh normally.
- **Container logs** (stdout of containers) are not collected yet. Applications send logs over OTLP (Phase 3).
