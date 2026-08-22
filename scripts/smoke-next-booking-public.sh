#!/usr/bin/env bash

set -euo pipefail

service="${1:?Usage: smoke-next-booking-public.sh <service-key>}"
summary_file="${GITHUB_STEP_SUMMARY:-/dev/null}"

if [ "$service" != "next-booking-frontend" ]; then
  printf '%s\n' "- Next Booking public smoke: not required for ${service}" >> "$summary_file"
  exit 0
fi

canary_url="${NEXT_BOOKING_CANARY_URL:?NEXT_BOOKING_CANARY_URL is required}"
canary_name="${NEXT_BOOKING_CANARY_NAME:?NEXT_BOOKING_CANARY_NAME is required}"
expected_build_sha="${EXPECTED_BUILD_SHA:?EXPECTED_BUILD_SHA is required}"
timeout_seconds="${NEXT_BOOKING_CANARY_TIMEOUT_SECONDS:-600}"

if [[ "$expected_build_sha" == next-* ]]; then
  expected_build_sha="${expected_build_sha#next-}"
fi
if [[ ! "$expected_build_sha" =~ ^[a-f0-9]{40}$ ]]; then
  echo "::error::Expected Booking build SHA must be a full lowercase Git SHA."
  exit 1
fi
if [[ ! "$timeout_seconds" =~ ^[0-9]+$ ]] || [ "$timeout_seconds" -lt 30 ] || [ "$timeout_seconds" -gt 900 ]; then
  echo "::error::NEXT_BOOKING_CANARY_TIMEOUT_SECONDS must be between 30 and 900."
  exit 1
fi
if [[ ! "$canary_url" =~ ^https://([a-z0-9-]+)\.next-booking\.vayada\.com/?$ ]]; then
  echo "::error::NEXT_BOOKING_CANARY_URL must be a tenant origin on *.next-booking.vayada.com."
  exit 1
fi

slug="${BASH_REMATCH[1]}"
origin="https://${slug}.next-booking.vayada.com"
deadline=$((SECONDS + timeout_seconds))

while true; do
  health="$({
    curl --fail --silent --show-error \
      --connect-timeout 10 \
      --max-time 20 \
      "${origin}/api/health"
  } 2>/dev/null || true)"
  observed_build_sha="$(jq -r '.buildSha // empty' <<< "$health" 2>/dev/null || true)"
  observed_status="$(jq -r '.status // empty' <<< "$health" 2>/dev/null || true)"
  if [ "$observed_status" = "ok" ] && [ "$observed_build_sha" = "$expected_build_sha" ]; then
    break
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "::error::Next Booking did not expose build ${expected_build_sha} within ${timeout_seconds}s."
    exit 1
  fi
  sleep 10
done

host="$({
  curl --fail --silent --show-error \
    --connect-timeout 10 \
    --max-time 20 \
    "${origin}/api/booking-web/hosts/${origin#https://}"
} 2>/dev/null || true)"
if ! jq --exit-status --arg slug "$slug" --arg name "$canary_name" '
  .contractVersion == "public-bookability.v1" and
  .hotel.slug == $slug and
  .hotel.name == $name
' <<< "$host" >/dev/null 2>&1; then
  echo "::error::Next Booking canary host resolution is missing or does not match the configured tenant."
  exit 1
fi

profile="$({
  curl --fail --silent --show-error \
    --connect-timeout 10 \
    --max-time 20 \
    "${origin}/api/booking-web/hotels/${slug}"
} 2>/dev/null || true)"
if ! jq --exit-status --arg slug "$slug" --arg name "$canary_name" '
  .contractVersion == "public-bookability.v1" and
  .hotel.slug == $slug and
  .hotel.name == $name
' <<< "$profile" >/dev/null 2>&1; then
  echo "::error::Next Booking canary public-bookability profile is missing or does not match the configured tenant."
  exit 1
fi

if ! curl --fail --silent --show-error \
  --connect-timeout 10 \
  --max-time 20 \
  --output /dev/null \
  "$origin"; then
  echo "::error::Next Booking canary page is not reachable."
  exit 1
fi

printf '%s\n' \
  "- Next Booking public smoke: build ${expected_build_sha}, host resolution, public profile, and tenant page passed for ${slug}" \
  >> "$summary_file"
