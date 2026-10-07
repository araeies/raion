# Alerts and notifications

Raion watches your services, the host and the observability stack itself. It tells you when something needs attention: in the **Raion inbox** always, and by Slack, email or webhook if you set them up.

## What is watched

You don't write alert rules. Raion generates them from your workspace.

### Each service with HTTP metrics (Node.js, Python, Go)

| Alert                     | Fires when                                                                  | Severity                                                  |
| ------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------- |
| `ServiceHighErrorRate`    | More than 5% of requests fail with HTTP 5xx for 5 minutes                   | critical for `tier: critical` services, otherwise warning |
| `ServiceHighLatency`      | 95% of requests take longer than 1 s, for 5 minutes                         | warning                                                   |
| `ServiceTelemetryMissing` | The service was sending data in the last 6 hours and stopped for 15 minutes | as for errors                                             |

To avoid alerts caused by a single failed request, error and latency alerts are quiet while a service gets fewer than about 3 requests per minute.

### Databases and proxies (PostgreSQL, Redis, Nginx)

| Alert                          | Fires when                                                                                             | Severity                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `ServiceUnreachable`           | The collector could not read the service for about 5 minutes (down, unreachable, or wrong credentials) | critical for `tier: critical`, otherwise warning |
| `PostgresConnectionsNearLimit` | Over 85% of `max_connections` in use for 10 minutes                                                    | warning                                          |
| `PostgresDeadlocks`            | Deadlocks in the last 10 minutes                                                                       | warning                                          |
| `RedisMemoryNearLimit`         | Over 90% of `maxmemory` used for 10 minutes                                                            | warning                                          |
| `RedisRejectingConnections`    | Connections refused because `maxclients` was reached                                                   | warning                                          |
| `NginxDroppingConnections`     | Connections accepted but not handled (`worker_connections` limit)                                      | warning                                          |

See [Integrations](integrations/README.md).

Tune them per service:

```yaml
spec:
  alerts:
    errorRatePercent: 2 # default 5
    latencyP95Ms: 500 # default 1000
    for: 10m # how long the problem must last, default 5m
    missingTelemetry: true # default true
    enabled: true # false turns this service's alerts off
```

### The host

| Alert                       | Fires when                                                      | Severity |
| --------------------------- | --------------------------------------------------------------- | -------- |
| `HostDiskAlmostFull`        | A real filesystem is over 90% full                              | critical |
| `HostDiskWillFillIn24Hours` | Over 70% full and, at the last 6 hours' rate, full within a day | warning  |
| `HostMemoryPressure`        | Less than 10% of memory is available for 10 minutes             | warning  |
| `HostHighCpu`               | CPU over 90% busy for 15 minutes                                | warning  |

### The observability stack (always on)

| Alert                           | Fires when                                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `RaionComponentDown`            | A component (collector, Prometheus, Loki, Tempo, Grafana, Alertmanager, node_exporter) cannot be reached for 2 minutes |
| `RaionTelemetryNotDelivered`    | The collector cannot deliver data to storage, so data is being lost                                                    |
| `RaionTelemetryRefused`         | The collector refuses data (overloaded or malformed input)                                                             |
| `RaionCollectorQueueNearlyFull` | Storage is not keeping up                                                                                              |
| `RaionRuleEvaluationFailing`    | Prometheus cannot evaluate some rules                                                                                  |
| `RaionNotificationsFailing`     | Slack, email or webhook delivery fails                                                                                 |
| `RaionAlertmanagerUnreachable`  | Prometheus cannot hand alerts to Alertmanager                                                                          |
| `Watchdog`                      | Always. See below.                                                                                                     |

## Is alerting itself working?

The `Watchdog` alert fires all the time on purpose. Raion checks that it reaches Alertmanager. If it doesn't, alerts are not being evaluated or delivered, and Raion says so:

- `raion status` and `raion alerts` print **Alerting: ✗ …**
- the **Alerts** page in Raion shows a red **Alerting is broken** banner
- the **Raion · Alerts** dashboard shows the _Alerting pipeline_ tile in red

The Watchdog never notifies anyone.

## Where alerts go

**Every alert is in the Raion inbox** (the **Alerts** page), whoever else is notified. The inbox keeps 30 days of history.

To also be notified, add receivers and choose who gets what:

```yaml
spec:
  notifications:
    defaultReceiver: ops-email # alerts no team claims
    receivers:
      - name: ops-email
        type: email
        to: [ops@example.com]
        from: raion@example.com
        smarthost: smtp.example.com:587
        username: raion
        password: ${secret:SMTP_PASSWORD}
      - name: payments-slack
        type: slack
        webhookUrl: ${secret:PAYMENTS_SLACK_WEBHOOK}
        channel: payments-alerts
      - name: pager
        type: webhook
        url: ${secret:PAGER_WEBHOOK_URL}
        bearerToken: ${secret:PAGER_TOKEN}
  teams:
    - name: payments
      route: payments-slack # alerts of the team's services (level 3)
```

- With **no receivers**, alerts are only in the inbox.
- **`defaultReceiver`** gets every alert that no team route claims.
- **Team routes** send a team's service alerts to the team's receiver. They are part of level 3 (`ownershipRouting`). Below level 3 they are ignored and `raion validate` warns (`RAI-W107`).

### Secrets

Webhook URLs, tokens and passwords are secrets. Configuration only references them:

- `${secret:NAME}` is stored by Raion:

  ```sh
  raion secrets set PAYMENTS_SLACK_WEBHOOK      # prompts; the value is hidden
  raion secrets list                            # what is needed and whether it is set (never values)
  ```

  Admins can also set them on the **Observability stack** page.

- `${env:NAME}` is read from the environment of the process running `raion apply`.

Secrets reach Alertmanager as files. They never appear in generated configuration, logs or the API. `raion apply` refuses to deploy while a needed secret is missing. Changing a secret's value and applying restarts only Alertmanager.

## Silencing

When you are already working on a problem, silence its alert so it stops notifying people.

- **In the UI:** on the Alerts page (or the service page), click **Silence…**, choose how long, and say why.
- **Who can:** editors and admins.
- **What it covers:** the alert for that service. It stays visible in the inbox marked _silenced_, and is recorded in the audit log.

Remove a silence early from the Alerts page.

## Command line

```sh
raion alerts               # what is firing, and whether alerting works
raion alerts --format json
```

## Runbooks

Link an alert to your own instructions:

```yaml
spec:
  runbooks:
    - alert: ServiceHighErrorRate
      url: https://wiki.example.com/payments/errors
```

The link appears in notifications and the inbox. Every service alert also links to the service's Grafana dashboard and its Raion page.

## Under the hood

- Rules are standard Prometheus alerting rules. Find them in `raion render` output under `prometheus/rules/`, or on the Observability stack page.
- They are checked by Prometheus' own `promtool` before every deploy.
- Routing, grouping (by alert and service), repeat intervals (4 h) and inhibition (critical hides warning, and a collector outage hides "service stopped sending telemetry") are standard Alertmanager configuration.
- The Raion server reads alerts from Alertmanager's API through the gateway. The stack never connects to Raion.

## Troubleshooting

| Symptom                                | What to do                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Alerting is broken**                 | `raion status` shows which component is down. Usually Prometheus or Alertmanager is restarting.                                |
| `RaionNotificationsFailing` fires      | Check the receiver in `raion.yaml` and its secret (`raion secrets list`). Slack webhooks expire when the Slack app is removed. |
| An alert fires but nobody was notified | Is a receiver configured? Is the alert silenced? Team routes apply only at level 3.                                            |
| `raion apply` says a secret is missing | Run `raion secrets set NAME`, or set the environment variable for `${env:NAME}`.                                               |
| Too many alerts for a noisy service    | Raise its `alerts.errorRatePercent` or `alerts.latencyP95Ms`, or increase `alerts.for`.                                        |
