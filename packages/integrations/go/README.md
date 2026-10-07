# Go (OpenTelemetry SDK)

HTTP metrics, traces and logs linked to traces for Go services.

Go compiles to machine code, so there is no zero-code option without elevated privileges. The setup is one file, copied from the [example](../../../examples/polyglot/pricing-api/otel.go), and a wrapped HTTP handler. Raion configures the SDK through environment variables (`autoexport`), so the same binary runs with or without observability.

| Signal  | What                                                                                      |
| ------- | ----------------------------------------------------------------------------------------- |
| Metrics | Request rate, errors and latency per route, from `otelhttp` (routes from `http.ServeMux`) |
| Traces  | One trace per request, continued across services in any language                          |
| Logs    | `slog` records through the `otelslog` bridge, with the trace and span of the request      |

## Setup

1. `go get` the modules listed by `raion connect`.
2. Copy `otel.go`; call `setupOTel(ctx)` at startup; wrap your `http.ServeMux` with `otelhttp.NewHandler`; log with `otelslog.NewLogger(...)` and the request's context.
3. Run `raion connect` and start the service with the override, then `raion verify --service <name>`.

Details: [integrations guide](../../../docs/integrations/go.md).
