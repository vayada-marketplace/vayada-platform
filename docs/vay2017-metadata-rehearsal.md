# VAY-2017 metadata rehearsal

This change configures the existing lane as a fixed **catalog-only fingerprint preflight** for VAY-2042, using the existing VAY-2017 metadata login and isolated restore. It is not an extraction, row-count inventory, production migration or cutover. The previous v2 collector remains tested for historical compatibility but is not selected by the new task definition. Deployment and dispatch require the separate gates below.

## Catalog contract and deployment boundary

- Pin app release `b83cec1894c81b5f65fb8a871fdaa6e0e67335af`, image `sha256:b9cbbeedcdb7a1530b32fdae31c00d75db0ae4c6d53143ca2acf26c0002e3b17` (build `36134864409`, artifact `10863860900`). Only the metadata task changes image; successful bootstrap tasks retain their original image and must not be rerun.
- Import the existing product `SOURCE_SCHEMA_FINGERPRINT_SQL` from `/app/packages/backend-migration/dist/sourceInventory.js`; require its SHA-256 `9707f57e277e424ca9f97610511fce3f4d3b9fc56722cc4957b2971dd0541f37` before connecting. Do not duplicate a scanner or accept caller SQL.
- Read catalogs in exactly four databases: `auth=vayada_auth_db`, `booking=vayada_booking_db`, `marketplace=postgres`, `pms=vayada_pms_db`. Each uses a separate repeatable-read, read-only transaction with the exact metadata login, database and private server-address checks. No discovery, application-table counts/values, source credential reads, target connection, grants or writes.
- Emit only version 3 `isolated-source-catalog` evidence: exact restore/image/query/scanner identity, collection time and four product-compatible 32-hex MD5 fingerprints. The wrapper rejects v2, extra fields/databases, wrong identity or fingerprint formats. Artifact name: `vay2042-source-catalog-<run-id>`; file: `source-catalog-fingerprints.json`.
- This artifact is **not** source-reader ACL/provenance verification, cross-database snapshot consistency, freeze proof, target attestation, a run binding or data parity. The snapshot is historical; it does not prove production is frozen.

Before any deployment, review a fresh saved plan. Expected scope is one isolated metadata task-definition replacement and its exact RunTask-policy/state-machine reference updates; no database, secret, network, permission expansion or bootstrap change. Obtain approval before applying. After apply, independently verify the effective image, embedded collector/checksum, `VAY2017_CATALOG_ONLY=1`, secret references, IAM task reference and state-machine task reference. Do not dispatch before this readback and the separately approved catalog-only run below.

## Before each inventory

1. Confirm the isolated infrastructure root in `infra/vay2017-metadata-runner` is applied from an independently reviewed saved plan as described in `docs/vay2017-metadata-infrastructure-lane.md`. Also confirm the dedicated `vay2017-metadata-preflight` GitHub environment is restricted to `main`, requires the designated owner approval, and has administrator bypass disabled. Per the owner's decision, the designated owner may approve runs they initiated. The current shared `next` environment has no protection rules and must not be used for this workflow. Do not broaden the generic platform-deploy role to make apply pass.
2. From this repository, with an authorized, read-only operator AWS identity in the reviewed account, run:

   ```bash
   bash scripts/check-vay2017-rehearsal-isolation.sh
   ```

   This verifies the exact source snapshot and isolated restored instance, encryption/privacy, pinned image, dedicated VPC, no-internet/no-peering routes, endpoints, and security groups. It reads AWS metadata only; it does not connect to the database or inspect its contents. Do not dispatch the inventory if any check fails.
3. The new restored database is created with its dedicated PostgreSQL-only security group in the same approved infrastructure plan. The older restore in the shared default VPC is not used or modified. If the new restore does not have exactly the expected security group, stop and get a new plan/review; do not repair its access rules manually.
4. The one-time metadata reader setup already completed. Reuse it; do not rerun any bootstrap, rotate credentials, add grants or call its count function for this operation. If authentication fails, inspect the sanitized failure and obtain a separately reviewed recovery decision.
5. After fresh isolation/effective-task checks and explicit approval for these four catalog reads, dispatch **VAY-2042 Source Catalog Fingerprints** from protected `main` (`vay2017-metadata-inventory.yml`). Its workflow has no caller-supplied command, database, or resource inputs and cannot retrieve the master secret. It starts the existing fixed Step Functions lane and uploads only the sanitized fingerprint artifact. Inspect any failure; do not retry blindly.

The GitHub workflow role deliberately has no broad EC2, RDS, or ECR describe permissions. The dedicated environment approval is the enforceable gate for the separate operator check; the approver must confirm the successful check immediately before approving each run. Repeat it immediately before every dispatch to minimize configuration drift. Do not run the workflow until that environment's reviewer/bypass settings have been verified.

Never restore another database, read or export row contents, use a production credential, run a migration, change owner access, write to providers, cut over, or shut down the legacy system as part of this rehearsal. If the exact resource identity or isolation boundary differs from the checked-in attestation, stop and get the evidence and code reviewed again.
