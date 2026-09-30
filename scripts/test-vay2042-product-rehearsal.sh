#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
if (cd "$scratch" && bash "$repo/scripts/run-vay2042-product-rehearsal.sh") >"$scratch/output" 2>&1; then
  echo 'Missing reviewed run file unexpectedly passed.' >&2
  exit 1
fi
grep -q 'Reviewed rehearsal run file is absent; no task launched.' "$scratch/output"
echo 'No-run-file gate passed.'
