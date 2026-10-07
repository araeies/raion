# Phase 6: SLO decisions

## D1. Plain Prometheus rules, traffic-weighted, one formula for every window

Each SLO records two series every 30 s: bad events per second and all events per second (5-minute rates). Every window's error ratio is:

```
sum_over_time(bad[W]) / sum_over_time(total[W])
```

This weights each moment by its traffic, unlike averaging ratios, where a quiet night counts as much as a busy day. It also costs the same for 5 minutes as for 30 days, because it reads only the two recorded series.

The same formula serves all four SLI types:

- **availability and latency:** bad = failed or slow requests
- **custom:** the user's good/bad and total queries
- **throughput:** a time-based SLI (`bad = traffic < N ? 1 : 0`, `total = 1` per evaluation), so the ratio is the share of bad 5-minute periods

We considered Sloth (Phase 0 §9.3) and kept our own generator: it is one TypeScript module with golden tests and promtool unit tests, and avoids another binary.

## D2. Multi-window, multi-burn-rate alerts, rescaled per window

- **The conditions** are the SRE Workbook's: page on 14.4× over 1 h with 5 m, or 6× over 6 h with 30 m; ticket on 3× over 1 d with 2 h, or 1× over 3 d with 6 h.
- **Rescaling.** Factors are defined as "share of the budget consumed in the long window" and rescaled for the SLO's window: factor = budget share × window / long window.
- **Dropped conditions.** A condition is dropped when its long window is not shorter than the SLO window, or when its factor would be below 1, meaning it would fire while still within budget. Short-window SLOs (≤ 2 days) therefore only get `SLOErrorBudgetExhausted`.
- **Precision.** Thresholds keep 6 significant digits, so 99.99% objectives stay exact. The first version rounded to 3 decimals, which turned a 0.0005 budget into 0.001; caught in review and covered by a test.

## D3. SLOs are created as new files, never by editing existing ones

The UI and `raion slo add` write a new standalone `kind: SLO` document (`slos/<service>-<name>.yaml`). Before writing, they validate the whole workspace with the new file included, so an SLO that cannot be measured is never written (for example a latency threshold between histogram buckets).

Because existing files are never edited, there are no merge conflicts with Git and no lost edits between users.

## D4. OpenSLO in both directions, honestly

- **Export.** `ratioMetric` for occurrence SLIs, and `thresholdMetric` with Timeslices for throughput. The output is validated in CI with the official `oslo` tool (pinned by digest).
- **Import.** Only what Raion can evaluate: ratio metrics with Prometheus rate queries, rolling day windows, Occurrences budgeting and a single objective. Every rejected construct is reported. If imported SLOs would make the workspace invalid, the written files are removed.
- **Bug caught by the validator.** The end-to-end run showed that `oslo` rejects list-valued labels (`team: [payments]`). Labels are now strings.

## D5. Error budget policies are text, shown where decisions are made

`policy` is free text, for example "freeze feature releases until the budget recovers". It is shown on the SLO and appended to its alerts.

Automated enforcement, such as blocking deploys, belongs to the user's CI and release tooling, not to Raion.

## D6. SLO status is computed from the recording rules

`raion slo list`, the SLOs page and the service pages read four instant queries: SLI, objective, budget left, and 1-hour burn rate. Status is classified as healthy, at risk (< 25% budget or ≥ 2× burn), budget spent or no data.

The burn-rate query is exported from core and unit-tested with promtool. Its first version used an invalid `group_left` form, which Prometheus rejected; the CLI had hidden the error. The end-to-end test caught it, and status errors are now reported.

## D7. Deferred

| Item                                         | Why                                                                                                                                                                        |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Latency thresholds between histogram buckets | Needs custom SDK bucket views or native (exponential) histograms end to end, which affects every dashboard query. Today validation points to the nearest exact thresholds. |
| Calendar-aligned windows (e.g. "per month")  | Rolling windows are simpler and what the alert math assumes                                                                                                                |
| SLO-based release gating                     | Belongs to CI/CD; the status API (`/api/v1/slos`) and `raion slo list --format json` make it possible                                                                      |
