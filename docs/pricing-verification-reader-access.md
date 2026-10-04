# VAY-1543 protected reader access — merge gated

This normal-root opt-in adds the exact OIDC subject
`repo:vayada-marketplace/vayada-platform:environment:vay1543-pricing-verification`
to the existing `vayada-github-actions-platform-plan` role in account
`269416271598`. It retains the existing pull-request trust and does not change
the role's permissions. The protected environment requires human approval and
allows only `main`; reverify those settings before installation and dispatch.

**Merging changes AWS access:** the normal Terraform Apply installs this trust.
Before merge, inspect the fresh full-root plan: it must contain exactly one
in-place update to `aws_iam_role.platform_plan[0]`, only adding this trust
statement, with no permission, resource, deployment or unrelated changes.
Obtain explicit human approval for that exact plan and coordinate the shared
release window; keep the existing API/frontend holds intact. Unexpected changes
block merge rather than authorizing a targeted apply or bypass.
The normal Apply also runs imperative deployment checks outside Terraform's
plan; coordination must verify those holds and deployment drift before merge.

This does not dispatch the identity workflow, prove effective read permissions,
admit the private no-op lane, install pricing credentials, start services, or
authorize hotel testing. Those remain separate reviewed and approved steps.
