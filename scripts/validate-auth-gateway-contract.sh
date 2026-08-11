#!/usr/bin/env bash

set -euo pipefail

contract_file="infra/auth-gateways.json"
expected_public_origins='{
  "next-affiliate-dashboard": "https://next-affiliate.vayada.com",
  "next-booking-admin": "https://next-booking-admin.vayada.com",
  "next-marketplace-admin": "https://next-admin.vayada.com",
  "next-marketplace-frontend": "https://next-marketplace.vayada.com",
  "next-pms-frontend": "https://next-pms.vayada.com"
}'

jq --exit-status --argjson expected_public_origins "$expected_public_origins" '
  type == "array" and
  length > 0 and
  all(.[];
    (keys | sort) == ["public_origin", "service", "surface", "upstream_origin"] and
    (.service | test("^next-[a-z0-9-]+$")) and
    (.public_origin == $expected_public_origins[.service]) and
    (.upstream_origin == "https://next-api.vayada.com") and
    (.surface | test("^[a-z][a-z0-9-]*$"))
  ) and
  ([.[].service] | sort) == ($expected_public_origins | keys | sort) and
  ([.[].service] | length == (unique | length)) and
  ([.[].public_origin] | length == (unique | length)) and
  ([.[].surface] | length == (unique | length))
' "$contract_file" >/dev/null
