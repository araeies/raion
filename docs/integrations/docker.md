# Docker containers

For any service that runs in Docker Compose, Raion can show its containers' resource use and collect what the containers write to their output, whatever the language and even without an integration.

## Container metrics

Set `infrastructure.containers: true` in `raion.yaml`. Raion runs cAdvisor, which needs a privileged container, so `raion apply` asks for `--allow-privileged`.

**You get:**

- **Per service:** the dashboard of every service with `runtime: compose` shows its containers' CPU, memory and restarts, matched by Compose service name.
- **Containers dashboard:** **Raion · Containers** shows all containers.

## Container logs

For services that do not send logs themselves, add `containerLogs: true`:

```yaml
spec:
  type: web
  containerLogs: true
```

How it works:

- `raion connect` sets the container's Docker logging driver to `fluentd`, pointing at the collector on `127.0.0.1:24224` (`target.compose.fluentForwardPort`).
- **No privileged access.** Nothing reads Docker's files, and no component gets the Docker socket.
- **Never blocks the container.** The driver runs in asynchronous mode, so a stopped collector does not block or fail the container.
- **`docker logs` keeps working.** Docker keeps a local copy.
- **Only expected services.** The collector accepts lines only from services that have `containerLogs`.

Use it for services without an OpenTelemetry integration. A service that already sends its logs over OTLP would store each line twice (`RAI-W108`); container output never carries trace IDs, so those logs cannot be linked to traces.

## Troubleshooting

| Symptom                                      | What to check                                                                                                                                                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No container logs                            | The container must be started with the override from `raion connect`, which sets the logging driver. `docker inspect <container>` shows `"Type": "fluentd"`.                             |
| No container panels on a service's dashboard | Set `infrastructure.containers: true` and apply with `--allow-privileged` (an admin in the web UI). The panels match the service by its Compose service name (`runtime.composeService`). |
