# Phase 3: Application integration decisions

## D1. Integrations are data packages behind a small, closed vocabulary

An integration is a folder with `integration.yaml` and a README (`packages/integrations/<name>/`). The manifest is validated by a strict schema, so unknown fields such as a `postInstall` command are rejected. It can declare:

- parameters (booleans)
- requirements, which are **shown**, never run
- environment variables for the instrumented process
- capabilities, with the exact metric names, labels and histogram buckets

Values may use only these placeholders: `service.name`, `service.namespace`, `environment`, `resource.attributes`, `otlp.httpEndpoint`, `otlp.grpcEndpoint`, `signals.*`. Any other placeholder is rejected when the package loads. Substitution happens after YAML parsing, into string values only.

**Why.** Packages can come from the community. A package that cannot execute anything and cannot read anything beyond these variables is safe to load.

**Deferred to Phase 8.**

- Third-party package directories
- `integrations.lock.yaml` with checksums
- signatures

Phase 3 ships only first-party packages, which are inside the Raion release.

## D2. Generators depend on capabilities, not on integrations

Services expose the capabilities of their integrations. Today these are `http.server`, `http.client`, `logs.otlp`, `traces.otlp` and `runtime.nodejs`. Everything downstream reads capabilities:

- the service health numbers (request rate, errors, p95)
- `raion verify --service`
- the latency-SLO bucket check
- dashboards in Phase 4 and SLOs in Phase 6

A future Python or Nginx integration that provides `http.server` gets all of these unchanged.

## D3. Language implies the integration

`language: nodejs` with no `integrations:` list selects the `nodejs` integration (marked `implicit` in the resolved model). Beginners don't need to know integrations exist. Experts can list integrations explicitly with parameters, and Raion warns on a language mismatch (`RAI-W105`).

## D4. Zero-code instrumentation, including ES modules

The Node.js integration uses `@opentelemetry/auto-instrumentations-node` through `NODE_OPTIONS`. We tested this against Express 5 with pino:

- `--require …/register` alone instruments `http` but **not** ES-module imports. Traces were named `POST` with no route, and logs had no trace IDs.
- Adding `--import=data:text/javascript,…register('@opentelemetry/instrumentation/hook.mjs', …)` instruments ES modules too. Routes appear (`POST /payments`), and 99% of log lines carry `trace_id` and `span_id`.
- The `--import` form is used because `--experimental-loader` prints a deprecation warning on Node 24. The data URL has no spaces, so it survives `NODE_OPTIONS` parsing.

This is the `esmHook` parameter (default `true`). Its documented cost: the hook needs `@opentelemetry/instrumentation` to be resolvable from the app. That is automatic with npm and yarn; pnpm users add it directly or turn the hook off.

`OTEL_SEMCONV_STABILITY_OPT_IN=http` selects the stable `http.server.request.duration` metric (seconds, standard buckets). Prometheus stores it as `http_server_request_duration_seconds`, with `http_request_method`, `http_response_status_code` and `http_route` labels. We verified the bucket boundaries against live data, and the latency-SLO validation (`RAI-E022`) uses them.

## D5. Connect without editing the user's files

For Compose services Raion generates `observability.override.yaml`, which the user layers on top of their own compose file.

- The override lists the `default` network explicitly. Compose replaces a service's network list when an override defines one, so without it the service would lose its own network.
- `$` is escaped for Compose interpolation.
- The file carries a marker, and `raion connect` refuses to overwrite a file without it.

## D6. Verification looks at stored data, not configuration

`raion verify --service` and the service page query Prometheus, Loki and Tempo through the gateway. They report:

- whether each signal arrived
- what share of log lines carry trace IDs
- whether those IDs resolve to traces

The linking check samples log lines older than 30 seconds, because applications export spans in batches. Every check shows its query so users can continue in Grafana.

## D7. Container stdout logs move to the Docker integration (Phase 8)

Phase 2 planned stdout log collection "with the application integration". Node.js logs already arrive over OTLP with trace correlation. Collecting stdout for _any_ container needs a privileged-ish reader of `/var/lib/docker/containers` (root with `CAP_DAC_READ_SEARCH`) and container-name enrichment. That is a feature of the Docker integration, where it is designed once for every language.

## D8. Supply chain

- CI publishes a CycloneDX SBOM of Raion's npm dependencies (`pnpm sbom`) on every change to the lockfile.
- A weekly job scans every pinned runtime image with Trivy (itself pinned by digest) and writes a report.
- The scan does not fail the build. Fixes for upstream images come from upstream, and the report informs image upgrades (`scripts/update-images.mjs`). `--fail-critical` exists for teams that want a hard gate.
