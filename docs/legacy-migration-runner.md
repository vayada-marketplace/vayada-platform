# Production legacy migration runner (VAY-1362)

A protected one-off ECS runner for five `packages/backend-migration` CLIs, in
their `:dist` form inside the pinned next-api image. It is inert. Nothing runs it
until the reviewed workflow is dispatched on `main`, the dispatch is approved on
`platform-mutations-v2`, and a reviewed run file exists for that run ID.

## What it contains (`infra/legacy_migration_runner.tf`)

- **Two task definitions.** Both use the image pinned in
  `deployment/legacy-migration-runner.json`. That source/digest pair must
  appear in `scripts/next-api-split-compatible-images.txt`.
  - `vayada-legacy-migration-runner-target` runs `target:migration-status` and
    `target:cutover:abort`. It gets only `TARGET_DATABASE_URL`, read from
    `/vayada/prod/target-database-url`, the same migration secret next-api maps as
    `TARGET_DATABASE_MIGRATION_URL`. It has no task role.
  - `vayada-legacy-migration-runner-source` runs `target:source:extract`,
    `target:cutover:dry-run` and `target:cutover`. It also gets the four source
    URLs, the media settings and the media task role.
- **The task command** is `scripts/legacy-migration-runner.mjs`. It accepts only
  its kind's commands and runs `node /app/packages/backend-migration/dist/cli/…`
  with the arguments from the run file. It keeps the CLI's exit code.
- **Its own cluster and log group** (`/ecs/vayada-legacy-migration-runner`, 365 days).
- **Execution role.** The managed ECS execution policy, plus `ssm:GetParameters`
  on exactly the five parameters.
- **Task role (source only).** It may read legacy media (`vayada-uploads-prod`
  `creators/`, `hotels/`, `listings/`, and `vayada-creator-marketplace-images`)
  and put or delete objects under `public/media/` and `private/media/` in the
  platform media bucket.
- **GitHub controller role** `vayada-github-actions-legacy-migration-runner`. Only
  `platform-mutations-v2` jobs can assume it. It may run these two families on
  this cluster, pass the two roles, and read the task logs.
- **A refresh-only policy on the shared apply role.** It may read these roles.
  It is denied registering, running, stopping or passing them.

## Install (needs its own go; never by merge)

The shared apply role cannot create IAM roles. It works the same way as the
Financials export runner:

1. The authorized operator reviews a saved plan of this change. It must show
   exactly these 14 additions and nothing else: the cluster, the log group,
   3 roles, 3 inline policies, the execution-policy attachment, 2 task
   definitions, the refresh policy and its attachment.
2. The operator applies that saved plan.
3. Only then merge. The PR's plan must show `No changes.` Merging first makes
   `tf-apply` fail halfway.

Later changes to the runner, such as a new image pin, follow the same path.

## Dispatch

The protected `workflow_dispatch` workflow and its launcher come in the next,
stacked change. Until then nothing in this repository can start the runner.

## Limits

- `target:cutover:dry-run` is not read-only. It extracts into the production
  target and parity takes `SHARE` locks, so run it only inside a native-write freeze.
- `target:cutover:abort` only marks the run aborted. Imported rows stay.
- The runner does not run the per-domain CLIs, owner bootstrap or the historical
  binding transition.
- The media read prefixes follow the reviewed VAY-2042 rehearsal role, plus
  `hotels/`. If the rehearsal hits `AccessDenied`, widen them in a reviewed change.

Tests: `node --test scripts/test-legacy-migration-runner.mjs`.
