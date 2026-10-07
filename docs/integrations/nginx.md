# Nginx

Enable `stub_status` on a location that only the observability network can reach. The example uses a second, unpublished port:

```nginx
server {
  listen 8081;
  location = /nginx_status { stub_status; }
}
```

Then describe it:

```yaml
# services/edge.yaml
apiVersion: raion/v1alpha1
kind: Service
metadata:
  name: edge
spec:
  type: web
  runtime: { type: compose }
  containerLogs: true # also keep the access and error logs
  integrations:
    - name: nginx
      params:
        endpoint: http://edge:8081/nginx_status
```

Run `raion apply`, start Nginx with the override from `raion connect`, and check it with `raion verify --service edge`.

**You get:**

- **Dashboard:** requests per second, connections by state, and dropped connections.
- **Alerts:** `ServiceUnreachable` and `NginxDroppingConnections`.

`stub_status` has no status codes. Add `containerLogs: true` to keep Nginx's access and error logs in Loki, and look at the upstream services for errors.

## Troubleshooting

| Symptom                                                               | What to check                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `raion verify --service` says the collector fails to read the service | Is it on the observability network (started with the override from `raion connect`)? Is `endpoint` right? Is the stored password correct (`raion secrets set`)? The collector's log names the error: `docker logs <project>-otel-collector-1` (the project is `raion` unless you changed `target.compose.projectName`). |
| A service running on this machine (not in Docker) cannot be reached   | Use `host.docker.internal:<port>` as the endpoint and `runtime: { type: host }`; Raion then lets the collector resolve that name, on Linux too.                                                                                                                                                                         |
| No access logs                                                        | Set `containerLogs: true` and start the container with the override; see [Docker containers](docker.md#container-logs).                                                                                                                                                                                                 |
