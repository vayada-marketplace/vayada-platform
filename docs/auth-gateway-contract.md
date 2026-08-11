# Auth gateway deployment contract

Next.js frontends that proxy authentication through their own origin depend on
server-only runtime values that are owned by this repository. The authoritative
service, origin, and surface map is [`infra/auth-gateways.json`](../infra/auth-gateways.json).
Terraform turns each entry into `AUTH_PUBLIC_ORIGIN` and
`AUTH_GATEWAY_UPSTREAM_ORIGIN`; do not duplicate those variables in an
individual ECS service environment.

The same map supplies the TypeScript API's per-surface callback origins
(`AUTH_PLATFORM_ADMIN_ORIGIN`, `AUTH_BOOKING_ADMIN_ORIGIN`,
`AUTH_PMS_WEB_ORIGIN`, `AUTH_AFFILIATE_DASHBOARD_ORIGIN`, and
`AUTH_MARKETPLACE_WEB_ORIGIN`), the common compatibility callback origin, and
the gateway portion of `AUTH_ALLOWED_ORIGINS`. The guest Booking origin is the
only additional frontend allowlist entry. This keeps the API startup contract
aligned with the frontend gateways and prevents a new API image from
crash-looping on missing or stale callback origins.

## Current gateways

| Platform service | App auth surface | Public origin | Upstream origin |
| --- | --- | --- | --- |
| `next-affiliate-dashboard` | `affiliate-dashboard` | `https://next-affiliate.vayada.com` | `https://next-api.vayada.com` |
| `next-booking-admin` | `booking-admin` | `https://next-booking-admin.vayada.com` | `https://next-api.vayada.com` |
| `next-marketplace-admin` | `platform-admin` | `https://next-admin.vayada.com` | `https://next-api.vayada.com` |
| `next-marketplace-frontend` | `marketplace-web` | `https://next-marketplace.vayada.com` | `https://next-api.vayada.com` |
| `next-pms-frontend` | `pms-web` | `https://next-pms.vayada.com` | `https://next-api.vayada.com` |

Each service is also listed in `auth_gateway_enabled_services` in `infra/ecs.tf`.
CI rejects malformed or duplicate contracts and service-local declarations of the
two reserved gateway environment variables. Terraform checks that the
enabled-service inventory and JSON contracts match exactly, that origins are
approved pathless Vayada HTTPS URLs, that upstream origins are allowlisted, and
that public origins and surfaces are unique. Pull-request Terraform validation
and plan are required before merge.

## Cross-repository release rule

An app change that adds or changes an own-origin auth gateway is incomplete
until its platform counterpart is reviewed. The app PR must name the surface,
public origin, upstream origin, and related platform ticket/PR. The platform
change must:

1. add the ECS service to `auth_gateway_enabled_services`;
2. add or update its entry in `infra/auth-gateways.json`;
3. pass Terraform validation and the production plan; and
4. merge and apply before the corresponding app image is deployed.

After Terraform applies, `scripts/roll-forward-auth-gateways.sh` compares every
gateway service with the latest generated task definition. It preserves the
currently deployed image, rolls forward only drifted services, waits for ECS
stability, and runs the unauthenticated smoke probe. A failed rollout or probe
restores the service's previous task definition.

Do not rely on app tests that mock server environment variables as deployment
evidence. Terraform owns the production values, while the app repository owns
the route and surface name; both sides of the contract must change together.

## Deployment smoke

After ECS reaches service stability, `.github/workflows/deploy.yml` reads the
deployed service's contract and requests:

```text
<public_origin>/auth/session?surface=<surface>
```

HTTP 401 with JSON error `missing_session` is the healthy unauthenticated
result: the public proxy reached the upstream auth service. A gateway 5xx,
unexpected status, malformed response, or other error fails the deployment
workflow visibly.

This probe intentionally needs no production user credentials. Authenticated
product QA remains a separate release check when a ticket changes signed-in
behavior.
