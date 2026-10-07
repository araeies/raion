# Users, roles and security

Everyone who uses Raion has their own account. Raion can deploy infrastructure and holds credentials, so access is protected even when it runs on a laptop.

## Roles

| Role       | Can                                                                                                                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **viewer** | See everything: services, health, SLOs, alerts, advisor findings, the observability stack, generated configuration; open Grafana as a Grafana Viewer                                   |
| **editor** | Everything a viewer can, plus: create SLOs, apply advisor fixes, silence alerts, apply ordinary changes to the stack, test the pipeline, restore the stack after drift; Grafana Editor |
| **admin**  | Everything an editor can, plus: manage users, set secrets, approve changes that need elevated privileges or affect stored data, read the audit log; Grafana Admin                      |

Choose the smallest role that lets someone do their work. In a team that changes Raion only through Git ([Working through Git](14-gitops.md)), most people can be viewers.

## Accounts

### The first admin

When `raion server` starts and no users exist, it prints a one-time setup link (see [First run](03-first-run.md#4-create-the-administrator-account)). The link works once, for 30 minutes, and keeps its token after `#`, so the token never appears in server or proxy logs. If it expires, restart the server to get a new one.

### Adding people

- **Web UI:** an admin opens **Users** → **Add a user**: username, initial password, role. Share the password privately.
- **Command line**, on the machine that holds the workspace:

  ```sh
  raion users add alice --role editor -w observability    # prompts for the password
  raion users list -w observability
  ```

### Changing a role, disabling an account

On **Users**, an admin changes a role from the list, or clicks **Disable** (and later **Enable**). Either signs that person out everywhere immediately. Raion refuses to demote or disable the last active admin.

### Passwords

- At least 12 characters, and must not contain the username. Stored as scrypt hashes.
- **Changing your own password** is done through the API; the web UI has no page for it. See [Changing a password](reference/api.md#changing-a-password).
- **Resetting someone else's password** (admins) is also done through the API, with `PATCH /api/v1/users/<username>`. It signs that person out.

### Sign-in protection

- 10 failed attempts lock an account for 15 minutes; sign-in is also rate-limited per IP address.
- The error message is the same whether the username or the password was wrong.
- Sessions end after 12 hours of inactivity, and after 7 days at the latest.

### Audit log

Raion records sign-ins (successful and failed), setup, user changes, password changes, secret changes (by name, never value), deployments, rollbacks, repairs, silences, SLO creation and advisor fixes, each with who did it. Admins read it through the API: `GET /api/v1/audit` ([HTTP API](reference/api.md)).

## Secrets

Workspace files are meant for Git, so they never contain credentials. Fields that need one (Slack webhooks, SMTP passwords, webhook tokens, database monitoring passwords) accept only a reference:

- `${secret:NAME}`: stored by Raion in `.raion/secrets/` (owner-only, never committed)
- `${env:NAME}`: read from the environment of the process running `raion apply`

A value written directly into a file is rejected by `raion validate`. Store secrets with:

```sh
raion secrets set SLACK_WEBHOOK -w observability     # prompts; the value is hidden
raion secrets list -w observability                  # which are needed and whether each is set
raion secrets remove SLACK_WEBHOOK -w observability
```

Admins can also set them on **Observability stack → Secrets**. Values can be replaced but never read back. Apply afterwards so the components pick them up; `raion apply` refuses to deploy while a needed secret is missing.

## Serving Raion to your team

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
- **No secrets in configuration files:** only references, see [secrets](06-configuration.md#secrets).
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
  - `raion drift` finds changes made around the review; each repair is audited. See [Working through Git](14-gitops.md).
- **Workspace integration packages are pinned.** A package in `integrations/` sets environment variables of the applications it instruments (for example `JAVA_TOOL_OPTIONS`), so review it like code. Raion refuses a package that is not in `integrations.lock.yaml` or has changed since it was locked; `raion integrations lock` is the deliberate, reviewable step.

## Limitations

- Sign-in uses Raion's own accounts. Single sign-on with an external identity provider (Google, Entra ID, Okta, Keycloak) is not supported.
- There are no personal API tokens. Scripts sign in with a username and password ([HTTP API](reference/api.md)).
- Changing passwords and reading the audit log are available through the API only.
