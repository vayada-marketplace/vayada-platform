# Production legacy PMS freeze (VAY-1362)

`infra/legacy_pms_freeze.tf` wires the freeze switches that the legacy PMS API
(`apps/pms-api/app/config.py`) already reads into the production
`vayada-pms-backend` task definition. Every switch defaults to `null`. A null
switch adds no environment entry, so the task definition stays identical and
the Terraform plan shows no change until go-day sets a switch.

| Terraform variable | Container variable | App default | Freeze value |
|---|---|---|---|
| `legacy_pms_scheduler_enabled` | `PMS_SCHEDULER_ENABLED` | `true` | `false` |
| `legacy_pms_webhook_mode` | `PMS_LEGACY_WEBHOOK_MODE` | `mutating` | `proxy_to_target` |
| `legacy_pms_stripe_webhook_mode` | `PMS_LEGACY_STRIPE_WEBHOOK_MODE` | falls back to the line above | unset |
| `legacy_pms_xendit_webhook_mode` | `PMS_LEGACY_XENDIT_WEBHOOK_MODE` | falls back | unset |
| `legacy_pms_channex_webhook_mode` | `PMS_LEGACY_CHANNEX_WEBHOOK_MODE` | falls back | unset |
| `legacy_pms_channex_admin_manual_booking_sync_mode` | `CHANNEX_ADMIN_MANUAL_BOOKING_SYNC_MODE` | `CHANNEX_ADMIN_DEFAULT_MODE` (`legacy-owned`) | `disabled` |
| `legacy_pms_channex_admin_manual_ari_sync_mode` | `CHANNEX_ADMIN_MANUAL_ARI_SYNC_MODE` | `CHANNEX_ADMIN_DEFAULT_MODE` (`legacy-owned`) | `disabled` |

Webhook modes are `mutating` and `proxy_to_target`. The Channex admin modes are
`legacy-owned`, `read-only`, `disabled`, `proxy-to-target` and `target-owned`.
Terraform rejects anything else, including `ack_only_with_receipt`.

## Why `ack_only_with_receipt` is rejected

`ack_only_with_receipt` answers 200 with a receipt and does not process the
event. Providers treat it as delivered and never send it again, so the event is
lost. The staging PMS runtime uses it because no real provider calls it; never
copy that block. The freeze uses `proxy_to_target` with **no** target URL.
Legacy then answers 503 (`Webhook proxy target not configured`) and the
provider retries later. Production legacy PMS sets no `PMS_WEBHOOK_TARGET_BASE_URL`
or `PMS_*_WEBHOOK_TARGET_URL`, and Terraform does not wire them. Confirm that
with `proxyTargetConfigured: false` (step 4 below).

The go-day runbook (app repo, `engineering/legacy-migration-go-day-runbook.md`,
step F2) sets the Stripe and Channex modes one by one. The single
`legacy_pms_webhook_mode` below has the same effect and also covers Xendit.

## Before go-day (T-2)

`curl -s https://pms-api.vayada.com/health` must already return the `scheduler`
and `cutover.legacyProviderWebhooks` keys. An older image ignores unknown
settings, so without these keys the switches would do nothing.

## Go-day freeze (runbook step F2, needs the freeze go)

1. Open a PR that adds `infra/legacy_pms_freeze.auto.tfvars.json`:

   ```json
   {
     "legacy_pms_scheduler_enabled": false,
     "legacy_pms_webhook_mode": "proxy_to_target",
     "legacy_pms_channex_admin_manual_booking_sync_mode": "disabled",
     "legacy_pms_channex_admin_manual_ari_sync_mode": "disabled"
   }
   ```

2. The PR's Terraform plan must show only
   `aws_ecs_task_definition.services["pms-backend"] must be replaced`, with
   exactly these four entries added, and
   `Plan: 1 to add, 0 to change, 1 to destroy.` Stop on anything else,
   including a `Value for undeclared variable` warning: Terraform only warns
   about a mistyped key and then leaves that switch unset. A merge applies the
   whole root, so nothing else may merge to `main` between this plan and the
   merge.
3. Merge it only with the freeze go. Merging is the apply: `tf-apply.yml` starts
   at once on the `platform-mutations-v2` environment, which admits only `main`
   and has no required reviewer, so nothing in GitHub waits for an approval. It
   registers the new revision, and then
   (step "Check production PMS task definition drift") rolls
   `vayada-pms-backend-service` onto it. It keeps the image that is running now
   and waits for the service to be stable. If the workflow fails before that
   step, the revision exists but the service still runs the old one: fix the
   cause and re-run `tf-apply.yml` on `main` (`workflow_dispatch`). The drift
   step compares the running revision with the latest and rolls it forward.
4. Verify, read-only:
   - `curl -s https://pms-api.vayada.com/health` shows `scheduler.enabled: false`,
     `running: false`, `active_job_count: 0` and, for `stripe`, `xendit` and
     `channex`, `mode: proxy_to_target` with `proxyTargetConfigured: false`.
   - The new task logs `Scheduler not started because all legacy PMS jobs are frozen`.
   - The running revision holds the four entries:
     `aws ecs describe-task-definition --region eu-west-1 --profile vayada --task-definition "$(aws ecs describe-services --region eu-west-1 --profile vayada --cluster vayada-backend-cluster --services vayada-pms-backend-service --query 'services[0].taskDefinition' --output text)" --query "taskDefinition.containerDefinitions[0].environment"`.
5. Continue with the target writers and the drain (runbook F3 and F4).

## Legacy app deploys

The app repo's legacy deploy workflows (`deploy-pms-api.yml`,
`deploy-booking-api.yml`, `deploy-marketplace-api.yml`) are disabled in GitHub
and stay disabled (Flamur's decision). A legacy change goes live only through an
explicit `workflow_dispatch` of this repo's `deploy.yml` on `main`, one deploy
at a time, with Flamur's go for that deploy naming the service and the image
digest:

| Input | Value |
|---|---|
| `service` | `pms-backend`, `booking-backend` or `marketplace-backend` |
| `ecr_repo` | `vayada-pms-backend`, `vayada-booking-backend` or `vayada-creator-marketplace-backend` |
| `image_sha` | the image's 40-character git SHA tag |
| `image_digest` | the image's `sha256:` digest; the workflow checks that tag and digest match in ECR |
| `environment` | `production` |

`platform-mutations-v2` has no required reviewer, so a dispatched deploy runs
without any further approval. The go comes before the dispatch.

Such a deploy keeps the freeze switches: `deploy.yml` copies the running
revision and only swaps the image.

## Thaw or rollback (runbook R1)

Open a PR that deletes `infra/legacy_pms_freeze.auto.tfvars.json`. Its plan shows
the same single replacement, now without the entries. Merge it; `tf-apply.yml`
rolls the service forward again. With the entries gone, the app defaults return:
the scheduler runs, webhooks mutate and the Channex manual syncs are legacy-owned.
Providers then deliver the events they held back. Do not write `mutating` or
`true` explicitly; deleting the file restores today's task definition exactly.

After the provider handover (runbook H), keep the file. Legacy stays frozen
until it is retired (VAY-1363).

## What these switches do not freeze

- **Legacy PMS write routes.** Admin, booking, affiliate and payout routes stay
  open, and so do the background work they start (Channex ARI pushes, emails).
  The maintenance of the legacy write surfaces (runbook F1) covers them, together
  with the other Channex admin route groups and
  `FINANCE_XENDIT_PAYOUT_RECONCILIATION_LEGACY_MODE`, which this change does not wire.
- **Stripe fixed-plan billing.** The Stripe handler processes fixed-plan
  subscription events before it checks the webhook mode, and the billing job
  `sync_fixed_plan_subscription_prices` runs every 5 minutes whatever
  `PMS_SCHEDULER_ENABLED` says. Both keep writing legacy, as the runbook's
  billing decision expects.
- **Promo usage reconciler.** It starts at boot, outside the scheduler, and
  every 15 seconds retries rows in `booking_promo_usage_state` where
  `desired_state <> applied_state`, calling the Booking API each time. A failing
  row is retried every 30 seconds without limit. Before the Booking API is
  blocked (F1), wait until no such rows remain; otherwise legacy keeps writing
  and the last-write check in the drain never settles.
- **Booking API and Marketplace API.** They have no freeze switch. Their only
  lever is `legacy_booking_api_desired_count` / `legacy_marketplace_api_desired_count`.
- **Calls rejected before the mode check.** The mode applies after the
  signature or token check. Terraform maps neither `CHANNEX_WEBHOOK_SECRET` nor
  `XENDIT_WEBHOOK_SECRET` on production legacy PMS, so legacy already answers
  Channex with 503 and Xendit with 400. In practice the webhook switch changes
  only `/webhooks/stripe` and `/webhooks/stripe/connect`.

Tests: `node --test scripts/test-legacy-pms-freeze.mjs` evaluates these switches
offline, including the freeze file above.
