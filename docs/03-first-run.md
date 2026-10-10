# First run

This page takes you from nothing to the Raion web UI, signed in as the administrator, with monitoring running and your first application connected. You type two commands; everything else is done in the web UI. It takes about fifteen minutes, most of it downloading container images.

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

Press Enter to keep the suggested answer shown in brackets. At the end, Raion shows your answers and asks before creating anything: choose **Change my answers** to go through the questions again with your answers filled in, or press Ctrl+C at any point to stop without creating anything.

Every answer can also be given as a flag, for scripts: `raion init observability --yes --name shop --service payment-api --type api --language nodejs --runtime compose --level 2`.

You get:

```
observability/
├── raion.yaml              the workspace: level, environment, teams, notifications
├── services/
│   └── payment-api.yaml    one file per service
└── .gitignore              keeps .raion/ (local state and secrets) out of Git
```

Everything after this happens in the web UI. (Prefer the terminal? Each step below has a command too: see [Web UI and command line](reference/ui-and-cli.md).)

## 2. Start Raion

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

## 3. Create the administrator account

1. Open the **setup link** in your browser. The setup token is filled in for you.
2. Choose an **admin username** and a **password** of at least 12 characters (that does not contain the username), and repeat it.
3. Click **Create admin account**. You are signed in, on **Home**.

The link works once and for 30 minutes. If it expired, stop the server and start it again to get a new one. Next time, sign in at **<http://127.0.0.1:7600>**.

## 4. Start monitoring

**Home** shows a short **Get set up** checklist. Its first open step is **Start monitoring**:

1. Click **Open the observability stack**. Its **Changes to deploy** tab shows what Raion will run, in plain words.
2. Click **Deploy and start monitoring**. The first time, Raion downloads the monitoring tools, which takes a few minutes; the progress is shown live.
3. Raion checks every tool: each must be ready, monitored, and alerting must work. If anything fails, Raion puts back what was there before and tells you why. Nothing is left half-done.

When it is done, **Test the pipeline** sends a test measurement, log line and trace and checks each one arrives.

## 5. Add and connect your application

Your workspace already has the application you described in `raion init`. To add another, click **Add an application**: Raion asks its name, where it runs (and lists the containers running on this machine, so you can pick yours), and what kind it is, then shows what it recommends. Click **Set this up for me**.

Then open the application's **Connect** tab:

- **Already running here in Docker Compose?** Click **Connect it for me** (admins). Raion shows exactly what it will change, then restarts it with its settings. Your compose files are not changed.
- **Not running yet, or elsewhere?** The tab gives the steps, with commands to copy.
- **Running somewhere Raion cannot reach inside** (a cloud service, another server)? Raion watches it from outside, by its web address.

Within a minute, its **Overview** tab shows data arriving. See [Connecting an application](05-connecting-a-service.md).

## 6. Get notified (optional)

Every alert appears on the **Alerts** page. To also get them by Slack, email or webhook, go to **Settings → Notifications → Add a notification channel**, then deploy from **Observability stack**.

## 7. Invite your colleagues (optional)

Go to **People → Add a person** (username, initial password, role) and share the password with them privately. Roles:

- **viewer**: sees everything
- **editor**: also adds and changes applications and reliability goals, applies Advisor fixes, silences alerts, deploys changes
- **admin**: also manages people, secrets and workspace settings, connects running applications, and approves sensitive changes

The server only accepts connections from this machine. To let colleagues use it from their own computers, see [Serving Raion to your team](15-users-and-security.md#serving-raion-to-your-team).

## The same from the terminal

Everything above can also be done with commands, for scripts and CI/CD:

```sh
raion validate observability              # check the workspace
raion apply observability                 # start monitoring (shows the plan and asks first)
raion verify observability                # test the pipeline
raion services add ledger-api --type api --language nodejs -w observability
raion connect observability --restart ledger-api
raion users add alex --role editor -w observability
```

## Stopping and starting again

- **The web UI:** Ctrl+C in the server's terminal; `raion server --workspace observability` to start it again.
- **Monitoring** keeps running in Docker when the web UI is stopped. **Observability stack → Advanced → Stop monitoring** (or `raion destroy observability`) stops it; your stored data is kept. **Deploy and start monitoring** (or `raion apply observability`) starts it again.

Next: [A tour of the web UI](04-ui-tour.md).
