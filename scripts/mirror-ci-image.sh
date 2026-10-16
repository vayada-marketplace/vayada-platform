#!/usr/bin/env bash
# VAY-2237: copy one public CI test image into ghcr.io/vayada-marketplace without changing its digest.
#
#   bash scripts/mirror-ci-image.sh IMAGE TAG PACKAGE
#   e.g. bash scripts/mirror-ci-image.sh postgres 16-alpine ci-postgres
#
# Reads the official image IMAGE:TAG from ECR Public first and Docker Hub second (both serve the same
# digests), then copies it by digest, with every platform, to ghcr.io/vayada-marketplace/PACKAGE:TAG.
# A mirror that already has the source digest is left alone. Only MIRROR_PUBLISH=true copies (the
# workflow logs in to ghcr.io first); otherwise this is a dry run that reports what it would do.
# MIRROR_RETRY_DELAYS overrides the waits, in seconds, between attempts.
set -euo pipefail

image="${1:?usage: mirror-ci-image.sh IMAGE TAG PACKAGE}"
tag="${2:?usage: mirror-ci-image.sh IMAGE TAG PACKAGE}"
package="${3:?usage: mirror-ci-image.sh IMAGE TAG PACKAGE}"
publish="${MIRROR_PUBLISH:-false}"
read -r -a delays <<< "${MIRROR_RETRY_DELAYS:-30 60 120 240 480}"

sources=("public.ecr.aws/docker/library/${image}" "docker.io/library/${image}")
mirror="ghcr.io/vayada-marketplace/${package}:${tag}"

# A tag's digest is the sha256 of its raw manifest (for these images, the multi-platform index).
digest() {
  local raw
  raw="$(mktemp)"
  if skopeo inspect --raw --retry-times 2 "$@" > "${raw}" && test -s "${raw}"; then
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
  local mirror_digest
  for source in "${sources[@]}"; do
    if ! source_digest="$(digest --no-creds "docker://${source}:${tag}")"; then
      echo "could not read ${source}:${tag}"
      continue
    fi
    mirror_digest="$(digest "docker://${mirror}" 2> /dev/null || true)"
    if [[ "${mirror_digest}" == "${source_digest}" ]]; then
      report "unchanged"
      return 0
    fi
    if [[ "${publish}" != true ]]; then
      report "dry run: would copy (mirror has ${mirror_digest:-no such tag})"
      return 0
    fi
    if ! skopeo copy --all --preserve-digests --retry-times 2 --src-no-creds \
      "docker://${source}@${source_digest}" "docker://${mirror}"; then
      echo "copy from ${source} failed"
      continue
    fi
    if ! mirror_digest="$(digest "docker://${mirror}")"; then
      echo "could not read ${mirror} back"
      return 1
    fi
    if [[ "${mirror_digest}" != "${source_digest}" ]]; then
      echo "::error::${mirror} has ${mirror_digest}, expected ${source_digest}"
      exit 1
    fi
    report "copied"
    return 0
  done
  return 1
}

for ((n = 0; ; n++)); do
  if attempt; then
    exit 0
  fi
  if ((n >= ${#delays[@]})); then
    echo "::error::could not mirror ${image}:${tag} after $((n + 1)) attempts"
    exit 1
  fi
  echo "attempt $((n + 1)) failed; retrying in ${delays[n]}s"
  sleep "${delays[n]}"
done
