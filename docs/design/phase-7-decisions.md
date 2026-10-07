# Phase 7: Observability Advisor decisions

## D1. Rules are pure functions over the workspace and a snapshot of live facts

`advise(workspace, files, { facts })` returns findings. It is pure: no network, no clock, no file system. Live data is gathered separately (`collectLiveFacts` in `@raion/deploy`) into a plain `LiveFacts` object, in which each part is optional.

Because rules depend only on their inputs, every rule is tested with fixtures. A failed query becomes a `problems` entry, not a missing report, so one broken backend cannot hide every other finding.

Each finding has:

- what is wrong, why it matters and what to do
- what was observed, and a query to look further
- a stable ID (`<rule>/<subject>`), so the CLI, the API, the UI and `advisor.ignore` all refer to the same finding

## D2. Live checks use cheap, read-only queries over one hour

The collection makes a fixed, small set of queries (eight when every service is Node.js), all through the gateway:

- one per HTTP metric for request rates
- two Loki counts for log correlation
- one service-graph query
- three collector counters
- Prometheus's TSDB status endpoint

Cardinality uses the TSDB status endpoint (top 10 metrics and labels by series), which costs nothing. The alternative, `count by (__name__)` over every series, gets expensive exactly when cardinality is the problem.

One hour smooths out bursts and still reflects the current state.

## D3. Fixes change workspace files only, and go through plan and apply

An autofix is a list of file changes (create or edit), never an action on the running stack.

- **Edits are comment-preserving.** They use the `yaml` document model (chosen in Phase 0 for this reason). A round-trip of every example workspace is byte-identical, so a diff shows only the lines the fix adds. CRLF files stay CRLF.
- **Fixes are validated before they are offered.** A fix is shown only if the whole workspace validates with it applied. Tests apply every offered fix and validate the result. The end-to-end test applies one, plans it (`--detailed-exitcode` reports the change) and deploys it.
- **Fixes are minimal.** Turning on SLOs for one service sets `features.slos` on that service, not `level: 3` on the workspace, because a level also changes alert routing. A new SLO is a new file, as in Phase 6.

## D4. The server recomputes fixes; clients send only an ID

`POST /api/v1/advisor/apply` takes `{ id }`. The server:

1. reloads the workspace and live data
2. recomputes the findings
3. applies its own fix for that ID

A client therefore cannot write arbitrary content, even an editor's browser running modified code. Other safeguards:

- Applies are serialized in the server.
- Every file is compared with the content the fix was computed from, and nothing is written if any file changed (409).
- Paths outside the workspace are refused.
- Each apply is audited.

Viewers can read findings and their diffs but cannot apply them. Configuration contains no secrets (Phase 1), so showing diffs to viewers exposes nothing new.

## D5. Ignoring findings is configuration, not UI state

`spec.advisor.ignore` lives in `raion.yaml`, requires a reason, and its rule names are validated against the rule catalogue. With several people on one workspace, a dismissal stored in one user's browser would hide the decision from everyone else. In Git it is reviewed like any other change.

## D6. Rules that report without fixing are honest about why

`database-not-monitored` says that Raion has no database integrations yet, rather than suggesting a fix it cannot deliver. `unused-dependency` is information only: a rare call path looks exactly like a removed one, so Raion never deletes a declared dependency. Fixes that need knowledge only the team has (runbook URLs, logging libraries, which label is unbounded) are described, not guessed.

## D7. Deferred

| Item                                                            | Why                                                                                                                                       |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Per-workspace thresholds (e.g. series per metric)               | The defaults suit the single-node stack; thresholds are already parameters of `advise()`, so exposing them is a schema change when needed |
| Finding history and trends                                      | Needs storage and a retention policy; findings are cheap to recompute                                                                     |
| Advisor findings as alerts or notifications                     | Findings are review items, not incidents; `--fail-on` covers CI                                                                           |
| Label-level cardinality breakdown (which label of which metric) | Needs per-metric queries that are expensive at exactly the wrong moment; the finding links a query to run when needed                     |
| Fixes for application code (logging libraries, labels)          | Outside the workspace; Raion does not edit application repositories                                                                       |
