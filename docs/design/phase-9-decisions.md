# Phase 9: GitOps decisions

Phase 0 planned split workspaces, `raion render`, a GitHub Action, drift detection and the `init` wizard, with the exit criterion "a CI example repository validates and plans on every pull request". Split workspaces, `render`, `plan --detailed-exitcode` and `init` already existed. This phase added what was missing.

## D1. Pull requests are reviewed with `raion diff`, not `raion plan`

In CI there is no deployed release, so `raion plan` would show the whole stack as new. `raion diff <base> <head>` renders both versions of the workspace and runs the same planner. It treats the base's generated configuration as the "deployed release", so the review shows exactly what applying the pull request would change:

- components that restart
- privileged and data-affecting changes
- notes
- file diffs

The output is text, JSON or Markdown. The Markdown stays under GitHub's comment limit and says what it left out.

## D2. The action builds Raion from its pinned commit

The action builds Raion from the commit it is pinned to, because Raion is not published as a package yet. A pinned commit is also the supply-chain guidance for third-party actions, so pinning the action pins Raion.

- **No script injection.** Inputs reach scripts only through environment variables, never `${{ }}` inside a script. A crafted branch name or input cannot inject shell.
- **No `pull_request_target`.** Fork pull requests get the job summary only; the comment needs a token that forks don't have. Untrusted code never runs with write access.
- **The base commit comes from the checkout.** It is fetched only when missing (`fetch-depth: 0` avoids needing credentials on private repositories).

## D3. Committed state fails the check

`.raion/` holds the gateway token, Grafana's admin password, notification and database credentials, and the user database. `raion init` writes a `.gitignore` for it, but hand-made workspaces may not have one. The action fails when any file under the workspace's `.raion/` is tracked, and says how to remove it and that the secrets must be rotated.

## D4. Drift compares the running stack with the release, not with Git

Two different questions, two commands:

- **`raion plan --detailed-exitcode`:** Git has changes that were not deployed.
- **`raion drift`:** the running stack differs from the release Raion deployed. That means generated files edited, deleted or added, or containers missing, stopped, added or running another image.

Files are compared byte for byte with the release's stored copy. Images are compared with the release's own `compose.yaml`, not with the current code's pins, so an older release is not reported as drifted after a Raion upgrade. The runtime end-to-end test edits a generated file and stops a container; drift finds both, and `--repair` restores the release.

Repair redeploys the current release (the rollback path), so it needs nothing that release did not already have. Editors may repair, as they may apply. Every repair is audited with the drift it undid.

## D5. State can live outside the checkout

CI checkouts are cleaned on every run (`actions/checkout` runs `git clean -ffdx`), which would delete `.raion/` with every release and secret. `RAION_STATE_DIR` moves the state to a directory on the runner. It must be absolute and is used for one workspace.

This was found while writing the example deploy workflow, before it could cost anyone their secrets.

## D6. Deferred

| Item                                                      | Why                                                                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Personal API tokens (CI talking to a shared Raion server) | A security design of its own (scopes, expiry, rotation, audit); today CI uses the CLI on the deploy host. To be agreed before it is built. |
| GitLab CI and other systems                               | The building blocks are CLI commands (`diff --format markdown`, `drift`, exit codes); a template per system follows demand                 |
| Pull-request comments with inline suggestions             | Needs GitHub's review API and line mapping into the user's YAML                                                                            |
| Running the action without building Raion                 | Needs a published package or container image of Raion                                                                                      |
