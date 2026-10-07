# Command line

`raion --help` lists the commands; `raion <command> --help` shows each command's options. This page is the same, with explanations.

**Which workspace.** Commands take the workspace folder as an argument (`raion apply observability`), or with `-w`/`--workspace` where shown. Without one, Raion uses the current folder if it contains `raion.yaml`, and `./observability` otherwise.

**Exit codes.** `0` success; `1` errors (invalid configuration, failed checks); `2` wrong usage; `3` changes or drift found (`plan --detailed-exitcode`, `drift`).

## Setting up

| Command                         | Does                                                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `raion init [dir]`              | Create a workspace (default folder `observability`), asking a few questions                                                        |
| `raion validate [dir]`          | Check the workspace for errors                                                                                                     |
| `raion schema`                  | Print the JSON Schema of workspace files, for editors and CI                                                                       |
| `raion integrations list [dir]` | List the integrations services can use: built-in, and the workspace's own                                                          |
| `raion integrations lock [dir]` | Record the checksums of the workspace's own integration packages ([Writing integrations](../integrations/writing-integrations.md)) |

**`raion init`** answers its questions from flags with `-y`/`--yes`:

- `--name <name>`, `--environment <name>`
- `--level 1`, `2` or `3`
- `--service <name>`
- `--type`: `web`, `api`, `worker`, `database`, `microservice` or `infrastructure`
- `--language`: `nodejs`, `python`, `go`, `java`, `dotnet`, `php` or `other`
- `--runtime`: `compose` or `host`

**`raion validate`**: `--deep` also runs each component's own validator on the generated configuration (needs Docker); `--format` `text` or `json`.

## Deploying the observability stack

| Command                          | Does                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| `raion plan [dir]`               | Show what applying would change, without changing anything                            |
| `raion apply [dir]`              | Deploy or update the stack (shows the plan and asks first)                            |
| `raion status [dir]`             | Every component's state and health, monitoring of the stack, alerting, drift          |
| `raion verify [dir]`             | Send test telemetry through the stack and find it in storage                          |
| `raion rollback [dir]`           | Deploy an earlier release again                                                       |
| `raion drift [dir]`              | Compare the running stack with the deployed release                                   |
| `raion destroy [dir]`            | Stop the stack                                                                        |
| `raion render [dir] --out <dir>` | Write the generated configuration to a folder (it must be empty or new)               |
| `raion diff <base> [head]`       | Compare two versions of a workspace: components and generated files that would change |

Options:

- **`plan`**: `--detailed-exitcode` exits with 3 when changes are pending; `--no-tool-validation` skips the component validators.
- **`apply`**:
  - `-y`/`--yes`: no confirmation
  - `--allow-privileged`: approve components that need elevated privileges
  - `--allow-data-changes`: approve changes that delete or stop collecting data
  - `--skip-tool-validation`: skip the component validators (not recommended)
- **`status`**: `--format` `text` or `json`.
- **`verify`**: `-s`/`--service <name>` checks one service instead; `--dashboards` checks that every dashboard loads and shows data.
- **`rollback`**: `--to <release>` (default: the previous release); `-y`/`--yes`.
- **`drift`**: `--repair` restores the deployed release; `-y`/`--yes`; `--format` `text` or `json`.
- **`destroy`**: `--delete-data` also deletes stored metrics, logs, traces and Grafana data; `-y`/`--yes`.
- **`diff`**: `--format` `text`, `markdown` or `json`; `--files` adds each file's diff to text output; `--advise` adds Advisor findings to markdown and json output.

## Connecting services

| Command               | Does                                                             |
| --------------------- | ---------------------------------------------------------------- |
| `raion connect [dir]` | Show how to connect each service, and write the Compose override |

Options:

- `-s`/`--service <name…>`: only these services
- `-o`/`--out <file>`: write the override, e.g. `observability.override.yaml`
- `--format compose` (the default), or `env` or `shell` to print only the environment variables

## SLOs, alerts and the Advisor

| Command                   | Does                                                            |
| ------------------------- | --------------------------------------------------------------- |
| `raion slo list [dir]`    | Every SLO with its SLI, error budget left, burn rate and status |
| `raion slo add <service>` | Create an SLO (asks questions when run interactively)           |
| `raion slo export [dir]`  | Write all SLOs in OpenSLO v1 format                             |
| `raion slo import <file>` | Import OpenSLO SLOs as new files in `slos/`                     |
| `raion alerts [dir]`      | What is firing, and whether alerting works                      |
| `raion advise [dir]`      | Find gaps in your observability                                 |

Options:

- **`slo list`** and **`alerts`**: `--format` `text` or `json`.
- **`slo add`**:
  - `-w <dir>`
  - `--type`: `availability`, `latency` or `throughput`
  - `--target <percent>`
  - `--window`: `7d`, `14d`, `28d`, `30d` (the default) or `90d`
  - `--threshold-ms <ms>` (latency) or `--min-rps <rate>` (throughput)
  - `--name`, `--description`, `--policy`
- **`slo export`**: `-o`/`--out <file>`.
- **`slo import`**: `-w <dir>`, `--service <name>`.
- **`advise`**:
  - `--offline`: configuration only, without querying the stack
  - `--all`: include ignored findings
  - `--fail-on` `critical`, `warning` or `info`: exit with 1, for CI
  - `--apply <finding>`: write a finding's fix; `-y`/`--yes` skips the confirmation
  - `--format` `text` or `json`

## Secrets

| Command                       | Does                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `raion secrets set <name>`    | Store a secret, used in workspace files as `${secret:NAME}`; prompts for the value |
| `raion secrets list`          | Which secrets are needed and whether each is set; never shows values               |
| `raion secrets remove <name>` | Delete a secret                                                                    |

All take `-w`/`--workspace <dir>`. `set` reads the value from standard input with `--value-stdin`, for scripts.

## The web UI and users

| Command                      | Does                     |
| ---------------------------- | ------------------------ |
| `raion server`               | Start the web UI and API |
| `raion users add <username>` | Create a user            |
| `raion users list`           | List users               |

Options:

- **`server`**:
  - `-w`/`--workspace <dir>`
  - `--host <address>` (default `127.0.0.1`), `--port <port>` (default 7600)
  - `--public-url <url>`: required when not listening on loopback
  - `--tls-cert <file>` and `--tls-key <file>`: built-in HTTPS
  - `--trust-proxy`: Raion is behind a TLS-terminating reverse proxy

  See [Serving Raion to your team](../15-users-and-security.md#serving-raion-to-your-team).

- **`users add`**: `--role` `viewer` (the default), `editor` or `admin`; prompts for the password, or reads it with `--password-stdin`; `-w <dir>`.
- **`users list`**: `-w <dir>`.

## Environment variables

| Variable          | Effect                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `RAION_STATE_DIR` | Keep Raion's state (secrets, releases, users) in this absolute path instead of `<workspace>/.raion`. One folder per workspace. |
