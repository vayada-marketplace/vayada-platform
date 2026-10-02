# Property setup credential bootstrap contract (VAY-1092 / VAY-965)

Design for the missing operational property bootstrap. This document provisions
nothing and does not authorize automatic provisioning during a product request.
Reuse the reviewed creation bootstrap runner when its release slice is composed;
keep its organization/reader purposes and identities separate. App reference:
Save/credential preflight PR #2791, source
`da0f57296325ce5149b9ff499bdef1c80f1b8a22`; a moved head needs renewed review.

## Inputs and authority

Accept an explicitly approved canonical property UUID, organization UUID, current
actor UUID and one fixed operation: `launch_settings`, `currency`,
`currency_ready` or `feature_hub`. Obtain the property UUID from committed creation
or the existing setup status; never create a second property to repair credentials.
Independently check the current database property/organization ownership and the
operation's actor authorization. `launch_settings` uses setup permission and must
not require PMS access from a Marketplace-only owner. Do not trust client-supplied
login names, SQL, grant lists, secret references or an earlier authorization check.

The operational runner alone receives its reviewed administrative credential and
secret write permission. Neither the public API nor either private command service
receives them. Its exact image, database endpoint, CA, grants and attached IAM are
release inputs; no broad ordinary API grant is an alternative. This initial
operational bootstrap requires the property command service to have zero desired,
running and pending tasks, with caller admission blocked, through proof and
publication. Do not run it alongside admitted commands; later automated or online
provisioning needs its own reviewed readiness/admission contract.

## One fresh identity per property and purpose

1. Lock the canonical ownership/assignment through database staging. Reject any
   existing assignment for this property/purpose, including inactive or uncertain
   attempts. Inspection or a separately reviewed rotation is required; do not
   adopt, retarget, repair or overwrite an existing role/secret on retry.
2. Generate a fresh `vayada_next_hotel_setup_property_*` role. Record its exact OID;
   start with NOLOGIN, no password, no ownership and safe native role attributes.
   Grant only the non-settable property scope membership and the selected compiled
   column inventory. Only `launch_settings` receives its reviewed contact DELETE.
   Reject insufficient-grant warnings and roll back every grant on staging failure.
   Commit verified NOLOGIN staging and grants before activating the recorded identity.
3. Set a random password and activate only this exact newly staged identity. Follow
   the existing reader activation's identity/verifier checks and failure cleanup;
   a changed OID/verifier or ambiguous outcome requires inspection. In the guarded
   activation transaction, recheck current authority and insert the exact
   `(database_login,property_id,organization_id,operation_class,active=true)`
   assignment. Preserve the one-active-assignment-per-property/operation constraint
   and commit before opening the separate native proof connection; it must see
   the committed assignment. Any ambiguous activation/commit blocks publication.
4. Verify native TLS authentication, exact columns, memberships, owners, policies,
   functions, triggers and assigned purpose using the final image's
   `hotelSetupPropertyPreflight` implementation. It invokes no business command.
   Both image slots must pass on the same final schema, including migration 0462.
   Keep the new credential unavailable to the command service until proof passes;
   any staged assignment with no published credential fails closed.
5. After successful proof and current ownership recheck, publish only the exact
   two-field `{username,password}` credential under the fixed property prefix.
   Reread the immutable published version. Existing versions, mismatched readback
   or uncertain publication fail release; do not retry publication blindly.
   Native secret publication is distinct from reader/internal-token publication.
6. On failure, disable only this attempt's verified role identity and remove its
   assignment or mark it unusable; terminate its sessions. Never clean up another
   attempt's role or overwrite its secret. Ambiguous commit/publication/cleanup
   emits a sanitized inspection-required receipt and blocks release.

Sanitized evidence records source/image/schema, property/purpose, role OID,
assignment and secret version references, native proof and cleanup status. Never
include passwords, tokens, database URLs or PostgreSQL diagnostic payloads.

## Full onboarding acceptance and retries

Creation returns and preserves the canonical UUID before property bootstrap.
If creation commits but its response is lost, recover that UUID from setup status
before retrying; an ambiguous outcome must not issue a blind new creation.
Until `launch_settings` is ready, Save returns a recoverable setup-unavailable
result, retains form data and retries the same property; no broad credential
fallback. The Save owner owns this caller/adapter behavior. Provisioning alone
neither saves settings nor enables Financials.

Native PMS first-currency completion separately requires `currency_ready`.
Its existing single transaction owns currency, seven categories and initial
Financials activation; later currency and Feature Hub use their distinct purposes.
A successful Save or secret publication does not prove first-currency readiness.

Before release, owned PG16/17 tests must prove cross-property/purpose and revoked
ownership denials; extra/missing/grant-option ACL rejection; failed grants and
native authentication; lost commit/publication outcomes; same-identity cleanup;
existing-role/assignment/secret rejection. Full flow must prove creation, optional
logo, assignment readiness, Save/status reload, same-property retry and native
first currency for both reported accounts. Existing Owner-off and billing/global
restrictions must remain enforced. Live provisioning and release require separate
explicit authority after these reviewable checks; no automatic provisioner is
implemented or approved by this design.
