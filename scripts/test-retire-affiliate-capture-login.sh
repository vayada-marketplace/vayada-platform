#!/usr/bin/env bash
# VAY-2272: exercise retire-affiliate-capture-login.mjs against a disposable PostgreSQL with a
# non-superuser CREATEROLE vayada_admin, as on RDS.
set -euo pipefail

version="${1:?usage: test-retire-affiliate-capture-login.sh <16|17>}"
[[ "${version}" == "16" || "${version}" == "17" ]] || exit 2
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
suffix="${RANDOM}${RANDOM}"
network="vayada-affiliate-capture-login-${suffix}"
database="vayada-affiliate-capture-login-pg-${suffix}"
modules="vayada-affiliate-capture-login-node-${suffix}"
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
  --network-alias vayada-affiliate-capture-login-db --env POSTGRES_PASSWORD=postgres \
  "ghcr.io/vayada-marketplace/ci-postgres:${version}" >/dev/null
for _ in {1..30}; do
  docker exec "${database}" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec "${database}" pg_isready -h 127.0.0.1 -U postgres >/dev/null
sql() { docker exec -i "${database}" psql -U "${2:-postgres}" -d "${1}" -v ON_ERROR_STOP=1 -Atq; }
login=vayada_next_affiliate_capture

sql postgres <<'SQL'
CREATE ROLE vayada_admin LOGIN CREATEROLE PASSWORD 'admin';
CREATE ROLE vayada_target_prod_user LOGIN PASSWORD 'owner';
CREATE DATABASE vayada_target_prod OWNER vayada_admin;
GRANT CREATE ON DATABASE vayada_target_prod TO vayada_target_prod_user;
SQL
# vayada_admin created the login (PostgreSQL 16+ gives it ADMIN OPTION on it).
sql vayada_target_prod vayada_admin <<SQL
CREATE ROLE ${login} LOGIN PASSWORD 'capture';
GRANT CONNECT ON DATABASE vayada_target_prod TO ${login};
SQL
# What app migration 0416 and the capture functions left: a policy naming the login as text, a
# function the login may run and schema usage, all from the migration owner.
sql vayada_target_prod vayada_target_prod_user <<SQL
CREATE SCHEMA hotel_catalog;
CREATE TABLE hotel_catalog.property_slugs (id int PRIMARY KEY, slug text);
ALTER TABLE hotel_catalog.property_slugs ENABLE ROW LEVEL SECURITY;
CREATE POLICY affiliate_capture_compat ON hotel_catalog.property_slugs TO PUBLIC USING (true);
CREATE POLICY affiliate_capture_destination_lock_only ON hotel_catalog.property_slugs AS RESTRICTIVE
  FOR UPDATE TO PUBLIC USING (true) WITH CHECK (current_user <> '${login}');
CREATE FUNCTION hotel_catalog.capture() RETURNS int LANGUAGE sql AS 'SELECT 1';
GRANT USAGE ON SCHEMA hotel_catalog TO ${login}, vayada_admin;
GRANT EXECUTE ON FUNCTION hotel_catalog.capture() TO ${login};
GRANT SELECT, UPDATE ON hotel_catalog.property_slugs TO vayada_admin WITH GRANT OPTION;
SQL
# What vayada_admin gave the login: table and column privileges, and its own schema and routine.
sql vayada_target_prod vayada_admin <<SQL
GRANT SELECT, UPDATE ON hotel_catalog.property_slugs TO ${login};
GRANT SELECT (slug) ON hotel_catalog.property_slugs TO ${login};
CREATE SCHEMA capture_tools;
CREATE FUNCTION capture_tools.ping() RETURNS int LANGUAGE sql AS 'SELECT 1';
GRANT USAGE ON SCHEMA capture_tools TO ${login};
GRANT EXECUTE ON FUNCTION capture_tools.ping() TO ${login};
SQL

docker run --rm --volume "${modules}:/work" --workdir /work ghcr.io/vayada-marketplace/ci-node:22-bookworm \
  sh -c 'npm init -y >/dev/null && npm install --silent --no-audit --no-fund pg@8.16.3'
cp "${root}/scripts/retire-affiliate-capture-login.mjs" "${work}/retire.mjs"
run() {
  docker run --rm --network "${network}" --volume "${modules}:/work" \
    --volume "${work}/retire.mjs:/work/retire.mjs:ro" --workdir /work \
    --env "TARGET_DATABASE_ADMIN_URL=postgresql://vayada_admin:admin@vayada-affiliate-capture-login-db:5432/postgres" \
    --env VAYADA_AFFILIATE_CAPTURE_LOGIN_LOCAL_FIXTURE=1 --env "VAYADA_AFFILIATE_CAPTURE_LOGIN_PHASE=$1" \
    --env "VAYADA_AFFILIATE_CAPTURE_LOGIN_FROZEN=${2:-}" \
    ghcr.io/vayada-marketplace/ci-node:22-bookworm node retire.mjs 2>&1
}
field() { jq -r "$1" <<<"$2"; }
expect_fail() {
  local output
  if output="$(run "$@")"; then echo "unexpected success: $*: ${output}" >&2; exit 1; fi
  printf '%s' "${output}"
}

# Before app migration 0497: a policy still names the login and the owner's grants remain.
plan="$(run inspect)"
[[ "$(field .status "${plan}")" == PLAN && "$(field .ready "${plan}")" == false ]]
field '.blockers[]' "${plan}" | grep -Fx affiliate_capture_login_still_referenced >/dev/null
field '.blockers[]' "${plan}" | grep -Fx affiliate_capture_login_foreign_grants >/dev/null
expect_fail apply "$(field .fingerprint "${plan}")" | grep -F '"status":"FAIL"' >/dev/null

# Exactly what 0497 does as the migration owner: the owner's schema grant stays, and the plan names it.
sql vayada_target_prod vayada_target_prod_user <<SQL
ALTER POLICY affiliate_capture_compat ON hotel_catalog.property_slugs RENAME TO property_slugs_existing_access;
DROP POLICY affiliate_capture_destination_lock_only ON hotel_catalog.property_slugs;
DROP FUNCTION hotel_catalog.capture();
SQL
plan="$(run inspect)"
[[ "$(field .ready "${plan}")" == false && "$(field .references "${plan}")" == 0 ]]
field '.blockers[]' "${plan}" | grep -Fx affiliate_capture_login_foreign_grants >/dev/null
field '.otherGrantList[] | @tsv' "${plan}" |
  grep -F "schema	hotel_catalog		${login}	vayada_target_prod_user	USAGE" >/dev/null
# Its grantor revokes it.
sql vayada_target_prod vayada_target_prod_user <<<"REVOKE ALL ON SCHEMA hotel_catalog FROM ${login};"

# A role that is a member of the login, or a policy that names it as a role, blocks the drop.
sql vayada_target_prod vayada_admin <<SQL
CREATE ROLE vayada_capture_member NOLOGIN;
GRANT ${login} TO vayada_capture_member;
SQL
sql vayada_target_prod vayada_target_prod_user <<<"CREATE POLICY capture_reader ON hotel_catalog.property_slugs TO ${login} USING (true);"
plan="$(run inspect)"
field '.blockers[]' "${plan}" | grep -Fx affiliate_capture_login_has_members >/dev/null
field '.blockers[]' "${plan}" | grep -Fx affiliate_capture_login_dependencies_remaining >/dev/null
sql vayada_target_prod vayada_admin <<SQL
REVOKE ${login} FROM vayada_capture_member;
DROP ROLE vayada_capture_member;
SQL
sql vayada_target_prod vayada_target_prod_user <<<"DROP POLICY capture_reader ON hotel_catalog.property_slugs;"

plan="$(run inspect)"
[[ "$(field .ready "${plan}")" == true && "$(field .otherGrants "${plan}")" == 0 ]]
for entry in "database	vayada_target_prod		CONNECT" "relation	hotel_catalog.property_slugs		UPDATE" \
             "column	hotel_catalog.property_slugs	slug	SELECT" "schema	capture_tools		USAGE" \
             "routine	capture_tools.ping()		EXECUTE"; do
  field '.adminGrantList[] | @tsv' "${plan}" | grep -F "${entry}" >/dev/null
done
frozen="$(field .fingerprint "${plan}")"
expect_fail apply "$(printf '%064d' 0)" | grep -F '"code":"affiliate_capture_login_plan_changed"' >/dev/null
sql vayada_target_prod vayada_admin <<<"GRANT TEMPORARY ON DATABASE vayada_target_prod TO ${login};"
expect_fail apply "${frozen}" | grep -F '"code":"affiliate_capture_login_plan_changed"' >/dev/null

# A live session blocks the drop.
docker exec -d --env PGPASSWORD=capture "${database}" \
  psql -h 127.0.0.1 -U "${login}" -d vayada_target_prod -c 'SELECT pg_sleep(120)'
for _ in {1..20}; do
  [[ "$(sql postgres <<<"SELECT count(*) FROM pg_stat_activity WHERE usename = '${login}'")" == 1 ]] && break
  sleep 0.5
done
plan="$(run inspect)"
field '.blockers[]' "${plan}" | grep -Fx affiliate_capture_login_sessions_active >/dev/null
expect_fail apply "$(field .fingerprint "${plan}")" | grep -F '"code":"affiliate_capture_login_sessions_active"' >/dev/null
sql postgres <<<"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${login}';" >/dev/null
for _ in {1..20}; do
  [[ "$(sql postgres <<<"SELECT count(*) FROM pg_stat_activity WHERE usename = '${login}'")" == 0 ]] && break
  sleep 0.5
done

# The drop: revoke vayada_admin's grants and drop the login in one transaction.
plan="$(run inspect)"
[[ "$(field .ready "${plan}")" == true ]]
result="$(run apply "$(field .fingerprint "${plan}")")"
[[ "$(field .status "${result}")" == PASS && "$(field .login "${result}")" == null ]]
[[ "$(sql postgres <<<"SELECT count(*) FROM pg_roles WHERE rolname = '${login}'")" == 0 ]]
# The renamed policy that every login reads through stays, and so do vayada_admin's own objects.
[[ "$(sql vayada_target_prod <<<"SELECT count(*) FROM pg_policy WHERE polname = 'property_slugs_existing_access'")" == 1 ]]
[[ "$(sql vayada_target_prod <<<"SELECT count(*) FROM pg_proc WHERE proname = 'ping' AND pronamespace = 'capture_tools'::regnamespace")" == 1 ]]
plan="$(run inspect)"
field '.blockers[]' "${plan}" | grep -Fx affiliate_capture_login_already_retired >/dev/null
echo "affiliate capture login retirement passed on PostgreSQL ${version}"
