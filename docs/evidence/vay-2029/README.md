# VAY-2029 evidence index

Evidence in this directory is append-only audit material. Older JSON snapshots
remain historical and must not be overwritten to look current.

## Current evidence

- `candidate-publication.json`: exact non-production candidate publication;
- `hosted-rehearsal.json`: isolated recovery and lock rehearsal;
- `affected-input-rehearsal.json`: dependency-selection rehearsal;
- `live-inventory.json`, `active-queue.json`, `ecr-provenance.json`, and
  `source-build-proof.json`: historical September 20 observations;
- `iam-bootstrap-plan.json` and `iam-managed-policy-plan.json`: historical,
  consumed IAM plans; never reuse them.

The current pause-window snapshot, holds, exact candidate, and installed writer
boundary are recorded in `../../coordinated-release-activation.md`.

## Acceptance map

| Acceptance criterion | Evidence | State |
| --- | --- | --- |
| AC1 runbook/cutover inventory | activation runbook, candidate publication | Prepared; refresh immediately before mutation |
| AC2 integrated recovery | hosted and affected-input rehearsals plus targeted test suites | Partial; final combined scenario matrix/rerun evidence still required |
| AC3 independent review | PR #274 review; final combined review still required | Partial |
| AC4 exact approval | approval must name artifact/hashes and operations | Missing |
| AC5 stale writer fencing | PRs #262/#265/#272 and runs in activation runbook | Satisfied |
| AC6 coordinated activation | production activation record | Missing |
| AC7 real release/product smoke | production activation and smoke records | Missing |
| AC8 result accounting/recovery | hosted rehearsal | Satisfied for rehearsal |
| AC9 matched measurements | backend-only/shared-package/burst evidence | Missing |
| AC10 affected-only/reuse/overlap | affected-input + hosted rehearsal; production proof pending | Partial |
| AC11 safe system rollback | activation runbook + hosted rehearsal | Prepared; production path unexercised |
| AC12 final exact evidence | final activation/smoke/measurement records | Missing |

After an approved activation, add immutable `production-activation.json`,
`production-smoke.json`, and `matched-measurements.json` records. Keep VAY-2029
In Progress until those records and explicit human acceptance exist.
