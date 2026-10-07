# Connecting applications

Once the observability stack is running (`raion apply`), applications send it their metrics, logs and traces. Raion tells you exactly what to do for each service, and then checks that it worked.

## The short version

```sh
raion connect --out observability.override.yaml        # instructions + generated override
docker compose -f compose.yaml -f observability.override.yaml up -d
raion verify --service my-api                          # is it really connected?
```

## What `raion connect` does

For each service in your workspace, Raion picks an **integration**. Today that is Node.js, chosen automatically from `language: nodejs`. More languages and technologies come later. Raion then prints:

1. **What to install** in your application, for example the OpenTelemetry packages for Node.js. Raion never installs anything itself.
2. **How to start it**:
   - **Services in Docker Compose** (`runtime: { type: compose }`): Raion writes `observability.override.yaml`. You keep your own `compose.yaml` unchanged and add the override when starting:

     ```sh
     docker compose -f compose.yaml -f observability.override.yaml up -d
     ```

     The override adds OpenTelemetry environment variables and joins your service to the `raion-ingest` network, where it can reach the Raion collector and nothing else.

   - **Programs running directly on the machine** (`runtime: { type: host }`): Raion prints the environment variables to set. `raion connect --service my-api --format shell` prints them as `export` commands, and `--format env` prints them in `.env` format.

Regenerate the override whenever you add services or change their level. `raion connect` refuses to overwrite a file it did not generate.

## Checking a service

`raion verify --service <name>` looks at what actually arrived in the last few minutes:

| Check   | Passes when                                                    |
| ------- | -------------------------------------------------------------- |
| metrics | The service's request metrics are in Prometheus                |
| logs    | The service's logs are in Loki                                 |
| traces  | The service's traces are in Tempo (level 2 and above)          |
| linking | Log lines carry trace IDs, and those IDs open a trace in Tempo |

It also shows the request rate, error rate and 95th-percentile latency for the last 5 minutes. Each check prints the query it used, so you can look further in Grafana.

The same information is on the service's page in the Raion UI, refreshed every 30 seconds.

## Levels and signals

What a service sends follows its level and its `signals`:

|                       | Level 1 | Level 2+ |
| --------------------- | ------- | -------- |
| Metrics               | ✓       | ✓        |
| Logs                  | ✓       | ✓        |
| Traces                | –       | ✓        |
| Logs linked to traces | –       | ✓        |

`signals: { traces: false }` turns a signal off for one service. Raion then sets `OTEL_TRACES_EXPORTER=none`.

## Supported today

| Language / technology                | Integration                                              | Status                                                                                                                                                                                         |
| ------------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js                              | [`nodejs`](../../packages/integrations/nodejs/README.md) | ✅ metrics, traces, logs, log/trace correlation (zero-code)                                                                                                                                    |
| Python                               | [`python`](integrations.md#python)                       | ✅ metrics, traces, logs, log/trace correlation (zero-code, via `opentelemetry-instrument`)                                                                                                    |
| Go                                   | [`go`](integrations.md#go)                               | ✅ metrics, traces, logs, log/trace correlation (OpenTelemetry SDK; one setup file)                                                                                                            |
| PostgreSQL, Redis, Nginx             | [see Integrations](integrations.md)                      | ✅ read by the collector                                                                                                                                                                       |
| Container stdout logs (any language) | `containerLogs: true`                                    | ✅ [Docker containers](integrations.md#container-logs)                                                                                                                                         |
| Java, .NET, PHP                      | –                                                        | Use the OpenTelemetry SDK or agent for your language and send OTLP to `http://otel-collector:4318` (Compose) or `http://127.0.0.1:4318` (host), or [write a package](writing-integrations.md). |

Raion warns when a service's SLOs cannot be evaluated because no integration provides its request metrics (`RAI-W104`).

## Troubleshooting

| Symptom                                                             | What to do                                                                                                                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `network raion-ingest declared as external, but could not be found` | The observability stack is not running. Run `raion apply` first.                                                                                             |
| The service starts but `raion verify --service` finds nothing       | Check that it has handled requests, that its container is on `raion-ingest` (`docker inspect`), and that `OTEL_SERVICE_NAME` matches the Raion service name. |
| A service is missing from the override                              | Its `runtime.type` is `host`, or it has no supported integration. `raion connect` explains which.                                                            |

See the integration's own page (for example [Node.js](../../packages/integrations/nodejs/README.md)) for technology-specific problems.
