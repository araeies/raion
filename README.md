# Raion

**Observability as a platform, built on the open-source tools you already trust.**

Raion gives your team production-grade monitoring without first becoming experts in it. Add your applications in a guided web UI, and Raion does the SRE thinking: it sets up and runs OpenTelemetry, Prometheus, Loki, Tempo, Grafana and Alertmanager for you, with dashboards, alerts explained in plain words, reliability goals and error budgets. Everything is also available from the `raion` command line, and stored as ordinary YAML files you can review in Git.

Raion does not replace those tools; it configures them. Everything it generates is ordinary configuration you can read, export and run without Raion.

## What Raion does

- **Connects your applications** with OpenTelemetry, including ones already running: it finds them on the machine and restarts them with its settings, without touching your compose files. Node.js, Python and Java in Docker need no rebuild and no code change. Metrics, logs and traces arrive linked to each other.
- **Watches applications that run elsewhere** (the cloud, another server, Kubernetes) from outside: availability, answer time and certificate expiry.
- **Monitors databases, proxies and containers.** PostgreSQL, Redis and Nginx are read with read-only credentials. Docker containers get resource metrics and log collection.
- **Generates dashboards** for every service, and keeps them current.
- **Alerts** on errors, slow responses, missing telemetry, unreachable databases, full disks and problems in the monitoring itself. Each alert says what is wrong, why it fired and what to do. Alerts are on one page in Raion and go to Slack, email or webhooks.
- **Measures SLOs** with error budgets and multi-window burn-rate alerts. Import and export them in OpenSLO format.
- **Advises:** finds gaps such as a critical service without an SLO, logs without trace IDs, or dropped telemetry, and fixes the safe ones as reviewable changes.
- **Gives your team one place to work.** A web UI for everything, with help where you need it, personal accounts, viewer, editor and admin roles, single sign-on, API tokens and an audit log. The command line does everything the web UI does, for scripts and CI/CD.
- **Keeps everything as code.** Changes are validated, planned and deployed with automatic rollback. Pull requests show exactly what a change does, and drift detection catches changes made around the review.

## Quick start

You need Node.js 24+, Docker, and Git.

```sh
git clone https://github.com/araeies/raion.git && cd raion
corepack enable && pnpm install && pnpm run build

pnpm raion init observability                      # create a workspace (asks a few questions)
pnpm raion server --workspace observability        # start the web UI
```

`observability` is the folder Raion creates for your workspace; any name works, as long as you use the same one in both commands (`raion init my-monitoring`, then `raion server --workspace my-monitoring`). The workspace's own name is the first question `raion init` asks. See [names in the examples](docs/README.md#names-in-the-examples).

If `corepack enable` fails with `EPERM` on Windows, see [Installing](docs/02-installing.md#install).

The server prints a one-time link: open it to create your administrator account. **Home** then walks you through starting monitoring and adding your applications.

The [documentation](docs/README.md) takes it from there: [first run](docs/03-first-run.md), [a tour of the web UI](docs/04-ui-tour.md), and [connecting an application](docs/05-connecting-a-service.md).

## Documentation

**[Start here](docs/README.md)**: installing, first run, the web UI, connecting services, integrations, dashboards, alerts, SLOs, investigating problems, the Advisor, applying changes, GitOps, security, and troubleshooting, plus [web UI and command line](docs/reference/ui-and-cli.md), the [command line](docs/reference/cli.md) and [HTTP API](docs/reference/api.md) reference.

Examples you can run: [Node.js](examples/nodejs-express), [Python, Go, PostgreSQL, Redis and Nginx](examples/polyglot), and [a GitOps repository](examples/gitops).

## Project

Raion is open source under the [Apache-2.0](LICENSE) licence. It is owned and maintained by a single maintainer, who decides its design and direction. Bug reports, problems with the documentation, and suggestions are welcome as issues: see [CONTRIBUTING](CONTRIBUTING.md). Report security problems privately: see [SECURITY](SECURITY.md).

Changes are listed in the [changelog](CHANGELOG.md).
