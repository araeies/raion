# Writing integrations

An integration package teaches Raion about one technology. It is **data only**: a manifest (`integration.yaml`) and its documentation. Raion never runs code from a package.

Names such as `acme` on this page are examples: use your own. See [names in the examples](../README.md#names-in-the-examples).

This page explains how to add an integration to **your workspace** (`integrations/<name>/`, next to `raion.yaml`), for your team's own needs, such as a language Raion does not cover. The integrations included with Raion are chosen and maintained by the Raion maintainer; to suggest one, [open an issue](../../CONTRIBUTING.md).

## What a package can do

| It can                                                                      | It cannot                                                                 |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Set environment variables for the services that use it (instrumentation)    | Read workspace data other than the [placeholders](#placeholders) below    |
| Declare what the service then provides (capabilities: metric names, labels) | Add collector, Prometheus or Grafana configuration of its own             |
| Ask the collector to read a system with one of Raion's receivers            | Use a receiver Raion does not know (`postgresql`, `redis`, `nginx` today) |
| Declare parameters (booleans, `host:port`, URLs, names, secret references)  | Receive secret values (only `${secret:NAME}` references)                  |
| List what users must install or change, with documentation                  | Run commands; Raion only shows them                                       |

> **Review packages like code.** Environment variables such as `NODE_OPTIONS`, `JAVA_TOOL_OPTIONS` or `PYTHONPATH` decide what runs inside the instrumented application. That is how zero-code instrumentation works, and it is also why every package is pinned by checksum (below).

## A minimal package

`integrations/acme-java/integration.yaml`:

```yaml
apiVersion: raion/v1alpha1
kind: Integration
metadata:
  name: acme-java # must match the directory name, and not be a built-in name
  version: 1.0.0
spec:
  kind: application
  displayName: Java (OpenTelemetry agent)
  description: The OpenTelemetry Java agent, as Acme's base image ships it.
  languages: [java] # services with language: java use it unless they list integrations

  requirements:
    - kind: setup
      description: Use the acme/java-base image, which contains the agent in /otel.

  instrumentation:
    env:
      JAVA_TOOL_OPTIONS: -javaagent:/otel/opentelemetry-javaagent.jar
      OTEL_SERVICE_NAME: ${service.name}
      OTEL_RESOURCE_ATTRIBUTES: ${resource.attributes}
      OTEL_EXPORTER_OTLP_ENDPOINT: ${otlp.httpEndpoint}
      OTEL_EXPORTER_OTLP_PROTOCOL: http/protobuf
      OTEL_TRACES_EXPORTER: ${signals.traces}
      OTEL_METRICS_EXPORTER: ${signals.metrics}
      OTEL_LOGS_EXPORTER: ${signals.logs}
      OTEL_METRIC_EXPORT_INTERVAL: '15000'
      OTEL_SEMCONV_STABILITY_OPT_IN: http

  capabilities:
    - id: http.server
      metrics:
        requestDuration:
          name: http_server_request_duration_seconds
          type: histogram
          unit: seconds
          labels:
            { method: http_request_method, status: http_response_status_code, route: http_route }
          buckets: [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10]
    - id: logs.otlp
    - id: traces.otlp

  docs: README.md
```

Then:

```sh
raion integrations lock     # after reviewing the package; commit integrations.lock.yaml with it
raion validate
raion integrations list     # shows it as "workspace"
```

## The manifest

| Field                      | Meaning                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec.kind`                | `application`, `database`, `edge`, `infrastructure`, `cloud` or `platform`                                                                              |
| `spec.languages`           | Services in these languages use the package by default                                                                                                  |
| `spec.parameters`          | `boolean` (with `default`), `string` (with `format`: `hostPort`, `url` or `identifier`; optional `default`, `required`) or `secret` (`required`)        |
| `spec.requirements`        | What the user does once: `packages` (`npm`, `pip` or `go`), `command` (how to start the app), `code` (a code change), `setup` (in the monitored system) |
| `spec.instrumentation.env` | Environment variables, in order. A value may be `cases` chosen by boolean parameters (see the built-in `nodejs` package)                                |
| `spec.collector.receiver`  | For systems the collector reads: `postgresql`, `redis` or `nginx`. Raion builds the receiver's configuration from the parameters.                       |
| `spec.capabilities`        | What the service provides. These drive the generated dashboards, alerts and SLOs.                                                                       |
| `spec.docs`                | The documentation file in the package, shown in the UI                                                                                                  |

### Placeholders

Values may use only these: `${service.name}`, `${service.namespace}`, `${environment}`, `${resource.attributes}`, `${otlp.httpEndpoint}`, `${otlp.grpcEndpoint}`, `${signals.metrics}`, `${signals.logs}`, `${signals.traces}`. Anything else is refused when the package loads.

### Capabilities

| Capability                                          | Unlocks                                                                                                  |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `http.server`                                       | Golden-signal dashboard, error-rate, latency and missing-telemetry alerts, availability and latency SLOs |
| `http.client`                                       | Outgoing-call panels                                                                                     |
| `logs.otlp`, `traces.otlp`                          | Log and trace checks in `raion verify`, log/trace correlation in the advisor                             |
| `runtime.nodejs`                                    | Node.js runtime panels                                                                                   |
| `database.postgresql`, `cache.redis`, `proxy.nginx` | The panels and alerts of those systems                                                                   |

**Be exact.** Metric names, labels and bucket boundaries must be what the instrumentation really emits after Prometheus' OTLP translation: dots become underscores, units become suffixes, and counters end in `_total`. A wrong name produces empty panels and alerts that never fire. Check a running service in Grafana → Explore, then run `raion verify --dashboards`: every panel that should have data must have it. Latency SLO thresholds are validated against `buckets`.

## The lock file

`integrations.lock.yaml` records a SHA-256 checksum of each package's manifest and documentation (line endings normalized, so Windows and Linux checkouts agree). Raion refuses a package that is not in the lock file or has changed since it was locked (`RAI-E026`).

A package therefore changes only in two steps: someone edits it, then someone deliberately re-locks it. Both steps show up in review, and CI's `raion validate` catches an edit that skipped the second.

Package signatures are not supported yet.

## Testing a package

1. `raion validate`: the manifest is checked against the schema and the placeholder rules (`RAI-E025` names the problem and the file).
2. Connect a real service: `raion connect`, then `raion verify --service <name>`.
3. `raion verify --dashboards`: proves the declared metric names are right.
