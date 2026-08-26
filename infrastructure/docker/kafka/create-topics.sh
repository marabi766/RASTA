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

echo "==> Waiting for Kafka at ${BOOTSTRAP}"
for _ in $(seq 1 30); do
  if "${KAFKA_BIN}"/kafka-topics.sh --bootstrap-server "${BOOTSTRAP}" --list >/dev/null 2>&1; then
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
  "${KAFKA_BIN}"/kafka-topics.sh --bootstrap-server "${BOOTSTRAP}" \
    --create --if-not-exists \
    --topic "${name}" \
    --partitions "${partitions}" \
    --replication-factor "${REPLICATION}" \
    --config "retention.ms=${retention}" \
    --config "min.insync.replicas=1" \
    ${extra} >/dev/null
  echo "    - ${name} (partitions=${partitions})"
}

echo "==> Creating domain topics"
for domain in "${DOMAINS[@]}"; do
  create_topic "rasta.${domain}.v1" "${PARTITIONS}" "${RETENTION_MS}"
  # Retry topic: consumers republish here with a backoff attempt counter.
  create_topic "rasta.${domain}.v1.retry" "${PARTITIONS}" "${RETENTION_MS}"
  # DLQ: retained far longer — these need human eyes, not expiry.
  create_topic "rasta.${domain}.v1.dlq" 1 "2592000000" # 30 days
done

echo "==> Creating compacted state topics"
# The audit stream is the platform's tamper-evident record: never expire it in
# a real deployment. 30 days here only to keep laptops from filling up.
create_topic "rasta.audit.trail.v1" "${PARTITIONS}" "2592000000"

echo "==> Kafka topics ready"
"${KAFKA_BIN}"/kafka-topics.sh --bootstrap-server "${BOOTSTRAP}" --list | sort
