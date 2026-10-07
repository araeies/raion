#!/bin/sh
# Creates the shop's table and a read-only monitoring user for Raion.
set -eu
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v monitor_password="$MONITOR_PASSWORD" <<'SQL'
CREATE TABLE products (id integer PRIMARY KEY, name text NOT NULL);
INSERT INTO products SELECT i, 'Product ' || i FROM generate_series(1, 50) AS i;
-- pg_monitor can read statistics, but no table data.
CREATE USER raion_monitor WITH PASSWORD :'monitor_password';
GRANT pg_monitor TO raion_monitor;
SQL
