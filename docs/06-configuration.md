# Describing your services

You describe what Raion observes in YAML files in a **workspace** folder. This page lists every option. Run `raion validate` after each change: it checks every field, explains mistakes with the file and line, and suggests fixes.

Every document starts with:

```yaml
apiVersion: raion/v1alpha1
kind: Workspace | Service | SLO
metadata:
  name: lowercase-name # letters, digits, hyphens; starts with a letter; max 63 characters
```

Names become labels, file names and dashboard identifiers, which is why they are restricted. Unknown fields are errors, so typos never pass silently.

## Layout

| File                 | Contains                                                                           |
| -------------------- | ---------------------------------------------------------------------------------- |
| `raion.yaml`         | Exactly one `Workspace`. Services can also be listed inline under `spec.services`. |
| `services/**/*.yaml` | `Service` documents (and optionally `SLO` documents)                               |
| `slos/**/*.yaml`     | `SLO` documents                                                                    |

One file may hold several documents separated by `---`. The single-file and split layouts can be mixed. Raion merges them, and duplicates are reported.

## Workspace

```yaml
apiVersion: raion/v1alpha1
kind: Workspace
metadata:
  name: acme
spec:
  level: 3 # 1 basic | 2 production | 3 SRE        (default 1)
  environment: production # one environment per workspace          (default production)
  target:
    type: docker-compose # Raion deploys the stack with Docker Compose
    compose:
      projectName: raion # Docker Compose project name           (default raion)
      gatewayPort: 7601 # loopback port of the Raion gateway    (default 7601)
      otlpGrpcPort: 4317 # where host applications send OTLP     (default 4317)
      otlpHttpPort: 4318 #                                       (default 4318)
      fluentForwardPort: 24224 # loopback port for container logs (default 24224)
  retention: # how long telemetry is kept
    metrics: 15d # raised automatically to cover your longest SLO window
    logs: 7d
    traces: 3d
  server:
    publicUrl: http://127.0.0.1:7600 # the URL people use to open Raion; Grafana is served under /grafana/
  infrastructure:
    host: true # host metrics via node_exporter          (default true)
    containers: false # container metrics via cAdvisor; needs elevated privileges (default false)
  features: # optional: override individual features of the level
    traces: true
  notifications:
    receivers: # where alerts can go besides the built-in Raion inbox
      - name: payments-slack
        type: slack
        webhookUrl: ${secret:PAYMENTS_SLACK_WEBHOOK}
      - name: ops-email
        type: email
        to: [ops@example.com]
        from: raion@example.com
        smarthost: smtp.example.com:587
        username: raion
        password: ${secret:SMTP_PASSWORD}
      - name: incident-tool
        type: webhook
        url: https://hooks.example.com/raion
        bearerToken: ${secret:INCIDENT_TOKEN}
  teams:
    - name: payments
      route: payments-slack # receiver for this team's alerts (level 3; default: the inbox)
  services: [] # optional inline services (same fields as a Service spec, plus name)
  advisor:
    ignore: # findings of `raion advise` the team decided not to act on
      - rule: database-not-monitored
        subject: postgres-main # optional; omit to ignore the rule everywhere
        reason: The DBA team monitors it # required
```

See [The Advisor](12-advisor.md) for the rules and their subjects.

### Secrets

Configuration files are meant for Git, so they never contain secrets. Fields that hold credentials accept only references:

- `${secret:NAME}` is read from Raion's secret store (`.raion/secrets/NAME`, never committed)
- `${env:NAME}` is read from the environment of the process running Raion

An inline value such as a Slack webhook URL is rejected with error `RAI-E004`.

### Levels and features

A level turns on a set of features. To turn one feature on or off without changing the level, use `features` in the workspace or in a service:

| Feature               | On from level | What it does                                                                                   |
| --------------------- | ------------- | ---------------------------------------------------------------------------------------------- |
| `logs`                | 1             | Collect the service's logs                                                                     |
| `basicAlerts`         | 1             | Generate alerts for the service (errors, latency, missing telemetry, unreachable) and the host |
| `traces`              | 2             | Collect distributed traces; logs written during a request then carry its trace ID              |
| `serviceGraph`        | 2             | Build the service map and dependency panels from traces                                        |
| `traceLogCorrelation` | 2             | Expect logs to be linked to traces: the Advisor reports services whose logs are not            |
| `slos`                | 3             | Evaluate SLOs: error budgets, burn-rate alerts, SLO dashboards                                 |
| `ownershipRouting`    | 3             | Send each team's alerts to the team's receiver (`teams[].route`)                               |

Each feature is resolved in this order, with later entries overriding earlier ones:

1. the level preset (the service's `level`, or the workspace level)
2. workspace `features`
3. service `features`

Some things do not depend on features:

- Host metrics: `infrastructure.host`.
- Container metrics: `infrastructure.containers`.
- HTTP metrics and the dashboards built from them: the service's integration.
- Database monitoring: the database's integration.
- Runbook links: added to alerts whenever `runbooks` is set.

The schema also accepts the feature names `hostMetrics`, `httpMetrics`, `basicDashboards`, `goldenSignalDashboards`, `databaseMonitoring` and `runbookLinks`; setting them has no effect.

## Service

```yaml
apiVersion: raion/v1alpha1
kind: Service
metadata:
  name: payment-api
spec:
  type: api # web | api | worker | database | microservice | infrastructure  (required)
  language: nodejs # nodejs | python | go | java | dotnet | php | other
  team: payments # must exist in the workspace when teams are defined
  owner: payments-oncall@example.com
  tier: critical # critical | standard | best-effort  (default standard)
  description: Takes payments
  repository: https://github.com/example/payment-api
  runtime:
    type: compose # compose | host
    composeService: payment-api # name in your compose file (default: the service name)
  level: 3 # optional: override the workspace level for this service
  features: {} # optional: override individual features
  signals: # all default to true
    metrics: true
    logs: true
    traces: true
  integrations: [nodejs] # optional: chosen from `language` when omitted; see below
  containerLogs: false # collect the container's stdout/stderr (Compose only; default false)
  dependencies:
    - service: ledger-api # another service in this workspace
    - external: { name: postgres-main, kind: postgresql }
  slos: [] # see below
  runbooks:
    - slo: availability
      url: https://wiki.example.com/runbooks/payment-api
```

A `critical` service without a `team` or `owner` produces warning `RAI-W102`. Somebody should be woken up when it breaks.

### Integrations

An integration connects a technology to Raion. For example, `nodejs` adds OpenTelemetry to a Node.js service. When `integrations` is omitted, Raion picks the integration for the service's `language`. The explicit form takes parameters:

```yaml
integrations:
  - name: nodejs
    params:
      esmHook: true # also instrument ES modules (default)
```

Databases and proxies take an address and, where needed, a credential, which must be a secret reference:

```yaml
integrations:
  - name: postgresql
    params:
      endpoint: orders-db:5432
      password: ${secret:ORDERS_DB_MONITOR_PASSWORD}
```

See [Integrations](integrations/README.md) for every integration and its parameters. A workspace can also contain its own packages in `integrations/<name>/`, pinned in `integrations.lock.yaml` ([Writing integrations](integrations/writing-integrations.md)).

### Container logs

`containerLogs: true` collects what a Compose container writes to stdout and stderr, for services that do not send logs themselves, such as Nginx or PostgreSQL. `raion connect` sets the container's logging driver; see [Docker containers](integrations/docker.md#container-logs).

### Alerts

Every service with HTTP metrics gets error-rate, latency and missing-telemetry alerts. Tune them per service:

```yaml
alerts:
  errorRatePercent: 5 # default
  latencyP95Ms: 1000 # default
  for: 5m # how long a problem must last before alerting
  missingTelemetry: true
  enabled: true
```

Where alerts go is set under `spec.notifications` (`receivers`, `defaultReceiver`) and `spec.teams[].route`. See [Alerts and notifications](09-alerts.md).

## SLO

An SLO (service level objective) states how reliable a service should be, measured from the user's point of view. It can be written inside a service (`spec.slos`) or as its own document:

```yaml
apiVersion: raion/v1alpha1
kind: SLO
metadata:
  name: latency
spec:
  service: payment-api
  description: Payment requests served in under 500ms
  sli: { type: latency, thresholdMs: 500 }
  target: 99 # percent; 99, 99.9 and "99.9%" are all accepted
  window: 30d # rolling window, whole days from 1d to 90d (default 30d)
```

| SLI type       | Good events                                           | Fields                        |
| -------------- | ----------------------------------------------------- | ----------------------------- |
| `availability` | Requests that did not fail with a server error (5xx)  | none                          |
| `latency`      | Requests faster than the threshold                    | `thresholdMs`                 |
| `throughput`   | 5-minute periods with at least the given request rate | `minRequestsPerSecond`        |
| `custom`       | Your own PromQL                                       | `total`, plus `good` or `bad` |

The **error budget** is `100% - target`. For example, a 99.9% objective over 30 days allows 0.1% of requests to fail, roughly 43 minutes of complete outage.

An optional `policy` says what the team does when the budget is spent; it is shown with the SLO and in its alerts. See [SLOs and error budgets](10-slos.md) for burn-rate alerts, dashboards and OpenSLO.

SLOs are deployed when the `slos` feature is enabled (level 3). Below level 3 they are validated and kept, but you get warning `RAI-W101`.
