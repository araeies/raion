# Metrics, logs and traces

Raion collects three kinds of telemetry, often called signals. This page explains what is collected for each service and where to find it.

| Signal      | Answers                                                | Stored in  | Where to look                                                                      |
| ----------- | ------------------------------------------------------ | ---------- | ---------------------------------------------------------------------------------- |
| **Metrics** | How much, how fast, how often it fails                 | Prometheus | Service page (Health), service dashboard, Grafana → Explore → Prometheus           |
| **Logs**    | What happened, in the application's words              | Loki       | Service dashboard (Logs row), **Raion · Logs** dashboard, Grafana → Explore → Loki |
| **Traces**  | Where a single request spent its time, across services | Tempo      | Service dashboard (Traces row), **Raion · Traces**, Grafana → Explore → Tempo      |

## What is collected

**Applications** (Node.js, Python, Go):

- **Metrics:** for every HTTP route, the request rate, errors and latency (the "golden signals"), plus outgoing HTTP calls. Node.js also reports event-loop and memory metrics.
- **Logs:** what the application logs through its logging library, with the trace and span of the request that wrote it.
- **Traces:** one trace per request, following calls into your other services and into databases, caches and HTTP APIs (level 2 and above).

**Databases and proxies** (PostgreSQL, Redis, Nginx): metrics read by the collector; see each [integration](integrations/README.md). Their own log output can be collected with [container logs](integrations/docker.md#container-logs).

**The machine** (`infrastructure.host: true`, the default): CPU, memory, disks, filesystems and load.

**Containers** (`infrastructure.containers: true`): CPU, memory and restarts for each container, shown on each service's dashboard.

**Raion's own stack:** the health of every component and of the telemetry pipeline; see [Is Raion itself healthy?](16-raion-health.md).

## Logs linked to traces

At level 2 and above, a log line written while handling a request carries that request's **trace ID**. In Grafana, a log line opens its trace in one click, and a trace shows the logs it wrote. This is how you find "everything about this one failing request".

`raion verify --service <name>` and the service page check this link: the share of log lines with a trace ID, and whether those IDs open a trace. The Advisor reports services where most log lines are not linked.

## Turning signals on and off

- **By level:** traces start at level 2 ([levels](01-what-is-raion.md#ideas-you-will-meet)).
- **Per service:** `signals: { metrics: true, logs: true, traces: false }`.
- **Per feature:** `features: { traces: true }` turns traces on for one service at level 1.

After changing these, apply the change and run `raion connect` again: the environment variables of the service change.

## How long telemetry is kept

```yaml
spec:
  retention:
    metrics: 15d
    logs: 7d
    traces: 3d
```

These are the defaults. Metrics retention is raised automatically to cover your longest SLO window, so a 30-day SLO keeps 33 days of metrics; the plan tells you when this happens. Making retention shorter deletes older data, so Raion asks for explicit approval (`--allow-data-changes`, admins in the web UI).

## Querying directly

In Grafana, **Explore** queries each store directly:

- **Prometheus** (PromQL), for example `sum by (http_route) (rate(http_server_request_duration_seconds_count{service_name="payment-api"}[5m]))`
- **Loki** (LogQL), for example `{service_name="payment-api"} |= "error"`
- **Tempo** (TraceQL), for example `{resource.service.name="payment-api" && status=error}`

Every service carries the label `service_name`, so the same name finds its metrics, logs and traces. The queries behind the service page's checks are under **Show the queries**.
