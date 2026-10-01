# VAY-1543 temporary creation identity — review only

**Blocked for execution:** the scoped SSM read exception below is proposed for
review, not granted or approved for activation. The temporary identity now has
no IAM write allowances and cannot execute the former seven-create plan.
The operator-owned setup route below is proposed, not implemented or approved
for execution. Its executor gates remain absent. No activation is ready.

This is the first implementation slice of the hosted operator proposal in
[contract #251](https://github.com/vayada-marketplace/vayada-platform/pull/251).
It defines only the creation identity, not an executor or metadata-phase identity.
Merging it creates nothing: the normal platform root does not load this folder.
The isolated root's default `creation_window=null` declares zero resources.
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
for review, not a selection of an AWS operator or permission to run setup.
It reuses `infra/pricing_command_secrets.tf` and the guarded plan proposal
[#343](https://github.com/vayada-marketplace/vayada-platform/pull/343).
No second pricing-resource root, duplicate role declaration, state transfer,
import, targeted apply or extra IAM provisioning identity is needed.

The sole owner of the five containers, execution role and inline policy stays
the normal `infra` root at `s3://vayada-terraform-state/platform/terraform.tfstate`.
The separate `vay1543/bootstrap-identity/terraform.tfstate` key owns only this
proposal's temporary identity resources; it must never own pricing resources.
The temporary identity is **not** used for this seven-create apply, even if its
creation window or SSM opt-in is enabled. Do not provision it merely to unlock
this operator route or add back its IAM writes.

The operator must first be explicitly identified and approved, with reviewed
session admission, time limits/revocation, phase-specific permissions and safe
positive/negative authorization evidence. Ordinary CI, migration credentials
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
An attempted complete metadata-inventory check was throttled and not retried.
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
an admitted job can retrieve plaintext values for these exact parameters.
Treat the runner, inputs, state and transient plan as privileged; do not print,
upload or retain setting values. No Secrets Manager value access is introduced.
The permission proposal does not itself prove a production full refresh works.
Its acceptance and the remaining execution gates are required before admission.
See [SSM encryption context](https://docs.aws.amazon.com/systems-manager/latest/userguide/secure-string-parameter-kms-encryption.html#systems-manager-parameter-store-encryption-context)
and [KMS ViaService](https://docs.aws.amazon.com/kms/latest/developerguide/conditions-kms.html#conditions-kms-via-service).

Do not bypass refresh, use `-target`, broaden reads to pricing secret values,
or count the dummy local plans as evidence that production refresh succeeds.

Still required before either production apply: independently reviewed
same-runner receipt/approval code, immutable source/plan and full root guards,
durable shared writer hold, phase-specific authorization/negative evidence,
separate metadata phase, expiry/revocation proof and partial-failure recovery.
Creation expiry is not retirement verification. Keep the writer hold through
the metadata phase and ordinary hosted no-op refresh. Do not reset the window
or destroy resources as recovery. This slice launches no service, creates no
database login or value, and does not authorize hotel smoke.
