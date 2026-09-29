# VAY-2042 fixed source-reader runner

Successor to launcher PR #266; source-reader provisioning only, before target
bootstrap adds the tenth database. No extraction, attestation binding, migration,
production change, provider call, or owner-access grant is authorized here.

The isolated Terraform root adds exactly twelve `vay2042_source_*` resources:
one empty retained secret, one log group, four dedicated IAM roles and policies,
one fixed task, and one fixed state machine. Existing metadata roles, secrets,
tasks, state machines, database and network resources are unchanged. Task stop
permission requires this operation's task tag; GitHub cannot run ECS directly,
pass roles, read credentials, or supply a command. The master credential is
injected only by the separate execution role into the fixed bootstrap task.

Before any apply, independently review a fresh saved plan from
`infra/vay2017-metadata-runner`: twelve creates, zero updates/deletes/replacements,
and no production-root change. Use the isolated operator/state procedure in
`vay2017-metadata-infrastructure-lane.md`; obtain explicit approval of that exact
plan and the new secret/log costs. No automated apply or cleanup is provided.
If installing the target successor together, use the nineteen-create combined
plan gate in `vay2042-target-runner.md` instead; do not reuse a source-only plan.

Before enabling IAM trust or dispatching, verify the **new** GitHub environment
`vay2042-data-rehearsal` exists, permits only `main`, requires designated-owner
approval, and disables administrator bypass. The accepted sole-owner policy
allows that owner to approve their own initiated run. Do not substitute the
unprotected `next` or metadata-only environment. Environment setup is external
and must be evidenced; declaring its name in YAML is not proof of protection.

Immediately before every approved dispatch, an independent read-only operator
must run the existing isolation check and additionally verify exact resource ID
`db-BB7GOFQ3BQTLTBG444I2Q75X6Y`, the deployed bundle/image, all new role policies,
and the empty exact source-reader secret. The GitHub role deliberately cannot
perform these broad cloud checks. Approve only after that evidence is reviewed.
Run **VAY-2042 Isolated Source Reader Bootstrap** from protected main; shared
restore concurrency is retained without broadening metadata authority.

Require exit zero plus the exact sanitized completion record. On any failure,
retain resources and inspect the NOLOGIN/indeterminate activation state; never
retry blindly. The reader expires in 24 hours. Source snapshot/freeze evidence
and fresh target/run binding remain separate reviewed steps before extraction.

## Reviewed launcher repair after initial installation

For the PostgreSQL host-address projection correction, a fresh saved plan may
replace only the two `vay2042` task definitions and update their two orchestrator
policies and two state-machine definitions to reference the new exact revisions.
Require unchanged image, network, roles, permissions, secrets and database; the
only authored task payload change is `inet_server_addr()::text` to
`host(inet_server_addr())`. Independently review the complete plan and obtain
explicit approval; the initial-install create-only plans must not be reused.

Hold both dispatches until apply and effective bundle/revision/reference readback
complete, because these six updates are not atomic. Require no running or
unexplained prior executions and an empty source credential destination. Failed
run `36111801240` is a known pre-provisioning endpoint-check failure; its retained
evidence and reviewed control flow establish no provisioning SQL or credential
write was reached. It needs no database cleanup. A corrected source run still
requires normal protected approval, then success before fresh target preflight.
