# PostgreSQL

The collector connects with a monitoring user and reads PostgreSQL's statistics views. That user can read statistics, but no data.

Names such as `orders-db` and `ORDERS_DB_MONITOR_PASSWORD` on this page are examples: use your own. See [names in the examples](../README.md#names-in-the-examples).

1. Create the user:

   ```sql
   CREATE USER raion_monitor WITH PASSWORD '…';
   GRANT pg_monitor TO raion_monitor;
   ```

2. Store the password: `raion secrets set ORDERS_DB_MONITOR_PASSWORD`.
3. Describe the database as a service:

   ```yaml
   # services/orders-db.yaml
   apiVersion: raion/v1alpha1
   kind: Service
   metadata:
     name: orders-db
   spec:
     type: database
     tier: critical
     runtime: { type: compose } # or host, for a database outside Docker
     integrations:
       - name: postgresql
         params:
           endpoint: orders-db:5432 # as the collector reaches it
           password: ${secret:ORDERS_DB_MONITOR_PASSWORD}
   ```

4. Run `raion apply`, then `raion connect --out observability.override.yaml` and restart the database's container with the override, so the collector can reach it.
5. Check it: `raion verify --service orders-db`.

| Parameter      | Default         | Meaning                                                                   |
| -------------- | --------------- | ------------------------------------------------------------------------- |
| `endpoint`     | required        | `host:port` as the collector reaches it                                   |
| `username`     | `raion_monitor` | The monitoring user                                                       |
| `password`     | required        | `${secret:NAME}` or `${env:NAME}`; a value written in the file is refused |
| `tls`          | `false`         | Connect with TLS and verify the certificate                               |
| `tableMetrics` | `false`         | Also per-table and per-index metrics (their number grows with the schema) |

**You get:**

- **Dashboard:** connections against `max_connections`, transactions and rollbacks, cache hit ratio, deadlocks, rows read and size, each per database.
- **Alerts:**
  - `ServiceUnreachable`: the collector cannot read the database. Critical for a critical-tier service.
  - `PostgresConnectionsNearLimit`: over 85% of connections in use for 10 minutes.
  - `PostgresDeadlocks`.

The password is mounted into the collector as a file and referenced as `${file:…}`; it never appears in generated configuration.

## Troubleshooting

| Symptom                                                               | What to check                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `raion verify --service` says the collector fails to read the service | Is it on the observability network (started with the override from `raion connect`)? Is `endpoint` right? Is the stored password correct (`raion secrets set`)? The collector's log names the error: `docker logs <project>-otel-collector-1` (the project is `raion` unless you changed `target.compose.projectName`). |
| A service running on this machine (not in Docker) cannot be reached   | Use `host.docker.internal:<port>` as the endpoint and `runtime: { type: host }`; Raion then lets the collector resolve that name, on Linux too.                                                                                                                                                                         |
