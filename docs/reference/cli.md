# Command line

The `raion` command does everything the web UI does, for terminals, scripts and CI/CD. It works on its own: it needs the workspace folder and Docker, not the web UI. [Web UI and command line](ui-and-cli.md) maps each page of the web UI to its command.

Names such as `ops-slack`, `ci-deploy` and `shop` on this page are examples: use your own. See [names in the examples](../README.md#names-in-the-examples).

`raion --help` lists the commands; `raion <command> --help` shows each command's options. This page is the same, with explanations.

**Which workspace.** Commands take the workspace folder as an argument (`raion apply observability`), or with `-w`/`--workspace` where shown. Without one, Raion uses the current folder if it contains `raion.yaml`, and `./observability` otherwise.

**For scripts.** Commands that report something accept `--format json`: standard output then carries exactly one JSON document, and progress goes to standard error. Commands that change something ask first in a terminal; pass `-y`/`--yes` in scripts (without it, they refuse rather than wait). Editing commands accept `--dry-run` to show the change without writing it.

**Exit codes.**

| Code | Meaning                                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------------- |
| 0    | Success                                                                                                     |
| 1    | The result is a failure: invalid configuration, a failed deployment or check, something not found           |
| 2    | Refused: wrong usage, a missing `--yes`, or another operation is running                                    |
| 3    | `drift`: the running stack differs from the deployed release; `plan --detailed-exitcode`: changes to deploy |
| 70   | An unexpected error (please report it)                                                                      |
| 130  | Cancelled with Ctrl+C                                                                                       |

**Who you are.** The command line acts as an administrator of the workspace and is recorded in the audit log as `cli:<your operating-system user>`. See [who may do what](ui-and-cli.md#who-may-do-what).

## Setting up

| Command                         | Does                                                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `raion init [dir]`              | Create a workspace (default folder `observability`), asking a few questions                                                        |
| `raion validate [dir]`          | Check the workspace for errors                                                                                                     |
| `raion schema`                  | Print the JSON Schema of workspace files, for editors and CI                                                                       |
| `raion integrations list [dir]` | List the integrations applications can use: built-in, and the workspace's own                                                      |
| `raion integrations lock [dir]` | Record the checksums of the workspace's own integration packages ([Writing integrations](../integrations/writing-integrations.md)) |

**`raion init`** asks its questions, shows your answers and lets you change them before creating anything; Ctrl+C stops without creating anything. With `-y`/`--yes` it answers from flags instead:

- `--name <name>`, `--environment <name>` (default `production`)
- `--level 1`, `2` or `3`
- `--service <name>`
- `--type`: `web`, `api`, `worker`, `database`, `microservice` or `infrastructure`
- `--language`: `nodejs`, `python`, `go`, `java`, `dotnet`, `php` or `other`
- `--runtime`: `compose` or `host`
- `--format` `text` or `json`

**`raion validate`**: `--deep` also runs each component's own validator on the generated configuration (needs Docker); `--format` `text` or `json`.

## Applications

| Command                                | Does                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| `raion services list`                  | List applications                                                                       |
| `raion services add <name>`            | Add an application                                                                      |
| `raion services set <name> [changes…]` | Change an application, e.g. `tier=critical alerts.errorRatePercent=2`                   |
| `raion services remove <name>`         | Stop monitoring an application (its reliability goals go too)                           |
| `raion discover [dir]`                 | List the applications running on this machine, and which ones Raion monitors            |
| `raion connect [dir]`                  | Show how to connect each application, write the Compose override, or restart one        |
| `raion verify [dir] --service <name>`  | Check what one application sends: measurements, logs, traces, and their linking         |
| `raion history <service> [dir]`        | How one application behaved recently: requests, failures, response time, outside checks |

Options:

- **`services add`**:
  - `--type`, `--language`, `--team`, `--tier` (`critical`, `standard` or `best-effort`), `--description`
  - `--runtime` `compose` (the default), `host`, or `remote`: runs elsewhere, watched with `--check`
  - `--compose-service <name>`: its name in your compose file, if different
  - `--container-logs`: collect what the container prints (for applications that do not send logs)
  - `--check <addresses…>`: addresses Raion visits from outside, e.g. `https://shop.example.com/health`
- **`services set`**: changes are `key=value` pairs, with dotted keys for nested settings and JSON for lists, e.g. `checks='[{"url":"https://shop.example.com/health"}]'`. `--unset <keys…>` goes back to the defaults.
- **`services …`**: all take `-w <dir>`; the editing commands take `--dry-run` and `--format` `text` or `json`.
- **`discover`**: `--format` `text` or `json`.
- **`connect`**:
  - `-s`/`--service <name…>`: only these applications
  - `-o`/`--out <file>`: write the override, e.g. `observability.override.yaml`
  - `--format compose` (the default), or `env` or `shell` to print only the environment variables
  - `--restart <service>`: restart that running Compose application with Raion's settings, after showing what will change ([details](../05-connecting-a-service.md#applications-that-already-run)); `-y`/`--yes` skips the question
- **`history`**: `-p`/`--period` `1h` (the default), `6h` or `24h`; `--format` `text` (a sparkline per measurement) or `json` (every point).

## Reliability goals (SLOs)

| Command                                     | Does                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------- |
| `raion slo list [dir]`                      | Every goal with its measurement, error budget left, burn rate, status |
| `raion slo add <service>`                   | Set a goal (asks questions when run interactively)                    |
| `raion slo set <service> <name> <changes…>` | Change a goal, e.g. `target=99.5 window=28d`                          |
| `raion slo remove <service> <name>`         | Remove a goal                                                         |
| `raion slo export [dir]`                    | Write all goals in OpenSLO v1 format                                  |
| `raion slo import <file>`                   | Import OpenSLO goals as new files in `slos/`                          |

Options:

- **`slo list`**: `--format` `text` or `json`.
- **`slo add`**:
  - `-w <dir>`
  - `--type`: `availability`, `latency` or `throughput`
  - `--target <percent>`
  - `--window`: `7d`, `14d`, `28d`, `30d` (the default) or `90d`
  - `--threshold-ms <ms>` (latency) or `--min-rps <rate>` (throughput)
  - `--name`, `--description`, `--policy`
- **`slo set`** and **`slo remove`**: `-w <dir>`, `--dry-run`, `--format` `text` or `json`.
- **`slo export`**: `-o`/`--out <file>`.
- **`slo import`**: `-w <dir>`, `--service <name>`.

## Alerts and the Advisor

| Command                        | Does                                                                   |
| ------------------------------ | ---------------------------------------------------------------------- |
| `raion alerts [dir]`           | What is firing or about to fire, explained, and whether alerting works |
| `raion alerts silence <alert>` | Stop notifications for an alert for a while; it stays visible          |
| `raion alerts silences`        | List active silences                                                   |
| `raion alerts unsilence <id>`  | End a silence early                                                    |
| `raion advise [dir]`           | Find gaps in your monitoring                                           |

Options:

- **`alerts`** and **`alerts silences`**: `--format` `text` or `json`.
- **`alerts silence`**: `--service <name>` (only for this application), `--for <duration>` (e.g. `1h`, `4h`, `2d`; at most `7d`), `--reason <text>` (everyone sees it).
- **`alerts silence`**, **`silences`**, **`unsilence`**: `-w <dir>`.
- **`advise`**:
  - `--offline`: configuration only, without querying the stack
  - `--all`: include ignored findings
  - `--fail-on` `critical`, `warning` or `info`: exit with 1, for CI
  - `--apply <finding>`: write a finding's fix; `-y`/`--yes` skips the confirmation
  - `--format` `text` or `json`

## Workspace settings

| Command                             | Does                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `raion settings <changes…>`         | Change workspace settings, e.g. `level=3 retention.logs=14d`                |
| `raion receivers list`              | List notification channels                                                  |
| `raion receivers add <name>`        | Add a notification channel; its credentials are read from secrets           |
| `raion receivers remove <name>`     | Remove a notification channel                                               |
| `raion teams list`                  | List teams                                                                  |
| `raion teams add <name>`            | Add a team                                                                  |
| `raion teams set <name> [changes…]` | Change a team, e.g. `route=ops-slack`                                       |
| `raion teams remove <name>`         | Remove a team (no application may still belong to it)                       |
| `raion secrets set <name>`          | Store a secret, used in workspace files as `${secret:NAME}`; prompts for it |
| `raion secrets list`                | Which secrets are needed and whether each is set; never shows values        |
| `raion secrets remove <name>`       | Delete a secret                                                             |

Options:

- **`settings`**, **`teams set`**: `--unset <keys…>` goes back to the defaults.
- **`receivers add`**: `--type` `slack`, `email` or `webhook`, then:
  - Slack: `--webhook-secret <secret>` (the secret holding the webhook address), `--channel <channel>`
  - email: `--to <addresses…>`, `--from <address>`, `--smarthost <host:port>`, `--username <name>`, `--password-secret <secret>`
  - webhook: `--url <url>`, `--token-secret <secret>` (a bearer token)
- **`teams add`**: `--route <receiver>`: the channel for the team's alerts.
- All take `-w <dir>`; editing commands take `--dry-run` and `--format` `text` or `json`; the `list` commands take `--format`.
- **`secrets set`** reads the value from standard input with `--value-stdin`, for scripts.

## Deploying the observability stack

| Command                          | Does                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `raion plan [dir]`               | Show what deploying would change, without changing anything                                        |
| `raion apply [dir]`              | Deploy or update the stack (shows the plan and asks first)                                         |
| `raion status [dir]`             | Every component's state and health, monitoring of the stack, alerting, drift                       |
| `raion verify [dir]`             | Send test telemetry through the stack and find it in storage                                       |
| `raion rollback [dir]`           | Deploy an earlier release again                                                                    |
| `raion drift [dir]`              | Compare the running stack with the deployed release                                                |
| `raion destroy [dir]`            | Stop the stack                                                                                     |
| `raion activity [id]`            | Deployments, rollbacks, repairs, tests and restarts, from the CLI and the web UI, or one in detail |
| `raion render [dir] --out <dir>` | Write the generated configuration to a folder (it must be empty or new)                            |
| `raion diff <base> [head]`       | Compare two versions of a workspace: components and generated files that would change              |

Only one change to the stack runs at a time, whether it was started here or in the web UI; a second one is refused with exit code 2, saying who started the first and where.

Options:

- **`plan`**: `--detailed-exitcode` exits with 3 when changes are pending; `--no-tool-validation` skips the component validators; `--format`.
- **`apply`**:
  - `-y`/`--yes`: no confirmation
  - `--allow-privileged`: approve components that need elevated privileges
  - `--allow-data-changes`: approve changes that delete or stop collecting data
  - `--skip-tool-validation`: skip the component validators (not recommended)
  - `--format` `text` or `json`
- **`status`**: `--format` `text` or `json`.
- **`verify`**: `-s`/`--service <name>` checks one application instead; `--dashboards` checks that every dashboard loads and shows data; `--format`.
- **`rollback`**: `--to <release>` (default: the previous release); `-y`/`--yes`; `--format`.
- **`drift`**: `--repair` restores the deployed release; `-y`/`--yes`; `--format` `text` or `json`.
- **`destroy`**: `--delete-data` also deletes stored metrics, logs, traces and Grafana data; `-y`/`--yes`; `--format`.
- **`activity`**: `-w <dir>`, `--limit <n>` (default 20), `--format` `text` or `json`.
- **`render`**: `--format`.
- **`diff`**: `--format` `text`, `markdown` or `json`; `--files` adds each file's diff to text output; `--advise` adds Advisor findings to markdown and json output.

## People, access and the audit log

| Command                                  | Does                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| `raion server`                           | Start the web UI and API                                                   |
| `raion users list`                       | List people                                                                |
| `raion users add <username>`             | Create an account                                                          |
| `raion users set-role <username> <role>` | Change someone's role; signs them out everywhere                           |
| `raion users disable <username>`         | Stop someone from signing in; signs them out everywhere                    |
| `raion users enable <username>`          | Let a disabled account sign in again                                       |
| `raion users reset-password <username>`  | Set a new password for someone (prompts for it); signs them out everywhere |
| `raion tokens list`                      | Everyone's active API tokens                                               |
| `raion tokens create`                    | Create an API token for someone; it never has more rights than its owner   |
| `raion tokens revoke <id>`               | Revoke an API token; it stops working at once                              |
| `raion audit`                            | Who did what, newest first (the same as the **Audit log** page)            |

The same rules apply as in the web UI: Raion will not remove or demote the last active admin, and the roles of single sign-on accounts come from the identity provider.

Options:

- **`server`**:
  - `-w`/`--workspace <dir>`
  - `--host <address>` (default `127.0.0.1`), `--port <port>` (default 7600)
  - `--public-url <url>`: required when not listening on loopback
  - `--tls-cert <file>` and `--tls-key <file>`: built-in HTTPS
  - `--trust-proxy`: Raion is behind a TLS-terminating reverse proxy

  See [Serving Raion to your team](../15-users-and-security.md#serving-raion-to-your-team).

- **`users add`**: `--role` `viewer` (the default), `editor` or `admin`; prompts for the password, or reads it with `--password-stdin`.
- **`users reset-password`**: `--password-stdin`.
- **`users list`**: `--format` `text` or `json`.
- **`tokens create`**: `--user <username>`, `--name <name>` (what it is for, e.g. `ci-deploy`), `--role` (default `viewer`), `--days <days>` until it expires (1–366, default 90). The token is printed once.
- **`tokens list`**: `--all` includes revoked and expired tokens; `--format`.
- **`audit`**: `--actor <username>` (command-line actions are `cli:<user>`), `--action <kind>` (e.g. `login`, `user`, `token`, `runtime`), `--limit <n>` (default 50), `--format`.
- All take `-w <dir>`.

## Environment variables

| Variable          | Effect                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `RAION_STATE_DIR` | Keep Raion's state (secrets, releases, users) in this absolute path instead of `<workspace>/.raion`. One folder per workspace. |
