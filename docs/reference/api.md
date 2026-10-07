# HTTP API

The Raion web UI uses this API; scripts can too. All routes are under `/api/v1` on the Raion server (by default `http://127.0.0.1:7600`).

## Using the API from a script

### API tokens

Scripts use a personal API token. Create one on your account page in the web UI (click your username in the top bar); see [API tokens](../15-users-and-security.md#api-tokens). Send it in an `Authorization` header:

```sh
RAION=http://127.0.0.1:7600
export RAION_TOKEN=…   # paste it, or read it from your CI system's secret store

curl -s -H "Authorization: Bearer $RAION_TOKEN" "$RAION/api/v1/services"

curl -s -H "Authorization: Bearer $RAION_TOKEN" -H 'content-type: application/json' \
  -d '{"service":"checkout","name":"availability","sli":{"type":"availability"},"target":99.9,"window":"30d"}' \
  "$RAION/api/v1/slos"
```

- Requests with a token need no CSRF header.
- A token that is malformed, unknown, revoked or expired gets `401` with code `invalid_token`, even if the request also carries a session cookie.
- A token can do what its role allows, except manage accounts, passwords and tokens: those routes answer `403` with code `session_required`.
- Actions done with a token are audited under your name with `"token": "<name>"` in the details.

### With a session

The web UI signs in and keeps a session cookie. A script can do the same, but a token is simpler and safer. Every request that changes something must then carry the header `x-raion-csrf: 1`.

```sh
# Sign in and keep the session cookie in a file
curl -s -c raion.cookies -H 'content-type: application/json' -H 'x-raion-csrf: 1' \
  -d '{"username":"alice","password":"…"}' "$RAION/api/v1/auth/login"

curl -s -b raion.cookies "$RAION/api/v1/services"

# Sign out
curl -s -b raion.cookies -X POST -H 'x-raion-csrf: 1' "$RAION/api/v1/auth/logout"
```

Delete the cookie file afterwards. Passwords typed on the command line can end up in your shell history; type them interactively or read them from a file.

### Audit log

`GET /api/v1/audit` returns entries newest first. Query parameters:

| Parameter | Does                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------- |
| `limit`   | How many entries, 1 to 500 (default 100)                                                                            |
| `before`  | Only entries older than this entry ID, to page back                                                                 |
| `actor`   | Only entries by this username                                                                                       |
| `action`  | Only this action, and the actions under it: `user` matches `user.create` and `user.update`; `login` matches `login` |

## Routes

The role is the minimum needed. Responses are JSON; errors look like `{ "error": { "code": "…", "message": "…" } }`. Routes marked _session_ cannot be used with an API token.

### Accounts

| Method and path           | Role            | Does                                                                                        |
| ------------------------- | --------------- | ------------------------------------------------------------------------------------------- |
| `GET /setup`              | –               | Whether the first admin still needs to be created                                           |
| `POST /setup`             | –               | Create the first admin with the setup token                                                 |
| `GET /auth/methods`       | –               | How people can sign in: `{ password, sso: { displayName } or null }`                        |
| `POST /auth/login`        | –               | Sign in with a password (`403 password_login_disabled` when only single sign-on is allowed) |
| `GET /auth/oidc/start`    | –               | Start single sign-on (a browser redirect; `?next=` is the Raion page to return to)          |
| `GET /auth/oidc/callback` | –               | Where the identity provider sends the browser back                                          |
| `POST /auth/logout`       | –               | Sign out                                                                                    |
| `GET /auth/me`            | viewer          | The signed-in user                                                                          |
| `POST /auth/password`     | viewer, session | Change your own password (`currentPassword`, `newPassword`); `204` and a new session        |
| `GET /tokens`             | viewer, session | Your API tokens; admins add `?all=true` for everyone's                                      |
| `POST /tokens`            | viewer, session | Create a token (`name`, `role`, `expiresInDays` 1–366); the token is in the response once   |
| `DELETE /tokens/:id`      | viewer, session | Revoke your token (admins: anyone's)                                                        |
| `GET /users`              | admin, session  | List users                                                                                  |
| `POST /users`             | admin, session  | Create a user (`username`, `password`, `role`)                                              |
| `PATCH /users/:username`  | admin, session  | Change `role`, `disabled` or `password` (role and password not for single sign-on accounts) |
| `GET /audit`              | admin           | The audit log, newest first; see [Audit log](#audit-log)                                    |

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
