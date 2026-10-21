#!/usr/bin/env bash
set -euo pipefail

if [ "${ROOM_CLOSURE:-false}" = true ]; then
  test "${SERVICE:-}" = next-maps-canary
  test "${ENVIRONMENT:-}" = next
  test "${CHANNEX_STAGING:-}" = true
  test "${ACTIVATE_GUEST:-false}" != true
  test "${CHANNEX_WORKER_STATE:-preserve}" = preserve
fi

if [ "${CHANNEX_WORKER_DATABASE:-false}" = true ]; then
  test "${SERVICE:-}" = next-maps-canary
  test "${ENVIRONMENT:-}" = next
  test "${CHANNEX_STAGING:-}" = true
  test "${ACTIVATE_GUEST:-false}" != true
  test "${CHANNEX_WORKER_STATE:-preserve}" = preserve
fi

# VAY-2108: pull-only claimed booking replaces the restrictions canary; it never pairs with it.
if [ "${CHANNEX_STAGING_BOOKING:-false}" = true ]; then
  test "${SERVICE:-}" = next-maps-canary
  test "${ENVIRONMENT:-}" = next
  test "${CHANNEX_STAGING:-false}" != true
  test "${CHANNEX_WORKER_DATABASE:-false}" != true
  test "${ACTIVATE_GUEST:-false}" != true
  test "${CHANNEX_WORKER_STATE:-preserve}" = preserve
fi

case "${CHANNEX_WORKER_STATE:-preserve}" in
  preserve) exit 0 ;;
  paused|running)
    test "${SERVICE:-}" = next-maps-canary
    test "${ENVIRONMENT:-}" = next
    test "${CHANNEX_STAGING:-}" = true
    test "${ACTIVATE_GUEST:-false}" != true
    ;;
  *) echo 'Unknown Channex worker state' >&2; exit 1 ;;
esac
