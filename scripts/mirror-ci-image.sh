#!/usr/bin/env bash
# VAY-2237/VAY-2258: copy one public CI or build image into ghcr.io/vayada-marketplace without changing
# its digest.
#
#   bash scripts/mirror-ci-image.sh IMAGE TAG PACKAGE [SOURCE...]
#   e.g. bash scripts/mirror-ci-image.sh postgres 16-alpine ci-postgres
#        bash scripts/mirror-ci-image.sh moby/buildkit buildx-stable-1 ci-buildkit \
#          public.ecr.aws/vend/moby/buildkit docker.io/moby/buildkit
#
# Reads the official image IMAGE:TAG from ECR Public first and Docker Hub second (both serve the same
# digests), then copies it by digest, with every platform, to ghcr.io/vayada-marketplace/PACKAGE:TAG.
# For an image that is not an official Docker image, the SOURCE repositories are read instead, in order.
# A mirror that already has the source digest is left alone. Only MIRROR_PUBLISH=true copies (the
# workflow logs in to ghcr.io first) and then requires the mirror to be pullable without logging in;
# otherwise this is a dry run that reports what it would do.
# MIRROR_RETRY_DELAYS overrides the waits, in seconds, between attempts. They are short on purpose:
# when a runner's address has used up the anonymous limits, re-running the job on a new runner helps
# more than waiting.
set -euo pipefail

image="${1:?usage: mirror-ci-image.sh IMAGE TAG PACKAGE [SOURCE...]}"
tag="${2:?usage: mirror-ci-image.sh IMAGE TAG PACKAGE [SOURCE...]}"
package="${3:?usage: mirror-ci-image.sh IMAGE TAG PACKAGE [SOURCE...]}"
shift 3
publish="${MIRROR_PUBLISH:-false}"
read -r -a delays <<< "${MIRROR_RETRY_DELAYS:-15 45 120}"

sources=("$@")
if ((${#sources[@]} == 0)); then
  sources=("public.ecr.aws/docker/library/${image}" "docker.io/library/${image}")
fi
mirror="ghcr.io/vayada-marketplace/${package}:${tag}"

# A tag's digest is the sha256 of its raw manifest (for these images, the multi-platform index).
digest() {
  local raw
  raw="$(mktemp)"
  if skopeo inspect --raw --retry-times 1 "$@" > "${raw}" && test -s "${raw}"; then
    printf 'sha256:%s\n' "$(sha256sum "${raw}" | cut -d ' ' -f 1)"
    rm -f "${raw}"
  else
    rm -f "${raw}"
    return 1
  fi
}

report() {
  echo "${image}:${tag} -> ${mirror}: $1 (source ${source}@${source_digest})"
  {
    echo "| Image | Source | Digest | Result |"
    echo "|---|---|---|---|"
    echo "| \`${image}:${tag}\` | \`${source}\` | \`${source_digest}\` | $1 |"
  } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
}

# One attempt: the first source that answers decides the digest. Returns 1 to retry later.
attempt() {
  local mirror_digest result
  problem="no source could be read"
  for source in "${sources[@]}"; do
    if ! source_digest="$(digest --no-creds "docker://${source}:${tag}")"; then
      echo "could not read ${source}:${tag}"
      continue
    fi
    mirror_digest="$(digest "docker://${mirror}" 2> /dev/null || true)"
    if [[ "${mirror_digest}" == "${source_digest}" ]]; then
      result="unchanged"
    elif [[ "${publish}" != true ]]; then
      report "dry run: would copy (mirror is ${mirror_digest:-missing or unreadable})"
      return 0
    else
      if ! skopeo copy --all --preserve-digests --retry-times 1 --src-no-creds \
        "docker://${source}@${source_digest}" "docker://${mirror}"; then
        problem="copying from ${source} to ${mirror} failed"
        echo "${problem}"
        continue
      fi
      if ! mirror_digest="$(digest "docker://${mirror}")"; then
        problem="could not read ${mirror} back after copying"
        echo "${problem}"
        return 1
      fi
      if [[ "${mirror_digest}" != "${source_digest}" ]]; then
        echo "::error::${mirror} has ${mirror_digest}, expected ${source_digest}"
        exit 1
      fi
      result="copied"
    fi
    # CI pulls without logging in, so a mirror that only the workflow's token can read is no use.
    if [[ "${publish}" == true ]] &&
      [[ "$(digest --no-creds "docker://${mirror}" 2> /dev/null || true)" != "${source_digest}" ]]; then
      problem="${mirror} is not pullable without logging in; make the ${package} package public (docs/ci-image-mirror.md)"
      echo "${problem}"
      return 1
    fi
    report "${result}"
    return 0
  done
  return 1
}

for ((n = 0; ; n++)); do
  if attempt; then
    exit 0
  fi
  if ((n >= ${#delays[@]})); then
    echo "::error::could not mirror ${image}:${tag} after $((n + 1)) attempts: ${problem}"
    exit 1
  fi
  echo "attempt $((n + 1)) failed; retrying in ${delays[n]}s"
  sleep "${delays[n]}"
done
