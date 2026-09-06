# Native Inbox email delivery receipts (VAY-1381)

Contract: product repo `engineering/native-guest-inbox-contract.md`.
Owner: VAY-1381. This is not Inbox launch or Channex cutover approval.

## Activation

1. Obtain explicit approval for the Vayada Resend account and shared-next receipt
   endpoint. Verify the account/domain and inspect existing webhook ownership.
2. In Resend, create the endpoint `https://next-api.vayada.com/webhooks/resend`
   subscribing only to `email.delivered`. Keep it disabled during setup. Do not
   change receiving, DNS/MX, API-key permissions or existing provider callbacks.
3. Store its signing secret as the platform repository Actions secret
   `TF_VAR_RESEND_WEBHOOK_SECRET`. Never paste it in an issue, PR, command
   argument, log, or committed file. Do not overwrite an existing secret without
   inspecting its ownership and arranging rollback.
4. Run the normal Terraform plan/apply CI with the new secret. Require a clean,
   scoped plan: one new encrypted SSM parameter and the next-api task definition.
   Other infrastructure drift requires separate review. The apply workflow
   deploys the current next-api image with its new configuration; do not update
   ECS manually. Retain the before/after task identities and confirm all active
   tasks use the new secret reference before enabling the webhook.
5. Confirm an unsigned POST is rejected (`400 missing_resend_signature`, never
   `503 resend_webhook_not_configured`). Enable this webhook, then perform only
   the approved property-scoped Inbox tests. Link provider email IDs, verified
   webhook delivery and persisted Inbox receipts; provider acceptance alone is
   not mailbox delivery.

The secret is optional: absent/empty preserves today's unconfigured receiver.
No sender route, send flag or provider subscription is enabled by this code.
Terraform manages the SSM value; the value stays sensitive in plan output.

## Existing application limitations

The endpoint accepts only verified `email.delivered` events. It does not ingest
guest replies or project bounce/complaint events. Do not subscribe to unsupported
events or claim bounce tracking. It matches one already-accepted native Inbox
attempt; unknown or ambiguous email IDs return 503 for retry. The account also
sends Booking notifications, so an account-wide subscription can deliver
unmatched events. Before activation, resolve this ownership/routing gap in the
product receiver or use a provider-supported filter proven to limit delivery to
native Inbox email. Never discard unknown events solely to silence retries.

## Rollback

Disable this specific Resend webhook first and retain pending delivery evidence.
Do not delete the endpoint, rotate its signing key, resend guest email, change
mailbox routing or change global Inbox sending as incidental cleanup. Keep the
Actions secret and SSM parameter during rollback: old task definitions still
reference SSM and replacement tasks must be able to start. Runtime removal needs
a separate two-phase infrastructure change: detach/deploy and verify every
active task first, then remove SSM only when no remaining task references it.
Secret rotation also requires an explicit task rollout; changing an SSM value
alone does not refresh secrets already loaded by running tasks.
Disabling receipt collection does not recall or stop outbound mail. Sender
disable and pending-send reconciliation are a separate property operation.
