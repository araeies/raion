# Integrations

An **integration** connects one technology to Raion: a language, a database or a proxy. Raion knows what each integration provides, so it generates the matching dashboards, alerts and SLO options for every service that uses it.

| Integration  | For              | How the telemetry arrives                                | Code changes                                   |
| ------------ | ---------------- | -------------------------------------------------------- | ---------------------------------------------- |
| `nodejs`     | Node.js services | The app sends it (OpenTelemetry, zero-code)              | None                                           |
| `python`     | Python services  | The app sends it (OpenTelemetry, zero-code)              | None; start through `opentelemetry-instrument` |
| `go`         | Go services      | The app sends it (OpenTelemetry SDK)                     | A setup file and a wrapped HTTP handler        |
| `postgresql` | PostgreSQL       | The collector reads it, with a read-only monitoring user | None                                           |
| `redis`      | Redis            | The collector reads it (`INFO`)                          | None                                           |
| `nginx`      | Nginx            | The collector reads `stub_status`                        | Enable `stub_status`                           |

On top of that, for any service running in Docker Compose:

- **Container metrics:** CPU, memory and restarts per service, with `infrastructure.containers: true`.
- **Container logs:** what a container writes to stdout and stderr, with `containerLogs: true` on the service. Useful for Nginx, PostgreSQL, or any service that does not send logs itself.

Language integrations are chosen from a service's `language`. Database and proxy integrations are listed explicitly, because they need an address:

```yaml
# services/orders-db.yaml
apiVersion: raion/v1alpha1
kind: Service
metadata:
  name: orders-db
spec:
  type: database
  tier: critical
  integrations:
    - name: postgresql
      params:
        endpoint: orders-db:5432
        password: ${secret:ORDERS_DB_MONITOR_PASSWORD}
```

`raion connect` prints the steps for each service and writes the Compose override. `raion verify --service <name>` checks that its telemetry arrives. `raion integrations list` shows what is available, including your own packages.

A complete example with Python, Go, PostgreSQL, Redis and Nginx is in [examples/polyglot](../../examples/polyglot). The end-to-end test runs it on every change.

## Python

Zero-code [OpenTelemetry for Python](https://opentelemetry.io/docs/zero-code/python/). Flask, Django, FastAPI, requests, psycopg, SQLAlchemy, Redis and many more are instrumented by `opentelemetry-instrument` when the process starts.

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

## Go

Go compiles to machine code, so there is no zero-code option without elevated privileges. The setup is a single file plus two lines in `main`:

1. Add the modules:

   ```sh
   go get go.opentelemetry.io/contrib/exporters/autoexport \
          go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp \
          go.opentelemetry.io/contrib/bridges/otelslog \
          go.opentelemetry.io/otel/sdk go.opentelemetry.io/otel/sdk/metric go.opentelemetry.io/otel/sdk/log
   ```

2. Copy [`otel.go`](../../examples/polyglot/pricing-api/otel.go) from the example into your service. It creates the tracer, meter and logger providers. `autoexport` picks the exporters from the environment variables Raion sets, so the same binary runs with or without observability.
3. In `main`:

   ```go
   shutdown, err := setupOTel(ctx)                      // at startup
   defer shutdown(context.Background())

   handler := otelhttp.NewHandler(mux, "my-service")      // wrap your http.ServeMux
   logger := otelslog.NewLogger("my-service")            // log with the request's context:
   logger.InfoContext(r.Context(), "priced product", "product", id)
   ```

Routes come from `http.ServeMux` patterns (`GET /prices/{id}` is recorded as `/prices/{id}`), so metrics stay grouped by route rather than by URL. Use `otelhttp.NewTransport` for outgoing calls, and the instrumentation of your database and cache clients (for example `redisotel`) to see them in traces.

## PostgreSQL

The collector connects with a monitoring user and reads PostgreSQL's statistics views. That user can read statistics, but no data.

1. Create the user:

   ```sql
   CREATE USER raion_monitor WITH PASSWORD '…';
   GRANT pg_monitor TO raion_monitor;
   ```

2. Store the password: `raion secrets set ORDERS_DB_MONITOR_PASSWORD`.
3. Add the integration to the service (see above) and run `raion apply`.

| Parameter      | Default         | Meaning                                                                   |
| -------------- | --------------- | ------------------------------------------------------------------------- |
| `endpoint`     | required        | `host:port` as the collector reaches it                                   |
| `username`     | `raion_monitor` | The monitoring user                                                       |
| `password`     | required        | `${secret:NAME}` or `${env:NAME}`; a value written in the file is refused |
| `tls`          | `false`         | Connect with TLS and verify the certificate                               |
| `tableMetrics` | `false`         | Also per-table and per-index metrics (their number grows with the schema) |

**You get:**

- **Dashboard:** connections against `max_connections`, transactions and rollbacks, cache hit ratio, deadlocks, rows read and size, each per database.
- **Alerts:**
  - `ServiceUnreachable`: the collector cannot read the database. Critical for a critical-tier service.
  - `PostgresConnectionsNearLimit`: over 85% of connections in use for 10 minutes.
  - `PostgresDeadlocks`.

The password is mounted into the collector as a file and referenced as `${file:…}`; it never appears in generated configuration.

## Redis

| Parameter  | Default  | Meaning                                     |
| ---------- | -------- | ------------------------------------------- |
| `endpoint` | required | `host:port`                                 |
| `username` | –        | ACL user, if Redis uses ACLs                |
| `password` | –        | `${secret:NAME}`, if Redis needs one        |
| `tls`      | `false`  | Connect with TLS and verify the certificate |

With ACLs, a user that may run `INFO` is enough: `ACL SETUSER raion_monitor on >… +info +ping`.

**You get:**

- **Dashboard:** clients, commands per second, hit ratio, memory against `maxmemory`, evicted and expired keys, rejected connections.
- **Alerts:** `ServiceUnreachable`, `RedisMemoryNearLimit` (over 90% of `maxmemory`) and `RedisRejectingConnections`.

## Nginx

Enable `stub_status` on a location that only the observability network can reach. The example uses a second, unpublished port:

```nginx
server {
  listen 8081;
  location = /nginx_status { stub_status; }
}
```

Then set `endpoint: http://edge:8081/nginx_status`.

**You get:**

- **Dashboard:** requests per second, connections by state, and dropped connections.
- **Alerts:** `ServiceUnreachable` and `NginxDroppingConnections`.

`stub_status` has no status codes. Add `containerLogs: true` to keep Nginx's access and error logs in Loki, and look at the upstream services for errors.

## Docker containers

### Container metrics

Set `infrastructure.containers: true` in `raion.yaml`. Raion runs cAdvisor, which needs a privileged container, so `raion apply` asks for `--allow-privileged`.

**You get:**

- **Per service:** the dashboard of every service with `runtime: compose` shows its containers' CPU, memory and restarts, matched by Compose service name.
- **Containers dashboard:** **Raion · Containers** shows all containers.

### Container logs

For services that do not send logs themselves, add `containerLogs: true`:

```yaml
spec:
  type: web
  containerLogs: true
```

How it works:

- `raion connect` sets the container's Docker logging driver to `fluentd`, pointing at the collector on `127.0.0.1:24224` (`target.compose.fluentForwardPort`).
- **No privileged access.** Nothing reads Docker's files, and no component gets the Docker socket.
- **Never blocks the container.** The driver runs in asynchronous mode, so a stopped collector does not block or fail the container.
- **`docker logs` keeps working.** Docker keeps a local copy.
- **Only expected services.** The collector accepts lines only from services that have `containerLogs`.

Use it for services without an OpenTelemetry integration. A service that already sends its logs over OTLP would store each line twice (`RAI-W108`); container output never carries trace IDs, so those logs cannot be linked to traces.

## Your own integration packages

A team can add integrations of its own (for example, for a language Raion does not cover yet) as packages in the workspace. See [Writing integrations](writing-integrations.md).

## Troubleshooting

| Symptom                                                        | What to check                                                                                                                                                                                                              |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify --service` says the collector fails to read a database | Is the database on the observability network (started with the override)? Is `endpoint` right? Is the password in the secret store correct? The collector's log names the error: `docker logs <project>-otel-collector-1`. |
| A database on the host cannot be reached                       | Use `host.docker.internal:<port>` as the endpoint and `runtime: { type: host }`; Raion then lets the collector resolve that name, on Linux too.                                                                            |
| No container logs                                              | The container must be started with the override from `raion connect`, which sets the logging driver. `docker inspect <container>` shows `"Type": "fluentd"`.                                                               |
| Python service sends traces but no logs                        | The `logging` level filters them; set `level=logging.INFO` or lower.                                                                                                                                                       |
| Go service has metrics but `http_route` is empty               | Register routes on an `http.ServeMux` with patterns, and wrap the mux (not each handler) with `otelhttp.NewHandler`.                                                                                                       |
