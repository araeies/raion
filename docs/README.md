# Raion documentation

Raion gives a team production-grade observability (metrics, logs, traces, dashboards, alerts and reliability goals) without first becoming experts in it. You add your applications in the web UI; Raion configures and runs the open-source tools that do the work, and explains what it finds in plain words.

These pages describe the **web UI** first, since that is where most people work. Every step can also be done with the `raion` command, for scripts and CI/CD: see [Web UI and command line](reference/ui-and-cli.md).

## New to Raion? Start here

Read these in order. By the end, you will have Raion running, be signed in to its web UI, and have an application sending metrics, logs and traces.

1. [What is Raion?](01-what-is-raion.md): what it does, how it works, and the few ideas you need
2. [Installing Raion](02-installing.md): prerequisites and installation
3. [First run](03-first-run.md): create a workspace, start Raion, sign in, start monitoring and add your application
4. [A tour of the web UI](04-ui-tour.md): what each page shows and what you can do there
5. [Connecting an application](05-connecting-a-service.md): applications already running, without rebuilding, or running elsewhere

## Using Raion

| Topic                                                 | What you will learn                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| [Describing your services](06-configuration.md)       | For advanced users: the workspace files behind the web UI, and every option     |
| [Integrations](integrations/README.md)                | What each integration provides and how to configure it                          |
| [Metrics, logs and traces](07-signals.md)             | What is collected for each service, and where to find it                        |
| [Dashboards](08-dashboards.md)                        | The dashboards Raion generates and keeps up to date                             |
| [Alerts and notifications](09-alerts.md)              | Alerts explained, what is watched, where alerts go, silencing, runbooks         |
| [SLOs and error budgets](10-slos.md)                  | Defining reliability targets, reading error budgets, burn-rate alerts           |
| [Investigating a problem](11-investigating.md)        | Going from an alert to the cause: application page, dashboards, logs and traces |
| [The Advisor](12-advisor.md)                          | Finding gaps in your observability, and fixing them                             |
| [Applying changes](13-applying-changes.md)            | Validate, plan, apply, roll back; viewing the generated configuration; drift    |
| [Working through Git](14-gitops.md)                   | Reviewing changes in pull requests, deploying on merge, detecting drift         |
| [Users, roles and security](15-users-and-security.md) | Accounts, roles, secrets, and serving Raion to your team                        |
| [Is Raion itself healthy?](16-raion-health.md)        | Checking the observability stack, alerting, and telemetry delivery              |
| [Troubleshooting](17-troubleshooting.md)              | Common problems and their fixes                                                 |

## Reference

- [Web UI and command line](reference/ui-and-cli.md): how the two fit together, who may do what, and each capability in both
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
