# Python (OpenTelemetry)

Connects Python services to the observability stack **without changing their code**.

| Signal  | What                                                                                    |
| ------- | --------------------------------------------------------------------------------------- |
| Metrics | Request rate, errors and latency per route (`http_server_request_duration_seconds`)     |
| Traces  | One trace per request, into your other services and into databases, Redis and HTTP APIs |
| Logs    | Records of the standard `logging` module, with the trace and span of the request        |

## Setup

1. Add `opentelemetry-distro` and `opentelemetry-exporter-otlp`, plus the instrumentation for your libraries (`opentelemetry-bootstrap -a requirements` lists them). Pin the versions.
2. Start the application through `opentelemetry-instrument`, e.g. `opentelemetry-instrument python app.py`.
3. Run `raion connect` and start the service with the generated override (Compose), or with the printed environment variables.
4. Check it: `raion verify --service <name>`.

With gunicorn or uWSGI (pre-forking), see the [integrations guide](../../../docs/integrations/python.md).
