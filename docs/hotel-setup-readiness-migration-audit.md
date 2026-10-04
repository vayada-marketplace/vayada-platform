# Read-only readiness migration transition

Use the existing protected `hotel-setup-migration-audit.yml` workflow on `main`,
selecting `readiness_0463_0464`, the exact stable public task definition and an
immutable operational image recorded in `deployment/hotel-setup-bootstrap-images.json`.
Image admission must be separately reviewed; the historical bootstrap image
cannot pass this audit because it does not contain migrations 0463 and 0464.

The existing runner command is:

```sh
bash scripts/run-target-database-runtime-preflight.sh --audit-hotel-setup-readiness-migrations "$IMAGE_DIGEST"
```

The workflow supplies `EXPECTED_TASK`. Its protected owner injection stays inside
the ephemeral task, with no SDK task role. The task reads the fixed production
database through verified TLS in a read-only repeatable-read transaction, taking
the existing migrator's advisory lock to reject simultaneous migration work.

Every prior migration file must match the latest production applied ledger entry.
Unknown versions, unresolved failures, missing prior entries and changed names or
checksums fail closed. Only 0463 and 0464 may be absent, their exact SQL hashes are
pinned, and their columns, constraints and cursor table must still be absent.
The receipt contains only the applied count, image-file manifest hash and fixed
pending versions. It contains no database URL, PostgreSQL error or customer data.

This audit performs no DDL, ledger writes or credential changes. It cannot be used
after the two migrations are applied. The existing `start-next-api.sh` owner
migrator remains the separate apply path before starting the public API.
