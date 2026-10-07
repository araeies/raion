# What is Raion?

Raion is an observability platform for teams that want production-grade monitoring without assembling it themselves. You describe your services in a few YAML files. Raion then sets up, configures and runs a complete open-source observability stack, and gives you a web UI to see how your services are doing.

## What you get

- **Metrics, logs and traces** from your applications, collected with OpenTelemetry. For Node.js and Python this needs no code changes; Go needs one small setup file.
- **Monitoring of databases and proxies** (PostgreSQL, Redis, Nginx) and of Docker containers.
- **Dashboards** for every service, generated and kept up to date for you.
- **Alerts** for errors, slow responses, missing telemetry, unreachable databases, full disks and more, delivered to the Raion inbox and to Slack, email or a webhook.
- **SLOs and error budgets**: reliability targets, measured continuously, with burn-rate alerts.
- **An Advisor** that finds gaps, such as a critical service without an SLO or logs that are not linked to traces, and fixes the safe ones for you.
- **A web UI for your whole team**, with personal accounts, roles, and single sign-on into Grafana.
- **Everything as code**: your configuration lives in Git, and every change can be reviewed before it is deployed.

## How it works

```
 your services (YAML in Git)
          │
          ▼
 raion validate · plan · apply ───────► generated, standard configuration
                                          │
                                          ▼
                    ┌──────────── the observability stack (Docker Compose) ────────────┐
 your applications ─┤ OpenTelemetry Collector ─► Prometheus · Loki · Tempo ─► Grafana  │
   (OTLP)           │                           Alertmanager ─► inbox, Slack, email…  │
                    └─────────────────────────────────────────────────────────────────┘
                                          ▲
 you, in the browser ─► Raion web UI ─────┘  (services, SLOs, alerts, advisor, Grafana)
```

1. **You describe** your services: what they are, who owns them, how critical they are, what they depend on, and how reliable they must be.
2. **Raion generates** the configuration for each open-source component from that description.
3. **Raion deploys** the components on your machine or server with Docker Compose, checks that each one works, and restores the previous version if something fails.
4. **Your applications send** telemetry to the stack. `raion connect` tells you exactly how for each service.
5. **You use** the Raion web UI and Grafana to watch, investigate and improve.

Raion does not replace the open-source tools; it configures them. Everything it generates is ordinary configuration that you can read, export and run without Raion.

## The components

| Component               | Role                                                       |
| ----------------------- | ---------------------------------------------------------- |
| OpenTelemetry Collector | Receives telemetry from your applications; reads databases |
| Prometheus              | Stores metrics; evaluates alert rules and SLOs             |
| Loki                    | Stores logs                                                |
| Tempo                   | Stores traces                                              |
| Grafana                 | Dashboards and exploration                                 |
| Alertmanager            | Groups alerts and sends notifications                      |
| node_exporter           | Metrics of the machine itself                              |
| cAdvisor (optional)     | Metrics of each Docker container                           |
| Gateway                 | The only way into the stack; only Raion holds its key      |

## Ideas you will meet

**Workspace.** A folder of YAML files that describes what to observe: `raion.yaml` plus a `services/` folder (and optionally `slos/`). Keep it in Git. Raion keeps its own state (secrets, deployed versions, user accounts) in a `.raion/` folder next to it, which is never committed.

**Service.** Anything you run and want to observe: an API, a website, a worker, a database. Everything in Raion is organized around services.

**Integration.** Raion's knowledge of a technology, such as Node.js or PostgreSQL. It decides how a service is connected and what Raion can show and alert on for it.

**Level.** How much Raion sets up. You choose a level for the workspace and can override it per service:

| Level            | You get                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| **1 Basic**      | Logs; host CPU, memory, disk and network; request rate, errors and latency; basic alerts and dashboards |
| **2 Production** | Level 1, plus distributed tracing, logs linked to traces, a service map and golden-signal dashboards    |
| **3 SRE**        | Level 2, plus SLOs, error budgets, burn-rate alerts, team alert routing and runbook links               |

**Tier.** How critical a service is: `critical`, `standard` or `best-effort`. Problems with critical services are alerted with higher severity.

**SLO.** A service level objective: a reliability target such as "99.9% of requests succeed over 30 days". The failure the target allows is the **error budget**. See [SLOs and error budgets](10-slos.md).

**Release.** Each time you apply changes, Raion saves the complete configuration as a numbered release, so you can see what is deployed and roll back.

Next: [Installing Raion](02-installing.md).
