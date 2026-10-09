# Taking a wave of hotels off the legacy booking engine (VAY-1362)

`infra/legacy_wave_cutover.tf` adds two lists of ALB listener rules on
`vayada-backend-alb` (HTTPS listener). Both are empty by default, so merging
the code adds no rule and the plan shows no change. A wave sets them with
Flamur's go.

- **Block (fixed 410).** On `pms-api.vayada.com`, every path under
  `/api/hotels/<slug>/bookings*` for the wave's legacy booking slugs answers
  `410` with `{"detail": "Bookings for this hotel have moved to the new Vayada booking system."}`.
  That covers create, quote, confirm-authorization, withdraw, cancel,
  cancel-preview, lookup, status and the change-request routes
  (`apps/pms-api/app/routers/bookings.py:64-225`).
- **Redirect (302).** Each listed legacy booking-engine host, either
  `<slug>.booking.vayada.com` or a custom domain, redirects to the hotel's v2
  host `<slug>.next-booking.vayada.com`, keeping path and query. The legacy
  confirmation link `https://<slug>.booking.vayada.com/booking/<reference>?email=…`
  (`email_service.py:35-48`) therefore lands on the v2 `/booking/<reference>`
  page. The redirect is temporary (302), so browsers do not keep it after a
  rollback.

## Wave 1 file (verify before go-day)

`infra/legacy_wave_cutover.auto.tfvars.json`:

```json
{
  "legacy_booking_blocked_slugs": [
    "aetherhilltopvillas-a0ae2226",
    "dolcemareresort-9448d754",
    "haighahouse-aa2e01a9"
  ],
  "legacy_booking_redirects": {
    "aetherhilltopvillas-a0ae2226.booking.vayada.com": "aetherhilltopvillas-a0ae2226.next-booking.vayada.com",
    "dolcemareresort-9448d754.booking.vayada.com": "dolcemareresort-9448d754.next-booking.vayada.com",
    "haighahouse-aa2e01a9.booking.vayada.com": "haighahouse-aa2e01a9.next-booking.vayada.com"
  }
}
```

Before go-day, check each value:

1. **The slug is the hotel's legacy booking slug (`booking_hotels.slug`).** The
   legacy storefront takes it from its subdomain, or resolves a custom domain to
   it through booking-api `/api/resolve-domain`, and sends it in the pms-api
   path. pms-api resolves it against PMS `hotels.slug`, which register-hotel
   mirrors from `booking_hotels`. Haigha's PMS `hotels.slug`
   `haighahouse-aa2e01a9` was read on 2026-10-08. The Aether B and Dolcemare
   slugs come from the inventory and have not been read yet.
2. **The v2 host serves the hotel.** The migration keeps the legacy booking slug
   as the v2 canonical slug. Check it after the hotel's migration:
   `curl -s -o /dev/null -w '%{http_code}\n' https://<slug>.next-booking.vayada.com/`
   must print 200.
3. **Custom domains.** Add each one (`booking_hotels.custom_domain`, for example
   Aether B's) to `legacy_booking_redirects`; see below.

## Go-day (with Flamur's go for the wave)

1. Open a PR that adds the wave file. Its Terraform plan must show only
   `aws_lb_listener_rule.legacy_booking_block["0"]` (one rule per three slugs)
   and one `aws_lb_listener_rule.legacy_booking_redirect["<host>"]` per host
   being created, and `0 to change, 0 to destroy`. Stop on anything else.
2. Merge it. Merging is the apply: `tf-apply.yml` starts at once on
   `platform-mutations-v2`, with no reviewer step.
3. Verify:
   - `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://pms-api.vayada.com/api/hotels/<slug>/bookings/quote`
     prints `410` for each wave slug. Another hotel's slug still reaches pms-api.
   - `curl -sI https://<slug>.booking.vayada.com/booking/TEST?email=a%40b.c`
     prints `302` with
     `location: https://<slug>.next-booking.vayada.com:443/booking/TEST?email=a%40b.c`.
   - Each custom domain likewise answers `302` to its v2 host.

**Rollback:** open a PR that deletes the wave file and merge it. The plan shows
the same rules being destroyed. A later wave adds its hotels to the same file;
the rules then move to new keys or priorities, which the PR plan shows.

## Custom domains

Custom domains are Cloudflare for SaaS custom hostnames in the `vayada.com`
zone (booking-api `cloudflare_service.py`). Customers point them by CNAME to
`custom.booking.vayada.com`, and the ALB's catch-all rule (priority 99) forwards
them to the legacy storefront. Cloudflare passes the custom hostname as the
`Host` header, so a host rule in `legacy_booking_redirects` should catch it.
Verify that with the `curl -sI` check above. If the domain does not redirect,
do it in Cloudflare by hand, since custom hostnames are outside Terraform:

1. Cloudflare dashboard, `vayada.com` zone, **Rules → Redirect Rules → Create
   rule**, named `VAY-1362 wave <n>: <domain>`.
2. When: custom filter expression `(http.host eq "<domain>")`.
3. Then: dynamic redirect to
   `concat("https://<slug>.next-booking.vayada.com", http.request.uri.path)`,
   status `302`, with **Preserve query string** on.
4. Deploy, then run the `curl -sI` check. Rollback is deleting the rule.

Serving a custom domain from v2 directly (`hotel_catalog.property_domains`) is
a later, separate step.

## What these rules do not stop

- **Cancel and withdraw by booking id.** pms-api's withdraw, cancel-preview,
  cancel and confirm-authorization routes ignore the path slug. They check only
  the booking id (plus the guest email, except confirm-authorization)
  (`booking_service.py:1624-1660, 2373-2381, 2590-2625`). A crafted call that
  uses another hotel's slug still reaches a migrated booking. Cancel refunds for
  real, for example on Aether B's own Stripe account. Only the legacy write
  freeze (runbook F1) closes that path. These rules stop the storefront's own
  calls, and the redirect keeps guests off the legacy storefront.
- **Browsers see a CORS error, not the 410 text.** The storefront calls pms-api
  cross-origin, and the fixed response carries no CORS headers. The request
  still fails, and guests normally never get there because of the redirect.

Tests: `node --test scripts/test-legacy-wave-cutover.mjs` evaluates the inputs
offline, including the wave file above, and checks that the reserved
priorities never collide with the other listener rules.
