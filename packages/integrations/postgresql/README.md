# PostgreSQL

The collector reads PostgreSQL's statistics with a **read-only monitoring user**. Nothing changes in the applications.

**Dashboard:** connections against `max_connections`, transactions and rollbacks, cache hit ratio, deadlocks, rows read and size, per database.

**Alerts:** `ServiceUnreachable`, `PostgresConnectionsNearLimit` and `PostgresDeadlocks`.

## Setup

```sql
CREATE USER raion_monitor WITH PASSWORD '...';
GRANT pg_monitor TO raion_monitor;
```

```sh
raion secrets set ORDERS_DB_MONITOR_PASSWORD
```

```yaml
integrations:
  - name: postgresql
    params:
      endpoint: orders-db:5432
      password: ${secret:ORDERS_DB_MONITOR_PASSWORD}
```

Parameters: `endpoint` (required), `username` (default `raion_monitor`), `password` (required, a secret reference), `tls` (default false), `tableMetrics` (default false). See the [integrations guide](../../../docs/integrations/postgresql.md).
