#!/usr/bin/env bash
# CI: the authenticated broker, started exactly as compose starts it
# (RUN-006, ADR-061 § 3). A GitHub `services:` container cannot mount the
# checkout or override its entrypoint, so the jobs run this after checkout
# and `pnpm install` instead.
#
#   1. a password per principal (and the admin), generated for this run only,
#      masked, and exported to later steps through $GITHUB_ENV — never a
#      repository value. One already in the environment is kept.
#   2. the throwaway CA and broker certificate (tls.sh, inside the image)
#   3. the broker (broker-entrypoint.sh): SASL_SSL on localhost:9092
#   4. every platform topic (create-topics.sh, as admin), and the group
#      coordinator loaded before any test joins a group
#   5. the generated ACLs (scripts/kafka-acl.mjs apply), read back and compared
#
# Later steps then see KAFKA_BROKERS, KAFKA_SSL, KAFKA_SSL_CA_FILE and every
# KAFKA_SASL_PASSWORD_<NAME>, as a developer's .env provides them.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/../../.." && pwd)"
IMAGE="${KAFKA_IMAGE:-apache/kafka:3.9.0}"
NAME="${KAFKA_CONTAINER_NAME:-rasta-ci-kafka}"
TLS_DIR="${KAFKA_TLS_DIR:-${RUNNER_TEMP:-/tmp}/rasta-kafka-tls}"
started="$(date +%s)"

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
done < "${HERE}/principals.txt"

env_flags=()
for principal in "${principals[@]}"; do
  variable="$(password_variable "${principal}")"
  if [ -z "${!variable:-}" ]; then
    value="$(openssl rand -hex 24)"
    if [ -n "${GITHUB_ENV:-}" ]; then echo "::add-mask::${value}"; fi
    publish "${variable}" "${value}"
  fi
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
# A freshly started broker lists topics while `__consumer_offsets` is still
# loading; a consumer joining in that window is told the coordinator is not
# available and the test waits on the wrong thing. Listing groups loads it.
docker exec "${NAME}" /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server kafka:9094 \
  --command-config /tmp/admin.properties --list >/dev/null
echo "==> Topics ready after $(($(date +%s) - started)) s"

# ---------------------------------------------------------------- 5. ACLs
node "${ROOT}/scripts/kafka-acl.mjs" apply
echo "==> Authenticated broker ready in $(($(date +%s) - started)) s"
