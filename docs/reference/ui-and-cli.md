# Web UI and command line

Raion has two complete ways in: the **web UI**, for people who prefer to click, and the **`raion` command**, for terminals, scripts and CI/CD. Both are built on the same core: the same validation, the same configuration engine, the same deployment, Advisor, alerts and audit log. A change made in one is immediately visible in the other.

- [How the two fit together](#how-the-two-fit-together)
- [Who may do what](#who-may-do-what)
- [Long-running operations](#long-running-operations)
- [Output for scripts and exit codes](#output-for-scripts-and-exit-codes)
- [Every capability, in both](#every-capability-in-both)

## How the two fit together

- **One engine.** The CLI and the web server call the same functions. Saving an application's settings on its page and running `raion services set` go through the same editing engine: the whole workspace is checked with the change before anything is written, comments in your files are kept, and a file someone else changed in the meantime is never overwritten.
- **One set of files.** Everything Raion knows lives in your workspace folder (`raion.yaml`, `services/`, `slos/`). The web UI writes the same files you could edit by hand, so the web UI, the CLI, Git and your editor never disagree.
- **One state.** Users, sessions, API tokens, the audit log, alert history and the record of operations live in the workspace's `.raion/` folder, read by both.
- **The CLI does not need the web UI.** Every command works with only the workspace folder and Docker; `raion server` is only needed for the web UI and the HTTP API.

## Who may do what

| Who                         | How they are identified                                                | What they may do                                                                                |
| --------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| A person in the web UI      | Their Raion account (password or single sign-on)                       | What their role allows: viewer, editor or admin ([roles](../15-users-and-security.md#roles))    |
| A script using the HTTP API | A personal API token                                                   | What the token's role allows, never more than its owner's role; never accounts or tokens        |
| Someone running `raion`     | Their operating-system account on the machine that holds the workspace | Everything: the CLI reads the workspace's state directly, like an administrator on that machine |

Every change is recorded in the same audit log, whichever way it was made. Changes from the CLI are recorded as `cli:<operating-system user>`, so `raion audit` and the **Audit log** page show who did what from anywhere.

Because the CLI acts as an administrator, give access to the machine (and to the workspace's `.raion/` folder) only to people who are Raion administrators.

## Long-running operations

Deploying, rolling back, restoring, stopping, testing the pipeline and restarting an application with Raion's settings can take a while. Wherever they are started:

- **Recorded:** each one is recorded in `.raion/operations/`, with who started it, from where (web UI, API or command line), its progress log and its outcome. The **Observability stack → Activity** tab and `raion activity` show the same list.
- **Followed live:** a deployment started in a terminal appears live in the web UI, and the other way round.
- **Never twice at once:** a change to the stack is refused while another one runs, with a message saying who started it and where. A lock that its holder keeps refreshing prevents two deployments even across machines that share the workspace.
- **Interruptions are visible:** if the process running an operation stops (a closed terminal, a crash), the operation is shown as _interrupted_ instead of running forever, and its lock is released.

## Output for scripts and exit codes

Commands that report something accept `--format json`. In JSON mode, progress messages go to standard error and standard output carries exactly one JSON document, so scripts can parse it.

| Exit code | Meaning                                                                                                                           |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 0         | Success                                                                                                                           |
| 1         | The command ran, but the result is a failure: invalid configuration, a failed deployment or check, something not found            |
| 2         | The command was refused: a mistake in how it was called, a missing confirmation (`--yes`), or another operation is running        |
| 3         | `raion drift`: the running stack differs from the deployed release. `raion plan --detailed-exitcode`: there are changes to deploy |
| 70        | An unexpected error (please report it)                                                                                            |
| 130       | Cancelled with Ctrl+C                                                                                                             |

Commands that change something ask for confirmation in a terminal; scripts pass `--yes`. Editing commands accept `--dry-run` to show the change without writing it.

## Every capability, in both

The HTTP API column lists the route for scripts; the web UI uses the same routes.

### Applications and reliability goals

| Capability                                          | Web UI                                           | Command                   | HTTP API                                   |
| --------------------------------------------------- | ------------------------------------------------ | ------------------------- | ------------------------------------------ |
| Add an application                                  | **Applications → Add an application**            | `raion services add`      | `POST /workspace/edits` (`service.add`)    |
| List applications                                   | **Applications**                                 | `raion services list`     | `GET /services`                            |
| Change an application                               | Application → **Settings**                       | `raion services set`      | `POST /workspace/edits` (`service.update`) |
| Stop monitoring an application                      | Application → **Settings** → Stop monitoring     | `raion services remove`   | `POST /workspace/edits` (`service.remove`) |
| Find what runs on this machine                      | **Add an application** → Running on this machine | `raion discover`          | `GET /discovery`                           |
| How to connect an application                       | Application → **Connect**                        | `raion connect`           | `GET /services/:name/connect`              |
| Restart a running application with Raion's settings | Application → **Connect** → Connect it for me    | `raion connect --restart` | `POST /services/:name/connect-running`     |
| What an application sends                           | Application → **Overview**                       | `raion verify --service`  | `GET /services/:name/telemetry`            |
| How an application behaved recently                 | Application → **Overview** → Over time           | `raion history`           | `GET /services/:name/history`              |
| List reliability goals                              | **Reliability goals**                            | `raion slo list`          | `GET /slos`                                |
| Set a reliability goal                              | **Reliability goals → Set a goal**               | `raion slo add`           | `POST /workspace/edits` (`slo.add`)        |
| Change a reliability goal                           | Goal → **Change**                                | `raion slo set`           | `POST /workspace/edits` (`slo.update`)     |
| Remove a reliability goal                           | Goal → **Remove**                                | `raion slo remove`        | `POST /workspace/edits` (`slo.remove`)     |
| Export goals as OpenSLO                             | **Reliability goals** → OpenSLO format           | `raion slo export`        | `GET /slos/openslo`                        |
| Import OpenSLO goals                                | Command line only: it reads a file you have      | `raion slo import`        |                                            |

### Monitoring, alerts and the Advisor

| Capability                             | Web UI                                                            | Command                   | HTTP API                      |
| -------------------------------------- | ----------------------------------------------------------------- | ------------------------- | ----------------------------- |
| See alerts, and whether alerting works | **Alerts**                                                        | `raion alerts`            | `GET /alerts`                 |
| Silence an alert                       | Alert → **Silence…**                                              | `raion alerts silence`    | `POST /alerts/silences`       |
| List silences                          | **Alerts** → Silenced                                             | `raion alerts silences`   | `GET /alerts/silences`        |
| End a silence                          | **Alerts** → End silence                                          | `raion alerts unsilence`  | `DELETE /alerts/silences/:id` |
| Recommendations                        | **Advisor**                                                       | `raion advise`            | `GET /advisor`                |
| Apply a recommended fix                | **Advisor** → Fix it for me                                       | `raion advise --apply`    | `POST /advisor/apply`         |
| List integrations                      | **Integrations**                                                  | `raion integrations list` | `GET /integrations`           |
| Lock workspace integration packages    | Command line only: a reviewable step, committed with the packages | `raion integrations lock` |                               |

### The observability stack

| Capability                          | Web UI                                                    | Command                                | HTTP API                 |
| ----------------------------------- | --------------------------------------------------------- | -------------------------------------- | ------------------------ |
| Check the configuration             | Problems are shown on **Home** and **Settings**           | `raion validate`                       | `GET /workspace`         |
| What deploying would change         | **Observability stack → Changes to deploy**               | `raion plan`                           | `GET /runtime`           |
| Deploy                              | **Observability stack → Deploy**                          | `raion apply`                          | `POST /runtime/apply`    |
| Status of every component           | **Observability stack → Components**                      | `raion status`                         | `GET /runtime`           |
| Test the pipeline                   | **Observability stack → Test the pipeline**               | `raion verify`                         | `POST /runtime/verify`   |
| Changes made outside Raion          | **Observability stack** (notice)                          | `raion drift`                          | `GET /runtime`           |
| Restore the deployed release        | **Observability stack** → Restore release                 | `raion drift --repair`                 | `POST /runtime/repair`   |
| Roll back to an earlier release     | **Observability stack → Releases**                        | `raion rollback`                       | `POST /runtime/rollback` |
| Stop the stack                      | **Observability stack → Advanced** → Stop monitoring      | `raion destroy`                        | `POST /runtime/stop`     |
| Recent operations                   | **Observability stack → Activity**                        | `raion activity`                       | `GET /runtime/jobs`      |
| Generated configuration             | **Observability stack → Advanced**                        | `raion render` (writes it to a folder) | `GET /runtime/files/*`   |
| Compare two versions of a workspace | Command line only: it compares folders, for pull requests | `raion diff`                           |                          |

### Workspace settings

| Capability                                | Web UI                                                     | Command                                                                        | HTTP API                                     |
| ----------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------- |
| Create a workspace                        | Command line, once; afterwards **Add an application**      | `raion init`                                                                   |                                              |
| Level, data retention, machine monitoring | **Settings → General**                                     | `raion settings`                                                               | `POST /workspace/edits` (`workspace.update`) |
| Notification channels                     | **Settings → Notifications**                               | `raion receivers list`, `raion receivers add`, `raion receivers remove`        | `POST /workspace/edits` (`receiver.*`)       |
| Teams                                     | **Settings → Teams**                                       | `raion teams list`, `raion teams add`, `raion teams set`, `raion teams remove` | `POST /workspace/edits` (`team.*`)           |
| Set a secret                              | **Observability stack → Secrets**                          | `raion secrets set`                                                            | `PUT /secrets/:key`                          |
| Which secrets are needed                  | **Observability stack → Secrets**                          | `raion secrets list`                                                           | `GET /secrets`                               |
| Delete a secret                           | **Observability stack → Secrets** (secrets no longer used) | `raion secrets remove`                                                         | `DELETE /secrets/:key`                       |
| JSON Schema for editors                   | Command line only: for your code editor                    | `raion schema`                                                                 |                                              |
| Start the web UI                          |                                                            | `raion server`                                                                 |                                              |

### People and access

| Capability                   | Web UI                                               | Command                                                           | HTTP API                                   |
| ---------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------ |
| Add a person                 | **People → Add a person**                            | `raion users add`                                                 | `POST /users`                              |
| List people                  | **People**                                           | `raion users list`                                                | `GET /users`                               |
| Change a role                | **People** → role                                    | `raion users set-role`                                            | `PATCH /users/:username`                   |
| Disable or enable an account | **People** → Disable / Enable                        | `raion users disable`, `raion users enable`                       | `PATCH /users/:username`                   |
| Reset a password             | **People** → Reset password                          | `raion users reset-password`                                      | `PATCH /users/:username`                   |
| API tokens                   | **Your account** (your own); **People** (everyone's) | `raion tokens list`, `raion tokens create`, `raion tokens revoke` | `GET`/`POST /tokens`, `DELETE /tokens/:id` |
| Audit log                    | **Audit log**                                        | `raion audit`                                                     | `GET /audit`                               |
