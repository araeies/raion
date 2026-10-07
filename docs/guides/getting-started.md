# Getting started

This guide takes you from nothing to a validated Raion workspace and a running Raion server. It takes about ten minutes.

> **What you will not have yet:** automatic instrumentation of your application (Phase 3), dashboards (Phase 4), alerts (Phase 5) and SLO evaluation (Phase 6). You will have a running, verified observability stack that any OpenTelemetry-instrumented application can send data to.

## 1. Install

You need Node.js 24 or newer.

```sh
corepack enable
pnpm install
pnpm run build
```

## 2. Create a workspace

A **workspace** is a folder of YAML files that describes what you want to observe. Keep it in Git, next to your code or in its own repository.

```sh
pnpm raion init observability
```

Raion asks four questions:

1. **What are you monitoring?** An API, a website, a worker, and so on.
2. **What is it called?**
3. **Where does it run?** Docker Compose or directly on a machine.
4. **What language is it written in?**

It then asks **how much to set up**:

| Level        | You get                                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------------------------------- |
| 1 Basic      | Logs, CPU, memory, disk and network, request rate, error rate, latency, basic alerts and dashboards                   |
| 2 Production | Everything in level 1, plus distributed tracing, logs linked to traces, a dependency map and golden-signal dashboards |
| 3 SRE        | Everything in level 2, plus SLOs, error budgets and burn-rate alerts                                                  |

Start with level 1 if you are unsure. You can change it later by editing one line.

You get:

```
observability/
├── raion.yaml              # the workspace: level, environment, teams, where alerts go
├── services/
│   └── payment-api.yaml    # one file per service
└── .gitignore              # keeps .raion/ (local state and secrets) out of Git
```

## 3. Validate

```sh
pnpm raion validate observability
```

`validate` checks every file and explains any problem with its exact location:

```
error RAI-E012 services/payment-api.yaml:17:20
  service "payment-api" depends on unknown service "ledgr-api"
  hint: did you mean "ledger-api"?
```

It exits with code 1 when there are errors, so you can run it in CI on every pull request. Use `--format json` for machine-readable output. Every code is explained in [validation codes](validation-codes.md).

## 4. Deploy the observability stack

You need Docker (Docker Desktop on Windows and macOS).

```sh
pnpm raion plan observability     # see what will be deployed; nothing changes yet
pnpm raion apply observability    # deploy (asks for confirmation)
pnpm raion verify observability   # send test data and confirm it is stored
```

The first `apply` downloads the container images, which takes a few minutes. [Deploying the observability stack](deploying.md) explains every component and what to do when something fails.

## 5. Connect your application

```sh
pnpm raion connect observability --out observability.override.yaml
```

This prints what to install in your application and writes a Docker Compose override that connects it. Start your application with `docker compose -f compose.yaml -f observability.override.yaml up -d`, then check it with `pnpm raion verify observability --service <name>`.

[Connecting applications](connecting-applications.md) explains the details. [examples/nodejs-express](../../examples/nodejs-express) is a complete example you can run.

## 6. Start the Raion server

```sh
pnpm raion server --workspace observability
```

The first time, the server prints a one-time link:

```
No users exist yet. Create the first admin within 30 minutes:
  http://127.0.0.1:7600/setup#token=...
```

Open it, choose an admin username and password, and you are in. From **Users** you can invite colleagues as viewers, editors or admins. See [users, roles and security](security.md).

The server only listens on `127.0.0.1` by default. To share it with your team, see [Serving Raion to a team](security.md#serving-raion-to-a-team).

## 7. Explore

The **Observability stack** page shows the health of every component, what applying would change, and every generated configuration file. **Grafana** in the top bar opens Grafana, already signed in.

The **Services** page lists what your workspace describes. Each service page shows its owner, its SLOs and the error budget they allow, its dependencies, and "Show configuration", which displays the exact YAML the page was built from.

## Editor support

Run `pnpm raion schema > raion.schema.json`, then point the YAML extension of your editor at it for autocompletion and inline errors. In VS Code with the Red Hat YAML extension, add this to the top of your files:

```yaml
# yaml-language-server: $schema=./raion.schema.json
```
