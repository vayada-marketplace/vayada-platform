#!/usr/bin/env bash

set -euo pipefail

contract_file="infra/auth-gateways.json"

jq --exit-status '
  type == "array" and
  length > 0 and
  all(.[];
    (keys | sort) == ["public_origin", "service", "surface", "upstream_origin"] and
    (.service | test("^next-[a-z0-9-]+$")) and
    (.public_origin | test("^https://[a-z0-9.-]+$")) and
    (.upstream_origin | test("^https://[a-z0-9.-]+$")) and
    (.surface | test("^[a-z][a-z0-9-]*$"))
  ) and
  ([.[].service] | length == (unique | length)) and
  ([.[].public_origin] | length == (unique | length)) and
  ([.[].surface] | length == (unique | length))
' "$contract_file" >/dev/null

reserved_literal_count="$(grep -Ec '"(AUTH_PUBLIC_ORIGIN|AUTH_GATEWAY_UPSTREAM_ORIGIN)"' infra/ecs.tf)"
if [ "$reserved_literal_count" -ne 2 ]; then
  echo "::error::Auth gateway environment variables must be generated from ${contract_file}, not declared in a service environment."
  exit 1
fi
