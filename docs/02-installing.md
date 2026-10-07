# Installing Raion

Raion runs on Linux, macOS and Windows. You install it from source, then run it with the `raion` command.

## Prerequisites

| You need                   | Version                                   | Used for                                                        |
| -------------------------- | ----------------------------------------- | --------------------------------------------------------------- |
| **Node.js**                | 24 or newer                               | Running Raion                                                   |
| **pnpm**                   | via `corepack enable`                     | Installing and building Raion                                   |
| **Docker** with Compose v2 | Docker Desktop, or Docker Engine on Linux | Running the observability stack                                 |
| **Git**                    | any recent                                | Getting Raion, and keeping your workspace under version control |

**Memory.** The observability stack is limited to about 4.5 GB in total. Give Docker at least 6 GB (Docker Desktop: _Settings → Resources_).

**Ports.** Raion uses these ports on `127.0.0.1` only; they must be free:

| Port  | What listens                                              |
| ----- | --------------------------------------------------------- |
| 7600  | The Raion web UI and API                                  |
| 7601  | The gateway into the stack (used by Raion itself)         |
| 4317  | OpenTelemetry (gRPC) from your applications               |
| 4318  | OpenTelemetry (HTTP) from your applications               |
| 24224 | Container logs (only when a service uses `containerLogs`) |

Every port except the web UI's can be changed in the workspace ([configuration](06-configuration.md#workspace)); the web UI's with `raion server --port`.

## Install

```sh
git clone <raion repository URL> raion
cd raion
corepack enable          # makes pnpm available
pnpm install
pnpm run build
```

Check it worked:

```sh
pnpm raion --version
```

## The `raion` command

Inside the Raion folder, `pnpm raion …` runs Raion. It always runs **from the Raion folder**, so relative paths are resolved from there.

To use `raion` from any folder (as the rest of this documentation does), define it once per terminal:

```sh
# bash or zsh (add to ~/.bashrc or ~/.zshrc to keep it)
raion() { node /path/to/raion/apps/cli/dist/index.js "$@"; }
```

```powershell
# PowerShell (add to your $PROFILE to keep it)
function raion { node C:\path\to\raion\apps\cli\dist\index.js @args }
```

Replace the path with where you cloned Raion. Then `raion --help` lists every command; see also the [command reference](reference/cli.md).

## Updating Raion

```sh
cd raion
git pull
pnpm install
pnpm run build
```

Your workspaces are not touched. Run `raion plan` in a workspace to see what the new version would change in your stack before you apply it.

## Editor support (optional)

Raion can give your editor autocompletion and inline errors for workspace files:

```sh
raion schema > raion.schema.json
```

With the Red Hat YAML extension in VS Code, add this line at the top of a workspace file:

```yaml
# yaml-language-server: $schema=./raion.schema.json
```

Next: [First run](03-first-run.md).
