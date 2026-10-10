# Alerts and notifications

Raion watches your applications, the machine and its own monitoring tools. It tells you when something needs attention: on the **Alerts** page always, and by Slack, email or webhook if you set them up.

Names such as `payment-api`, `payments` and `ops-email` on this page are examples: use your own. See [names in the examples](README.md#names-in-the-examples).

## One place, in plain words

Every alert is on the **Alerts** page, explained so that anyone on the team can act on it:

| Shown                   | Example                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| **What** is wrong       | Many requests are failing                                                                                  |
| **Which application**   | payment-api                                                                                                |
| **What it means**       | People using payment-api are getting errors instead of an answer                                           |
| **Why it fired**        | More than 5% of requests have failed for 5 minutes in a row                                                |
| **Since when**          | 10 Oct, 13:38 (23 minutes ago)                                                                             |
| **Where it comes from** | One of the checks Raion runs for payment-api                                                               |
| **What to do**          | 1. Open payment-api in Raion… 2. Open its dashboard… 3. If something changed recently, consider undoing it |

**Technical details** under each alert shows the exact rule (its PromQL expression) and its labels, for those who want to dig further.

The page has four tabs:

- **Firing now:** active alerts, most urgent first.
- **About to fire:** problems Raion has noticed that become alerts if they last long enough (most rules wait 5 or 10 minutes, so that a short blip does not wake anyone up).
- **History:** alerts that stopped, kept for 30 days. Alerts that started and stopped while the web UI was not running are filled in from Prometheus when it starts again, so nothing is missed.
- **What Raion watches:** every check Raion runs, with the same explanations.

The **Needs attention** list on **Home** and each application's **Overview** show the same alerts.

**Grafana's own alerting is turned off.** Raion's alerts are evaluated by Prometheus and delivered by Alertmanager; showing a second, separate set of alerts in Grafana only caused confusion. Grafana remains the place for dashboards and exploring data.

## What is watched

You do not write alert rules. Raion generates them from your applications and settings, with sensible defaults you can change on each application's **Settings** tab.

### Each application with HTTP metrics (Node.js, Python, Java, Go)

| Alert                     | Fires when                                                                  | Severity                                                  |
| ------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------- |
| `ServiceHighErrorRate`    | More than 5% of requests fail with HTTP 5xx for 5 minutes                   | critical for `tier: critical` services, otherwise warning |
| `ServiceHighLatency`      | 95% of requests take longer than 1 s, for 5 minutes                         | warning                                                   |
| `ServiceTelemetryMissing` | The service was sending data in the last 6 hours and stopped for 15 minutes | as for errors                                             |

To avoid alerts caused by a single failed request, error and latency alerts are quiet while a service gets fewer than about 3 requests per minute.

### Applications watched from outside

For applications that run elsewhere, watched by [outside checks](05-connecting-a-service.md#applications-that-run-elsewhere):

| Alert                    | Fires when                                                                                             | Severity                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `EndpointDown`           | Every check of its address failed for 2 minutes: no answer, an error status, or an invalid certificate | critical for `tier: critical`, otherwise warning |
| `EndpointSlow`           | Answers took longer than its response-time threshold (`alerts.latencyP95Ms`) on average over 5 minutes | warning                                          |
| `CertificateExpiresSoon` | Its HTTPS certificate expires within 14 days                                                           | warning                                          |

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

Tune them per application on its **Settings** tab (**When to alert**), or in its file:

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

Raion runs a **self-test alert** (`Watchdog`) that fires all the time, on purpose, and checks that it reaches Alertmanager. You see it at the top of the **Alerts** page as "Alerting self-test", never as a problem, and it never notifies anyone.

If the self-test stops arriving, alerts are not being evaluated or delivered, and Raion says so:

- the **Alerts** page shows a red **Alerting is broken** banner, saying what to check
- `raion status` and `raion alerts` print **Alerting: ✗ …**
- the **Raion · Alerts** dashboard shows the _Alerting pipeline_ tile in red

## Where alerts go

**Every alert is on the Alerts page**, whoever else is notified.

To also be notified, an admin adds a channel in **Settings → Notifications → Add a notification channel** (Slack, email or webhook) and chooses which channel gets the alerts no team claims. Each team's alerts can go to its own channel in **Settings → Teams**. Credentials (webhook addresses, passwords, tokens) are entered there and stored as secrets, never written into files. Then deploy from **Observability stack**.

The same in the workspace file, for those who prefer it:

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

- With **no receivers**, alerts are only on the Alerts page.
- **`defaultReceiver`** gets every alert that no team route claims.
- **Team routes** send a team's service alerts to the team's receiver. They are part of level 3 (`ownershipRouting`). Below level 3 they are ignored and `raion validate` warns (`RAI-W107`).

### Secrets

Webhook URLs, tokens and passwords are secrets. Configuration only references them:

- `${secret:NAME}` is stored by Raion:

  ```sh
  raion secrets set PAYMENTS_SLACK_WEBHOOK      # prompts; the value is hidden
  raion secrets list                            # what is needed and whether it is set (never values)
  ```

  Admins can also set them in **Observability stack → Secrets**, which also lists secrets no longer used, to delete.

- `${env:NAME}` is read from the environment of the process running `raion apply`.

Secrets reach Alertmanager as files. They never appear in generated configuration, logs or the API. `raion apply` refuses to deploy while a needed secret is missing. Changing a secret's value and applying restarts only Alertmanager.

## Silencing

When you are already working on a problem, silence its alert so it stops notifying people.

- **In the UI:** on the Alerts page (or the application's page), click **Silence…**, choose how long, and say why.
- **From the command line:** `raion alerts silence ServiceHighErrorRate --service payment-api --for 2h --reason "deploying a fix"`.
- **Who can:** editors and admins.
- **What it covers:** the alert for that application. It stays visible on the Alerts page marked _silenced_, and is recorded in the audit log.

End a silence early from the Alerts page, or with `raion alerts silences` and `raion alerts unsilence <id>`.

## Command line

```sh
raion alerts               # what is firing or about to, explained, and whether alerting works
raion alerts --format json # the same, for scripts
raion alerts silences      # active silences
```

## Runbooks

Link an alert to your own instructions:

```yaml
spec:
  runbooks:
    - alert: ServiceHighErrorRate
      url: https://wiki.example.com/payments/errors
```

The link appears in notifications and on the Alerts page. Every service alert also links to the service's Grafana dashboard and its Raion page.

## Under the hood

- Rules are standard Prometheus alerting rules. Find them in `raion render` output under `prometheus/rules/`, or in **Observability stack → Advanced**. The plain-language explanations are kept by Raion, not in the rule files.
- They are checked by Prometheus' own `promtool` before every deploy.
- Routing, grouping (by alert and service), repeat intervals (4 h) and inhibition (critical hides warning, and a collector outage hides "service stopped sending telemetry") are standard Alertmanager configuration.
- The Raion server reads alerts from Alertmanager's API, and pending alerts and history from Prometheus, through the gateway. The stack never connects to Raion.
- Grafana runs with its unified alerting turned off (`GF_UNIFIED_ALERTING_ENABLED=false`).

## Troubleshooting

| Symptom                                 | What to do                                                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Alerting is broken**                  | `raion status` shows which component is down. Usually Prometheus or Alertmanager is restarting.                                                               |
| `RaionNotificationsFailing` fires       | Check the receiver in `raion.yaml` and its secret (`raion secrets list`). Slack webhooks expire when the Slack app is removed.                                |
| An alert fires but nobody was notified  | Is a channel set up in **Settings → Notifications**, and deployed? Is the alert silenced? Team routes apply only at level 3.                                  |
| Deploying says a secret is missing      | Set it in **Observability stack → Secrets** (or `raion secrets set NAME`), or set the environment variable for `${env:NAME}`.                                 |
| Too many alerts for a noisy application | On its **Settings** tab, raise the failure share or response time, or the time it must last (`alerts.errorRatePercent`, `alerts.latencyP95Ms`, `alerts.for`). |
| I expected to see alerts in Grafana     | Grafana's alerting is turned off on purpose: every alert is on Raion's **Alerts** page.                                                                       |
