# Java

Connects Java applications **without changing their code or their image**, with the [OpenTelemetry Java agent](https://opentelemetry.io/docs/zero-code/java/agent/).

Names such as `my-app` on this page are examples: use your own. See [names in the examples](../README.md#names-in-the-examples).

## What you get

| Signal  | What                                                                                                                                           | Where to look                                |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Metrics | Request rate, errors and response time per route (Spring Boot, Tomcat, Jetty, Undertow, Netty, Vert.x, Micronaut, Quarkus…), JVM memory and GC | The application's page in Raion, and Grafana |
| Traces  | The path of each request through your applications, into databases (JDBC), caches, message queues and outgoing HTTP calls                      | Grafana → Explore (Tempo)                    |
| Logs    | Records from Logback, Log4j 2 and `java.util.logging`, each linked to the request it belongs to                                                | Grafana → Explore (Loki)                     |

## Connecting it

In the web UI, **Add an application**, choose **Docker Compose** and **Java**: nothing else is needed. On its **Connect** tab, **Connect it for me** restarts it with Raion's settings (admins), or copy the steps to restart it yourself.

How it works: when the container starts, a small helper container copies the agent from Raion's pinned OpenTelemetry image into a shared, read-only volume, and Java loads it through `JAVA_TOOL_OPTIONS`. Your image and your code do not change. The helper has no network access and no privileges, and exits once the agent is copied.

From the command line: `raion services add my-app --type api --language java`, then `raion connect --restart my-app` (or `raion connect --out observability.override.yaml` and restart it yourself).

## Parameters

```yaml
integrations:
  - name: java
    params:
      injectAgent: true # default
```

| Parameter     | Default | Meaning                                                                                                                                                |
| ------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `injectAgent` | `true`  | Add the agent when the container starts (Docker Compose only). Set `false` when the application runs directly on a machine, or ships the agent itself. |

## Adding the agent yourself

When the application does not run in Docker Compose, or you prefer to ship the agent in your image, set `injectAgent: false`. Download `opentelemetry-javaagent.jar` from the [opentelemetry-java-instrumentation releases](https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases) and start Java with `-javaagent:/path/to/opentelemetry-javaagent.jar`. The **Connect** tab (or `raion connect --service <name> --format shell`) gives the settings that tell the agent where to send data.

## Troubleshooting

| Symptom                                     | Cause and fix                                                                                                                                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nothing arrives                             | The application already sets `JAVA_TOOL_OPTIONS` in its compose file, which replaces Raion's. Combine both values.                                                                        |
| Nothing arrives from `java File.java`       | The agent turns itself off for JDK tools, including the single-file source launcher. Compile the program and run it with `java -cp …`, as any real deployment does.                       |
| Slower start-up, more memory                | Expected: the agent adds a few seconds at start-up and typically 50–100 MB of memory.                                                                                                     |
| `raion verify --service` reports no metrics | The application has not handled requests since it was connected, or cannot reach the collector: check that its container is on the `raion-ingest` network (`docker inspect <container>`). |

Java 8 and newer are supported.
