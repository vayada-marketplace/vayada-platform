# Online hotel setup provisioning — VAY-965

Contract: application [automatic internal setup](https://github.com/vayada-marketplace/vayada/pull/2805).
The existing manual bootstrap keeps its blocked-caller/zero-private-task gates.

`assert-hotel-setup-online-readiness.py` is a read-only prerequisite for the
separate online runner. It requires stable public/private definitions, retained
fixed public caller pairs, isolated serving identities, exact reader/token
references, fixed native database endpoint and purpose, reviewed immutable private
images, matching physically running containers and no draining replacements.
It never reads secret values or creates, stops or updates a task or service.

The checked-in online image inventory starts empty. The older serving images
cannot admit an online provisioner. Populate each purpose only after actual
compiled primary/rollback PostgreSQL 16/17 proof verifies readiness schema,
reader ACLs, exact role OID, pinned native secret version and failure/revocation
behavior. Operational images additionally need the first-publication and bounded
reconciliation proofs. An image's ordinary setup proof is insufficient.

The future main-only runner shares `production-ecs-mutations` and captures this
snapshot before administrative work. It rechecks immediately before starting each
bounded ephemeral pass and must retain the same reviewed serving definitions
through publication. Organization/property operational task roles and native
secret prefixes stay disjoint; only the dedicated execution identity injects the
admin URL. No per-hotel service pause or API secret-write privilege is introduced.
There is no scheduled runner or production activation in this prerequisite slice.
