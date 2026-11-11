#!/usr/bin/env bash
# Make Chromium ready for the portal's browser suite, and PROVE that it starts.
#
#   scripts/ci-install-browser.sh        (no arguments)
#
# Why (FU-335): `playwright install --with-deps chromium` ran apt on every
# run, although the runner image already has every shared library Chromium
# links: on ubuntu-24.04 apt added nine font packages and nothing else (the
# portal ships its own typeface). When the image's Ubuntu mirror stopped
# resolving on 2026-11-11 the step failed after ten minutes, the suite never
# ran and nothing could merge.
#
# What it does, in this order:
#   1. downloads the Chromium build only (`playwright install chromium`; a
#      no-op when the cached build is already there);
#   2. proves it: Playwright's own `screenshot` command launches that build
#      headless (the executable and defaults the suite's projects use) on a
#      page given inline, and writes a PNG into a directory made for this
#      proof. Proven means the command exited 0 AND the file it wrote begins
#      as a PNG does: the 8-byte signature, then the IHDR chunk header (the
#      first 16 bytes; the image is not decoded). Exit 0 alone is not a proof;
#   3. only if the proof fails, installs Playwright's system packages
#      (`playwright install-deps chromium`, which is apt) and proves again.
#
# The only way out with status 0 is a passed proof. Every other path (the
# download failing, the packages failing to install, a browser that still
# does not start, a proof that hangs) exits non-zero, so the suite step after
# this one does not run and the job is red; nothing here skips the suite.
#
# Downloads and apt are retried a bounded number of times, each attempt under
# a time limit: CI_BROWSER_BACKOFF is the sleep before each retry, in seconds,
# and the number of retries is the number of entries (default "5 15" = 3
# attempts); CI_BROWSER_ATTEMPT_SECONDS bounds one attempt (default 120) and
# CI_BROWSER_PROOF_SECONDS one proof (default 120), each with 10 s more to
# be killed in. With the defaults the longest path is 410 s of download,
# 410 s of apt and two 130 s proofs: 18 minutes, then red with one of the
# messages below. The ordinary path takes seconds.
set -uo pipefail

BACKOFF=(${CI_BROWSER_BACKOFF:-5 15})
ATTEMPT_SECONDS="${CI_BROWSER_ATTEMPT_SECONDS:-120}"
PROOF_SECONDS="${CI_BROWSER_PROOF_SECONDS:-120}"
PROOF_PAGE='data:text/html,<title>rasta</title><p>browser launch proof</p>'
# The first 16 bytes of every PNG, in hex: the signature (0x89 "PNG" CR LF
# 0x1a LF), then the first chunk's length (13) and type ("IHDR").
PNG_START=89504e470d0a1a0a0000000d49484452

if [ "$#" -ne 0 ]; then
  echo "usage: ci-install-browser.sh (takes no arguments)" >&2
  exit 2
fi

attempt() { # $1 = download | packages: one attempt, under its time limit
  case "$1" in
    download)
      timeout --kill-after=10 "$ATTEMPT_SECONDS" \
        pnpm --filter @rasta/web exec playwright install chromium
      ;;
    packages)
      timeout --kill-after=10 "$ATTEMPT_SECONDS" \
        pnpm --filter @rasta/web exec playwright install-deps chromium
      ;;
    *) return 2 ;;
  esac
}

bounded() { # $1 = download | packages; $2 = what that is, for the log
  local what="$2" n=0 max=$((${#BACKOFF[@]} + 1)) rc
  while :; do
    n=$((n + 1))
    attempt "$1"
    rc=$?
    if [ "$rc" -eq 0 ]; then
      echo "${what}: done (attempt ${n}/${max})"
      return 0
    fi
    if [ "$n" -ge "$max" ]; then
      echo "${what}: still failing after ${max} attempts (exit ${rc})" >&2
      return 1
    fi
    echo "${what}: failed (exit ${rc}, attempt ${n}/${max}); retrying in ${BACKOFF[$((n - 1))]}s" >&2
    sleep "${BACKOFF[$((n - 1))]}"
  done
}

prove() {
  local dir shot rc
  dir="$(mktemp -d)" || return 1
  shot="${dir}/launch-proof.png"
  timeout --kill-after=10 "$PROOF_SECONDS" \
    pnpm --filter @rasta/web exec playwright screenshot --browser chromium "$PROOF_PAGE" "$shot"
  rc=$?
  if [ "$rc" -eq 0 ] &&
    [ "$(head -c 16 "$shot" 2>/dev/null | od -An -v -tx1 | tr -d ' \n')" = "$PNG_START" ]; then
    rm -rf "$dir"
    echo "browser-launch-proof: Chromium launched headless and rendered a page"
    return 0
  fi
  rm -rf "$dir"
  echo "browser-launch-proof: FAILED (exit ${rc}; output above)" >&2
  return 1
}

if ! bounded download 'Chromium download'; then
  echo "::error::The Chromium build could not be downloaded. The browser suite was NOT run." >&2
  exit 1
fi

if prove; then
  echo "Chromium starts with the libraries already on this image; no system packages were installed."
  exit 0
fi

echo "::warning::Chromium did not start with the libraries on this image (output above). Installing Playwright's system packages with apt, then proving again." >&2
if ! bounded packages 'System packages for Chromium'; then
  echo "::error::Chromium does not start on this runner image, and its system packages could not be installed (apt). The browser suite was NOT run." >&2
  exit 1
fi

if prove; then
  echo "Chromium starts after installing Playwright's system packages."
  exit 0
fi
echo "::error::Chromium still does not start after its system packages were installed (output above). The browser suite was NOT run." >&2
exit 1
