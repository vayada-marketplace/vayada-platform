#!/usr/bin/env bash
set -euo pipefail

version="${1:?usage: test-target-database-identity-runtime-grant.sh <16|17>}"
[[ "${version}" == "16" || "${version}" == "17" ]] || exit 2
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
suffix="${RANDOM}${RANDOM}"
network="vayada-identity-grant-${suffix}"
database="vayada-identity-grant-pg-${suffix}"
modules="vayada-identity-grant-node-${suffix}"
work="$(mktemp -d)"
cleanup() {
  docker rm -f "${database}" >/dev/null 2>&1 || true
  docker network rm "${network}" >/dev/null 2>&1 || true
  docker volume rm "${modules}" >/dev/null 2>&1 || true
  rm -r -- "${work}"
}
trap cleanup EXIT

docker network create "${network}" >/dev/null
docker volume create "${modules}" >/dev/null
docker run --detach --rm --name "${database}" --network "${network}" \
  --network-alias vayada-identity-grant-db --env POSTGRES_PASSWORD=postgres \
  "ghcr.io/vayada-marketplace/ci-postgres:${version}" >/dev/null
for _ in {1..30}; do
  docker exec "${database}" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec "${database}" pg_isready -h 127.0.0.1 -U postgres >/dev/null

docker exec -i "${database}" psql -U postgres -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
CREATE ROLE legacy_owner LOGIN PASSWORD 'owner';
REVOKE CREATE, TEMPORARY ON DATABASE postgres FROM PUBLIC;
CREATE DATABASE identity_sibling;
REVOKE CONNECT, CREATE, TEMPORARY ON DATABASE identity_sibling FROM PUBLIC;
CREATE SCHEMA identity AUTHORIZATION legacy_owner;
CREATE SCHEMA platform AUTHORIZATION legacy_owner;
CREATE SCHEMA booking AUTHORIZATION legacy_owner;
CREATE SCHEMA hotel_catalog AUTHORIZATION legacy_owner;
SET ROLE legacy_owner;
DO $fixture$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY[
    'identity.users', 'identity.external_identities', 'identity.organizations',
    'identity.organization_memberships', 'identity.organization_resource_links',
    'identity.role_permission_grants', 'identity.permission_catalog',
    'identity.product_entitlements', 'identity.auth_reconciliation_events',
    'identity.auth_session_handoffs', 'identity.staff_invitations',
    'identity.staff_invitation_property_assignments',
    'identity.membership_property_assignments', 'identity.membership_delegations',
    'identity.organization_roles', 'identity.account_admin_guards',
    'identity.account_admin_transfer_proofs', 'identity.cookie_consents',
    'identity.user_consent_status', 'identity.consent_history',
    'identity.gdpr_requests'
  ] LOOP
    EXECUTE format('CREATE TABLE %s (id integer PRIMARY KEY, provider text)', name);
  END LOOP;
END $fixture$;
CREATE TABLE platform.external_webhook_events (id integer PRIMARY KEY, provider text NOT NULL, delivery_status text);
CREATE TABLE platform.idempotency_keys (id integer PRIMARY KEY, operation_scope text NOT NULL, status text);
CREATE TABLE platform.jobs (id integer PRIMARY KEY, queue_name text NOT NULL, job_type text NOT NULL,
  resource_product text NOT NULL, resource_type text, status text);
CREATE TABLE platform.product_audit_events (id integer PRIMARY KEY, product text NOT NULL);
CREATE TABLE platform.dead_letter_events (id integer PRIMARY KEY, source_kind text NOT NULL,
  resource_product text NOT NULL, resource_type text NOT NULL,
  webhook_event_id integer REFERENCES platform.external_webhook_events(id));
CREATE TABLE platform.legacy_owner_bootstrap_receipts (command_id uuid PRIMARY KEY,
  owner_user_ids uuid[] NOT NULL, payload_sha256 text);
CREATE TABLE booking.guest_bookings (id integer PRIMARY KEY);
CREATE TABLE hotel_catalog.properties (id integer PRIMARY KEY);
CREATE VIEW booking.pricing_runtime_effective_property_scopes
  WITH (security_barrier = true) AS SELECT id AS property_id FROM booking.guest_bookings WHERE false;
REVOKE ALL ON booking.pricing_runtime_effective_property_scopes FROM PUBLIC;
GRANT SELECT ON booking.pricing_runtime_effective_property_scopes TO PUBLIC;
ALTER TABLE platform.external_webhook_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY identity_runtime_scope ON platform.external_webhook_events TO PUBLIC
  USING (current_user <> 'vayada_next_identity_runtime' OR provider = 'workos');
ALTER TABLE platform.idempotency_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY identity_runtime_scope ON platform.idempotency_keys TO PUBLIC
  USING (current_user <> 'vayada_next_identity_runtime' OR operation_scope = 'identity');
ALTER TABLE platform.jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY identity_runtime_scope ON platform.jobs TO PUBLIC
  USING (current_user <> 'vayada_next_identity_runtime'
    OR (queue_name = 'identity.webhooks' AND job_type = 'identity.workos_webhook.reconcile' AND resource_product = 'identity')
    OR (queue_name = 'identity-provider' AND job_type = 'workos.organization-membership.delete' AND resource_product = 'identity')
    OR (queue_name = 'identity-admin-transfer' AND job_type = 'identity.membership_role.reconcile' AND resource_product = 'identity'));
CREATE POLICY identity_runtime_pms_inbox_enqueue ON platform.jobs
  FOR INSERT TO PUBLIC WITH CHECK
  (current_user = 'vayada_next_identity_runtime' AND queue_name = 'pms-inbox'
    AND job_type = 'pms.inbox.assignment.reconcile' AND resource_product = 'pms'
    AND resource_type = 'inbox_assignment');
ALTER TABLE platform.product_audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY identity_runtime_scope ON platform.product_audit_events TO PUBLIC
  USING (current_user <> 'vayada_next_identity_runtime' OR product = 'identity');
ALTER TABLE platform.dead_letter_events ENABLE ROW LEVEL SECURITY;
-- App migration 0414 (VAY-2045) form: the WorkOS receipt lookup lives in an invoker helper.
CREATE FUNCTION platform.identity_runtime_dead_letter_webhook_scope(webhook_id integer)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM platform.external_webhook_events receipt
    WHERE receipt.id = webhook_id AND receipt.provider = 'workos'
  );
END;
$$;
CREATE POLICY identity_runtime_scope ON platform.dead_letter_events TO PUBLIC USING (
  current_user <> 'vayada_next_identity_runtime'
  OR (source_kind = 'webhook' AND resource_product = 'identity'
      AND resource_type = 'workos_webhook'
      AND platform.identity_runtime_dead_letter_webhook_scope(webhook_event_id))
);
RESET ROLE;
SQL

docker run --rm --volume "${modules}:/work" --workdir /work ghcr.io/vayada-marketplace/ci-node:22-bookworm \
  sh -c 'npm init -y >/dev/null && npm install --silent --no-audit --no-fund pg@8.16.3'
cp "${root}/scripts/grant-target-database-identity-runtime.mjs" "${work}/grant.mjs"
cp "${root}/scripts/provision-target-database-identity-runtime.mjs" "${work}/provision.mjs"
run_provision() {
  local force_failure="${1:-0}"
  local force_marker_mismatch="${2:-0}"
  local provision_scope="${3:-}"
  docker run --rm --network "${network}" --volume "${modules}:/work" \
    --volume "${work}/provision.mjs:/work/provision.mjs:ro" --workdir /work \
    --env "TARGET_DATABASE_ADMIN_URL=postgresql://postgres:postgres@vayada-identity-grant-db:5432/postgres" \
    --env "IDENTITY_DATABASE_URL=postgresql://vayada_next_identity_runtime:identity@vayada-identity-grant-db:5432/postgres" \
    --env VAYADA_IDENTITY_PROVISION_LOCAL_FIXTURE=1 \
    --env "VAYADA_DB_PROVISION_SCOPE=${provision_scope}" \
    --env "FINANCE_EXPENSE_WORKER_DATABASE_URL=postgresql://vayada_next_finance_expense_worker:finance@vayada-identity-grant-db:5432/postgres" \
    --env "FINANCE_EXPORT_WORKER_DATABASE_URL=postgresql://vayada_next_finance_export_worker:export@vayada-identity-grant-db:5432/postgres" \
    --env "VAYADA_IDENTITY_PROVISION_FORCE_LOGIN_FAILURE=${force_failure}" \
    --env "VAYADA_IDENTITY_PROVISION_FORCE_MARKER_MISMATCH=${force_marker_mismatch}" \
    ghcr.io/vayada-marketplace/ci-node:22-bookworm node provision.mjs
}
if output="$(run_provision 2>&1)"; then
  echo 'identity role provision unexpectedly allowed template database access' >&2
  exit 1
fi
grep -F '"code":"identity_provision_cluster_database_acl_unsafe"' <<<"${output}" >/dev/null
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'REVOKE CONNECT, CREATE, TEMPORARY ON DATABASE template1 FROM PUBLIC' >/dev/null
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'GRANT CONNECT ON DATABASE identity_sibling TO PUBLIC' >/dev/null
if output="$(run_provision 2>&1)"; then
  echo 'identity role provision unexpectedly allowed sibling database access' >&2
  exit 1
fi
grep -F '"code":"identity_provision_cluster_database_acl_unsafe"' <<<"${output}" >/dev/null
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'REVOKE CONNECT ON DATABASE identity_sibling FROM PUBLIC' >/dev/null
if output="$(run_provision 1 2>&1)"; then
  echo 'identity role forced login failure unexpectedly passed' >&2
  exit 1
fi
grep -F '"code":"identity_provision_login_unexpected"' <<<"${output}" >/dev/null
docker exec "${database}" psql -U postgres -Atqc \
  "SELECT count(*) FROM pg_roles WHERE rolname = 'vayada_next_identity_runtime'" | grep -Fx 0 >/dev/null
if output="$(run_provision 0 1 2>&1)"; then
  echo 'identity role mismatched cleanup marker unexpectedly passed' >&2
  exit 1
fi
grep -F '"code":"identity_provision_cleanup_failed"' <<<"${output}" >/dev/null
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'REVOKE CONNECT ON DATABASE postgres FROM vayada_next_identity_runtime; DROP ROLE vayada_next_identity_runtime' >/dev/null
# The same protected provisioner creates a separate Finance login, never an alias.
run_provision 0 0 finance_expense | grep -F '"role":"vayada_next_finance_expense_worker"' >/dev/null
docker exec "${database}" psql -U postgres -Atqc \
  "SELECT rolcanlogin AND NOT (rolsuper OR rolinherit OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolreplication) FROM pg_roles WHERE rolname='vayada_next_finance_expense_worker'" | grep -Fx t >/dev/null
run_provision 0 0 finance_export | grep -F '"role":"vayada_next_finance_export_worker"' >/dev/null
docker exec "${database}" psql -U postgres -Atqc \
  "SELECT rolcanlogin AND NOT (rolsuper OR rolinherit OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolreplication) FROM pg_roles WHERE rolname='vayada_next_finance_export_worker'" | grep -Fx t >/dev/null
run_provision | grep -F '"status":"PASS"' >/dev/null
if output="$(run_provision 2>&1)"; then
  echo 'identity role provision unexpectedly allowed a duplicate' >&2
  exit 1
fi
grep -F '"code":"identity_provision_role_already_exists"' <<<"${output}" >/dev/null
run_grant() {
  local user="${1:-legacy_owner}"
  local password="${2:-owner}"
  local fixture="${3:-1}"
  docker run --rm --network "${network}" --volume "${modules}:/work" \
    --volume "${work}/grant.mjs:/work/grant.mjs:ro" --workdir /work \
    --env "TARGET_DATABASE_MIGRATION_URL=postgresql://${user}:${password}@vayada-identity-grant-db:5432/postgres" \
    --env "VAYADA_IDENTITY_GRANT_LOCAL_FIXTURE=${fixture}" \
    ghcr.io/vayada-marketplace/ci-node:22-bookworm node grant.mjs
}
expect_grant_failure() {
  local code="$1"
  local output
  if output="$(run_grant 2>&1)"; then
    echo "grant unexpectedly passed: ${code}" >&2
    exit 1
  fi
  grep -F "\"code\":\"${code}\"" <<<"${output}" >/dev/null
}

if output="$(run_grant legacy_owner owner 0 2>&1)"; then
  echo "non-RDS grant unexpectedly passed" >&2
  exit 1
fi
grep -F '"code":"unexpected_database_host"' <<<"${output}" >/dev/null
if output="$(run_grant vayada_next_identity_runtime identity 2>&1)"; then
  echo "non-owner grant unexpectedly passed" >&2
  exit 1
fi
if output="$(run_grant postgres postgres 2>&1)"; then
  echo "non-owner grant unexpectedly passed" >&2
  exit 1
fi
grep -F '"code":"identity_grant_table_owner_required"' <<<"${output}" >/dev/null

docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE identity_delegate; GRANT vayada_next_identity_runtime TO identity_delegate' >/dev/null
expect_grant_failure identity_role_inherits_membership
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'REVOKE vayada_next_identity_runtime FROM identity_delegate; CREATE SCHEMA role_owned AUTHORIZATION vayada_next_identity_runtime' >/dev/null
expect_grant_failure identity_role_owns_objects
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'DROP SCHEMA role_owned' >/dev/null

docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'GRANT SELECT ON identity.users TO vayada_next_identity_runtime WITH GRANT OPTION' >/dev/null
expect_grant_failure identity_role_existing_privilege_too_broad
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'REVOKE SELECT ON identity.users FROM vayada_next_identity_runtime; GRANT SELECT (id) ON identity.users TO vayada_next_identity_runtime WITH GRANT OPTION' >/dev/null
expect_grant_failure identity_role_existing_column_privilege_too_broad
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'REVOKE SELECT (id) ON identity.users FROM vayada_next_identity_runtime' >/dev/null

docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'ALTER TABLE platform.jobs DISABLE ROW LEVEL SECURITY' >/dev/null
expect_grant_failure identity_shared_rls_missing
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'ALTER TABLE platform.jobs ENABLE ROW LEVEL SECURITY' >/dev/null
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'ALTER POLICY identity_runtime_pms_inbox_enqueue ON platform.jobs WITH CHECK (true)' >/dev/null
expect_grant_failure identity_shared_rls_policy_unexpected
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c "ALTER POLICY identity_runtime_pms_inbox_enqueue ON platform.jobs WITH CHECK (current_user = 'vayada_next_identity_runtime' AND queue_name = 'pms-inbox' AND job_type = 'pms.inbox.assignment.reconcile' AND resource_product = 'pms' AND resource_type = 'inbox_assignment')" >/dev/null
# VAY-2478: only the 0414 dead-letter scope passes; the pre-0414 inline form and extra policies fail.
dead_letter_scope="current_user <> 'vayada_next_identity_runtime' OR (source_kind = 'webhook'
  AND resource_product = 'identity' AND resource_type = 'workos_webhook'"
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 -c "ALTER POLICY identity_runtime_scope
  ON platform.dead_letter_events USING (${dead_letter_scope} AND EXISTS (SELECT 1 FROM
  platform.external_webhook_events AS receipt WHERE receipt.id = webhook_event_id AND receipt.provider = 'workos')))" >/dev/null
expect_grant_failure identity_shared_rls_policy_unexpected
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 -c "ALTER POLICY identity_runtime_scope
  ON platform.dead_letter_events USING (${dead_letter_scope}))" >/dev/null
expect_grant_failure identity_shared_rls_policy_unexpected
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 -c "ALTER POLICY identity_runtime_scope
  ON platform.dead_letter_events USING (${dead_letter_scope}
  AND platform.identity_runtime_dead_letter_webhook_scope(webhook_event_id)))" >/dev/null
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE POLICY dead_letter_extra ON platform.dead_letter_events TO PUBLIC USING (true)' >/dev/null
expect_grant_failure identity_shared_rls_policy_unexpected
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'DROP POLICY dead_letter_extra ON platform.dead_letter_events' >/dev/null
# The helper's body is not compared; a definer helper would bypass the receipts' row scope.
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 -c \
  'ALTER FUNCTION platform.identity_runtime_dead_letter_webhook_scope(integer) SECURITY DEFINER' >/dev/null
expect_grant_failure identity_role_callable_definer
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 -c \
  'ALTER FUNCTION platform.identity_runtime_dead_letter_webhook_scope(integer) SECURITY INVOKER' >/dev/null

docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'ALTER VIEW booking.pricing_runtime_effective_property_scopes SET (security_barrier=false)' >/dev/null
expect_grant_failure identity_public_read_contract_unsafe
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'ALTER VIEW booking.pricing_runtime_effective_property_scopes SET (security_barrier=true); GRANT SELECT ON booking.pricing_runtime_effective_property_scopes TO vayada_next_identity_runtime' >/dev/null
expect_grant_failure identity_public_read_contract_unsafe
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'REVOKE SELECT ON booking.pricing_runtime_effective_property_scopes FROM vayada_next_identity_runtime' >/dev/null
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'GRANT SELECT ON booking.pricing_runtime_effective_property_scopes TO vayada_next_identity_runtime WITH GRANT OPTION' >/dev/null
expect_grant_failure identity_public_read_contract_unsafe
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'REVOKE SELECT ON booking.pricing_runtime_effective_property_scopes FROM vayada_next_identity_runtime' >/dev/null
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'GRANT SELECT (property_id) ON booking.pricing_runtime_effective_property_scopes TO vayada_next_identity_runtime' >/dev/null
expect_grant_failure identity_public_read_contract_unsafe
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'REVOKE SELECT (property_id) ON booking.pricing_runtime_effective_property_scopes FROM vayada_next_identity_runtime' >/dev/null

docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c "CREATE POLICY finance_expense_worker_scope ON platform.jobs AS RESTRICTIVE TO PUBLIC USING (current_user <> 'vayada_next_finance_expense_worker')" >/dev/null
run_grant | grep -F '"status":"PASS"' >/dev/null
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c "INSERT INTO identity.staff_invitations (id) VALUES (1)" >/dev/null
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c "INSERT INTO platform.external_webhook_events (id, provider) VALUES (1, 'workos'), (2, 'stripe')" >/dev/null
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'INSERT INTO booking.guest_bookings (id) VALUES (1)' >/dev/null
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'INSERT INTO hotel_catalog.properties (id) VALUES (1)' >/dev/null

docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
SET ROLE vayada_next_identity_runtime;
UPDATE identity.staff_invitations SET provider = 'workos' WHERE id = 1;
SELECT id FROM identity.staff_invitations WHERE id = 1 FOR UPDATE;
UPDATE platform.external_webhook_events SET provider = 'workos' WHERE id = 1;
SELECT id FROM hotel_catalog.properties WHERE id = 1;
SELECT count(*) FROM booking.pricing_runtime_effective_property_scopes;
INSERT INTO platform.jobs (id, queue_name, job_type, resource_product, resource_type)
  VALUES (1, 'pms-inbox', 'pms.inbox.assignment.reconcile', 'pms', 'inbox_assignment');
SQL
if docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'SET ROLE vayada_next_identity_runtime; DELETE FROM identity.staff_invitations WHERE id = 1' >/dev/null 2>&1; then
  echo 'identity invitation DELETE unexpectedly allowed' >&2
  exit 1
fi
if docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'SET ROLE vayada_next_identity_runtime; UPDATE booking.guest_bookings SET id = 2 WHERE id = 1' >/dev/null 2>&1; then
  echo 'booking write unexpectedly allowed' >&2
  exit 1
fi
if docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'SET ROLE vayada_next_identity_runtime; UPDATE hotel_catalog.properties SET id = 2 WHERE id = 1' >/dev/null 2>&1; then
  echo 'hotel catalog write unexpectedly allowed' >&2
  exit 1
fi
if docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c "SET ROLE vayada_next_identity_runtime; INSERT INTO platform.external_webhook_events (id, provider) VALUES (3, 'stripe')" >/dev/null 2>&1; then
  echo 'Stripe webhook insert unexpectedly allowed' >&2
  exit 1
fi
if [[ "$(docker exec "${database}" psql -U postgres -At \
  -c 'SET ROLE vayada_next_identity_runtime; SELECT count(*) FROM platform.jobs')" != *$'\n0' ]]; then
  echo 'PMS inbox job visible to identity role after enqueue' >&2
  exit 1
fi
if [[ "$(docker exec "${database}" psql -U postgres -At \
  -c "SET ROLE vayada_next_identity_runtime; UPDATE platform.jobs SET status='failed' WHERE id=1 RETURNING id")" != *$'\nUPDATE 0' ]]; then
  echo 'PMS inbox job writable by identity role after enqueue' >&2
  exit 1
fi
if [[ "$(docker exec "${database}" psql -U postgres -At \
  -c 'SET ROLE vayada_next_identity_runtime; SELECT count(*) FROM platform.external_webhook_events')" != *$'\n1' ]]; then
  echo 'non-WorkOS webhook row visible' >&2
  exit 1
fi
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 -c "INSERT INTO platform.dead_letter_events
  VALUES (1, 'webhook', 'identity', 'workos_webhook', 1), (2, 'webhook', 'identity', 'workos_webhook', 2)" >/dev/null
if [[ "$(docker exec "${database}" psql -U postgres -At \
  -c 'SET ROLE vayada_next_identity_runtime; SELECT id FROM platform.dead_letter_events')" != $'SET\n1' ]]; then
  echo 'dead letter outside the WorkOS receipt scope visible' >&2
  exit 1
fi

# VAY-2478: the legacy-owner signup guard runs on this login. It reads owner_user_ids only.
receipts=platform.legacy_owner_bootstrap_receipts
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 -c "INSERT INTO ${receipts} \
  VALUES ('00000000-0000-4000-8000-000000000001', '{00000000-0000-4000-8000-0000000000aa}', 'x')" >/dev/null
run_guard() {
  # The guard's query verbatim (apps/api/src/platform/legacyOwnerSignupGuard.ts), logged in as the role.
  docker run --rm --network "${network}" --volume "${modules}:/work" --workdir /work \
    --env "IDENTITY_DATABASE_URL=postgresql://vayada_next_identity_runtime:identity@vayada-identity-grant-db:5432/postgres" \
    --env "GUARD_USER_ID=$1" ghcr.io/vayada-marketplace/ci-node:22-bookworm node --input-type=module --eval '
      import pg from "pg";
      const client = new pg.Client(process.env.IDENTITY_DATABASE_URL);
      await client.connect();
      const result = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM platform.legacy_owner_bootstrap_receipts
           WHERE $1::uuid = ANY(owner_user_ids)
         ) AS protected`,
        [process.env.GUARD_USER_ID],
      );
      console.log(result.rows[0].protected);
      await client.end();'
}
[[ "$(run_guard 00000000-0000-4000-8000-0000000000aa)" == true ]] || { echo 'guard missed a receipt owner' >&2; exit 1; }
[[ "$(run_guard 00000000-0000-4000-8000-0000000000bb)" == false ]] || { echo 'guard held a non-owner' >&2; exit 1; }
for statement in "SELECT command_id FROM ${receipts}" "SELECT * FROM ${receipts}" \
  "INSERT INTO ${receipts} (command_id, owner_user_ids) VALUES (gen_random_uuid(), '{}')" \
  "UPDATE ${receipts} SET owner_user_ids = owner_user_ids" "DELETE FROM ${receipts}" "TRUNCATE ${receipts}"; do
  if output="$(docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
    -c "SET ROLE vayada_next_identity_runtime; ${statement}" 2>&1)"; then
    echo "receipt statement unexpectedly allowed: ${statement}" >&2
    exit 1
  fi
  grep -F 'permission denied for table legacy_owner_bootstrap_receipts' <<<"${output}" >/dev/null
done
# A re-run with the receipt grant in place passes; any wider receipt access fails it.
run_grant | grep -F '"status":"PASS"' >/dev/null
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c "GRANT SELECT (payload_sha256) ON ${receipts} TO vayada_next_identity_runtime" >/dev/null
expect_grant_failure identity_role_existing_column_privilege_too_broad
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c "REVOKE SELECT (payload_sha256) ON ${receipts} FROM vayada_next_identity_runtime; GRANT INSERT (owner_user_ids) ON ${receipts} TO vayada_next_identity_runtime" >/dev/null
expect_grant_failure identity_role_existing_column_privilege_too_broad
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c "REVOKE INSERT (owner_user_ids) ON ${receipts} FROM vayada_next_identity_runtime; GRANT SELECT ON ${receipts} TO vayada_next_identity_runtime" >/dev/null
expect_grant_failure identity_role_existing_privilege_too_broad
# A table-level REVOKE also drops the column grant; the next run restores it.
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c "REVOKE SELECT ON ${receipts} FROM vayada_next_identity_runtime" >/dev/null
run_grant | grep -F '"status":"PASS"' >/dev/null
[[ "$(run_guard 00000000-0000-4000-8000-0000000000aa)" == true ]] || { echo 'receipt grant not restored' >&2; exit 1; }

docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'GRANT UPDATE ON booking.guest_bookings TO vayada_next_identity_runtime' >/dev/null
expect_grant_failure identity_role_existing_privilege_too_broad
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'REVOKE UPDATE ON booking.guest_bookings FROM vayada_next_identity_runtime' >/dev/null
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE VIEW booking.guest_booking_view AS SELECT id FROM booking.guest_bookings; GRANT SELECT ON booking.guest_booking_view TO vayada_next_identity_runtime' >/dev/null
expect_grant_failure identity_role_existing_privilege_too_broad
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'REVOKE SELECT ON booking.guest_booking_view FROM vayada_next_identity_runtime; CREATE SEQUENCE booking.guest_booking_seq; GRANT USAGE ON SEQUENCE booking.guest_booking_seq TO vayada_next_identity_runtime' >/dev/null
expect_grant_failure identity_role_existing_sequence_privilege
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'REVOKE USAGE ON SEQUENCE booking.guest_booking_seq FROM vayada_next_identity_runtime; DROP VIEW booking.guest_booking_view' >/dev/null

# VAY-2079: app migration 0475 dropped the authority-scope view, so it is no longer a public read.
# A view recreated under that name and readable by the role is an unexpected privilege.
docker exec -i "${database}" psql -U postgres -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
SET ROLE legacy_owner;
CREATE VIEW booking.pricing_runtime_effective_authority_scopes
  WITH (security_barrier = true) AS SELECT id AS property_id FROM booking.guest_bookings WHERE false;
REVOKE ALL ON booking.pricing_runtime_effective_authority_scopes FROM PUBLIC;
GRANT SELECT ON booking.pricing_runtime_effective_authority_scopes TO PUBLIC;
SQL
expect_grant_failure identity_role_existing_privilege_too_broad
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'DROP VIEW booking.pricing_runtime_effective_authority_scopes' >/dev/null
run_grant | grep -F '"status":"PASS"' >/dev/null
# A dropped public-read view grants nothing, so the grant passes without it (the remaining
# property-scope view is dropped the same way later).
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'DROP VIEW booking.pricing_runtime_effective_property_scopes' >/dev/null
run_grant | grep -F '"status":"PASS"' >/dev/null
echo "identity runtime grant contract passed (PostgreSQL ${version})"
