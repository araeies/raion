# Dashboards

Raion generates Grafana dashboards from your workspace and keeps them up to date. You don't build or maintain them. Add a service, connect it, and its dashboard appears.

Open them from the Raion UI: **Observability stack → Dashboards**, **Open the … dashboard in Grafana ↗** on a service's page, or **Grafana ↗** in the top bar, which opens the **Overview**. You are signed in automatically.

## What you get

| Dashboard                              | Shows                                                                                                                                                                         | Appears when                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **Raion · Overview**                   | Requests, error rate and p95 latency of every service, and whether the stack itself is healthy                                                                                | always                                |
| **Service · ‹name›**                   | Everything about one service (see below)                                                                                                                                      | one per service                       |
| **Raion · Dependencies**               | A service map built from traces, plus request and error rates for each caller → callee pair                                                                                   | level 2+ (traces)                     |
| **Raion · Logs**                       | Log volume and errors across services, and recent error logs                                                                                                                  | always                                |
| **Raion · Traces**                     | Recent failed, slow (over 1 s) and ordinary requests across services                                                                                                          | level 2+                              |
| **Raion · Infrastructure**             | Host CPU, memory, disks and load                                                                                                                                              | `infrastructure.host: true` (default) |
| **Raion · Containers**                 | CPU and memory per container                                                                                                                                                  | `infrastructure.containers: true`     |
| **Raion · Observability stack health** | Whether the monitoring itself works: components up, telemetry refused or not delivered, queue usage, stored series, logs and spans, failed rule evaluations and notifications | always                                |

### A service's dashboard

The rows depend on what the service's integrations provide, so a service only shows what it can actually measure:

| Row                      | Needs                                      | Panels                                                                                                               |
| ------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Golden signals           | HTTP request metrics (Node.js, Python, Go) | Requests/s, error rate, p95 latency, instances, traffic by status class, error rate over time, p50/p95/p99 latency   |
| By route                 | HTTP routes                                | Requests and p95 latency per endpoint                                                                                |
| PostgreSQL               | The `postgresql` integration               | Connections against the limit, transactions and rollbacks, cache hit ratio, deadlocks, rows read, size; per database |
| Redis                    | The `redis` integration                    | Clients, commands per second, hit ratio, memory against `maxmemory`, evicted and expired keys, rejected connections  |
| Nginx                    | The `nginx` integration                    | Requests per second, connections by state, dropped connections                                                       |
| Containers               | `infrastructure.containers: true`          | CPU, memory and restarts of the service's containers                                                                 |
| Service level objectives | SLOs evaluated (level 3)                   | Each SLO's SLI, error budget left and burn rate                                                                      |
| Dependencies             | Outgoing HTTP metrics, traces              | Calls to each destination, their errors and latency, and who calls this service                                      |
| Runtime                  | Node.js                                    | Event-loop delay and utilization, heap memory: signs of saturation                                                   |
| Logs                     | Logs on, or container logs                 | Volume by level, errors and warnings, recent lines (with links to traces)                                            |
| Traces                   | Traces on                                  | Slow requests (over 500 ms), failed requests, recent requests                                                        |

Every panel has a description: hover the ⓘ icon to read what it shows and what "bad" looks like.

## Checking that dashboards work

```sh
raion verify --dashboards
```

This asks Grafana to run every panel's queries through the same datasources the dashboards use. It then reports:

- dashboards Grafana did not load
- panels whose query failed
- panels that should show data but are empty

Some panels are allowed to be empty, for example _Failed requests_ when nothing failed. The report counts those separately. The check uses a read-only Grafana account called `raion-system`.

If panels are empty right after you connect a service, wait a few minutes: rates need several samples.

## Changing dashboards

Generated dashboards are read-only in Grafana. Change them by changing the workspace, then run `raion apply`:

| You want                                               | Change                             |
| ------------------------------------------------------ | ---------------------------------- |
| A service's description, team or tier in its dashboard | the service file                   |
| Trace, dependency and log rows                         | the service's `level` or `signals` |
| The Containers dashboard                               | `infrastructure.containers: true`  |

Dashboard-only changes are picked up by Grafana within about 10 seconds, without a restart. The plan shows these as `~ refresh grafana`.

To build your own dashboards, create them in Grafana in a folder other than **Raion**. Saved dashboards are kept in Grafana's storage and are not touched by Raion. To export a generated dashboard as a starting point, use `raion render --out <dir>`. The JSON files are in `grafana/provisioning/dashboards/raion/`.

## Under the hood

- Dashboards are standard Grafana JSON, provisioned from files into the **Raion** folder with fixed UIDs (`raion-overview`, `raion-svc-<service>` and so on). Links and bookmarks keep working across applies.
- Queries come from the metric names, labels and buckets that each integration declares, so every integration that provides HTTP metrics gets the same golden-signal panels.
- The dependency view uses the OpenTelemetry Collector's `servicegraph` connector. It turns traces into `traces_service_graph_*` metrics, which Grafana's service map reads.
- Calls an application makes to the collector itself (exporting telemetry) are filtered out of dependency panels.

## Troubleshooting

| Symptom                                           | Cause and fix                                                                                                                     |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| A service dashboard has no Golden signals row     | No integration of the service provides HTTP metrics. Check `language`, or see [Connecting a service](05-connecting-a-service.md). |
| Panels show "No data" right after connecting      | Rates need several minutes of data. Run `raion verify --service <name>` to check telemetry is arriving.                           |
| _Service map_ is empty                            | Needs traces at level 2+, and calls between traced services. `raion verify --dashboards` checks the underlying metrics.           |
| _Fullest disk_ is higher than you expect          | It shows the fullest real filesystem. On Docker Desktop that is Docker's virtual disk.                                            |
| `raion verify --dashboards` reports a query error | That is a Raion bug. Please [report it](../CONTRIBUTING.md) with the output.                                                      |
