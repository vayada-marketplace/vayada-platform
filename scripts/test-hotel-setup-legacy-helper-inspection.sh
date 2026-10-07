#!/usr/bin/env bash
set -euo pipefail
version="${1:?usage: test-hotel-setup-legacy-helper-inspection.sh <16|17>}"
[[ "$version" == 16 || "$version" == 17 ]] || exit 2
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
suffix="${RANDOM}${RANDOM}"
network="vay965-legacy-helpers-${suffix}"
database="vay965-legacy-helpers-pg-${suffix}"
modules="vay965-legacy-helpers-node-${suffix}"
cleanup() {
  docker rm -f "$database" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker volume rm "$modules" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create "$network" >/dev/null
docker volume create "$modules" >/dev/null
docker run --detach --rm --name "$database" --network "$network" \
  --network-alias legacy-helper-db --env POSTGRES_PASSWORD=postgres "postgres:${version}" >/dev/null
for _ in {1..30}; do
  docker exec "$database" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$database" pg_isready -U postgres >/dev/null
docker run --rm --volume "$modules:/work" --workdir /work node:22-bookworm \
  sh -c 'npm init -y >/dev/null && npm install --silent --no-audit --no-fund pg@8.16.3'
docker run --rm --network "$network" --volume "$modules:/work" \
  --volume "$root/scripts:/source:ro" --workdir /work node:22-bookworm \
  sh -c 'cp /source/hotel-setup-legacy-helper-inspection.mjs /source/test-hotel-setup-legacy-helper-inspection.mjs /work/ && node test-hotel-setup-legacy-helper-inspection.mjs'
