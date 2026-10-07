#!/usr/bin/env bash
set -euo pipefail

postgres_version="${1:?usage: test-target-database-runtime-preflight-integration.sh <16|17>}"
if [[ "${postgres_version}" != "16" && "${postgres_version}" != "17" ]]; then
  echo "PostgreSQL version must be 16 or 17" >&2
  exit 2
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
suffix="${RANDOM}${RANDOM}"
network="vayada-db-preflight-${suffix}"
database_container="vayada-db-preflight-pg-${suffix}"
node_modules_container="vayada-db-preflight-node-${suffix}"
work="$(mktemp -d)"

cleanup() {
  docker rm -f "${database_container}" >/dev/null 2>&1 || true
  docker network rm "${network}" >/dev/null 2>&1 || true
  docker volume rm "${node_modules_container}" >/dev/null 2>&1 || true
  rm -rf "${work}"
}
trap cleanup EXIT
trap 'echo "integration test failed at line ${LINENO}: ${BASH_COMMAND}" >&2' ERR

docker network create "${network}" >/dev/null
docker volume create "${node_modules_container}" >/dev/null
docker run --detach --rm \
  --name "${database_container}" \
  --network "${network}" \
  --network-alias vayada-db-preflight \
  --env POSTGRES_PASSWORD=postgres \
  "postgres:${postgres_version}" >/dev/null

ready_checks=0
for _ in {1..60}; do
  if docker exec "${database_container}" psql -U postgres -Atqc "SELECT 1" >/dev/null 2>&1; then
    ready_checks=$((ready_checks + 1))
    [[ "${ready_checks}" -ge 2 ]] && break
  else
    ready_checks=0
  fi
  sleep 1
done
[[ "${ready_checks}" -ge 2 ]] || { echo "PostgreSQL did not become stably ready" >&2; exit 1; }

docker exec -i "${database_container}" psql -v ON_ERROR_STOP=1 -U postgres <<'SQL'
CREATE ROLE legacy_owner LOGIN PASSWORD 'owner';
CREATE ROLE hotel_setup_provision_admin LOGIN CREATEROLE PASSWORD 'provision';
CREATE ROLE vayada_next_api_runtime LOGIN PASSWORD 'runtime'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE elevated NOLOGIN;
REVOKE CREATE, TEMPORARY ON DATABASE postgres FROM PUBLIC;
GRANT CONNECT ON DATABASE postgres TO vayada_next_api_runtime;
GRANT CONNECT ON DATABASE postgres TO legacy_owner, hotel_setup_provision_admin;

CREATE SCHEMA platform AUTHORIZATION legacy_owner;
CREATE SCHEMA app AUTHORIZATION legacy_owner;
CREATE SCHEMA booking AUTHORIZATION legacy_owner;
CREATE SCHEMA finance AUTHORIZATION legacy_owner;
CREATE SCHEMA pms AUTHORIZATION legacy_owner;
CREATE SCHEMA marketplace AUTHORIZATION legacy_owner;
CREATE SCHEMA hotel_catalog AUTHORIZATION legacy_owner;
CREATE SCHEMA distribution AUTHORIZATION legacy_owner;
CREATE SCHEMA identity AUTHORIZATION legacy_owner;
CREATE SCHEMA vayada_migration_evidence AUTHORIZATION legacy_owner;
REVOKE ALL ON SCHEMA identity, platform, app, booking, finance, pms, marketplace, hotel_catalog, distribution, vayada_migration_evidence FROM PUBLIC;
GRANT USAGE ON SCHEMA identity, platform, app, booking, finance, pms, marketplace, hotel_catalog, distribution, vayada_migration_evidence
  TO vayada_next_api_runtime;

SET ROLE legacy_owner;
CREATE TABLE platform.legacy_owner_bootstrap_receipts (
  owner_user_ids text[] NOT NULL,
  authority_payload jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE app.hotel (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text);
CREATE TABLE booking.guest_bookings (id uuid PRIMARY KEY);
CREATE TABLE finance.payments (id uuid PRIMARY KEY);
CREATE TABLE finance.expense_categories (id uuid PRIMARY KEY);
CREATE TABLE finance.expenses (id uuid PRIMARY KEY);
CREATE TABLE finance.recurring_expense_rules (id uuid PRIMARY KEY);
CREATE TABLE finance.folios (id uuid PRIMARY KEY, property_id uuid);
CREATE TABLE finance.folio_revisions (id uuid PRIMARY KEY);
CREATE TABLE finance.folio_lines (id uuid PRIMARY KEY);
CREATE TABLE finance.folio_payment_references (id uuid PRIMARY KEY);
CREATE TABLE pms.channel_operational_alerts (
  id uuid PRIMARY KEY, resolved_at timestamptz, acknowledged_at timestamptz
);
CREATE TABLE finance.affiliate_earning_reconciliation_revisions (id uuid PRIMARY KEY);
CREATE TABLE finance.affiliate_eligible_earning_revisions (id uuid PRIMARY KEY);
CREATE TABLE finance.affiliate_earning_allocations (id uuid PRIMARY KEY);
CREATE TABLE finance.affiliate_earning_allocation_items (id uuid PRIMARY KEY);
CREATE TABLE platform.external_webhook_events (id uuid PRIMARY KEY);
CREATE TABLE platform.domain_events (id uuid PRIMARY KEY);
CREATE TABLE platform.idempotency_keys (id uuid PRIMARY KEY);
CREATE TABLE platform.product_audit_events (id uuid PRIMARY KEY);
CREATE TABLE platform.jobs (id uuid PRIMARY KEY);
CREATE TABLE pms.channel_connections (id uuid PRIMARY KEY);
CREATE TABLE marketplace.affiliate_links (id uuid PRIMARY KEY);
CREATE TABLE marketplace.affiliate_agreement_lifecycle_events (id uuid PRIMARY KEY);
CREATE TABLE marketplace.affiliate_click_occurrences (id uuid PRIMARY KEY);
CREATE TABLE marketplace.affiliate_discrepancy_claims (id uuid PRIMARY KEY);
CREATE TABLE marketplace.affiliate_discrepancy_resolutions (id uuid PRIMARY KEY);
CREATE TABLE marketplace.affiliate_click_quota_windows (link_id uuid PRIMARY KEY, consumed integer);
CREATE TABLE hotel_catalog.organization_setup_track_intents (
  organization_id uuid PRIMARY KEY, selected_tracks text[], revision integer, updated_at timestamptz
);
CREATE TABLE identity.product_entitlements (
  id uuid DEFAULT gen_random_uuid(), organization_id uuid, product text, entitlement_key text,
  status text, starts_at timestamptz, expires_at timestamptz, metadata jsonb, updated_at timestamptz,
  resource_product text
);
CREATE TABLE identity.organization_resource_links (
  id uuid DEFAULT gen_random_uuid(), organization_id uuid, product text, resource_type text,
  resource_id text, relationship text, status text
);
CREATE TABLE finance.billing_entitlements (id uuid DEFAULT gen_random_uuid(), billing_status text);
CREATE TABLE booking.booking_settings (property_id uuid PRIMARY KEY, published boolean DEFAULT false);
CREATE TABLE marketplace.marketplace_hotel_profiles (
  property_id uuid PRIMARY KEY, organization_id uuid, source_system text, source_hotel_profile_id text,
  status text DEFAULT 'draft'
);
CREATE TABLE hotel_catalog.properties (id uuid PRIMARY KEY, profile_revision integer NOT NULL DEFAULT 1);
CREATE TABLE booking.affiliate_click_contexts (id uuid PRIMARY KEY);
CREATE TABLE booking.affiliate_click_admissions (id uuid PRIMARY KEY);
CREATE TABLE booking.affiliate_original_booking_bindings (id uuid PRIMARY KEY);
CREATE TABLE platform.legacy_owner_approval_records (id uuid PRIMARY KEY);
CREATE TABLE platform.legacy_owner_approval_revocations (id uuid PRIMARY KEY);
CREATE TABLE platform.identity_migration_provenance (id uuid PRIMARY KEY);
CREATE TABLE platform.legacy_historical_binding_transitions (id uuid PRIMARY KEY);
CREATE TABLE platform.channex_management_worker_properties (property_id uuid PRIMARY KEY);
CREATE TABLE platform.finance_expense_worker_properties (property_id uuid PRIMARY KEY);
CREATE TABLE platform.finance_export_worker_properties (property_id uuid PRIMARY KEY);
CREATE TABLE platform.pricing_runtime_property_scopes (database_login name PRIMARY KEY);
CREATE TABLE platform.hotel_setup_property_scopes (database_login name PRIMARY KEY, property_id uuid, organization_id uuid);
CREATE TABLE platform.hotel_setup_creation_scopes (database_login name PRIMARY KEY, organization_id uuid);
CREATE TABLE platform.hotel_setup_linked_properties (property_id uuid PRIMARY KEY);
CREATE TABLE platform.hotel_setup_reconciliation_cursors (mode text PRIMARY KEY, scope_id uuid);
CREATE VIEW hotel_catalog.hotel_setup_effective_creation_scopes WITH (security_barrier = true) AS
  SELECT organization_id FROM platform.hotel_setup_creation_scopes WHERE database_login = session_user;
CREATE TABLE pms.inventory_coverage_validation_queue (id uuid PRIMARY KEY);
-- VAY-2054 product DML fixture: ordinary product tables, protected classes and the identity lock set.
CREATE TABLE platform.schema_migrations (name text PRIMARY KEY);
CREATE TABLE distribution.public_room_offer_snapshots (id uuid PRIMARY KEY);
CREATE TABLE platform.outbox_events (id uuid PRIMARY KEY);
CREATE TABLE platform.job_attempts (id uuid PRIMARY KEY);
CREATE TABLE platform.dead_letter_events (id uuid PRIMARY KEY);
CREATE TABLE platform.media_objects (id uuid PRIMARY KEY);
CREATE TABLE platform.production_cutover_runs (id uuid PRIMARY KEY);
CREATE TABLE hotel_catalog.property_setup_sessions (id uuid PRIMARY KEY);
CREATE TABLE hotel_catalog.property_setup_step_drafts (id uuid PRIMARY KEY, revision integer DEFAULT 1);
CREATE TABLE booking.pricing_authority_heads (id uuid PRIMARY KEY, revision integer);
CREATE TABLE booking.pricing_authority_revisions (id uuid PRIMARY KEY);
CREATE TABLE booking.pricing_quotes (id uuid PRIMARY KEY);
CREATE TABLE finance.expense_generation_dispatches (id uuid PRIMARY KEY);
CREATE TABLE pms.channex_room_availability_attempts (id uuid PRIMARY KEY);
CREATE TABLE pms.channex_ari_schedule_sources (id uuid PRIMARY KEY);
CREATE SEQUENCE booking.fixture_sequence;
CREATE TABLE identity.organizations (id uuid PRIMARY KEY, name text);
CREATE TABLE identity.users (id uuid PRIMARY KEY, status text);
CREATE TABLE identity.organization_memberships (id uuid PRIMARY KEY);
CREATE TABLE identity.role_permission_grants (id uuid PRIMARY KEY);
CREATE TABLE identity.membership_property_assignments (membership_id uuid, property_id uuid, PRIMARY KEY (membership_id, property_id));
CREATE TABLE identity.organization_roles (id uuid PRIMARY KEY);
INSERT INTO identity.organizations (id, name) VALUES ('00000000-0000-4000-8000-00000000aa01', 'fixture');
DO $$
DECLARE item regclass;
BEGIN
  FOREACH item IN ARRAY ARRAY['identity.organizations','identity.users','identity.organization_memberships',
    'identity.role_permission_grants','identity.membership_property_assignments','identity.organization_roles']::regclass[] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', item);
    EXECUTE format('CREATE POLICY api_runtime_existing_access ON %s TO PUBLIC USING (true) WITH CHECK (true)', item);
    EXECUTE format('CREATE POLICY api_runtime_lock_only ON %s AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (true)
      WITH CHECK (current_user <> ''vayada_next_api_runtime'' AND session_user <> ''vayada_next_api_runtime'')', item);
  END LOOP;
END $$;
CREATE TABLE vayada_migration_evidence.database_attestations (id uuid PRIMARY KEY);
CREATE TYPE app.hotel_state AS ENUM ('active', 'inactive');
CREATE FUNCTION app.hotel_count() RETURNS bigint
  LANGUAGE sql AS 'SELECT count(*) FROM app.hotel';
CREATE FUNCTION app.owner_only() RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS 'SELECT';
RESET ROLE;

REVOKE ALL ON platform.legacy_owner_bootstrap_receipts FROM PUBLIC;
GRANT SELECT (owner_user_ids) ON platform.legacy_owner_bootstrap_receipts
  TO vayada_next_api_runtime;
GRANT SELECT ON app.hotel TO vayada_next_api_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON booking.guest_bookings
  TO vayada_next_api_runtime;
GRANT SELECT, INSERT, UPDATE ON finance.payments,
  platform.external_webhook_events, pms.channel_connections
  TO vayada_next_api_runtime;
GRANT SELECT ON finance.expense_categories, finance.expenses, finance.recurring_expense_rules TO vayada_next_api_runtime;
GRANT SELECT ON finance.folios, finance.folio_revisions, finance.folio_lines,
  finance.folio_payment_references TO vayada_next_api_runtime;
GRANT SELECT, UPDATE (resolved_at) ON pms.channel_operational_alerts TO vayada_next_api_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.idempotency_keys
  TO vayada_next_api_runtime;
GRANT SELECT ON platform.product_audit_events
  TO vayada_next_api_runtime;
GRANT SELECT ON platform.jobs TO vayada_next_api_runtime;
GRANT SELECT, UPDATE (id) ON hotel_catalog.properties TO vayada_next_api_runtime;
GRANT SELECT ON hotel_catalog.organization_setup_track_intents, identity.product_entitlements,
  identity.organization_resource_links, finance.billing_entitlements,
  booking.booking_settings, marketplace.marketplace_hotel_profiles TO vayada_next_api_runtime;
GRANT SELECT ON platform.legacy_owner_approval_records,
  platform.legacy_owner_approval_revocations TO vayada_next_api_runtime;
GRANT SELECT ON platform.schema_migrations, distribution.public_room_offer_snapshots, platform.outbox_events, platform.job_attempts,
  platform.dead_letter_events, platform.media_objects, platform.production_cutover_runs,
  hotel_catalog.property_setup_sessions, hotel_catalog.property_setup_step_drafts,
  booking.pricing_authority_heads, booking.pricing_authority_revisions, booking.pricing_quotes,
  finance.expense_generation_dispatches, pms.channex_room_availability_attempts,
  pms.channex_ari_schedule_sources, identity.organizations, identity.users,
  identity.organization_memberships, identity.role_permission_grants,
  identity.membership_property_assignments, identity.organization_roles TO vayada_next_api_runtime;
GRANT EXECUTE ON FUNCTION app.hotel_count() TO vayada_next_api_runtime;
REVOKE ALL ON FUNCTION app.owner_only() FROM PUBLIC;
GRANT USAGE ON TYPE app.hotel_state TO vayada_next_api_runtime;
-- Legacy allowlist end-state: what the retired per-incident grants produced in production.
GRANT SELECT ON marketplace.affiliate_links, marketplace.affiliate_agreement_lifecycle_events,
  marketplace.affiliate_click_occurrences, marketplace.affiliate_discrepancy_claims,
  marketplace.affiliate_discrepancy_resolutions, booking.affiliate_click_contexts,
  booking.affiliate_click_admissions, booking.affiliate_original_booking_bindings,
  finance.affiliate_earning_reconciliation_revisions, finance.affiliate_eligible_earning_revisions,
  finance.affiliate_earning_allocations, finance.affiliate_earning_allocation_items,
  platform.pricing_runtime_property_scopes, platform.channex_management_worker_properties,
  platform.domain_events TO vayada_next_api_runtime;
GRANT INSERT ON platform.product_audit_events, platform.domain_events, platform.jobs,
  finance.expense_categories, finance.expenses, finance.recurring_expense_rules, finance.folios,
  finance.folio_revisions, finance.folio_lines, finance.folio_payment_references TO vayada_next_api_runtime;
GRANT UPDATE (id) ON finance.folios, finance.billing_entitlements TO vayada_next_api_runtime;
GRANT INSERT (organization_id, selected_tracks, revision), UPDATE (selected_tracks, revision, updated_at)
  ON hotel_catalog.organization_setup_track_intents TO vayada_next_api_runtime;
GRANT INSERT (organization_id, product, entitlement_key, status, starts_at, expires_at, metadata),
  UPDATE (status, starts_at, expires_at, updated_at) ON identity.product_entitlements TO vayada_next_api_runtime;
GRANT INSERT (organization_id, product, resource_type, resource_id, relationship, status), UPDATE (id)
  ON identity.organization_resource_links TO vayada_next_api_runtime;
GRANT INSERT (property_id) ON booking.booking_settings TO vayada_next_api_runtime;
GRANT INSERT (property_id, organization_id, source_system, source_hotel_profile_id), UPDATE (property_id)
  ON marketplace.marketplace_hotel_profiles TO vayada_next_api_runtime;
SQL

docker run --rm \
  --volume "${node_modules_container}:/work" \
  --workdir /work node:22-bookworm \
  sh -c 'npm init -y >/dev/null && npm install --silent --no-audit --no-fund pg@8.16.3'
cp "${root}/scripts/target-database-runtime-preflight.mjs" "${work}/preflight.mjs"
cp "${root}/scripts/provision-hotel-setup-scope-role.mjs" "${work}/hotel-setup-scope.mjs"
cp "${root}/scripts/grant-target-database-runtime-product-dml.mjs" "${work}/product-dml-grant.mjs"

run_hotel_setup_scope() {
  local database_role="${1:-postgres}"
  local password="${2:-postgres}"
  local fixture_flag="${3:-1}"
  docker run --rm \
    --network "${network}" \
    --volume "${node_modules_container}:/work" \
    --volume "${work}/hotel-setup-scope.mjs:/work/hotel-setup-scope.mjs:ro" \
    --workdir /work \
    --env "TARGET_DATABASE_ADMIN_URL=postgresql://${database_role}:${password}@vayada-db-preflight:5432/postgres" \
    --env "VAYADA_HOTEL_SETUP_SCOPE_LOCAL_FIXTURE=${fixture_flag}" \
    node:22-bookworm node hotel-setup-scope.mjs
}

if untrusted_scope_output="$(run_hotel_setup_scope postgres postgres 0 2>&1)"; then
  echo "hotel setup scope accepted an untrusted host" >&2
  exit 1
fi
grep -F '"code":"hotel_setup_scope_admin_endpoint_untrusted"' <<<"${untrusted_scope_output}" >/dev/null
if unprivileged_scope_output="$(run_hotel_setup_scope legacy_owner owner 2>&1)"; then
  echo "hotel setup scope accepted a non-admin login" >&2
  exit 1
fi
grep -F '"code":"hotel_setup_scope_admin_privilege_missing"' <<<"${unprivileged_scope_output}" >/dev/null
run_hotel_setup_scope hotel_setup_provision_admin provision | grep -F '"created":true' >/dev/null
run_hotel_setup_scope hotel_setup_provision_admin provision | grep -F '"created":false' >/dev/null
docker exec "${database_container}" psql -U postgres -v ON_ERROR_STOP=1 -c \
  'GRANT SELECT ON hotel_catalog.hotel_setup_effective_creation_scopes TO vayada_next_hotel_setup_scope' >/dev/null
docker exec "${database_container}" psql -U postgres -tAc \
  "SELECT has_table_privilege('vayada_next_hotel_setup_scope', 'hotel_catalog.hotel_setup_effective_creation_scopes', 'SELECT')" | grep -Fx t >/dev/null
docker exec "${database_container}" psql -U postgres -Atqc "
  SELECT NOT (rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR
    rolinherit OR rolbypassrls OR rolreplication)
  FROM pg_roles WHERE rolname = 'vayada_next_hotel_setup_scope'
" | grep -Fx t >/dev/null
docker exec "${database_container}" psql -v ON_ERROR_STOP=1 -U postgres -c \
  'GRANT elevated TO vayada_next_hotel_setup_scope' >/dev/null
if unsafe_scope_output="$(run_hotel_setup_scope 2>&1)"; then
  echo "hotel setup scope accepted inherited membership" >&2
  exit 1
fi
grep -F '"code":"hotel_setup_scope_role_unsafe"' <<<"${unsafe_scope_output}" >/dev/null
docker exec "${database_container}" psql -v ON_ERROR_STOP=1 -U postgres -c \
  'REVOKE elevated FROM vayada_next_hotel_setup_scope' >/dev/null

run_grant() {
  local database_role="$1"
  local database_password="$2"
  local fixture_flag="${3:-1}"
  local grant_scope="${4:-product_dml}"
  local grant_file="product-dml-grant.mjs"
  docker run --rm \
    --network "${network}" \
    --volume "${node_modules_container}:/work" \
    --volume "${work}/${grant_file}:/work/${grant_file}:ro" \
    --workdir /work \
    --env "TARGET_DATABASE_MIGRATION_URL=postgresql://${database_role}:${database_password}@vayada-db-preflight:5432/postgres" \
    --env "VAYADA_AUDIT_GRANT_LOCAL_FIXTURE=${fixture_flag}" \
    --env "VAYADA_DB_GRANT_SCOPE=${grant_scope}" \
    node:22-bookworm node "${grant_file}"
}

run_preflight() {
  docker run --rm \
    --network "${network}" \
    --volume "${node_modules_container}:/work" \
    --volume "${work}/preflight.mjs:/work/preflight.mjs:ro" \
    --workdir /work \
    --env "TARGET_DATABASE_URL=postgresql://vayada_next_api_runtime:runtime@${database_container}:5432/postgres" \
    --env "VAYADA_DB_REQUIRE_PRODUCT_DML=${VAYADA_DB_REQUIRE_PRODUCT_DML:-0}" \
    node:22-bookworm node preflight.mjs
}

expect_failure() {
  local expected="$1"
  local output
  if output="$(run_preflight 2>&1)"; then
    echo "preflight unexpectedly passed; wanted ${expected}" >&2
    exit 1
  fi
  grep -F "${expected}" <<<"${output}" >/dev/null
}

if ambiguous_tls_output="$(docker run --rm \
  --volume "${node_modules_container}:/work" \
  --volume "${work}/product-dml-grant.mjs:/work/product-dml-grant.mjs:ro" \
  --workdir /work \
  --env 'TARGET_DATABASE_MIGRATION_URL=postgresql://legacy_owner:owner@vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com:5432/postgres?sslmode=require&ssl=0' \
  --env VAYADA_DB_RDS_CA_BUNDLE=test-ca --env VAYADA_DB_GRANT_SCOPE=product_dml \
  node:22-bookworm node product-dml-grant.mjs 2>&1)"; then
  echo "conflicting TLS parameter unexpectedly passed" >&2
  exit 1
fi
grep -F '"code":"unsupported_connection_parameters"' <<<"${ambiguous_tls_output}" >/dev/null

if override_host_output="$(docker run --rm \
  --volume "${node_modules_container}:/work" \
  --volume "${work}/product-dml-grant.mjs:/work/product-dml-grant.mjs:ro" \
  --workdir /work \
  --env 'TARGET_DATABASE_MIGRATION_URL=postgresql://legacy_owner:owner@vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com:5432/postgres?sslmode=require&host=elsewhere.example.test' \
  --env VAYADA_DB_RDS_CA_BUNDLE=test-ca --env VAYADA_DB_GRANT_SCOPE=product_dml \
  node:22-bookworm node product-dml-grant.mjs 2>&1)"; then
  echo "overridden database host unexpectedly passed" >&2
  exit 1
fi

# A missing read must never mask an unexpected authority leak before repair.
docker exec "${database_container}" psql -U postgres -v ON_ERROR_STOP=1 -c \
  'GRANT SELECT ON platform.hotel_setup_creation_scopes TO vayada_next_api_runtime' >/dev/null
expect_failure runtime_protected_relation_read_forbidden
docker exec "${database_container}" psql -U postgres -v ON_ERROR_STOP=1 -c \
  'REVOKE SELECT ON platform.hotel_setup_creation_scopes FROM vayada_next_api_runtime' >/dev/null

run_preflight | grep -F '"status":"PASS"' >/dev/null
docker exec "${database_container}" psql -U postgres -c \
  "GRANT UPDATE (acknowledged_at) ON pms.channel_operational_alerts TO vayada_next_api_runtime" >/dev/null
expect_failure runtime_unapproved_relation_column_write_forbidden
docker exec "${database_container}" psql -U postgres -c \
  "REVOKE UPDATE (acknowledged_at) ON pms.channel_operational_alerts FROM vayada_next_api_runtime" >/dev/null
docker exec "${database_container}" psql -U postgres -c \
  "GRANT UPDATE (resolved_at) ON pms.channel_operational_alerts TO vayada_next_api_runtime WITH GRANT OPTION" >/dev/null
expect_failure runtime_column_grant_option_forbidden
docker exec "${database_container}" psql -U postgres -c \
  "REVOKE GRANT OPTION FOR UPDATE (resolved_at) ON pms.channel_operational_alerts FROM vayada_next_api_runtime" >/dev/null
run_preflight | grep -F '"status":"PASS"' >/dev/null
run_preflight | grep -F '"status":"PASS"' >/dev/null
docker exec -e PGPASSWORD=runtime "${database_container}" \
  psql -U vayada_next_api_runtime -d postgres -v ON_ERROR_STOP=1 -c \
  "BEGIN; INSERT INTO finance.folios(id) VALUES ('00000000-0000-4000-8000-000000000011'); SELECT id FROM finance.folios WHERE id='00000000-0000-4000-8000-000000000011' FOR UPDATE; INSERT INTO finance.folio_revisions(id) VALUES ('00000000-0000-4000-8000-000000000012'); INSERT INTO finance.folio_lines(id) VALUES ('00000000-0000-4000-8000-000000000013'); INSERT INTO finance.folio_payment_references(id) VALUES ('00000000-0000-4000-8000-000000000014'); ROLLBACK" >/dev/null
if docker exec -e PGPASSWORD=runtime "${database_container}" \
  psql -U vayada_next_api_runtime -d postgres -v ON_ERROR_STOP=1 -c \
  "UPDATE finance.folios SET property_id=property_id WHERE false" >/dev/null 2>&1; then
  echo "runtime role unexpectedly updated Folios property scope" >&2
  exit 1
fi
if docker exec -e PGPASSWORD=runtime "${database_container}" \
  psql -U vayada_next_api_runtime -d postgres -v ON_ERROR_STOP=1 -c \
  "DELETE FROM finance.folios WHERE false" >/dev/null 2>&1; then
  echo "runtime role unexpectedly deleted Folios" >&2
  exit 1
fi

for quota_read in 'SELECT' 'SELECT (link_id)'; do
  docker exec "${database_container}" psql -U postgres -v ON_ERROR_STOP=1 -c \
    "GRANT ${quota_read} ON marketplace.affiliate_click_quota_windows TO vayada_next_api_runtime" >/dev/null
  expect_failure runtime_protected_relation_read_forbidden
  docker exec "${database_container}" psql -U postgres -v ON_ERROR_STOP=1 -c \
    "REVOKE ${quota_read} ON marketplace.affiliate_click_quota_windows FROM vayada_next_api_runtime" >/dev/null
done

for privilege in 'SELECT' 'SELECT (id)'; do
  docker exec "${database_container}" psql -U postgres -v ON_ERROR_STOP=1 -c \
    "GRANT ${privilege} ON platform.identity_migration_provenance TO vayada_next_api_runtime" >/dev/null
  expect_failure runtime_protected_relation_read_forbidden
  docker exec "${database_container}" psql -U postgres -v ON_ERROR_STOP=1 -c \
    "REVOKE ${privilege} ON platform.identity_migration_provenance FROM vayada_next_api_runtime" >/dev/null
done
for privilege in 'SELECT' 'SELECT (id)'; do
  docker exec "${database_container}" psql -U postgres -v ON_ERROR_STOP=1 -c \
    "GRANT ${privilege} ON platform.legacy_historical_binding_transitions TO vayada_next_api_runtime" >/dev/null
  expect_failure runtime_protected_relation_read_forbidden
  docker exec "${database_container}" psql -U postgres -v ON_ERROR_STOP=1 -c \
    "REVOKE ${privilege} ON platform.legacy_historical_binding_transitions FROM vayada_next_api_runtime" >/dev/null
done
for privilege in 'INSERT' 'UPDATE (id)'; do
  docker exec "${database_container}" psql -U postgres -v ON_ERROR_STOP=1 -c \
    "GRANT ${privilege} ON platform.identity_migration_provenance TO vayada_next_api_runtime" >/dev/null
  if [[ "${privilege}" == 'INSERT' ]]; then
    expect_failure runtime_protected_relation_write_forbidden
  else
    expect_failure runtime_protected_relation_column_write_forbidden
  fi
  docker exec "${database_container}" psql -U postgres -v ON_ERROR_STOP=1 -c \
    "REVOKE ${privilege} ON platform.identity_migration_provenance FROM vayada_next_api_runtime" >/dev/null
done
run_preflight | grep -F '"status":"PASS"' >/dev/null

# Finance worker scopes remain private even when a table or column grant leaks.
for table in finance_expense_worker_properties finance_export_worker_properties; do
  for privilege in 'SELECT' 'SELECT (property_id)'; do
    docker exec "${database_container}" psql -U postgres -c \
      "GRANT ${privilege} ON platform.${table} TO vayada_next_api_runtime" >/dev/null
    expect_failure runtime_protected_relation_read_forbidden
    docker exec "${database_container}" psql -U postgres -c \
      "REVOKE ${privilege} ON platform.${table} FROM vayada_next_api_runtime" >/dev/null
  done
done
run_preflight | grep -F '"status":"PASS"' >/dev/null

# Exact hotel setup exclusions must reject leaked direct, PUBLIC and inherited reads.
for entry in \
  platform.hotel_setup_property_scopes:database_login \
  platform.hotel_setup_creation_scopes:database_login \
  platform.hotel_setup_linked_properties:property_id \
  platform.hotel_setup_reconciliation_cursors:scope_id \
  hotel_catalog.hotel_setup_effective_creation_scopes:organization_id; do
  table="${entry%:*}"
  column="${entry#*:}"
  for grantee in vayada_next_api_runtime PUBLIC elevated; do
    if [[ "${grantee}" == elevated ]]; then
      docker exec "${database_container}" psql -U postgres -v ON_ERROR_STOP=1 -c \
        'GRANT elevated TO vayada_next_api_runtime WITH INHERIT TRUE, SET FALSE, ADMIN FALSE' >/dev/null
    fi
    for privilege in SELECT "SELECT (${column})"; do
      docker exec "${database_container}" psql -U postgres -v ON_ERROR_STOP=1 -c \
        "GRANT ${privilege} ON ${table} TO ${grantee}" >/dev/null
      expect_failure runtime_protected_relation_read_forbidden
      docker exec "${database_container}" psql -U postgres -v ON_ERROR_STOP=1 -c \
        "REVOKE ${privilege} ON ${table} FROM ${grantee}" >/dev/null
    done
    if [[ "${grantee}" == elevated ]]; then
      docker exec "${database_container}" psql -U postgres -v ON_ERROR_STOP=1 -c \
        'REVOKE elevated FROM vayada_next_api_runtime' >/dev/null
    fi
  done
  for privilege in INSERT "UPDATE (${column})"; do
    docker exec "${database_container}" psql -U postgres -v ON_ERROR_STOP=1 -c \
      "GRANT ${privilege} ON ${table} TO vayada_next_api_runtime" >/dev/null
    if [[ "${privilege}" == INSERT ]]; then
      expect_failure runtime_protected_relation_write_forbidden
    else
      expect_failure runtime_protected_relation_column_write_forbidden
    fi
    docker exec "${database_container}" psql -U postgres -v ON_ERROR_STOP=1 -c \
      "REVOKE ${privilege} ON ${table} FROM vayada_next_api_runtime" >/dev/null
  done
done
run_preflight | grep -F '"status":"PASS"' >/dev/null

docker exec "${database_container}" psql -U postgres -c \
  "REVOKE INSERT ON platform.domain_events FROM vayada_next_api_runtime" >/dev/null
run_preflight | grep -F '"status":"PASS"' >/dev/null
docker exec "${database_container}" psql -U postgres -c \
  "GRANT INSERT ON platform.domain_events TO vayada_next_api_runtime" >/dev/null

docker exec "${database_container}" psql -U postgres -c \
  "GRANT DELETE ON platform.domain_events TO vayada_next_api_runtime" >/dev/null
expect_failure runtime_unapproved_relation_write_forbidden
docker exec "${database_container}" psql -U postgres -c \
  "REVOKE DELETE ON platform.domain_events FROM vayada_next_api_runtime" >/dev/null

docker exec "${database_container}" psql -U postgres -c \
  "REVOKE INSERT ON platform.jobs FROM vayada_next_api_runtime" >/dev/null
run_preflight | grep -F '"status":"PASS"' >/dev/null
docker exec "${database_container}" psql -U postgres -c \
  "GRANT INSERT ON platform.jobs TO vayada_next_api_runtime" >/dev/null
docker exec "${database_container}" psql -U postgres -c \
  "GRANT DELETE ON platform.jobs TO vayada_next_api_runtime" >/dev/null
expect_failure runtime_unapproved_relation_write_forbidden
docker exec "${database_container}" psql -U postgres -c \
  "REVOKE DELETE ON platform.jobs FROM vayada_next_api_runtime" >/dev/null

docker exec -e PGPASSWORD=runtime "${database_container}" \
  psql -U vayada_next_api_runtime -d postgres -v ON_ERROR_STOP=1 \
  -c "INSERT INTO platform.product_audit_events(id) VALUES ('00000000-0000-0000-0000-000000000001')" \
  >/dev/null

docker exec "${database_container}" psql -U postgres -c \
  "REVOKE INSERT ON platform.product_audit_events FROM vayada_next_api_runtime" >/dev/null
expect_failure runtime_relation_access_missing
docker exec "${database_container}" psql -U postgres -c \
  "GRANT INSERT ON platform.product_audit_events TO vayada_next_api_runtime" >/dev/null

docker exec "${database_container}" psql -U postgres -c \
  "GRANT UPDATE ON platform.product_audit_events TO vayada_next_api_runtime" >/dev/null
expect_failure runtime_unapproved_relation_write_forbidden
docker exec "${database_container}" psql -U postgres -c \
  "REVOKE UPDATE ON platform.product_audit_events FROM vayada_next_api_runtime" >/dev/null

docker exec "${database_container}" psql -U postgres -c \
  "GRANT DELETE ON platform.product_audit_events TO vayada_next_api_runtime" >/dev/null
expect_failure runtime_unapproved_relation_write_forbidden
docker exec "${database_container}" psql -U postgres -c \
  "REVOKE DELETE ON platform.product_audit_events FROM vayada_next_api_runtime" >/dev/null

if docker exec -e PGPASSWORD=runtime "${database_container}" \
  psql -U vayada_next_api_runtime -d postgres -v ON_ERROR_STOP=1 \
  -c "INSERT INTO platform.legacy_owner_bootstrap_receipts(owner_user_ids) VALUES ('{}')" \
  >/dev/null 2>&1; then
  echo "runtime role unexpectedly wrote a receipt" >&2
  exit 1
fi

docker exec "${database_container}" psql -U postgres -c \
  "GRANT INSERT (owner_user_ids) ON platform.legacy_owner_bootstrap_receipts TO vayada_next_api_runtime" >/dev/null
expect_failure receipt_columns_writable
docker exec "${database_container}" psql -U postgres -c \
  "REVOKE INSERT (owner_user_ids) ON platform.legacy_owner_bootstrap_receipts FROM vayada_next_api_runtime" >/dev/null
if docker exec -e PGPASSWORD=runtime "${database_container}" \
  psql -U vayada_next_api_runtime -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT authority_payload FROM platform.legacy_owner_bootstrap_receipts" \
  >/dev/null 2>&1; then
  echo "runtime role unexpectedly read receipt authority data" >&2
  exit 1
fi

docker exec "${database_container}" psql -U postgres -c \
  "GRANT elevated TO vayada_next_api_runtime WITH SET TRUE" >/dev/null
expect_failure runtime_has_settable_or_admin_role_membership
docker exec "${database_container}" psql -U postgres -c \
  "REVOKE elevated FROM vayada_next_api_runtime" >/dev/null

docker exec "${database_container}" psql -U postgres -c \
  "GRANT elevated TO vayada_next_api_runtime WITH ADMIN TRUE, SET FALSE" >/dev/null
expect_failure runtime_has_settable_or_admin_role_membership
docker exec "${database_container}" psql -U postgres -c \
  "REVOKE elevated FROM vayada_next_api_runtime" >/dev/null

docker exec "${database_container}" psql -U postgres -c \
  "CREATE SCHEMA runtime_owned AUTHORIZATION vayada_next_api_runtime" >/dev/null
expect_failure runtime_application_object_ownership_forbidden
docker exec "${database_container}" psql -U postgres -c "DROP SCHEMA runtime_owned" >/dev/null

docker exec "${database_container}" psql -U postgres -c \
  "GRANT CREATE ON SCHEMA app TO vayada_next_api_runtime" >/dev/null
expect_failure runtime_schema_create_forbidden
docker exec "${database_container}" psql -U postgres -c \
  "REVOKE CREATE ON SCHEMA app FROM vayada_next_api_runtime" >/dev/null

docker exec "${database_container}" psql -U postgres -c \
  "GRANT TRUNCATE ON app.hotel TO vayada_next_api_runtime" >/dev/null
expect_failure runtime_destructive_relation_access_forbidden
docker exec "${database_container}" psql -U postgres -c \
  "REVOKE TRUNCATE ON app.hotel FROM vayada_next_api_runtime" >/dev/null

if [[ "${postgres_version}" == "17" ]]; then
  docker exec "${database_container}" psql -U postgres -c \
    "GRANT MAINTAIN ON app.hotel TO vayada_next_api_runtime" >/dev/null
  expect_failure runtime_destructive_relation_access_forbidden
  docker exec "${database_container}" psql -U postgres -c \
    "REVOKE MAINTAIN ON app.hotel FROM vayada_next_api_runtime" >/dev/null
fi

docker exec "${database_container}" psql -U postgres -c \
  "GRANT REFERENCES (id) ON app.hotel TO vayada_next_api_runtime" >/dev/null
expect_failure runtime_unapproved_relation_column_write_forbidden
docker exec "${database_container}" psql -U postgres -c \
  "REVOKE REFERENCES (id) ON app.hotel FROM vayada_next_api_runtime" >/dev/null

if [[ "${postgres_version}" == "17" ]]; then
  docker exec "${database_container}" psql -U postgres -c \
    "GRANT MAINTAIN ON platform.legacy_owner_bootstrap_receipts TO vayada_next_api_runtime" >/dev/null
  expect_failure receipt_can_maintain_must_be_denied
  docker exec "${database_container}" psql -U postgres -c \
    "REVOKE MAINTAIN ON platform.legacy_owner_bootstrap_receipts FROM vayada_next_api_runtime" >/dev/null
fi

docker exec "${database_container}" psql -U postgres -c \
  "GRANT EXECUTE ON FUNCTION app.owner_only() TO vayada_next_api_runtime" >/dev/null
expect_failure runtime_security_definer_execute_forbidden
docker exec "${database_container}" psql -U postgres -c \
  "REVOKE EXECUTE ON FUNCTION app.owner_only() FROM vayada_next_api_runtime" >/dev/null

docker exec "${database_container}" psql -U postgres -c \
  "GRANT INSERT ON app.hotel TO vayada_next_api_runtime" >/dev/null
expect_failure runtime_unapproved_relation_write_forbidden
docker exec "${database_container}" psql -U postgres -c \
  "REVOKE INSERT ON app.hotel FROM vayada_next_api_runtime" >/dev/null

docker exec "${database_container}" psql -U postgres -c \
  "REVOKE SELECT ON app.hotel FROM vayada_next_api_runtime" >/dev/null
expect_failure runtime_relation_read_missing
docker exec "${database_container}" psql -U postgres -c \
  "GRANT SELECT ON app.hotel TO vayada_next_api_runtime" >/dev/null

docker exec "${database_container}" psql -U postgres -c \
  "GRANT DELETE ON finance.payments TO vayada_next_api_runtime" >/dev/null
expect_failure runtime_unapproved_relation_write_forbidden
docker exec "${database_container}" psql -U postgres -c \
  "REVOKE DELETE ON finance.payments FROM vayada_next_api_runtime" >/dev/null

docker exec "${database_container}" psql -U postgres -c \
  "GRANT USAGE ON SEQUENCE app.hotel_id_seq TO vayada_next_api_runtime" >/dev/null
expect_failure runtime_sequence_access_forbidden
docker exec "${database_container}" psql -U postgres -c \
  "REVOKE USAGE ON SEQUENCE app.hotel_id_seq FROM vayada_next_api_runtime" >/dev/null

docker exec "${database_container}" psql -U postgres -c \
  "REVOKE INSERT ON booking.guest_bookings FROM vayada_next_api_runtime" >/dev/null
expect_failure runtime_relation_access_missing
docker exec "${database_container}" psql -U postgres -c \
  "GRANT INSERT ON booking.guest_bookings TO vayada_next_api_runtime" >/dev/null

docker exec "${database_container}" psql -U postgres -c \
  "GRANT INSERT ON platform.legacy_owner_approval_records TO vayada_next_api_runtime" >/dev/null
expect_failure runtime_protected_relation_write_forbidden
docker exec "${database_container}" psql -U postgres -c \
  "REVOKE INSERT ON platform.legacy_owner_approval_records FROM vayada_next_api_runtime" >/dev/null

docker exec "${database_container}" psql -U postgres -c \
  "GRANT UPDATE (id) ON vayada_migration_evidence.database_attestations TO vayada_next_api_runtime" >/dev/null
expect_failure runtime_protected_relation_column_write_forbidden
docker exec "${database_container}" psql -U postgres -c \
  "REVOKE UPDATE (id) ON vayada_migration_evidence.database_attestations FROM vayada_next_api_runtime" >/dev/null


# VAY-2054: one owner-checked product DML grant, protected list re-verified, rollback restores the legacy allowlist.
runtime_psql() {
  docker exec -e PGPASSWORD=runtime "${database_container}" \
    psql -U vayada_next_api_runtime -d postgres -v ON_ERROR_STOP=1 -Atqc "$1"
}
expect_runtime_denied() {
  if runtime_psql "$1" >/dev/null 2>&1; then
    echo "runtime role unexpectedly ran: $1" >&2; exit 1
  fi
}
owner_psql() { docker exec "${database_container}" psql -U postgres -v ON_ERROR_STOP=1 -Atqc "$1"; }

run_preflight | grep -F '"status":"PASS"' >/dev/null
if product_non_owner="$(run_grant vayada_next_api_runtime runtime 1 product_dml 2>&1)"; then
  echo "product DML grant accepted a non-owner" >&2; exit 1
fi
grep -F '"code":"runtime_dml_owner_required"' <<<"${product_non_owner}" >/dev/null
if product_untrusted="$(run_grant legacy_owner owner 0 product_dml 2>&1)"; then
  echo "product DML grant accepted an untrusted endpoint" >&2; exit 1
fi
grep -F '"code":"unexpected_database_host"' <<<"${product_untrusted}" >/dev/null
owner_psql "DROP POLICY api_runtime_lock_only ON identity.users" >/dev/null
if product_no_policy="$(run_grant legacy_owner owner 1 product_dml 2>&1)"; then
  echo "product DML grant accepted a missing identity lock-only policy" >&2; exit 1
fi
grep -F '"code":"runtime_identity_lock_only_policy_missing"' <<<"${product_no_policy}" >/dev/null
[[ "$(owner_psql "SELECT has_table_privilege('vayada_next_api_runtime','hotel_catalog.property_setup_step_drafts','INSERT')")" == f ]]
owner_psql "CREATE POLICY api_runtime_lock_only ON identity.users AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (true)
  WITH CHECK (current_user <> 'vayada_next_api_runtime' AND session_user <> 'vayada_next_api_runtime')" >/dev/null
owner_psql "GRANT elevated TO vayada_next_api_runtime" >/dev/null
if product_membership="$(run_grant legacy_owner owner 1 product_dml 2>&1)"; then
  echo "product DML grant accepted a role membership" >&2; exit 1
fi
grep -F '"code":"runtime_role_membership_forbidden"' <<<"${product_membership}" >/dev/null
owner_psql "REVOKE elevated FROM vayada_next_api_runtime" >/dev/null
run_grant legacy_owner owner 1 product_dml | grep -F '"grant":"product_dml"' >/dev/null
run_grant legacy_owner owner 1 product_dml | grep -F '"grant":"product_dml"' >/dev/null
run_preflight | grep -F '"posture":"product_dml"' >/dev/null
VAYADA_DB_REQUIRE_PRODUCT_DML=1 run_preflight | grep -F '"status":"PASS"' >/dev/null
owner_psql "GRANT INSERT ON platform.schema_migrations TO vayada_next_api_runtime" >/dev/null
expect_failure runtime_protected_relation_write_forbidden
owner_psql "REVOKE INSERT ON platform.schema_migrations FROM vayada_next_api_runtime" >/dev/null
owner_psql "GRANT UPDATE ON identity.users TO vayada_next_api_runtime" >/dev/null
expect_failure runtime_identity_write_scope_too_broad
owner_psql "REVOKE UPDATE ON identity.users FROM vayada_next_api_runtime; GRANT UPDATE (id) ON identity.users TO vayada_next_api_runtime" >/dev/null
owner_psql "DROP POLICY api_runtime_lock_only ON identity.organizations" >/dev/null
expect_failure runtime_identity_lock_only_policy_missing
owner_psql "CREATE POLICY api_runtime_lock_only ON identity.organizations AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (true)
  WITH CHECK (current_user <> 'vayada_next_api_runtime' AND session_user <> 'vayada_next_api_runtime')" >/dev/null
owner_psql "REVOKE INSERT ON hotel_catalog.property_setup_step_drafts FROM vayada_next_api_runtime" >/dev/null
expect_failure runtime_product_dml_missing:1:hotel_catalog.property_setup_step_drafts.INSERT
owner_psql "GRANT INSERT ON hotel_catalog.property_setup_step_drafts TO vayada_next_api_runtime" >/dev/null
docker exec -e PGPASSWORD=owner "${database_container}" psql -U legacy_owner -d postgres -v ON_ERROR_STOP=1 -Atqc \
  "ALTER DEFAULT PRIVILEGES IN SCHEMA booking REVOKE ALL ON TABLES FROM vayada_next_api_runtime" >/dev/null
expect_failure runtime_product_dml_posture_partial:6
docker exec -e PGPASSWORD=owner "${database_container}" psql -U legacy_owner -d postgres -v ON_ERROR_STOP=1 -Atqc \
  "ALTER DEFAULT PRIVILEGES IN SCHEMA booking GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vayada_next_api_runtime" >/dev/null
owner_psql "GRANT UPDATE ON platform.product_audit_events TO vayada_next_api_runtime" >/dev/null
expect_failure runtime_narrowed_relation_writable
owner_psql "REVOKE UPDATE ON platform.product_audit_events FROM vayada_next_api_runtime" >/dev/null
owner_psql "GRANT INSERT ON app.hotel TO vayada_next_api_runtime" >/dev/null
expect_failure runtime_unapproved_relation_write_forbidden
owner_psql "REVOKE INSERT ON app.hotel FROM vayada_next_api_runtime" >/dev/null
owner_psql "GRANT UPDATE ON SEQUENCE booking.fixture_sequence TO vayada_next_api_runtime" >/dev/null
expect_failure runtime_sequence_access_forbidden
owner_psql "REVOKE UPDATE ON SEQUENCE booking.fixture_sequence FROM vayada_next_api_runtime" >/dev/null
owner_psql "GRANT elevated TO vayada_next_api_runtime WITH INHERIT TRUE, SET FALSE, ADMIN FALSE" >/dev/null
expect_failure runtime_role_membership_forbidden
owner_psql "REVOKE elevated FROM vayada_next_api_runtime" >/dev/null
run_preflight | grep -F '"posture":"product_dml"' >/dev/null

runtime_psql "INSERT INTO hotel_catalog.property_setup_step_drafts(id) VALUES ('00000000-0000-4000-8000-000000000101')" >/dev/null
runtime_psql "UPDATE hotel_catalog.property_setup_step_drafts SET revision = 2 WHERE id = '00000000-0000-4000-8000-000000000101'" >/dev/null
runtime_psql "DELETE FROM hotel_catalog.property_setup_step_drafts WHERE id = '00000000-0000-4000-8000-000000000101'" >/dev/null
runtime_psql "INSERT INTO platform.outbox_events(id) VALUES ('00000000-0000-4000-8000-000000000102')" >/dev/null
runtime_psql "INSERT INTO platform.jobs(id) VALUES ('00000000-0000-4000-8000-000000000103')" >/dev/null
runtime_psql "UPDATE platform.jobs SET id = id WHERE id = '00000000-0000-4000-8000-000000000103'" >/dev/null
runtime_psql "SELECT nextval('booking.fixture_sequence')" >/dev/null
[[ "$(runtime_psql "SELECT name FROM identity.organizations WHERE id = '00000000-0000-4000-8000-00000000aa01' FOR SHARE")" == fixture ]]
[[ "$(runtime_psql "SELECT name FROM identity.organizations WHERE id = '00000000-0000-4000-8000-00000000aa01' FOR UPDATE")" == fixture ]]
expect_runtime_denied "UPDATE identity.organizations SET name = 'changed' WHERE id = '00000000-0000-4000-8000-00000000aa01'"
expect_runtime_denied "UPDATE identity.organizations SET id = id WHERE id = '00000000-0000-4000-8000-00000000aa01'"
[[ "$(owner_psql "SELECT name FROM identity.organizations WHERE id = '00000000-0000-4000-8000-00000000aa01'")" == fixture ]]
expect_runtime_denied "INSERT INTO identity.users(id) VALUES ('00000000-0000-4000-8000-000000000104')"
expect_runtime_denied "INSERT INTO platform.hotel_setup_creation_scopes(database_login) VALUES ('x')"
expect_runtime_denied "SELECT count(*) FROM platform.hotel_setup_creation_scopes"
expect_runtime_denied "SELECT count(*) FROM hotel_catalog.hotel_setup_effective_creation_scopes"
expect_runtime_denied "INSERT INTO platform.production_cutover_runs(id) VALUES ('00000000-0000-4000-8000-000000000105')"
expect_runtime_denied "INSERT INTO platform.schema_migrations(name) VALUES ('9999')"
expect_runtime_denied "UPDATE booking.pricing_authority_heads SET revision = 1 WHERE false"
expect_runtime_denied "INSERT INTO marketplace.affiliate_click_occurrences(id) VALUES ('00000000-0000-4000-8000-000000000106')"
expect_runtime_denied "INSERT INTO finance.expense_generation_dispatches(id) VALUES ('00000000-0000-4000-8000-000000000107')"
expect_runtime_denied "UPDATE platform.product_audit_events SET id = id WHERE false"
expect_runtime_denied "DELETE FROM platform.domain_events WHERE false"
expect_runtime_denied "DELETE FROM hotel_catalog.properties WHERE false"
expect_runtime_denied "SELECT setval('booking.fixture_sequence', 1)"
expect_runtime_denied "SELECT authority_payload FROM platform.legacy_owner_bootstrap_receipts LIMIT 0"
runtime_psql "SELECT owner_user_ids FROM platform.legacy_owner_bootstrap_receipts LIMIT 0" >/dev/null
[[ "$(owner_psql "SELECT count(*) FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
  WHERE n.nspname IN ('hotel_catalog','booking','pms','marketplace','distribution','finance','platform') AND d.defaclobjtype = 'r'")" == 7 ]]

run_grant legacy_owner owner 1 revoke_product_dml | grep -F '"grant":"revoke_product_dml"' >/dev/null
expect_runtime_denied "INSERT INTO hotel_catalog.property_setup_step_drafts(id) VALUES ('00000000-0000-4000-8000-000000000108')"
expect_runtime_denied "SELECT name FROM identity.organizations FOR SHARE"
runtime_psql "INSERT INTO booking.guest_bookings(id) VALUES ('00000000-0000-4000-8000-000000000109')" >/dev/null
runtime_psql "SELECT count(*) FROM hotel_catalog.property_setup_step_drafts" >/dev/null
[[ "$(owner_psql "SELECT count(*) FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
  WHERE n.nspname IN ('hotel_catalog','booking','pms','marketplace','distribution','finance','platform')")" == 0 ]]
run_preflight | grep -F '"posture":"legacy"' >/dev/null
VAYADA_DB_REQUIRE_PRODUCT_DML=1 expect_failure runtime_product_dml_required

echo "PostgreSQL ${postgres_version} runtime preflight integration passed"
