#!/usr/bin/env bash
set -euo pipefail

version="${1:?usage: test-target-database-cluster-acl.sh <16|17>}"
[[ "${version}" == "16" || "${version}" == "17" ]] || exit 2
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
suffix="${RANDOM}${RANDOM}"
network="vayada-cluster-acl-${suffix}"
database="vayada-cluster-acl-pg-${suffix}"
modules="vayada-cluster-acl-node-${suffix}"
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
  --network-alias vayada-cluster-acl-db --env POSTGRES_PASSWORD=postgres \
  "postgres:${version}" >/dev/null
for _ in {1..30}; do
  docker exec "${database}" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec "${database}" pg_isready -U postgres >/dev/null
docker exec -i "${database}" psql -U postgres -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
CREATE ROLE cluster_admin LOGIN CREATEDB CREATEROLE PASSWORD 'admin';
ALTER DATABASE postgres OWNER TO cluster_admin;
ALTER DATABASE template1 OWNER TO cluster_admin;
REVOKE CREATE, TEMPORARY ON DATABASE template1 FROM PUBLIC;
CREATE ROLE service_owner;
GRANT service_owner TO cluster_admin;
CREATE ROLE service_user LOGIN PASSWORD 'service';
CREATE ROLE blocked_user LOGIN PASSWORD 'blocked';
CREATE DATABASE service_db OWNER service_owner;
GRANT CONNECT ON DATABASE service_db TO service_user;
CREATE DATABASE vayada_target_prod OWNER cluster_admin;
REVOKE CONNECT, CREATE, TEMPORARY ON DATABASE vayada_target_prod FROM PUBLIC;
CREATE DATABASE unexpected_db OWNER cluster_admin;
SQL
docker run --rm --volume "${modules}:/work" --workdir /work node:22-bookworm \
  sh -c 'npm init -y >/dev/null && npm install --silent --no-audit --no-fund pg@8.16.3'
cp "${root}/scripts/harden-target-database-cluster-acl.mjs" "${work}/harden.mjs"
run_harden() {
  docker run --rm --network "${network}" --volume "${modules}:/work" \
    --volume "${work}/harden.mjs:/work/harden.mjs:ro" --workdir /work \
    --env "TARGET_DATABASE_ADMIN_URL=postgresql://cluster_admin:admin@vayada-cluster-acl-db:5432/vayada_target_prod" \
    --env VAYADA_CLUSTER_ACL_LOCAL_FIXTURE=1 node:22-bookworm node harden.mjs
}

if output="$(run_harden 2>&1)"; then
  echo 'hardening unexpectedly accepted database ACL drift' >&2
  exit 1
fi
grep -F '"code":"cluster_database_acl_unexpected"' <<<"${output}" >/dev/null
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'DROP DATABASE unexpected_db' >/dev/null
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE dormant_user LOGIN PASSWORD 'dormant'" >/dev/null
if output="$(run_harden 2>&1)"; then
  echo 'hardening unexpectedly accepted an unclassified login role' >&2
  exit 1
fi
grep -F '"code":"cluster_database_acl_login_roles_unexpected"' <<<"${output}" >/dev/null
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'DROP ROLE dormant_user' >/dev/null
if output="$(run_harden 2>&1)"; then
  echo 'hardening unexpectedly removed required service temporary access' >&2
  exit 1
fi
grep -F '"code":"cluster_database_acl_effective_access_unexpected"' <<<"${output}" >/dev/null
docker exec "${database}" psql -U postgres -Atqc \
  "SELECT EXISTS (SELECT 1 FROM pg_database d CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) a WHERE d.datname = 'service_db' AND a.grantee = 0 AND a.privilege_type = 'CONNECT')" \
  | grep -Fx t >/dev/null
docker exec "${database}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'GRANT TEMPORARY ON DATABASE service_db TO service_user' >/dev/null
run_harden | grep -F '"changed":true' >/dev/null
docker exec "${database}" psql -U postgres -Atqc \
  "SELECT count(*) FROM pg_database d CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) a WHERE d.datallowconn AND a.grantee = 0 AND (a.privilege_type IN ('CONNECT', 'CREATE', 'TEMPORARY'))" \
  | grep -Fx 0 >/dev/null
docker run --rm --network "${network}" --env PGPASSWORD=service postgres:"${version}" \
  psql -h vayada-cluster-acl-db -U service_user -d service_db -Atqc 'SELECT current_user' \
  | grep -Fx service_user >/dev/null
if docker run --rm --network "${network}" --env PGPASSWORD=blocked postgres:"${version}" \
  psql -h vayada-cluster-acl-db -U blocked_user -d service_db -Atqc 'SELECT 1' >/dev/null 2>&1; then
  echo 'blocked role unexpectedly connected to sibling database' >&2
  exit 1
fi
run_harden | grep -F '"changed":false' >/dev/null
