#!/bin/bash
# -----------------------------------------------------------------------------
# Creates every Rasta platform topic the contracts declare: each topic and its
# `.retry` twin, and each consumer's dead-letter topic — read from topics.txt,
# which `pnpm kafka:acl:generate` writes from TOPIC_PRODUCERS and
# TOPIC_CONSUMERS together with the ACLs, so the two cannot disagree (RUN-006).
# TOPICS_FILE defaults to the copy next to this script.
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

TOPICS_FILE="${TOPICS_FILE:-$(dirname "$0")/topics.txt}"
[ -s "${TOPICS_FILE}" ] || { echo "==> ${TOPICS_FILE} missing; run pnpm kafka:acl:generate" >&2; exit 1; }

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

# Partitions and retention by kind. Dead letters need human eyes, not expiry;
# the audit trail is the platform's tamper-evident record — never expire it in
# a real deployment, 30 days here only to keep laptops from filling up.
create_kind() {
  local name="$1"
  case "$2" in
    stream | retry) create_topic "${name}" "${PARTITIONS}" "${RETENTION_MS}" ;;
    dead-letter) create_topic "${name}" 1 "2592000000" ;;
    audit-trail) create_topic "${name}" "${PARTITIONS}" "2592000000" ;;
    *)
      echo "==> ${name}: unknown kind $2" >&2
      return 1
      ;;
  esac
}

# Each kafka-topics.sh call is a JVM start, so a few run at once
# (KAFKA_TOPIC_PARALLELISM, default 6). Any failure still fails the script.
echo "==> Creating topics from $(basename "${TOPICS_FILE}")"
PARALLELISM="${KAFKA_TOPIC_PARALLELISM:-6}"
pids=()
failed=0
while read -r name kind; do
  case "${name}" in '' | \#*) continue ;; esac
  create_kind "${name}" "${kind}" &
  pids+=("$!")
  if [ "${#pids[@]}" -ge "${PARALLELISM}" ]; then
    for pid in "${pids[@]}"; do wait "${pid}" || failed=1; done
    pids=()
  fi
done < "${TOPICS_FILE}"
for pid in "${pids[@]}"; do wait "${pid}" || failed=1; done
if [ "${failed}" -ne 0 ]; then
  echo "==> A topic could not be created" >&2
  exit 1
fi

# A freshly started broker lists topics while `__consumer_offsets` is still
# loading, and a consumer joining in that window is told the coordinator is
# not available — so a test waits on the wrong thing. Asking for the groups
# loads it now, before anything joins one.
"${KAFKA_BIN}"/kafka-consumer-groups.sh --bootstrap-server "${BOOTSTRAP}" "${ADMIN_CONFIG[@]}" --list >/dev/null

echo "==> Kafka topics ready"
"${KAFKA_BIN}"/kafka-topics.sh --bootstrap-server "${BOOTSTRAP}" "${ADMIN_CONFIG[@]}" --list | sort
