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
  "postgres:${version}" >/dev/null
for _ in {1..30}; do
  docker exec "${database}" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec "${database}" pg_isready -U postgres >/dev/null

docker exec -i "${database}" psql -U postgres -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
CREATE ROLE legacy_owner LOGIN PASSWORD 'owner';
REVOKE CREATE, TEMPORARY ON DATABASE postgres FROM PUBLIC;
CREATE DATABASE identity_sibling;
REVOKE CONNECT, CREATE, TEMPORARY ON DATABASE identity_sibling FROM PUBLIC;
CREATE SCHEMA identity AUTHORIZATION legacy_owner;
CREATE SCHEMA platform AUTHORIZATION legacy_owner;
CREATE SCHEMA booking AUTHORIZATION legacy_owner;
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
CREATE TABLE booking.guest_bookings (id integer PRIMARY KEY);
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
CREATE POLICY identity_runtime_scope ON platform.dead_letter_events TO PUBLIC
  USING (current_user <> 'vayada_next_identity_runtime'
    OR (source_kind = 'webhook' AND resource_product = 'identity'
      AND resource_type = 'workos_webhook'
      AND EXISTS (SELECT 1 FROM platform.external_webhook_events AS receipt
        WHERE receipt.id = webhook_event_id AND receipt.provider = 'workos')));
RESET ROLE;
SQL

docker run --rm --volume "${modules}:/work" --workdir /work node:22-bookworm \
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
    node:22-bookworm node provision.mjs
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
    node:22-bookworm node grant.mjs
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

docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c "CREATE POLICY finance_expense_worker_scope ON platform.jobs AS RESTRICTIVE TO PUBLIC USING (current_user <> 'vayada_next_finance_expense_worker')" >/dev/null
run_grant | grep -F '"status":"PASS"' >/dev/null
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c "INSERT INTO identity.staff_invitations (id) VALUES (1)" >/dev/null
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c "INSERT INTO platform.external_webhook_events (id, provider) VALUES (1, 'workos'), (2, 'stripe')" >/dev/null
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'INSERT INTO booking.guest_bookings (id) VALUES (1)' >/dev/null

docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
SET ROLE vayada_next_identity_runtime;
UPDATE identity.staff_invitations SET provider = 'workos' WHERE id = 1;
SELECT id FROM identity.staff_invitations WHERE id = 1 FOR UPDATE;
UPDATE platform.external_webhook_events SET provider = 'workos' WHERE id = 1;
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
echo "identity runtime grant contract passed (PostgreSQL ${version})"
