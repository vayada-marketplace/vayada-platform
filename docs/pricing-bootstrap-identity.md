# VAY-1543 temporary creation identity — review only

**Blocked for execution:** the retained no-decrypt boundary is incompatible
with production Terraform's full SecureString refresh. No activation is ready.

This is the first implementation slice of the hosted operator proposal in
[contract #251](https://github.com/vayada-marketplace/vayada-platform/pull/251).
It defines only the creation identity, not an executor or metadata-phase identity.
Merging it creates nothing: the normal platform root does not load this folder.
The isolated root's default `creation_window=null` declares zero resources.
No workflow provisions or assumes the new role.

`infra/pricing-bootstrap-identity` owns a separate IAM-only state key. An
authorized operator must review its own exact four-addition plan and identity
(one role, its creation/fence inline policy, a managed refresh policy and attachment);
never add it to the seven-create pricing plan, import existing identities,
apply from normal CI, or populate it with production Terraform inputs.
Only reviewed exact KMS metadata ARNs may be supplied; default empty inventory
is not evidence that production-root refresh works.

The creation role reuses the enumerated plan-policy refresh/lock allowlist,
adds writes only to the exact production state object, the dedicated execution
role, and five fixed secret names with their required tags. Secret ARNs have
six suffix placeholders, not a broad prefix. No metadata-policy mutation,
service mutation, PassRole, secret-value read/subsequent write, KMS decrypt,
or role assumption is allowed. State/SSM configuration reads remain privileged.
CreateSecret can include initial values and PutRolePolicy accepts arbitrary
JSON: IAM does not prove the empty-container or policy-content restrictions.
Reviewed source, exact-plan approval and verification must enforce them.

Admission is a fixed OIDC audience/environment within a reviewed UTC window
of at most one hour. Request-time denial stops already-issued sessions at the
end; older sessions are rejected when a new window starts. Before provisioning,
prove the new `pricing-bootstrap-create-v1` environment admits reviewed `main`
only and requires the agreed approved human reviewers. The IAM environment
subject alone does not restrict branch or human identity. Do not configure
or activate it under this PR's approval. Operators also control the new role;
it cannot edit its own trust or permissions. Only its declared refresh policy
may be attached. The inline all-action time fences also deny managed refresh
permissions outside the window; IAM propagation still needs actual proof.

Provider action inventory was checked against the pinned [AWS 5.100.0 role](https://github.com/hashicorp/terraform-provider-aws/blob/v5.100.0/internal/service/iam/role.go)
and [secret](https://github.com/hashicorp/terraform-provider-aws/blob/v5.100.0/internal/service/secretsmanager/secret.go)
creation/read paths. CreateSecret name conditions are separate from TagResource,
which does not support that key ([AWS action reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_secretsmanager.html)).
Offline native plans validate declaration/policy structure, not live IAM admission.

Independent review found a compatibility blocker: the pinned [SSM resource
reader](https://github.com/hashicorp/terraform-provider-aws/blob/v5.100.0/internal/service/ssm/parameter.go)
requests `GetParameter` with decryption. The explicit `kms:Decrypt` denial
therefore blocks refresh of existing SecureString settings, including those
using the AWS-managed SSM key. This slice intentionally retains the approved
no-decrypt boundary. A separately approved narrowly scoped SSM-only exception
or a different full-plan strategy is required before provisioning/admission.
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
