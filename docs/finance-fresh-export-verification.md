# One fresh Dashboard export: review contract

Status: **blocked, not an executable activation runbook**. No POST, worker
activation, or permission change is authorized by this document.

## Platform implementation under review

`finance-export-once.yml` uses the existing `production-ecs-mutations` lock.
It checks the original POST deadline before dedicated/general database
preflights, then invokes `scripts/run-finance-export-once.py`. Queue time counts
against the deadline; expiry fails closed. Do not rerun a failed workflow.

The script requires the exact stable API task definition and attested serving
digest. It builds a separate `vayada-finance-export-once` Fargate task with only
the dedicated export database secret, property/ID/dispatch identity, bucket,
region and application revision. It invokes the app-owned
`apps/api/dist/jobs/runFinanceDashboardExportOnce.js`; it never starts the API
server, migration launcher or polling timer. Service worker flags remain off.

The workflow uses the dedicated `vayada-github-actions-finance-export` OIDC
role and `platform-mutations-v2` environment, restricted to main in GitHub.
Its IAM trust matches only that environment subject. Export tasks use a
separate `vayada-finance-export-once` cluster; the existing shared role gets
no new finance PassRole, RunTask or StopTask access. An attached boundary explicitly denies finance-family registration,
execution and indirect service deployment, finance task
stop/exec, and passing finance task roles. Existing non-finance callers retain
their current permissions. This protects the new finance resources, not all
possible finance side effects: the legacy shared role still has privileged
SSM/S3, preflight-family execution and global task-definition cleanup authority. It and existing operators
remain trusted. Full shared writer-boundary enforcement remains a separate
coordinated-activation gate; do not claim global finance execution isolation.
Do not migrate unrelated callers as part of this verification.

AWS does not support resource scoping for `ecs:DeregisterTaskDefinition`.
The dedicated controller therefore has this cleanup action on `*`, limited
to eu-west-1; reviewed code restricts calls to recorded temporary task ARNs.
The shared role already has an out-of-module wildcard deregistration policy;
this change neither adds nor revokes that legacy authority. Family-specific
denial is unsupported for this action. Verify the dedicated controller
allow/region denial and record the retained shared-role access with IAM simulation. This unavoidable controller
cleanup authority is broader than its family-scoped register/run access.
See the [AWS ECS authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ecs.html).

The new task role has no direct S3 permission. The app must assume
`vayada-finance-export-once-writer` with a session policy restricting PutObject
to the exact Dashboard CSV key and absolute deadline. The base writer permits
only PutObject under the private Financials exports prefix and trusts only the
one-shot role. This relies on the reviewed app always supplying the session
restriction; the base role itself is not an exact-ID policy. Credentials stay
in app memory. An accepted S3 request can still have an ambiguous completion
after timeout; no claim of guaranteed remote cancellation is made.

The platform records task/definition ARNs and verifies STOPPED/INACTIVE cleanup.
Unknown registration or RunTask responses, stop failure, or deregistration
failure keep the window held for reconciliation. Do not infer a clean result
from workflow cancellation or process termination. Never delete job/artifact
evidence to resolve uncertainty. Exit zero is only task completion; artifact
acceptance requires the protected readback below.

Before any POST: complete app and platform review, test their combined path,
merge/deploy the app entry point and attest its immutable image, review a clean
Terraform plan for the isolated cluster, three roles/policies and refresh/boundary
attachment. Bootstrap these resources with an authorized principal
using a reviewed saved Terraform plan before merging: the shared apply role
cannot create roles or update its own policy. It receives only read access
to refresh the installed resources; future finance IAM changes require the
same authorized bootstrap process. Never grant it finance role management
or self-policy mutation. Verify the actual role permissions and main-only
GitHub environment restriction before dispatch. The existing image does not contain this new entry point.
No Terraform apply or workflow dispatch has been performed for this draft.

## Owners and baseline

VAY-2029 owns the platform execution and cleanup mechanism. VAY-1134 owns the
authenticated export request and artifact verification. VAY-1138 owns the
exclusive test window and the explicit user approval of the final executable
contract. The archived VAY-2045 task is not an active operator.

Verified baseline: next API task definition 1155, source
`a53a41ffb36fc84449559fffeebadefb429aac34`, image
`sha256:64f3cd6f30c0d45f229535b3084f941b60879cf791aff354f64264e3454fc2d2`.
Deployment 36011021847, health/readiness and postdeployment general database
preflight passed. Both Finance workers are disabled, property scopes empty,
and worker credentials unmapped. Recheck this baseline immediately before use.

Historical platform PRs #228, #231, #234 and #238 describe mapping, enabling,
disabling and unmapping the old export. They do not authorize a new export.
Never replay or reset terminal export `f3429f38-b462-4453-b7f1-d901fc86ebfa`.

## Required mechanism before approval

The deployed server calls `runFinanceFolioExportJobs` at startup and every five
seconds; its default invocation limit is ten. A retryable outcome can be
claimed again. An exact ID and one ECS instance alone do not enforce one
attempt. CI deployment/rollback queues cannot enforce a deadline measured
from the request.

Prepare and independently review an execution path before creating the export:

1. Bind one new export ID and the approved property without waiting for new
   PRs/builds after the POST. Reject any old, different or ambiguous identity.
2. Invoke the existing worker once with `limit: 1`, with a persistent claim
   guard that rejects an already-attempted job across process/task restarts.
   No polling timer, service replacement retry, or operator rerun is allowed.
3. Record the POST dispatch time before sending it and enforce a deadline
   no later than dispatch + 15 minutes, including request latency, queue delay
   and preflight. Clock uncertainty must shorten the budget or fail closed;
   server acceptedAt must never move the deadline later. An expired request must fail before claiming work.
   Bound local database and artifact operations. The guarantee is one local
   invocation, one eligible first attempt, and a POST-dispatch + 15 minute
   admission deadline. An S3 or database operation already accepted remotely
   may complete after local timeout. Treat any such outcome as ambiguous,
   keep all processing off, and reconcile read-only before claiming success
   or considering a separately authorized retry. A stop request alone is not
   proof of stop.
4. Restrict the task to the dedicated export login and reviewed property/ID;
   run dedicated and general preflights. Keep the expense worker off.
5. Prepare rollback and disabled/unmapped cleanup before starting. Prove
   timeout, retryable failure, process restart and ambiguous outcome handling
   with nonproduction tests. Never use production failure injection.

These are acceptance requirements for the missing mechanism, not claims about
the current implementation. Any new runner/workflow or changed worker behavior
requires its own reviewed change and applicable deployment approval. Do not
promise a hard remote side-effect cutoff at 15 minutes.

Before a fresh POST, require final stacked PostgreSQL 16/17 and CLI checks,
independent review, clean app merge composition, immutable image attestation
and a deployment with workers disabled, a clean platform PR #247 apply,
exact database and permissions preflights, reviewed fresh-ID execution and
stop/deregister plans with both service workers disabled and unmapped, and
explicit exclusive property-window approval. Complete these gates before
requesting that approval. The base branch filter does not run full CI for an
app PR stacked on another topic branch; retarget it to main after its
predecessor merges and pass the final checks.

## Proposed request and evidence contract

- Property: `65f6b2fc-c783-4963-9d6b-a85f82319769` (Codex Test Hotel).
- Organization: `org_01M1RC66GQZ5M9ZW08DW6RGXDG`.
- Use the existing reusable owner login; verify its property and organization
  binding. Never copy credentials into this document or logs.
- Confirm no competing VAY-2037/2039/2044 or other shared-property writes.
- After executable review and explicit window approval, record dispatch time
  and issue one POST to
  `/api/finance/properties/{property}/financials/exports` with a fresh UUID
  commandId, one fresh idempotency key identical in header/body, and
  `{tab:'dashboard',format:'csv',filters:{}}` in the existing request schema.
- Require HTTP 202 `created`. If the response is ambiguous, stop and reconcile
  without another POST. Record the new ID and sanitized timestamps only.
- Before execution, verify acceptedAt, 24-hour expiry, valid snapshot/manifest,
  zero other eligible work, and the exact new ID. The operational deadline
  remains 15 minutes; the job's 24-hour expiry does not extend it.
- Poll only the protected GET for that ID. Stop on first failure, retry,
  dead-letter, drift or timeout. Preserve job, attempt, audit and artifact rows.
- Success requires exactly one attempt and one nonempty private Dashboard CSV
  artifact. Verify metadata/checksum/manifest, expected headers and formula
  safety without retaining raw CSV, guest data, signed URLs or secrets.
- Finish with both workers disabled and unmapped, scopes empty, the bounded
  task stopped, and health/readiness plus general database preflight passing.
  Record actual deadline/stop timestamps and release the exclusive window.

No other Financials activation, five-tab export sweep, payment, reservation,
backfill, or unrelated fixture mutation is included.
