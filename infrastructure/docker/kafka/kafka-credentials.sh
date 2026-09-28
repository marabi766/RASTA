#!/usr/bin/env bash
# Prints `export` lines for exactly the Kafka credentials one CI step needs
# (RUN-006, review of #131 finding 1), from the per-run files ci-up.sh wrote
# to KAFKA_SECRETS_DIR. Nothing reaches $GITHUB_ENV; a step takes its scope
# explicitly and only for itself:
#
#   eval "$(bash infrastructure/docker/kafka/kafka-credentials.sh service fleet-service)"
#
# Scopes:
#   service <name>  that service's own password only — what a service process
#                   is started with; refused for anything not a declared
#                   `-service` principal
#   observer        the read-only test observer only (the E2E harness)
#   tests           every service's password and the observer's: the
#                   integration suites publish as each topic's owner and
#                   observe as itest-observer. Never the admin's or ops-replay's.
#   admin           everything, the admin included: the broker tests alone
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SECRETS_DIR="${KAFKA_SECRETS_DIR:?KAFKA_SECRETS_DIR is not set; run ci-up.sh first}"
PRINCIPALS_FILE="${HERE}/principals.development.txt"

password_variable() {
  local stem="${1%-service}"
  stem="${stem//-/_}"
  printf 'KAFKA_SASL_PASSWORD_%s' "${stem^^}"
}

emit() {
  local variable
  variable="$(password_variable "$1")"
  if [ ! -s "${SECRETS_DIR}/${variable}" ]; then
    echo "kafka-credentials: no credential for $1 in ${SECRETS_DIR}" >&2
    exit 1
  fi
  printf "export %s='%s'\n" "${variable}" "$(cat "${SECRETS_DIR}/${variable}")"
}

services() {
  grep -v '^#' "${PRINCIPALS_FILE}" | grep -e '-service$' || true
}

case "${1:-}" in
  service)
    name="${2:-}"
    if [[ "${name}" != *-service ]] || ! services | grep -qx -- "${name}"; then
      echo "kafka-credentials: '${name}' is not a service principal" >&2
      exit 1
    fi
    emit "${name}"
    ;;
  observer)
    emit itest-observer
    ;;
  tests)
    while IFS= read -r name; do emit "${name}"; done < <(services)
    emit itest-observer
    ;;
  admin)
    emit admin
    while IFS= read -r name; do
      case "${name}" in '' | \#*) continue ;; esac
      emit "${name}"
    done < "${PRINCIPALS_FILE}"
    ;;
  *)
    echo "usage: kafka-credentials.sh service <name> | observer | tests | admin" >&2
    exit 2
    ;;
esac
