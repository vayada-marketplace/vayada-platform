# Isolated migration application smoke

VAY-1361 continues the completed VAY-1470 storage slice. This first slice adds
only a separate application task role and two retained rehearsal Finance keys.
It does **not** start an application, create a service, copy credentials, alter
production routing, or complete the application-smoke gate.

## Runtime contract

- Reuse the immutable rehearsal run, target, source tags, parity checksum and
  digest recorded in VAY-1361. Do not restart migration or substitute shared
  `next-*` services. The migration role and its media reservation stay unchanged.
  Start the packaged `apps/api/dist/server.js` directly: its default image
  entrypoint reruns schema migrations, which this completed run does not need.
- Run the pinned API and a browser runner as a bounded one-off ECS task; use
  task-local HTTP only, with no ALB, DNS record, public listener or ECS service.
  Build any required frontend runner from the reviewed application source with
  test-local API/origin configuration. Never use a shared frontend as evidence.
- Use the operator's authorized reusable test accounts, preserving their shared
  property and memberships. Obtain a short-lived session through normal next
  login; use the packaged WorkOS verifier for signature, issuer and client
  validation against public provider metadata. These test accounts use WorkOS
  Production identities, not a sandbox tenant. This authorizes login only, not
  provider management or shared-product mutations. No new provider user is needed.
- Inject only the exact isolated target connection and short-lived test session
  into the bounded test task. The app receives public WorkOS verifier metadata,
  **no WorkOS API key or live cookie-sealing secret**, and no migration bundle,
  source-reader credentials or administrator connection. Keep credentials out
  of command arguments, logs, source and evidence. Any required local identity
  mapping must be explicitly synthetic and target-scoped; never remap migrated
  people by email or impersonate their provider identities.
- Start with a database-enforced read-only application role. Unmapped reusable
  identities must fail closed; record those denials, not an authenticated-read
  success. A separately reviewed target-only mapping step is required before
  claiming authorized migrated-data reads. Login on next alone is not isolated
  application smoke. Tokens expire quickly; expiry is a failed check, not a
  reason to disable verification or export long-lived credentials.
- Use `API_RUNTIME=next`, every tested domain's target source and a non-production
  Node environment. The existing production startup requires live delivery
  configuration; do not invent provider credentials to satisfy that guard.
  Record that this is isolated application/data smoke, not production delivery
  acceptance. Stripe, Xendit, Channex, Resend and social-provider credentials
  must be absent; webhook intake stays observe-only and Channex workers off.
- The exact release starts several database jobs unconditionally. A reviewed
  launcher must capture the before-start baseline and explicitly account for
  their effects, or use database-enforced read-only permissions for the first
  read-only phase. Do not claim that omitting delivery credentials disables
  all jobs. Do not launch a writer before this containment gate is reviewed.
- The application role can read migrated public/private media, but **cannot
  write, delete or overwrite any S3 object**, including retained evidence.
  Disable media cleanup and draft retention. Upload/publish writes are not
  covered by this slice; VAY-1470's separate live storage evidence is retained.
- Encrypt/decrypt and fingerprint only synthetic Finance recipients using the
  two rehearsal keys. Production ciphertext must remain inaccessible.

## Administrator bootstrap

Follow the saved-plan administrator workflow in `environments.md`, with platform
applies paused. Target only the application role, its inline policy, the two
`migration_rehearsal_application` keys, the CI key-read managed policy and its
attachment, and the existing CI base policy. Require exactly six creates and one in-place base
policy update. The base update adds only the exact application role to the four
existing IAM read actions. The new CI policy grants read-only access to the two
new keys plus inspection of that exact managed policy; no key creation,
cryptographic use, IAM writes or PassRole expansion. The separate managed policy
avoids exhausting the existing role's inline-policy quota. Review both aggregate
inline characters and managed-policy attachment quota before applying. Merge the same reviewed
commit before resuming normal platform applies. Never modify the production
Finance keys/policies or the VAY-1470 migration task role.

## Remaining evidence gates

### Read-only database prerequisite

The read-only checks live in `scripts/migration-rehearsal-reader-contract.mjs`.
The separate reader-bootstrap slice supplies the operations payload for the
pinned rehearsal image, where `pg` is already installed. It requires explicit
`REHEARSAL_READER_MODE=inspect|create`. Inspect uses a read-only transaction;
create grants one expiring, connection-limited role SELECT/USAGE on the existing
target domain tables and retained attestation only. The bootstrap task alone
receives the isolated administrator URL. Never give that URL or a source/migration
bundle to the application. Pass both URLs via secret injection, never arguments.

The payload verifies the exact RDS-host/database/OID, version, run, completed
checkpoints, release, attestation and parity bindings before grants. Existing
roles fail closed for operator inspection, not password rotation or repair.
Passwords are randomly generated ASCII; only a client-derived SCRAM verifier
enters SQL. Its explicit READ WRITE / zero-row UPDATE denial proves table ACLs,
not merely a client read-only setting. Trigger creation, sequence writes and
PostgreSQL 17 MAINTAIN privileges are also forbidden.

The only table-permission exception is UPDATE/column-UPDATE on the native
`pg_catalog.pg_settings` view, whose standard rules only change session settings.
Before any role creation, verify its exact reviewed RDS17.9 owner, view/rule
definitions and zero triggers against the retained fixture hash. Unexpected
rules, another view, or any INSERT/DELETE/TRUNCATE/TRIGGER/REFERENCES/MAINTAIN
privilege still fail closed. CASE guards keep sequence-only checks type-safe.

Containment covers migrated business/evidence tables for this fixed reviewed
application. PostgreSQL PUBLIC CONNECT and built-in capabilities are not a
hostile-SQL sandbox. Do not change global PUBLIC privileges or expose arbitrary
SQL. Every app connection must use the guarded target URL with read-only startup
options. A reader bootstrap PASS is not application, job or browser acceptance.
If proof fails after COMMIT, the expiring role and secret deliberately remain;
inspect them before any retry. Never rotate/reset or grant additional privileges
to make a failed proof pass, and never give an app that credential before PASS.

Run the read-only deployed IAM/key check, then a reviewed bounded runtime test.
Record actual login/session allow/deny checks, migrated Booking/PMS/Finance/
Marketplace reads, media delivery, public read-model privacy and controlled job
idempotency. Preserve before/after hashes and identify every synthetic write.
Stop the task to rehearse abort-before-switch; prove legacy remains sole provider
owner and no customer-facing replay occurred. This does not prove rollback after
production writes, or measure the final production delta/freeze window.

Only complete `production-cutover-smoke.v1` after all required checks actually
pass, then resume the same immutable orchestration with that report. Named owner
approvals, production provider cutover and legacy retirement remain separate.
