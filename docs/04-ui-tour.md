# A tour of the web UI

Open **<http://127.0.0.1:7600>** while `raion server` is running (see [First run](03-first-run.md)) and sign in.

The bar at the top is always there:

- **Raion** (left): back to Services
- your **workspace name**, environment and level
- the menu: **Services**, **SLOs**, **Alerts**, **Advisor**, **Observability stack**, and **Users** for admins
- **Grafana ↗**: opens Grafana in a new tab, already signed in with a matching role
- your **username and role**, and **Sign out**

What you can change depends on your role. Viewers see everything below; buttons that change something appear for editors and admins, and a few for admins only. See [roles](15-users-and-security.md#roles).

---

## Services

The home page. Every service in your workspace, with its type and language, team, tier, level, and number of SLOs. Click a service to open its page.

If the workspace has configuration errors, they are listed at the top with the file and line.

### A service's page

| Section                      | What it shows and what you can do                                                                                                                                                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Summary**                  | Type, language, team, owner, tier, environment, where it runs, level, repository                                                                                                                                                                                                             |
| **Health**                   | Requests per second, error rate and p95 latency over the last 5 minutes; whether metrics, logs and traces are arriving; and whether logs are linked to traces. **Show the queries** gives each query to run in Grafana. **Open the … dashboard in Grafana ↗** opens the service's dashboard. |
| **Alerts**                   | The service's alerts that are firing now. Editors can **Silence…** them.                                                                                                                                                                                                                     |
| **Connect this service**     | The integration used and the steps to connect the service: what to install, and the Compose override or environment variables. See [Connecting a service](05-connecting-a-service.md).                                                                                                       |
| **Service level objectives** | The service's SLOs with their error budgets. Editors can add one.                                                                                                                                                                                                                            |
| **Dependencies**             | What the service depends on (other services, external systems) and which services depend on it                                                                                                                                                                                               |
| **Configuration**            | The features enabled for the service, and **Show …** for each file that defines it, exactly as written                                                                                                                                                                                       |

---

## SLOs

Every SLO in the workspace, as a card:

- the objective in plain words, for example "**99.9%** of requests that do not fail with a server error, over a rolling 30d"
- its status: **healthy**, **at risk**, **budget spent**, **no data yet**, or **not evaluated** (with the reason)
- the current SLI, the **error budget left** (as a bar), and the burn rate over the last hour
- the description and the error budget policy, if set

**Create an SLO** (editors) opens a form: the service, what to measure (availability, latency or throughput), the objective, the window, and optionally a name, description and policy. Raion checks the SLO can be measured before saving it. **Show as OpenSLO** shows all SLOs in the vendor-neutral OpenSLO format.

See [SLOs and error budgets](10-slos.md).

---

## Alerts

- A banner says whether **alerting works**. Raion checks it constantly with an always-firing test alert. **Alerts dashboard ↗** opens the alerts dashboard in Grafana.
- **Firing now**: every active alert, with its severity, service, description, and links to the dashboard and runbook. Editors can **Silence…** an alert: choose for how long (1 hour to 1 week) and say why.
- **Silences**: active silences, with who created them and why. Editors can **Remove** one.
- **Recently resolved**: alerts that stopped firing, kept for 30 days.
- **What Raion watches**: every alert rule Raion generated, with its description.

See [Alerts and notifications](09-alerts.md).

---

## Advisor

Gaps in your observability, most severe first. Each finding says what is wrong, why it matters, what to do, and what was observed. Where Raion can make the fix itself, **Raion can do this** shows the exact change as a diff, and editors can click **Apply this fix**. Fixes change only your workspace files; deploy them from the Observability stack page.

**Check again** re-runs the checks. Findings your team has chosen to ignore are listed separately.

See [The Advisor](12-advisor.md).

---

## Observability stack

The state of the open-source components Raion runs for you.

| Section                                 | What it shows and what you can do                                                                                                                                                                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status banner**                       | **Healthy**, **Something is wrong** (with what), or **Not deployed yet**                                                                                                                                                                                   |
| **Open Grafana**, **Test the pipeline** | Editors can send a test metric, log line and trace through the stack and see whether each one is stored                                                                                                                                                    |
| **Drift notice** (only when needed)     | Changes made to the running stack outside Raion, such as a hand-edited file or a stopped container. Editors can **Restore release …**                                                                                                                      |
| **Dashboards**                          | Links to every generated Grafana dashboard                                                                                                                                                                                                                 |
| **Components**                          | Each component, its purpose, whether it is running and ready, and any elevated privileges it needs                                                                                                                                                         |
| **Monitoring of the stack itself**      | Whether Prometheus can collect metrics from each component                                                                                                                                                                                                 |
| **Secrets** (admins)                    | The secrets your notification receivers and database integrations need, whether each is set, and a form to set it. Values are never shown.                                                                                                                 |
| **Pending changes**                     | What applying your workspace would change: components that start, restart or stop, and changed files. **Apply changes** deploys them (editors). Changes that need elevated privileges or affect stored data must be approved by an admin, with a checkbox. |
| **Generated configuration**             | Every file Raion generates for the components; click one to read it                                                                                                                                                                                        |
| **Releases**                            | Every deployed version, newest first, with when and by whom                                                                                                                                                                                                |
| **Sending telemetry**                   | Where applications send OpenTelemetry data (gRPC and HTTP addresses, and the Docker network for containers)                                                                                                                                                |

Deployments, tests and repairs run in the background; a panel shows their progress and result.

See [Applying changes](13-applying-changes.md) and [Is Raion itself healthy?](16-raion-health.md).

---

## Users (admins)

Every account, with its role and status. Change a role from the list, **Disable** or **Enable** an account, or **Add a user** with a username, an initial password and a role. Changing a role or disabling an account signs that person out immediately. Raion will not let you remove or demote the last active admin.

See [Users, roles and security](15-users-and-security.md).

---

## Grafana

**Grafana ↗** in the top bar opens Grafana on the **Raion · Overview** dashboard. You are signed in automatically with the role that matches yours in Raion (viewer, editor or admin); Grafana has no separate login. All of Raion's dashboards are in the **Raion** folder. Use **Explore** to query metrics (Prometheus), logs (Loki) and traces (Tempo) directly.

See [Dashboards](08-dashboards.md) and [Investigating a problem](11-investigating.md).
