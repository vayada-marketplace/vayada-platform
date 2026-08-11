#!/usr/bin/env bash

set -euo pipefail

contract_file="infra/auth-gateways.json"

jq --exit-status '
  type == "array" and
  length > 0 and
  all(.[];
    (keys | sort) == ["public_origin", "service", "surface", "upstream_origin"] and
    (.service | test("^next-[a-z0-9-]+$")) and
    (.public_origin | test("^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\\.vayada\\.com$")) and
    (.upstream_origin == "https://next-api.vayada.com") and
    (.surface | test("^[a-z][a-z0-9-]*$"))
  ) and
  ([.[].service] | length == (unique | length)) and
  ([.[].public_origin] | length == (unique | length)) and
  ([.[].surface] | length == (unique | length))
' "$contract_file" >/dev/null
