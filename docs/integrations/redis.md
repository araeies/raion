# Redis

| Parameter  | Default  | Meaning                                     |
| ---------- | -------- | ------------------------------------------- |
| `endpoint` | required | `host:port`                                 |
| `username` | –        | ACL user, if Redis uses ACLs                |
| `password` | –        | `${secret:NAME}`, if Redis needs one        |
| `tls`      | `false`  | Connect with TLS and verify the certificate |

```yaml
# services/cache.yaml
apiVersion: raion/v1alpha1
kind: Service
metadata:
  name: cache
spec:
  type: database
  runtime: { type: compose }
  integrations:
    - name: redis
      params:
        endpoint: cache:6379
        # password: ${secret:CACHE_PASSWORD}    # if Redis requires one
```

With ACLs, a user that may run `INFO` is enough: `ACL SETUSER raion_monitor on >… +info +ping`.

Run `raion apply`, start Redis with the override from `raion connect`, and check it with `raion verify --service cache`.

**You get:**

- **Dashboard:** clients, commands per second, hit ratio, memory against `maxmemory`, evicted and expired keys, rejected connections.
- **Alerts:** `ServiceUnreachable`, `RedisMemoryNearLimit` (over 90% of `maxmemory`) and `RedisRejectingConnections`.

## Troubleshooting

| Symptom                                                               | What to check                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `raion verify --service` says the collector fails to read the service | Is it on the observability network (started with the override from `raion connect`)? Is `endpoint` right? Is the stored password correct (`raion secrets set`)? The collector's log names the error: `docker logs <project>-otel-collector-1` (the project is `raion` unless you changed `target.compose.projectName`). |
| A service running on this machine (not in Docker) cannot be reached   | Use `host.docker.internal:<port>` as the endpoint and `runtime: { type: host }`; Raion then lets the collector resolve that name, on Linux too.                                                                                                                                                                         |
