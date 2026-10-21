#!/usr/bin/env bash
# VAY-2247: exercise set-api-runtime-timeouts.mjs against a disposable PostgreSQL with a non-superuser
# CREATEROLE vayada_admin, as on RDS: inspect, apply, the defaults in a new session, rollback, drift and
# a login vayada_admin may not change.
set -euo pipefail

version="${1:?usage: test-set-api-runtime-timeouts.sh <16|17>}"
[[ "${version}" == "16" || "${version}" == "17" ]] || exit 2
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
suffix="${RANDOM}${RANDOM}"
network="vayada-api-runtime-timeouts-${suffix}"
database="vayada-api-runtime-timeouts-pg-${suffix}"
modules="vayada-api-runtime-timeouts-node-${suffix}"
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
  --network-alias vayada-api-runtime-timeouts-db --env POSTGRES_PASSWORD=postgres \
  "ghcr.io/vayada-marketplace/ci-postgres:${version}" >/dev/null
for _ in {1..30}; do
  docker exec "${database}" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec "${database}" pg_isready -h 127.0.0.1 -U postgres >/dev/null
sql() { docker exec -i "${database}" psql -U "${2:-postgres}" -d "${1}" -v ON_ERROR_STOP=1 -Atq; }
login=vayada_next_api_runtime

sql postgres <<'SQL'
CREATE ROLE vayada_admin LOGIN CREATEROLE PASSWORD 'admin';
CREATE DATABASE vayada_target_prod OWNER vayada_admin;
CREATE DATABASE vayada_other OWNER vayada_admin;
SQL
# vayada_admin created the login (PostgreSQL 16+ gives it ADMIN OPTION on it).
sql vayada_target_prod vayada_admin <<SQL
CREATE ROLE ${login} LOGIN PASSWORD 'runtime';
GRANT CONNECT ON DATABASE vayada_target_prod, vayada_other TO ${login};
SQL

docker run --rm --volume "${modules}:/work" --workdir /work ghcr.io/vayada-marketplace/ci-node:22-bookworm \
  sh -c 'npm init -y >/dev/null && npm install --silent --no-audit --no-fund pg@8.16.3'
cp "${root}/scripts/set-api-runtime-timeouts.mjs" "${work}/timeouts.mjs"
run() {
  docker run --rm --network "${network}" --volume "${modules}:/work" \
    --volume "${work}/timeouts.mjs:/work/timeouts.mjs:ro" --workdir /work \
    --env "TARGET_DATABASE_ADMIN_URL=postgresql://vayada_admin:admin@vayada-api-runtime-timeouts-db:5432/postgres" \
    --env VAYADA_API_RUNTIME_TIMEOUTS_LOCAL_FIXTURE=1 --env "VAYADA_API_RUNTIME_TIMEOUTS_PHASE=$1" \
    --env "VAYADA_API_RUNTIME_TIMEOUTS_FROZEN=${2:-}" \
    ghcr.io/vayada-marketplace/ci-node:22-bookworm node timeouts.mjs 2>&1
}
field() { jq -r "$1" <<<"$2"; }
expect_fail() {
  local output
  if output="$(run "$@")"; then echo "unexpected success: $*: ${output}" >&2; exit 1; fi
  printf '%s' "${output}"
}
# What a new session of the login gets in a database.
shown() {
  docker exec --env PGPASSWORD=runtime "${database}" psql -h 127.0.0.1 -U "${login}" -d "$1" -Atq \
    -c "SELECT current_setting('lock_timeout') || ' ' || current_setting('idle_in_transaction_session_timeout')"
}

# Nothing set yet: ready to apply, nothing to roll back.
plan="$(run inspect)"
[[ "$(field .status "${plan}")" == PLAN && "$(field .readyToApply "${plan}")" == true ]]
[[ "$(field .readyToRollback "${plan}")" == false && "$(field .current.lock_timeout "${plan}")" == null ]]
field '.rollbackBlockers[]' "${plan}" | grep -Fx api_runtime_timeouts_not_applied >/dev/null
[[ "$(shown vayada_target_prod)" == "0 0" ]]
expect_fail rollback "$(field .fingerprint "${plan}")" | grep -F '"code":"api_runtime_timeouts_not_applied"' >/dev/null

# A wrong fingerprint, or a change since inspect, refuses and changes nothing.
frozen="$(field .fingerprint "${plan}")"
expect_fail apply "$(printf '%064d' 0)" | grep -F '"code":"api_runtime_timeouts_plan_changed"' >/dev/null
sql vayada_target_prod vayada_admin <<<"ALTER ROLE ${login} IN DATABASE vayada_target_prod SET statement_timeout = '30s';"
expect_fail apply "${frozen}" | grep -F '"code":"api_runtime_timeouts_plan_changed"' >/dev/null
[[ "$(shown vayada_target_prod)" == "0 0" ]]

# Apply: both defaults in this database only; the other setting stays.
plan="$(run inspect)"
field '.otherDatabaseDefaults[]' "${plan}" | grep -Fx statement_timeout >/dev/null
result="$(run apply "$(field .fingerprint "${plan}")")"
[[ "$(field .status "${result}")" == PASS && "$(field .current.lock_timeout "${result}")" == 10s ]]
[[ "$(field .current.idle_in_transaction_session_timeout "${result}")" == 10min ]]
[[ "$(shown vayada_target_prod)" == "10s 10min" ]]
[[ "$(shown vayada_other)" == "0 0" ]]
[[ "$(sql vayada_target_prod <<<"SELECT current_setting('statement_timeout') FROM (SELECT 1) x")" == "0" ]]
plan="$(run inspect)"
[[ "$(field .readyToApply "${plan}")" == false && "$(field .readyToRollback "${plan}")" == true ]]
field '.applyBlockers[]' "${plan}" | grep -Fx api_runtime_timeouts_already_applied >/dev/null

# Rollback: both defaults reset; the unrelated statement_timeout stays.
result="$(run rollback "$(field .fingerprint "${plan}")")"
[[ "$(field .status "${result}")" == PASS && "$(field .current.lock_timeout "${result}")" == null ]]
[[ "$(shown vayada_target_prod)" == "0 0" ]]
[[ "$(sql vayada_target_prod <<<"SELECT array_to_string(setconfig, ',') FROM pg_db_role_setting WHERE setrole = '${login}'::regrole")" == "statement_timeout=30s" ]]

# A login vayada_admin holds no ADMIN OPTION on is refused before anything changes.
sql vayada_target_prod vayada_admin <<<"REVOKE CONNECT ON DATABASE vayada_target_prod, vayada_other FROM ${login};"
sql postgres <<SQL
DROP ROLE ${login};
CREATE ROLE ${login} LOGIN PASSWORD 'runtime';
SQL
plan="$(run inspect)"
[[ "$(field .readyToApply "${plan}")" == false && "$(field .login.adminOption "${plan}")" == false ]]
field '.applyBlockers[]' "${plan}" | grep -Fx api_runtime_timeouts_admin_option_missing >/dev/null
expect_fail apply "$(field .fingerprint "${plan}")" | grep -F '"code":"api_runtime_timeouts_admin_option_missing"' >/dev/null
sql postgres <<<"DROP ROLE ${login};"
plan="$(run inspect)"
field '.applyBlockers[]' "${plan}" | grep -Fx api_runtime_timeouts_login_missing >/dev/null
echo "API runtime login timeouts passed on PostgreSQL ${version}"
