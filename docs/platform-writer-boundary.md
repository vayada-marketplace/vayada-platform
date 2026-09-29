# Staged platform writer admission (VAY-2029)

The transition-session boundary is installed: `bootstrap_plan_role: true`,
`enforce_trust: true`, `revoke_before: 2026-09-25T08:08:47Z`. All mutation-role
callers use the main-only `platform-mutations-v2` environment. Protected
admission is proven, a no-environment OIDC probe denied all 12 assume attempts,
and a post-cutoff protected Terraform Apply completed with no changes. This
boundary does not enable coordinated deployment or clear release holds.

The installed evidence is platform PRs #262, #265, and #272; runs `36105639066`,
`36109471264`, `36109998999`, and `36117487916`. The last run reports 0 added,
0 changed, and 0 destroyed. The cutoff policy simulation explicitly denies
`2026-09-25T08:08:46Z` and allows the cutoff instant and one second later.

## Boundary

Old workflow code cannot execute new guards. Platform IAM now trusts only `repo:vayada-marketplace/vayada-platform:environment:platform-mutations-v2`, audience `sts.amazonaws.com`, and the environment restricts deployments to reviewed main. The existing grants stay in place: do not clone its nine inline/eight managed policies. This protects against the recorded old workflow code, not malicious repository administrators or every possible account credential.

Trust changes alone do not revoke existing STS sessions. This operator-selected UTC cutoff installs an explicit all-action denial for `aws:TokenIssueTime` older than `2026-09-25T08:08:47Z`. Later old-workflow credential requests already fail the enforced trust; post-cutoff sessions from the protected environment remain admitted.

Terraform Plan uses a role with enumerated provider metadata reads, scoped SSM configuration reads, exactly two S3 object reads (state and managed BIMI logo), and exact backend lock-table item access. It has no resource mutation other than DynamoDB lock bookkeeping. It remains privileged: state/SSM reads may reveal application secrets. No KMS decrypt is granted. Hosted provider refresh is proven; do not replace the allowlist with AdministratorAccess or blanket ReadOnlyAccess on a future failure.

The mutation role gains one managed attachment for metadata reads of the new role/policy and later session revocation. This avoids the aggregate inline quota. Recount live attachments before bootstrap: AWS attachment limits and the parallel RDS managed-policy repair must be accounted for; do not duplicate that repair.

## Durable staged rollout

`platform_writer_boundary.auto.tfvars.json` is the committed stage selector, read by ordinary Terraform Plan and Apply. Do not enable stages using an unrecorded operator-only `TF_VAR` override and then leave normal CI on false defaults. Each stage is a separate exact reviewed configuration/code change. Keep a writer pause through enforcement and revocation; normal operations must not execute a partially installed boundary.

1. **Prepare bootstrap.** Rebase on current main; confirm the policy matrix against live IAM without printing secrets. Create/configure the new GitHub environment under approved action: main-only branch admission, required protection as agreed, and inherited settings audit. Stage only `bootstrap_plan_role: true` in the durable file; leave enforcement false and cutoff null. Obtain approval for a saved clean plan and have the authorized operator apply it to the existing platform state. The existing mutation role cannot create this role, attach the boundary policy, or change its own trust. Ordinary CI is not a substitute for operator bootstrap.
2. **Verify the plan identity.** Use a bounded approved same-repository PR plan with the exact new role and current provider configuration. Demonstrate state read/locking/refresh, no S3 state write, denied deployment/IAM/SSM writes, and unchanged resource state. Fork PRs must not receive these credentials. Diagnose missing refresh permissions narrowly; SSM/KMS decryption is an explicit unproven gate.
3. **Migrate reviewed workflow callers.** Apply `deployment/platform-writer-boundary-workflows.patch` to a current reviewed revision and submit that diff as a separate PR. It routes ordinary deploy, maps/canary, Terraform Apply and RDS rotation to the new protected environment, checks main before credentials, and routes same-repository PR Terraform Plan to the plan role. The patch is not an executable workflow and has no effect merely by existing. Regenerate/review if intervening workflow edits conflict. Do not apply it before environment/role readiness.
4. **Enforce trust.** With migrated callers and writer pause, commit `enforce_trust: true`, leaving cutoff null. Review/apply the exact trust-only change using authorized operator credentials. Allow IAM propagation; prove new-environment OIDC admission and old/no-environment rejection through bounded new negative/read-only probes. Do not rerun or poll the stuck requests. A workflow input called `environment` is not an OIDC job environment.
5. **Revoke transition sessions.** After trust rejection is verified, choose an explicit UTC cutoff that covers sessions issued during the transition. Persist it in `revoke_before`; review the exact policy update. Drain writers and disable Terraform Apply, have the authorized operator install that reviewed policy version, verify pre-cutoff denial and post-cutoff protected admission after propagation, then merge the durable selector. Re-enable Terraform Apply only for the resulting no-op run before restoring writers. IAM is eventually consistent; no immediate enforcement is assumed. Previously accepted ECS updates may finish: stabilize and inventory actual services before resuming writers or activation.
6. **Retain the boundary.** Never reset bootstrap/enforcement or remove/move cutoff backward for recovery. The plan guard rejects changes to installed enforced trust, revocation removal/narrowing/backward cutoff, and attachment removal/repointing (including moved addresses). `prevent_destroy` additionally protects resources; it does not protect policy contents by itself. The guard runs before plan publication/apply and does not replace approval or block an out-of-band administrator.

At the initial read-only audit, `next` had zero environment secrets, zero variables and no protection rules, while ordinary deploy, Terraform Apply and rotation had no job environment. All mutation-role callers now use `platform-mutations-v2`; it admits only `main` and has no environment secrets or variables. Repository/organization settings were not copied or exposed. The plan role itself gets no GitHub environment capable of assuming the mutation role.

## Recovery and limits

Held manual recovery uses the reviewed migrated workflow and existing durable holds; keep desired-release, holds, checkpoint obligations and provenance. Old workflow revisions should fail authentication. Do not relax trust to make an old revision run. Automatic legacy delivery remains separately fenced and needs the authenticated generation/source/checkpoint protocol; installing this IAM boundary does not reopen it or authorize activation.

The cutoff's pre-cutoff denial and post-cutoff admission are proven. Product
smoke and coordinated activation remain unproven. The retained old queued
requests are authentication-fenced; do not cancel, rerun, or treat them as
release evidence.

Sources: [AWS session revocation](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_revoke-sessions.html), [GitHub OIDC with AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws).
