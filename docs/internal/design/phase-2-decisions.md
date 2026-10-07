# Phase 2: Runtime decisions

Decisions made while building the Docker Compose runtime, including the items Phase 0 left open (§7.5, §11.1). Each entry gives the decision, why it was made, and what it costs.

## D1. A single authenticated gateway in front of the stack

**Decision.** The `gateway` container (unprivileged nginx) is the only runtime component reachable from the host, and only on `127.0.0.1:7601`. It is published on loopback alongside the OTLP receiver.

- Every route requires the `X-Raion-Gateway-Token` header. The expected value lives in `.raion/secrets/gateway_auth.conf`, is mounted as a Compose secret, and never appears in generated files.
- The gateway strips the token before forwarding.

**Why.** Prometheus, Loki, Tempo and Alertmanager have no authentication of their own. Raion is multi-user, so "only on localhost" is not enough: other users or processes on a shared host could otherwise query or reconfigure them (for example `POST /-/reload`, or Alertmanager silences). One gate with one secret is the simplest control that is still strong.

**Cost.** Tools that expect direct Prometheus access must go through Raion. Exposing a component directly is an explicit future opt-in, never a default.

## D2. Three networks: backend (internal), ingest, edge

| Network            | Members                                          | Internet access                                           |
| ------------------ | ------------------------------------------------ | --------------------------------------------------------- |
| `backend`          | every component                                  | **none** (`internal: true`)                               |
| `<project>-ingest` | collector, and the user's application containers | yes                                                       |
| `edge`             | gateway, Alertmanager                            | yes (Alertmanager needs it for Slack, email and webhooks) |

**Why.**

- Application containers join the ingest network to send telemetry. On that network they can reach the collector and nothing else, so a compromised application cannot reach Grafana, where it could spoof the single sign-on headers.
- Backends cannot make outbound connections at all.

The ingest network has a fixed, project-scoped name (`raion-ingest` by default), so application Compose files can declare it as `external`.

## D3. Grafana single sign-on via `auth.proxy`

**Decision.**

- The Raion server proxies `/grafana/*` to the gateway, after checking the Raion session. It sets `X-WEBAUTH-USER` and `X-WEBAUTH-ROLE` itself, and drops any identity headers sent by the browser.
- Raion roles map to Grafana org roles: viewer → Viewer, editor → Editor, admin → Admin. The role is re-synchronized on every request.
- Grafana's login form, basic auth, anonymous access and sign-up are disabled. The generated admin password is a break-glass credential in the secret store.

**Why.**

- Users get one account and one URL, and there is no shared Grafana password.
- Grafana trusts the headers only because nothing except the gateway can reach it (D1, D2).

Verified against Grafana 13.2: changing a user's Raion role changes their Grafana role on the next request.

**Cost.** Grafana Live (websockets) is disabled (`GF_LIVE_MAX_CONNECTIONS=0`), because the proxy does not upgrade connections. Dashboards still refresh by polling.

## D4. Applications send telemetry over OTLP; Prometheus ingests OTLP natively

**Decision.** The OpenTelemetry Collector exports:

- metrics to Prometheus' OTLP endpoint (`--web.enable-otlp-receiver`)
- logs to Loki's OTLP endpoint
- traces to Tempo over OTLP gRPC

Prometheus promotes `service.name`, `service.namespace`, `service.version` and `deployment.environment.name` to labels, and allows out-of-order samples within a 30-minute window.

**Why.**

- There is one protocol end to end, with no remote-write glue.
- Mimir accepts the same OTLP endpoint, so moving to Mimir is a `MetricsBackend` change (Phase 0 §1.3).
- Service identity is on every metric, which correlation and SLOs depend on.

Verified end to end by `raion verify` and the CI end-to-end test:

- the metric arrives with `service_name` and `deployment_environment_name` labels
- the log line arrives with `trace_id` and `span_id` as Loki structured metadata
- the trace is retrievable by ID

## D5. Tempo 3 in single-binary mode

**Decision.** Use Tempo 3.1 (`target: all`) with local storage. Retention is set on both `backend_scheduler` and `backend_worker`, because Tempo 3 runs retention as scheduled backend jobs. Tempo 3 removed the old `compactor` block.

**Why.** Tempo 2.10 is still patched, but 3.x is the current line. We confirmed that single-binary mode needs no Kafka and passes `-config.verify`. Starting new installations on the old major would mean a forced migration soon.

**Known noise.** On an idle system, Tempo logs `error calling scheduler ... no jobs found` periodically. It is harmless.

## D6. node_exporter: host PID namespace and a read-only root mount, no mount propagation

**Decision.**

- `pid: host` and `/:/host:ro` with `--path.rootfs=/host`.
- The container stays on the backend network; it does not use host networking.
- No `rslave` mount propagation.

**Why.**

- Docker Desktop rejects `rslave` because its root mount is not shared.
- Host networking would require exposing port 9100 on the host, or on an address Prometheus can reach.

**Known limitation.** Network metrics (`node_network_*`) currently describe the node_exporter container's own interface, not the host's. CPU, memory, disk, filesystem and load are the host's (on Docker Desktop: the Linux VM's). Accurate host network metrics need host networking and are deferred; they are listed in the CHANGELOG.

## D7. Changes are classified, and two kinds need explicit approval

**Decision.** Every apply computes a plan.

- Each component gets an action: `start`, `restart` (a configuration file changed), `recreate` (container settings or image changed), `stop` or `unchanged`.
- **Security-relevant changes** (a component with `requiresApproval`, today only cAdvisor) need `--allow-privileged`, and an admin when applied from the UI.
- **Data-affecting changes** (a component removed, or retention shortened) need `--allow-data-changes`, and an admin when applied from the UI.
- node_exporter's read-only host access is _disclosed_ in every plan but is not gated, because it is part of level 1.

## D8. Releases, a stable runtime directory, and automatic rollback

**Decision.**

- Every apply writes an immutable release (`.raion/releases/<seq>-<hash>/`), then syncs it into the stable runtime directory `.raion/runtime/`, which is what Compose mounts.
- Only components whose files changed are restarted.
- Applying the same configuration twice changes nothing.
- If the new release does not become ready, the previous release is restored and the error reports the rollback.
- With no previous release (a first deployment), containers are left running for inspection and nothing is marked as deployed.

**Why.** Mounting a release directory directly would recreate every container on every apply, because the mount paths change.

## D9. Generated configuration is validated by the components themselves

Before anything is deployed, each file is checked by its own tool, run from the same pinned image with `--network none` and a read-only root:

- `otelcol-contrib validate`
- `promtool check config` (which includes the rule files)
- `amtool check-config`
- `loki -verify-config`
- `tempo -config.verify`
- `nginx -t`
- `docker compose config`

A rejection aborts the apply before any change is made.

## D10. The alert inbox will read Alertmanager's API (Phase 5)

**Decision (changes Phase 0 §10.4).** The Raion inbox will poll Alertmanager's API through the gateway. Alertmanager will not push to the Raion server.

**Why.** The Raion server runs on the host and binds to loopback, so containers cannot reach it, and making it reachable from the container network would weaken D1. Polling keeps every connection flowing from Raion into the stack.

Alertmanager is deployed now with a single `inbox` route and no outbound integrations. Slack, email and webhook receivers are generated in Phase 5.

## D11. Gateway port 7601 by default

7680 was the first choice, but Windows Delivery Optimization uses it intermittently. 7601 sits next to the Raion server's 7600. Every published port is configurable in `raion.yaml`.
