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

docker network create "${network}" >/dev/null
docker volume create "${node_modules_container}" >/dev/null
docker run --detach --rm \
  --name "${database_container}" \
  --network "${network}" \
  --network-alias vayada-db-preflight \
  --env POSTGRES_PASSWORD=postgres \
  "postgres:${postgres_version}" >/dev/null

for _ in {1..30}; do
  if docker exec "${database_container}" pg_isready -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "${database_container}" pg_isready -U postgres >/dev/null

docker exec -i "${database_container}" psql -v ON_ERROR_STOP=1 -U postgres <<'SQL'
CREATE ROLE legacy_owner LOGIN PASSWORD 'owner';
CREATE ROLE vayada_next_api_runtime LOGIN PASSWORD 'runtime'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE elevated NOLOGIN;
REVOKE CREATE, TEMPORARY ON DATABASE postgres FROM PUBLIC;
GRANT CONNECT ON DATABASE postgres TO vayada_next_api_runtime;

CREATE SCHEMA platform AUTHORIZATION legacy_owner;
CREATE SCHEMA app AUTHORIZATION legacy_owner;
CREATE SCHEMA booking AUTHORIZATION legacy_owner;
CREATE SCHEMA finance AUTHORIZATION legacy_owner;
CREATE SCHEMA pms AUTHORIZATION legacy_owner;
CREATE SCHEMA marketplace AUTHORIZATION legacy_owner;
CREATE SCHEMA vayada_migration_evidence AUTHORIZATION legacy_owner;
REVOKE ALL ON SCHEMA platform, app, booking, finance, pms, marketplace, vayada_migration_evidence FROM PUBLIC;
GRANT USAGE ON SCHEMA platform, app, booking, finance, pms, marketplace, vayada_migration_evidence
  TO vayada_next_api_runtime;

SET ROLE legacy_owner;
CREATE TABLE platform.legacy_owner_bootstrap_receipts (
  owner_user_ids text[] NOT NULL,
  authority_payload jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE app.hotel (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text);
CREATE TABLE booking.guest_bookings (id uuid PRIMARY KEY);
CREATE TABLE finance.payments (id uuid PRIMARY KEY);
CREATE TABLE platform.external_webhook_events (id uuid PRIMARY KEY);
CREATE TABLE platform.idempotency_keys (id uuid PRIMARY KEY);
CREATE TABLE platform.product_audit_events (id uuid PRIMARY KEY);
CREATE TABLE pms.channel_connections (id uuid PRIMARY KEY);
CREATE TABLE marketplace.affiliate_links (id uuid PRIMARY KEY);
CREATE TABLE marketplace.affiliate_agreement_lifecycle_events (id uuid PRIMARY KEY);
CREATE TABLE platform.legacy_owner_approval_records (id uuid PRIMARY KEY);
CREATE TABLE platform.legacy_owner_approval_revocations (id uuid PRIMARY KEY);
CREATE TABLE pms.inventory_coverage_validation_queue (id uuid PRIMARY KEY);
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
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.idempotency_keys
  TO vayada_next_api_runtime;
GRANT SELECT ON platform.product_audit_events
  TO vayada_next_api_runtime;
GRANT SELECT ON platform.legacy_owner_approval_records,
  platform.legacy_owner_approval_revocations TO vayada_next_api_runtime;
GRANT EXECUTE ON FUNCTION app.hotel_count() TO vayada_next_api_runtime;
REVOKE ALL ON FUNCTION app.owner_only() FROM PUBLIC;
GRANT USAGE ON TYPE app.hotel_state TO vayada_next_api_runtime;
SQL

docker run --rm \
  --volume "${node_modules_container}:/work" \
  --workdir /work node:22-bookworm \
  sh -c 'npm init -y >/dev/null && npm install --silent --no-audit --no-fund pg@8.16.3'
cp "${root}/scripts/target-database-runtime-preflight.mjs" "${work}/preflight.mjs"
cp "${root}/scripts/grant-target-database-product-audit-insert.mjs" "${work}/grant.mjs"

run_grant() {
  local database_role="$1"
  local database_password="$2"
  local fixture_flag="${3:-1}"
  local grant_scope="${4:-audit_insert}"
  docker run --rm \
    --network "${network}" \
    --volume "${node_modules_container}:/work" \
    --volume "${work}/grant.mjs:/work/grant.mjs:ro" \
    --workdir /work \
    --env "TARGET_DATABASE_MIGRATION_URL=postgresql://${database_role}:${database_password}@vayada-db-preflight:5432/postgres" \
    --env "VAYADA_AUDIT_GRANT_LOCAL_FIXTURE=${fixture_flag}" \
    --env "VAYADA_DB_GRANT_SCOPE=${grant_scope}" \
    node:22-bookworm node grant.mjs
}

run_preflight() {
  docker run --rm \
    --network "${network}" \
    --volume "${node_modules_container}:/work" \
    --volume "${work}/preflight.mjs:/work/preflight.mjs:ro" \
    --workdir /work \
    --env "TARGET_DATABASE_URL=postgresql://vayada_next_api_runtime:runtime@${database_container}:5432/postgres" \
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

if untrusted_host_output="$(run_grant legacy_owner owner 0 2>&1)"; then
  echo "non-RDS grant without explicit test fixture unexpectedly passed" >&2
  exit 1
fi
grep -F '"code":"unexpected_database_host"' <<<"${untrusted_host_output}" >/dev/null

if ambiguous_tls_output="$(docker run --rm \
  --volume "${node_modules_container}:/work" \
  --volume "${work}/grant.mjs:/work/grant.mjs:ro" \
  --workdir /work \
  --env 'TARGET_DATABASE_MIGRATION_URL=postgresql://legacy_owner:owner@vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com:5432/postgres?sslmode=require&ssl=0' \
  --env VAYADA_DB_RDS_CA_BUNDLE=test-ca \
  node:22-bookworm node grant.mjs 2>&1)"; then
  echo "conflicting TLS parameter unexpectedly passed" >&2
  exit 1
fi
grep -F '"code":"unsupported_connection_parameters"' <<<"${ambiguous_tls_output}" >/dev/null

if override_host_output="$(docker run --rm \
  --volume "${node_modules_container}:/work" \
  --volume "${work}/grant.mjs:/work/grant.mjs:ro" \
  --workdir /work \
  --env 'TARGET_DATABASE_MIGRATION_URL=postgresql://legacy_owner:owner@vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com:5432/postgres?sslmode=require&host=elsewhere.example.test' \
  --env VAYADA_DB_RDS_CA_BUNDLE=test-ca \
  node:22-bookworm node grant.mjs 2>&1)"; then
  echo "overridden database host unexpectedly passed" >&2
  exit 1
fi
grep -F '"code":"unsupported_connection_parameters"' <<<"${override_host_output}" >/dev/null

if non_owner_output="$(run_grant vayada_next_api_runtime runtime 2>&1)"; then
  echo "non-owner audit grant unexpectedly passed" >&2
  exit 1
fi
grep -F '"code":"audit_table_owner_required"' <<<"${non_owner_output}" >/dev/null
run_grant legacy_owner owner | grep -F '"status":"PASS"' >/dev/null

expect_failure runtime_relation_read_missing
if affiliate_non_owner_output="$(run_grant vayada_next_api_runtime runtime 1 affiliate_read 2>&1)"; then
  echo "non-owner affiliate read grant unexpectedly passed" >&2
  exit 1
fi
grep -F '"code":"affiliate_table_owner_required"' <<<"${affiliate_non_owner_output}" >/dev/null
run_grant legacy_owner owner 1 affiliate_read | grep -F '"grant":"affiliate_tables:SELECT"' >/dev/null

docker exec "${database_container}" psql -U postgres -c \
  "GRANT INSERT ON marketplace.affiliate_links TO vayada_next_api_runtime" >/dev/null
if affiliate_broad_output="$(run_grant legacy_owner owner 1 affiliate_read 2>&1)"; then
  echo "affiliate read grant unexpectedly passed with write privilege" >&2
  exit 1
fi
grep -F '"code":"affiliate_runtime_write_scope_too_broad"' <<<"${affiliate_broad_output}" >/dev/null
docker exec "${database_container}" psql -U postgres -c \
  "REVOKE INSERT ON marketplace.affiliate_links FROM vayada_next_api_runtime" >/dev/null

docker exec "${database_container}" psql -U postgres -c \
  "GRANT UPDATE (id) ON marketplace.affiliate_agreement_lifecycle_events TO vayada_next_api_runtime" >/dev/null
if affiliate_column_output="$(run_grant legacy_owner owner 1 affiliate_read 2>&1)"; then
  echo "affiliate read grant unexpectedly passed with column write privilege" >&2
  exit 1
fi
grep -F '"code":"affiliate_runtime_write_scope_too_broad"' <<<"${affiliate_column_output}" >/dev/null
docker exec "${database_container}" psql -U postgres -c \
  "REVOKE UPDATE (id) ON marketplace.affiliate_agreement_lifecycle_events FROM vayada_next_api_runtime" >/dev/null

docker exec -e PGPASSWORD=runtime "${database_container}" \
  psql -U vayada_next_api_runtime -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT count(*) FROM marketplace.affiliate_links" >/dev/null
docker exec -e PGPASSWORD=runtime "${database_container}" \
  psql -U vayada_next_api_runtime -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT count(*) FROM marketplace.affiliate_agreement_lifecycle_events" >/dev/null
if docker exec -e PGPASSWORD=runtime "${database_container}" \
  psql -U vayada_next_api_runtime -d postgres -v ON_ERROR_STOP=1 \
  -c "INSERT INTO marketplace.affiliate_links(id) VALUES ('00000000-0000-0000-0000-000000000001')" \
  >/dev/null 2>&1; then
  echo "runtime role unexpectedly wrote an affiliate link" >&2
  exit 1
fi

expect_grant_scope_failure() {
  local output
  if output="$(run_grant legacy_owner owner 2>&1)"; then
    echo "audit grant unexpectedly passed with forbidden privilege" >&2
    exit 1
  fi
  grep -F '"code":"audit_runtime_write_scope_too_broad"' <<<"${output}" >/dev/null
}

docker exec "${database_container}" psql -U postgres -c \
  "GRANT TRUNCATE ON platform.product_audit_events TO vayada_next_api_runtime" >/dev/null
expect_grant_scope_failure
docker exec "${database_container}" psql -U postgres -c \
  "REVOKE TRUNCATE ON platform.product_audit_events FROM vayada_next_api_runtime" >/dev/null

docker exec "${database_container}" psql -U postgres -c \
  "GRANT UPDATE (id) ON platform.product_audit_events TO vayada_next_api_runtime" >/dev/null
expect_grant_scope_failure
docker exec "${database_container}" psql -U postgres -c \
  "REVOKE UPDATE (id) ON platform.product_audit_events FROM vayada_next_api_runtime" >/dev/null

if [[ "${postgres_version}" == "17" ]]; then
  docker exec "${database_container}" psql -U postgres -c \
    "GRANT MAINTAIN ON platform.product_audit_events TO vayada_next_api_runtime" >/dev/null
  expect_grant_scope_failure
  docker exec "${database_container}" psql -U postgres -c \
    "REVOKE MAINTAIN ON platform.product_audit_events FROM vayada_next_api_runtime" >/dev/null
fi

run_preflight | grep -F '"status":"PASS"' >/dev/null

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

echo "PostgreSQL ${postgres_version} runtime preflight integration passed"
