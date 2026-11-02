#!/bin/bash
# -----------------------------------------------------------------------------
# Creates every Rasta platform topic the contracts declare: each topic and its
# `.retry` twin, and each consumer's dead-letter topic — read from topics.txt,
# which `pnpm kafka:acl:generate` writes from TOPIC_PRODUCERS and
# TOPIC_CONSUMERS together with the ACLs, so the two cannot disagree (RUN-006).
# TOPICS_FILE defaults to the copy next to this script.
#
# Every topic gets an explicit `max.message.bytes` (PR #378 r2 F1), and this
# script never lowers one (r4 F2) — said exactly (r5, PM decision D-066):
# a single provisioner never lowers a limit; a concurrent writer is detected
# only if its change lands before this run's re-read of that topic, just ahead
# of the write. topics.txt plans Kafka's default for a source topic; for a
# dead-letter topic, the largest limit of its sources plus the bound on the
# headers the shared consumer adds and GZIP's worst-case growth
# (`@rasta/contracts` dead-letter-size.ts says what that covers and what it
# does not). On a running broker:
#
#   1. preflight: every topic's EFFECTIVE limit is read (`--describe --all`,
#      so an inherited broker default counts as surely as an override), and
#      the script stops, having changed nothing, if one cannot be read;
#   2. every dead-letter topic is created, or raised, to room over the largest
#      limit its sources will end with — their planned limit, or a larger one
#      they already have — and read back;
#   3. only then is every other topic created with its planned limit, or
#      raised to it; a topic with a larger limit keeps it and is named;
#   4. everything is read back: each at least its target, none below what it
#      had, every dead-letter topic with room over its sources as they are.
#
# Steps 2 and 3 take one topic at a time, nothing in the background. Before
# raising a topic it reads that topic's limit again and stops, writing
# nothing further, if it is not what the preflight read; after raising it, it
# reads it back and stops unless it holds at least the larger of the two. A
# create is refused by the broker if the topic exists by then, and stops the
# run the same way. Kafka's config alter is unconditional (IncrementalAlter-
# Configs carries a name, an operation and a value — nothing to compare), so
# a change landing between that re-read and the write is overwritten unseen.
#
# PRECONDITION — one writer of topic configuration per broker at a time: while
# this runs, no second provisioner, no manual `kafka-configs --alter` of a
# topic and no change of the broker default `message.max.bytes`. Compose runs
# one kafka-init per stack; every CI job that needs Kafka starts a broker of
# its own (ci-up.sh) and provisions it once; the broker tests provision their
# own topics one run after another. Nothing here can enforce it across hosts.
#
# A re-run changes nothing. A run that stops part-way leaves no source above
# what its dead-letter topics have room for. Retention and partitions of an
# existing topic are never touched, and this script has no way to lower a
# limit: a topic that must shrink needs an operator, who drains it first
# (docs/runbooks/replay-dlq.md). A limit a topic inherits from the broker
# default stays inherited, and moves with that default.
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

# shellcheck source=topic-limits.sh
source "$(dirname "$0")/topic-limits.sh"

fail() {
  echo "==> $*" >&2
  exit 1
}

# ---------------------------------------------------------------- the plan
# topics.txt: `<name> <kind> <planned max.message.bytes> [<sources>]`, the
# sources (comma-separated) on a dead-letter topic's line only, and the bound
# on the headers a dead letter adds in its `#@` line. Read whole, and refused
# whole, before the broker is asked anything.
bound="$(sed -n 's/^#@ dead-letter-added-headers-max-bytes \([1-9][0-9]*\)$/\1/p' "${TOPICS_FILE}")"
case "${bound}" in
  '' | *[!0-9]*) fail "${TOPICS_FILE} states no single dead-letter-added-headers-max-bytes; run pnpm kafka:acl:generate" ;;
esac
declare -A KIND=() PLANNED=() SOURCES=() EXISTS=() CURRENT=() ORIGIN=() BASE=() TARGET=() READ=()
NAMES=()
DEAD_LETTERS=()
OTHERS=()
while read -r name kind max_bytes sources; do
  case "${name}" in '' | \#*) continue ;; esac
  case "${name}" in *[!a-zA-Z0-9._-]*) fail "${name}: not a topic name" ;; esac
  case "${max_bytes}" in '' | *[!0-9]*) fail "${name}: topics.txt states no max.message.bytes" ;; esac
  case "${kind}" in stream | retry | audit-trail | dead-letter) ;; *) fail "${name}: unknown kind ${kind}" ;; esac
  [ -z "${KIND[${name}]:-}" ] || fail "${name}: listed twice in topics.txt"
  KIND[${name}]="${kind}"
  PLANNED[${name}]="${max_bytes}"
  SOURCES[${name}]="${sources}"
  NAMES+=("${name}")
done < "${TOPICS_FILE}"
for name in "${NAMES[@]}"; do
  if [ "${KIND[${name}]}" = dead-letter ]; then
    [ -n "${SOURCES[${name}]}" ] || fail "${name}: topics.txt lists no sources for this dead-letter topic"
    IFS=, read -r -a list <<< "${SOURCES[${name}]}"
    for source in "${list[@]}"; do
      [ -n "${KIND[${source}]:-}" ] || fail "${name}: its source ${source} is not in topics.txt"
      # Every dead-letter topic is raised before any source; one that was a
      # source itself would need an order this script does not have.
      [ "${KIND[${source}]}" != dead-letter ] || fail "${name}: its source ${source} is a dead-letter topic"
    done
    DEAD_LETTERS+=("${name}")
  else
    [ -z "${SOURCES[${name}]}" ] || fail "${name}: only a dead-letter topic lists sources"
    OTHERS+=("${name}")
  fi
done

# `<topic> <effective max.message.bytes> <where it comes from>` for every topic
# on the broker: one JVM, `--all`, so a limit a topic inherits (the broker's
# `message.max.bytes`, static or dynamic) is read as surely as its own
# override. Fails on any output it cannot read for certain (`effective_limits`).
describe_limits() {
  "${KAFKA_BIN}"/kafka-configs.sh --bootstrap-server "${BOOTSTRAP}" "${ADMIN_CONFIG[@]}" --describe --all --entity-type topics | effective_limits
}

# ---------------------------------------------------------------- preflight
# Every limit is read before anything is created or changed (PR #378 r4 F2).
# A topic the broker does not list is absent, and is created; a listed topic
# whose effective limit cannot be read stops the script here, unchanged.
echo "==> Reading the effective max.message.bytes of every topic before changing any"
listed="$("${KAFKA_BIN}"/kafka-topics.sh --bootstrap-server "${BOOTSTRAP}" "${ADMIN_CONFIG[@]}" --list)" ||
  fail "The topics could not be listed; nothing was changed"
described="$(describe_limits)" ||
  fail "The effective limits could not be read; nothing was changed"
for name in "${NAMES[@]}"; do
  if ! grep -qxF "${name}" <<< "${listed}"; then
    EXISTS[${name}]=0
    continue
  fi
  line="$(awk -v topic="${name}" '$1 == topic' <<< "${described}")"
  [ -n "${line}" ] || fail "${name} exists, but its effective max.message.bytes was not described; nothing was changed"
  read -r _ value origin <<< "${line}"
  EXISTS[${name}]=1
  CURRENT[${name}]="${value}"
  ORIGIN[${name}]="${origin}"
done

# Never lower a limit. A topic that is not a dead-letter topic gets its planned
# limit, or keeps a larger one it has. A dead-letter topic gets room over the
# largest limit any of its sources will end with — planned or larger, kept —
# or keeps a larger one it has. BASE is what the contracts and the sources
# ask for; TARGET is that, or the topic's own larger limit.
for name in "${OTHERS[@]}"; do
  BASE[${name}]="${PLANNED[${name}]}"
done
for name in "${OTHERS[@]}" "${DEAD_LETTERS[@]}"; do
  if [ "${KIND[${name}]}" = dead-letter ]; then
    largest=0
    IFS=, read -r -a list <<< "${SOURCES[${name}]}"
    for source in "${list[@]}"; do
      if [ "${TARGET[${source}]}" -gt "${largest}" ]; then largest="${TARGET[${source}]}"; fi
    done
    BASE[${name}]="$(dead_letter_limit "${largest}" "${bound}")"
    if [ "${PLANNED[${name}]}" -gt "${BASE[${name}]}" ]; then BASE[${name}]="${PLANNED[${name}]}"; fi
  fi
  TARGET[${name}]="${BASE[${name}]}"
  if [ "${EXISTS[${name}]}" = 1 ] && [ "${CURRENT[${name}]}" -gt "${BASE[${name}]}" ]; then
    TARGET[${name}]="${CURRENT[${name}]}"
  fi
done

# One topic's effective limit as `<value> <where it comes from>`, read now —
# the same `--describe --all` and the same strict parser as the preflight.
limit_now() {
  local out line
  out="$("${KAFKA_BIN}"/kafka-configs.sh --bootstrap-server "${BOOTSTRAP}" "${ADMIN_CONFIG[@]}" --describe --all --entity-type topics --entity-name "$1" | effective_limits)" ||
    return 1
  line="$(awk -v topic="$1" '$1 == topic { print $2, $3 }' <<< "${out}")"
  [ -n "${line}" ] || return 1
  echo "${line}"
}

create_topic() {
  local name="$1"
  local partitions="$2"
  local retention="$3"
  local max_bytes="$4"

  # No --if-not-exists: the broker creates a topic only if it does not exist,
  # so a topic another writer created since the preflight fails here instead
  # of being taken for ours.
  "${KAFKA_BIN}"/kafka-topics.sh --bootstrap-server "${BOOTSTRAP}" "${ADMIN_CONFIG[@]}" \
    --create \
    --topic "${name}" \
    --partitions "${partitions}" \
    --replication-factor "${REPLICATION}" \
    --config "retention.ms=${retention}" \
    --config "min.insync.replicas=1" \
    --config "max.message.bytes=${max_bytes}" >/dev/null ||
    fail "${name} could not be created — another writer may have created it since this run read the broker; nothing further was changed. Re-run once no other provisioner or operator is changing topics."
  echo "    - ${name}: created (partitions=${partitions}, max.message.bytes=${max_bytes})"
}

# One topic, then the next — nothing runs in the background, so a refusal
# below ends the run with nothing further changed (PR #378 r5, D-066):
#
#   - absent at the preflight: created with its target (a create the broker
#     refuses if the topic now exists);
#   - below what it is asked for: its effective limit is read AGAIN, and if
#     that is not what the plan was built on, the run stops before writing —
#     another writer has been here, and this plan may be smaller than theirs.
#     Otherwise it is raised, read back, and must hold at least the larger of
#     what it had and its target before the next topic is touched;
#   - otherwise left exactly as it is, and said so when it keeps more.
#
# What this cannot see: a change that lands after that second read and before
# this run's alter is overwritten (Kafka's alter has no "only if still"
# condition — IncrementalAlterConfigs carries a name, an operation and a
# value, nothing to compare). Hence the precondition in the header.
#
# Partitions and retention by kind. Dead letters need human eyes, not expiry;
# the audit trail is the platform's tamper-evident record — never expire it in
# a real deployment, 30 days here only to keep laptops from filling up.
# Retention and partitions of an existing topic are never touched.
apply_limit() {
  local name="$1" now attempt
  if [ "${EXISTS[${name}]}" = 0 ]; then
    case "${KIND[${name}]}" in
      stream | retry) create_topic "${name}" "${PARTITIONS}" "${RETENTION_MS}" "${TARGET[${name}]}" ;;
      dead-letter) create_topic "${name}" 1 "2592000000" "${TARGET[${name}]}" ;;
      audit-trail) create_topic "${name}" "${PARTITIONS}" "2592000000" "${TARGET[${name}]}" ;;
    esac
  elif [ "${CURRENT[${name}]}" -lt "${BASE[${name}]}" ]; then
    now="$(limit_now "${name}")" ||
      fail "${name}: its limit could not be read again before raising it; nothing further was changed"
    [ "${now}" = "${CURRENT[${name}]} ${ORIGIN[${name}]}" ] ||
      fail "${name}: max.message.bytes is now ${now}, not the ${CURRENT[${name}]} (${ORIGIN[${name}]}) this run planned from — another writer changed it; nothing further was changed. Re-run once no other provisioner or operator is changing topics."
    "${KAFKA_BIN}"/kafka-configs.sh --bootstrap-server "${BOOTSTRAP}" "${ADMIN_CONFIG[@]}" --alter --entity-type topics --entity-name "${name}" --add-config "max.message.bytes=${BASE[${name}]}" >/dev/null ||
      fail "${name}: max.message.bytes could not be raised; nothing further was changed"
    # A broker can answer a describe a moment before a change reaches it, so a
    # shortfall is asked again twice. BASE is above CURRENT here, so it is the
    # larger of the two.
    for attempt in 1 2 3; do
      if [ "${attempt}" -gt 1 ]; then sleep 2; fi
      now="$(limit_now "${name}")" || continue
      if [ "${now%% *}" -ge "${BASE[${name}]}" ]; then break; fi
    done
    [ -n "${now}" ] && [ "${now%% *}" -ge "${BASE[${name}]}" ] ||
      fail "${name}: max.message.bytes read back as ${now:-nothing}, below the ${BASE[${name}]} just written; nothing further was changed"
    echo "    - ${name}: max.message.bytes ${CURRENT[${name}]} (${ORIGIN[${name}]}) raised to ${BASE[${name}]}"
  elif [ "${CURRENT[${name}]}" -gt "${BASE[${name}]}" ]; then
    echo "    - ${name}: keeps max.message.bytes ${CURRENT[${name}]} (${ORIGIN[${name}]}), more than the ${BASE[${name}]} asked for"
  fi
}

# Read back: each topic named is at least its target, and none is below what
# it had before — nothing was lowered. A broker can answer a describe a moment
# before a change reaches it, so a shortfall is asked again twice.
read_back() {
  local attempt now value problems=""
  for attempt in 1 2 3; do
    if [ "${attempt}" -gt 1 ]; then sleep 2; fi
    problems=""
    if ! now="$(describe_limits)"; then
      problems="the limits could not be read back"
      continue
    fi
    for name in "$@"; do
      value="$(awk -v topic="${name}" '$1 == topic { print $2 }' <<< "${now}")"
      if [ -z "${value}" ]; then
        problems+=" ${name}: not described;"
        continue
      fi
      if [ "${value}" -lt "${TARGET[${name}]}" ]; then problems+=" ${name}: ${value}, below ${TARGET[${name}]};"; fi
      if [ "${EXISTS[${name}]}" = 1 ] && [ "${value}" -lt "${CURRENT[${name}]}" ]; then
        problems+=" ${name}: lowered from ${CURRENT[${name}]} to ${value};"
      fi
      READ[${name}]="${value}"
    done
    if [ -z "${problems}" ]; then return 0; fi
  done
  echo "==> max.message.bytes read back wrong:${problems}" >&2
  return 1
}

# ---------------------------------------------------------------- apply
# Dead-letter topics first, read back, and only then any other topic: a run
# that stops part-way leaves no source raised, or created, above what its
# dead-letter topics have room for (r4 F2). One topic at a time (r5): any
# refusal in apply_limit ends the run there.
echo "==> Dead-letter topics: max.message.bytes from their sources' limits (topics.txt)"
for name in "${DEAD_LETTERS[@]}"; do apply_limit "${name}"; done
read_back "${DEAD_LETTERS[@]}" ||
  fail "A dead-letter topic's limit is not in place; no other topic was created or changed"

echo "==> Every other topic: its planned max.message.bytes, or a larger one it has (topics.txt)"
for name in "${OTHERS[@]}"; do apply_limit "${name}"; done
read_back "${NAMES[@]}" || fail "A topic's max.message.bytes is not in place"

# The headroom itself, on what the broker now has: every dead-letter topic at
# least `dead_letter_limit` over the largest effective limit of its sources.
for name in "${DEAD_LETTERS[@]}"; do
  largest=0
  IFS=, read -r -a list <<< "${SOURCES[${name}]}"
  for source in "${list[@]}"; do
    if [ "${READ[${source}]}" -gt "${largest}" ]; then largest="${READ[${source}]}"; fi
  done
  need="$(dead_letter_limit "${largest}" "${bound}")"
  [ "${READ[${name}]}" -ge "${need}" ] ||
    fail "${name}: max.message.bytes ${READ[${name}]} leaves no room over its sources' ${largest}; it needs ${need}"
done
echo "==> max.message.bytes in place; this run lowered nothing"

# A freshly started broker lists topics while `__consumer_offsets` is still
# loading, and a consumer joining in that window is told the coordinator is
# not available — so a test waits on the wrong thing. Asking for the groups
# loads it now, before anything joins one.
"${KAFKA_BIN}"/kafka-consumer-groups.sh --bootstrap-server "${BOOTSTRAP}" "${ADMIN_CONFIG[@]}" --list >/dev/null

echo "==> Kafka topics ready"
"${KAFKA_BIN}"/kafka-topics.sh --bootstrap-server "${BOOTSTRAP}" "${ADMIN_CONFIG[@]}" --list | sort
