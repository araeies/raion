# SLOs and error budgets

An **SLO** says how reliable a service must be for the people who use it, for example _"99.9% of payment requests succeed, measured over 30 days"_. Raion turns that sentence into measurements, error budgets, dashboards and alerts. You don't write PromQL.

## The three ideas

| Idea                | Meaning                                                        | Example (99.9% over 30 days)                                      |
| ------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| **SLI** (indicator) | What is measured: the share of good events                     | 99.96% of requests succeeded so far                               |
| **Error budget**    | The failure that is allowed: `100% − objective`                | 0.1% of requests, about 43 minutes of complete outage per 30 days |
| **Burn rate**       | How fast the budget is being spent. 1 means exactly on budget. | At 14×, a month's budget is gone in about 2 days                  |

A team with budget left can ship and experiment. A team whose budget is running out slows down and fixes reliability. That trade-off is the point of SLOs.

## Creating an SLO

**In the UI.** Open **Reliability goals → Set a goal**, or an application's **Reliability goals** tab. Pick what to measure, the objective (Raion recommends one) and the window. Raion writes the goal to a new file in your workspace (`slos/<service>-<name>.yaml`); deploy it from the **Observability stack** page. Each goal can be changed or removed from its card (or `raion slo set` and `raion slo remove`).

**On the command line:**

```sh
raion slo add payment-api                      # asks a few questions
raion slo add payment-api --type availability --target 99.9
raion slo add payment-api --type latency --threshold-ms 500 --target 99 \
  --policy "Freeze feature releases until the budget recovers"
raion apply
```

**In YAML**, inside a service or as its own file:

```yaml
slos:
  - name: availability
    sli: { type: availability }
    target: 99.9 # percent
    window: 30d # rolling; whole days from 1d to 90d
    description: Customers can pay
    policy: Freeze feature releases until the budget recovers.
```

SLOs are evaluated from **level 3**. At lower levels they are validated and kept, and `raion validate` warns that they are not measured yet (`RAI-W101`).

## What you can measure

| Type           | Good events                                                             | Settings                                                                                                                                                                                                           |
| -------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `availability` | Requests that do not fail with a server error (5xx)                     | –                                                                                                                                                                                                                  |
| `latency`      | Requests faster than a threshold                                        | `thresholdMs`: one of the boundaries the service's histogram measures (Node.js: 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500 or 10000). Other values are rejected with a suggestion (`RAI-E022`). |
| `throughput`   | 5-minute periods in which at least _N_ requests per second were handled | `minRequestsPerSecond`. Useful for pipelines that must keep up.                                                                                                                                                    |
| `custom`       | Your own PromQL                                                         | `good` or `bad`, plus `total`. Each must return one series of **events per second** over 5 minutes, e.g. `sum(rate(x[5m]))`.                                                                                       |

Availability, latency and throughput need a service with HTTP metrics, for example `language: nodejs`. Custom SLIs work for anything Prometheus has.

## What Raion generates for each SLO

- **Recording rules:**
  - the SLI and error ratio over the SLO window and over 5 minutes to 3 days
  - the error budget left
  - all traffic-weighted, so a busy hour counts more than a quiet night
- **Burn-rate alerts** (multi-window, multi-burn-rate, from the Google SRE Workbook):

  | Alert                     | Severity         | Fires when (30-day SLO)                                                                                                                                     |
  | ------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `SLOErrorBudgetBurnFast`  | critical (page)  | 2% of the budget burns within an hour (14.4×), or 5% within 6 hours (6×). Both a long and a short window must agree, so it fires quickly and stops quickly. |
  | `SLOErrorBudgetBurnSlow`  | warning (ticket) | 10% burns within a day (3×) or within 3 days (1×)                                                                                                           |
  | `SLOErrorBudgetExhausted` | warning          | The budget for the window is used up                                                                                                                        |

  Factors are rescaled for other windows. For short windows (a few days or less), conditions that would fire while still within budget are left out, so a 1-day SLO only alerts when its budget is exhausted.

- **Dashboards:**
  - **Raion · SLOs:** every SLO's budget at a glance, plus SLI, budget left over time and burn rates
  - an **SLO row** on the service's dashboard
- **The error budget policy** (`policy`), shown with the SLO and included in its alerts.

Alerts go where the service's other alerts go: the inbox, the team's receiver at level 3, or the default receiver. See [Alerting](09-alerts.md).

## Reading the status

`raion slo list` and the **Reliability goals** page show each goal as:

| Status           | Meaning                                                         |
| ---------------- | --------------------------------------------------------------- |
| **healthy**      | At least 25% of the budget left, and not burning fast           |
| **at risk**      | Less than 25% left, or burning at 2× or more over the last hour |
| **budget spent** | The objective is missed over the window                         |
| **no data yet**  | The service has not handled requests since the SLO was deployed |

Right after an SLO is created, the window holds only a few minutes of data, so the status can swing. A handful of slow requests can make a fresh latency SLO look spent. It settles as the window fills up.

## OpenSLO

[OpenSLO](https://openslo.com) is the vendor-neutral SLO format.

```sh
raion slo export --out slos.openslo.yaml       # all SLOs as OpenSLO v1 (validated in CI with the official oslo tool)
raion slo import slos.openslo.yaml -w observability [--service payment-api]
```

What converts in each direction:

- **Export.** Availability, latency and custom SLIs become `ratioMetric`; throughput becomes `thresholdMetric` with time-slice budgeting.
- **Import.** Ratio metrics with Prometheus queries become custom SLIs.
- **Rejected on import, with the reason:** anything Raion cannot evaluate, such as counters, calendar windows, threshold metrics or other sources. If the imported SLOs would make the workspace invalid, nothing is kept.

The UI shows the same export on the **Reliability goals** page, under **The same goals in OpenSLO format**.

## Choosing good SLOs

- **Start small:** one availability SLO for the service your users notice most. 99.9% over 30 days is a common first objective.
- **Be realistic:** pick an objective the service meets today, then tighten it. An SLO that is always red teaches people to ignore it.
- **Be honest about latency:** measure what users wait for. Choose the threshold from the service's p95 or p99 latency on its dashboard.
- **Write the policy down**, even one sentence. It turns a number into a decision.

## Troubleshooting

| Symptom                                             | What to do                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| "not evaluated: SLOs start at level 3"              | Set `level: 3` (or `features: { slos: true }`) and apply                                |
| "no integration provides the HTTP metrics it needs" | Set the service's `language` to one with an integration, or use a custom SLI            |
| `RAI-E022` latency threshold                        | Use one of the suggested bucket boundaries                                              |
| Status shows "no data yet"                          | The service must handle requests. Check `raion verify --service <name>`.                |
| A custom SLI shows nothing                          | Run its queries in Grafana → Explore. Each must return one series in events per second. |
