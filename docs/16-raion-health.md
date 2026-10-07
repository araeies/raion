# Is Raion itself healthy?

Monitoring that silently stops working is worse than none: you believe everything is fine. Raion watches its own stack all the time and tells you when part of it is broken.

## At a glance

- **Web UI:** the **Observability stack** page shows **Healthy** or **Something is wrong** (with what). The **Alerts** page shows whether **alerting works**.
- **Command line:**

  ```sh
  raion status observability
  ```

  This lists every component with its state and readiness. It also shows:

  - whether Prometheus can collect metrics from each one (**monitoring of the stack itself**)
  - whether alerting works
  - whether the running stack still matches what Raion deployed (drift)

  It exits with code 1 when something is unhealthy.

## What Raion checks

| Check                                  | How                                                                                            | Where you see it                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Components running and ready           | Each component's health endpoint, through the gateway                                          | `raion status`, Observability stack → Components         |
| Monitoring of the stack                | Prometheus collects metrics from every component; a component it cannot reach is "down"        | `raion status`, Observability stack                      |
| Alerting works                         | An alert called `Watchdog` fires all the time on purpose; Raion checks it reaches Alertmanager | `raion status`, `raion alerts`, Alerts page banner       |
| Telemetry delivered                    | Collector counters: data refused on arrival, data that could not be stored                     | Alerts, **Raion · Observability stack health** dashboard |
| The configuration is what was deployed | Generated files and containers compared with the deployed release                              | `raion drift`, `raion status`, Observability stack       |
| The pipeline end to end                | A test metric, log line and trace sent through the collector and found in storage              | `raion verify`, **Test the pipeline** button             |

## Alerts about the stack

These are always on and need no configuration:

| Alert                           | Means                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------- |
| `RaionComponentDown`            | A component cannot be reached for 2 minutes; the telemetry it handles may be lost |
| `RaionTelemetryNotDelivered`    | The collector cannot store data in Prometheus, Loki or Tempo: data is being lost  |
| `RaionTelemetryRefused`         | The collector refuses data: applications send too much, or send malformed data    |
| `RaionCollectorQueueNearlyFull` | Storage is not keeping up with the incoming telemetry                             |
| `RaionRuleEvaluationFailing`    | Prometheus cannot evaluate some alert or SLO rules                                |
| `RaionNotificationsFailing`     | Slack, email or webhook notifications cannot be delivered                         |
| `RaionAlertmanagerUnreachable`  | Prometheus cannot hand alerts to Alertmanager                                     |

If alerting itself is broken, these alerts cannot reach you. That is why the always-firing `Watchdog` exists, and why the Alerts page and `raion status` check it directly.

## The stack health dashboard

**Raion · Observability stack health** in Grafana shows:

- components up
- telemetry refused or not delivered
- collector queue usage
- how many metric series, log lines and spans are stored
- failed rule evaluations and notifications

The Advisor also reports [telemetry dropped by the collector and high-cardinality metrics](12-advisor.md).

## When something is wrong

| You see                                 | Do                                                                                                                                                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A component not running or not ready    | `raion status` shows which. `raion apply` starts it again; if it keeps failing, its log has the reason: `docker logs <project>-<component>-1` (the project is `raion` unless you changed it). |
| A scrape target "down"                  | The component is restarting or overloaded. The error column of `raion status` says why.                                                                                                       |
| **Alerting is broken**                  | Usually Prometheus or Alertmanager is restarting; `raion status` shows which.                                                                                                                 |
| Drift                                   | `raion drift` lists the differences; `raion drift --repair` restores the deployed release ([Applying changes](13-applying-changes.md#drift)).                                                 |
| `raion verify` reports a signal missing | The component that stores it is usually not ready; check `raion status`.                                                                                                                      |
| Telemetry refused                       | An application sends bursts or too much data; reduce log volume or sample traces. The **Stack health** dashboard shows which signal.                                                          |

The Raion **web UI** is separate from the stack. If the web UI is down, the stack keeps collecting and alerting; start the server again with `raion server`.
