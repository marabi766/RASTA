#!/usr/bin/env bash
# The broker's TLS material, generated inside the apache/kafka image with its
# own keytool (RUN-006, ADR-061 § 3). No host tool is needed — a Windows
# machine runs this exactly as CI does.
#
#   TLS_DIR          where the material lands (default /tls). In compose, the
#                    `kafka-tls` named volume; in CI, a runner temp directory.
#   CA_EXPORT_DIR    optional: also copy the CA certificate here, for clients
#                    outside Docker (the services and tests on the host). It is
#                    a public certificate; nothing secret is exported.
#   BROKER_UID       owner of the files, the image's user (default 1000).
#
# A throwaway CA signs the broker certificate (SAN: kafka, localhost,
# 127.0.0.1) and its private key is then deleted: nothing can ever issue
# another certificate this CA vouches for. The keystore password is random and
# stays in TLS_DIR, readable by the broker only. Idempotent: an existing,
# unexpired keystore is kept.
#
# Nothing here is ever committed (.gitignore covers the export directory).
set -euo pipefail

TLS_DIR="${TLS_DIR:-/tls}"
BROKER_UID="${BROKER_UID:-1000}"
DAYS="${TLS_VALIDITY_DAYS:-825}"
mkdir -p "${TLS_DIR}"
cd "${TLS_DIR}"

export_ca() {
  if [ -n "${CA_EXPORT_DIR:-}" ]; then
    mkdir -p "${CA_EXPORT_DIR}"
    cp ca.pem "${CA_EXPORT_DIR}/ca.pem"
    chmod 0644 "${CA_EXPORT_DIR}/ca.pem"
  fi
}

if [ -s broker.p12 ] && [ -s ca.pem ] && [ -s keystore.password ] &&
  keytool -list -keystore broker.p12 -storetype PKCS12 \
    -storepass "$(cat keystore.password)" -alias broker >/dev/null 2>&1 &&
  openssl x509 -in ca.pem -noout -checkend 86400 >/dev/null 2>&1; then
  echo "==> Broker TLS material present in ${TLS_DIR}; keeping it"
  export_ca
  exit 0
fi

echo "==> Generating a throwaway CA and the broker certificate in ${TLS_DIR}"
rm -f ca.p12 ca.pem broker.p12 broker.csr broker.pem keystore.password
umask 077
openssl rand -hex 24 > keystore.password
PASS="$(cat keystore.password)"

keytool -genkeypair -alias ca -dname "CN=rasta-development-kafka-ca" \
  -keyalg RSA -keysize 2048 -validity "${DAYS}" -ext bc:c \
  -keystore ca.p12 -storetype PKCS12 -storepass "${PASS}" >/dev/null 2>&1
keytool -exportcert -alias ca -keystore ca.p12 -storetype PKCS12 \
  -storepass "${PASS}" -rfc -file ca.pem >/dev/null 2>&1

keytool -genkeypair -alias broker -dname "CN=kafka" \
  -keyalg RSA -keysize 2048 -validity "${DAYS}" \
  -keystore broker.p12 -storetype PKCS12 -storepass "${PASS}" >/dev/null 2>&1
keytool -certreq -alias broker -keystore broker.p12 -storetype PKCS12 \
  -storepass "${PASS}" -file broker.csr >/dev/null 2>&1
keytool -gencert -alias ca -keystore ca.p12 -storetype PKCS12 -storepass "${PASS}" \
  -infile broker.csr -outfile broker.pem -rfc -validity "${DAYS}" \
  -ext "SAN=dns:kafka,dns:localhost,ip:127.0.0.1" \
  -ext "KU=digitalSignature,keyEncipherment" -ext "EKU=serverAuth" >/dev/null 2>&1
keytool -importcert -noprompt -alias ca -file ca.pem \
  -keystore broker.p12 -storetype PKCS12 -storepass "${PASS}" >/dev/null 2>&1
keytool -importcert -noprompt -alias broker -file broker.pem \
  -keystore broker.p12 -storetype PKCS12 -storepass "${PASS}" >/dev/null 2>&1

# The CA's private key goes: the certificate it signed is all it was for.
rm -f ca.p12 broker.csr broker.pem
chmod 0644 ca.pem
chmod 0600 broker.p12 keystore.password
chown "${BROKER_UID}" broker.p12 keystore.password ca.pem 2>/dev/null || true
export_ca
echo "==> Broker TLS material ready"
