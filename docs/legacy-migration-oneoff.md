# Legacy migration one-off tasks (VAY-1362)

The legacy migration runs once. Its production steps are started by
`scripts/legacy-migration-oneoff.sh` from the operator's machine, with the
`vayada` AWS profile. Each step needs Flamur's explicit go first, naming the
command and the run file's SHA-256. No Terraform, no new IAM roles and no
GitHub workflow are involved.

## Commands

| Command | Task gets | Confirmation (third argument) |
|---|---|---|
| `target:migration-status` | target DB only | `MIGRATION_STATUS:<run>` |
| `target:cutover:abort` | target DB only | `ABORT_CUTOVER:<run>` (the CLI checks it again) |
| `target:source:extract` | target DB, 4 source DBs, media (unused) | `SOURCE_EXTRACT:<run>:<source-run>` |
| `target:cutover` | target DB, 4 source DBs, media | `PRODUCTION_CUTOVER:<run>:<source-run>` (the CLI checks it again) |

```bash
EVIDENCE_DIR=<0700 evidence folder> caffeinate -i bash scripts/legacy-migration-oneoff.sh <command> <run-file.json> <run-file-sha256> <confirmation>
EVIDENCE_DIR=<0700 evidence folder> caffeinate -i bash scripts/legacy-migration-oneoff.sh watch <task-arn>
```

A cutover can take an hour. Run the script as a background command; Claude's
foreground commands stop after 10 minutes. If the script dies anyway (lost
network, sleep, a killed shell), the task keeps running. **Never rerun the
step:** `watch <task-arn>` re-attaches from the task record in the evidence
folder, saves the log and returns the exit code.

`target:cutover` runs the source extraction itself. Do not run
`target:source:extract` before it; that would only repeat the extraction.
Use it on its own only for a standalone extraction, and check that its report's
`runId` equals the run file's `sourceRunId`.

## What one call does

1. **Before any AWS call, it checks the inputs:**
   - `EVIDENCE_DIR` is a 0700 folder;
   - the command is on the allow-list;
   - the run file's SHA-256 equals the approved one;
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
   definition (up to about 60 KB), not as overrides (8 KB). It writes a task
   record (`task-<id>.json`) to the evidence folder.
5. **It waits and keeps the evidence.** It waits up to 4 hours and rides out
   short AWS errors. It saves the task log to `EVIDENCE_DIR` (0600), then
   deregisters and deletes the definition. A running task is never affected,
   though CloudTrail still records the request. It exits with the CLI code:
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
  - Every command used needs an `args` entry. For `target:migration-status`, `[]` is enough.
  - `target:cutover:abort` needs `--operator`.
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
EVIDENCE_DIR=<0700 evidence folder> bash scripts/legacy-migration-oneoff.sh readonly-counts-plan <counts.sql> <target-check.sql>
EVIDENCE_DIR=<0700 evidence folder> bash scripts/legacy-migration-oneoff.sh readonly-counts <counts.sql> <target-check.sql> READONLY_COUNTS:<plan sha256>
```

A read-only snapshot for go-day planning. It covers:
- the legacy PMS/Booking blocks in `readonly-counts.sql`;
- the 6c pre-deploy check (`6c/predeploy-readonly-check.sql`) on the production
  target;
- Stripe subscription counts.

The SQL files are kept in the evidence folder rather than the repository,
because they name candidate hotels. They are still embedded in the disposable
task definition, which is deleted afterwards, and are recorded by CloudTrail.
Nothing runs before the plan is reviewed and Flamur's go names the plan SHA-256.

| Coordinator check | How it is met |
|---|---|
| Owner-checked pattern | **Image:** the digest of the single running `vayada-pms-backend` task, never a tag. The service must be settled (one task, one completed deployment); the plan names that task. **Embedded in the disposable definition:** the code (`python -I -c`), both SQL files and the RDS CA bundle (`rehearsal/rds-ca-rsa2048-g1.pem`, SHA-256 `f5c5f92a…`, checked by the script and again in the task). **Secrets:** exactly four reviewed SSM names: `/vayada/prod/db-pms-url`, `/vayada/prod/db-booking-url`, `/vayada/prod/stripe-secret-key`, `/vayada/prod/target-database-url`. **Connections:** host `vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com`, port 5432, and the database (`vayada_pms_db`, `vayada_booking_db`, `vayada_target_prod`) are pinned per secret. TLS is verified against that CA, including the hostname (sslmode `verify-full`). |
| Read-only, aggregates only | **Transaction:** every statement runs inside `BEGIN TRANSACTION READ ONLY` … `ROLLBACK`, with a 60 s statement timeout and a 2 s lock timeout. **Legacy blocks:** must contain an aggregate and must not build values from many rows (`*_agg`, JSON builders, `*_to_xml`). They may return at most 50 rows. Whether a `GROUP BY` key is personal data is up to the reviewed SQL. **Target checks:** each 6c `SELECT` (the file's own `BEGIN`/`ROLLBACK` are dropped) runs as `SELECT count(*) AS rows_found FROM (…)` and must return exactly that one value, so no target row is printed. Balanced parentheses and the ban on comments stop a statement from breaking out of the wrapper. The expected answer is 0. **Stripe:** counts per status, in total and for fixed-plan subscriptions; no IDs, emails or amounts. The task gets the full platform key, because SSM holds no restricted read-only key. The code only calls `Subscription.list`. **Errors:** only a code or the exception type is printed. |
| Least privilege, no new IAM | No task role. The execution role is the existing `ecsTaskExecutionRole`, the role the legacy services already use. Logs go to the existing `/ecs/vayada-pms-backend` group (prefix `legacy-readonly-counts`). Nothing goes through Terraform. The definition is deregistered and deleted afterwards. |
| Dry-run / plan mode | `readonly-counts-plan` makes only read-only AWS calls. It prints every statement exactly as it will run, the image, roles, secrets and log group, both SQL SHA-256s and the plan SHA-256, and saves all of it to `readonly-counts-plan.txt`. The run rebuilds the definition and refuses if its SHA-256 differs from the one in the go (a new image, SQL, code or CA). |
| Only SELECT | Each block or check must be a single `SELECT`/`WITH`. The script refuses write keywords (`INSERT`, `UPDATE`, `DELETE`, `MERGE`, DDL, `COPY`, `CALL`, `DO`, `LOCK`, `SELECT … INTO`, `FOR UPDATE/SHARE`, …) and functions that act even inside a read-only transaction: any `pg_*(…)` call, `dblink`, `nextval`/`setval`, `set_config`, `txid_*`, `*xact_id`, large-object functions and `*_to_xml`. It also refuses comments, quoted identifiers and `U&` escapes, which could hide a keyword. This is checked locally before any AWS call and again in the task. |

**Why the target login is the migration login:** row-level security on
`hotel_catalog.properties` and `platform.jobs` could hide rows from the ordinary
runtime login and produce a false zero. The read-only transaction and the
refusals above keep that login from writing. The database user is not pinned,
only the host, port and database are.

**Results:** `readonly-counts-result.md` (legacy blocks and Stripe) and
`predeploy-readonly-check-result.md` (6c), both 0600. The task log is kept as
`readonly-counts-task-<UTC time>.log`.

The result files are written only when the task exits 0 and printed both
sections and the final `COUNTS_COMPLETE` line. Otherwise only the raw log is
kept and the run fails. `watch <task-arn>` applies the same rule. Existing
results are never overwritten.

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

1. Freeze and snapshot. Write the freeze proof only after the freeze switches
   are confirmed: the CLI checks the proof, not that writes really stopped.
2. Restore the snapshots plus a copy of the live target, in isolation.
3. `target:cutover:dry-run` on the copy, then smoke on the copy.
4. The approval report.
5. The production `target:cutover`, which also runs the extraction.

That adds roughly 1.5–2.5 hours: the copy restore, a second migration run,
smoke and approval. It moves the window from about 3.5–4.5 hours to about
5–7 hours, so OTA closeouts are needed.

Tests: `node --test scripts/test-legacy-migration-oneoff.mjs` and
`PYTHONDONTWRITEBYTECODE=1 python3 -m unittest scripts/test_legacy_readonly_counts.py`.
