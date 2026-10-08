# Legacy migration one-off tasks (VAY-1362)

The legacy migration runs once. Its production steps are started by
`scripts/legacy-migration-oneoff.sh` from the operator's machine, with the
`vayada` AWS profile. Each step needs Flamur's explicit go first. No Terraform,
no new IAM roles and no GitHub workflow are involved.

## Commands

| Command | Task gets | Confirmation (third argument) |
|---|---|---|
| `target:migration-status` | target DB only | `MIGRATION_STATUS:<run>` |
| `target:cutover:abort` | target DB only | `ABORT_CUTOVER:<run>` (the CLI checks it again) |
| `target:source:extract` | target DB, 4 source DBs, media | `SOURCE_EXTRACT:<run>:<source-run>` |
| `target:cutover` | target DB, 4 source DBs, media | `PRODUCTION_CUTOVER:<run>:<source-run>` (the CLI checks it again) |

```bash
EVIDENCE_DIR=<0700 evidence folder> bash scripts/legacy-migration-oneoff.sh <command> <run-file.json> <confirmation>
```

## What one call does

1. **Before any AWS call, it checks the inputs:**
   - the command is on the allow-list;
   - the run file has the `vay1360` run ID, the `vay1351` source run ID and the image pair, and that pair (`sourceSha imageDigest`) is listed in `scripts/next-api-split-compatible-images.txt`;
   - the confirmation is exact;
   - every argument is a string, and the inputs are named JSON documents.
2. **Before starting anything:** it clears inherited AWS credentials and requires
   the `vayada` profile to resolve to account `269416271598`. It refuses if a
   one-off migration task is still running.
3. **It registers one disposable task definition.** The family is
   `vayada-legacy-migration-oneoff-target` or `-source`. That is never the
   `vayada-next-api` family, so `tf-apply` will not roll a service onto it.
   - **Image and command:** the pinned next-api image. The command is
     `scripts/legacy-migration-oneoff.mjs`, which accepts only its kind's
     commands, runs `node /app/packages/backend-migration/dist/cli/…`, logs flag
     names only, and keeps the CLI's exit code.
   - **Roles:** the existing `ecsTaskExecutionRole`. Source tasks also get the
     existing `vayada-next-api-media-task-role`.
   - **Secrets:**
     - `TARGET_DATABASE_URL` comes from `/vayada/prod/target-database-url`, the
       migration secret next-api already maps as `TARGET_DATABASE_MIGRATION_URL`.
     - Source tasks also get `/vayada/prod/legacy-migration-source-{auth,booking,marketplace,pms}-url`.
   - **Media settings:** copied from the running next-api task (bucket and
     CDN), plus the legacy media bucket allow-list.
4. **It runs the task once** on the `vayada-target-database-runtime-preflight`
   cluster, with next-api's network. Arguments and inputs travel inside the
   definition (up to about 60 KB), not as overrides (8 KB).
5. **It waits and keeps the evidence.** It waits up to 4 hours, saves the task
   log to `EVIDENCE_DIR` (0600), and deregisters the definition. It exits with
   the CLI code:
   - `0`: done
   - `4`: awaiting smoke
   - `1`: failed, including a parity NO-GO (`PARITY_NOT_GO`)
   - `64`: the dispatcher refused the inputs

It never stops or reruns a task. After a failure or a timeout, check the task
and `target:migration-status` before doing anything else.

## Run file (kept in the evidence folder, shown to Flamur with its SHA-256)

```json
{
  "runId": "vay1360-<24 hex>",
  "sourceRunId": "vay1351-<24 hex>",
  "sourceSha": "<40 hex>",
  "imageDigest": "sha256:<64 hex>",
  "args": { "target:cutover": ["--source-run-id", "vay1351-<24 hex>", "--manifest", "@manifest", "…"] },
  "files": { "manifest": { "version": 1, "…": "…" } }
}
```

- **Arguments:** leave out `--run-id`, `--confirmation` and `--report`. The script adds them, and the CLI refuses duplicates.
- **`@name`** refers to an entry in `files`.
- **Never put secrets here:** database URLs come only from SSM.
- **To resume after `AWAITING_SMOKE`,** add `--resume` and `--smoke-report @smoke-report`.

## Before go-day

1. Create the four source SecureStrings for the attested go-day restore.
2. Let next-api's security group reach that restore.
3. In the rehearsal, confirm two things:
   - `ecsTaskExecutionRole` can read those parameters;
   - `vayada-next-api-media-task-role` can read the legacy media
     (`vayada-uploads-prod`, `vayada-creator-marketplace-images`) and write
     `public/media/` and `private/media/` in the platform media bucket.
4. Pin the rehearsed image: its `APPLICATION_RELEASE` must equal `--application-release`.

## Read-only counts (`readonly-counts`)

```bash
EVIDENCE_DIR=<0700 evidence folder> bash scripts/legacy-migration-oneoff.sh readonly-counts <counts.sql> READONLY_COUNTS
```

This is a read-only snapshot of legacy numbers, for planning. It also runs only
after Flamur's go. The SQL file stays in the evidence folder, because it names
the candidate hotels. The script prints its SHA-256 before running.

- **Input check.** Locally, `scripts/legacy-readonly-counts.py --check` accepts
  only blocks headed `-- (N) LEGACY PMS|BOOKING database: <title>`, each with a
  single `SELECT`/`WITH` statement.
- **The task.** The one-off family `vayada-legacy-readonly-counts` copies the
  running `vayada-pms-backend` task: the same image and execution role, with no
  task role. It keeps only three of its secrets: `DATABASE_URL` (PMS),
  `BOOKING_ENGINE_DATABASE_URL` (Booking) and `STRIPE_SECRET_KEY`. It is not the
  `vayada-pms-backend` family, so `tf-apply` never rolls the service onto it.
- **Each SQL block** runs inside `BEGIN TRANSACTION READ ONLY` … `ROLLBACK`, with
  a 60-second statement timeout, and may return at most 50 aggregate rows.
- **Stripe** (platform account): one paged `subscriptions.list(status=all)`,
  reported only as a count per status (`active`, `past_due`, `trialing`,
  `incomplete`, `unpaid`, `canceled`, `other`). No IDs, emails or amounts.
- **The Markdown output** is saved as `readonly-counts-result.md` (0600) in the
  evidence folder.

## The practice run (`target:cutover:dry-run`) and the go-day window

This script does not run the dry run. The CLI accepts it only as
`preprod`/`preprod`, against a target attested `vayada.target_environment=preprod`.
It belongs on an isolated restore plus a copy of the live target, never on
production.

The production cutover's approval gate (`validateApprovedRunReport`,
`validateApprovalReport` in `productionCutover.ts`, and the README section
"Guarded Rehearsal and Cutover Orchestration") requires the approved dry run to
match the production run on:

- the **same source run ID**, which is a hash of the manifest (snapshot IDs,
  schema revision, **freeze proof**);
- the same per-database source tags;
- the same freeze proof, application release and cohort;
- completion through `smoke_evidence`.

**So the approved dry run can only happen on go-day, after the freeze.**
Earlier dry runs are rehearsals; they cannot approve production. The go-day
order becomes:

1. Freeze and snapshot.
2. Restore the snapshots plus a copy of the live target, in isolation.
3. `target:cutover:dry-run` on the copy, then smoke on the copy.
4. The approval report.
5. The production `target:source:extract`, then `target:cutover`.

That adds roughly 1.5–2.5 hours: the copy restore, a second migration run,
smoke and approval. It moves the window from about 3.5–4.5 hours to about
5–7 hours, so OTA closeouts are needed.

Tests: `node --test scripts/test-legacy-migration-oneoff.mjs`.
