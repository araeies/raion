# Changelog

All notable changes to Raion are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

The first release of Raion.

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
