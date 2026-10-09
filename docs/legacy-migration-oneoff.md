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
2. **Before starting anything:** it clears inherited AWS credentials and the
   overrides `AWS_ENDPOINT_URL*`, `AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE`
   and `AWS_CA_BUNDLE`, and
   requires the `vayada` profile to resolve to account `269416271598`. It refuses if a
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
   - **Database pins and TLS:** the pinned RDS CA (`rehearsal/rds-ca-rsa2048-g1.pem`,
     SHA-256 `f5c5f92a…`, checked by the script and again in the task). Before
     the CLI starts, the dispatcher checks every database URL:
     - the target must be host `vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com`,
       port 5432, `vayada_target_prod`, user `vayada_target_prod_user`;
     - the sources must be the run file's `sourceHost` (an RDS host in this
       account, never the production `vayada-database`) and `sourceUser`, with
       the expected database names.

     A URL that does not match is refused (exit 64). The CLI starts with
     `node --require scripts/legacy-migration-tls.cjs` (SHA-256 pinned in the
     dispatcher), which wraps `pg.Client` and `pg.Pool` before the CLI imports
     pg. Every client and pool gets the explicit TLS
     object `{ ca: <pinned RDS CA>, rejectUnauthorized: true, servername:
     <host> }`, which verifies the certificate and hostname. Any host or port
     that is not pinned is refused, and so is any query parameter other than
     `application_name`, because pg would let it override the URL. The URLs
     still carry `sslmode=verify-full` with the CA, as a fallback for any
     client the preload did not patch. This is the same object the app's
     historical-binding preflight uses. A proof against the real pg 8.21 (as
     imported by the CLIs) is in the evidence folder.
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
  "sourceHost": "<restore>.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com",
  "sourceUser": "<restricted reader login>",
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

1. Create the four source SecureStrings for the attested go-day restore, all on
   the restore host and the reader login named in the run file.
2. Let next-api's security group reach that restore.
3. In the rehearsal, confirm two things:
   - `ecsTaskExecutionRole` can read those parameters;
   - `vayada-next-api-media-task-role` can read the legacy media
     (`vayada-uploads-prod`, `vayada-creator-marketplace-images`) and write
     `public/media/` and `private/media/` in the platform media bucket.
4. Pin the rehearsed image: its `APPLICATION_RELEASE` must equal `--application-release`.

## Read-only counts (`readonly-counts`)

```bash
EVIDENCE_DIR=<0700 evidence folder> bash scripts/legacy-migration-oneoff.sh readonly-counts-plan <counts.sql> scripts/legacy-predeploy-readonly-check.sql
EVIDENCE_DIR=<0700 evidence folder> bash scripts/legacy-migration-oneoff.sh readonly-counts <counts.sql> scripts/legacy-predeploy-readonly-check.sql READONLY_COUNTS:<plan sha256>
```

A read-only snapshot for go-day planning. It covers two inputs:
- the legacy PMS and Booking blocks in `readonly-counts.sql`;
- the 6c pre-deploy check on the production target, run from the counted copy
  `scripts/legacy-predeploy-readonly-check.sql`.

There is no Stripe part: Flamur read the two subscriptions directly.

The counted copy differs from the 6c owner's reference query in one place: the
per-property column is `count(*)` instead of an aggregate that concatenated two
columns. The check therefore needs no string concatenation, and the count it
reports is the same.

`readonly-counts.sql` stays in the evidence folder rather than the repository,
because it names candidate hotels. Both inputs are still embedded in the
disposable task definitions, which are deleted afterwards, and are recorded by
CloudTrail.
Nothing runs before the plan is reviewed and Flamur's go names the plan SHA-256.

**Do not run during deploys.** pms-api and next-api run migrations when they
start. The script refuses unless both services run exactly one task in one
completed deployment.

| Coordinator check | How it is met |
|---|---|
| Owner-checked pattern | **Image:** the digest of the single running `vayada-pms-backend` task, named in the plan, never a tag. **Embedded in each disposable definition:** the code (`python -I -c`), that task's SQL and the RDS CA bundle (`rehearsal/rds-ca-rsa2048-g1.pem`, SHA-256 `f5c5f92a…`, checked by the script and again in the task). **One task per database, each holding only its own secret**, with these pins: |
| | PMS: `/vayada/prod/db-pms-url`, which must be `vayada_pms_user` @ `vayada_pms_db`. |
| | Booking: `/vayada/prod/db-booking-url`, which must be `vayada_booking_user` @ `vayada_booking_db`. |
| | Target: `/vayada/prod/target-database-url`, which must be `vayada_target_prod_user` @ `vayada_target_prod`. |
| | **Every connection:** host `vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com` and port 5432 are pinned too. TLS is verified against that CA, including the hostname (verify-full). |
| Read-only, aggregates only | **Transaction:** every statement runs inside `BEGIN TRANSACTION READ ONLY` … `ROLLBACK`, with a 15 s statement timeout and a 1 s lock timeout. **Printed legacy blocks:** the top-level SELECT list may hold only `count(…)` (optionally with `FILTER (WHERE …)`), `max(<*_at, *_date, check_in or check_out column>)` cast to `date` or `timestamp`, and the reviewed label columns (`label`, `stripe_billing_status`, `billing_active_plan`, optionally inside `coalesce(…, '<text>')`). It may also hold the hotel identity labels `<h>.id`, `<h>.name` and `<h>.slug`, where `<h>` is the legacy `hotels` table, or its alias, written directly after `FROM` or `JOIN` in the top-level query (aliases inside subqueries do not count). The word `hotels` may appear only there, as `hotels.<column>`, or as an output column name (`AS hotels`): no other table, subquery or CTE may be called `hotels`, `hotels` may not be schema-qualified, and it may not take a column alias list (`hotels h(a, name)`). **Printed columns come only from base tables and literal lists:** the top-level `FROM` may not contain derived tables (`FROM (…)`, parenthesised joins, `ROWS FROM`) or `LATERAL`. Every CTE must be a `VALUES` list of literals (strings, numbers, `NULL`/`TRUE`/`FALSE`, simple casts), and `WITH RECURSIVE` is refused. `GROUP BY` may use only positions and those labels. Top-level `UNION`, `INTERSECT` and `EXCEPT` are refused, so every printed row comes from the checked list. At most 50 rows. **Target checks:** each 6c `SELECT` (the file's own `BEGIN`/`ROLLBACK` are dropped) runs as `SELECT count(*) AS rows_found FROM (…)` and must return exactly that one value, so no target row is printed. **Errors:** only a code or the exception type is printed. |
| Least privilege, no new IAM | No task role. The execution role is the existing `ecsTaskExecutionRole`. Logs go to the existing `/ecs/vayada-pms-backend` group. No Terraform. All definitions are deregistered and deleted afterwards. |
| Dry-run / plan mode | `readonly-counts-plan` makes only read-only AWS calls. It prints every statement exactly as it will run, with its database and user, and each task's image, role, secret and log group. It also prints the network, the cluster, the code and SQL SHA-256s and the plan SHA-256, and saves all of it to `readonly-counts-plan.txt`. The plan SHA covers all definitions, the network configuration, the cluster and the code SHA. The run refuses unless the go names it. |
| Only SELECT | One `SELECT`/`WITH` per block or check. **Only allow-listed functions may be called:** printed blocks `count`, `max`, `coalesce`; counted 6c checks `count` only. Every other function is refused, including schema-qualified calls and calls disguised as CTE names. Also refused: write keywords, row locks, `SELECT … INTO`, comments, quoted identifiers, `U&`, `$` (dollar quotes and parameters) and `E'…'` strings. String concatenation (`\|\|`) is refused everywhere, with no exception. Checked locally (`python3 -I`) before any AWS call and again in the task. |

**Why the target login is the migration login:** row-level security on
`hotel_catalog.properties` and `platform.jobs` could hide rows from the ordinary
runtime login and produce a false zero. The read-only transaction and the
refusals above keep that login from writing.

**Results:** `readonly-counts-result.md` (legacy PMS and Booking) and
`predeploy-readonly-check-result.md` (6c), both 0600. Each task's log is kept as
`readonly-counts-<kind>-<UTC time>.log`.

The tasks run one after another. Results are written only when every task exits
0 and ends with its `COUNTS_COMPLETE` line; the first failure stops the run, and
only raw logs are kept. Existing results are never overwritten: once a folder holds `readonly-counts-result.md` or `predeploy-readonly-check-result.md`, both plan and run refuse it, so its plan file stays too. If the run is
interrupted, `watch <task-arn>` saves that task's raw log; start a new run for
the results, with a new go.

**Running only legacy blocks:** pass `none` instead of the 6c file. The plan
and run then contain no target task, and only `readonly-counts-result.md` is
written. Use a separate 0700 evidence folder for a second read, so the first
results stay untouched.

**A non-zero 6c count returns no IDs.** Explaining the hits needs a second,
separately reviewed query that is allowed to return them, with its own go.

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
