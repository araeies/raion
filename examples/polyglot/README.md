# Example: a shop in three languages

A small shop that shows Raion's integrations working together:

```
loadgen ──► edge (Nginx) ──► catalog-api (Python) ──► pricing-api (Go) ──► pricing-cache (Redis)
                                    └──► catalog-db (PostgreSQL)
```

| Service         | Integration  | How it is observed                                                                                |
| --------------- | ------------ | ------------------------------------------------------------------------------------------------- |
| `edge`          | `nginx`      | The collector reads `stub_status`; access logs via `containerLogs`                                |
| `catalog-api`   | `python`     | Zero-code: Flask, psycopg, requests and logging, started via `opentelemetry-instrument`           |
| `pricing-api`   | `go`         | OpenTelemetry SDK: [`otel.go`](pricing-api/otel.go), `otelhttp`, `otelslog`, `redisotel`          |
| `catalog-db`    | `postgresql` | The collector reads statistics with a read-only `pg_monitor` user; server log via `containerLogs` |
| `pricing-cache` | `redis`      | The collector reads `INFO`                                                                        |

The workspace is in [`observability/`](observability). Nothing secret is in this directory: the database passwords come from your environment.

## Run it

Needs Docker and the `raion` command (see [Using raion from any folder](../../README.md#using-raion-from-any-folder)). Run these from this folder.

```sh
cd examples/polyglot

# Passwords for the example database (any random values).
export CATALOG_DB_PASSWORD=$(openssl rand -hex 16)
export CATALOG_DB_MONITOR_PASSWORD=$(openssl rand -hex 16)

# The monitoring password goes into Raion's secret store, not into a file.
printf '%s' "$CATALOG_DB_MONITOR_PASSWORD" | raion secrets set CATALOG_DB_MONITOR_PASSWORD -w observability --value-stdin

raion apply observability
raion connect observability --out observability.override.yaml
docker compose -f compose.yaml -f observability.override.yaml up -d --build --wait

raion verify observability --service catalog-api     # metrics, logs, traces, linking
raion verify observability --service catalog-db      # the collector reads PostgreSQL
raion server --workspace observability               # then open http://127.0.0.1:7600
```

On Windows PowerShell, set the variables with `$env:CATALOG_DB_PASSWORD = "<random>"`.

The shop answers on <http://127.0.0.1:8088/products>.

## Things to try

- **Break a database.** `docker compose stop catalog-db`: within about five minutes `ServiceUnreachable` fires (critical: `catalog-db` is a critical-tier service), and `raion verify --service catalog-db` says why.
- **Inject errors.** `docker compose exec catalog-api python -c "import urllib.request as u; u.urlopen(u.Request('http://localhost:5000/admin/faults', data=b'{\"failureRate\": 0.5}', headers={'content-type': 'application/json'}))"`. The catalog's error rate and logs show it, and `ServiceHighErrorRate` fires.
- **Follow a request.** In Grafana → Explore → Tempo, open a trace of `GET /products/<int:product_id>`. It goes through Python, PostgreSQL, Go and Redis, and its logs link back to it.
- **See container metrics.** Set `infrastructure.containers: true` in `observability/raion.yaml` and run `raion apply --allow-privileged`. Each service's dashboard then shows its containers' CPU, memory and restarts.

## Clean up

```sh
docker compose -f compose.yaml -f observability.override.yaml down --volumes
raion destroy observability --delete-data
```
