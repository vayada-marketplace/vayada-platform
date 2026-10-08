# Production legacy migration runner (VAY-1362)

A protected one-off ECS runner for four `packages/backend-migration` CLIs, in
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
  - `vayada-legacy-migration-runner-source` runs `target:source:extract` and
    `target:cutover`. It also gets the four source URLs, the media settings and
    the media task role.
- **The task command** is `scripts/legacy-migration-runner.mjs`. It accepts only
  its kind's commands and runs `node /app/packages/backend-migration/dist/cli/…`
  with the arguments from the run file. It logs only flag names, never values,
  and exits with the CLI's code.
- **Its own cluster and log group** (`/ecs/vayada-legacy-migration-runner`, 365 days).
- **Execution role.** The managed ECS execution policy, plus `ssm:GetParameters`
  on exactly the five parameters.
- **Task role (source only).** It may read legacy media (`vayada-uploads-prod`
  `creators/`, `hotels/`, `listings/`, and `vayada-creator-marketplace-images`)
  and put or delete objects under `public/media/` and `private/media/` in the
  versioned platform media bucket.
- **GitHub controller role** `vayada-github-actions-legacy-migration-runner`. Only
  `platform-mutations-v2` jobs can assume it. It may run these two families on
  this cluster, pass the two roles, and read the task logs.
- **A refresh-only policy on the shared apply role.** It may read these roles.
  It is denied registering, deregistering, running, stopping or passing them,
  deleting the log group, and rewriting the four source parameters.

**Who can start it.** IAM decides who can start the task: only jobs on
`platform-mutations-v2` through the controller role. RunTask overrides could
replace the command, so the allow-list itself rests on the reviewed workflow and
launcher on `main` (the same model as the Financials export runner). The
dispatcher's own check is defence in depth.

## Why `target:cutover:dry-run` is not here

The cutover CLI accepts a dry run only as `preprod`/`preprod`, against a target
attested `vayada.target_environment=preprod`
(`packages/backend-migration/README.md`: "isolated pre-production dry-run"). Its
media step also writes to the configured platform media bucket. On this
production runner it would either fail with `TARGET_ATTESTATION_MISMATCH`, or need
production attested as preprod, which imports legacy rows into the live target.
Run the dry run in the isolated rehearsal environment, against a copy of the
target and the rehearsal media bucket. Its report then becomes the
`--approved-run-report` input of `target:cutover`.

## Install (needs its own go; never by merge)

The shared apply role cannot create IAM roles. It works the same way as the
Financials export runner:

1. Recount the managed policies attached to `vayada-github-actions-platform-deploy`
   against the AWS quota (10 by default). This change adds one.
2. The authorized operator reviews a saved plan of this change. It must show
   exactly 13 additions and nothing else: the cluster, the log group, 3 roles,
   3 inline policies, the execution-policy attachment, 2 task definitions, the
   refresh policy and its attachment.
3. Hold every other `infra/` merge. Between the operator's apply and this merge,
   `main` does not know these resources, and any `tf-apply` would try to destroy
   them.
4. The operator applies that saved plan. Merge right after. The PR's plan must
   show `No changes.` Merging first makes `tf-apply` fail halfway.

Later changes to the runner follow the same path, for example a new image pin
or a dispatcher change. Both files are in the tf-plan and tf-apply path filters.

## Before the first dispatch

1. Re-pin `deployment/legacy-migration-runner.json` to the rehearsed go-day
   image in a reviewed PR, then install it as above. The CLI refuses to run if
   the image's `APPLICATION_RELEASE` differs from `--application-release`.
2. Create the SecureStrings `/vayada/prod/legacy-migration-source-{auth,booking,marketplace,pms}-url`
   for the restored, attested legacy source (runbook M1). Until they exist,
   source tasks cannot start.
3. Let the next-api security group reach that restore. Tasks use the network
   configuration of `vayada-next-api-service`.
4. Commit the run file (below) in a reviewed PR.

## Run file: `deployment/legacy-migration-runs/<run-id>.json`

```json
{
  "runId": "vay1360-<24 hex>",
  "sourceRunId": "vay1351-<24 hex>",
  "args": {
    "target:cutover": ["--source-run-id", "vay1351-<24 hex>", "--manifest", "@manifest", "…"]
  },
  "files": { "manifest": { "version": 1, "…": "…" } }
}
```

- **`args`** lists the CLI flags for each command. Leave out `--run-id`,
  `--confirmation` and `--report`: the launcher adds them, and the CLI refuses
  duplicates.
- **`@name`** points to an entry in `files`. The task writes it as a 0600 JSON
  file and passes its path.
- **No secrets.** Database URLs come only from SSM.
- **Size limit.** The arguments and all inputs (one gzip blob) must fit the
  8192-byte ECS override limit, or the launcher refuses. `target:cutover` needs
  the approved dry-run report, the approval report and the cohort. Measure their
  real sizes in the rehearsal; if they do not fit, an S3 input path with
  SHA-256-pinned keys must exist before go-day.
- **Resuming after `AWAITING_SMOKE`** means adding `--resume` and
  `--smoke-report @smoke-report` in a reviewed update.

## Dispatch

Use the workflow **VAY-1362 legacy migration runner**. It is `workflow_dispatch`
only, runs on `main` only, needs approval on `platform-mutations-v2`, and shares
the `production-ecs-mutations` queue. Its inputs are `command`, `image_digest`
(which must equal the pin), `run_id` and `confirmation`:

| Command | Confirmation |
|---|---|
| `target:migration-status` | `MIGRATION_STATUS:<run>` |
| `target:source:extract` | `SOURCE_EXTRACT:<run>:<source-run>` |
| `target:cutover` | `PRODUCTION_CUTOVER:<run>:<source-run>` (the CLI checks it again) |
| `target:cutover:abort` | `ABORT_CUTOVER:<run>` (the CLI checks it again) |

- **Output.** The CLI output goes to the log group and the job log.
- **Exit code.** The job exits with the CLI's code. `0` means done and `4`
  means awaiting smoke. `1` means failed, including a parity NO-GO
  (`PARITY_NOT_GO`); read the error code in the log. `64` means the dispatcher
  refused the inputs.
- **One task at a time.** The launcher refuses to start while a runner task is
  still running.
- **Never re-run blindly.** After a failure or a 150-minute timeout, check the
  task and `target:migration-status` first.

## Limits

- `target:cutover:abort` only marks the run aborted. Imported rows stay.
- The runner does not run the per-domain CLIs, owner bootstrap or the historical
  binding transition.
- The media read prefixes follow the reviewed VAY-2042 rehearsal role, plus
  `hotels/`. Without `s3:ListBucket`, a missing object reports `AccessDenied`
  rather than "not found". Confirm the prefixes in the rehearsal (PMS message
  attachments may live elsewhere) and widen them in a reviewed change.
- `target:source:extract` shares the source task role, though it reads no media.

Tests: `node --test scripts/test-legacy-migration-runner.mjs`.
