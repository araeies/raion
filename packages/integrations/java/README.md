# Java

Monitors Java applications with the [OpenTelemetry Java agent](https://opentelemetry.io/docs/zero-code/java/agent/): request metrics, distributed traces and logs, with no change to your code.

## What you get

- **Requests:** how many, how many fail, and how fast, per route. Works with Spring Boot, servlet containers (Tomcat, Jetty, Undertow), Netty, Vert.x, Micronaut, Quarkus and more.
- **Traces:** the path of each request through your applications, into databases (JDBC), caches, message queues and outgoing HTTP calls.
- **Logs:** records from Logback, Log4j 2 and `java.util.logging`, each linked to the request it belongs to.

## How Raion connects it

For an application in Docker Compose, Raion adds the agent when the container starts: a small helper container copies the agent from Raion's pinned OpenTelemetry image into a shared volume, and the application loads it through `JAVA_TOOL_OPTIONS`. Your image and your code do not change.

To connect it, add the application in Raion (choose Java), then restart it with the settings Raion prepares (the application's **Connect** tab shows them, or use `raion connect --out observability.override.yaml`).

## Adding the agent yourself

When the application does not run in Docker Compose, or you prefer to ship the agent in your image, set `injectAgent: false`:

```yaml
spec:
  integrations:
    - name: java
      params:
        injectAgent: false
```

Then download `opentelemetry-javaagent.jar` from the [opentelemetry-java-instrumentation releases](https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases) and start Java with `-javaagent:/path/to/opentelemetry-javaagent.jar`. Raion's settings (shown on the **Connect** tab) tell the agent where to send data.

## Things to know

- If your application already sets `JAVA_TOOL_OPTIONS`, combine both values.
- The agent adds a few seconds to start-up and some memory (typically 50–100 MB).
- Java 8 and newer are supported.
