# Raion

**Observability as a platform, built on the open-source tools you already trust.**

Raion gives your team production-grade monitoring without first becoming experts in it. You describe your services in a few YAML files. Raion sets up and runs OpenTelemetry, Prometheus, Loki, Tempo, Grafana and Alertmanager for you, with dashboards, alerts, SLOs and error budgets, and gives your team a web UI to see how everything is doing.

Raion does not replace those tools; it configures them. Everything it generates is ordinary configuration you can read, export and run without Raion.

## What Raion does

- **Connects your applications** with OpenTelemetry. Node.js and Python need no code changes; Go needs one setup file. Metrics, logs and traces arrive linked to each other.
- **Monitors databases, proxies and containers.** PostgreSQL, Redis and Nginx are read with read-only credentials. Docker containers get resource metrics and log collection.
- **Generates dashboards** for every service, and keeps them current.
- **Alerts** on errors, slow responses, missing telemetry, unreachable databases, full disks and problems in the monitoring itself. Alerts go to a built-in inbox and to Slack, email or webhooks.
- **Measures SLOs** with error budgets and multi-window burn-rate alerts. Import and export them in OpenSLO format.
- **Advises:** finds gaps such as a critical service without an SLO, logs without trace IDs, or dropped telemetry, and fixes the safe ones as reviewable changes.
- **Gives your team one place to work.** The web UI has personal accounts, viewer, editor and admin roles, an audit log, and single sign-on into Grafana.
- **Keeps everything as code.** Changes are validated, planned and deployed with automatic rollback. Pull requests show exactly what a change does, and drift detection catches changes made around the review.

## Quick start

You need Node.js 24+, Docker, and Git.

```sh
git clone <this repository> raion && cd raion
corepack enable && pnpm install && pnpm run build

pnpm raion init observability                      # describe your first service (asks a few questions)
pnpm raion apply observability                     # deploy the observability stack
pnpm raion server --workspace observability        # start the web UI
```

The server prints a one-time link: open it to create your administrator account. Then go to **<http://127.0.0.1:7600>**.

The [documentation](docs/README.md) takes it from there: [first run](docs/03-first-run.md), [a tour of the web UI](docs/04-ui-tour.md), and [connecting a service](docs/05-connecting-a-service.md).

## Documentation

**[Start here](docs/README.md)**: installing, first run, the web UI, connecting services, integrations, dashboards, alerts, SLOs, investigating problems, the Advisor, applying changes, GitOps, security, and troubleshooting, plus the [command line](docs/reference/cli.md) and [HTTP API](docs/reference/api.md) reference.

Examples you can run: [Node.js](examples/nodejs-express), [Python, Go, PostgreSQL, Redis and Nginx](examples/polyglot), and [a GitOps repository](examples/gitops).

## Project

Raion is open source under the [Apache-2.0](LICENSE) licence. It is owned and maintained by a single maintainer, who decides its design and direction. Bug reports, problems with the documentation, and suggestions are welcome as issues: see [CONTRIBUTING](CONTRIBUTING.md). Report security problems privately: see [SECURITY](SECURITY.md).

Changes are listed in the [changelog](CHANGELOG.md).
