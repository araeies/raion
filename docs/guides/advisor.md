# The Observability Advisor

The advisor looks for common gaps in your observability and tells you, for each one:

- what is wrong
- why it matters
- what to do about it

Where the fix is a safe change to your workspace files, Raion can make it for you.

```sh
raion advise                     # the findings for ./observability
raion advise --apply <finding>   # review and write a fix, e.g. critical-service-without-slo/payment-api
```

In the UI, open **Advisor**.

## Where the findings come from

- **Your configuration.** Always checked, even before anything is deployed.
- **The running stack.** Checked when it is deployed, using the last hour:
  - traffic per service
  - log lines with and without trace IDs
  - calls between services seen in traces
  - telemetry the collector refused or could not deliver
  - Prometheus's series counts

  All of this is read with read-only queries through the Raion gateway. `--offline` skips it.

If part of the live data cannot be read, the advisor says so and still reports everything else.

## What it checks

| Rule                             | Finds                                                                                   | Live data | Raion can fix it                                              |
| -------------------------------- | --------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------- |
| `critical-service-without-slo`   | A `tier: critical` service without an SLO                                               |           | Yes: a 99.9% availability SLO (and turns SLOs on)             |
| `busiest-service-without-slo`    | The service with the most traffic has no SLO                                            | ✓         | Yes: same                                                     |
| `slos-not-evaluated`             | SLOs on a service whose level does not measure them                                     |           | Yes: `features: { slos: true }` on that service               |
| `service-without-alerts`         | A service with HTTP metrics whose alerts are turned off                                 |           | Yes: turns its alerts back on                                 |
| `service-without-golden-signals` | An API or web service without request rate, error and latency metrics                   |           | No: needs an integration for its language                     |
| `page-alert-without-runbook`     | Alerts that page someone (critical services, fast SLO burn) without a runbook link      |           | No: only you know the runbook's URL                           |
| `database-not-monitored`         | A database dependency, or a `type: database` service, that nothing monitors             |           | No: needs an endpoint and a monitoring user; the fix says how |
| `dependencies-not-traced`        | Declared dependencies that tracing cannot confirm (traces or the service graph are off) |           | Yes: turns on traces and the service graph                    |
| `undeclared-dependency`          | Calls seen in traces between services that are not declared as dependencies             | ✓         | Yes: adds the dependency                                      |
| `unused-dependency`              | A declared dependency with no calls, while the caller was busy                          | ✓         | No: it may be a rare call; you decide                         |
| `low-log-trace-correlation`      | Under 80% of a service's log lines carry a trace ID                                     | ✓         | No: needs a change in the application's logging               |
| `collector-dropping-telemetry`   | Over 1% of telemetry refused or not delivered by the collector                          | ✓         | No: the cause must be found; the finding says where           |
| `high-cardinality-metric`        | A metric with over 10,000 series, or a label with over 5,000 values                     | ✓         | No: the label must be removed in the application              |

Severities:

- **critical:** data is being lost, or nobody is told when a critical service breaks
- **warning:** a gap that will hurt in an incident
- **info:** a suggestion

## How fixes are applied

A fix only ever changes **workspace files**: it creates a new SLO file, or edits a service or `raion.yaml`. It never touches the running stack directly.

1. **Review.** `raion advise --apply` (and **Raion can do this** in the UI) shows the change as a diff before anything is written.
2. **Written as a hand edit.** Edits keep your comments, key order and formatting, and Windows line endings, so the change reads like a hand edit in review.
3. **Checked first.** A fix is offered only if the whole workspace still validates with it applied.
4. **Never overwrites someone else's change.** If any file changed after the findings were computed (another user, an editor, a `git pull`), nothing is written and you are asked to look again.
5. **Deployed the normal way.** Review the change, commit it, then run `raion plan` and `raion apply` (or **Plan** and **Apply** on the Observability stack page).

In the UI, viewers see fixes but only editors and admins can apply them. Every applied fix is recorded in the audit log. The browser sends only the finding's ID: the server works out the fix again itself, so a request cannot write arbitrary content.

## Ignoring a finding

Some findings are deliberate. A database may be monitored by another team, for example. Record that in `raion.yaml`, so the decision and its reason are visible to everyone:

```yaml
spec:
  advisor:
    ignore:
      - rule: database-not-monitored
        subject: postgres-main # optional: omit to ignore the rule everywhere
        reason: The DBA team monitors it in their own Grafana.
```

`subject` is what the finding is about: the second part of its ID (`<rule>/<subject>`), such as a service name, `payment-api->ledger-api` or a metric name. Ignored findings are hidden from the list and the summary; `raion advise --all` and the UI's **ignored** section still show them.

## In CI

```sh
raion advise --offline --fail-on warning   # exit 1 when a warning or critical finding exists
raion advise --format json                 # machine-readable findings
```

`--offline` keeps CI independent of a running stack. Without it, the live checks run too when the stack is reachable.
