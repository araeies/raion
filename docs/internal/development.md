# Developing Raion

**Internal.** How to build, test and change Raion. For the maintainer, and for anyone the maintainer has invited to make a specific change (see [CONTRIBUTING](../../CONTRIBUTING.md)).

## Setup

You need **Node.js 24+** and **Git**. Docker is needed for deep validation and the end-to-end tests.

```sh
corepack enable          # provides the pnpm version pinned in package.json
pnpm install
pnpm run check           # format, lint, type check, build, test, validate examples
```

If `corepack enable` fails with a permissions error (common on Windows without admin rights), install the shim into a user directory that is on your `PATH`:

```sh
corepack enable --install-directory "$APPDATA/npm" pnpm     # Windows (Git Bash)
corepack enable --install-directory ~/.local/bin pnpm      # Linux / macOS
```

Useful commands:

| Command                             | What it does                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `pnpm run build`                    | Compile all packages and the web UI                                            |
| `pnpm test` / `pnpm run test:watch` | Run tests (against sources, no build needed)                                   |
| `pnpm run lint`                     | ESLint with type-aware rules and layer boundaries                              |
| `pnpm run typecheck`                | TypeScript, including test files                                               |
| `pnpm raion <command>`              | Run the built CLI                                                              |
| `pnpm --filter @raion/web dev`      | UI dev server with hot reload; proxies `/api` to a `raion server` on port 7600 |
| `pnpm run test:e2e`                 | Full-stack test: deploys, verifies, updates and destroys a real stack (Docker) |
| `node scripts/update-images.mjs`    | Re-resolve image digests after changing a tag (`--check` detects drift)        |

### Platform notes

Raion is developed on Linux, macOS and Windows, and CI runs on all three.

- Repository scripts are Node.js, not shell scripts, so they work everywhere.
- Line endings are normalized to LF (`.gitattributes`).
- **Docker Desktop (Windows/macOS):** host metrics will describe Docker's Linux VM, not your laptop. This is expected. Full-stack end-to-end tests run on Linux in CI.
- On Windows, file permissions on `.raion/` (secrets, database) are not restricted the way they are on Linux and macOS. Keep workspaces in your user profile.

## Repository layout

| Path                  | Contents                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `packages/schema`     | Configuration schemas (zod) and the JSON Schema export                                                           |
| `packages/core`       | Loading, validation, resolution, the service registry and runtime generators. Pure: no network, no processes.    |
| `packages/deploy`     | Deployment engine: releases, plans, Docker Compose target, gateway client. The only package that runs processes. |
| `apps/server`         | The control plane: API, auth, user store, UI hosting                                                             |
| `apps/cli`            | The `raion` command                                                                                              |
| `apps/web`            | The web UI (React)                                                                                               |
| `examples/workspaces` | Example workspaces. Each is validated in CI.                                                                     |
| `docs/`               | The user documentation; `docs/internal/` holds the architecture, design decisions and development history        |

Layering rules (`core` must not import apps, and only deployment adapters may spawn processes) are enforced by ESLint. See [the architecture](design/phase-0-architecture.md).

## Making changes

1. Every change starts from an issue the maintainer has accepted, and stays within the scope agreed there.
2. Keep changes focused. Add tests for behaviour and docs for anything user-facing.
3. User documentation (`docs/`) describes the product from the user's point of view: what it does, how to use it, how to troubleshoot it. Design reasoning and history go in `docs/internal/`.
4. Add an entry under "Unreleased" in `CHANGELOG.md`, in user terms.
5. Run `pnpm run check` before opening a pull request.

### Dependencies

We keep the dependency tree small, because every dependency is supply-chain risk.

- Explain why a new dependency is needed in the PR, and prefer Node.js built-ins.
- Versions are pinned exactly.
- pnpm refuses versions published less than 24 hours ago (`minimumReleaseAge`) and does not run dependency install scripts unless allow-listed.

### Integrations

Integrations live in `packages/integrations/<name>/`, as an `integration.yaml` and a README. They are data only: the schema in `packages/schema/src/integration.ts` defines everything they can declare, and placeholders are limited to the variables in `packages/core/src/integrations.ts`.

A new integration needs:

- tests in `packages/core/test/`
- a README that covers what you get, how it works, setup, parameters, customizing and troubleshooting
- if it instruments applications, an end-to-end test against a real application

The [integration authoring guide](../integrations/writing-integrations.md) explains the manifest, capabilities and how to check metric names against a running service.

### Generated configuration

Generator output is covered by golden files in `packages/core/test/__golden__/`. When you change a generator, run `pnpm exec vitest run packages/core -u`, then review the golden-file diff in your pull request. It shows exactly what changes for users. CI also runs the full-stack end-to-end test, which deploys the generated configuration for real.

### Validation codes

New validation errors get a stable code in `packages/core/src/diagnostics.ts` and an entry in `docs/reference/validation-codes.md`. Messages should say what is wrong in plain language, and hints should say how to fix it.
