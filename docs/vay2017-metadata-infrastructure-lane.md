# VAY-2043 metadata runner infrastructure lane

VAY-2043 infrastructure lives in `infra/vay2017-metadata-runner`, with an
independent Terraform state key. The normal platform Terraform root and
`vayada-github-actions-platform-deploy` role do not manage or receive IAM
permissions for these resources.

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
- no production service, database, IAM role, secret, or shared network changes;
- the restored RDS instance and source snapshot identity match the checked-in
  restore attestation;
- all runner traffic stays in the private restore VPC and the dedicated
  database security group;
- the task image remains pinned by digest and its execution policy can read
  only the one attested RDS-managed secret.

Save the plan outside the repository with restrictive local permissions. Apply
only that exact saved plan after the owner approves that run. If apply fails or
the plan contains anything outside the allowlist, stop and retain its state and
evidence for review. Never run `destroy`, reuse a saved plan, or copy state
between this root and the platform root.

This file split does not authorize an apply or inventory run. The existing
`vay2017-metadata-preflight` GitHub environment continues to gate inventory
execution separately. First apply, live isolation verification, and each
inventory execution remain distinct approval points.
