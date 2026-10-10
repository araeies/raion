# Investigating a problem

This page walks through finding the cause of a problem with Raion, from the first alert to the line of code or the struggling dependency. The example: `payment-api` starts failing.

Names such as `payment-api` on this page are examples: use your own. See [names in the examples](README.md#names-in-the-examples).

## 1. The alert

You learn about it from an alert: on the **Alerts** page (and **Home**), and in Slack, email or your webhook if you set them up. On the Alerts page, each alert explains:

- what is wrong and where, for example "Many requests are failing" for payment-api, with the current value ("18% of requests are failing")
- what it means for your users, why it fired, and since when
- **what to do**: the first steps to take
- links to the application's **Grafana dashboard** and its **Raion page**, and its **runbook**, if your team wrote one ([runbooks](09-alerts.md#runbooks))

Notifications carry the summary and the same links.

If you are going to work on it, **Silence…** the alert so it stops notifying others, and say why. Everyone sees who silenced it.

**First, check it is real.** If the Alerts page shows **Alerting is broken**, or several services alert at once, the problem may be the monitoring itself. Check [Is Raion itself healthy?](16-raion-health.md) before anything else.

## 2. The application's page

Open **Applications → payment-api** (or click its name on the alert). On the **Overview** tab:

- **Health**: requests per second, the share failing and the response time of the slowest 1 in 20 requests, over the last 5 minutes. Is it errors, slowness, or both?
- **Over time**: the same as charts over the last hour, 6 hours or 24 hours. When did it start? Did traffic change at the same moment? Point at a chart to read the value at any moment.
- **Alerts**: everything firing for this application, each with what it means and what to do. A slowness alert next to the error alert often means a slow dependency.
- **Connections**: what it calls and what calls it. A problem there shows up here as errors or slowness.

The **Reliability goals** tab shows how much error budget is left and how fast it is burning, which tells you how urgent it is (see [Reliability goals](10-slos.md)).

## 3. The service dashboard

**Open dashboard** at the top of its page. Set the time range to cover the start of the problem.

| Row                         | Ask                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Golden signals**          | When did it start? Which status codes (5xx are the service's failures; 4xx are usually the caller's)? |
| **By route**                | Is it every endpoint or one? Which one is slow?                                                       |
| **Dependencies**            | Are calls to another service failing or slow? Then continue on that service's dashboard.              |
| **Runtime**, **Containers** | Is the service saturated: event loop delayed, memory growing, CPU at its limit, restarts?             |
| **Database rows**           | For a database or cache it uses: connections at the limit, deadlocks, cache misses, memory full?      |

Hover the ⓘ next to a panel title for what it shows and what "bad" looks like.

## 4. The logs

The **Logs** row shows log volume by level, recent errors and warnings, and recent lines. Look for errors that began when the problem began.

At level 2 and above, each log line written during a request carries its trace ID. Expand a log line and click **TraceID** to open the request that wrote it.

For a broader search, **Explore → Loki**: `{service_name="payment-api"} |= "timeout"`.

## 5. The traces

The **Traces** row lists **Failed requests**, **Slow requests** and recent requests. Open one:

- The trace shows every step of the request, across services, with how long each took. The failing or slow span is usually obvious.
- A span in another service means the problem is there. A span for a database query or an HTTP call shows which dependency.
- On a span, **Logs for this span** shows the log lines written while it ran.

The **Raion · Dependencies** dashboard shows the whole service map, with request and error rates between services: useful when the trouble spreads.

## 6. The machine and the stack

If several services are affected at once:

- **Raion · Infrastructure**: CPU, memory, disks and load of the machine.
- **Raion · Containers** (if enabled): which container uses the resources.
- **Raion · Observability stack health**: whether telemetry is being lost, which would make the dashboards misleading.

## 7. Afterwards

- Remove the silence, or let it expire.
- If the alert came too late or too early, tune the service's [alert thresholds](09-alerts.md).
- Write or link a [runbook](09-alerts.md#runbooks) for next time; the Advisor lists paging alerts without one.
- Check the SLO: how much budget did the incident cost? If it is nearly spent, the policy says what the team does next.

## Tips

- **Every signal carries the service name** as `service_name`, so the same name finds metrics, logs and traces in Explore.
- **The application's Overview tab** has **The queries behind these numbers**: the exact queries behind each number, to continue in Explore.
- **Logs not linked to traces?** The service is below level 2, or its logging library is not instrumented; see the service's [integration](integrations/README.md).
