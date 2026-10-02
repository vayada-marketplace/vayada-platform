# VAY-1543 temporary creation identity — review only

**Blocked for execution:** the scoped SSM read exception below is proposed for
review, not granted or approved for activation. The temporary identity now has
no IAM write allowances and cannot execute the former seven-create plan.
The distinct selected-owner creation role below is now concrete Terraform for
review, not installed or approved for execution. Its executor gates remain absent.
No activation is ready.

This is the first implementation slice of the hosted operator proposal in
[contract #251](https://github.com/vayada-marketplace/vayada-platform/pull/251).
It defines only the creation identity, not an executor or metadata-phase identity.
Merging it creates nothing: the normal platform root does not load this folder.
The isolated root's default `creation_window=null` and
`operator_creation_window=null` declare zero resources.
No workflow provisions or assumes the new role.

`infra/pricing-bootstrap-identity` owns a separate IAM-only state key. An
authorized operator must review its own exact four-addition plan and identity
(one role, its creation/fence inline policy, a managed refresh policy and attachment;
six additions with the SSM opt-in's separate managed policy and attachment);
never add it to the seven-create pricing plan, import existing identities,
apply from normal CI, or populate it with production Terraform inputs.
Only reviewed exact KMS metadata ARNs may be supplied; default empty inventory
is not evidence that production-root refresh works. The SSM opt-in is separately
off by default (`enable_ssm_refresh_decryption=false`).

The creation role reuses the enumerated plan-policy refresh/lock allowlist,
adds writes only to the exact production state object and five fixed secret
names with their required tags. Secret ARNs have
six suffix placeholders, not a broad prefix. No metadata-policy mutation,
service mutation, PassRole, Secrets Manager value read/subsequent write,
or role assumption is allowed. KMS decrypt is denied by default; the proposed
exception permits only the fixed SSM refresh described below. State/SSM
configuration reads remain privileged.
CreateSecret can include initial values: IAM does not prove empty containers.
Reviewed source, exact-plan approval and verification must enforce that remaining
trusted-operator restriction.

### Role-mutation restriction — proposed for review

CodeRabbit identified that CreateRole/PutRolePolicy could grant another
principal persistent execution-role authority beyond the bootstrap window.
The proposal removes both permissions rather than relying on expiry or an
invented permissions-boundary ARN. An unconditional all-resource denial also
covers role creation, inline policy writes/deletes, trust edits, managed-policy
attachments/detachments, role deletion/tag changes and boundary changes.
The remaining IAM allowances are exactly the existing eight Get/List actions.
Tests verify this in both default-deny and SSM-opt-in policy compositions.
Read-only custom-policy simulation denied all 11 mutation actions on the
execution, bootstrap and unrelated role ARNs (33 resource decisions), allowed
GetRole/ListRolePolicies, implicitly denied policy creation/version changes
and explicitly denied PassRole. These simulated documents are not deployed
policies or actual-role enforcement evidence.

A [permissions boundary](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html)
limits identity-policy permissions, not the arbitrary trust document supplied
to [CreateRole](https://docs.aws.amazon.com/IAM/latest/APIReference/API_CreateRole.html).
Keeping role creation with a secret-reading boundary would still let the
creator name an unintended principal. No such delegation is proposed here.

This restriction supersedes only the candidate IAM write permissions in draft
contract #251; it does not implement a new provisioning lane. The unchanged
root still declares five secrets, the execution role and its inline policy.
The unchanged seven-create guard/plan proposal #343 therefore cannot be used
as this identity's execution plan. A separately reviewed authorized-operator
step must own exact ECS-only execution-role trust and policy. The proposed
same-root route below preserves state ownership and the seven-create guard;
it does not provide an executor. Do not remove denials, use imports/targeted
applies to improvise that step, run the old plan hoping for partial success, or treat missing IAM
permissions as a reason to widen this role again.

### Proposed operator setup: keep all seven resources in the existing root

Use one separately authorized operator for the **whole** seven-create phase,
not a role-only apply followed by this temporary identity. This is a proposal
for review, not permission to run setup. The accountable operator has now been
selected below; the execution session and its permissions are not approved.
It reuses `infra/pricing_command_secrets.tf` and the guarded plan proposal
[#343](https://github.com/vayada-marketplace/vayada-platform/pull/343).
No second pricing-resource root, duplicate role declaration, state transfer,
import or targeted apply is needed. Any phase-limited operator identity needs
its own separately reviewed prerequisite setup; it is not a pricing-resource root.

The sole owner of the five containers, execution role and inline policy stays
the normal `infra` root at `s3://vayada-terraform-state/platform/terraform.tfstate`.
The separate `vay1543/bootstrap-identity/terraform.tfstate` key owns only this
proposal's temporary identity resources; it must never own pricing resources.
The temporary identity is **not** used for this seven-create apply, even if its
creation window or SSM opt-in is enabled. Do not provision it merely to unlock
this operator route or add back its IAM writes.

The selected operator still needs reviewed session admission, time limits/
revocation, phase-specific permissions and safe positive/negative authorization
evidence. Ordinary CI, migration credentials
and an unnamed administrator are not substitutes. The approved executor must
load the existing production input bindings on its private runner without
exporting them, guessing them from runtime SSM copies or publishing state/plan
data. #343 is plan-only and discards its plan; #344 provides no executor.
Neither a chat approval nor a pre-job environment approval binds a later plan.
CreateRole/PutRolePolicy do not enforce approved document contents, and
CreateSecret can include a value. This operator route therefore requires
explicit acceptance of that residual trusted-operator authority plus immutable
source/exact-plan controls; approval to prepare this document is not acceptance.

Keep #343's full seven-create guard, not a new two-create or five-create guard:
it checks the exact ECS-only trust, fixed account/region, five names/tags,
disabled metadata phase and inline policy derived only from the five generated
secret ARNs. Those ARNs are unknown until creation; do not replace the expression
with invented suffixes or a wildcard. Review the exact current-main source,
source fingerprint and all guards together before admitting the operator.
Any unrelated change, live drift, import, move, update, replacement or deletion
rejects the full plan. Preserve the installed writer boundary and protected
resource guards; no partial plan or refresh bypass is acceptable.

Execution still requires the independently reviewed same-runner, post-plan
receipt approval and durable shared writer hold described in #251. Apply only
the approved unchanged saved plan using the existing state lock. Inspect
post-apply metadata: five containers have no versions, trust is ECS-only, the
inline policy grants only GetSecretValue on their actual exact ARNs, and no
extra inline/managed policies or shared-role access appeared. Do not fetch
values or start tasks to verify this empty-resource phase. Terraform creation
is not atomic: cancellation or partial failure keeps the hold and requires a
new reviewed recovery plan, never a blind rerun, manual import or destroy.

Keep the hold through the separately authorized two-policy metadata phase,
operator-session retirement proof and an ordinary hosted no-op refresh.
Only then may ordinary writers resume. Execution-role image-pull/log grants,
PassRole, database roles/values, service launch, proxy cutover and hotel testing
remain separate reviewed steps. This route does not complete those gates.

### Selected operator — ownership only, not execution admission

Flamur explicitly approved designating the existing `VayadaUser` administrator
as the responsible one-time setup operator in this chat. The selected principal
is `arn:aws:iam::269416271598:user/VayadaUser`, stable IAM user ID
`AIDAT5OTWB3XLUEYGCQ56`, verified with read-only `GetUser`. Recreating a user
with the same name/ARN must not silently inherit this selection. Reverify both
fields before any later admission; mismatch requires a fresh reviewed decision.

This resolves operator ownership only. It does not authorize using the current
administrator credentials for apply, changing permissions, issuing sessions,
loading production settings or modifying GitHub protections. It does not accept
residual arbitrary trust/policy or initial-secret-value authority and does not
choose the separate GitHub receipt approvers. Those remain explicit gates.

The receipt records this owner separately from `context.operatorArn`, which
still requires an assumed-role session. Owner metadata does not prove that a
role/session belongs to the selected operator. No execution-role allowlist,
session admission or attributable-role evidence is configured yet; do not
widen the session check to accept this IAM-user ARN or any role merely because
it is in the account. This component alone is not an admission controller.

The access proposal must use an independently reviewed phase-limited role,
exact trust/admission and request-time expiry/revocation. Keep the owner's
long-term credentials and other administrator credential sources out of the
private runner; prove its actual caller, role policy composition and allowed/
denied operations rather than relying on a requested session duration or policy.
[GetSessionToken](https://docs.aws.amazon.com/STS/latest/APIReference/API_GetSessionToken.html)
retains the user's permissions; it is not a least-privilege substitute.
[AssumeRole](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html)
can restrict a session through role/session policies, but the actual role,
resource policies and admission still need review and proof. Neither API was
called and no role, grant, session or credential was created by this decision.

Before connecting an executor, review the concrete all-writer pause with this
operator: admission and issued-session fencing, accepted-action drain, covered
writer identities, retained authentication-fenced requests, phase-specific
exceptions, failure ownership and explicit release after metadata verification
and hosted no-op. The current workflow observation is not that fence. Operator
session expiry must never automatically release the writer hold. Preserve the
installed VAY-2029 trust and cutoff. No new pause control is activated here.

### Selected-owner IAM prerequisite — concrete, inactive configuration

Flamur approved preparing a one-time permission setup by the selected owner,
without widening the deployment role. `operator.tf` now consumes the selected
no-MFA trust and deny-only session-fence templates in the existing IAM-only root.
Both window variables remain null; normal CI/merge provisions nothing. Do not
enable the old hosted identity as a prerequisite for this new operator role.

An explicit `operator_creation_window` proposes exactly four additions:
`vayada-pricing-operator-create`, its creation/fence inline policy,
`vayada-pricing-operator-create-refresh`, and its attachment. The attachment
depends on the inline fence. The window must be explicit UTC, positive and at
most one hour; hosted creation and the SSM opt-in cannot be enabled alongside it.
The chosen owner's exact ARN/stable ID and source identity remain required.
MFA is deliberately absent only in this selected pilot candidate.

The policy reuses the fixed five-secret names/tags, exact production state
object, lock leading keys and enumerated provider metadata from the existing
proposal. It adds only CreateRole/PutRolePolicy on the exact pricing execution
role. Explicit denies cover those writes on every other role, all role trust/
attachment/boundary edits, secret value reads/subsequent writes, KMS decrypt,
PassRole and role chaining. No metadata-policy or service writes are granted.
Request-time fences reject wrong/missing source identity, old/missing token
issuance context and requests before the start or at/after expiry.

This is the prerequisite identity's four-create configuration, **not** a saved
live plan or permission to install it, issue credentials or apply the seven
pricing-resource creates. A fresh exact IAM setup plan and composed live
authorization evidence still need independent review/approval. The owner's
administrator credentials must never enter the private pricing runner.
CreateRole/PutRolePolicy still accept caller-supplied documents; CreateSecret
can carry an initial value. The separate initial-value decision is now accepted
below; this does not authorize supplying values. SSM plaintext refresh remains blocked
and this candidate cannot perform full production refresh; do not bypass it.
Receipt/executor, durable writer hold, separate metadata phase, retirement and
deployment remain unimplemented gates. No role, policy, session, secret or
service was created or changed. Native-console diagnostics may have used
temporary IAM-only backend lock bookkeeping; the lock is released and state
remains absent. This is not installation or execution evidence.

### Empty-container enforcement — separate decision accepted

Flamur explicitly accepted relying on the reviewed pricing plan to enforce
"empty containers only" after the initial-value limitation was disclosed.
CreateSecret can carry a value, so IAM alone does not enforce this rule.
Use immutable reviewed declarations/private runner, exact saved-plan approval
and post-write no-version verification; do not claim IAM proves emptiness.
This clears the initial-value content-authority decision, not permission to
supply any value, grant access, issue a session or execute setup. SSM plaintext
and metadata-policy-content acceptance remain separate, unaccepted decisions.
The unlocked IAM-only review plan is not an approved execution plan; no
admission window may be shifted or installed based on this acceptance alone.

### Limited-access proposal — role-policy trust decision accepted for preparation

Flamur explicitly accepted reliance on the trusted operator and reviewed plan
for the exact role-permission contents in this chat, then directed preparation
to proceed. This clears that design decision only: it does not approve a grant,
credential/session issuance, role/fence installation, production plan/apply or
deployment. Do not infer separate acceptance of SSM plaintext access or
metadata-policy content authority from that role-policy decision. Initial-value
authority was separately accepted above, not inferred from it.

This is the proposed permission boundary for the selected owner's future
phase-limited sessions, **not** a policy grant or an implemented identity.
The existing restricted hosted role keeps `NeverMutateRoles`; do not relax it
or reuse it for the operator phase. Do not copy `AdministratorAccess` or the
ordinary deploy role's policies into a new session. Before implementing the
privileged execution lane, retain the explicit role-policy decision above and
resolve remaining content-authority gates below; naming the owner alone did not
make that decision.

| Phase | Proposed write scope | Required plan/verification boundary |
| --- | --- | --- |
| Empty-resource creation | `iam:CreateRole` and `iam:PutRolePolicy` only on `arn:aws:iam::269416271598:role/vayada-pricing-command-execution`; `secretsmanager:CreateSecret`/`TagResource` only on the five fixed names and required tags already declared above | Exactly seven creates from #343, ECS-only trust, one expected inline policy derived from actual five secret ARNs, no initial secret versions |
| Metadata refresh | Separate session for only the two existing policy targets in `docs/pricing-command-metadata-refresh.md`, never the operator's own role or the creation-role grants | Exactly two policy updates, final exact resource ARNs, unchanged VAY-2029 trust/cutoff and no extra permissions |
| State bookkeeping | Existing exact production state-object write and existing lock-table item operations/leading keys, not another backend or general S3/DynamoDB writes | Same saved plan, state lineage/serial, backend lock and immutable source; no imports, targeted apply or refresh bypass |

Both sessions also need the reviewed provider-read inventory, exact admitted
role/RoleId and owner attribution, independent source/plan guards, and proven
request-time expiry/revocation. Sensitive SSM/KMS refresh remains a separate
unaccepted permission gate; no broad read wildcard or decryption exception is
implied by this table. Neither session may pass/assume roles, launch/change
services, populate/read pricing secret values, change its own permissions or
perform the other phase's writes. Provider action inventory and actual composed
permissions must be reviewed before any admission; the table is not executable
policy or sufficient authorization evidence.

The unavoidable risk is concrete: `CreateRole` accepts a caller-supplied trust
document and `PutRolePolicy` accepts caller-supplied permissions. Scoping the
resource ARN does not make IAM check ECS-only trust, the inline policy's name
or its exact contents. An admitted operator could instead create persistent
unintended authority on that role. Likewise, `CreateSecret` can include an
initial value, and metadata-policy writes could insert unintended grants.
The trusted operator, reviewed immutable declarations/provider/runner, exact
saved-plan approval and post-write verification enforce these content limits;
expiry does not undo an unintended persistent grant. No test or owner selection
is acceptance of that trust assumption. Rejecting a remaining gate keeps
execution blocked and requires a different reviewed design; do not silently restore IAM writes
or replace it with direct administrator execution.

For the deployment pause, propose an AWS-enforced mutation fence on the full
reviewed platform-writer inventory, not only workflow disabling or service
holds. It must cover old/new sessions and later queued credential requests,
while preserving only enumerated metadata/lock access needed for verification.
Keep operator-phase exceptions separate and explicitly approved. Audit other
repositories and out-of-band control-plane writers; coordinate administrator
non-interference and recovery ownership rather than claiming the fence blocks
the selected administrator from changing it. Uncovered writers block setup.
Prove propagation and drain previously accepted AWS changes before planning.
Any IAM/GitHub access or fence installation needs its own separately approved
prerequisite configuration/plan; it cannot be bundled into either the seven-
create or two-update plan. Failure/timeout keeps the hold, with no automatic
release or cancellation/retry of retained authentication-fenced requests.
The concrete fence policy, identity inventory, installation/rollback plan and
live evidence are still absent. This proposal neither implements nor activates
the pause and preserves the installed VAY-2029 trust/cutoff unchanged.

### Concrete operator admission/fence templates — unattached, no grants

`deployment/pricing-operator-trust.json.tftpl` proposes direct admission only
from the selected user ARN and stable user ID, with MFA and an exact required
`sts:SourceIdentity`. Both admission and issued-session restrictions use the
same separately approved UTC start/end, spanning at most one hour. Revalidate
the user's stable ID and the interval before rendering; do not substitute a
different owner, remove MFA or extend/reopen a window as recovery.

Flamur subsequently explicitly directed skipping MFA and continuing preparation.
The separate `deployment/pricing-operator-trust-no-mfa.json.tftpl` is the selected
**pilot proposal** for that decision; the MFA template above remains unchanged.
The alternative removes only the MFA admission condition and preserves the
selected ARN/stable ID, source identity and reviewed window. Stolen owner
credentials could therefore assume the future pilot role during its window
without a second factor; source identity and expiry do not replace MFA.
This is not permission to disable installed MFA controls, change credentials,
relax another role/SCP/boundary, issue a session or run setup. If composed live
controls require MFA, the proposal does not override them. Exact phase-limited
grants, attached session fence and separate plan/receipt/writer-hold approvals
remain prerequisites. Never combine both trust variants or use administrator
credentials in the private runner to sidestep those gates.

`deployment/pricing-operator-session-fence.json.tftpl` is **deny only**. It
rejects requests before the start or at/after expiry, sessions issued before the
start or missing token issuance context, wrong/missing source identity, PassRole and role
chaining. Attach the reviewed fence to the future operator role before any
grant can make it usable; an optional caller-supplied session policy is not
sufficient. Never attach it to the selected user or the pricing execution role.
It is not the whole-platform writer hold and grants no creation/metadata access.

The inactive `operator.tf` candidate now consumes only the selected no-MFA trust
and deny-only fence; the original MFA template remains unused. No credential
command or workflow assumes or provisions the operator. Offline native plans
check the rendered declarations only, not an admission controller. Exact
role/RoleId admission, selected-variant admission, source-identity/CloudTrail attribution,
full composed grants and live positive/negative expiry/revocation evidence
remain unproven. The private runner must receive only its admitted role session,
never administrator credential sources or MFA codes. Preserve all existing
receipt/source/plan/hold guards and phase separation before admission.
Read-only `GetUser` reconfirmed the selected ARN/stable ID; `ListMFADevices`
reported zero devices. That remains a blocker for the original MFA variant,
not an enrollment prerequisite for the explicitly selected no-MFA pilot proposal.
No enrollment, device secret or code was requested or created. Do not treat
preparation or the pilot exception as authorization to change user credentials.
See [AWS source identity](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp_control-access_monitor.html)
and [MFA with AssumeRole](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html).

### Same-runner approval component — not an executor

`scripts/pricing_bootstrap_approval.py` implements only the in-process approval
boundary. The selected AWS owner is receipt metadata only. No human GitHub IDs
are authorized by default; selecting them requires
explicit approval and a reviewed code change, never a dispatch/environment input.
It generates an allowlisted receipt with source/run/attempt, operator session,
state lineage/serial, saved-plan digest, writer-hold and authorization-evidence
digests, a random nonce and a 15-minute expiry. An unedited later GitHub comment
from an approved User must match the receipt digest and nonce byte-for-byte.
Wrong discussion, bot/app, stale, edited, expired and replayed approvals fail.
Receipt copies cannot change its in-memory context, and approval is consumed
before an apply attempt; it cannot be reused after failure or restored on a
different process/run. Copy/serialization and fork reuse are rejected, and
consumption is atomic across threads. It writes nothing and has no executable
setup entry point.

`ApprovalGate.fetch_and_consume` now obtains the selected comment directly via
native `gh api` on fixed `github.com` endpoints. It binds matching REST/GraphQL
IDs, author, body and timestamps, including GraphQL `lastEditedAt`, `editor`
and `isMinimized` evidence. Missing fields, partial API errors or disagreeing
snapshots reject approval; equal REST created/updated timestamps alone are
insufficient. API failures expose only sanitized messages, not response bodies.
An empty approved-human allowlist fails before fetching. See the official
[IssueComment schema](https://docs.github.com/en/graphql/reference/issues#issuecomment).
The future executor must run all source/plan/identity/state/hold/authorization
guards before building the receipt and again before consumption. The component compares their context;
it does **not** authenticate caller-supplied JSON or prove an operator/hold from
a digest. Service holds do not freeze Terraform writers. Private input loading,
live evidence collection, durable whole-writer hold, polling/publication, apply,
post-apply verification, recovery and metadata-phase integration remain absent.
No setup workflow calls this component or gains permissions, and its tests use only
synthetic data. Passing them is not authorization to execute setup.

### Workflow pause observation — not an authorization fence

`observe_workflow_pause` is a read-only diagnostic, not an executor prerequisite
that establishes the receipt's `writerHoldSha256`. It requires a complete
single-page inventory (at most 100 workflows), manually disabled workflows
except the reviewed `tf-plan.yml` and `tf-validate.yml`, and no nonterminal runs
outside those two. It checks every queued/in-progress/waiting/pending/requested
status without branch or date filters. Missing, duplicate, malformed or truncated
workflow/run identities fail closed. No setup-runner exception is inferred; the diagnostic does not
disable, enable, cancel or retry anything.

[GitHub workflow disabling](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)
stops new triggers. A snapshot of disabled workflows does not revoke issued AWS
sessions, drain accepted AWS actions, prevent administrator re-enablement/reruns,
or cover other repositories and out-of-band operators. This observation must
not be treated as proof of a durable all-writer hold or atomic drain snapshot:
a writer may change status between sequential API queries and go unobserved.
The reviewed hold still
needs phase-specific coverage, ownership, fresh checks and safe recovery through
creation, metadata verification and the ordinary hosted no-op. Retained older
authentication-fenced writer runs will block this diagnostic too; do not cancel
or retry them merely to make it pass. Their disposition requires the existing
writer-boundary coordination and reviewed fence evidence. No live pause was made.

Admission is a fixed OIDC audience/environment within a reviewed UTC window
of at most one hour. Request-time denial stops already-issued sessions at the
end; older sessions are rejected when a new window starts. Before provisioning,
prove the new `pricing-bootstrap-create-v1` environment admits reviewed `main`
only and requires the agreed approved human reviewers. The IAM environment
subject alone does not restrict branch or human identity. Do not configure
or activate it under this PR's approval. Operators also control the new role;
it cannot edit its own or another role's trust or permissions. Only the declared
refresh policies may be attached. The inline all-action time fences also deny
managed refresh permissions outside the window; IAM propagation still needs
actual proof.

Provider action inventory was checked against the pinned [AWS 5.100.0 secret](https://github.com/hashicorp/terraform-provider-aws/blob/v5.100.0/internal/service/secretsmanager/secret.go)
creation/read path; execution-role writes are intentionally unavailable.
CreateSecret name conditions are separate from TagResource,
which does not support that key ([AWS action reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_secretsmanager.html)).
Offline native plans validate declaration/policy structure, not live IAM admission.

Independent review found a compatibility blocker: the pinned [SSM resource
reader](https://github.com/hashicorp/terraform-provider-aws/blob/v5.100.0/internal/service/ssm/parameter.go)
requests `GetParameter` with decryption. The explicit `kms:Decrypt` denial
therefore blocks refresh of existing SecureString settings, including those
using the AWS-managed SSM key. The proposed opt-in replaces that blanket denial
only with all of these restrictions:

- Exact 36 parameter ARNs from `infra/ssm.tf`, including conditional declarations;
  no prefix, history or by-path reads. The reused broad parameter statement is
  removed even when the opt-in is off. Tests fail on inventory drift.
- Exact AWS-managed key `arn:aws:kms:eu-west-1:269416271598:key/3f96b311-bfda-431d-8f05-bfced29c2114`.
- Requests must come via `ssm.eu-west-1.amazonaws.com` and contain an exact
  allowlisted `kms:EncryptionContext:PARAMETER_ARN`.
- Independent explicit denies reject other keys, other/missing service and
  other/missing parameter context. The allow and context deny work together;
  do not remove the deny just because the allow names an exact key. AWS-managed
  SSM key permissions do not provide the same parameter-level restriction.

Metadata-only DescribeKey/DescribeParameters checks on 2026-10-01 identified
the key and Standard SecureStrings using `alias/aws/ssm`; no values were read.
The initial complete-inventory attempt was throttled. A fresh 2026-10-02
metadata-only inventory found all 36 exact declared names, each Standard
SecureString using `alias/aws/ssm`; DescribeKey reconfirmed the exact key above.
No values were retrieved or decryption grants installed. This point-in-time
metadata mapping is not actual-role authorization or full-refresh evidence.
Read-only IAM `SimulateCustomPolicy` checked the three generated proposal policy
documents: exact SSM decrypt/read allowed; missing/wrong service, region or
context, other key and time-fence cases explicitly denied; unlisted parameter,
history and by-path reads implicitly denied; Secrets Manager value read explicitly
denied (15 cases). This does not prove actual-role admission, resource/key-policy
composition, SCP/boundary enforcement, propagation or production refresh.
Before activation, reverify the exact inventory's existence, type, tier and key
mapping and demonstrate the composed policy's positive/negative authorization.
Key rotation/mapping or root-declaration changes require a reviewed update,
not a wildcard expansion. The exception is not limited to Terraform by IAM:
an admitted job can retrieve plaintext values for these exact parameters,
including the RDS administrator connection URL and payment/provider API keys.
Treat the runner, inputs, state and transient plan as privileged; do not print,
upload or retain setting values. No Secrets Manager value access is introduced.
The permission proposal does not itself prove a production full refresh works.
Its acceptance and the remaining execution gates are required before admission.
See [SSM encryption context](https://docs.aws.amazon.com/systems-manager/latest/userguide/secure-string-parameter-kms-encryption.html#systems-manager-parameter-store-encryption-context)
and [KMS ViaService](https://docs.aws.amazon.com/kms/latest/developerguide/conditions-kms.html#conditions-kms-via-service).

Do not bypass refresh, use `-target`, broaden reads to pricing secret values,
or count the dummy local plans as evidence that production refresh succeeds.

Still required before either production apply: independently reviewed
same-runner receipt/approval integration, immutable source/plan and full root guards,
durable shared writer hold, phase-specific authorization/negative evidence,
separate metadata phase, expiry/revocation proof and partial-failure recovery.
Creation expiry is not retirement verification. Keep the writer hold through
the metadata phase and ordinary hosted no-op refresh. Do not reset the window
or destroy resources as recovery. This slice launches no service, creates no
database login or value, and does not authorize hotel smoke.
