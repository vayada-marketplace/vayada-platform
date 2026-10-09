#!/usr/bin/env bash
# VAY-2091: pull each CI test image once, retrying ECR Public's anonymous "Rate exceeded"
# throttle. The test scripts' `docker run` calls then use the local copy instead of pulling.
set -euo pipefail

for image in "$@"; do
  for attempt in 1 2 3 4 5 6; do
    if docker pull --quiet "${image}" >/dev/null; then
      continue 2
    fi
    echo "pull ${image} failed (attempt ${attempt}); retrying" >&2
    sleep $((attempt * 10))
  done
  echo "could not pull ${image}" >&2
  exit 1
done
