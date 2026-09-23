# VAY-2043 metadata runner infrastructure lane

VAY-2043 infrastructure lives in `infra/vay2017-metadata-runner`, with an
independent Terraform state key. It creates a dedicated VPC and a new private
RDS restore from the immutable VAY-2017 source snapshot. The pre-existing
rehearsal restore in the shared default VPC is left untouched. The normal
platform Terraform root and `vayada-github-actions-platform-deploy` role do not
manage or receive IAM permissions for these resources.

## Plan and apply boundary

The isolated root has no automated apply workflow. Its backend uses the
existing encrypted state bucket and lock table, but a distinct state key:
`vay2017/metadata-runner/terraform.tfstate`. Only an authorized AWS operator
may run the first plan/apply, using a saved plan and the current reviewed main
revision. Do not use the normal platform deploy role, an administrator
workstation with unrelated credentials, or Terraform targeting against the
production platform root.

Before merging this state split, review the hosted Terraform Plan for the
existing platform root and require zero deletes or replacements for the
VAY-2043 resource addresses. Also verify that the platform state address list
contains no `aws_*` resource whose name starts with `vay2017_`. If either check
finds a tracked resource or a planned destroy, stop: do not apply either root
and do not create duplicates. Resolve existing state through a separately
reviewed state-migration plan before continuing; this lane intentionally does
not move, copy, or forget state.

Before apply, independently review the complete saved plan and require:

- every create is for a resource declared in `infra/vay2017-metadata-runner`;
- zero changes, deletes, replacements, or imports;
- no changes to existing production services, databases, networks, IAM roles,
  or secrets;
- exactly one new PostgreSQL RDS instance restored from
  `vay2017-legacy-source-freeze-20260920`, with RDS-managed Secrets Manager
  credentials, encrypted storage, no public access, no Multi-AZ deployment,
  and the same small instance class as the existing rehearsal restore;
- the old restore `vay2017-legacy-rehearsal-20260921` is not managed, modified,
  or deleted by this plan;
- `10.230.0.0/24` remains unused and non-overlapping immediately before apply;
- the new VPC has no internet/NAT gateway and no peering, and has separate
  private runner, endpoint, and two-AZ database subnets;
- runner routes are local plus the S3 image-layer endpoint only; its security
  group permits PostgreSQL only to the dedicated RDS group, HTTPS only to the
  dedicated AWS endpoint group, and S3 image-layer traffic;
- the database security group admits TCP 5432 only from the runner security
  group and has no egress rules;
- the task image remains pinned by digest; only the isolated one-time bootstrap
  task execution role can read the new restore's RDS-managed master secret;
- the separate inventory task execution role can read only the dedicated
  count-only reader secret, and the bootstrap task role can only write that
  exact reader secret;
- the inventory login has no direct table or column `SELECT`, schema `CREATE`,
  temporary-object creation, or table/sequence write privileges; the bootstrap
  removes PostgreSQL's default `PUBLIC` temporary-object privilege and `PUBLIC`
  execute on other application `SECURITY DEFINER` routines only on this
  isolated restore. Connect access is also removed from connectable template
  databases on this isolated restore; they are not inventoried. The scanner can
  call the fixed safe row-count function.

Creating the additional RDS copy starts AWS compute/storage and managed-secret
charges. Do not apply without a fresh, explicit approval of the exact saved
plan and these ongoing-cost implications. Terraform protects the RDS instance
from accidental destruction. Cleanup is a separate approved action; no cleanup
or source snapshot deletion is authorized here.

Save the plan outside the repository with restrictive local permissions. Apply
only that exact saved plan after the owner approves that run. If apply fails or
the plan contains anything outside the allowlist, stop and retain its state
and evidence for review. Never run `destroy`, reuse a saved plan, or copy state
between this root and the platform root.

This file split and plan do not authorize an apply, reader-provisioning run, or
inventory run. The `vay2017-metadata-preflight` GitHub environment gates
provisioning and inventory separately. First apply, live isolation verification,
reader provisioning, inventory, and cleanup remain distinct approval points.
