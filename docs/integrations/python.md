# Python

Zero-code [OpenTelemetry for Python](https://opentelemetry.io/docs/zero-code/python/). Flask, Django, FastAPI, requests, psycopg, SQLAlchemy, Redis and many more are instrumented by `opentelemetry-instrument` when the process starts.

## Without rebuilding your image

For applications in Docker Compose, Raion can add OpenTelemetry when the container starts: you install nothing and keep your start command. **Add an application** in the web UI does this for you when you choose Docker Compose and Python. In a workspace file:

```yaml
integrations:
  - name: python
    params:
      injectAgent: true
      alpine: false # true when the image is based on Alpine Linux
```

A small helper container copies the agent from Raion's pinned OpenTelemetry image into a shared, read-only volume, and Python loads it through `PYTHONPATH`. The helper has no network access and no privileges. Then restart the application with Raion's settings: **Connect it for me** on its **Connect** tab, or `raion connect --restart <name>`. Works with Python 3.9 and newer; set `alpine: true` for images based on Alpine Linux, which need a different build of the agent.

## Installing the packages yourself

1. Add the packages, plus the instrumentation for the libraries you use:

   ```sh
   pip install opentelemetry-distro opentelemetry-exporter-otlp
   opentelemetry-bootstrap -a requirements   # prints e.g. opentelemetry-instrumentation-flask
   ```

   Pin the versions you test with. The example pins them in `requirements.txt`.

2. Start the application through `opentelemetry-instrument`:

   ```dockerfile
   CMD ["opentelemetry-instrument", "python", "app.py"]
   ```

3. `raion connect` sets the environment variables, including the stable HTTP metric names (`OTEL_SEMCONV_STABILITY_OPT_IN=http`) and log export with trace context (`OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED=true`).

**Logs.** Records of the standard `logging` module are sent with the trace and span of the request. Configure a level that lets them through, for example `logging.basicConfig(level=logging.INFO)`.

**Pre-forking servers.** gunicorn and uWSGI fork worker processes after the SDK starts, and the SDK's background exporters do not survive the fork. Use a threaded server such as waitress, as the example does, or initialize OpenTelemetry in a `post_fork` hook (see the OpenTelemetry Python documentation).

## Connecting the service

1. Describe the service with `language: python` (the integration is chosen automatically).
2. Run `raion connect observability --out observability.override.yaml` and start the service with the override (Compose), or with the variables from `raion connect observability --service <name> --format shell` (a process on this machine).
3. Check it: `raion verify observability --service <name>`. Metrics, logs, traces (level 2 and above) and the link between logs and traces should all be ✓.

The [Python, Go, PostgreSQL, Redis and Nginx example](../../examples/polyglot) runs a Python service you can copy from.

## Troubleshooting

| Symptom                                           | What to check                                                                                                                                                               |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Traces arrive but no logs                         | The `logging` level filters them; set `logging.basicConfig(level=logging.INFO)` or lower.                                                                                   |
| No metrics or traces at all                       | The application was not started through `opentelemetry-instrument`, or the instrumentation for your framework is not installed (`opentelemetry-bootstrap -a requirements`). |
| Metrics stop after a while with gunicorn or uWSGI | The workers were forked after the SDK started; see pre-forking servers above.                                                                                               |
