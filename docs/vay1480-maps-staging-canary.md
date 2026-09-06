# VAY-1480 test-hotel maps staging

The user authorized connecting Google/publication and exercising the real hotel-to-guest flow on next. The inspected shared target has 229 properties and zero immutable active booking publications; changing its global profile source would remove existing public pages. Use a separate request-only API on the shared next database, with the approved test hotel's paths routed through it. This does not change the global profile contract.

`deploy.yml` supports manual `next-maps-canary` / `next-maps-canary-remove` on this branch, with environment `next` and an immutable next API image tag. The script preserves current API task roles, secret references and network configuration, sets active publication and Google, and disables API background jobs. The image must include `API_BACKGROUND_WORKERS_ENABLED`; baseline workers remain owned by the ordinary API. No production host is routed. Only exact test-hotel base paths and slash descendants on next-api are selected.

The approved Places server credential lives in SecureString `/vayada/prod/next-google-places-server-test` (existing ECS execution-role path); only the canary references it. It is not a browser key. Both rebuilt frontend workflows supply the browser key at build time.

Read-only preflight on 2026-09-06 found all 153 applied migration checksums match the candidate, with only new nearby tables 0154/0155 pending. Historical failed attempts remain untouched. Startup performs ordinary additive migrations; rollback retains those tables/data. Never rewrite an applied ledger. Recheck before launch if another schema release lands.

Initial ALB association uses baseline weight 1/canary weight 0. After ECS rollout and target health succeed, only the five owner rules switch; the sixth guest rule remains on baseline. On initial failure, new rules and service are removed; on update failure the previous task definition is restored. Explicit removal deletes the rules first, then stops/deletes the canary service. Empty target group/task revisions remain as diagnostic infrastructure and can be reused. Baseline API image/configuration is not rolled back or changed by this workflow.

Use the reusable owner, preserve all existing booking/calendar/Inbox data, and make no reservation/payment. Save/reload location and nearby curation, request an actual publication through the supported owner API, inspect the public page with real Google, test Hidden, then restore Approximate and reconfirm the test curation for review. Retain the original profile/curation privately for rollback; the retained fixture is explicitly synthetic. Record source/image digest, publication result and browser evidence; publication failure is not a passing smoke.

Canary deploy/remove share a fixed, cancellation-disabled canary concurrency group. Normal platform mutations retain their existing group. Before execution, verify no conflicting migration allocation or concurrent ALB/Terraform change. Initial deployment activates only owner paths; the guest stays on baseline while its real publication is prepared. A second manual run with activate_guest=true verifies the pinned healthy canary and switches the guest rule after successful publication. This avoids breaking concurrent baseline guest smoke while publication is absent.

The six conditions cover scoped hotel setup, legacy Booking settings/publication, guest slug, canonical Booking configuration, exact PMS pricing/mandatory-charge evidence, and the exact PMS inventory-materialization endpoint. The guest condition alone requires explicit activation.

## Stable frontend previews

`next-maps-frontends` pins separate `vayada-next-maps-guest-service` and `vayada-next-maps-admin-service` to the tested guest976c8519a and admin1241b0330 builds. Only `codex-test-hotel-not-bookable.next-booking.vayada.com` routes to the guest preview. The baseline deployment smoke uses the different `codex-qa-hotel-20260813-1927` tenant. Admin routing additionally requires the non-secret opt-in Cookie `vay1480_preview=1`; authentication still applies. Normal admin sessions and all other guest hosts retain baseline routing.

Each frontend activates after healthy rollout. Failures restore prior rule conditions/actions and task definitions; an initially created failed service/rule is removed. If the second frontend fails, the first successful frontend remains available. `next-maps-frontends-remove` removes these owned routes and services without changing baseline services. This shares the isolated canary concurrency group. Service names retain the existing IAM-permitted `vayada-` prefix; permissions were not broadened.

Real test-hotel publication succeeded on 2026-09-06, operation/content revision `682cf105-6365-46dd-b77d-c0d45e781d29`, using API62d46aae0. Guest routing was then activated through CI run34021596500. The test hotel remains synthetic; no booking, payment or message was created by this validation.
