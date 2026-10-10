# Example: a Node.js payments application

Two small Express services:

- **payment-api** takes payments.
- **ledger-api** records them. payment-api calls it for every payment.

A load generator keeps traffic flowing. The code contains **no observability code at all**; Raion connects it to OpenTelemetry from the outside.

```
loadgen ──► payment-api ──► ledger-api
                │               │
                └── OTLP ───────┴──► Raion collector ──► Prometheus · Loki · Tempo ──► Grafana
```

## Try it

You need Docker and the Raion CLI (see the main [README](../../README.md)). In the commands below, `observability` is the **folder** that holds the workspace, not its name (which is `payments-demo`, in `observability/raion.yaml`). From this folder:

```sh
# 1. Deploy the observability stack described in ./observability
raion apply observability

# 2. Generate the Compose override that connects the services
raion connect observability --out observability.override.yaml

# 3. Start the application with the override
docker compose -f compose.yaml -f observability.override.yaml up -d --build

# 4. After a minute, check what each service sends
raion verify observability --service payment-api
raion verify observability --service ledger-api
```

The application's Dockerfile installs `@opentelemetry/api` and `@opentelemetry/auto-instrumentations-node`, which is the step `raion connect` asks you to do for your own applications.

Expected output:

```
  ✓ metrics  receiving HTTP metrics (4.80 requests/s)
  ✓ logs     612 log lines in the last 15 minutes
  ✓ traces   receiving traces
  ✓ linking  99% of log lines carry a trace ID and open the matching trace

Last 5 minutes:
  requests/s 4.80   errors 1.02%   p95 latency 220 ms
```

## Explore

Start the Raion server (`raion server --workspace observability`), sign in, then:

- **Services → payment-api** shows live request rate, errors and latency, and whether metrics, logs and traces arrive.
- **Grafana → Explore → Tempo**: search for `{resource.service.name="payment-api"}`. Each trace shows payment-api calling ledger-api, and **Logs for this span** jumps to the log lines the request wrote.
- **Grafana → Explore → Loki**: run `{service_name="payment-api"}`. Each line has a link to its trace.

## Add SLOs

Switch the workspace to level 3 (`level: 3` in `observability/raion.yaml`), then:

```sh
raion slo add payment-api -w observability --type availability --target 99.9
raion slo add payment-api -w observability --type latency --threshold-ms 1000 --target 97
raion apply observability
raion slo list observability
```

The example deliberately makes about 2% of requests slow, so a strict latency objective (99% under 500 ms) is quickly at risk. That is a good way to see an error budget being spent.

## Break it on purpose

The services inject faults when asked, so you can see errors and latency change:

```sh
# 20% of payment requests fail with HTTP 500
curl -X POST localhost:3000/admin/faults -H 'content-type: application/json' -d '{"failureRate":0.2}'

# 30% of requests take 0.6-1.5 s
curl -X POST localhost:3000/admin/faults -H 'content-type: application/json' -d '{"slowRate":0.3}'

# back to normal
curl -X POST localhost:3000/admin/faults -H 'content-type: application/json' -d '{"failureRate":0.01,"slowRate":0.02}'
```

## Clean up

```sh
docker compose -f compose.yaml -f observability.override.yaml down
raion destroy observability            # add --delete-data to also delete stored telemetry
```
