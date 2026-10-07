# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Phase 9: GitOps

#### Added

- **`raion diff <base> <head>`**: what a pull request changes, without deploying. It lists components that restart, flags privileged or data-affecting changes, shows notes and gives the diff of every generated file, as text, JSON or a Markdown pull-request comment (`--advise` adds advisor findings).
- **The Raion check action** (`actions/check`):
  - validates (optionally with each component's own validator)
  - compares with the base branch
  - runs the advisor with `fail-on`
  - writes the job summary and one updated pull-request comment
  - fails when `.raion/` (secrets) is committed
  - fork-safe: no `pull_request_target`, inputs never interpolated into scripts
- **Drift detection**: `raion drift` (exit code 3) finds generated files edited, removed or added, and containers missing, stopped, added or running another image. `--repair` restores the deployed release. Shown in `raion status` and on the Observability stack page, with a **Restore** button for editors (`POST /api/v1/runtime/repair`, audited).
- **`RAION_STATE_DIR`**: keep releases, secrets and the user database outside the workspace, for CI runners whose checkout is cleaned.
- **[examples/gitops](examples/gitops)**: a repository with CODEOWNERS and workflows for pull requests, approved deployment and hourly drift checks. Raion's CI runs the action on it for every change.
- **Tests**: drift comparison, workspace comparison and the comment size limit, the state directory, the repair API, and drift in the runtime end-to-end test (edit a file and stop a container, detect both, repair).
- **Docs**: [GitOps](docs/guides/gitops.md), [Phase 9 decisions](docs/design/phase-9-decisions.md).

#### Changed

- The polyglot end-to-end test waits up to 15 minutes (was 10) for `ServiceUnreachable`, which normally fires about 6 minutes after the database stops. On a timeout, it prints the rule's state and the collector's read counter. One run timed out on this machine for an unexplained reason. The next run passed, with the alert firing 6½ minutes after the stop; the next failure will show where the delay is.

#### Deferred (intentionally not in Phase 9)

| Item                               | Phase | Why                                                                          |
| ---------------------------------- | ----- | ---------------------------------------------------------------------------- |
| Personal API tokens for CI         | later | Needs its own security design (scopes, expiry, rotation); to be agreed first |
| GitLab CI and other CI systems     | later | The CLI commands are the building blocks; templates follow demand            |
| Running the action without a build | later | Needs a published Raion package or image                                     |

### Phase 8: Integrations

#### Added

- **Python** (`python`): zero-code OpenTelemetry via `opentelemetry-instrument`. HTTP metrics per route, traces into databases and other services, and `logging` records linked to traces.
- **Go** (`go`): the OpenTelemetry SDK, configured by Raion's environment variables through `autoexport`. A single setup file to copy, `otelhttp` with routes from `http.ServeMux`, and `slog` logs linked to traces.
- **PostgreSQL, Redis and Nginx** (`postgresql`, `redis`, `nginx`), read by the collector:
  - monitoring credentials only as secret references, mounted as files
  - per-database PostgreSQL metrics
  - a dashboard section for each
  - alerts: `ServiceUnreachable`, `PostgresConnectionsNearLimit`, `PostgresDeadlocks`, `RedisMemoryNearLimit`, `RedisRejectingConnections` and `NginxDroppingConnections`
  - `raion verify --service` tells why the collector cannot read a service
- **Docker containers**:
  - CPU, memory and restarts on each Compose service's dashboard (with `infrastructure.containers`)
  - **container logs without privileges**: `containerLogs: true` makes `raion connect` route the container's output through Docker's `fluentd` logging driver to a loopback-only collector port
- **Typed integration parameters**: boolean, `host:port`, URL, name and secret. None can contain `$`, so nothing can be injected into collector configuration.
- **Workspace integration packages** in `integrations/<name>/`:
  - pinned by checksum in `integrations.lock.yaml`
  - `raion integrations list` and `raion integrations lock`
  - shown in the API and UI next to the built-ins
- **Advisor**:
  - an unmonitored database gets the concrete fix (the integration to add)
  - `type: database` services without monitoring are reported
  - proxies are no longer asked for HTTP metrics
- **Validation codes**: `RAI-E024`–`RAI-E026` and `RAI-W108`.
- **Example** [`examples/polyglot`](examples/polyglot): Nginx → Python → Go, with PostgreSQL and Redis.
- **Tests**:
  - unit tests for receivers, secrets, parameters, container logs, packages and the lock file
  - `promtool` tests for the new alerts
  - a new end-to-end test, `e2e/polyglot.e2e.mjs`, in its own CI job. It connects all five services and checks that the histogram buckets and routes each app emits match its manifest, plus per-database series, every dashboard (container panels included), container logs, the advisor, and `ServiceUnreachable` when the database stops.
- **Docs**: [Integrations](docs/guides/integrations.md), [Writing integrations](docs/guides/writing-integrations.md), [Phase 8 decisions](docs/design/phase-8-decisions.md). Dependabot now covers the example applications.

#### Fixed

- An invalid integration parameter was reported twice (as invalid and as missing).
- The advisor's runbook finding suggested an alert name unrelated to the service.

#### Deferred (intentionally not in Phase 8)

| Item                                   | Phase | Why                                                                         |
| -------------------------------------- | ----- | --------------------------------------------------------------------------- |
| Signed integration packages            | later | Needs key distribution; checksums in Git cover review today                 |
| Packages fetched from registries       | later | Needs signatures first                                                      |
| Java, .NET, PHP; MySQL, MongoDB, Kafka | later | Each needs a real-application end-to-end test; workspace packages meanwhile |
| Nginx status codes and latency         | later | Not in `stub_status`; needs access-log parsing                              |

### Phase 7: Observability Advisor

#### Added

- **`raion advise`** and an **Advisor** page. Each finding shows what is wrong, why it matters, what to do, what was observed and a query to explore. Thirteen rules:
  - **SLOs:** critical service without an SLO, busiest service without an SLO, SLOs that are not measured
  - **Alerting:** service without alerts, paging alerts without a runbook
  - **Coverage:** service without golden-signal metrics, unmonitored databases
  - **Dependencies:** dependencies that are not traced, undeclared dependencies seen in traces, declared dependencies never called
  - **Live data:** low log/trace correlation, telemetry dropped by the collector, high-cardinality metrics and labels
- **Live data** from the running stack (the last hour), through read-only gateway queries. Prometheus's TSDB statistics provide cardinality at no query cost. `--offline` checks configuration only.
- **Fixes Raion can apply** (`raion advise --apply <id>`, **Apply this fix** in the UI):
  - always workspace-file changes, reviewed as a diff and deployed with the normal plan and apply
  - comments, formatting and line endings preserved
  - offered only when the workspace still validates
  - refused when a file changed in the meantime
  - in the UI, the server recomputes the fix from the finding's ID; editors and admins only; audited
- **`advisor.ignore`** in `raion.yaml`: dismiss a finding (or a whole rule) with a reason, kept in Git for everyone to see.
- **CI use:** `raion advise --fail-on <severity>` and `--format json`.
- **API:** `GET /api/v1/advisor`, `POST /api/v1/advisor/apply`.
- **Tests:**
  - fixture tests for every rule, and a check that every offered fix validates
  - comment and CRLF preservation, conflict detection, and path confinement
  - live-fact collection against a fake gateway, including partial failure
  - API, CLI and UI tests
  - the Node.js end-to-end test, which now has the advisor find the critical service without an SLO, then discover the undeclared `payment-api → ledger-api` dependency from traces, apply the fix, plan it and deploy it, with no false correlation or dropped-telemetry findings
- **Docs**: [Advisor](docs/guides/advisor.md), [Phase 7 decisions](docs/design/phase-7-decisions.md).

#### Deferred (intentionally not in Phase 7)

| Item                                          | Phase | Why                                                                                    |
| --------------------------------------------- | ----- | -------------------------------------------------------------------------------------- |
| Database monitoring (the finding is in place) | 8     | Needs the PostgreSQL, MySQL and Redis integrations                                     |
| Configurable thresholds per workspace         | later | Defaults suit the single-node stack; `advise()` already takes thresholds               |
| Finding history and trends                    | later | Needs storage; findings are cheap to recompute                                         |
| Per-label cardinality breakdown               | later | Expensive exactly when cardinality is high; the finding links a query to run on demand |
| Fixes that change application code            | –     | Raion edits only the workspace, never application repositories                         |

### Phase 6: SLIs, SLOs and error budgets

#### Added

- **SLO evaluation** (level 3) as plain Prometheus rules. Bad and total events are recorded every 30 s, and traffic-weighted error ratios computed over 5 m–3 d and the SLO window, together with the SLI, the objective and the error budget left.
- **SLI types**: availability, latency, **throughput** (time-based: the share of 5-minute periods with at least _N_ requests/s), and custom PromQL.
- **Burn-rate alerts**:
  - multi-window, multi-burn-rate (SRE Workbook): `SLOErrorBudgetBurnFast` (page), `SLOErrorBudgetBurnSlow` (ticket) and `SLOErrorBudgetExhausted`
  - rescaled for the SLO window, with exact thresholds for small budgets
  - routed like the service's other alerts
- **Error budget policies**: `policy:` on an SLO, shown with it and included in its alerts.
- **Creating SLOs without YAML**:
  - `raion slo add` asks questions interactively; there is a **Create an SLO** form in the UI (editors and admins)
  - both write a new `slos/<service>-<name>.yaml` after validating the whole workspace, never editing existing files
  - unmeasurable latency thresholds are refused with suggestions
- **Status**:
  - `raion slo list` and an **SLOs** page show SLI, budget left, 1-hour burn rate and health (healthy, at risk, budget spent, no data)
  - service pages show the same for that service's SLOs
  - API: `GET /api/v1/slos`
- **Dashboards**: **Raion · SLOs** (budget at a glance, SLI, budget over time, burn rates) and an SLO row on each service dashboard.
- **OpenSLO v1**:
  - `raion slo export`, "Show as OpenSLO" in the UI, and `GET /api/v1/slos/openslo`; validated in CI with the official `oslo` tool
  - `raion slo import` converts ratio-metric SLOs into custom SLIs, reports everything else, and rolls back if the workspace would become invalid
- **Tests**:
  - burn-condition math, rules, SLI queries, policies and levels
  - OpenSLO export and import, and SLO authoring
  - SLO API and status tests
  - promtool unit tests that a 20% failure rate pages, that 0.05% failures stay within budget, and that the SLI (80%), budget (−199) and burn rate (200×) values are exact
  - the Node.js end-to-end test, which now creates an availability and a latency SLO with the CLI, validates the OpenSLO export with `oslo`, checks SLO status and the SLO dashboard, and receives `SLOErrorBudgetBurnFast` at a webhook receiver
- **Docs**: [SLOs](docs/guides/slos.md), [Phase 6 decisions](docs/design/phase-6-decisions.md), and [MVP Definition of Done](docs/design/mvp-definition-of-done.md), with the evidence for each of the 17 items.

#### Fixed

- The OpenSLO export used list-valued labels, which the official validator rejects.

#### Deferred (intentionally not in Phase 6)

| Item                                         | Phase | Why                                                                                                   |
| -------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------- |
| Latency thresholds between histogram buckets | later | Needs custom bucket views or native histograms end to end; validation suggests exact thresholds today |
| Calendar-aligned SLO windows                 | later | Rolling windows match the burn-rate math                                                              |
| SLO-based release gating                     | later | Belongs to CI/CD; `raion slo list --format json` and `/api/v1/slos` make it possible                  |
| Editing and deleting SLOs in the UI          | later | Creating SLOs writes new files; edits happen in files and Git                                         |

### Phase 5: Alerting

#### Added

- **Generated alert rules** (Prometheus):
  - **Per service with HTTP metrics:** high error rate, high p95 latency, and telemetry that stopped arriving. Severity follows the service tier, low traffic is ignored, and thresholds can be set per service (`alerts:`).
  - **Host:** disk almost full, disk filling within 24 h, memory pressure, sustained CPU.
  - **The stack itself (always on):** component down, telemetry refused or not delivered, collector queue nearly full, rule evaluation failures, notification failures, Alertmanager unreachable, and the always-firing **Watchdog**.
- **Alertmanager routing**:
  - `notifications.defaultReceiver`
  - team routes at level 3 (`ownershipRouting`)
  - Slack, email and webhook receivers with credentials read from files
  - grouping by alert and service
  - inhibition: critical hides warning; a collector outage hides "service stopped sending telemetry"
- **Secrets for receivers**:
  - `raion secrets set|list|remove` and an admin-only API and UI
  - values are written to the private secret store and mounted into Alertmanager as files, never put in generated configuration, logs or API responses
  - `${env:NAME}` is copied from the environment at apply time
  - missing secrets block apply with instructions
  - a changed value restarts only Alertmanager
- **The Raion alert inbox**:
  - the server polls Alertmanager through the gateway and keeps 30 days of history in SQLite
  - an **Alerts** page with pipeline health, firing alerts (dashboard and runbook links), silencing with a reason (editors and admins, audited), active silences, recently resolved alerts, and the rules being watched
  - firing alerts on each service page
- **Alerting pipeline health**: the Watchdog is checked out-of-band by `raion status`, `raion alerts`, the Alerts page and the new **Raion · Alerts** dashboard (firing alerts, notifications sent and failed).
- **`raion alerts`** (text or JSON) reads straight from Alertmanager.
- **A deploy now finishes only when the stack is fully working**: every component is ready, Prometheus has scraped every component successfully, and the Watchdog alert has reached Alertmanager. Otherwise the deploy rolls back. This also removes a race where `raion status` right after a deploy could report a component as not monitored.
- **Quieter Grafana**: plugin preinstall downloads are disabled (Grafana has no internet access by design), and the empty plugin and alerting provisioning folders it expects are generated.
- **Validation**: unknown `defaultReceiver` (`RAI-E015`), runbooks for alerts Raion does not generate (`RAI-W106`), team routes ignored below level 3 (`RAI-W107`).
- **Tests**:
  - `promtool test rules` unit tests of the generated rules in CI (`e2e/rules.e2e.mjs`), covering when alerts fire, when they stay quiet, labels and rendered text
  - generation, routing and secret tests
  - inbox, silence and secrets-API tests against a fake Alertmanager
  - the Node.js end-to-end test, which now proves on a real stack that the Watchdog arrives, that injected errors fire `ServiceHighErrorRate` and are delivered to a webhook receiver whose URL is a secret, and that stopping the collector fires `RaionComponentDown`
- **Docs**: [Alerting](docs/guides/alerting.md), [Phase 5 decisions](docs/design/phase-5-decisions.md).

#### Deferred (intentionally not in Phase 5)

| Item                                                             | Phase | Why                                                                          |
| ---------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------- |
| SLO burn-rate alerts                                             | 6     | Need the SLO recording rules                                                 |
| External dead man's switch (notices when the whole host is down) | later | Needs a receiver outside the host, e.g. a hosted heartbeat service           |
| Editing receivers and thresholds from the UI                     | later | The UI deploys what is in the workspace files; edits happen in files and Git |
| Alerts for services without HTTP metrics (e.g. workers)          | 8     | Need the capabilities those integrations provide                             |
| Microsoft Teams, PagerDuty and Opsgenie receiver types           | later | Generic webhooks cover them today; native types are additive                 |

### Phase 4: Dashboards

#### Added

- **Generated Grafana dashboards**, built from services and their capabilities and provisioned into a read-only "Raion" folder with stable UIDs:
  - **Raion · Overview**: every service's golden signals, plus stack health. Grafana opens on it.
  - **Service · ‹name›**, one per service:
    - golden signals: requests, error rate, p50/p95/p99 latency, instances, traffic by status class
    - per-route traffic and latency
    - dependencies: outgoing calls, errors, latency, and who calls the service
    - Node.js runtime saturation: event-loop delay and utilization, heap
    - logs: volume by level, errors, recent lines
    - traces: slow, failed and recent requests
  - **Raion · Dependencies**: a service map from traces, plus calls and failures for each caller → callee pair.
  - **Raion · Logs**, **Raion · Traces**.
  - **Raion · Infrastructure**: CPU, memory, fullest disk, load, disk throughput, filesystems.
  - **Raion · Containers**, when cAdvisor is enabled.
  - **Raion · Observability stack health**: components up, refused or undelivered telemetry, queue usage, stored series, logs and spans, failed rule evaluations and notifications.
- **Service graph**: the OpenTelemetry Collector's `servicegraph` connector derives dependency metrics from traces (level 2+), flushed every 15 s.
- **`raion verify --dashboards`**: runs every panel through Grafana's own query API and reports dashboards that did not load, queries that failed, and panels that should have data but are empty. Each panel declares whether it may be empty.
- **Live dashboard updates**: dashboard-only changes are planned as `~ refresh grafana` and picked up without restarting Grafana.
- **UI**: a Dashboards list on the Observability stack page, and "Open the … dashboard" on each service page.
- **Tests**:
  - golden dashboards for the example application
  - structural checks: unique panel IDs, known datasources, a query on every data panel, layout bounds
  - capability-driven content
  - the checker against a fake Grafana
  - the refresh plan action
  - the Node.js end-to-end test, which now requires every dashboard to pass `raion verify --dashboards` against live data
- **Docs**: [Dashboards](docs/guides/dashboards.md), [Phase 4 decisions](docs/design/phase-4-decisions.md).

#### Fixed

- The plan summarizes long restart reasons ("10 configuration files changed").

#### Deferred (intentionally not in Phase 4)

| Item                                                         | Phase | Why                                                                                                                          |
| ------------------------------------------------------------ | ----- | ---------------------------------------------------------------------------------------------------------------------------- |
| SLO and error-budget dashboards                              | 6     | Need the SLO rules that produce their data                                                                                   |
| Alert-health dashboard (firing alerts, notification history) | 5     | Needs alert rules and the inbox                                                                                              |
| Database, Redis and web-server dashboards                    | 8     | Come with those integrations, from their capabilities                                                                        |
| User-editable dashboard overrides kept by Raion              | later | Users can build their own dashboards in other Grafana folders; `raion render` exports the generated JSON as a starting point |

### Phase 3: Application integration (Node.js)

#### Added

- **Integration framework**:
  - Integrations are data-only packages (`packages/integrations/<name>/integration.yaml` plus a README), validated by a strict schema.
  - They may declare parameters, requirements (shown, never run), environment variables, and capabilities with exact metric names, labels and buckets.
  - Placeholders are limited to a fixed set of variables, and any other placeholder is rejected at load time.
- **Capabilities** (`http.server`, `http.client`, `logs.otlp`, `traces.otlp`, `runtime.nodejs`) drive health numbers, checks and validation, independent of the integration that provides them.
- **Node.js integration** (`nodejs`):
  - zero-code OpenTelemetry through `NODE_OPTIONS`, including ES modules (`esmHook`)
  - HTTP server and client metrics, distributed traces, and pino/winston/bunyan logs linked to traces
  - chosen automatically from `language: nodejs`
- **`raion connect`**: per-service instructions plus a generated `observability.override.yaml` for Docker Compose services (never edits your files; refuses to overwrite files it did not write). `--format env|shell` prints the variables for programs on the host.
- **`raion verify --service <name>`** checks:
  - metrics, logs and traces actually arrived
  - the share of log lines with trace IDs, and that they open traces
  - request rate, error rate and p95 latency, with the queries used
- **Service page**: live health tiles (request rate, error rate, p95 latency, refreshed every 30 s), telemetry checks, and step-by-step connection instructions with the generated override.
- **API**: `GET /api/v1/services/:name/telemetry`, `GET /api/v1/services/:name/connect`, `GET /api/v1/integrations`.
- **Validation**:
  - unknown integrations (`RAI-E021`) and invalid parameters (`RAI-E023`)
  - latency thresholds that are not histogram buckets (`RAI-E022`)
  - SLOs on services without HTTP metrics (`RAI-W104`)
  - integration/language mismatch (`RAI-W105`)
- **Example application** (`examples/nodejs-express`):
  - payment-api calling ledger-api, plus a load generator and fault injection
  - its own compose file, with no observability code
  - a Raion workspace
- **Supply chain**: a CycloneDX SBOM of npm dependencies in CI (`pnpm sbom`), and a weekly Trivy scan of every pinned runtime image (`scripts/scan-images.mjs`, report-only by default).
- **Tests**:
  - integration loading, including hostile packages
  - interpolation, resolution, validation and connection generation (golden override)
  - service telemetry against a fake gateway
  - server endpoints
  - a Node.js end-to-end test in CI (`e2e/nodejs.e2e.mjs`) that deploys, connects the example app and requires every check to pass
- **Docs**: [Connecting applications](docs/guides/connecting-applications.md), [Node.js integration](packages/integrations/nodejs/README.md), [Phase 3 decisions](docs/design/phase-3-decisions.md).

#### Deferred (intentionally not in Phase 3)

| Item                                                                      | Phase                  | Why                                                                               |
| ------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------- |
| Container stdout log collection                                           | 8 (Docker integration) | Needs a host-level log reader designed once for all languages (decision D7)       |
| Third-party integration directories, `integrations.lock.yaml`, signatures | 8                      | Only first-party packages exist; they ship inside Raion                           |
| Python, Go and other language integrations                                | 8                      | The framework is ready; these are additional packages                             |
| Custom histogram buckets (SDK views) for unusual latency thresholds       | 6                      | Thresholds must currently be a default bucket boundary; validation explains which |
| Dashboards                                                                | 4                      | The data is now there to build them on                                            |

### Phase 2: Observability runtime (Docker Compose)

#### Added

- **Runtime generation** (`@raion/core`, pure and deterministic). From the workspace, Raion generates configuration for:
  - OpenTelemetry Collector 0.161
  - Prometheus 3.13 with native OTLP ingest and promoted service labels
  - Loki 3.7, with OTLP ingest and trace_id/span_id structured metadata
  - Tempo 3.1, deployed only when a service uses tracing
  - Grafana 13.2, with datasources linked for metric/log/trace correlation
  - Alertmanager 0.34
  - node_exporter 1.12
  - cAdvisor 0.60 (opt-in)
  - the Raion gateway (nginx)
  - a Docker Compose project
- **Pinned images**: every image is pinned by multi-arch digest. `scripts/update-images.mjs` re-resolves them, and `--check` detects drift.
- **Secure runtime by default**:
  - Only the gateway (`127.0.0.1:7601`) and the OTLP receiver (`127.0.0.1:4317/4318`) are published.
  - The gateway requires a secret that only Raion holds.
  - Backends sit on an internal network with no internet access, and applications can reach only the collector.
  - Every container drops all capabilities and runs with a read-only root filesystem, no-new-privileges and memory limits.
  - Secrets are mounted as files and never written into generated configuration.
- **Grafana single sign-on** through the Raion server (`/grafana/`). Raion roles map to Grafana roles, browser-supplied identity headers are discarded, and Grafana's own login is disabled.
- **Deployment engine** (`@raion/deploy`):
  - `DeploymentTarget` interface, with Docker Compose implemented
  - immutable numbered releases and a stable runtime directory
  - plans that classify each change (start, restart, recreate, stop)
  - approval gates for privileged components and data-affecting changes
  - automatic rollback when a release does not become ready
  - a workspace lock against concurrent deploys
  - validation of generated files by each component's own tool before deploying
  - status with readiness and Prometheus scrape health
  - an end-to-end pipeline check
- **CLI**: `raion plan` (with `--detailed-exitcode` for CI), `apply`, `status`, `verify`, `rollback`, `destroy`, `render`, and `validate --deep`.
- **Server and UI**:
  - an "Observability stack" page showing component health, monitoring of the stack itself, pending changes with Apply, live job progress, "Test the pipeline", every generated file, and the release history
  - an Open Grafana link
  - return to Grafana after sign-in
  - a startup warning when `server.publicUrl` does not match the server's address
- **Workspace settings**: `spec.target.compose` ports and project name, `spec.retention`, `spec.server.publicUrl`. Metrics retention is raised automatically to cover the longest SLO window.
- **Tests**:
  - golden files for generated configuration
  - security-default assertions
  - plan, release, lock and apply/rollback tests with fake Docker and gateway
  - Grafana proxy tests
  - a full-stack end-to-end test (`pnpm run test:e2e`) that runs in CI on Linux
- **Docs**: [Deploying the observability stack](docs/guides/deploying.md), [Phase 2 decisions](docs/design/phase-2-decisions.md).

#### Deferred (intentionally not in Phase 2)

| Item                                                                     | Phase | Why                                                                                                                        |
| ------------------------------------------------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------- |
| Host network metrics (node_exporter sees its own container interface)    | later | Needs host networking; see decision D6                                                                                     |
| Collecting container stdout logs                                         | 3     | Applications send logs over OTLP first; container logs come with the application integration                               |
| Alert rules, notification receivers (Slack, email, webhook), alert inbox | 5     | Alertmanager is deployed with an inbox-only route                                                                          |
| Dashboards                                                               | 4     | The Grafana dashboard provider is in place but empty                                                                       |
| SBOM and image vulnerability scanning in CI                              | 3     | Images are third-party and pinned. Scanning them (and producing an SBOM for Raion's own package) needs a release pipeline. |
| Editing the workspace from the UI                                        | later | The UI deploys what is in the workspace files; edits happen in files and Git                                               |
| Grafana Live (websockets)                                                | later | The Raion proxy does not upgrade connections; dashboards still refresh by polling                                          |

#### Known limitations

- Docker Desktop: "host" metrics describe Docker's Linux VM.
- Tempo logs a harmless `no jobs found` message periodically when idle.

### Phase 1: Foundation

#### Added

- **Configuration schemas** (`@raion/schema`) for `Workspace`, `Service` and `SLO` documents (`apiVersion: raion/v1alpha1`):
  - single-file and split (GitOps) layouts
  - observability levels 1-3 as feature-flag presets, with per-workspace and per-service overrides
  - secrets accepted only as `${secret:NAME}` / `${env:NAME}` references
  - JSON Schema export for editors and CI
- **Workspace loading and validation** (`@raion/core`):
  - YAML parsing with alias-expansion limits and file size and count limits
  - schema validation with file, line and column for every finding
  - cross-reference checks (teams, receivers, dependencies, SLO targets, runbooks, environments) with "did you mean" suggestions
  - stable diagnostic codes ([docs/guides/validation-codes.md](docs/guides/validation-codes.md))
- **Service registry** with dependency and dependent lookups and cycle detection.
- **`raion` CLI**:
  - `init` (guided questions or flags; never overwrites)
  - `validate` (text or JSON output; exit code 1 on errors)
  - `schema`
  - `server`
  - `users add|list`
- **Raion server** (multi-user control plane):
  - accounts with scrypt password hashing, account lockout and login rate limiting
  - sessions in HttpOnly SameSite=Strict cookies with idle and absolute expiry
  - viewer, editor and admin roles enforced per route; last-admin protection
  - audit log
  - first-admin setup via a one-time link
  - CSRF and DNS-rebinding protection, strict security headers and CSP
  - refuses plain HTTP off-loopback (built-in TLS or `--trust-proxy` with an https public URL)
  - `/healthz`, `/readyz`, and `/metrics` (Prometheus format, loopback only)
- **Web UI**: first-admin setup, sign-in, services list, service page (properties, SLOs with error-budget explanation, dependencies, "Show configuration"), user administration. Accessible markup, keyboard focus styles, and light and dark themes.
- **Tooling**:
  - pnpm workspace
  - strict TypeScript, type-aware ESLint with layer-boundary rules, Prettier
  - Vitest (64 tests)
  - CI on Linux, Windows and macOS, plus a dependency audit and CodeQL
  - Dependabot; supply-chain settings (24h minimum release age, install scripts blocked)
- **Community files**: license (Apache-2.0), contributing guide, security policy, code of conduct, issue and PR templates.

#### Deferred (intentionally not in Phase 1)

| Item                                                                    | Phase    | Why                                                                                            |
| ----------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| Deploying anything (`plan`, `apply`, `destroy`, `status`)               | 2        | Needs the deployment engine and generators                                                     |
| Live health data on service pages                                       | 2-4      | Nothing is measured until the stack is deployed. The UI says so rather than showing fake data. |
| Integration registry; validating `integrations:` names                  | 3, 8     | Integration packages do not exist yet, so names are recorded but not checked                   |
| Latency-threshold vs histogram-bucket check                             | 6        | Needs integration capability metadata                                                          |
| Throughput SLIs                                                         | 6        | Rejected with an explanatory message for now                                                   |
| Editing configuration from the UI, with optimistic concurrency          | 2+       | The UI is read-only in Phase 1. Edits are made in files and Git.                               |
| Personal API tokens for remote CLI use                                  | 9        | No remote CLI commands exist yet                                                               |
| OIDC single sign-on                                                     | post-MVP | Built-in accounts cover the MVP                                                                |
| SBOM generation and image scanning                                      | 2        | There are no container images until Phase 2                                                    |
| Playwright end-to-end UI tests and automated accessibility (axe) checks | 4        | The UI is still small. Component tests cover current behaviour.                                |

#### Known limitations

- On Windows, `.raion/` file permissions are not restricted (POSIX modes only apply on Linux and macOS).
