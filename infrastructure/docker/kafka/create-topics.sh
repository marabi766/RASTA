#!/bin/bash
# -----------------------------------------------------------------------------
# Creates every Rasta platform topic the contracts declare: each topic and its
# `.retry` twin, and each consumer's dead-letter topic — read from topics.txt,
# which `pnpm kafka:acl:generate` writes from TOPIC_PRODUCERS and
# TOPIC_CONSUMERS together with the ACLs, so the two cannot disagree (RUN-006).
# TOPICS_FILE defaults to the copy next to this script.
#
# Every topic gets the `max.message.bytes` topics.txt states (PR #378 r2 F1):
# Kafka's default for a source topic, more for a dead-letter topic, so the dead
# letter of any record a source admitted fits. `--create --if-not-exists`
# leaves an existing topic as it is, so the limits are then read back for every
# topic and set where they differ: a re-run, or a broker provisioned before the
# limits existed, converges, and the script fails unless every topic ends with
# its limit. Retention and partitions of an existing topic are not touched.
#
# With KAFKA_PROVISION_PROFILE (compose's kafka-init) it first gives a
# credential to any principal of that profile that has none — one added to
# the contracts after the broker's log was formatted. It never overwrites one.
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

# RUN-006: the broker authenticates, so this connects as `admin` over
# SASL_SSL, trusting the throwaway CA tls.sh wrote. The admin's password comes
# from the bootstrap-only env file (compose) or ci-up.sh; without it, stop.
: "${KAFKA_SASL_PASSWORD_ADMIN:?the admin password is not set (infrastructure/docker/kafka/bootstrap.env.example)}"
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

echo "==> Waiting for Kafka at ${BOOTSTRAP}"
for _ in $(seq 1 30); do
  if "${KAFKA_BIN}"/kafka-topics.sh --bootstrap-server "${BOOTSTRAP}" "${ADMIN_CONFIG[@]}" --list >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

# The broker adds credentials only when it formats an empty log. With the log
# kept across recreation (compose's kafka-data volume), a principal added to
# the contracts later has none: give it one from the environment, as the
# format would have. An existing credential is never touched — a rotated
# password stays rotated. CI formats a fresh broker every run and skips this.
if [ -n "${KAFKA_PROVISION_PROFILE:-}" ]; then
  principals_file="$(dirname "$0")/principals.${KAFKA_PROVISION_PROFILE}.txt"
  [ -s "${principals_file}" ] || { echo "==> ${principals_file} missing" >&2; exit 1; }
  existing="$("${KAFKA_BIN}"/kafka-configs.sh --bootstrap-server "${BOOTSTRAP}" "${ADMIN_CONFIG[@]}" \
    --describe --entity-type users)"
  while IFS= read -r principal; do
    case "${principal}" in '' | \#*) continue ;; esac
    if grep -q "user-principal '${principal}'" <<< "${existing}"; then continue; fi
    stem="${principal%-service}"
    stem="${stem//-/_}"
    variable="KAFKA_SASL_PASSWORD_${stem^^}"
    [ -n "${!variable:-}" ] || { echo "==> ${variable} is not set; ${principal} has no credential" >&2; exit 1; }
    # On the command line, as the broker's own format passes --add-scram:
    # inside this bootstrap container only. (--add-config-file mangles the
    # SCRAM key.)
    "${KAFKA_BIN}"/kafka-configs.sh --bootstrap-server "${BOOTSTRAP}" "${ADMIN_CONFIG[@]}" \
      --alter --entity-type users --entity-name "${principal}" \
      --add-config "SCRAM-SHA-512=[password=${!variable}]" >/dev/null
    echo "==> Credential added for ${principal}, which had none"
  done < "${principals_file}"
fi

create_topic() {
  local name="$1"
  local partitions="$2"
  local retention="$3"
  local max_bytes="$4"

  "${KAFKA_BIN}"/kafka-topics.sh --bootstrap-server "${BOOTSTRAP}" "${ADMIN_CONFIG[@]}" \
    --create --if-not-exists \
    --topic "${name}" \
    --partitions "${partitions}" \
    --replication-factor "${REPLICATION}" \
    --config "retention.ms=${retention}" \
    --config "min.insync.replicas=1" \
    --config "max.message.bytes=${max_bytes}" >/dev/null
  echo "    - ${name} (partitions=${partitions}, max.message.bytes=${max_bytes})"
}

# Partitions and retention by kind. Dead letters need human eyes, not expiry;
# the audit trail is the platform's tamper-evident record — never expire it in
# a real deployment, 30 days here only to keep laptops from filling up.
create_kind() {
  local name="$1"
  local max_bytes="$3"
  case "${max_bytes}" in
    '' | *[!0-9]*)
      echo "==> ${name}: topics.txt states no max.message.bytes" >&2
      return 1
      ;;
  esac
  case "$2" in
    stream | retry) create_topic "${name}" "${PARTITIONS}" "${RETENTION_MS}" "${max_bytes}" ;;
    dead-letter) create_topic "${name}" 1 "2592000000" "${max_bytes}" ;;
    audit-trail) create_topic "${name}" "${PARTITIONS}" "2592000000" "${max_bytes}" ;;
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
while read -r name kind max_bytes; do
  case "${name}" in '' | \#*) continue ;; esac
  create_kind "${name}" "${kind}" "${max_bytes}" &
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

# `<topic> <max.message.bytes>` for every topic that overrides it: one JVM for
# all of them. A topic without the override inherits the broker's default and
# is listed with none.
topic_limits() {
  "${KAFKA_BIN}"/kafka-configs.sh --bootstrap-server "${BOOTSTRAP}" "${ADMIN_CONFIG[@]}" \
    --describe --entity-type topics |
    awk '/^Dynamic configs for topic / { topic = $5 }
         /^ +max\.message\.bytes=/ { split($1, kv, "="); print topic, kv[2] }'
}

# An existing topic keeps whatever it had: set the limit where it differs.
echo "==> Applying max.message.bytes from $(basename "${TOPICS_FILE}")"
current="$(topic_limits)"
pids=()
while read -r name _ max_bytes; do
  case "${name}" in '' | \#*) continue ;; esac
  if grep -qxF "${name} ${max_bytes}" <<< "${current}"; then continue; fi
  (
    "${KAFKA_BIN}"/kafka-configs.sh --bootstrap-server "${BOOTSTRAP}" "${ADMIN_CONFIG[@]}" \
      --alter --entity-type topics --entity-name "${name}" \
      --add-config "max.message.bytes=${max_bytes}" >/dev/null
    echo "    - ${name}: max.message.bytes set to ${max_bytes}"
  ) &
  pids+=("$!")
  if [ "${#pids[@]}" -ge "${PARALLELISM}" ]; then
    for pid in "${pids[@]}"; do wait "${pid}" || failed=1; done
    pids=()
  fi
done < "${TOPICS_FILE}"
for pid in "${pids[@]}"; do wait "${pid}" || failed=1; done

# Read back: every topic ends with exactly the limit topics.txt states.
current="$(topic_limits)"
while read -r name _ max_bytes; do
  case "${name}" in '' | \#*) continue ;; esac
  if ! grep -qxF "${name} ${max_bytes}" <<< "${current}"; then
    echo "==> ${name}: max.message.bytes is not ${max_bytes}" >&2
    failed=1
  fi
done < "${TOPICS_FILE}"
if [ "${failed}" -ne 0 ]; then
  echo "==> A topic's max.message.bytes could not be applied" >&2
  exit 1
fi

# A freshly started broker lists topics while `__consumer_offsets` is still
# loading, and a consumer joining in that window is told the coordinator is
# not available — so a test waits on the wrong thing. Asking for the groups
# loads it now, before anything joins one.
"${KAFKA_BIN}"/kafka-consumer-groups.sh --bootstrap-server "${BOOTSTRAP}" "${ADMIN_CONFIG[@]}" --list >/dev/null

echo "==> Kafka topics ready"
"${KAFKA_BIN}"/kafka-topics.sh --bootstrap-server "${BOOTSTRAP}" "${ADMIN_CONFIG[@]}" --list | sort
