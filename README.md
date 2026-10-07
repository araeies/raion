# Raion

**Observability as a platform, built on the open-source tools you already trust.**

Raion lets a team that has never set up observability get production-grade monitoring without first becoming experts in it. You describe your services. Raion generates and runs the configuration for OpenTelemetry, Prometheus, Loki, Tempo, Grafana and Alertmanager. That includes dashboards, alerts, SLOs, error budgets and burn-rate alerts.

Raion does not replace those tools. It configures them. Everything it generates is plain, standard configuration that you can read, export and keep using without Raion.

> **Status: early development (Phase 9 of 10). All 17 items of the MVP Definition of Done are met ([evidence](docs/design/mvp-definition-of-done.md)).** Raion validates observability-as-code workspaces, deploys and operates the open-source observability stack with Docker Compose, connects Node.js, Python and Go applications (metrics, traces, and logs linked to traces) and monitors PostgreSQL, Redis, Nginx and Docker containers, and runs a multi-user control plane with single sign-on to Grafana. Generated dashboards are checked against live data, generated alerts reach an inbox and Slack, email or webhooks, SLOs come with error budgets, burn-rate alerts and OpenSLO export, and an advisor points out gaps (and fixes the safe ones). See [the roadmap](#roadmap).

## What works today

- **Observability as code.** You describe services, owners, dependencies and SLOs in YAML (`raion.yaml`, `services/`, `slos/`), versioned in Git.
- **`raion validate`** catches typos, invalid values, unknown references ("did you mean `ledger-api`?") and inline secrets. Each finding has a file and line number, and the command's exit code makes it suitable for CI.
- **`raion init`** is a short guided set of questions that creates a valid workspace.
- **`raion server`** is the multi-user control plane:
  - per-user accounts with viewer, editor and admin roles
  - an audit log
  - secure defaults: TLS is required off-localhost, plus CSRF and DNS-rebinding protection and a strict CSP
  - a web UI listing services, their SLOs, dependencies and configuration
- **A JSON Schema** for editor autocompletion (`raion schema`).
- **`raion plan` / `apply` / `status` / `verify` / `rollback` / `destroy`** deploy and operate the stack:
  - OpenTelemetry Collector, Prometheus, Loki, Tempo, Grafana, Alertmanager and node_exporter
  - images pinned by digest and hardened containers
  - every generated file validated by the component's own tool before deploying
  - automatic rollback
  - an end-to-end pipeline check
- **`raion connect` / `raion verify --service`** connect services:
  - Node.js and Python without code changes, Go with one setup file
  - PostgreSQL, Redis and Nginx, read by the collector with read-only credentials from the secret store
  - container metrics and container logs for any Compose service, without giving anything the Docker socket
  - your own integrations as workspace packages, pinned by checksum
  - a generated Docker Compose override
  - checks that metrics, logs and traces arrive and that logs are linked to traces
  - live request rate, error rate and latency on each service page
  - complete examples: [Node.js](examples/nodejs-express) and [Python, Go, PostgreSQL, Redis and Nginx](examples/polyglot)
- **Generated dashboards**:
  - an overview, one dashboard per service built from what the service provides, dependencies (service map), logs, traces, infrastructure, and the health of the monitoring itself
  - `raion verify --dashboards` proves every panel shows data
- **Alerting**:
  - generated alerts for services, the host and the observability stack itself
  - an always-firing Watchdog that proves alerting works
  - the Raion alert inbox with silencing
  - Slack, email and webhook notifications with secrets kept out of configuration
  - alert rules unit-tested with `promtool`
- **SLOs without PromQL**:
  - availability, latency, throughput or custom SLOs, created in the UI or with `raion slo add`
  - error budgets, multi-window burn-rate alerts and SLO dashboards
  - OpenSLO export and import
- **The Observability Advisor** (`raion advise`, the Advisor page):
  - finds critical services without SLOs, alerts without runbooks, undeclared dependencies seen in traces, logs without trace IDs, dropped telemetry and high-cardinality metrics
  - explains why each matters and what to do
  - applies the safe fixes as reviewable, comment-preserving changes to your workspace files
- **GitOps**:
  - `raion diff` shows reviewers what a pull request changes
  - a GitHub Action validates, compares and runs the advisor on every pull request
  - `raion drift` finds and repairs changes made behind Raion's back
- **Grafana single sign-on**: sign in to Raion and open Grafana with a matching role. No component of the stack is reachable without going through Raion.

## Quick start

Requires Node.js 24+ and pnpm (via `corepack enable`).

```sh
git clone <this repository> raion && cd raion
pnpm install
pnpm run build

# Create a workspace (asks a few questions)
pnpm raion init observability

# Check it
pnpm raion validate observability

# Deploy the observability stack (needs Docker) and check it end to end
pnpm raion apply observability
pnpm raion verify observability

# Start the control plane and open the printed setup link to create the first admin
pnpm raion server --workspace observability
```

Then open <http://127.0.0.1:7600>.

### Using raion from any folder

`pnpm raion` always runs in the repository root, so relative paths are resolved from there. The examples' instructions use a plain `raion` command instead, run inside the example's folder. Define it once per terminal, with the path to your clone:

```sh
# bash / zsh
raion() { node /path/to/raion/apps/cli/dist/index.js "$@"; }
```

```powershell
# PowerShell
function raion { node C:\path\to\raion\apps\cli\dist\index.js @args }
```

## How it fits together

```
your services (YAML in Git) ──► raion validate / plan / apply ──► generated, standard config
                                                                   ├─ OpenTelemetry Collector
                                                                   ├─ Prometheus + rules + alerts
                                                                   ├─ Loki, Tempo
                                                                   ├─ Grafana dashboards
                                                                   └─ Alertmanager routing
```

The full design is in [docs/design/phase-0-architecture.md](docs/design/phase-0-architecture.md).

## Documentation

- [Getting started](docs/guides/getting-started.md)
- [Deploying the observability stack](docs/guides/deploying.md)
- [Dashboards](docs/guides/dashboards.md)
- [Alerting](docs/guides/alerting.md)
- [SLOs](docs/guides/slos.md)
- [Observability Advisor](docs/guides/advisor.md)
- [GitOps](docs/guides/gitops.md)
- [Connecting applications](docs/guides/connecting-applications.md) · [Integrations](docs/guides/integrations.md) · [Writing integrations](docs/guides/writing-integrations.md)
- [Configuration reference](docs/guides/configuration.md)
- [Validation error codes](docs/guides/validation-codes.md)
- [Users, roles and security](docs/guides/security.md)
- [Architecture](docs/design/phase-0-architecture.md)
- [Contributing](CONTRIBUTING.md)

## Roadmap

| Phase | Scope                                                                 | Status  |
| ----- | --------------------------------------------------------------------- | ------- |
| 0     | Architecture and design                                               | ✅ Done |
| 1     | Foundation: schemas, validation, CLI, multi-user server, UI shell, CI | ✅ Done |
| 2     | Deploy the OSS stack with Docker Compose (`plan`, `apply`, rollback)  | ✅ Done |
| 3     | Node.js integration: metrics, logs, traces, correlation               | ✅ Done |
| 4     | Generated dashboards                                                  | ✅ Done |
| 5     | Alerting and observability-health alerts                              | ✅ Done |
| 6     | SLIs, SLOs, error budgets, burn-rate alerts, OpenSLO                  | ✅ Done |
| 7     | Observability advisor                                                 | ✅ Done |
| 8     | More integrations (Python, Go, PostgreSQL, Redis, Nginx, Docker)      | ✅ Done |
| 9     | GitOps hardening                                                      | ✅ Done |
| 10    | Kubernetes, Mimir, cloud, profiling, synthetics                       | Next    |

## License

[Apache-2.0](LICENSE)
