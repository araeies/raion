# Working through Git

Raion's workspace is plain YAML, meant for Git. This guide shows how a team reviews, deploys and audits its observability the way it does code.

Names such as `checkout` on this page are examples: use your own. See [names in the examples](README.md#names-in-the-examples).

| Step   | Command                                                                                            | What it guarantees                                                                                                  |
| ------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Edit   | your editor (with the [JSON Schema](06-configuration.md)), `raion slo add`, `raion advise --apply` | Changes are files                                                                                                   |
| Review | `raion diff <base> <head>`                                                                         | Reviewers see which components restart, privileged or data-affecting changes, and every generated file that changes |
| Check  | `raion validate --deep`, `raion advise --fail-on warning`                                          | Invalid configuration and observability gaps fail the pull request                                                  |
| Deploy | `raion plan`, `raion apply`                                                                        | Only what was reviewed is deployed; escalations stop for a person                                                   |
| Audit  | `raion drift`                                                                                      | Changes made to the running stack behind Raion's back are found, and `--repair` undoes them                         |

[examples/gitops](../examples/gitops) has a complete repository: workspace, CODEOWNERS and the three workflows.

## Reviewing a change: `raion diff`

`raion diff` compares two versions of a workspace (a pull request and its target branch) without deploying anything:

```sh
git worktree add /tmp/base origin/main
raion diff /tmp/base/observability observability            # text
raion diff /tmp/base/observability observability --files    # with the diff of each generated file
raion diff /tmp/base/observability observability --format markdown --advise   # for a PR comment
```

The output lists:

- components that would start, restart, be recreated or stop, and why
- changes that need `--allow-privileged` (for example container metrics) or `--allow-data-changes` (shorter retention), flagged
- notes, for example "metrics retention raised to 33 days for a 30-day SLO"
- every generated file that changes, as a diff

## The pull-request check (GitHub Actions)

```yaml
permissions:
  contents: read
  pull-requests: write

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha>
        with: { fetch-depth: 0, persist-credentials: false }
      - uses: <owner>/raion/actions/check@<commit-sha>
        with:
          workspace: observability
          deep: 'true'
          fail-on: warning
```

The [action](../actions/check/action.yml):

1. builds Raion from the pinned commit
2. validates (and with `deep`, runs each component's own validator)
3. fails if anything under `.raion/` is committed (it holds secrets)
4. compares with the base branch
5. writes the result to the job summary and one pull-request comment, updated on every push
6. fails at the advisor severity you set

It needs no running stack and no secrets. Pull requests from forks get the job summary only: their token cannot comment, and the action never uses `pull_request_target`.

## Deploying on merge

Deployment runs where the stack runs. With GitHub Actions, that's a self-hosted runner on that machine. See `observability-deploy.yml` in the example.

- **State outside the checkout.** CI checkouts are cleaned on every run. Set `RAION_STATE_DIR` to a directory on the runner (owner-only), so releases, secrets and the user database survive. Use one directory per workspace.
- **A person approves.** Use a GitHub environment with required reviewers.
- **No silent escalation.** Never pass `--allow-privileged` or `--allow-data-changes` in the pipeline: such changes stop the deployment, and a person applies them deliberately.
- **One deploy at a time.** Raion also locks the stack during an apply.

## Detecting drift: `raion drift`

Drift is a change to the running stack that Git doesn't know about:

- a generated file edited by hand in `.raion/runtime`
- a container stopped, removed, added or running another image

```sh
raion drift                 # exit code 0: matches the release; 3: drift (lists each difference)
raion drift --repair        # restore the deployed release: its files and its containers
```

Changes in the workspace that are not deployed yet are not drift. `raion plan --detailed-exitcode` reports those (exit code 3).

`raion status` and the Observability stack page show drift too. Editors and admins can restore the release from the page; each repair is audited with what it undid. Schedule `raion drift` (the example runs it hourly) to be told when someone works around the review.

## Who may change what

- **CODEOWNERS** makes the right people review each part:
  - services by their teams
  - notification routes by SRE
  - integration packages by security, because they configure what runs inside applications
- **Raion's roles** apply to the UI and API:
  - viewers read
  - editors create SLOs, apply advisor fixes, deploy and repair
  - only admins approve privileged or data-affecting changes, and manage secrets

In a strict GitOps setup, give people the viewer role in the UI and let the pipeline be the only writer.
