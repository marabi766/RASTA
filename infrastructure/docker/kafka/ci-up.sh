#!/usr/bin/env bash
# CI: the authenticated broker, started exactly as compose starts it
# (RUN-006, ADR-061 § 3). A GitHub `services:` container cannot mount the
# checkout or override its entrypoint, so the jobs run this after checkout
# and `pnpm install` instead.
#
#   1. a password per principal (and the admin), generated for this run only
#      and masked, written one file per variable to one of two private
#      directories (mode 700), never to $GITHUB_ENV (review of #131):
#        KAFKA_SECRETS_DIR        the services' and the test observer's
#        KAFKA_ADMIN_SECRETS_DIR  the admin's, ops-replay's, Kafka UI's and
#                                 the exporter's — for the broker bootstrap
#                                 (this script) and the broker tests alone
#      Neither path is published either: each step that needs one is given it
#      in its own `env:` and takes exactly the credentials it needs through
#      `kafka-credentials.sh <scope>`. A service start step unsets the
#      directory before it launches anything, so no service process has it.
#      One password already in the environment is kept.
#   2. the throwaway CA and broker certificate (tls.sh, inside the image)
#   3. the broker (broker-entrypoint.sh, profile development): SASL_SSL on
#      localhost:9092
#   4. every topic in topics.txt and the group coordinator (create-topics.sh,
#      as admin), before any test joins a group
#   5. the generated development ACLs (kafka-acl.mjs apply), read back and
#      compared
#
# Later steps see only what is not secret through $GITHUB_ENV: KAFKA_BROKERS,
# KAFKA_SSL and KAFKA_SSL_CA_FILE. The accepted CI residual (ADR-061 § 3):
# every step runs as the same runner user, so test code pointed at a secrets
# directory can read it; deployments inject only each service's own secret.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/../../.." && pwd)"
IMAGE="${KAFKA_IMAGE:-apache/kafka:3.9.0@sha256:fbc7d7c428e3755cf36518d4976596002477e4c052d1f80b5b9eafd06d0fff2f}"
NAME="${KAFKA_CONTAINER_NAME:-rasta-ci-kafka}"
TLS_DIR="${KAFKA_TLS_DIR:-${RUNNER_TEMP:-/tmp}/rasta-kafka-tls}"
SECRETS_DIR="${KAFKA_SECRETS_DIR:?KAFKA_SECRETS_DIR must name the secrets directory for services and the observer}"
ADMIN_SECRETS_DIR="${KAFKA_ADMIN_SECRETS_DIR:?KAFKA_ADMIN_SECRETS_DIR must name the secrets directory for the admin and tools}"
if [ "${SECRETS_DIR}" = "${ADMIN_SECRETS_DIR}" ]; then
  echo "kafka: the services' and the admin's secrets need two directories" >&2
  exit 1
fi
PROFILE=development
started="$(date +%s)"

# Not secret: exported here and, in CI, to later steps.
publish() {
  export "$1=$2"
  if [ -n "${GITHUB_ENV:-}" ]; then
    echo "$1=$2" >> "${GITHUB_ENV}"
  fi
}

password_variable() {
  local stem="${1%-service}"
  stem="${stem//-/_}"
  printf 'KAFKA_SASL_PASSWORD_%s' "${stem^^}"
}

# ---------------------------------------------------------------- 1. credentials
principals=(admin)
while IFS= read -r principal; do
  case "${principal}" in '' | \#*) continue ;; esac
  principals+=("${principal}")
done < "${HERE}/principals.${PROFILE}.txt"

mkdir -p "${SECRETS_DIR}" "${ADMIN_SECRETS_DIR}"
chmod 700 "${SECRETS_DIR}" "${ADMIN_SECRETS_DIR}"
env_flags=()
for principal in "${principals[@]}"; do
  variable="$(password_variable "${principal}")"
  # A service's and the observer's go where the test steps may read them;
  # every other principal's (admin, ops-replay, the tools) where only the
  # broker tests may.
  case "${principal}" in
    *-service | itest-observer) directory="${SECRETS_DIR}" ;;
    *) directory="${ADMIN_SECRETS_DIR}" ;;
  esac
  if [ -z "${!variable:-}" ]; then
    value="$(openssl rand -hex 24)"
    if [ -n "${GITHUB_ENV:-}" ]; then echo "::add-mask::${value}"; fi
    export "${variable}=${value}"
  fi
  (umask 077 && printf '%s' "${!variable}" > "${directory}/${variable}")
  # `-e NAME` without a value: docker copies it from this environment, so no
  # password appears on a command line.
  env_flags+=(-e "${variable}")
done
publish KAFKA_BROKERS localhost:9092
publish KAFKA_SSL true
publish KAFKA_SSL_CA_FILE "${TLS_DIR}/ca.pem"

on_error() {
  echo "::group::broker log"
  docker logs "${NAME}" 2>&1 | tail -200 || true
  echo "::endgroup::"
}
trap on_error ERR

# ---------------------------------------------------------------- 2. TLS
mkdir -p "${TLS_DIR}"
docker run --rm --user 0 \
  -v "${TLS_DIR}:/tls" -v "${HERE}:/bootstrap:ro" \
  --entrypoint bash "${IMAGE}" /bootstrap/tls.sh

# ---------------------------------------------------------------- 3. broker
docker rm -f "${NAME}" >/dev/null 2>&1 || true
docker run -d --name "${NAME}" --hostname kafka -p 9092:9092 \
  -v "${TLS_DIR}:/tls:ro" -v "${HERE}:/bootstrap:ro" \
  -e CLUSTER_ID="${KAFKA_CLUSTER_ID:-rasta-ci-cluster-000001}" \
  -e KAFKA_ADVERTISED_EXTERNAL=localhost:9092 \
  -e KAFKA_ADVERTISED_BROKER=kafka:9094 \
  -e KAFKA_ACL_PROFILE="${PROFILE}" \
  "${env_flags[@]}" \
  --entrypoint /bootstrap/broker-entrypoint.sh "${IMAGE}" >/dev/null

ready=0
for _ in $(seq 1 60); do
  if docker exec "${NAME}" /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:9094 \
    --command-config /tmp/admin.properties --list >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
if [ "${ready}" -ne 1 ]; then
  echo "kafka: the broker did not accept the admin over SASL_SSL" >&2
  on_error
  exit 1
fi
echo "==> Broker up after $(($(date +%s) - started)) s"

# ---------------------------------------------------------------- 4. topics
docker exec -e KAFKA_SASL_PASSWORD_ADMIN -e KAFKA_CA_FILE=/tls/ca.pem -e KAFKA_BOOTSTRAP=kafka:9094 \
  "${NAME}" bash /bootstrap/create-topics.sh >/dev/null
echo "==> Topics ready after $(($(date +%s) - started)) s"

# ---------------------------------------------------------------- 5. ACLs
node "${ROOT}/scripts/kafka-acl.mjs" apply --profile "${PROFILE}"
echo "==> Authenticated broker ready in $(($(date +%s) - started)) s"
