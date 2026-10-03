# VAY-1543 temporary creation identity — review only

**Blocked for execution:** Flamur approved the fixed-36 plaintext SSM refresh
design for the distinct selected-owner operator only; no permissions are installed
or approved for activation. The old hosted temporary identity still has
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
six additions for the old hosted SSM opt-in; eight for the operator opt-in,
whose SSM read and decrypt policies each need a separate attachment);
never add it to the seven-create pricing plan, import existing identities,
apply from normal CI, or populate it with production Terraform inputs.
Only reviewed exact KMS metadata ARNs may be supplied; default empty inventory
is not evidence that production-root refresh works. Both SSM opt-ins remain
off by default (`enable_ssm_refresh_decryption=false` for the old hosted role,
`enable_operator_ssm_refresh_decryption=false` for the selected operator).
The approved operator exception does not approve or enable the hosted exception.

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
choose the separate GitHub receipt approver; that identity was subsequently
selected explicitly below. Session admission and exact receipt approval remain gates.

The receipt records this owner separately from `context.operatorArn`, which
still requires an assumed-role session. Owner metadata does not prove that a
role/session belongs to the selected operator. Creation context now accepts
only the exact account's assumed-role ARN for the proposed
`vayada-pricing-operator-create` role. Other roles (including ordinary deployment,
the pricing service execution role and the old hosted creation candidate), IAM
users/root, account mismatches and role-name lookalikes reject. This fixed name
binding is metadata validation, not authenticated session admission or stable
role-ID evidence: a caller can still supply a string or recreate a same-named
role. Those checks remain required. This component alone is not an admission
controller and cannot admit the separate metadata-policy phase.

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
most one hour; hosted creation and its `enable_ssm_refresh_decryption` opt-in
cannot be enabled alongside it. The separately approved operator opt-in
`enable_operator_ssm_refresh_decryption=true` adds an exact-36 SSM managed
policy, a decrypt-fence managed policy and their attachments (eight creates
total). Keeping them separate satisfies IAM policy-size quotas; combining them
would exceed 6,144 characters. It reuses the existing inventory and exact
key/service/context decrypt fences. All attachments depend on the inline
request-time fence; SSM reads additionally depend on the decrypt-fence attachment.
An opt-in without a window creates nothing.
The chosen owner's exact ARN/stable ID and source identity remain required.
MFA is deliberately absent only in this selected pilot candidate.

The policy reuses the fixed five-secret names/tags, exact production state
object, lock leading keys and enumerated provider metadata from the existing
proposal. It adds only CreateRole/PutRolePolicy on the exact pricing execution
role. Explicit denies cover those writes on every other role, all role trust/
attachment/boundary edits, secret value reads/subsequent writes, KMS decrypt
outside the separately opted-in fixed SSM scope,
PassRole and role chaining. No metadata-policy or service writes are granted.
Request-time fences reject wrong/missing source identity, old/missing token
issuance context and requests before the start or at/after expiry.

This is the prerequisite identity's four-create default or eight-create SSM opt-in
configuration, **not** a saved
live plan or permission to install it, issue credentials or apply the seven
pricing-resource creates. A fresh exact IAM setup plan and composed live
authorization evidence still need independent review/approval. The owner's
administrator credentials must never enter the private pricing runner.
CreateRole/PutRolePolicy still accept caller-supplied documents; CreateSecret
can carry an initial value. The separate initial-value decision is now accepted
below; this does not authorize supplying values. The SSM access-design decision
is separately accepted below; no actual-role full production refresh has been
performed or proven. Do not bypass refresh or infer activation from that decision.
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
access and metadata-policy-content enforcement are separately accepted below.
Those decisions do not authorize activation or policy writes.
The unlocked IAM-only review plan is not an approved execution plan; no
admission window may be shifted or installed based on this acceptance alone.

### Metadata-policy contents — separate decision accepted for preparation

Flamur explicitly accepted reviewed-plan/trusted-operator enforcement of the
contents of the two existing metadata-policy targets after disclosure that a
faulty operator could add unintended access. This decision is for preparation
only: no grant, session, policy update, setup, deployment or hotel test is
authorized. That content decision did not select a metadata-phase receipt
approver or execution window, approve any saved plan, or prove the runner,
authorization or writer hold. The later human selection below is separate.
The two-policy phase still requires its own separately admitted session and
exact approval; the existing creation receipt cannot authorize it.

The offline `assert-pricing-bootstrap-plan.py --metadata` check allows exactly
two known policy-document updates. It preserves all existing statements and
the installed reviewed cutoff, and adds only the fingerprinted narrow metadata
statements on the five known final secret ARNs and execution-role ARN. Existing
pricing resources must be unchanged; unrelated writes, unknowns, imports/moves,
drift and output changes reject. The seven-create check and its approval path
remain unchanged. This is a content check on supplied plan JSON, **not an
executor or authenticated live evidence**. No workflow calls the metadata mode.
Trusted native decoding of the sealed saved plan, source/runtime/backend/state
admission, actual ARN/role and authorization evidence, all root/protected guards,
whole-writer hold, metadata-specific approval and post-write verification still
must be connected before execution. Tests include a native Terraform two-update
plan using copied declarations and synthetic local state, without refresh or
apply; no production metadata plan or actual-role authorization is proven.

### Limited-access proposal — role-policy trust decision accepted for preparation

Flamur explicitly accepted reliance on the trusted operator and reviewed plan
for the exact role-permission contents in this chat, then directed preparation
to proceed. This clears that design decision only: it does not approve a grant,
credential/session issuance, role/fence installation, production plan/apply or
deployment. Do not infer separate acceptance of SSM plaintext access or
metadata-policy content authority from that role-policy decision. Initial-value
authority was separately accepted above and SSM access below, not inferred from it.

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
request-time expiry/revocation. Sensitive SSM/KMS refresh is separately approved
for the selected operator's exact fixed-36 configuration, not installed or
proven; no broad read wildcard or other decryption exception is implied by this
table. Neither session may pass/assume roles, launch/change
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
The uninstalled policy candidate below does not supply the reviewed identity
inventory, installation/rollback plan or live enforcement evidence. This proposal
does not activate the pause and preserves the installed VAY-2029 trust/cutoff unchanged.

### Whole-writer hold policy candidate — uninstalled, not executor admission

`deployment/pricing-writer-hold.json` is a standalone **deny-only** identity-policy
document: all actions, all resources, no conditions, exceptions or expiry. No
Terraform root, workflow or executor loads it. Its offline shape test is not
AWS enforcement proof. The proposed installation is a separate managed policy
and reviewed attachments, not another inline policy or an update to the existing
VAY-2029 boundary. Do not install it under approval for either pricing phase.

A read-only account authorization inventory on 2026-10-03 found 54 roles and
three users. The platform deploy role has 11 managed attachments and 10,175
compact JSON characters across its inline policies; even this 84-character
document would exceed the 10,240-character aggregate inline quota. Recovery
scenario/state-denial roles also have nearly full inline policy inventories.
The account's read-only IAM Service Quotas response reports 20 managed policies
per role (`L-0DA4ABF3`). Reverify actual attachment
capacity for every proposed target before any installation. These observations
do not select target roles or prove effective
permissions, complete writer coverage, admission, propagation or drain.

The inventory includes allow statements for security-group changes on the older
app deployment role, ECS/SSM changes on the coordinated role, and task/service
changes on recovery roles. Review their resources, denies, trust, chaining and
active executions; inspecting only the ordinary platform workflow is insufficient.
Do not attach this policy indiscriminately to all 54 roles: running application
and AWS service-linked roles are not a safe default target inventory. Complete
the cross-repository/out-of-band writer and administrator non-interference review,
including non-AWS provider credentials, before claiming a whole-writer hold.

If separately installed on reviewed writer identities, the unconditional deny
has no older/newer-session escape or timeout release. It also denies their
metadata, state and lock operations; obtain observations through separately
reviewed read-only identities, not a new exception in this document. Already
accepted operations and chained sessions under other identities still require
inventory/drain; STS caller-identity output is not a denial probe. Separate
phase-limited operator identities and the installer/recovery owner must remain
outside the reviewed competing-writer target set, with their independent controls.

### Concrete prerequisite scope — proposal, not installation approval

The expanded 2026-10-03 read-only IAM audit identifies these four overlapping
deployment identities for the prerequisite review. They are **candidates**, not
a complete or approved fence target list:

| Existing role | Observed stable RoleId | Relevant overlap |
| --- | --- | --- |
| `vayada-github-actions-platform-deploy` | `AROAT5OTWB3XLPYHBY43Y` | Platform infrastructure, production state/parameters, exact RDS modification and coordinated-receiver IAM management |
| `vayada-github-actions-coordinated-deploy` | `AROAT5OTWB3XD5SXH5GJW` | Six normal-next services and deployment-control records |
| `vayada-github-actions-deploy` | `AROAT5OTWB3XPZT47OHGB` | Exact database security group and account repository image uploads |
| `vayada-github-actions-finance-export` | `AROAT5OTWB3XMKMLBCNMM` | Region-restricted `ecs:DeregisterTaskDefinition` on `*`, despite isolated RunTask/StopTask scopes |

Re-observe each identity, trust and full permission composition before producing
the installation plan. Classify additional writers by overlapping resources and
execution capabilities, not role-name matching. Do not fence runtime logging,
service-linked or unrelated rehearsal roles merely because they have writes.
The selected owner inherits AdministratorAccess; an explicit non-interference
window and installer/recovery responsibility are required, not an assumption
that deployment-role attachments restrict that owner. Non-AWS writers,
resource policies/SCPs and accepted/chained executions remain review gates.

For hosted verification, Flamur explicitly approved a separate GitHub environment named
`vay1543-pricing-verification`: only the `main` branch, required reviewer numeric
ID `120040061`, no administrator bypass, and only the private read-only check.
On 2026-10-03 it was created and read back as environment ID `23367769738`,
one required User reviewer `FlamurMaliqi` / `120040061`,
`can_admins_bypass=false` and one branch policy `main` / type `branch`
(policy ID `61838144`). Self-review prevention is false for this single-human
setup: the human may request and explicitly approve a check; the agent must
never approve it using that human's credentials. No wait-timer rule is present.
Environment protection is not a workflow restriction or AWS read-only grant;
repository administrators can still edit its configuration. Before any check,
reverify the exact environment, source/workflow/run and independent AWS admission.
The existing `platform-mutations-v2` environment currently admits only
`main` but has no required-reviewer rule; it is not human-approval evidence.
This approval installs only the new environment settings, not AWS trust,
permissions, credentials, a workflow, a dispatch or either pricing setup phase.

Reuse the existing Plan role `AROAT5OTWB3XFQWPINYTU`; propose adding only the
exact OIDC subject
`repo:vayada-marketplace/vayada-platform:environment:vay1543-pricing-verification`
with audience `sts.amazonaws.com`, preserving its existing PR subject and
permission policy. The reader's trust remains owned by the normal Terraform
root: do not import or manage that role in the operator-identity root. Verify
actual environment restrictions and composed reader permissions independently;
the OIDC environment subject itself does not prove branch, reviewer or source.
Do not broaden trust to a repository wildcard or add setup/deployment grants.

`enable_pricing_verification_reader` now prepares this exact additional trust
statement in the normal root, defaulting to false. No checked-in activation
setting enables it. The existing PR trust, reader permission policy and writer
boundary/cutoff remain unchanged by default. Enabling it requires enforced writer
trust with a reviewed session cutoff and a separately reviewed exact trust-update plan, fresh
environment/RoleId/permission admission and explicit installation approval.
This option does not create a workflow, privately generate a plan or install a
writer fence; environment approval does not authorize those AWS operations.

The reviewed prerequisite must specify policy/attachment ownership and an exact
saved plan, actual capacity, complete admitted target set, human-selected window,
private runner/backend/input binding, failure recovery and separate release
approval. Keep the existing VAY-2029 boundary and cutoff unchanged. None of
the remaining proposed AWS identities, reader trust or writer-fence scope choices
authorizes further installation, setup, a hosted dispatch or the hotel test.

### Pause, verify and resume — proposed order, not an executable lane

The required ordinary hosted no-op is a **plan refresh**, not Terraform Apply.
The existing `.github/workflows/tf-plan.yml` uses
`arn:aws:iam::269416271598:role/vayada-github-actions-platform-plan`, not the
deployment role. Keep this independently reviewed reader outside the competing-
writer deny target set, with its existing enumerated metadata/state reads and
exact DynamoDB lock-item access. Do not add state-object writes, decryption,
role assumption, deployment permissions or exceptions to the deny document.
Actual RoleId, trust and composed permissions must be reverified; the role's name
or source declaration alone is not admission evidence.

This reuses the metadata runbook's ordinary hosted **plan** requirement without
temporarily reopening a deployment identity. Terraform Apply is not a substitute:
its workflow also runs database preflights, SES writes and possible ECS deployment
outside Terraform's resource-change summary. Leave it and all other competing
writers fenced throughout verification.

| Step | Required evidence before advancing |
| --- | --- |
| Prepare | Separately approved prerequisite plan: complete writer/reader identity inventory, actual quotas, installer/recovery owner, fence state ownership and exact installation/release scope. Admit immutable runner/source/provider/backend and private inputs independently. No pricing receipt authorizes this step. |
| Pause and drain | Disable relevant triggers as coordination, install the approved deny attachments, prove actual propagation/session coverage and drain already accepted AWS changes and chained executions. Preserve retained authentication-fenced requests and existing service holds. Any uncovered writer or partial installation blocks setup. |
| Create, then metadata | Keep the same whole-writer fence. Use the distinct admitted phase roles, exact seven-create then two-update saved plans, separate human receipts and fresh source/state/authorization/hold checks. Recheck metadata version capacity before receipt and consumption; verify actual empty containers, trust/policy contents and exact final mappings. |
| Retire and refresh | Prove both privileged phase sessions retired. Use the admitted existing plan reader for a fresh full-root locked plan against the final checked-in configuration and actual production backend. Require no managed-resource/output changes, drift, imports or moves, with the existing writer/protected guards. No apply, targeted plan, `-refresh=false`, cached JSON or state publication. |
| Explicit release | Only after the preceding evidence is accepted, approve a fresh exact fence-removal plan and release the covered workflows explicitly. Recheck actual identities/policies/state/holds immediately before removal; preserve VAY-2029 trust/cutoff and service holds. Do not replay an old attachment snapshot, automatically release on timeout, retry old runs or clear a service hold as a side effect. |

The current PR Plan workflow succeeds even when a plan contains changes and
publishes plan text. Its green status is **not** the required private no-op
verification. A reviewed hosted check still needs exact source/backend/input
binding, private saved-plan inspection and sanitized no-op evidence; this change
does not dispatch or add that lane. The workflow/allowlist regression tests check
declarations only, not actual-role permissions, runtime custody or live freshness.

`guard_saved_plan(..., phase="no-op")` now provides the offline inspection
component for that future lane. It uses the same sealed descriptor, pinned native
`version`/`show`, credential-free environment and writer/Finance guards. It rejects
duplicate JSON fields, any resource or output change, unknown values, drift,
imports, moves, failed/unknown checks, missing pricing identities and
missing/altered metadata additions.
The final pricing metadata stage and existing reviewed cutoff must be present.
It does not consume an approval receipt, generate a plan, call AWS, apply, retire
sessions or release a hold. `ApprovalGate` still permits only creation and
metadata receipts; `no-op` is inspection, not a third mutation phase.

This is saved-plan content evidence only. A targeted, unrefreshed, stale or
incomplete plan can still contain these resources; the future admitted hosted
lane must independently prove full-root fresh locked planning, exact source,
backend/input/state binding, immutable runtime and continued writer/session holds.
Synthetic native fixtures use `-refresh=false` and no backend only for offline
compatibility tests; they are not acceptable production verification evidence.
Successful inspection never authorizes activation or fence removal.

The same module now has a narrowly read-only command:

```text
python3 scripts/pricing_bootstrap_approval.py --inspect-no-op <reviewed-main-sha> <saved-plan-sha256> <private-plan-file>
```

It checks argument shape and Linux sealing API presence before source/API access,
verifies the actual checkout against authenticated current main, seals and hashes
the private file, runs only the no-op inspection on that descriptor, then checks
the checkout/current-main binding again before emitting one fixed content-only
success message. Keep the plan outside the checkout in private transient storage;
no plan bytes, path or user-supplied argument is printed. Unsupported commands,
source/custody/guard failure or interruption fail without a success message; the
descriptor closes on failure and no approval or release path is connected.
Actual syscall/seal availability is checked during custody, not by API presence;
deeply nested native JSON is also rejected with fixed sanitized output.

This command does not plan, initialize, call AWS, acquire deployment access or
establish that the file came from this source/backend. GitHub ref reads are its
only external observations. All independently admitted runtime, full-root fresh
locked planning/input/state and whole-writer/session gates above still apply.
It cannot run successfully from this unmerged draft as an admitted main checkout.
It is a private verification entry point, not the missing hosted planning lane,
pricing setup executor or authorization to run production verification.

Partial installation, failure, cancellation, drift or unverifiable retirement
keeps installed denials and blocks release pending the explicitly reviewed recovery
procedure. No hold installation, verification, release executor or setup runner
is connected here. These gates still precede any executor connection; the
ordered proposal is not activation approval or completed rollout evidence.

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

### Metadata-phase human selected — component only, no execution admission

Flamur subsequently selected the same GitHub User `FlamurMaliqi`, stable numeric
ID `120040061`, for the separate two-policy metadata approval. Read-only GitHub
account metadata reconfirmed the ID and User type. This records who may approve
a future exact metadata receipt; it approves no receipt, plan, execution window,
AWS role/session, permission grant, policy update, setup or deployment.

`ApprovalGate` keeps creation as its default; an explicit literal
`phase="metadata"` selects the separate metadata receipt and its independently
selected `METADATA_APPROVED_HUMAN_IDS`. `APPROVED_HUMAN_IDS` remains creation-only.
The two reviewed phases are the only accepted values; never take the phase from
dispatch inputs, comments or the environment. This component validates only
the proposed metadata role name, not an actual caller or RoleId. No actual
metadata role/session or execution window is selected/admitted, and there is
no metadata executor. Live admission and the reviewed execution contract must
still connect source/runtime/backend/state, authorization and whole-writer hold
checks before constructing or consuming a receipt.

The metadata receipt says zero additions, two updates and zero deletions,
identifies the fixed inline-policy and managed-policy targets, and requires
unchanged existing statements, writer trust/cutoff and secret values. Its
`approve-vay1543-metadata` text and digest/nonce cannot substitute for a creation
receipt, even though the human is the same. Context validation rejects creation
and unrelated operator roles. Both phases retain fresh REST/GraphQL edit proof,
expiry, single-process/single-use, copy/fork rejection and atomic consumption.
The saved-plan path always selects the receipt's phase, never a per-call switch.
Metadata uses the same native sealed-FD inspection, writer-boundary and Finance
guards, but the exact two-update check instead of the seven-create check.
Guard failure stops before approval fetching/consumption. No CLI, workflow or
apply lane is added; live policy-version preflight integration remains absent.

### Separate metadata operator — inactive permission proposal

`infra/pricing-bootstrap-identity/operator_metadata.tf` proposes
`vayada-pricing-operator-metadata` in the existing IAM-only root. It is not a
human-selected/admitted role or execution authorization. Its window defaults
to null and its independent SSM option defaults to false; ordinary CI creates
nothing. The metadata receipt component binds this candidate name only;
no workflow or executor installs, assumes or admits the proposed role.

A reviewed window of at most one hour, after both retained creation windows
expire, and five exact final secret ARNs are required even to propose its four
IAM resources. The optional fixed-36 SSM refresh/decrypt policies and fenced
attachments make eight; this option does not affect either creation identity.
The candidate reuses the selected-owner no-MFA pilot trust, stable user/source
identity and request-time session fences. Live composition, role ID, window and
this phase's admission still require separate review/approval; no installed
MFA or VAY-2029 trust/cutoff is changed.

Writes are limited to `PutRolePolicy` on the existing platform plan role and
`CreatePolicyVersion` on the existing writer-boundary policy, plus the exact
production state/lock bookkeeping. The reviewed plan must still fix the inline
policy name and both documents: IAM resource scope does not enforce contents.
Other role-policy targets and managed-policy version targets, self-editing,
creation/service writes, secret values, PassRole and chaining remain denied.
Refresh reuses the existing inventory with only the five exact final pricing
secret ARNs, not creation-time suffix wildcards. Fences precede attachments.

Policy-version deletion and switching to an old default are denied. The pinned
[AWS provider 5.100.0](https://github.com/hashicorp/terraform-provider-aws/blob/v5.100.0/internal/service/iam/policy.go)
creates a new default version but first prunes an old version at the five-version
limit. Admission must confirm fewer than five versions while holding writers;
stop otherwise and separately review any version retirement. Do not widen this
role or bypass the check. No production plan, apply or live permission proof
is supplied by the native offline tests.

`observe_metadata_policy_capacity` now prepares that read-only observation;
no executor calls it and it was not run against AWS. A future independently
admitted private runner must supply the reviewed stable metadata RoleId and
its exact session context, never select the ID from dispatch/environment or
from the observation itself. The helper accepts only explicit temporary
session credentials, disables profile/config/metadata fallback and drops
endpoint, proxy, CA and other environment overrides. Fixed native AWS CLI
calls first compare authenticated STS account, ARN and RoleId/session, then
list versions of only the existing writer-boundary ARN. A single-page response
must explicitly be complete, have one to four distinct valid version IDs and
exactly one boolean default. Five versions, pagination markers, malformed
responses, command failures and timeouts reject with a fixed error; no raw
responses or credentials are returned. It never deletes or switches versions.

The allowlisted result is point-in-time identity/capacity observation, **not**
session/window authorization, IAM composition, runtime/source/state admission
or the whole-writer hold. The future executor must rerun it under that hold
before both receipt construction and consumption, not accept saved JSON or
reuse an earlier success. Policy-version identity/content and unchanged state
still require their separate guards. The actual RoleId/session/window remain
unselected; synthetic tests do not establish live enforcement. See the official
[complete-list response contract](https://docs.aws.amazon.com/IAM/latest/APIReference/API_ListPolicyVersions.html).

### Same-runner approval component — not an executor

`scripts/pricing_bootstrap_approval.py` implements only the in-process approval
boundary. The selected AWS owner is receipt metadata only. Flamur subsequently
explicitly selected GitHub User `FlamurMaliqi` as the creation-plan receipt
approver. Read-only GitHub account metadata reconfirmed stable numeric ID
`120040061`; `APPROVED_HUMAN_IDS` now contains only that reviewed ID, not a login
match or dispatch/environment input. Selecting this approver is not approval
of any receipt/plan, AWS setup, credentials, session or deployment. No workflow
or executor is activated; other phases/approvers require their own reviewed selection.
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

Saved-plan custody now uses native Linux seals, not a mutable pathname or a
caller-reported hash alone. `sealed_saved_plan` accepts only an owner-private
regular `0600` file with one link, no final symlink, and 1 byte–64 MiB of bytes; it
copies to an anonymous private descriptor, seals writes/growth/shrinkage and
further seal changes, and verifies the actual SHA-256. Platforms without Linux
sealing reject before opening the source. The descriptor closes on normal or
exceptional context exit; no plan bytes or descriptor path enter the receipt.
`ApprovalGate.fetch_and_consume_saved_plan` checks this sealed descriptor against
the receipt's plan digest, then obtains and consumes fresh GitHub evidence.
The future executor must keep that context open and pass the **same live FD**
to native Terraform show/guard/apply using `/proc/self/fd/<fd>` and `pass_fds`.
It must not close/reuse the FD, reopen the original file, or use the older
metadata-only consumption method as execution authorization. This is only
artifact custody, not an executor. Plan-guard integration is described below;
every admission/state/hold/authorization check still needs actual integration.
Tests use synthetic bytes and offline Terraform fixtures. Native Linux CI
checks that Terraform can read the sealed plan after its original is removed;
there is no apply call or AWS operation in this custody slice.

The draft now incorporates #343's existing guard and plan-only files as a code
dependency; neither PR is merged and no workflow is dispatched or activated.
The imported diagnostic workflow's guard output is now redirected to its private
temporary log; failed guard diagnostics cannot publish raw container/environment
plan data. A synthetic shell regression checks all three guard failures,
short-circuiting, successful status and private log mode. The older #343 head
without this repair must not be dispatched or treated as the reviewed lane.
`guard_saved_plan` runs native `terraform show` on the sealed descriptor, then
the unchanged writer-boundary and phase-specific pricing/source checks, followed by the
existing Finance/protected-resource guard on that same inherited FD. All output
is captured privately and failures are sanitized. Inspection processes receive
no inherited credentials, TF_VAR values, logging/CLI overrides or shell hooks.
The saved-plan approval path runs these checks before fetching/consuming human
approval; a guard failure cannot consume it. The former eight-create IAM review
plan is rejected, not treated as the seven-resource pricing plan.
Tests cover the command/FD/environment boundary with mocked inspection output;
Linux CI also rejects a genuine native eight-create fixture. This does not prove
a production full refresh or positive live all-guard admission. Pinned
runtime/provider admission and fresh
state/session/authorization/whole-writer-hold checks remain required before both
receipt construction and consumption. The CLI still has no executor/apply lane.

The diagnostic draft freezes its existing three action references to exact
commit IDs, selects Terraform `1.5.7` and initializes with `-lockfile=readonly`.
Before saved-plan inspection, the shared guard observes native `terraform
version -json` and rejects anything other than `1.5.7`, `linux_amd64`, AWS
`5.100.0` and Cloudflare `4.52.7` (the committed provider selections). A mismatch
stops before `show` or approval fetching/consumption; output remains private.
These are compatibility checks, **not trusted runtime admission**: a substituted
binary can report the expected metadata. Action pinning does not prove reviewed
provenance, and read-only initialization alone does not verify the extracted
provider files, backend/workspace initialization or immutable runner. Those
gates remain unimplemented; no credential loading or setup is authorized by
passing these observations. Tests mock version mismatches and check committed
lockfile alignment; Linux CI also exercises the native observation before the
eight-create negative plan proof.

`verify_checkout_source` now checks the actual checkout against the receipt's
exact commit and GitHub's authenticated current `main` ref. It runs before
receipt construction, before saved-plan guards and again after fresh approval
fetching. It checks every tracked file's raw Git blob identity and executable
mode (owner execute), even if index flags hide edits; rejects index changes, missing files,
symlinks/submodules/hardlinks and extra files including ignored overrides.
Only `infra/.terraform/` initialization files are excluded; their provider,
backend and workspace admission remains a separate **unimplemented** gate.
Git inspection has a fixed environment, no replacement objects or filesystem
monitor/untracked-cache hooks, and case-sensitive enumeration regardless of
local Git configuration; failures expose only a fixed message. Raw index
records must exactly match the reviewed tree, rather than trusting diff output
that can hide intent-to-add entries or configured submodule differences.
Independent review found those index-visibility and executable-bit gaps;
the exact comparison and owner-execute check have regression coverage.
It never fetches or resets
Git, writes files, changes refs or dispatches a workflow. Tests use actual
temporary Git repositories and mocked GitHub metadata, not a live setup lane.

This is point-in-time observation, **not filesystem immutability**, source
review provenance, or a main-branch freeze. A trusted independently admitted
runtime and immutable checkout remain prerequisites before privileged inputs
are loaded and through all guard/apply operations. A writable runner could
modify source after inspection or replace this verifier itself. No receipt or
passed test admits that runner, its provider/backend initialization or AWS
session. The private execution lane and whole-writer hold are still absent.

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

### Fixed-36 operator plaintext refresh — separate design decision accepted

Flamur explicitly approved this narrowly scoped access after disclosure that it
includes database administrator credentials and provider API keys. Approval is
for refresh on the reviewed private runner without printing values, not use of
those credentials, granting access, session issuance or execution. The operator's
default-off opt-in reuses the existing inventory and KMS fences; the old hosted
opt-in remains unaccepted for activation. The separate metadata-policy-content
decision is now accepted for preparation above; all execution gates remain
outstanding.

Independent review found a compatibility blocker: the pinned [SSM resource
reader](https://github.com/hashicorp/terraform-provider-aws/blob/v5.100.0/internal/service/ssm/parameter.go)
requests `GetParameter` with decryption. The explicit `kms:Decrypt` denial
therefore blocks refresh of existing SecureString settings, including those
using the AWS-managed SSM key. The explicit opt-in replaces that blanket denial
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
Native offline tests verify the operator opt-in's eight creates, unchanged
default-deny/hosted scope, exact policy reuse, quotas and fence-first attachments.
Read-only `SimulateCustomPolicy` on the four generated operator documents passed
20 cases, including all 36 names for both GetParameter/GetParameters (72 resource
decisions), exact decrypt, wrong/missing service or parameter context, other key,
before-start/at-expiry, old/missing token and wrong/missing source identity.
Unlisted/history/by-path reads remain implicitly denied; pricing value reads,
self-edit and other-role writes are explicitly denied. Exact execution-role
creation/inline-policy writes are allowed only in the synthetic admitted context.
No actual reads, decryption, sessions or grants ran. These are simulated policy
documents, not actual-role, key-policy/SCP or production-refresh proof.
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
