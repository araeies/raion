# Redis

The collector reads Redis's `INFO`. Nothing changes in the applications.

**Dashboard:** clients, commands per second, hit ratio, memory against `maxmemory`, evicted and expired keys, rejected connections.

**Alerts:** `ServiceUnreachable`, `RedisMemoryNearLimit` and `RedisRejectingConnections`.

```yaml
integrations:
  - name: redis
    params:
      endpoint: cache:6379
      # password: ${secret:CACHE_PASSWORD}   # if Redis requires one
```

Parameters: `endpoint` (required), `username` (ACL user), `password` (a secret reference), `tls` (default false). See the [integrations guide](../../../docs/guides/integrations.md#redis).
