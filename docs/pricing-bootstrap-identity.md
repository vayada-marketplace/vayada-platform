# VAY-1543 temporary creation identity — review only

**Blocked for execution:** the scoped SSM read exception below is proposed for
review, not granted or approved for activation. Executor and role-policy-content
gates are still absent. No activation is ready.

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
adds writes only to the exact production state object, the dedicated execution
role, and five fixed secret names with their required tags. Secret ARNs have
six suffix placeholders, not a broad prefix. No metadata-policy mutation,
service mutation, PassRole, Secrets Manager value read/subsequent write,
or role assumption is allowed. KMS decrypt is denied by default; the proposed
exception permits only the fixed SSM refresh described below. State/SSM
configuration reads remain privileged.
CreateSecret can include initial values and PutRolePolicy accepts arbitrary
JSON: IAM does not prove the empty-container or policy-content restrictions.
Reviewed source, exact-plan approval and verification must enforce them.
CodeRabbit's review of the initial slice raised this as a major activation
blocker: arbitrary execution-role trust/policy content can confer authority on
another principal that outlives the bootstrap window. The bootstrap role's own
time fences and chaining denial do not constrain that other principal. No
execution-role permissions boundary exists in the seven-create declaration.
Do not invent a boundary ARN or mark the concern resolved; require a reviewed
content-enforcement design or explicit acceptance of this trusted-operator
authority, plus implemented exact-source/plan controls, before activation.

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
