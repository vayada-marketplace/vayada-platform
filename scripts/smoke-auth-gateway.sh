#!/usr/bin/env bash

set -euo pipefail

service="${1:?Usage: smoke-auth-gateway.sh <service-key>}"
contract="$(
  jq -c --arg service "$service" '
    map(select(.service == $service)) |
    if length > 1 then error("duplicate auth gateway service")
    elif length == 1 then .[0]
    else empty
    end
  ' infra/auth-gateways.json
)"
summary_file="${GITHUB_STEP_SUMMARY:-/dev/null}"

if [ -z "$contract" ]; then
  printf '%s\n' "- Auth gateway smoke: not required for ${service}" >> "$summary_file"
  exit 0
fi

public_origin="$(jq -r '.public_origin' <<< "$contract")"
surface="$(jq -r '.surface' <<< "$contract")"
session_endpoint="${public_origin}/auth/session?surface=${surface}"
google_endpoint="${public_origin}/auth/oauth/google/start"
response_file="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/auth-gateway-${service}.json"
status="$(
  curl --silent --show-error \
    --retry 6 \
    --retry-delay 5 \
    --retry-all-errors \
    --connect-timeout 10 \
    --max-time 20 \
    --output "$response_file" \
    --write-out "%{http_code}" \
    "$session_endpoint"
)"
error="$(jq -r '.error // empty' "$response_file" 2>/dev/null || true)"

if [ "$status" != "401" ] || [ "$error" != "missing_session" ]; then
  body="$(head -c 500 "$response_file")"
  echo "::error::Auth gateway smoke failed for ${service}: HTTP ${status}, body ${body}"
  exit 1
fi

google_result="$(
  curl --silent --show-error \
    --retry 6 \
    --retry-delay 5 \
    --retry-all-errors \
    --connect-timeout 10 \
    --max-time 20 \
    --output /dev/null \
    --write-out $'%{http_code}\t%{redirect_url}' \
    --get "$google_endpoint" \
    --data-urlencode "surface=${surface}" \
    --data-urlencode "flow=login" \
    --data-urlencode "return_to=${public_origin}/" \
    --data-urlencode "error_return_to=${public_origin}/"
)"
IFS=$'\t' read -r google_status google_redirect <<< "$google_result"

if [ "$google_status" != "302" ] || [[ "$google_redirect" != https://api.workos.com/* ]]; then
  echo "::error::Google auth gateway smoke failed for ${service}: HTTP ${google_status}, redirect ${google_redirect}"
  exit 1
fi

printf '%s\n' \
  "- Auth gateway smoke: ${service} returned HTTP 401 missing_session and Google start returned HTTP 302 to WorkOS" \
  >> "$summary_file"
