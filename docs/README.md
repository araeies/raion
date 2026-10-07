# Raion documentation

Raion gives a team production-grade observability (metrics, logs, traces, dashboards, alerts and SLOs) without first becoming experts in it. You describe your services; Raion configures and runs the open-source tools that do the work.

## New to Raion? Start here

Read these in order. By the end, you will have Raion running, be signed in to its web UI, and have a service sending metrics, logs and traces.

1. [What is Raion?](01-what-is-raion.md): what it does, how it works, and the few ideas you need
2. [Installing Raion](02-installing.md): prerequisites and installation
3. [First run](03-first-run.md): create a workspace, deploy the stack, start Raion and sign in
4. [A tour of the web UI](04-ui-tour.md): what each page shows and what you can do there
5. [Connecting a service](05-connecting-a-service.md): get telemetry from your application into Raion

## Using Raion

| Topic                                                 | What you will learn                                                           |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| [Describing your services](06-configuration.md)       | The workspace files: services, teams, levels, notifications, and every option |
| [Integrations](integrations/README.md)                | What each integration provides and how to configure it                        |
| [Metrics, logs and traces](07-signals.md)             | What is collected for each service, and where to find it                      |
| [Dashboards](08-dashboards.md)                        | The dashboards Raion generates and keeps up to date                           |
| [Alerts and notifications](09-alerts.md)              | What is watched, where alerts go, silencing, runbooks                         |
| [SLOs and error budgets](10-slos.md)                  | Defining reliability targets, reading error budgets, burn-rate alerts         |
| [Investigating a problem](11-investigating.md)        | Going from an alert to the cause: service page, dashboards, logs and traces   |
| [The Advisor](12-advisor.md)                          | Finding gaps in your observability, and fixing them                           |
| [Applying changes](13-applying-changes.md)            | Validate, plan, apply, roll back; viewing the generated configuration; drift  |
| [Working through Git](14-gitops.md)                   | Reviewing changes in pull requests, deploying on merge, detecting drift       |
| [Users, roles and security](15-users-and-security.md) | Accounts, roles, secrets, and serving Raion to your team                      |
| [Is Raion itself healthy?](16-raion-health.md)        | Checking the observability stack, alerting, and telemetry delivery            |
| [Troubleshooting](17-troubleshooting.md)              | Common problems and their fixes                                               |

## Reference

- [Command line](reference/cli.md): every `raion` command and option
- [Validation codes](reference/validation-codes.md): what each `RAI-…` message means and how to fix it
- [HTTP API](reference/api.md): for scripts and automation
- [Writing integrations](integrations/writing-integrations.md): add support for a technology yourself

## Examples

| Example                                                      | Shows                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| [Node.js](../examples/nodejs-express)                        | Two Node.js services connected without code changes, with SLOs and alerts |
| [Python, Go, PostgreSQL, Redis, Nginx](../examples/polyglot) | A shop in three languages with two databases and a proxy                  |
| [A GitOps repository](../examples/gitops)                    | Pull-request checks, approved deployment and drift detection              |

## Getting help

Found a bug, something unclear in these pages, or a missing capability? See [Reporting issues](../CONTRIBUTING.md). Security problems are reported privately: see [SECURITY.md](../SECURITY.md).
