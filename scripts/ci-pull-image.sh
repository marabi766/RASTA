#!/usr/bin/env bash
# Pre-pull CI images with a bounded retry on TRANSIENT registry errors only.
#
#   scripts/ci-pull-image.sh <name@sha256:digest> [<name@sha256:digest> ...]
#
# Why: a 502 from quay.io on the Keycloak manifest failed a whole job
# (docker exit 125, 2026-10-14, #279). The step that starts the container is
# left exactly as it was; this runs before it so the image is already local
# and that step's own pull is a no-op.
#
# What it will not do:
#   - accept a reference that is not pinned by digest (the pin is the point);
#   - retry anything it does not positively recognise as transient. A 404,
#     "manifest unknown", "unauthorized"/"denied", a digest mismatch, or any
#     error text it has never seen fails at once, with docker's own output;
#   - retry forever: attempts are bounded by CI_PULL_BACKOFF.
#
# CI_PULL_BACKOFF is the sleep before each retry, in seconds; the number of
# retries is the number of entries. Default "10 30 60" = 4 attempts.
set -uo pipefail

BACKOFF=(${CI_PULL_BACKOFF:-10 30 60})

# Permanent failures win over transient ones: an error text that matches both
# (a "not found" page that also says "timeout") is not retried.
PERMANENT='manifest unknown|name unknown|not found|HTTP status: 40[0-9]|unauthorized|authentication required|denied|forbidden|no matching manifest|digest (mismatch|invalid)|manifest verification failed|invalid reference format|repository does not exist'
TRANSIENT='unexpected HTTP status: 5[0-9][0-9]|50[0-4] (Bad Gateway|Service Unavailable|Gateway Time-?out|Internal Server Error)|Bad Gateway|Service Unavailable|Gateway Time-?out|TLS handshake timeout|i/o timeout|context deadline exceeded|Client\.Timeout|connection reset by peer|connection refused|unexpected EOF|: EOF|temporary failure in name resolution|no such host|toomanyrequests|HTTP status: 429'

# The image's own digest is stripped first: 64 hex characters contain "404" or
# "502" often enough to misclassify an error that quotes the manifest URL.
classify() { # $1 = file with docker's output; prints "permanent", "transient" or "unknown"
  local text
  text="$(sed -E 's/sha256:[0-9a-f]{64}/sha256:DIGEST/g' "$1")"
  if grep -Eiq "$PERMANENT" <<<"$text"; then echo permanent
  elif grep -Eiq "$TRANSIENT" <<<"$text"; then echo transient
  else echo unknown
  fi
}

pull_one() {
  local image="$1" out attempt=0 max=$((${#BACKOFF[@]} + 1)) kind rc
  out="$(mktemp)"
  while :; do
    attempt=$((attempt + 1))
    docker pull "$image" >"$out" 2>&1
    rc=$?
    if [ "$rc" -eq 0 ]; then
      echo "pulled ${image} (attempt ${attempt}/${max})"
      rm -f "$out"
      return 0
    fi
    cat "$out" >&2
    kind="$(classify "$out")"
    if [ "$kind" != transient ]; then
      echo "::error::pull of ${image} failed with a ${kind} error (docker exit ${rc}); not retrying" >&2
      rm -f "$out"
      return 1
    fi
    if [ "$attempt" -ge "$max" ]; then
      echo "::error::pull of ${image} still failing after ${max} attempts (docker exit ${rc})" >&2
      rm -f "$out"
      return 1
    fi
    echo "transient pull error for ${image} (attempt ${attempt}/${max}); retrying in ${BACKOFF[$((attempt - 1))]}s" >&2
    sleep "${BACKOFF[$((attempt - 1))]}"
  done
}

if [ "$#" -eq 0 ]; then
  echo "usage: ci-pull-image.sh <image@sha256:digest> [...]" >&2
  exit 2
fi
for image in "$@"; do
  case "$image" in
    *@sha256:????????????????????????????????????????????????????????????????) ;;
    *)
      echo "::error::${image} is not pinned by sha256 digest; refusing to pull" >&2
      exit 2
      ;;
  esac
done
for image in "$@"; do
  pull_one "$image" || exit 1
done
