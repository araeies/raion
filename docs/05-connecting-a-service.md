# Connecting an application

Once monitoring is running, your applications send it their measurements, logs and traces, and Raion's collector reads your databases. Raion tells you exactly what to do for each application, does it for you where it can, and then checks that it worked.

There are three situations, and Raion handles each one:

| Your application                                           | What Raion does                                                                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Runs on this machine in Docker or Docker Compose**       | Connects it, often without rebuilding anything: see [already running](#applications-that-already-run) and [no rebuild](#without-rebuilding-your-image) |
| **Runs directly on this machine** (no Docker)              | Gives you the settings to start it with                                                                                                                |
| **Runs elsewhere** (the cloud, another server, Kubernetes) | Watches it from outside, by its web address: see [outside checks](#applications-that-run-elsewhere)                                                    |

## In the web UI

1. **Applications → Add an application.** Give it a name, choose where it runs (Raion lists the containers running on this machine, so you can pick yours), and what kind of application it is. Raion shows what it recommends; click **Set this up for me**.
2. Open the application's **Connect** tab. It shows the steps for that application, with commands to copy, or **Connect it for me** when Raion can do it.
3. Within a minute, the **Overview** tab shows what arrives: requests, failures and response times, and whether measurements, logs and traces are all coming in. **Over time** charts the last hour, 6 hours or 24 hours.

If something is missing, the **Overview** tab says what, and the [troubleshooting](#if-something-does-not-work) table below says why.

## Applications that already run

Most people start monitoring after their applications are already running, often in production. Raion does not need you to stop anything first or to change your compose files.

**Find them.** **Add an application** lists the containers running on this machine, with their Compose project and service and a guess at their language. Pick one, and its name and details are filled in. (Command line: `raion discover`.)

**Connect it for me** (admins), on the application's **Connect** tab:

1. Raion shows exactly what it will do: the settings it adds (where to send data, the application's name), and the restart command.
2. When you confirm, Raion writes its settings to a separate file in its own state folder (`.raion/connect/<project>.raion.yaml`) and restarts **only that service** of your Compose project, with your compose files plus that file. Your own compose files are never changed.
3. The application is back within seconds, now sending data. The restart is recorded in the audit log and in **Observability stack → Activity**.

Command line: `raion connect --restart payment-api`. Raion prints the restart command too, so you can restart it the same way yourself later (for example after `docker compose up` from your own files, which drops Raion's settings).

**Things to know:**

- Monitoring must be running first: the application joins Raion's network to reach the collector.
- A restart is short, but it is a restart: requests in progress may fail. Choose a quiet moment for production.
- When the same Compose service name runs in several projects, Raion does not guess: it asks you to use `raion connect --out` and restart it yourself.

## Without rebuilding your image

For **Node.js**, **Python** and **Java** applications in Docker Compose, Raion adds OpenTelemetry when the container starts. You install nothing, change no code and keep your image. **Add an application** sets this up when you choose Docker Compose and one of these languages.

When the application starts, a small helper container copies the agent from Raion's pinned, verified OpenTelemetry image into a shared, read-only volume, and the application loads it. The helper has no network access and no privileges, and exits once done. Details per language: [Node.js](integrations/nodejs.md#without-rebuilding-your-image), [Python](integrations/python.md#without-rebuilding-your-image), [Java](integrations/java.md).

Go, .NET and PHP applications are instrumented in the code or the image instead: the **Connect** tab shows how.

## Applications that run elsewhere

When an application runs where Raion cannot see inside it (a cloud service, another server, a Kubernetes cluster, or a site you do not host), Raion watches it **from outside**, like a user would. In **Add an application**, choose **Cloud or another server**, **Kubernetes** or **I'm not sure**, and give the address to check, usually a health page such as `https://shop.example.com/health`.

Every 30 seconds, Raion visits each address and records:

- whether it answered, and with which status (any 2xx is healthy, unless you choose the codes)
- how long it took to answer
- when its HTTPS certificate expires

You get alerts when it is **down** (every check failed for 2 minutes), **slow** (answers took longer than the application's response-time threshold, 1 second by default), or when its **certificate expires** within 14 days. You can set reliability goals on it ("available 99.9% of the time"), and its page charts its availability and answer time.

Change the addresses on the application's **Settings** tab. In a workspace file:

```yaml
spec:
  type: web
  runtime:
    type: remote
  checks:
    - url: https://shop.example.com/health
      expectStatus: [200] # optional; default any 2xx
      interval: 30s # optional, 15s to 10m
      timeout: 10s # optional, 1s to 60s
```

The checks run from the machine running Raion, so the address must be reachable from it. Command line: `raion services add shop --type web --runtime remote --check https://shop.example.com/health`.

## From the command line

The steps below do the same as the web UI, for scripts and for those who prefer files: describe the application in a file, generate its settings, and check what arrives.

```sh
raion services add payment-api --type api --language nodejs -w observability
raion connect observability --out observability.override.yaml
docker compose -f compose.yaml -f observability.override.yaml up -d
raion verify observability --service payment-api
raion history payment-api observability     # the last hour, as text
```

### 1. Describe the service

Each application is a file in `services/` (or an entry in `raion.yaml`). `raion services add` (or **Add an application**) writes it for you; you can also create one such as `services/ledger-api.yaml` yourself:

```yaml
apiVersion: raion/v1alpha1
kind: Service
metadata:
  name: ledger-api
spec:
  type: api # web, api, worker, database, microservice or infrastructure
  language: nodejs # Raion picks the integration from the language
  team: payments
  tier: standard # critical, standard or best-effort
  runtime:
    type: compose # in Docker Compose; "host": a process on this machine; "remote": elsewhere
    composeService: ledger-api # its name in your compose file, if different
```

Databases and proxies name their integration and how to reach them:

```yaml
spec:
  type: database
  integrations:
    - name: postgresql
      params:
        endpoint: orders-db:5432
        password: ${secret:ORDERS_DB_MONITOR_PASSWORD}
```

Run `raion validate` after each change. [Describing your services](06-configuration.md) lists every option, and [Integrations](integrations/README.md) lists what each technology needs.

### 2. Get the instructions: `raion connect`

```sh
raion connect observability
```

For each service, Raion prints the integration it uses and the steps:

1. **What to install or change** in your application (for example the OpenTelemetry packages), or what to set up in your database (a read-only monitoring user). Raion never installs or changes anything in your application itself.
2. **How to start it**:
   - **Services in Docker Compose:** add `--out observability.override.yaml` and Raion writes a Compose override file. Your own `compose.yaml` stays unchanged; you start with both:

     ```sh
     docker compose -f compose.yaml -f observability.override.yaml up -d
     ```

     The override sets the OpenTelemetry environment variables and puts the service on the stack's `raion-ingest` network, where it can reach the collector. For databases and proxies it only joins the network, so the collector can read them. For services with [container logs](integrations/docker.md#container-logs), it also sets the Docker logging driver.

   - **Processes on this machine** (`runtime: { type: host }`): Raion prints the environment variables to set. `raion connect observability --service my-api --format shell` prints them as `export` commands; `--format env` in `.env` format.

The same steps are on each application's **Connect** tab in the web UI.

Generate the override again whenever you add services or change their level. Raion refuses to overwrite a file it did not write.

### 3. Check it: `raion verify --service`

```sh
raion verify observability --service payment-api
```

Raion looks at what actually arrived in the last few minutes:

| Check       | Passes when                                                                      |
| ----------- | -------------------------------------------------------------------------------- |
| **metrics** | The service's metrics are in Prometheus (for a database: the collector reads it) |
| **logs**    | The service's logs are in Loki                                                   |
| **traces**  | The service's traces are in Tempo (level 2 and above)                            |
| **linking** | Log lines carry trace IDs, and those IDs open a trace                            |

It also shows the request rate, error rate and 95th-percentile latency of the last 5 minutes, and the query behind each check so you can look further in Grafana. The application's **Overview** tab shows the same, refreshed every 30 seconds.

A service that has not handled any requests yet has no request metrics. Send it some traffic, wait a minute, and check again.

## What each service sends

What is collected follows the service's level and its `signals`:

|                       | Level 1 | Level 2 and 3 |
| --------------------- | ------- | ------------- |
| Metrics               | ✓       | ✓             |
| Logs                  | ✓       | ✓             |
| Traces                | –       | ✓             |
| Logs linked to traces | –       | ✓             |

To turn a signal off for one service, set for example `signals: { traces: false }`.

## A language without an integration

Raion has integrations for Node.js, Python, Java and Go ([all integrations](integrations/README.md)). For another language, instrument the service with the OpenTelemetry SDK for that language and send OTLP to `http://otel-collector:4318` (from Compose) or `http://127.0.0.1:4318` (from this machine), with `OTEL_SERVICE_NAME` set to the service's name in Raion. Logs and traces then work. Request-rate dashboards, service alerts and availability or latency SLOs need an integration; your team can [write one](integrations/writing-integrations.md).

## If something does not work

| Symptom                                                             | What to do                                                                                                                                                  |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `network raion-ingest declared as external, but could not be found` | Monitoring is not running. Deploy it from **Observability stack** (or `raion apply`) first.                                                                 |
| **Connect it for me** says no running container was found           | The application is not running, or its name in your compose file differs: set it on the application's **Settings** tab.                                     |
| An outside check fails, but the site works in your browser          | The check runs from the machine running Raion: can it reach the address (firewall, VPN, internal DNS)? Is the status one you expect?                        |
| Nothing arrives after a restart with the agent                      | The application sets `NODE_OPTIONS`, `PYTHONPATH` or `JAVA_TOOL_OPTIONS` itself, replacing Raion's: combine both values. See the language's page.           |
| `raion verify --service` finds nothing                              | Has the service handled requests? Is its container on `raion-ingest` (`docker inspect <container>`)? Does `OTEL_SERVICE_NAME` match the Raion service name? |
| A service is missing from the override                              | It runs on the host, or it has no integration. `raion connect` says which.                                                                                  |
| The collector cannot read a database                                | See the integration's page, for example [PostgreSQL](integrations/postgresql.md#troubleshooting).                                                           |

More in [Troubleshooting](17-troubleshooting.md).
