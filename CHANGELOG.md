# Changelog

All notable changes to Raion are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

The first release of Raion.

### Beginner-first web UI

- A redesigned, light web UI: a sidebar, **Home** with what needs attention and a setup checklist, and help everywhere (explanations on hover, "What is this?" boxes, recommended choices, and technical details folded away for advanced users).
- **Add an application**: a guided setup that asks where it runs (Docker Compose, Docker, this machine, the cloud, Kubernetes, or "I'm not sure"), lists the containers running on the machine, recommends what to monitor, and sets it up.
- Everything the command line configures can be done in the web UI: applications, reliability goals, workspace settings (level, retention, machine monitoring), notification channels, teams and secrets.
- Charts of each application's requests, failures and response time (or availability and answer time for outside checks) over the last hour, 6 hours or 24 hours.

### Alerts, explained

- Every alert says what is wrong, for which application, what it means, why it fired, since when, where it comes from and what to do; the exact rule is under technical details.
- Alerts about to fire are shown before they fire, and alert history is filled in from Prometheus for any time the web UI was not running.
- Grafana's own alerting is turned off, so every alert is in one place; the always-firing self-test is shown as such.

### Connecting applications that already run

- `raion discover` and **Add an application** find the containers running on the machine.
- **Connect it for me** (admins) and `raion connect --restart` restart one Compose service with Raion's settings, after showing what will change; your compose files are not changed.
- Node.js, Python and Java applications in Docker Compose are instrumented without rebuilding: Raion adds the pinned OpenTelemetry agent when the container starts. A built-in Java integration.
- Outside checks for applications that run elsewhere (`runtime: remote`): availability, answer time and certificate expiry, with alerts, reliability goals and a dashboard section.

### Web UI and command line together

- One engine for both: the web UI and the command line use the same editing, validation, deployment and audit, and act on the same files and state.
- New commands: `raion services`, `raion settings`, `raion receivers`, `raion teams`, `raion slo set|remove`, `raion alerts silence|silences|unsilence`, `raion users set-role|disable|enable|reset-password`, `raion tokens`, `raion audit`, `raion activity`, `raion discover` and `raion history`.
- `--format json` with one JSON document on standard output, `--dry-run` for edits, and documented exit codes.
- Deployments, rollbacks, repairs, tests and restarts are recorded wherever they start, followed live in the web UI, never run twice at once, and shown as interrupted if their process stops.

### Workspaces and configuration

- Observability as code: a workspace of YAML files (`raion.yaml`, `services/`, `slos/`) describing services, teams, levels, notifications and SLOs.
- `raion init` creates a workspace by asking a few questions; `raion validate` explains every problem with its file, line and a suggested fix; a JSON Schema for editor autocompletion.
- Secrets are only referenced from files (`${secret:NAME}`, `${env:NAME}`), never written into them.

### The observability stack

- `raion plan` and `raion apply` deploy OpenTelemetry Collector, Prometheus, Loki, Tempo, Grafana, Alertmanager and node_exporter (cAdvisor optional) with Docker Compose.
- Every generated file is checked by the component's own validator before deploying; a deployment that does not become healthy is rolled back automatically.
- Releases, `raion rollback`, `raion drift` (with `--repair`) and `raion destroy`.
- Images pinned by digest, hardened containers, and a single authenticated gateway into the stack.

### Connecting services

- Integrations for Node.js and Python (zero-code), Go (OpenTelemetry SDK), PostgreSQL, Redis and Nginx (read by the collector), and Docker containers (metrics and logs).
- `raion connect` writes a Docker Compose override or prints environment variables; `raion verify --service` checks metrics, logs, traces and their correlation.
- Workspace integration packages, pinned by checksum in `integrations.lock.yaml`.

### Dashboards, alerts and SLOs

- Generated Grafana dashboards: overview, one per service, dependencies, logs, traces, infrastructure, containers, SLOs, alerts, and the health of the stack itself. `raion verify --dashboards` checks every panel.
- Generated alerts for services, databases, the host and the stack itself, with an always-firing Watchdog that proves alerting works. A built-in inbox, silences, runbook links, and Slack, email and webhook notifications.
- SLOs (availability, latency, throughput, custom) with error budgets, multi-window burn-rate alerts, error budget policies, and OpenSLO export and import.

### The Advisor

- `raion advise` and the Advisor page find gaps in your observability, from both the configuration and live data, and apply the safe fixes as reviewable changes to workspace files.

### Web UI and access

- Pages for services, SLOs, alerts, the Advisor, integrations and the observability stack; user management and an audit log page for admins.
- Personal accounts with viewer, editor and admin roles, and single sign-on into Grafana.
- An account page to change your password; admins reset other people's passwords from the Users page.
- Single sign-on with any OpenID Connect identity provider (Entra ID, Google, Okta, Keycloak, …): accounts created at first sign-in, roles mapped from groups, and optional password sign-in.
- Personal API tokens for scripts: limited to a role, always expiring, revocable, and audited by name.
- An audit log of sign-ins, account, token and secret changes, deployments, silences, SLOs and advisor fixes, filterable by person and action.
- Secure defaults: loopback-only unless served over HTTPS, CSRF and DNS-rebinding protection, a strict Content-Security-Policy.

### Working through Git

- `raion diff` shows what a change does between two versions of a workspace.
- A GitHub Action for pull requests (validation, comparison and advisor findings in one comment), and an example GitOps repository.
- `RAION_STATE_DIR` keeps state outside a CI checkout.
