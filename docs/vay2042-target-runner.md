# VAY-2042 fixed fresh-target runner

Successor to target launcher #269 and source runner #268. Only the reviewed
fresh-target bootstrap is executable here; no extraction, binding, migration,
owner access, provider call or production change is included.

`target_bootstrap.tf` adds seven resources: one retained empty target-writer
secret, task role/policy, fixed task, orchestrator role/policy and fixed state
machine. The data GitHub policy gains only Start/Describe for that exact state
machine. It still cannot run ECS directly, pass roles or read credentials.
The existing **data-lane** execution role and log group are reused unchanged;
target records use `target/target-bootstrap/<task-id>`. Source orchestration and
every metadata identity, secret, task and policy remain unchanged. The target
task may Describe/Put only its distinct secret, while ECS injects only the exact
restore's managed master credential through the shared data execution role.

Use the isolated saved-plan/operator procedure in
`vay2017-metadata-infrastructure-lane.md`. If source resources are not yet applied,
the combined plan must contain exactly nineteen creates and zero updates,
deletes, replacements or imports. If source resources already exist, require
seven creates and only the exact data GitHub-policy update. Never reuse the
earlier twelve-create plan. Independently review the complete fresh saved plan
and get explicit approval of that plan and new secret/task/log costs. No apply
or cleanup is automated.

The `vay2042-data-rehearsal` environment must be externally verified as main-only,
designated-owner approval required, administrator bypass disabled. The accepted
sole-owner policy permits self-review; its YAML name alone proves nothing.
Before approving **VAY-2042 Isolated Fresh Target Bootstrap**, independently
verify live restore identity, isolation/capacity, deployed bundle/image/IAM and
the exact empty target secret. Review successful source bootstrap evidence first:
target creation adds a tenth database, so source bootstrap cannot follow it.
Both workflows use shared restore concurrency, but each needs its own approval.

Require exit zero and the exact sanitized target record with `bound: false`.
On any failure or unknown final activation, retain resources and inspect the
exact writer/database/secret state; never retry, drop or rotate blindly. The
writer expires in 24 hours. Attestor-owned source evidence and fresh target/run
binding remain separate reviewed prerequisites before any row extraction.

For the host-address launcher correction after initial installation, use the
narrow repair-plan gate in `vay2042-source-reader-runner.md`. Keep target dispatch
held until the repaired source run succeeds and the target preflight is fresh.
