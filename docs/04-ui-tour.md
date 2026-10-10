# A tour of the web UI

The web UI is the main way to use Raion. Everything you need day to day is here: adding applications, seeing their health, understanding alerts, setting reliability goals and deploying changes. You never need to open a configuration file. (If you like terminals, everything here can also be done with the [`raion` command](reference/ui-and-cli.md).)

Open **<http://127.0.0.1:7600>** while `raion server` is running (see [First run](03-first-run.md)) and sign in, with your Raion username and password or, if your organization set it up, with **Sign in with …** ([single sign-on](15-users-and-security.md#single-sign-on)).

**Help is built in.** Look for:

- a **?** next to a word: point at it (or focus it with the keyboard) for a short explanation
- **What is this?** boxes that explain an idea the first time you meet it
- **Recommended** on the choice Raion suggests when you are not sure
- **Technical details**, folded away at the bottom of a section: the exact queries, rules and settings behind what you see, for when you want to look further

## The sidebar

| Section | Page                    | What it is for                                                                    |
| ------- | ----------------------- | --------------------------------------------------------------------------------- |
| Monitor | **Home**                | What needs attention, your next setup step, and all your applications at a glance |
|         | **Applications**        | Every application, its health, and how to connect it                              |
|         | **Alerts**              | What is wrong now, in plain words, and what to do about it                        |
|         | **Reliability goals**   | How reliable each application should be, and whether it is on track               |
|         | **Advisor**             | Gaps in your monitoring, with fixes Raion can make for you                        |
| Set up  | **Integrations**        | The technologies Raion understands, and how to set up each                        |
|         | **Observability stack** | The monitoring tools Raion runs for you: deploy, test, roll back                  |
|         | **Settings**            | Level, data retention, notifications and teams (editors and admins)               |
|         | **People**              | Accounts, roles and API tokens (admins)                                           |
|         | **Audit log**           | Who did what, and when (admins)                                                   |
| Explore | **Dashboards ↗**        | Grafana, already signed in                                                        |

At the bottom: your name and role, which opens [your account](#your-account), and **Sign out**. On a phone, the menu button at the top opens the sidebar.

What you can change depends on your role. Viewers see everything; buttons that change something appear for editors and admins, and a few for admins only. See [roles](15-users-and-security.md#roles).

---

## Home

Where you land after signing in.

- **At a glance:** alerts firing, applications, reliability goals, and whether Raion's own tools are healthy.
- **Needs attention:** firing alerts and reliability goals at risk, each linking to where you deal with it. It only appears when something needs you.
- **Get set up** (editors and admins): a short checklist (add your first application, start monitoring, set a reliability goal) with the next step's button. It disappears once you are done.
- **Your applications:** a card per application with its health at a glance. **Add an application** starts the guided setup.

---

## Adding an application

**Applications → Add an application** (or **Add an application** on Home) asks four simple questions, with a recommended answer for each:

1. **Name:** what you call it, for example "Payment API". Raion turns it into a name it can use (`payment-api`) and shows it.
2. **Where it runs:**
   - **Docker Compose** or **Docker** on this machine. Raion lists the containers running here, so you can pick yours instead of typing.
   - **Directly on this machine:** a program started without Docker.
   - **Cloud or another server**, **Kubernetes**, or **I'm not sure:** Raion watches it from outside, by its web address ([outside checks](05-connecting-a-service.md#applications-that-run-elsewhere)).
3. **Details:** what kind of application it is (website, API, worker, database…) and its language. Each choice says what it means.
4. **Recommended setup:** what Raion will set up for it, in plain words (request measurements, error tracking, tracing, alerts for errors, slowness and silence, or availability checks for outside applications). **Set this up for me** does it all.

Next, Raion shows how to connect the application. When it already runs here in Docker Compose, an admin can click **Connect it for me**.

---

## An application's page

Click an application anywhere to open it. Under its name: what it is, its importance (tier), its team and where it runs. **Open dashboard** opens its Grafana dashboard.

| Tab                   | What it shows and what you can do                                                                                                                                                                                                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Overview**          | **Health**: requests per second, the share failing and the response time of the slowest 1 in 20 requests, over the last 5 minutes, and whether measurements, logs and traces are arriving. **Over time**: a chart of each over the last hour, 6 hours or 24 hours. Its **Alerts**, explained, and its **Connections** to other applications. |
| **Connect**           | How to connect it, step by step, with commands to copy. For applications already running here in Docker Compose, **Connect it for me** (admins) restarts it with Raion's settings, after showing exactly what will change. See [Connecting an application](05-connecting-a-service.md).                                                      |
| **Reliability goals** | Its goals and their error budgets; **Set a goal**.                                                                                                                                                                                                                                                                                           |
| **Settings**          | Change what it does, its contact, team and importance, its name in your compose file, its outside checks, **what Raion collects** (measurements, logs, traces, container output) and **when to alert** (editors). **Stop monitoring…** removes it.                                                                                           |
| **Configuration**     | The files that describe it, exactly as written, for those who want to see them.                                                                                                                                                                                                                                                              |

Applications watched from outside show their **outside checks** instead: whether the address answers, how fast, and when its HTTPS certificate expires.

---

## Alerts

One place for everything Raion watches. Grafana's own alerting is turned off, so nothing is shown in two places.

Each alert says, in plain words:

- **what** is wrong, and **which application**
- **what it means** for your users
- **why it fired**: the condition, for example "more than 5% of requests failed for 5 minutes in a row"
- **since when**, and **where it comes from**
- **what to do**: numbered first steps

**Technical details** shows the exact rule and labels. Editors can **Silence…** an alert while they work on it.

| Tab                    | What it shows                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| **Firing now**         | Alerts that are active now, most urgent first                                                     |
| **About to fire**      | Problems Raion has noticed that become alerts if they last (for example, "for 10 minutes")        |
| **History**            | Alerts that stopped, for 30 days, including any that started and stopped while the web UI was off |
| **What Raion watches** | Every check Raion runs, explained                                                                 |

At the top, Raion confirms that **alerting works**. It runs a self-test alert all the time; you see it as "Alerting self-test", never as a problem. Active silences are listed with who created them and why.

See [Alerts and notifications](09-alerts.md).

---

## Reliability goals

How reliable each application should be ("99.9% of requests succeed, over 30 days") and whether it is on track: **healthy**, **at risk**, **budget spent** or **no data yet**, with the error budget left as a bar. **Set a goal** walks you through it with a recommended goal for the application; each goal can be changed or removed. **OpenSLO format** shows them in the vendor-neutral format.

See [Reliability goals and error budgets](10-slos.md).

---

## Advisor

Gaps in your monitoring, most important first. Each says what is wrong, why it matters and what to do. When Raion can make the fix itself, **Fix it for me** shows the exact change first, then makes it (editors). See [The Advisor](12-advisor.md).

---

## Integrations

Every technology Raion understands (Node.js, Python, Java, Go, PostgreSQL, Redis, Nginx, Docker containers, and your own packages). Click one for what you get, how to use it, its settings and which of your applications use it. See [Integrations](integrations/README.md).

---

## Observability stack

The monitoring tools Raion runs for you (the collector, Prometheus, Loki, Tempo, Grafana, Alertmanager and their helpers). At the top: whether everything is healthy, and **Deploy** when there are changes. **Test the pipeline** sends a test measurement, log line and trace and checks each one arrives.

| Tab                   | What it shows and what you can do                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Components**        | Each tool, what it does, whether it is running and ready                                                                                                                  |
| **Changes to deploy** | What deploying would change, in plain words. **Deploy** (editors). Changes that need extra privileges or delete stored data need an admin's approval.                     |
| **Activity**          | Every deployment, rollback, test and restart, from the web UI or the command line, with who started it and its progress log. One started in a terminal appears here live. |
| **Releases**          | Every deployed version. **Roll back** to an earlier one (editors).                                                                                                        |
| **Secrets** (admins)  | Passwords and webhook addresses that notifications and integrations need: set them here; values are never shown. Secrets no longer used can be deleted.                   |
| **Advanced**          | The generated configuration files, where applications send data, and **Stop monitoring**                                                                                  |

If something was changed outside Raion (a stopped container, an edited file), a notice offers to **Restore** the deployed release.

See [Applying changes](13-applying-changes.md) and [Is Raion itself healthy?](16-raion-health.md).

---

## Settings

Editors can see the settings; admins change them, because they affect everyone.

| Tab               | What you set                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **General**       | **How much Raion sets up** (level 1, 2 or 3, each explained), how long data is kept, and whether to monitor this machine and each container |
| **Notifications** | Channels for alerts (Slack, email, webhook) and which one gets alerts no team claims. Credentials are stored as secrets, never in files.    |
| **Teams**         | Teams, and where each team's alerts go                                                                                                      |

Changes are saved to your workspace files. Deploy them from **Observability stack** to take effect.

---

## Your account

Click your name in the sidebar.

- **Change your password**: your current password, then the new one twice. It signs you out everywhere else. People who sign in with single sign-on change it at their identity provider instead.
- **API tokens**: create a token for a script, choose its role (up to your own) and when it expires, and copy it; it is shown only once. See [API tokens](15-users-and-security.md#api-tokens).

---

## People (admins)

Every account, with its role and status. Change a role, **Disable** or **Enable** an account, **Reset password**, or **Add a person**. Changing a role or disabling an account signs that person out immediately. Raion will not let you remove or demote the last active admin. Accounts marked **SSO** get their role from the identity provider. Below, every active API token, which you can revoke.

See [Users, roles and security](15-users-and-security.md).

---

## Audit log (admins)

Who did what, newest first: sign-ins, account and token changes, secrets, deployments, silences, changes to applications, goals and settings, and fixes. Changes made from the command line appear as `cli:<user>`. Filter by person or kind of action.

---

## Dashboards (Grafana)

**Dashboards ↗** opens Grafana on the **Raion · Overview** dashboard, signed in with the role that matches yours. All of Raion's dashboards are in the **Raion** folder; **Explore** queries metrics, logs and traces directly. See [Dashboards](08-dashboards.md) and [Investigating a problem](11-investigating.md).
