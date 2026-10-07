# First run

This page takes you from nothing to the Raion web UI, signed in as the administrator, with the observability stack running. It takes about fifteen minutes, most of it downloading container images.

Make sure Docker is running and the [`raion` command](02-installing.md#the-raion-command) works.

## 1. Create a workspace

A workspace is the folder of YAML files that describes what you observe. Create it next to your code, or in its own Git repository:

```sh
raion init observability
```

Raion asks a few questions:

1. **A name for the workspace**, usually your team or product.
2. **What are you monitoring?** A web application, an API, a background worker, a database, a microservice, or infrastructure only.
3. **The name of the service**, for example `payment-api`.
4. **Where does it run?** In Docker Compose, or as a process on this machine.
5. **What language is it written in?** Node.js, Python, Go, …
6. **How much do you want to set up?** Level 1, 2 or 3 ([levels](01-what-is-raion.md#ideas-you-will-meet)). Start with 1 or 2 if you are unsure; you can change it later.

Every answer can also be given as a flag, for scripts: `raion init observability --yes --name shop --service payment-api --type api --language nodejs --runtime compose --level 2`.

You get:

```
observability/
├── raion.yaml              the workspace: level, environment, teams, notifications
├── services/
│   └── payment-api.yaml    one file per service
└── .gitignore              keeps .raion/ (local state and secrets) out of Git
```

Check it:

```sh
raion validate observability
```

`validate` explains any problem with its exact file and line, and suggests fixes ("did you mean `ledger-api`?").

## 2. Deploy the observability stack

```sh
raion plan observability      # what will be deployed; nothing changes yet
raion apply observability     # deploy (shows the plan and asks first)
```

The first `apply` downloads the container images and takes a few minutes. Raion then checks every component: each one must be ready, monitored, and alerting must work. If anything fails, Raion restores the previous state and tells you why.

Confirm the stack works end to end:

```sh
raion verify observability    # sends a test metric, log line and trace, and finds each in storage
raion status observability    # every component, its health, and whether alerting works
```

## 3. Start the Raion server

```sh
raion server --workspace observability
```

The server keeps running in this terminal (stop it with Ctrl+C). It prints:

```
Raion server listening on http://127.0.0.1:7600

No users exist yet. Create the first admin within 30 minutes:
  http://127.0.0.1:7600/setup#token=…
```

The server also prints a log line for each request; you can ignore those.

## 4. Create the administrator account

1. Open the **setup link** in your browser. The setup token is filled in for you.
2. Choose an **admin username** and a **password** of at least 12 characters (that does not contain the username), and repeat it.
3. Click **Create admin account**. You are signed in.

The link works once and for 30 minutes. If it expired, stop the server and start it again to get a new one.

## 5. Open the web UI

Go to **<http://127.0.0.1:7600>**. Next time, sign in there with your username and password.

You land on **Services**. The bar at the top takes you to the rest of Raion:

| Menu item               | What it is for                                                               |
| ----------------------- | ---------------------------------------------------------------------------- |
| **Services**            | Every service, its health, alerts, SLOs, dependencies and how to connect it  |
| **SLOs**                | Reliability targets and their error budgets; create new SLOs                 |
| **Alerts**              | What is firing now, silences, recent history, and whether alerting works     |
| **Advisor**             | Gaps in your observability, and fixes                                        |
| **Integrations**        | What Raion can monitor, and how to set up each integration                   |
| **Observability stack** | Health of the components, pending changes, generated configuration, releases |
| **Users** (admins)      | Accounts, roles, password resets and everyone's API tokens                   |
| **Audit log** (admins)  | Who did what, and when                                                       |
| **Grafana ↗**           | Dashboards and exploration, already signed in                                |

The [tour of the web UI](04-ui-tour.md) explains each page.

## 6. Invite your colleagues (optional)

Go to **Users**, fill in **Add a user** (username, initial password, role) and share the password with them privately. Roles:

- **viewer**: sees everything
- **editor**: also creates SLOs, applies advisor fixes, silences alerts, deploys changes
- **admin**: also manages users and secrets, and approves sensitive changes

The server only accepts connections from this machine. To let colleagues use it from their own computers, see [Serving Raion to your team](15-users-and-security.md#serving-raion-to-your-team).

## Stopping and starting again

- **The web UI:** Ctrl+C in the server's terminal; `raion server --workspace observability` to start it again.
- **The observability stack** keeps running in Docker when the web UI is stopped. `raion destroy observability` stops it (your stored data is kept); `raion apply observability` starts it again.

Next: [A tour of the web UI](04-ui-tour.md).
