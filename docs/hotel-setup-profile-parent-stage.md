# Fixed profile parent pre-stage (VAY-965)

Application migration 0470 (`0470_hotel_setup_profile_edit_scope.sql`, sha256
`065464209d9d0f32bb20465c3f511bf7feb7a15199617a2d7ad06c135334e536`) adds the
actor-bound `property_profile` purpose. Like 0466, it needs the NOLOGIN parent
`vayada_next_hotel_setup_profile_scope`, and the production migration owner
`vayada_target_prod_user` cannot create roles. Merging the application slice is a
release, because public API startup applies 0470–0472. Stage the parent **before**
that merge; 0470 then skips `CREATE ROLE` and only verifies the parent's posture.

The protected main `hotel-setup-migration-scope.yml` workflow gains
`scope=profile_0470`. It never applies migrations or writes the ledger. Its only
mutation creates the absent fixed parent, as the logo parent did.

## Preconditions

- An operational bootstrap image whose `/app` contains the exact 0470 bytes and
  the applied 0466–0469 bytes, registered in `deployment/hotel-setup-bootstrap-images.json`
  by its own reviewed inventory change. Images built before application PR #2898
  do not contain 0470 and fail closed.
- All public callers explicitly blocked: creation, property and logo exactly
  `blocked`, and the profile caller either absent (before its first release) or
  exactly `blocked`. No admission marker may come from secrets.
- Both private services (`vayada-hotel-setup-service`,
  `vayada-hotel-setup-property-service`) stopped, with no running or draining tasks.
- An active incompatible-frontend coordinated hold that captures the exact stable
  serving public API task passed as `expected_task_definition`.

The driver rechecks the unchanged hold, admissions, service counts and physically
stopped tasks before launch, during execution and after completion, and stops and
deregisters its owned task on exit. Only the fixed admin URL and the pinned RDS CA
are injected; the task has no AWS role.

## What the module verifies

- The protected admin is exactly `vayada_admin`, NOSUPERUSER CREATEROLE, on the
  primary `vayada_target_prod` database.
- `platform.hotel_setup_property_scopes` is owned by `vayada_target_prod_user`,
  with neither CREATEROLE nor superuser.
- 0466–0469 are exactly applied in production (canonical names, pinned checksums,
  no failed or foreign rows). 0470 may be absent, or contain only exact
  `permission denied to create role` failures of the pinned bytes. Any 0471+, applied,
  unknown or mismatching history fails closed.
- The parent does not already exist (no adoption). After `CREATE ROLE`, no login,
  inheritance, elevated attributes, role settings or outgoing memberships. Incoming
  memberships are none (RDS) or exactly `vayada_admin` with ADMIN=true,
  INHERIT=false, SET=false and a superuser grantor (stock PostgreSQL 16/17).
- No business grant is added. A lost COMMIT acknowledgement reports
  `hotel_setup_scope_commit_inspection_required`; inspect, never retry blindly.

The wrapper accepts only the exact receipt
`{status:PASS, migration:0470, scopeRole:vayada_next_hotel_setup_profile_scope, ...,
scopeIncomingMemberships:0|1}`; a logo receipt cannot satisfy a profile run.

## Afterwards

Restart or release the reviewed primary public image with all callers blocked so
canonical startup applies 0470–0472, verify the ledger and catalog, then restore
callers and private services through the protected release. Credential grants and
caller admission for profile edits are a separate platform change.

If 0470 was merged first and failed exactly on `CREATE ROLE`, the same workflow can
stage the parent afterwards; then restart the public API to apply 0470.

## Local verification

`scripts/test_hotel_setup_creation_runner.py` covers the wrapper gates and exact
receipts. `scripts/test_hotel_setup_profile_parent_native.mjs` runs the module
against isolated loopback PostgreSQL 16/17 clusters with a NOSUPERUSER CREATEROLE
admin (`TEST_PG_MODULE`, `TEST_DATABASE_URL`, `TEST_MIGRATION_DIRECTORY` pointing at
the application's migrations). It covers image-byte, owner and ledger denials, safe
posture, the exact creator edge, existing-parent denial, unchanged ledger and catalog,
and an unknown COMMIT. It is not proof of RDS administrator authority.
