# VAY-1543 protected bootstrap plan — proposal only

This slice supplies a manually dispatched **plan-only** workflow. It reuses the
production settings already stored as GitHub repository secrets; AWS runtime
copies are incomplete and must not be used to guess Terraform inputs. No secret
export, new role, grant, trust change, credential, service or apply is included.

The existing `platform-mutations-v2` environment and platform deployment role
can prepare the plan without additional permissions. That role still cannot
create the pricing resources. The workflow shares `production-ecs-mutations`,
requires current main plus its exact reviewed SHA, and has no apply command.
Review its code and obtain separate dispatch authorization before running it.

It prepares a full locked plan against the existing production state, with the
same TF_VAR bindings/defaults as Terraform Apply. The current seven resource
declarations are fingerprinted; changed declarations need a new guard review.
Terraform override files are rejected before AWS access or planning.
Only five empty secret containers, the dedicated execution role and its inline
policy are eligible. The guard checks exact names/tags, ECS trust, no additional
role policies, the exact inline-policy role expression, the disabled
metadata stage, and the unknown inline policy's five-secret expression. Existing
writer and protected-resource guards also run. Unknown final secret ARNs mean
the reviewed source declaration, not an invented wildcard, defines that policy.
Unexpected drift, other changes, imports or replacements stop the workflow.

Plan, JSON and Terraform output stay in a mode-0700 runner directory, are never
logged, summarized in full, cached or uploaded, and are removed even on failure.
Only source SHA, saved-plan SHA-256 and the sanitized guard results are emitted.
These hashes are evidence of this diagnostic run, **not** a reusable apply
authorization: the saved plan is discarded when this job ends.

## Remaining operator execution decision

This does not yet replace the local authorized-operator bootstrap described in
[contract PR #251](https://github.com/vayada-marketplace/vayada-platform/pull/251).
A separate proposal must define how an authorized operator uses the production
inputs and reviews/applies the same saved plan without exporting secrets or
permanently expanding normal CI permissions. If a temporary setup identity is
chosen, review its provisioning, main-only OIDC/environment admission, exact
resource permissions, duration/revocation, state access and negative probes
before granting anything. Do not borrow unrelated migration roles or store an
operator access key in GitHub. The plan workflow alone cannot remove that gate.

Before any actual create, coordinate a durable writer pause and review the exact
seven-create saved plan and identity. Keep writers paused through the separate
[two-policy metadata activation](pricing-command-metadata-refresh.md), positive
and negative role checks, and an ordinary hosted no-op refresh. The diagnostic
queue/lock is not a durable operator hold. No database logins, secret values,
pricing traffic, hotel authority selection, quotes, bookings or payments are
authorized by merging or running this plan-only slice.
