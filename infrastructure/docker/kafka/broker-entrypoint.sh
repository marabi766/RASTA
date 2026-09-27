#!/usr/bin/env bash
# The development broker, authenticated and authorised (RUN-006, ADR-061 § 3,
# amendment 2026-09-27). The same script starts the compose broker and the CI
# broker, so neither can drift from the other.
#
# Listeners:
#   EXTERNAL  :9092  SASL_SSL, SCRAM-SHA-512 — clients outside Docker
#   BROKER    :9094  SASL_SSL, SCRAM-SHA-512 — clients on the Docker network,
#                    and the broker's own inter-broker traffic (as `admin`)
#   CONTROLLER 127.0.0.1:9093, PLAINTEXT — the KRaft controller, bound to the
#                    container's loopback and never published. Its unauthenticated
#                    peer (the broker in the same process) is the only
#                    `User:ANONYMOUS` the authoriser ever sees.
#
# Authorisation: StandardAuthorizer, allow.everyone.if.no.acl.found=false,
# super users `admin` (bootstrap only) and the loopback controller peer. Every
# other principal can do exactly what `broker-acls.json` grants — nothing
# until the bootstrap applies it.
#
# Credentials: every principal in principals.txt, and `admin`, is added as a
# SCRAM-SHA-512 credential when the storage is formatted, from
# KAFKA_SASL_PASSWORD_<NAME> (fleet-service -> KAFKA_SASL_PASSWORD_FLEET). A
# missing one stops the broker: a principal with no credential is a service
# that silently cannot connect. Rotation later: docs/runbooks/kafka-credential-rotation.md.
#
# Required mounts: /tls (tls.sh output, read-only) and /bootstrap (this
# directory, read-only). Optional: KAFKA_ADVERTISED_EXTERNAL (default
# localhost:9092), KAFKA_ADVERTISED_BROKER (default kafka:9094).
set -euo pipefail

TLS_DIR="${TLS_DIR:-/tls}"
BOOTSTRAP_DIR="${BOOTSTRAP_DIR:-/bootstrap}"
LOG_DIRS="${KAFKA_LOG_DIRS:-/tmp/kraft-combined-logs}"

password_variable() {
  local stem="${1%-service}"
  stem="${stem//-/_}"
  printf 'KAFKA_SASL_PASSWORD_%s' "${stem^^}"
}

password_of() {
  local variable
  variable="$(password_variable "$1")"
  local value="${!variable:-}"
  if [ -z "${value}" ]; then
    echo "broker: ${variable} is not set; principal $1 would have no credential" >&2
    exit 1
  fi
  printf '%s' "${value}"
}

jaas_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

[ -s "${TLS_DIR}/broker.p12" ] || { echo "broker: ${TLS_DIR}/broker.p12 missing; run tls.sh first" >&2; exit 1; }
KEYSTORE_PASSWORD="$(cat "${TLS_DIR}/keystore.password")"
ADMIN_PASSWORD="$(password_of admin)"

# ---------------------------------------------------------------- listeners
export KAFKA_NODE_ID="${KAFKA_NODE_ID:-1}"
export KAFKA_PROCESS_ROLES='broker,controller'
export KAFKA_CONTROLLER_QUORUM_VOTERS="${KAFKA_NODE_ID}@127.0.0.1:9093"
export KAFKA_CONTROLLER_LISTENER_NAMES='CONTROLLER'
export KAFKA_LISTENERS='CONTROLLER://127.0.0.1:9093,BROKER://:9094,EXTERNAL://:9092'
export KAFKA_ADVERTISED_LISTENERS="BROKER://${KAFKA_ADVERTISED_BROKER:-kafka:9094},EXTERNAL://${KAFKA_ADVERTISED_EXTERNAL:-localhost:9092}"
export KAFKA_LISTENER_SECURITY_PROTOCOL_MAP='CONTROLLER:PLAINTEXT,BROKER:SASL_SSL,EXTERNAL:SASL_SSL'
export KAFKA_INTER_BROKER_LISTENER_NAME='BROKER'

# ---------------------------------------------------------------- SASL / TLS
export KAFKA_SASL_ENABLED_MECHANISMS='SCRAM-SHA-512'
export KAFKA_SASL_MECHANISM_INTER_BROKER_PROTOCOL='SCRAM-SHA-512'
export KAFKA_LISTENER_NAME_BROKER_SCRAM___SHA___512_SASL_JAAS_CONFIG="org.apache.kafka.common.security.scram.ScramLoginModule required username=\"admin\" password=\"$(jaas_escape "${ADMIN_PASSWORD}")\";"
export KAFKA_LISTENER_NAME_EXTERNAL_SCRAM___SHA___512_SASL_JAAS_CONFIG='org.apache.kafka.common.security.scram.ScramLoginModule required;'
export KAFKA_SSL_KEYSTORE_TYPE='PKCS12'
export KAFKA_SSL_KEYSTORE_LOCATION="${TLS_DIR}/broker.p12"
export KAFKA_SSL_KEYSTORE_PASSWORD="${KEYSTORE_PASSWORD}"
export KAFKA_SSL_KEY_PASSWORD="${KEYSTORE_PASSWORD}"
export KAFKA_SSL_CLIENT_AUTH='none'
# The broker's own client side (inter-broker, and the listener self-check at
# startup) trusts the same throwaway CA.
export KAFKA_SSL_TRUSTSTORE_TYPE='PEM'
export KAFKA_SSL_TRUSTSTORE_LOCATION="${TLS_DIR}/ca.pem"

# ---------------------------------------------------------------- authorisation
export KAFKA_AUTHORIZER_CLASS_NAME='org.apache.kafka.metadata.authorizer.StandardAuthorizer'
export KAFKA_ALLOW_EVERYONE_IF_NO_ACL_FOUND='false'
export KAFKA_SUPER_USERS='User:admin;User:ANONYMOUS'
export KAFKA_AUTO_CREATE_TOPICS_ENABLE='false'

# ---------------------------------------------------------------- single node
export KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR='1'
export KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR='1'
export KAFKA_TRANSACTION_STATE_LOG_MIN_ISR='1'
export KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS='0'
export KAFKA_LOG_DIRS="${LOG_DIRS}"

# ---------------------------------------------------------------- credentials at format
if [ ! -s "${LOG_DIRS}/meta.properties" ]; then
  scram=(--add-scram "SCRAM-SHA-512=[name=admin,password=${ADMIN_PASSWORD}]")
  count=0
  while IFS= read -r principal; do
    case "${principal}" in '' | \#*) continue ;; esac
    scram+=(--add-scram "SCRAM-SHA-512=[name=${principal},password=$(password_of "${principal}")]")
    count=$((count + 1))
  done < "${BOOTSTRAP_DIR}/principals.txt"

  format="$(mktemp)"
  cat > "${format}" <<EOF
process.roles=${KAFKA_PROCESS_ROLES}
node.id=${KAFKA_NODE_ID}
controller.quorum.voters=${KAFKA_CONTROLLER_QUORUM_VOTERS}
controller.listener.names=${KAFKA_CONTROLLER_LISTENER_NAMES}
listeners=${KAFKA_LISTENERS}
advertised.listeners=${KAFKA_ADVERTISED_LISTENERS}
listener.security.protocol.map=${KAFKA_LISTENER_SECURITY_PROTOCOL_MAP}
inter.broker.listener.name=${KAFKA_INTER_BROKER_LISTENER_NAME}
sasl.enabled.mechanisms=${KAFKA_SASL_ENABLED_MECHANISMS}
sasl.mechanism.inter.broker.protocol=${KAFKA_SASL_MECHANISM_INTER_BROKER_PROTOCOL}
log.dirs=${LOG_DIRS}
EOF
  /opt/kafka/bin/kafka-storage.sh format -t "${CLUSTER_ID:?CLUSTER_ID is required}" \
    -c "${format}" "${scram[@]}" >/dev/null
  rm -f "${format}"
  echo "===> Storage formatted with SCRAM-SHA-512 credentials for admin and ${count} principals"
fi

# ---------------------------------------------------------------- admin client config
# For the healthcheck and the topic bootstrap inside this container only.
umask 077
cat > /tmp/admin.properties <<EOF
security.protocol=SASL_SSL
sasl.mechanism=SCRAM-SHA-512
sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="admin" password="$(jaas_escape "${ADMIN_PASSWORD}")";
ssl.truststore.type=PEM
ssl.truststore.location=${TLS_DIR}/ca.pem
EOF

exec /etc/kafka/docker/run
