# Integrations

An **integration** is Raion's knowledge of a technology. It decides how a service is connected, and what Raion can show and alert on for it. A service with an HTTP integration, for example, gets golden-signal dashboards, error and latency alerts, and availability and latency SLOs; a PostgreSQL database gets connection, cache and deadlock monitoring.

## Available integrations

| Integration                    | For                 | How the telemetry arrives                                     | Change to your application                         |
| ------------------------------ | ------------------- | ------------------------------------------------------------- | -------------------------------------------------- |
| [Node.js](nodejs.md)           | Node.js services    | The application sends it (OpenTelemetry, zero-code)           | None in Docker Compose; elsewhere add two packages |
| [Python](python.md)            | Python services     | The application sends it (OpenTelemetry, zero-code)           | None in Docker Compose; elsewhere add packages     |
| [Java](java.md)                | Java services       | The application sends it (OpenTelemetry Java agent)           | None in Docker Compose; elsewhere add `-javaagent` |
| [Go](go.md)                    | Go services         | The application sends it (OpenTelemetry SDK)                  | One setup file and a wrapped HTTP handler          |
| [PostgreSQL](postgresql.md)    | PostgreSQL          | The collector reads it, with a read-only monitoring user      | None                                               |
| [Redis](redis.md)              | Redis               | The collector reads it (`INFO`)                               | None                                               |
| [Nginx](nginx.md)              | Nginx               | The collector reads `stub_status`                             | Enable `stub_status`                               |
| [Docker containers](docker.md) | Any Compose service | Container metrics (cAdvisor); container logs (logging driver) | None                                               |

`raion integrations list` shows the integrations available in a workspace, including your team's own.

## Choosing an integration

**Applications.** The integration is chosen from the service's `language`:

```yaml
spec:
  type: api
  language: python # uses the python integration
```

To set parameters, list it explicitly:

```yaml
spec:
  integrations:
    - name: nodejs
      params:
        esmHook: true
```

**Databases and proxies.** These are always listed explicitly, because they need an address, and usually a credential:

```yaml
spec:
  type: database
  integrations:
    - name: postgresql
      params:
        endpoint: orders-db:5432
        password: ${secret:ORDERS_DB_MONITOR_PASSWORD}
```

Credentials are only accepted as references to [secrets](../15-users-and-security.md#secrets); a password written into a file is refused.

## What each integration gives you

| Integration      | Dashboard sections                                          | Alerts                                               | SLOs                                      |
| ---------------- | ----------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------- |
| Node.js          | Golden signals, routes, dependencies, runtime, logs, traces | High error rate, high latency, telemetry stopped     | Availability, latency, throughput, custom |
| Python, Java, Go | Golden signals, routes, dependencies, logs, traces          | High error rate, high latency, telemetry stopped     | Availability, latency, throughput, custom |
| PostgreSQL       | Connections, transactions, cache hit ratio, deadlocks, size | Unreachable, connections near limit, deadlocks       | Custom                                    |
| Redis            | Clients, commands, hit ratio, memory, evictions             | Unreachable, memory near limit, rejected connections | Custom                                    |
| Nginx            | Requests, connections, dropped connections                  | Unreachable, dropping connections                    | Custom                                    |
| Containers       | CPU, memory, restarts                                       | –                                                    | –                                         |

The [Alerts](../09-alerts.md) page lists every alert and when it fires.

## Other technologies

For a language or system without an integration, send OpenTelemetry data yourself (see [Connecting a service](../05-connecting-a-service.md#a-language-without-an-integration)), or add an integration for it to your workspace: see [Writing integrations](writing-integrations.md).
