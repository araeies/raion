# Connecting a service

Once the observability stack is running, your applications send it their metrics, logs and traces, and the collector reads your databases. Raion tells you exactly what to do for each service, then checks that it worked.

## In short

```sh
raion connect observability --out observability.override.yaml
docker compose -f compose.yaml -f observability.override.yaml up -d
raion verify observability --service payment-api
```

## 1. Describe the service

Each service is a file in `services/` (or an entry in `raion.yaml`). `raion init` created your first one; to add another, create a file such as `services/ledger-api.yaml`:

```yaml
apiVersion: raion/v1alpha1
kind: Service
metadata:
  name: ledger-api
spec:
  type: api # web, api, worker, database, microservice or infrastructure
  language: nodejs # Raion picks the integration from the language
  team: payments
  tier: standard # critical, standard or best-effort
  runtime:
    type: compose # in Docker Compose (or "host": a process on this machine)
    composeService: ledger-api # its name in your compose file, if different
```

Databases and proxies name their integration and how to reach them:

```yaml
spec:
  type: database
  integrations:
    - name: postgresql
      params:
        endpoint: orders-db:5432
        password: ${secret:ORDERS_DB_MONITOR_PASSWORD}
```

Run `raion validate` after each change. [Describing your services](06-configuration.md) lists every option, and [Integrations](integrations/README.md) lists what each technology needs.

## 2. Get the instructions: `raion connect`

```sh
raion connect observability
```

For each service, Raion prints the integration it uses and the steps:

1. **What to install or change** in your application (for example the OpenTelemetry packages), or what to set up in your database (a read-only monitoring user). Raion never installs or changes anything in your application itself.
2. **How to start it**:
   - **Services in Docker Compose:** add `--out observability.override.yaml` and Raion writes a Compose override file. Your own `compose.yaml` stays unchanged; you start with both:

     ```sh
     docker compose -f compose.yaml -f observability.override.yaml up -d
     ```

     The override sets the OpenTelemetry environment variables and puts the service on the stack's `raion-ingest` network, where it can reach the collector. For databases and proxies it only joins the network, so the collector can read them. For services with [container logs](integrations/docker.md#container-logs), it also sets the Docker logging driver.

   - **Processes on this machine** (`runtime: { type: host }`): Raion prints the environment variables to set. `raion connect observability --service my-api --format shell` prints them as `export` commands; `--format env` in `.env` format.

The same steps are on each service's page in the web UI, under **Connect this service**.

Generate the override again whenever you add services or change their level. Raion refuses to overwrite a file it did not write.

## 3. Check it: `raion verify --service`

```sh
raion verify observability --service payment-api
```

Raion looks at what actually arrived in the last few minutes:

| Check       | Passes when                                                                      |
| ----------- | -------------------------------------------------------------------------------- |
| **metrics** | The service's metrics are in Prometheus (for a database: the collector reads it) |
| **logs**    | The service's logs are in Loki                                                   |
| **traces**  | The service's traces are in Tempo (level 2 and above)                            |
| **linking** | Log lines carry trace IDs, and those IDs open a trace                            |

It also shows the request rate, error rate and 95th-percentile latency of the last 5 minutes, and the query behind each check so you can look further in Grafana. The **Health** section of the service's page shows the same, refreshed every 30 seconds.

A service that has not handled any requests yet has no request metrics. Send it some traffic, wait a minute, and check again.

## What each service sends

What is collected follows the service's level and its `signals`:

|                       | Level 1 | Level 2 and 3 |
| --------------------- | ------- | ------------- |
| Metrics               | ✓       | ✓             |
| Logs                  | ✓       | ✓             |
| Traces                | –       | ✓             |
| Logs linked to traces | –       | ✓             |

To turn a signal off for one service, set for example `signals: { traces: false }`.

## A language without an integration

Raion has integrations for Node.js, Python and Go ([all integrations](integrations/README.md)). For another language, instrument the service with the OpenTelemetry SDK for that language and send OTLP to `http://otel-collector:4318` (from Compose) or `http://127.0.0.1:4318` (from this machine), with `OTEL_SERVICE_NAME` set to the service's name in Raion. Logs and traces then work. Request-rate dashboards, service alerts and availability or latency SLOs need an integration; your team can [write one](integrations/writing-integrations.md).

## If something does not work

| Symptom                                                             | What to do                                                                                                                                                  |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `network raion-ingest declared as external, but could not be found` | The observability stack is not running. Run `raion apply` first.                                                                                            |
| `raion verify --service` finds nothing                              | Has the service handled requests? Is its container on `raion-ingest` (`docker inspect <container>`)? Does `OTEL_SERVICE_NAME` match the Raion service name? |
| A service is missing from the override                              | It runs on the host, or it has no integration. `raion connect` says which.                                                                                  |
| The collector cannot read a database                                | See the integration's page, for example [PostgreSQL](integrations/postgresql.md#troubleshooting).                                                           |

More in [Troubleshooting](17-troubleshooting.md).
