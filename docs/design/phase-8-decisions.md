# Phase 8: integration decisions

## D1. Databases and proxies are read by the collector, not by extra exporters

PostgreSQL, Redis and Nginx are read by the OpenTelemetry Collector's own receivers. There is one pipeline per monitored service, labelled with the service's name. The alternative, a Prometheus exporter container per database, adds images to pin, scan and harden, and a network path from Prometheus to each database.

The receivers' metric names were read from real instances before any dashboard was written, and the end-to-end test checks every panel against live data. That check caught nothing in the panels. It did catch two alerting mistakes (D5).

## D2. Integration packages stay data; Raion builds receiver configuration

A manifest declares `collector.receiver: postgresql` and its parameters; it never contains collector configuration. Raion builds each receiver's configuration in code, from an allow-list of receivers (`postgresql`, `redis`, `nginx`) and validated parameters.

- **Typed parameters.** They are typed: boolean, `string` with a format (`hostPort`, `url`, `identifier`), or `secret`.
- **No `$` in values.** None of the string formats allows it. The collector expands `${…}` anywhere in its configuration, so a value like `${file:/etc/shadow}` would otherwise read a file.
- **Secrets as references only.** A secret parameter accepts only `${secret:NAME}` or `${env:NAME}`. The collector reads it from a mounted file (`${file:/run/secrets/…}`), as Alertmanager already did for notification secrets.
- **Validation without real secrets.** `raion validate --deep` runs `otelcol validate` with placeholder files at the secret paths.

## D3. PostgreSQL: per-database labels, table metrics opt-in

The receiver reports the database name as a resource attribute, which Prometheus' OTLP endpoint does not keep as a label. Two databases on one server would then collide on a single series. Found in a lab before writing dashboards. Raion now promotes `postgresql.database.name` to a label, and the end-to-end test checks for per-database series.

Per-table and per-index metrics would collide the same way, and their number grows with the schema. They are off unless `tableMetrics: true`.

## D4. Python is zero-code; Go is SDK-based

- **Python.** `opentelemetry-instrument` instruments Flask, Django, FastAPI, psycopg, requests, logging and more. The one change is the start command, which the manifest lists as a requirement of kind `command`.
- **Go.** Go has no zero-code option without eBPF and elevated privileges. The integration is a single setup file (in the example) built on `autoexport`, so Raion's environment variables configure it like the other languages.
- **No assumptions about what the libraries emit.** Both integrations were checked against what they actually send:
  - The histogram buckets each application emits are compared with its manifest in the end-to-end test.
  - Routes are templates (`/products/<int:product_id>`, `/prices/{id}`), not URLs.
  - `otelhttp` v0.72 no longer has `WithRouteTag`; it reads `http.ServeMux` patterns. The integration was written for the current API, not the remembered one.

## D5. "The collector cannot read this service" comes from the collector's own counters

`ServiceUnreachable` fires when `otelcol_scraper_scraped_metric_points` for the service's receiver stops increasing for 2 minutes, held for 3. Two first attempts were wrong, and the end-to-end test caught both:

1. **The errored-points counter stays at 0.** `otelcol_scraper_errored_metric_points` counts nothing when the connection fails, because no points are produced. (The counters also have no `_total` suffix.)
2. **Detection was too slow.** "Metrics that were arriving stopped" works, but fired over 10 minutes after a database went down. The scraped-points counter also catches a database that was never readable, for example because of a wrong password.

`raion verify --service` uses the same signal to say "the collector fails to read …" rather than just "no data".

## D6. Container logs without privileges

Phase 3 deferred stdout logs to this phase. The obvious design, reading `/var/lib/docker/containers`, needs root-level file access. Container names would also need the Docker socket, which is root on the host.

Instead, services with `containerLogs: true` get Docker's `fluentd` logging driver, set in the override written by `raion connect`. The driver sends to the collector's Fluent Forward receiver, published on loopback like the OTLP ports.

- **No container gains a privilege.**
- **Async mode.** A down collector never blocks or fails the application container.
- **`docker logs` keeps working**, because Docker keeps a local copy.
- **Only expected services.** The collector keeps only lines whose tag is a service with `containerLogs`.

This was tried in a lab on Docker Desktop before it was built. The end-to-end test receives Nginx and PostgreSQL logs this way.

## D7. Docker container metrics reuse cAdvisor

Container metrics already existed as an opt-in, privileged cAdvisor (Phase 2). Phase 8 adds CPU, memory and restarts to each Compose service's dashboard, matched by the Compose service label. A second container-metrics source (the collector's Docker stats receiver) would need the Docker socket.

The panels are verified with live data in the end-to-end test, which turns cAdvisor on (`--allow-privileged`).

## D8. Workspace packages, pinned by checksum

Teams can add packages in `integrations/<name>/`. Each must be in `integrations.lock.yaml` with a SHA-256 of its manifest and documentation; line endings are normalized, so Windows and Linux checkouts agree. A new or changed package is refused until someone runs `raion integrations lock`. That makes the change visible in review, and CI fails on a package edited without it.

Packages cannot:

- shadow a built-in integration
- use placeholders other than the documented ones
- name a receiver outside the allow-list

They can set environment variables of the services they instrument, which is code execution in those services by design (zero-code instrumentation works that way). The authoring guide says to review packages like code.

## D9. Deferred

| Item                                                   | Why                                                                                                       |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Signed integration packages                            | Needs key distribution and trust policy; checksums in Git cover the review problem today                  |
| Packages from outside the workspace (registries, URLs) | Fetching code-like content over the network needs signatures first                                        |
| Java, .NET, PHP integrations                           | Each needs an example application and an end-to-end test; workspace packages cover them meanwhile         |
| MySQL, MongoDB, Kafka                                  | Same allow-list approach; each needs its receiver verified against a real instance                        |
| Nginx status codes and latency                         | `stub_status` has neither; access logs (container logs) have both, and structured parsing is a later step |
| Go runtime and Python runtime panels                   | Metric names differ between SDK versions; to be added with the same live check as the HTTP metrics        |
