# Phase 4: Dashboard decisions

## D1. One dashboard per service, built from capabilities

Phase 0 listed separate "service overview", "golden signals" and "RED" dashboards. They overlap almost entirely. A beginner looking at a service needs one page that answers "is it OK, and if not, where do I look?". So each service gets **one** dashboard whose rows come from its capabilities:

- golden signals and routes (`http.server`)
- dependencies (`http.client` and the service graph)
- runtime saturation (`runtime.nodejs`)
- logs and traces (signals and level)

Workspace-wide views are separate: overview, dependencies, logs, traces, infrastructure, containers and stack health.

The SLO, error-budget and alert-health dashboards (Phase 0 numbers 10–12) arrive with Phases 5 and 6, when there is data to put on them.

## D2. Our own typed builder instead of a dashboard SDK

The dashboards use a small subset of Grafana's model: rows, timeseries, stat, bar gauge, table, logs, node graph and text. A ~150-line typed builder (`dashboard-builder.ts`) covers it, with no new dependency, deterministic output and golden-file tests.

We would revisit `@grafana/grafana-foundation-sdk` if we needed the full panel model or the v2 dashboard schema.

## D3. Every panel declares whether it must show data

Each panel carries `raion.expect`:

- `data`: must return data when the service or stack is healthy.
- `optional`: may legitimately be empty, such as error panels, failed calls, or outgoing calls of a service with no declared dependencies.

`raion verify --dashboards` runs every panel through **Grafana's own query API** (`/api/ds/query`) as a read-only `raion-system` user. That tests the query, the datasource wiring and the provisioning together. The CI end-to-end test requires a pass.

The service map is computed in the browser, so its check queries the metrics behind it (`traces_service_graph_request_total`).

The checker caught three real bugs on its first run:

- **Multi-metric rates.** `rate({__name__=~…})` across several counters fails with "same labelset". These panels now sum each counter explicitly, with `or vector(0)` so a counter that doesn't exist yet counts as 0.
- **Service-graph flush interval.** The `servicegraph` connector flushes once a minute by default, too rarely for short rate windows. It now flushes every 15 s.
- **Root filesystem.** Docker Desktop has no `/` mountpoint. The panel now shows the _fullest real filesystem_, which is also the more useful number.

## D4. Dashboard changes refresh without restarting Grafana

Generated artifacts can be marked `live`. Grafana's file provider re-reads the folder every 10 s. When only live files change, the plan action is `refresh` rather than `restart`, so a dashboard update never interrupts Grafana.

## D5. Service graph from the collector, not Tempo's metrics generator

Dependencies come from the Collector's `servicegraph` connector, which is added only when some service has `serviceGraph` and tracing. Its metrics follow the names Grafana's service map expects, so the Tempo datasource's service map works without enabling Tempo 3's metrics generator. That keeps one processing pipeline and avoids enabling Prometheus remote-write ingestion.

## D6. Grafana opens on the overview

`GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH` points to the overview. Grafana serves it under its default-home route, a Grafana detail. The same dashboard is also available at `/grafana/d/raion-overview`.

## D7. Panels that filter telemetry export

Outgoing HTTP metrics include the application's own OTLP exports to `otel-collector`. Dependency panels exclude `server_address="otel-collector"`, so the collector never appears as a dependency.
