# Troubleshooting

Find your symptom below. Most commands explain their own errors, with the file and line or the component involved; start there.

## Installing and starting

| Symptom                                             | What to do                                                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm: command not found`                           | Run `corepack enable` (it comes with Node.js). On Windows, run the terminal as administrator once if it reports a permission error.        |
| An error about the Node.js version                  | Raion needs Node.js 24 or newer: `node --version`.                                                                                         |
| `raion: command not found`                          | Define the `raion` command in this terminal ([Installing](02-installing.md#the-raion-command)), or use `pnpm raion` from the Raion folder. |
| `pnpm raion …` cannot find your workspace           | `pnpm raion` runs from the Raion folder; pass an absolute path, or use the `raion` command from your workspace's folder.                   |
| `Docker is not available`                           | Start Docker Desktop, or check that your user can run `docker version`.                                                                    |
| `127.0.0.1:4317 is already used by another program` | Another collector or agent uses the port. Stop it, or change the port in `raion.yaml` (`spec.target.compose.otlpGrpcPort`).                |

## The web UI

| Symptom                                                 | What to do                                                                                                                                                                                                                                                |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The browser cannot connect to `127.0.0.1:7600`          | The server is not running. Start it: `raion server --workspace observability`. It must keep running while you use the UI.                                                                                                                                 |
| The setup link says the token is invalid or expired     | The link works once, for 30 minutes. Restart the server to get a new one (only while no user exists).                                                                                                                                                     |
| You forgot the admin password                           | On the machine with the workspace, create a new admin: `raion users add rescue-admin --role admin -w observability`. Sign in with it, then fix the old account (for example, reset its password through the [API](reference/api.md#changing-a-password)). |
| Sign-in fails although the password is right            | After 10 failed attempts an account is locked for 15 minutes. Wait, or ask an admin. A disabled account cannot sign in.                                                                                                                                   |
| `requests for host "…" are not accepted by this server` | Open Raion at `http://127.0.0.1:7600` or `http://localhost:7600`. To serve it under another name, see [Serving Raion to your team](15-users-and-security.md#serving-raion-to-your-team).                                                                  |
| The server refuses to start on a network address        | Raion serves other machines only over HTTPS: use `--public-url https://…` with `--tls-cert`/`--tls-key`, or a reverse proxy with `--trust-proxy`.                                                                                                         |
| A page says the workspace has configuration errors      | Run `raion validate`; it shows each error with its file and line.                                                                                                                                                                                         |
| A button is missing                                     | It needs a higher role: editors change things, admins manage users and secrets and approve sensitive changes ([roles](15-users-and-security.md#roles)).                                                                                                   |

## Deploying

| Symptom                                                          | What to do                                                                                                                                     |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `generated configuration was rejected by …`                      | Nothing was changed. The message contains the component's own output. This should not happen: please [report it](../CONTRIBUTING.md).          |
| `components did not become ready … Rolled back to release …`     | Your previous configuration is running again. The output includes the last log lines of the failing component; `raion status` shows the state. |
| `apply already in progress by …`                                 | Someone else is deploying. Wait; if their process crashed, the lock is released automatically after 30 minutes.                                |
| `raion apply` says a secret is missing                           | Set it: `raion secrets set NAME`, or on **Observability stack → Secrets**. For `${env:NAME}`, set the environment variable.                    |
| The plan asks for `--allow-privileged` or `--allow-data-changes` | The change needs elevated privileges or deletes data. Review it, then approve with the flag (an admin in the web UI).                          |

## Services and telemetry

| Symptom                                                             | What to do                                                                                                                                                                                       |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `network raion-ingest declared as external, but could not be found` | The observability stack is not running. Run `raion apply` first.                                                                                                                                 |
| `raion verify --service` finds nothing                              | Has the service handled requests? Is its container on `raion-ingest` (`docker inspect <container>`)? Does `OTEL_SERVICE_NAME` match the Raion service name?                                      |
| The collector cannot read a database                                | See the integration's troubleshooting: [PostgreSQL](integrations/postgresql.md#troubleshooting), [Redis](integrations/redis.md#troubleshooting), [Nginx](integrations/nginx.md#troubleshooting). |
| Logs are not linked to traces                                       | The service must be at level 2 or above, and log through an instrumented logging library; see its [integration](integrations/README.md).                                                         |
| Panels show "No data" right after connecting                        | Rates need a few minutes of data. Check telemetry arrives with `raion verify --service <name>`.                                                                                                  |

Integration-specific problems are on each [integration's page](integrations/README.md).

## Alerts and SLOs

| Symptom                                | What to do                                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Alerting is broken**                 | `raion status` shows which component is down; usually Prometheus or Alertmanager is restarting.                                      |
| An alert fires but nobody was notified | Is a receiver configured? Is the alert silenced? Team routes need level 3. See [Alerts](09-alerts.md#where-alerts-go).               |
| `RaionNotificationsFailing` fires      | Check the receiver in `raion.yaml` and its secret (`raion secrets list`). Slack webhooks stop working when the Slack app is removed. |
| Too many alerts for a noisy service    | Raise its `alerts.errorRatePercent` or `alerts.latencyP95Ms`, or increase `alerts.for`.                                              |
| An SLO is "not evaluated"              | SLOs are evaluated from level 3: set `level: 3` or `features: { slos: true }`, then apply. See [SLOs](10-slos.md#troubleshooting).   |
| An SLO shows "no data yet"             | The service has not handled requests since the SLO was deployed.                                                                     |

## The observability stack

See [Is Raion itself healthy?](16-raion-health.md#when-something-is-wrong).

## Still stuck?

Collect the output of `raion status`, `raion validate` and the failing command, and [open an issue](../CONTRIBUTING.md).
