# Phase 5: Alerting decisions

## D1. The inbox reads Alertmanager; receivers are optional

Every alert is stored in the Raion inbox. The server polls Alertmanager's v2 API through the gateway every 30 s and on page load (see Phase 2 decision D10).

- Notification receivers (Slack, email, webhook) are an addition, not a requirement, so a beginner sees alerts with no setup at all.
- Alert history (start, resolution, labels, annotations) is kept in the server's SQLite store for 30 days.
- When Alertmanager is unreachable, open alerts stay open: an outage of the alerting system must not look like "everything resolved".

## D2. A Watchdog proves the pipeline end to end

`Watchdog` (`vector(1)`) always fires. Seeing it in Alertmanager proves three things:

- Prometheus is evaluating rules.
- Prometheus can reach Alertmanager.
- Alertmanager is up.

`raion status`, `raion alerts`, the Alerts page and the Alerts dashboard all report its absence as "alerting is broken".

The Watchdog is routed only to the inbox, with a short repeat interval, so it never notifies anyone. A dead man's switch with an _external_ receiver, which would notice that the whole host is down, is listed as future work.

## D3. Alerts derive from capabilities and tiers

Service alerts exist only where the data does: an `http.server` capability with metrics enabled. They cover errors, p95 latency and telemetry that stopped arriving.

- **Severity follows the service tier.** Error and missing-telemetry alerts are critical for `tier: critical` services and warnings otherwise.
- **Low traffic is ignored.** Error and latency alerts require at least about 3 requests per minute, because below that one failed request is a large percentage.
- **Never-connected services don't alert.** `ServiceTelemetryMissing` fires only for a service that sent data in the last 6 hours and stopped.
- **Thresholds are per service.** `errorRatePercent`, `latencyP95Ms`, `for` and `missingTelemetry` can be overridden, with defaults suited to beginners.

## D4. Alerts about the stack are always on

Platform alerts are generated at every level, independent of `basicAlerts`:

- a component that cannot be scraped
- telemetry refused or not delivered
- a collector queue filling up
- rule evaluation failures
- notification failures
- Prometheus unable to reach Alertmanager

Monitoring that silently breaks is the failure mode Raion exists to prevent.

## D5. Team routing is the level-3 `ownershipRouting` feature

Team routes send a team's service alerts (matched on the `team` label) to the team's receiver, and everything else to `defaultReceiver`. Routing is part of level 3, as the maturity model says.

A route defined at a lower level would silently do nothing, so validation warns (`RAI-W107`) and suggests `defaultReceiver` instead.

## D6. Secrets are files, end to end

- **References:** receiver credentials are `${secret:NAME}` or `${env:NAME}` references, and the schema refuses inline values.
- **Storage:** `raion secrets set` (or the admin-only API) stores a value in `.raion/secrets/` (owner-only directory). `${env:NAME}` is copied there by `raion apply`.
- **Delivery:** each secret is mounted into Alertmanager as a Compose secret and read with Alertmanager's `*_file` options: `api_url_file`, `auth_password_file`, `url_file`, `credentials_file`.
- **Changes:** a SHA-256 fingerprint of the values is stored only in the private release record. A changed value plans `restart alertmanager` without the value or its hash appearing in any generated file. The end-to-end test asserts the receiver URL never appears in the generated Alertmanager config.

## D7. Alert rules are tested with promtool, not only syntax-checked

`promtool check config` (run before every deploy) checks syntax. CI also runs `promtool test rules` on the generated rules with synthetic series (`e2e/rules.e2e.mjs`):

- the error alert fires after its `for` duration, with the right labels and rendered text
- it stays quiet at low traffic and with no errors
- missing telemetry fires only for a service that used to send
- component-down, disk and collector alerts fire as expected
- in-memory filesystems are ignored

The Node.js end-to-end test then proves the whole chain on a real stack:

- the Watchdog arrives
- injected errors fire `ServiceHighErrorRate` with the owning team and critical severity
- the notification reaches a webhook receiver whose URL is a secret
- stopping the collector fires `RaionComponentDown`

## D8. Inhibition keeps alerts about one cause together

- A critical alert hides the warning version of the same alert for the same service.
- When the collector is down, every service would also report "stopped sending telemetry". The cause (`RaionComponentDown` for the collector) suppresses those.
