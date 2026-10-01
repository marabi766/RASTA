#!/usr/bin/env bash
# Prints `export` lines for exactly the Kafka credentials one CI step needs
# (RUN-006, reviews of #131), from the per-run files ci-up.sh wrote. Nothing
# reaches $GITHUB_ENV, and neither directory is published: a step is given the
# directory in its own `env:` and takes its scope explicitly, for itself:
#
#   kafka_credentials="$(bash infrastructure/docker/kafka/kafka-credentials.sh tests)"
#   eval "${kafka_credentials}"
#
# Scopes, and the directory each reads:
#   service <name>  KAFKA_SECRETS_DIR: that service's own password only — what a
#                   service process is started with; refused for anything not
#                   a declared `-service` principal. The start step unsets the
#                   directory before launching the service.
#   observer        KAFKA_SECRETS_DIR: the read-only test observer only (E2E)
#   tests           KAFKA_SECRETS_DIR: every service's password and the
#                   observer's — the integration suites publish as each topic's
#                   owner and observe as itest-observer. Test steps only; never
#                   the admin's, ops-replay's or a tool's.
#   replay          `tests`, plus ops-replay's password (KAFKA_ADMIN_SECRETS_DIR):
#                   the one step that publishes on `<topic>.retry` as the
#                   operator's replay principal, to show a replay is consumed
#                   like the original (D-039). Never the admin's or a tool's,
#                   and never a step that starts services.
#   admin           KAFKA_ADMIN_SECRETS_DIR as well: everything, the admin
#                   included — the broker tests alone
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRINCIPALS_FILE="${HERE}/principals.development.txt"

password_variable() {
  local stem="${1%-service}"
  stem="${stem//-/_}"
  printf 'KAFKA_SASL_PASSWORD_%s' "${stem^^}"
}

# emit <principal> <directory>
emit() {
  local variable
  variable="$(password_variable "$1")"
  if [ ! -s "$2/${variable}" ]; then
    echo "kafka-credentials: no credential for $1 in $2" >&2
    exit 1
  fi
  printf "export %s='%s'\n" "${variable}" "$(cat "$2/${variable}")"
}

services() {
  grep -v '^#' "${PRINCIPALS_FILE}" | grep -e '-service$' || true
}

services_dir() {
  printf '%s' "${KAFKA_SECRETS_DIR:?KAFKA_SECRETS_DIR is not set for this step}"
}

case "${1:-}" in
  service)
    name="${2:-}"
    if [[ "${name}" != *-service ]] || ! services | grep -qx -- "${name}"; then
      echo "kafka-credentials: '${name}' is not a service principal" >&2
      exit 1
    fi
    emit "${name}" "$(services_dir)"
    ;;
  observer)
    emit itest-observer "$(services_dir)"
    ;;
  tests)
    dir="$(services_dir)"
    while IFS= read -r name; do emit "${name}" "${dir}"; done < <(services)
    emit itest-observer "${dir}"
    ;;
  replay)
    dir="$(services_dir)"
    admin_dir="${KAFKA_ADMIN_SECRETS_DIR:?KAFKA_ADMIN_SECRETS_DIR is not set for this step}"
    while IFS= read -r name; do emit "${name}" "${dir}"; done < <(services)
    emit itest-observer "${dir}"
    emit ops-replay "${admin_dir}"
    ;;
  admin)
    dir="$(services_dir)"
    admin_dir="${KAFKA_ADMIN_SECRETS_DIR:?KAFKA_ADMIN_SECRETS_DIR is not set for this step}"
    emit admin "${admin_dir}"
    while IFS= read -r name; do
      case "${name}" in
        '' | \#*) continue ;;
        *-service | itest-observer) emit "${name}" "${dir}" ;;
        *) emit "${name}" "${admin_dir}" ;;
      esac
    done < "${PRINCIPALS_FILE}"
    ;;
  *)
    echo "usage: kafka-credentials.sh service <name> | observer | tests | replay | admin" >&2
    exit 2
    ;;
esac
