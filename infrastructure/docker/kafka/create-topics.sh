#!/bin/bash
# -----------------------------------------------------------------------------
# Creates every Rasta platform topic plus its retry and dead-letter companions.
#
# Broker auto-creation is OFF on purpose (ADR-006): producing to an unknown
# topic is a contract violation and must fail loudly rather than silently
# spawning a topic with default settings.
#
# Naming: rasta.<domain>.v<major>   — the major version is the *envelope*
# version. Individual event payload versions live in the envelope's
# `eventVersion` field so a single topic can carry a mixed-version stream
# during a rollout. See docs/events/README.md.
# -----------------------------------------------------------------------------
set -euo pipefail

KAFKA_BIN="${KAFKA_BIN:-/opt/kafka/bin}"
BOOTSTRAP="${KAFKA_BOOTSTRAP:-kafka:9094}"
PARTITIONS="${KAFKA_TOPIC_PARTITIONS:-3}"
REPLICATION="${KAFKA_TOPIC_REPLICATION:-1}"
RETENTION_MS="${KAFKA_TOPIC_RETENTION_MS:-604800000}" # 7 days

DOMAINS=(
  identity
  organization
  asset
  fleet
  maintenance
  insurance
  marketplace
  procurement
  supplier
  inventory
  construction
  contract
  economic
  notification
  document
  audit
)

# RUN-006: the broker authenticates. With the admin's password in the
# environment this connects as `admin` over SASL_SSL, trusting the throwaway CA
# tls.sh wrote; without it, PLAINTEXT as before.
ADMIN_CONFIG=()
if [ -n "${KAFKA_SASL_PASSWORD_ADMIN:-}" ]; then
  admin_properties="$(mktemp)"
  escaped="$(printf '%s' "${KAFKA_SASL_PASSWORD_ADMIN}" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  {
    echo 'security.protocol=SASL_SSL'
    echo 'sasl.mechanism=SCRAM-SHA-512'
    echo "sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username=\"admin\" password=\"${escaped}\";"
    echo 'ssl.truststore.type=PEM'
    echo "ssl.truststore.location=${KAFKA_CA_FILE:-/tls/ca.pem}"
  } > "${admin_properties}"
  ADMIN_CONFIG=(--command-config "${admin_properties}")
fi

echo "==> Waiting for Kafka at ${BOOTSTRAP}"
for _ in $(seq 1 30); do
  if "${KAFKA_BIN}"/kafka-topics.sh --bootstrap-server "${BOOTSTRAP}" "${ADMIN_CONFIG[@]}" --list >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

create_topic() {
  local name="$1"
  local partitions="$2"
  local retention="$3"
  local extra="${4:-}"

  # shellcheck disable=SC2086
  "${KAFKA_BIN}"/kafka-topics.sh --bootstrap-server "${BOOTSTRAP}" "${ADMIN_CONFIG[@]}" \
    --create --if-not-exists \
    --topic "${name}" \
    --partitions "${partitions}" \
    --replication-factor "${REPLICATION}" \
    --config "retention.ms=${retention}" \
    --config "min.insync.replicas=1" \
    ${extra} >/dev/null
  echo "    - ${name} (partitions=${partitions})"
}

create_domain() {
  local domain="$1"
  create_topic "rasta.${domain}.v1" "${PARTITIONS}" "${RETENTION_MS}"
  # Retry topic: consumers republish here with a backoff attempt counter.
  create_topic "rasta.${domain}.v1.retry" "${PARTITIONS}" "${RETENTION_MS}"
  # DLQ: retained far longer — these need human eyes, not expiry.
  create_topic "rasta.${domain}.v1.dlq" 1 "2592000000" # 30 days
}

# Each kafka-topics.sh call is a JVM start, so a few domains run at once
# (KAFKA_TOPIC_PARALLELISM, default 4). Any failure still fails the script.
echo "==> Creating domain topics"
PARALLELISM="${KAFKA_TOPIC_PARALLELISM:-4}"
pids=()
failed=0
for domain in "${DOMAINS[@]}"; do
  create_domain "${domain}" &
  pids+=("$!")
  if [ "${#pids[@]}" -ge "${PARALLELISM}" ]; then
    for pid in "${pids[@]}"; do wait "${pid}" || failed=1; done
    pids=()
  fi
done
for pid in "${pids[@]}"; do wait "${pid}" || failed=1; done
if [ "${failed}" -ne 0 ]; then
  echo "==> A topic could not be created" >&2
  exit 1
fi

echo "==> Creating compacted state topics"
# The audit stream is the platform's tamper-evident record: never expire it in
# a real deployment. 30 days here only to keep laptops from filling up.
create_topic "rasta.audit.trail.v1" "${PARTITIONS}" "2592000000"

echo "==> Kafka topics ready"
"${KAFKA_BIN}"/kafka-topics.sh --bootstrap-server "${BOOTSTRAP}" "${ADMIN_CONFIG[@]}" --list | sort
