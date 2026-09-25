# VAY-2029 evidence index

Evidence in this directory is append-only audit material. Older JSON snapshots
remain historical and must not be overwritten to look current.

## Current evidence

- `final-candidate-publication.json`: exact fresh candidate selected for production;
- `production-activation.json`: hold resumes, six-service activation, duplicate
  no-op, stale-event fence, deployed identities, and restored workflow states;
- `production-smoke.json`: bounded production release and browser smoke;
- `matched-measurements.json`: measured backend-only/cutover/no-op samples and
  explicit sample gaps;
- `candidate-publication.json`: exact non-production candidate publication;
- `hosted-rehearsal.json`: isolated recovery and lock rehearsal;
- `affected-input-rehearsal.json`: dependency-selection rehearsal;
- `live-inventory.json`, `active-queue.json`, `ecr-provenance.json`, and
  `source-build-proof.json`: historical September 20 observations;
- `iam-bootstrap-plan.json` and `iam-managed-policy-plan.json`: historical,
  consumed IAM plans; never reuse them.

The historical pause-window snapshot, hold reconciliation, activated candidate,
and installed writer boundary are recorded in
`../../coordinated-release-activation.md`.

## Acceptance map

| Acceptance criterion | Evidence | State |
| --- | --- | --- |
| AC1 runbook/cutover inventory | activation runbook, final candidate, preflight snapshots | Satisfied |
| AC2 integrated recovery | hosted and affected-input rehearsals plus targeted suites | Satisfied |
| AC3 independent review | PRs #274/#275/#276 and independent image review | Satisfied |
| AC4 exact approval | approval named artifact `10867296213` and four broad operational steps, but did not restate both hashes/revision/full sub-action tuple | Partial |
| AC5 stale writer fencing | PRs #262/#265/#272 plus run `36161462488` | Satisfied |
| AC6 coordinated activation | `production-activation.json` | Satisfied |
| AC7 real release/product smoke | activation smokes and browser canary `36161297153` | Partial; authenticated business-data reads remain and Finance product impact is unknown |
| AC8 result accounting/recovery | hosted rehearsal plus post-activation preflights `36161738886`/`36161818636` | Partial; `next-target-backend` task `1162` needs reviewed least-privilege reads on four exact Finance relations and a passing runtime preflight |
| AC9 matched measurements | `matched-measurements.json` | Partial; shared-package and merge-burst samples remain |
| AC10 affected-only/reuse/overlap | one API build/five reused plus 1.33-second frontend start spread | Satisfied |
| AC11 safe system rollback | activation runbook + hosted rehearsal | Prepared; production path unexercised |
| AC12 final exact evidence | final activation/smoke/measurement records | Satisfied with limitations stated |

Keep VAY-2029 In Progress until the four partial acceptance rows are closed and
the human explicitly accepts the result.
