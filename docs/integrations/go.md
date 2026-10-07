# Go

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

## Connecting the service

1. Describe the service with `language: go` (the integration is chosen automatically).
2. Run `raion connect observability --out observability.override.yaml` and start the service with the override (Compose), or with the variables from `raion connect observability --service <name> --format shell` (a process on this machine).
3. Check it: `raion verify observability --service <name>`. Metrics, logs, traces (level 2 and above) and the link between logs and traces should all be ✓.

The [Python, Go, PostgreSQL, Redis and Nginx example](../../examples/polyglot) runs a Go service you can copy from.

## Troubleshooting

| Symptom                                  | What to check                                                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Metrics arrive but `http_route` is empty | Register routes on an `http.ServeMux` with patterns, and wrap the mux (not each handler) with `otelhttp.NewHandler`.        |
| Logs are not linked to traces            | Log with the `otelslog` logger and pass the request's context (`logger.InfoContext(r.Context(), …)`).                       |
| Nothing arrives                          | `setupOTel` is not called before the server starts, or the process was not started with the variables from `raion connect`. |
