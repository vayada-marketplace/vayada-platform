#!/usr/bin/env bash
# VAY-2056 step 6a/6c: exercise retire-hotel-setup-database-roles.mjs against a disposable
# PostgreSQL with a non-superuser CREATEROLE vayada_admin, as on RDS.
set -euo pipefail

version="${1:?usage: test-retire-hotel-setup-database-roles.sh <16|17>}"
[[ "${version}" == "16" || "${version}" == "17" ]] || exit 2
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
suffix="${RANDOM}${RANDOM}"
network="vayada-hotel-setup-roles-${suffix}"
database="vayada-hotel-setup-roles-pg-${suffix}"
modules="vayada-hotel-setup-roles-node-${suffix}"
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
  --network-alias vayada-hotel-setup-roles-db --env POSTGRES_PASSWORD=postgres \
  "postgres:${version}" >/dev/null
for _ in {1..30}; do
  docker exec "${database}" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec "${database}" pg_isready -h 127.0.0.1 -U postgres >/dev/null
sql() { docker exec -i "${database}" psql -U "${2:-postgres}" -d "${1}" -v ON_ERROR_STOP=1 -Atq; }
login=vayada_next_hotel_setup_logo_37f915790bff5732_072438f4e0a8

sql postgres <<'SQL'
CREATE ROLE vayada_admin LOGIN CREATEROLE PASSWORD 'admin';
GRANT pg_signal_backend TO vayada_admin;
CREATE ROLE vayada_target_prod_user LOGIN PASSWORD 'owner';
CREATE DATABASE vayada_target_prod OWNER vayada_admin;
SQL
# vayada_admin creates the parents and logins (PostgreSQL 16+ gives it ADMIN OPTION on them).
sql vayada_target_prod vayada_admin <<SQL
CREATE ROLE vayada_next_hotel_setup_scope NOLOGIN NOINHERIT;
CREATE ROLE vayada_next_hotel_setup_logo_scope NOLOGIN NOINHERIT;
CREATE ROLE ${login} LOGIN PASSWORD 'logo';
CREATE ROLE vayada_next_hotel_setup_reader LOGIN PASSWORD 'reader';
GRANT CONNECT ON DATABASE vayada_target_prod TO ${login}, vayada_next_hotel_setup_reader;
SQL
sql postgres <<SQL
GRANT vayada_next_hotel_setup_logo_scope TO ${login} WITH INHERIT TRUE, SET FALSE;
GRANT CREATE ON DATABASE vayada_target_prod TO vayada_target_prod_user;
SQL
sql vayada_target_prod vayada_target_prod_user <<SQL
CREATE SCHEMA hotel_catalog;
CREATE TABLE hotel_catalog.property_media (id int PRIMARY KEY, logo text);
CREATE FUNCTION hotel_catalog.helper() RETURNS int LANGUAGE sql AS 'SELECT 1';
ALTER TABLE hotel_catalog.property_media ENABLE ROW LEVEL SECURITY;
CREATE POLICY hotel_setup_logo_access ON hotel_catalog.property_media TO vayada_next_hotel_setup_logo_scope USING (true);
CREATE POLICY hotel_setup_logo_guard ON hotel_catalog.property_media AS RESTRICTIVE
  USING (NOT pg_has_role(session_user, 'vayada_next_hotel_setup_logo_scope', 'MEMBER'));
GRANT USAGE ON SCHEMA hotel_catalog TO vayada_next_hotel_setup_logo_scope, vayada_admin;
GRANT EXECUTE ON FUNCTION hotel_catalog.helper() TO vayada_next_hotel_setup_scope;
GRANT SELECT (logo) ON hotel_catalog.property_media TO ${login};
GRANT SELECT, UPDATE (logo) ON hotel_catalog.property_media TO vayada_admin WITH GRANT OPTION;
GRANT DELETE ON hotel_catalog.property_media TO vayada_admin WITH GRANT OPTION;
SQL
sql vayada_target_prod vayada_admin <<SQL
GRANT UPDATE (logo) ON hotel_catalog.property_media TO ${login};
GRANT DELETE ON hotel_catalog.property_media TO ${login};
SQL

docker run --rm --volume "${modules}:/work" --workdir /work node:22-bookworm \
  sh -c 'npm init -y >/dev/null && npm install --silent --no-audit --no-fund pg@8.16.3'
cp "${root}/scripts/retire-hotel-setup-database-roles.mjs" "${work}/retire.mjs"
run() {
  docker run --rm --network "${network}" --volume "${modules}:/work" \
    --volume "${work}/retire.mjs:/work/retire.mjs:ro" --workdir /work \
    --env "TARGET_DATABASE_ADMIN_URL=postgresql://vayada_admin:admin@vayada-hotel-setup-roles-db:5432/postgres" \
    --env VAYADA_HOTEL_SETUP_ROLES_LOCAL_FIXTURE=1 --env "VAYADA_HOTEL_SETUP_ROLES_STEP=$1" \
    --env "VAYADA_HOTEL_SETUP_ROLES_PHASE=$2" --env "VAYADA_HOTEL_SETUP_ROLES_FROZEN=${3:-}" \
    node:22-bookworm node retire.mjs 2>&1
}
field() { jq -r "$1" <<<"$2"; }
expect_fail() {
  local output
  if output="$(run "$@")"; then echo "unexpected success: $*: ${output}" >&2; exit 1; fi
  printf '%s' "${output}"
}

# A login vayada_admin did not create has no ADMIN OPTION: disable must refuse to plan it.
sql postgres <<'SQL'
CREATE ROLE vayada_next_hotel_setup_org_unadministered_0001 LOGIN PASSWORD 'org';
SQL
plan="$(run disable inspect)"
[[ "$(field .status "${plan}")" == PLAN && "$(field .ready "${plan}")" == false ]]
field '.blockers[]' "${plan}" | grep -Fx hotel_setup_roles_admin_option_missing >/dev/null
expect_fail disable apply "$(field .fingerprint "${plan}")" | grep -F '"code":"hotel_setup_roles_admin_option_missing"' >/dev/null
sql postgres <<<'DROP ROLE vayada_next_hotel_setup_org_unadministered_0001;'

# Disable: plan, refuse a changed state, then apply the exact plan.
plan="$(run disable inspect)"
[[ "$(field .ready "${plan}")" == true && "$(field .adminGrants "${plan}")" -ge 4 ]]
[[ "$(field '.adminGrantList | length' "${plan}")" == "$(field .adminGrants "${plan}")" ]]
field '.adminGrantList[] | @tsv' "${plan}" | grep -F "database	vayada_target_prod		${login}	CONNECT" >/dev/null
field '.adminGrantList[] | @tsv' "${plan}" | grep -F "column	hotel_catalog.property_media	logo	${login}	UPDATE" >/dev/null
frozen="$(field .fingerprint "${plan}")"
expect_fail disable apply "$(printf '%064d' 0)" | grep -F '"code":"hotel_setup_roles_plan_changed"' >/dev/null
sql vayada_target_prod vayada_admin <<<"GRANT TEMPORARY ON DATABASE vayada_target_prod TO vayada_next_hotel_setup_reader;"
expect_fail disable apply "${frozen}" | grep -F '"code":"hotel_setup_roles_plan_changed"' >/dev/null
# A live session of the login is ended after the commit.
docker exec -d --env PGPASSWORD=logo "${database}" \
  psql -h 127.0.0.1 -U "${login}" -d vayada_target_prod -c 'SELECT pg_sleep(120)'
for _ in {1..20}; do
  [[ "$(sql postgres <<<"SELECT count(*) FROM pg_stat_activity WHERE usename = '${login}'")" == 1 ]] && break
  sleep 0.5
done
plan="$(run disable inspect)"
result="$(run disable apply "$(field .fingerprint "${plan}")")"
[[ "$(field .status "${result}")" == PASS && "$(field .adminGrants "${result}")" == 0 ]]
[[ "$(sql postgres <<<"SELECT count(*) FROM pg_roles WHERE rolname LIKE 'vayada\_next\_hotel\_setup\_%' AND rolcanlogin")" == 0 ]]
[[ "$(sql postgres <<<"SELECT count(*) FROM pg_stat_activity WHERE usename = '${login}'")" == 0 ]]
# The migration owner's grants stay for app migration 0474.
[[ "$(sql vayada_target_prod <<<"SELECT has_column_privilege('${login}', 'hotel_catalog.property_media', 'logo', 'SELECT')")" == t ]]
[[ "$(sql vayada_target_prod <<<"SELECT has_table_privilege('${login}', 'hotel_catalog.property_media', 'DELETE')")" == f ]]

# Drop before 0474: the roles are still granted and still named by a policy.
plan="$(run drop inspect)"
[[ "$(field .ready "${plan}")" == false ]]
field '.blockers[]' "${plan}" | grep -Fx hotel_setup_roles_dependencies_remaining >/dev/null
field '.blockers[]' "${plan}" | grep -Fx hotel_setup_roles_still_referenced >/dev/null
expect_fail drop apply "$(field .fingerprint "${plan}")" | grep -F '"status":"FAIL"' >/dev/null

# What 0474 does as the migration owner, then the drop.
sql vayada_target_prod vayada_target_prod_user <<SQL
DROP POLICY hotel_setup_logo_access ON hotel_catalog.property_media;
DROP POLICY hotel_setup_logo_guard ON hotel_catalog.property_media;
REVOKE ALL ON SCHEMA hotel_catalog FROM vayada_next_hotel_setup_logo_scope;
REVOKE ALL ON FUNCTION hotel_catalog.helper() FROM vayada_next_hotel_setup_scope;
REVOKE ALL (logo) ON hotel_catalog.property_media FROM ${login};
SQL
plan="$(run drop inspect)"
[[ "$(field .ready "${plan}")" == true ]]
result="$(run drop apply "$(field .fingerprint "${plan}")")"
[[ "$(field .status "${result}")" == PASS && "$(field '.roles | length' "${result}")" == 0 ]]
[[ "$(sql postgres <<<"SELECT count(*) FROM pg_roles WHERE rolname LIKE 'vayada\_next\_hotel\_setup\_%'")" == 0 ]]
plan="$(run drop inspect)"
field '.blockers[]' "${plan}" | grep -Fx hotel_setup_roles_already_retired >/dev/null
echo "hotel setup role retirement passed on PostgreSQL ${version}"
