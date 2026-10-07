# MVP Definition of Done: status

The MVP is complete when a new user can do each of the following. This page records the evidence for each item: what proves it, and where that proof runs.

**Where the tests run:**

- **Unit tests** run in CI on Linux, Windows and macOS.
- **End-to-end tests (e2e)** run in CI on Linux against real containers, on every change.

| #   | A new user can…                                         | Evidence                                                                                                                                                                                      |
| --- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Install the platform                                    | Clean-checkout install and build on all three operating systems (CI `check` job). The getting-started guide follows the same steps.                                                           |
| 2   | Connect a Node.js application                           | `e2e/nodejs.e2e.mjs`: `raion connect` writes an override; the example app starts with it, unchanged                                                                                           |
| 3   | Deploy the OSS observability stack                      | `e2e/runtime.e2e.mjs`: `raion apply` from nothing. A deploy only succeeds when every component is ready, monitored and alerting works.                                                        |
| 4   | See application metrics                                 | `raion verify --service` (metrics check) in the Node.js e2e test                                                                                                                              |
| 5   | See application logs                                    | Same (logs check)                                                                                                                                                                             |
| 6   | See distributed traces                                  | Same (traces check); traces span payment-api → ledger-api                                                                                                                                     |
| 7   | Correlate traces and logs                               | Same (linking check): 99% of log lines carry a trace ID, and those IDs open the trace in Tempo                                                                                                |
| 8   | View generated dashboards                               | `raion verify --dashboards` in the Node.js e2e test: every dashboard loads and every panel that should show data does, queried through Grafana itself                                         |
| 9   | Create an availability SLO                              | `raion slo add … --type availability` in the Node.js e2e test; the UI form calls the same validated code path (server tests)                                                                  |
| 10  | Create a latency SLO                                    | Same, `--type latency`. An unmeasurable threshold is refused, and nothing is written.                                                                                                         |
| 11  | See the error budget                                    | `raion slo list` shows each SLO's SLI and budget left in the e2e test. The SLO dashboard panels have data. promtool tests check the budget math (e.g. −199 for 20% failures against 99.9%).   |
| 12  | Receive an SLO / burn-rate alert                        | The e2e test injects 60% failures; `SLOErrorBudgetBurnFast` fires and is delivered to a webhook receiver, whose URL is a secret                                                               |
| 13  | Inspect the generated configuration                     | `raion render`, the Observability stack page (every file), "Show configuration" on service pages, "Show as OpenSLO"                                                                           |
| 14  | Validate the configuration                              | `raion validate`: schema and cross-references with file and line numbers. `--deep` runs each component's own validator. promtool unit-tests the rules in CI.                                  |
| 15  | Reapply configuration safely                            | The runtime e2e test: re-apply with no changes restarts nothing; a targeted change restarts one component; rollback works (unit tests and a manual run with a broken release)                 |
| 16  | Understand what each component does                     | Purposes shown in `raion status` and the UI. A guide per feature: getting started, deploying, connecting applications, dashboards, alerting, SLOs, security, configuration, validation codes. |
| 17  | Detect when the observability stack itself is unhealthy | Monitoring of the stack itself in `raion status`. The Watchdog proves alerting works. The e2e test stops the collector and `RaionComponentDown` fires.                                        |

## Known gaps

These are known gaps that do not block the items above:

- **Docker Desktop host metrics.** On Windows and macOS, "host" metrics describe Docker's Linux VM, and network metrics are node_exporter's own container interface.
- **Languages.** Node.js, Python and Go have integrations (Phase 8). Java, .NET and PHP send OTLP using the OpenTelemetry SDK and work for logs and traces, but get no automatic HTTP capability (and so no golden signals, service alerts or SLO templates) unless a team adds a [workspace package](../guides/writing-integrations.md).
- **Visual review.** The UI has component tests but no browser-level end-to-end or accessibility tests yet.
