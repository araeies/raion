# Node.js (OpenTelemetry)

Connects Node.js services to the observability stack **without changing their code**.

## What you get

| Signal  | What                                                                                                                                                          | Where to look                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Metrics | Request rate, errors and latency for every HTTP route (`http_server_request_duration_seconds`), outgoing HTTP calls, Node.js runtime (event loop, GC, memory) | Prometheus / Grafana, and the service page in Raion |
| Traces  | One trace per request, following calls into your other services and into databases, Redis and HTTP APIs                                                       | Tempo / Grafana                                     |
| Logs    | Everything logged with **pino**, **winston** or **bunyan**, with the `trace_id` and `span_id` of the request that wrote it                                    | Loki / Grafana                                      |

Because log lines carry the trace ID, you can jump from a slow trace to the logs it wrote, and from an error log to the full request.

## How it works

This integration uses OpenTelemetry's [zero-code instrumentation for Node.js](https://opentelemetry.io/docs/zero-code/js/) (`@opentelemetry/auto-instrumentations-node`).

- When your process starts, Node loads the OpenTelemetry SDK, which patches common libraries (http, Express, Fastify, Koa, pg, mysql, Redis, pino and more).
- It sends metrics, traces and logs over OTLP to the Raion collector.
- Raion only sets environment variables. No code or files are added to your application.

| Variable                                                                | Value                                                                                                                       | Why                                                                                                |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `NODE_OPTIONS`                                                          | `--import=…register(@opentelemetry/instrumentation/hook.mjs)… --require=@opentelemetry/auto-instrumentations-node/register` | Loads the SDK before your code. The `--import` part also instruments ES modules (`import` syntax). |
| `OTEL_SERVICE_NAME`                                                     | the service name                                                                                                            | Identifies the service everywhere                                                                  |
| `OTEL_RESOURCE_ATTRIBUTES`                                              | `service.namespace=<workspace>,deployment.environment.name=<environment>`                                                   | Groups and filters services                                                                        |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                                           | `http://otel-collector:4318` (Compose) or `http://127.0.0.1:4318` (host)                                                    | Where telemetry goes                                                                               |
| `OTEL_TRACES_EXPORTER` / `OTEL_METRICS_EXPORTER` / `OTEL_LOGS_EXPORTER` | `otlp`, or `none` when a signal is turned off                                                                               | Matches the service's level and `signals`                                                          |
| `OTEL_SEMCONV_STABILITY_OPT_IN`                                         | `http`                                                                                                                      | Uses the stable HTTP metric names and units (seconds) that dashboards and SLOs expect              |
| `OTEL_METRIC_EXPORT_INTERVAL`                                           | `15000`                                                                                                                     | Sends metrics every 15 s, matching Prometheus' resolution                                          |

Run `raion connect --service <name> --format env` to see the exact values for your service.

## Setup

1. Add the packages to your application and rebuild it:

   ```sh
   npm install @opentelemetry/api @opentelemetry/auto-instrumentations-node
   ```

2. Describe the service in Raion with `language: nodejs`. The integration is chosen automatically.
3. Connect it:
   - **Docker Compose:**

     ```sh
     raion connect --out observability.override.yaml
     docker compose -f compose.yaml -f observability.override.yaml up -d
     ```

   - **Directly on the host:** start the process with the variables from `raion connect --service <name> --format shell`.
4. Check it: `raion verify --service <name>`.

## Parameters

```yaml
integrations:
  - name: nodejs
    params:
      esmHook: true # default
```

| Parameter | Default | Meaning                                                                                                                                                                                                |
| --------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `esmHook` | `true`  | Also instrument ES modules. Needed for `"type": "module"` apps and harmless for CommonJS. Turn it off only if `@opentelemetry/instrumentation` cannot be resolved from your app (see Troubleshooting). |

## Customizing

- **Other settings.** Standard `OTEL_*` variables set in your own compose file take effect too. For example, `OTEL_NODE_DISABLED_INSTRUMENTATIONS=fs,dns` reduces noise. Don't override the variables listed above, or Raion's dashboards and checks may not match.
- **Custom spans and metrics.** Use `@opentelemetry/api` in your code. They are exported automatically.
- **Latency SLOs.** These must use one of the histogram boundaries:
  - 5, 10, 25, 50, 75, 100, 250, 500 and 750 ms
  - 1, 2.5, 5, 7.5 and 10 s

  `raion validate` reports other values.

## Troubleshooting

| Symptom                                                                                               | Cause and fix                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The service does not start: `Cannot find module '@opentelemetry/auto-instrumentations-node/register'` | The packages are not installed in the image. Run the `npm install` above and rebuild.                                                                                                       |
| The service does not start: `Cannot find package '@opentelemetry/instrumentation'`                    | Your package manager does not hoist dependencies (pnpm). Add `@opentelemetry/instrumentation` as a direct dependency, or set `esmHook: false` if the app is CommonJS.                       |
| `raion verify --service` reports no metrics                                                           | The service has not handled any requests since it was connected, or it cannot reach the collector. Check that the container is on the `raion-ingest` network: `docker inspect <container>`. |
| Traces have names like `GET` instead of `GET /payments/:id`                                           | The framework is not instrumented. With ES modules this means the `--import` hook is missing, so keep `esmHook: true`.                                                                      |
| Logs arrive but are not linked to traces                                                              | Only pino, winston and bunyan are linked automatically, and only for logs written while handling a request. `console.log` is not captured.                                                  |
| Your own `NODE_OPTIONS` disappeared                                                                   | The override sets `NODE_OPTIONS`. Combine your flags with Raion's in your compose file.                                                                                                     |

## Underlying projects

- [OpenTelemetry JavaScript](https://github.com/open-telemetry/opentelemetry-js) and [contrib instrumentations](https://github.com/open-telemetry/opentelemetry-js-contrib)
- [OTLP](https://opentelemetry.io/docs/specs/otlp/)
