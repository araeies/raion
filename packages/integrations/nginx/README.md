# Nginx

The collector reads Nginx's `stub_status` page.

**Dashboard:** requests per second, connections by state, dropped connections.

**Alerts:** `ServiceUnreachable` and `NginxDroppingConnections`.

Enable `stub_status` where only the observability network can reach it, for example on an unpublished port:

```nginx
server {
  listen 8081;
  location = /nginx_status { stub_status; }
}
```

```yaml
integrations:
  - name: nginx
    params:
      endpoint: http://edge:8081/nginx_status
containerLogs: true # also keep the access and error logs
```

See the [integrations guide](../../../docs/guides/integrations.md#nginx).
