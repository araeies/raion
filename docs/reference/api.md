# HTTP API

The Raion web UI uses this API; scripts can too. All routes are under `/api/v1` on the Raion server (by default `http://127.0.0.1:7600`).

## Using the API from a script

The API uses the same session as the web UI: sign in, keep the session cookie, and send it with each request. Every request that changes something must also carry the header `x-raion-csrf: 1`.

```sh
RAION=http://127.0.0.1:7600

# Sign in and keep the session cookie in a file
curl -s -c raion.cookies -H 'content-type: application/json' -H 'x-raion-csrf: 1' \
  -d '{"username":"alice","password":"…"}' "$RAION/api/v1/auth/login"

# Read
curl -s -b raion.cookies "$RAION/api/v1/services"

# Sign out
curl -s -b raion.cookies -X POST -H 'x-raion-csrf: 1' "$RAION/api/v1/auth/logout"
```

Delete the cookie file afterwards. Passwords typed on the command line can end up in your shell history; type them interactively or read them from a file.

### Changing a password

```sh
curl -s -b raion.cookies -c raion.cookies -H 'content-type: application/json' -H 'x-raion-csrf: 1' \
  -d '{"currentPassword":"…","newPassword":"…"}' "$RAION/api/v1/auth/password"
```

A `204` response means it worked. All your sessions, including web UI tabs, are signed out; the response carries a new session, which `-c` saves. An admin resets someone else's password with:

```sh
curl -s -b raion.cookies -X PATCH -H 'content-type: application/json' -H 'x-raion-csrf: 1' \
  -d '{"password":"…"}' "$RAION/api/v1/users/bob"
```

## Routes

The role is the minimum needed. Responses are JSON; errors look like `{ "error": { "code": "…", "message": "…" } }`.

### Accounts

| Method and path          | Role   | Does                                                           |
| ------------------------ | ------ | -------------------------------------------------------------- |
| `GET /setup`             | –      | Whether the first admin still needs to be created              |
| `POST /setup`            | –      | Create the first admin with the setup token                    |
| `POST /auth/login`       | –      | Sign in                                                        |
| `POST /auth/logout`      | –      | Sign out                                                       |
| `GET /auth/me`           | viewer | The signed-in user                                             |
| `POST /auth/password`    | viewer | Change your own password                                       |
| `GET /users`             | admin  | List users                                                     |
| `POST /users`            | admin  | Create a user (`username`, `password`, `role`)                 |
| `PATCH /users/:username` | admin  | Change `role`, `disabled` or `password`                        |
| `GET /audit`             | admin  | The audit log, newest first (`?limit=` and `?before=` to page) |

### Workspace and services

| Method and path                 | Role   | Does                                                                     |
| ------------------------------- | ------ | ------------------------------------------------------------------------ |
| `GET /workspace`                | viewer | Workspace name, level, environment, and configuration problems           |
| `GET /services`                 | viewer | All services                                                             |
| `GET /services/:name`           | viewer | One service, its dependents, and the files that define it                |
| `GET /services/:name/telemetry` | viewer | What the service sends: the checks behind its Health section             |
| `GET /services/:name/connect`   | viewer | How to connect it: requirements, environment variables, Compose override |
| `GET /integrations`             | viewer | Available integrations with their documentation                          |

### Observability stack

| Method and path         | Role   | Does                                                                                 |
| ----------------------- | ------ | ------------------------------------------------------------------------------------ |
| `GET /runtime`          | viewer | Status, pending changes, drift, components, files, releases, dashboards              |
| `GET /runtime/files/*`  | viewer | One generated file                                                                   |
| `POST /runtime/apply`   | editor | Apply pending changes (`allowPrivileged`, `allowDataChanges`: admins); returns a job |
| `POST /runtime/verify`  | editor | Test the pipeline; returns a job                                                     |
| `POST /runtime/repair`  | editor | Restore the deployed release after drift; returns a job                              |
| `GET /runtime/jobs/:id` | viewer | Progress and result of a job                                                         |
| `GET /secrets`          | admin  | Which secrets are needed and whether each is set (never values)                      |
| `PUT /secrets/:key`     | admin  | Set a secret (`value`)                                                               |
| `DELETE /secrets/:key`  | admin  | Remove a secret                                                                      |

### Alerts, SLOs and the Advisor

| Method and path               | Role   | Does                                                                         |
| ----------------------------- | ------ | ---------------------------------------------------------------------------- |
| `GET /alerts`                 | viewer | Firing and recently resolved alerts, alert rules, and whether alerting works |
| `GET /alerts/silences`        | viewer | Active silences                                                              |
| `POST /alerts/silences`       | editor | Silence an alert                                                             |
| `DELETE /alerts/silences/:id` | editor | Remove a silence                                                             |
| `GET /slos`                   | viewer | Every SLO with its status (`?service=` to filter)                            |
| `GET /slos/openslo`           | viewer | All SLOs in OpenSLO v1 format (YAML)                                         |
| `POST /slos`                  | editor | Create an SLO                                                                |
| `GET /advisor`                | viewer | Advisor findings                                                             |
| `POST /advisor/apply`         | editor | Apply a finding's fix (`id`)                                                 |

## Health of the server itself

`GET /healthz` (the server is up) and `GET /readyz` (it can serve requests) answer without signing in. `GET /metrics` (Prometheus format) answers only to requests from the same machine.
