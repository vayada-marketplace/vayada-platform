# VAY-2029 isolated recovery environment

This standalone Terraform root creates only synthetic recovery targets. It is
outside `infra/`, so the production Terraform apply workflow does not create it.
Its encrypted state uses `rehearsal/coordinated/terraform.tfstate` in the existing
state bucket, rather than `platform/terraform.tfstate`. The provider rejects any
account other than `269416271598`; region is fixed to `eu-west-1`.

## Initial resources and capacity

- Dedicated `vayada-coordinated-recovery` ECS cluster and VPC/subnet/routes.
- Six `vayada-recovery-*` services: api, pms, booking-web, booking-admin,
  marketplace-web and marketplace-admin. Each has one 0.25-vCPU, 512-MiB Fargate
  task: total 1.5 vCPU, 3 GiB and six public IPv4 addresses while running.
- No public ingress. Port 8080 is reachable only between fixture tasks using
  the fixture security group. HTTPS egress supports image pulls and logging;
  no VPC peering, production target groups, listeners or DNS are added.
- One execution role can pull only the six fixture ECR repositories and write
  only fixture logs. ECR authentication itself requires the standard wildcard
  token permission. Containers have no task role, secrets or database access.
- Six immutable-tag ECR repositories for subsequent fixture releases. Initial
  tasks use a digest-pinned official Python image from Docker Hub. Bootstrap
  depends on that public registry's availability/rate limits; no app image is
  substituted if pulling fails.
- CloudWatch logs retained seven days. ECR images cannot be force-deleted.
  No production or shared migration fixtures are reused.

The synthetic `/health` returns service/revision identity and either 200 or 503.
`FIXTURE_HEALTH=unhealthy` provides a future isolated failure case. The initial
bootstrap task health check expects `bootstrap-v1`. Future fixture releases must
update the expected identity alongside the image; this is not production smoke.

## Review and apply

From this directory:

```sh
terraform init -input=false
terraform fmt -check
terraform validate
python3 -m unittest test_fixture.py
terraform plan -input=false -out=recovery.tfplan
terraform show -json recovery.tfplan > plan.json
shasum -a 256 recovery.tfplan
```

The first plan must contain exactly 28 creates, zero changes and zero deletes:
one VPC, subnet, internet gateway, route table, route association, security group,
cluster and log group; six ECR repositories, task definitions and services; one
execution role and its inline policy. Review resource names, IAM and the exact
saved-plan hash before explicit apply approval. Do not run the production root,
use `-target` to mask unrelated changes, or auto-apply on merge.

Only after approval for the exact reviewed commit and saved plan:

```sh
terraform apply recovery.tfplan
```

An apply starts six billed tasks and public addresses. After the rehearsal,
produce a separately reviewed shutdown plan; preserve logs, images and runtime
control evidence until acceptance. There is no automated resource destruction.

## Private preflight runner

`runner.py` defaults to read-only inspection. It checks the six exact service
identities, approved subnet/security group, bootstrap image/command/environment,
execution role, absence of a task role/secrets, and healthy task identities.
Physical network IDs are pinned to the approved bootstrap; replacing the network
requires a reviewed runner update.

`--run` additionally requires the `vayada-recovery-runner` assumed role. It
registers and starts one non-root, read-only probe task inside the fixture
network. That task checks all six private endpoints' service and bootstrap
revision identities. Redirects and environment proxies are disabled. The role
is main-only, allows only the probe task family in the fixture cluster and the
fixture execution role, and explicitly denies service and SSM state mutations.
No image publishing or deployment authority is granted.

After approval of the new role's saved Terraform plan and reviewed main revision:

```sh
gh workflow run probe-recovery-environment.yml \
  --repo vayada-marketplace/vayada-platform --ref main
```

The manual workflow holds the existing global ECS mutation lock. It uploads
90-day evidence only on success and marks recovery scenarios `not-run`. AWS CLI
calls have 45-second subprocess limits; task polling is bounded to 240 seconds,
with cleanup of the exact launched task on timeout/error. The probe's six HTTP
requests each have a five-second timeout. Unexpected cancellation during AWS
launch may prevent collecting the task ARN: inspect the fixture cluster before
retrying. Probe task definitions and logs remain as evidence; no tasks loop or
listen indefinitely.

## What this does not yet enable

The environment and private preflight do not yet run recovery scenarios. No
publisher role, SSM runtime records, synthetic release artifacts or
production-role extension is created. A separate reviewed change must add
fixture publication identity, reconciliation target validation and scoped
mutation authority before running scenario injections.

Production smoke helpers must never be used for these targets: they point at
live domains. Reuse the actual reconciler's state/retry/hold/rollback logic with
explicit fixture identities, not forged production manifests or weaker
production allowlists. Prove the fixture role cannot mutate live ECS/SSM before
executing failures. Global-lock, checkpoint, state-write failure and system
rollback scenarios remain outstanding VAY-2029 acceptance work.
