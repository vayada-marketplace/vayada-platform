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

Webhook modes are `mutating`, `ack_only_with_receipt` and `proxy_to_target`.
Manual booking sync modes are `legacy-owned`, `read-only`, `disabled`,
`proxy-to-target` and `target-owned`. Terraform rejects anything else.

## Never use `ack_only_with_receipt` for the freeze

`ack_only_with_receipt` answers 200 with a receipt and does not process the
event. Providers treat it as delivered and never send it again, so the event is
lost. The freeze uses `proxy_to_target` with **no** target URL. Legacy then
answers 503 (`Webhook proxy target not configured`) and the provider retries
later. Production legacy PMS sets no `PMS_WEBHOOK_TARGET_BASE_URL` or
`PMS_*_WEBHOOK_TARGET_URL`, and Terraform does not wire them. Confirm that with
`proxyTargetConfigured: false` (step 4 below).

## Go-day freeze (runbook step F2, needs the freeze go)

1. Open a PR that adds `infra/legacy_pms_freeze.auto.tfvars.json`:

   ```json
   {
     "legacy_pms_scheduler_enabled": false,
     "legacy_pms_webhook_mode": "proxy_to_target",
     "legacy_pms_channex_admin_manual_booking_sync_mode": "disabled"
   }
   ```

2. The PR's Terraform plan must show only
   `aws_ecs_task_definition.services["pms-backend"] must be replaced`, with
   exactly these three entries added, and
   `Plan: 1 to add, 0 to change, 1 to destroy.` Stop on anything else. A merge
   applies the whole root, so nothing else may merge to `main` between this plan
   and the merge.
3. Merge it. Merging is the apply: `tf-apply.yml` waits for approval on the
   `platform-mutations-v2` environment, registers the new revision, and then
   (step "Check production PMS task definition drift") rolls
   `vayada-pms-backend-service` onto it. It keeps the image that is running now
   and waits for the service to be stable.
4. Verify, read-only:
   - `curl -s https://pms-api.vayada.com/health` shows `scheduler.enabled: false`
     and, for `stripe`, `xendit` and `channex`, `mode: proxy_to_target` with
     `proxyTargetConfigured: false`.
   - The new task logs `Scheduler not started because all legacy PMS jobs are frozen`.
   - The running revision holds the three entries:
     `aws ecs describe-task-definition --task-definition "$(aws ecs describe-services --cluster vayada-backend-cluster --services vayada-pms-backend-service --query 'services[0].taskDefinition' --output text --profile vayada)" --query "taskDefinition.containerDefinitions[0].environment" --profile vayada`.
5. Continue with the drain (runbook F3).

App image deploys during the freeze keep the switches: `deploy.yml` copies the
running revision and only swaps the image.

## Thaw or rollback (runbook R1)

Open a PR that deletes `infra/legacy_pms_freeze.auto.tfvars.json`. Its plan shows
the same single replacement, now without the entries. Merge it; `tf-apply.yml`
rolls the service forward again. With the entries gone, the app defaults return:
the scheduler runs, webhooks mutate and the manual booking sync is legacy-owned.
Providers then deliver the events they held back. Do not write `mutating` or
`true` explicitly; deleting the file restores today's task definition exactly.

After the provider handover (runbook H1/H2), keep the file. Legacy stays frozen
until it is retired (VAY-1363).

## What these switches do not freeze

- **Stripe fixed-plan billing (S3).** The Stripe handler processes fixed-plan
  subscription events before it checks the webhook mode. The separate billing
  job `sync_fixed_plan_subscription_prices` runs every 5 minutes, whatever
  `PMS_SCHEDULER_ENABLED` says. Both keep writing legacy.
- **Promo usage reconciler.** It starts at boot, outside the scheduler, and works
  through pending rows in `booking_promo_usage_state` every 15 seconds. It stops
  writing once no new bookings arrive, so the drain must wait it out.
- **Other legacy Channex admin route groups** (ARI sync, provisioning, markups and
  others) stay on `CHANNEX_ADMIN_DEFAULT_MODE`. The maintenance of the legacy
  write surfaces (runbook F1) covers them.
- **Booking API and Marketplace API.** They have no freeze switch. Their only
  lever is `legacy_booking_api_desired_count` / `legacy_marketplace_api_desired_count`.
- **Unauthenticated webhook calls.** The mode applies after the signature or
  token check, so invalid calls still get 400/401.

Tests: `node --test scripts/test-legacy-pms-freeze.mjs` evaluates these switches
offline, including the freeze file above.
