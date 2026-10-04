#!/usr/bin/env bash
set -euo pipefail
version="${1:?usage: test-hotel-setup-reader-rls-permissions.sh <16|17>}"
[[ "$version" == 16 || "$version" == 17 ]] || exit 2
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
suffix="${RANDOM}${RANDOM}"
network="vay965-reader-rls-${suffix}"
database="vay965-reader-rls-pg-${suffix}"
modules="vay965-reader-rls-node-${suffix}"
transport="$(mktemp -d)"
cleanup() {
  docker rm -f "$database" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker volume rm "$modules" >/dev/null 2>&1 || true
  rm -f "$transport/overrides.json"
  rmdir "$transport"
}
trap cleanup EXIT
# Capture the actual wrapper's source+CA transport using the existing no-AWS fixture.
python3 - "$root" "$transport/overrides.json" <<'PY_CAPTURE'
from pathlib import Path
import importlib.util
import sys
root, destination = Path(sys.argv[1]), Path(sys.argv[2])
spec = importlib.util.spec_from_file_location('reader_runner', root / 'scripts/test_hotel_setup_creation_runner.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
fixture = module.CreationRunnerTest()
fixture.setUp()
try:
    fixture.env.update(GITHUB_ACTIONS='true', GITHUB_REF='refs/heads/main', GITHUB_EVENT_NAME='workflow_dispatch',
                       GITHUB_REPOSITORY='vayada-marketplace/vayada-platform',
                       EXPECTED_TASK='arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:1186',
                       MOCK_CURRENT_TASK='arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:1186')
    result = fixture.run_wrapper('--inspect-hotel-setup-reader-rls')
    assert result.returncode == 0, result.stderr
    destination.write_bytes((fixture.root / 'capture/overrides.json').read_bytes())
finally:
    fixture.doCleanups()
PY_CAPTURE
docker network create "$network" >/dev/null
docker volume create "$modules" >/dev/null
docker run --detach --rm --name "$database" --network "$network" \
  --network-alias reader-rls-db --env POSTGRES_PASSWORD=postgres "postgres:${version}" >/dev/null
for _ in {1..30}; do
  docker exec "$database" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$database" pg_isready -h 127.0.0.1 -U postgres >/dev/null
docker run --rm --volume "$modules:/work" --workdir /work node:22-bookworm \
  sh -c 'npm init -y >/dev/null && npm install --silent --no-audit --no-fund pg@8.16.3'
docker run --rm --network "$network" --volume "$modules:/work" \
  --volume "$root/scripts:/source:ro" --volume "$transport/overrides.json:/fixture/overrides.json:ro" --workdir /work node:22-bookworm \
  sh -c 'cp /source/hotel-setup-reader-rls-permissions.mjs /source/test-hotel-setup-reader-rls-permissions.mjs /work/ && node test-hotel-setup-reader-rls-permissions.mjs'
