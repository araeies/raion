# Example: observability managed through pull requests

A repository layout for teams that change their observability the way they change code:

- reviewed in pull requests
- deployed when merged
- checked for drift every hour

Raion's own CI runs the pull-request check on this example on every change.

```
observability/
  raion.yaml                 workspace: level, teams, notifications, advisor settings
  services/*.yaml            one file per service (owners edit their own)
  slos/*.yaml                one file per SLO
  integrations/              optional: your own integration packages (+ integrations.lock.yaml)
  .gitignore                 keeps .raion/ (state and secrets) out of Git
CODEOWNERS                   who reviews what (copy to .github/CODEOWNERS)
.github/workflows/
  observability-pr.yml       on pull requests: validate, show what changes, run the advisor
  observability-deploy.yml   on merge: plan, apply (approved environment), verify
  observability-drift.yml    hourly: has anyone changed the running stack behind Raion's back?
```

## What a pull request shows

The [Raion check action](../../actions/check/action.yml) does four things:

- **Validates** the workspace. With `deep: 'true'`, Prometheus, Alertmanager, Loki, Tempo, the collector and Nginx also check the generated files with their own validators.
- **Compares** the pull request with its base branch (`raion diff`):
  - which components would start, restart or stop
  - changes that need privileges or delete data
  - the diff of every generated file
- **Runs the advisor**, and fails the check at the severity you choose (`fail-on`).
- **Reports** in the job summary, plus one comment on the pull request that is updated on every push.

It needs no running stack and no secrets.

## Setting it up in your repository

1. Copy `observability/`, `CODEOWNERS` (to `.github/CODEOWNERS`) and the workflows. `observability` is the folder that holds the workspace; if you name yours differently, change the folder in the workflows and `CODEOWNERS` too.
2. Pin the action to a commit of the Raion repository: `uses: <owner>/raion/actions/check@<commit-sha>`.
3. **Deploying** needs a machine that runs the stack, with a self-hosted runner labelled `raion` and Raion installed:
   - Create `/srv/raion/shop`, owned by the runner's user, mode 0700. Releases, secrets and the user database live there, outside the checkout, through `RAION_STATE_DIR`.
   - Store notification and database secrets once on that machine: `RAION_STATE_DIR=/srv/raion/shop raion secrets set NAME -w observability`.
   - Create a GitHub environment `production` with required reviewers, so every deployment is approved by a person.
4. Protect the main branch: require the check and a CODEOWNERS review.

## Safety built in

- **Pull requests from forks.** They only get the job summary, because their token cannot comment. Nothing runs with `pull_request_target`.
- **Committed secrets.** The check fails if anything under `observability/.raion/` is committed.
- **Deliberate escalation.** The deploy workflow never passes `--allow-privileged` or `--allow-data-changes`, so such changes stop and wait for a person.
- **Locked integration packages.** An integration package changed without `raion integrations lock` fails validation. CODEOWNERS sends packages to a security reviewer.
