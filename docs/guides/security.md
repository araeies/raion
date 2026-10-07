# Users, roles and security

Raion can deploy infrastructure, so access to it is protected even on a laptop.

## Accounts and roles

Everyone has their own account. There are no shared passwords.

| Role       | Can                                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **viewer** | See services, health, SLOs, alerts and the generated configuration                                                                       |
| **editor** | Everything a viewer can, plus change services and SLOs and deploy ordinary changes (from Phase 2)                                        |
| **admin**  | Everything an editor can, plus manage users, secrets and notification receivers, and approve security-relevant or data-affecting changes |

### The first admin

When `raion server` starts and no users exist, it prints a one-time setup link. The link:

- is valid for 30 minutes and for a single use
- keeps its token after `#`, so it never appears in server or proxy logs

If it expires, restart the server to get a new one.

### Adding people

- **Web UI:** an admin uses the **Users** page.
- **Command line** (on the machine that holds the workspace):

  ```sh
  raion users add alice --role editor     # prompts for the password
  raion users list
  ```

Changing someone's role or disabling them signs them out everywhere immediately. Raion refuses to demote or disable the last active admin.

### Passwords and sign-in

- **Passwords** must be at least 12 characters and must not contain the username. They are stored as scrypt hashes.
- **Failed sign-ins:**
  - 10 failed attempts lock the account for 15 minutes
  - sign-in is also rate-limited per IP address
  - the error message is the same whether the username or the password was wrong
- **Sessions** end after 12 hours of inactivity, and after 7 days at the latest.

### Audit log

Sign-ins (successful and failed), setup, and user changes are recorded. Admins can read the log at `/api/v1/audit`; a UI view is planned.

## Serving Raion to a team

By default Raion listens only on `127.0.0.1`. To let colleagues reach it, it must be served over HTTPS. Raion refuses to serve plain HTTP on a network address. There are two options.

**Behind a reverse proxy (recommended).** The proxy (nginx, Caddy, Traefik, a cloud load balancer) terminates TLS:

```sh
raion server --host 127.0.0.1 --port 7600 --trust-proxy --public-url https://raion.example.com
```

**Built-in TLS.**

```sh
raion server --host 0.0.0.0 --port 7600 \
  --tls-cert /etc/raion/tls.crt --tls-key /etc/raion/tls.key \
  --public-url https://raion.example.com
```

`--public-url` is the address people type into their browser. Requests for any other hostname are rejected, which protects against DNS-rebinding attacks.

## What Raion does to protect you

- **Strict browser security:**
  - Content-Security-Policy with no inline scripts
  - pages cannot be framed
  - HttpOnly, SameSite=Strict session cookies (also `Secure` when served over HTTPS)
- **CSRF protection:** every state-changing request needs a custom header and a same-origin `Origin`.
- **Metrics stay local:** `/metrics` is served only to loopback addresses.
- **No secrets in configuration files:** only references, see [secrets](configuration.md#secrets).
- **Local state is private:**
  - operational data (users, sessions, audit log) lives in `.raion/raion.db`
  - the `.raion/` directory is created with owner-only permissions on Linux and macOS
  - on Windows, keep the workspace inside your user profile

## The observability stack

- **One way in.** Only the Raion gateway is reachable, on `127.0.0.1:7601`, and it requires a secret that only the Raion server and CLI hold (`.raion/secrets/`). Prometheus, Loki, Tempo, Alertmanager and Grafana are not reachable directly, even from the same machine.
- **Grafana sign-in.** Grafana is opened through Raion (`/grafana/`). Raion checks your session and tells Grafana who you are and your role:

  | Raion role | Grafana role |
  | ---------- | ------------ |
  | viewer     | Viewer       |
  | editor     | Editor       |
  | admin      | Admin        |

  Grafana's own login form is disabled. Changing someone's role in Raion changes it in Grafana on their next request.

- **Network isolation.**
  - Storage components run on a network with no internet access.
  - Your application containers can reach only the telemetry collector.
- **Hardened containers.**
  - All Linux capabilities are dropped.
  - Root filesystems are read-only.
  - Privilege escalation is blocked.
  - Every image is pinned by digest.
  - The documented exceptions are node_exporter, which shares the host PID namespace and reads the host filesystem read-only, and the optional cAdvisor, which runs privileged and needs explicit approval (`--allow-privileged`, admins only in the UI).
- **Automated checks use a read-only Grafana account.** `raion verify --dashboards` signs in to Grafana as `raion-system` with the Viewer role. Grafana creates that account on first use.
- **Notification secrets** (Slack webhooks, SMTP passwords, tokens):
  - stored in the owner-only secret store
  - mounted into Alertmanager as files
  - never written into generated configuration, logs or API responses
  - managed by admins only; setting or removing one is audited by name, never by value
- **Deployments are audited.** Every apply, rollback and destroy is recorded with who did it and the release involved.
- **Database monitoring credentials** (PostgreSQL, Redis):
  - only accepted as `${secret:NAME}` or `${env:NAME}` references; a password written into the workspace is refused
  - mounted into the collector as files and read with `${file:…}`
  - never in generated configuration
  - use a read-only monitoring user (`pg_monitor`), never the application's user
- **Integration parameters cannot smuggle in configuration.** The collector expands `${…}` in its configuration, so parameter formats (`host:port`, URL, name) never allow `$`. Receiver configuration is built by Raion from an allow-list, never copied from a package.
- **Container logs need no privileges.** They arrive through Docker's `fluentd` logging driver on a loopback-only port. Nothing reads Docker's files, and no component gets the Docker socket. The collector keeps only lines tagged with a service that has `containerLogs`.
- **GitOps safeguards.**
  - The pull-request action fails when anything under `.raion/` is committed.
  - It never runs untrusted code with write access (no `pull_request_target`).
  - Deployment pipelines cannot escalate privileges or delete data without a person.
  - `raion drift` finds changes made around the review; each repair is audited. See [GitOps](gitops.md).
- **Workspace integration packages are pinned.** A package in `integrations/` sets environment variables of the applications it instruments (for example `JAVA_TOOL_OPTIONS`), so review it like code. Raion refuses a package that is not in `integrations.lock.yaml` or has changed since it was locked; `raion integrations lock` is the deliberate, reviewable step.

See [Phase 2 decisions](../design/phase-2-decisions.md) for the reasoning.

## Not available yet

- Single sign-on with OIDC providers (Google, Entra ID, Okta, Keycloak): planned as the first item after the MVP.
- Personal API tokens for using the CLI against a remote Raion server.
- Signed integration packages. Today they are pinned by checksum.
