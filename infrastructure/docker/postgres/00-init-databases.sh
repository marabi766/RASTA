#!/bin/bash
# -----------------------------------------------------------------------------
# Creates one logical database + one dedicated role per service.
#
# ADR-005 (Database Ownership per Service): services never share tables. In dev
# they share a PostgreSQL *cluster* to keep the laptop footprint sane, but each
# service can only reach its own database with its own credentials — the same
# boundary that becomes a separate cluster/instance in production.
# -----------------------------------------------------------------------------
set -euo pipefail

SERVICE_PASSWORD="${POSTGRES_SERVICE_PASSWORD:-rasta_service_dev_password}"

SERVICES=(
  identity
  organization
  asset
  fleet
  maintenance
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
  analytics
)

# Infrastructure databases that are not owned by a Rasta service.
INFRA_DATABASES=(keycloak temporal temporal_visibility)

psql_exec() {
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$1" -c "$2"
}

echo "==> Creating per-service roles and databases"
for svc in "${SERVICES[@]}"; do
  role="rasta_${svc}"
  db="rasta_${svc}"

  psql_exec postgres "DO \$\$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
        CREATE ROLE ${role} LOGIN PASSWORD '${SERVICE_PASSWORD}';
      END IF;
    END \$\$;"

  if ! psql -tAc "SELECT 1 FROM pg_database WHERE datname='${db}'" --username "$POSTGRES_USER" postgres | grep -q 1; then
    psql_exec postgres "CREATE DATABASE ${db} OWNER ${role} ENCODING 'UTF8'"
  fi

  # Deny cross-service access explicitly rather than relying on defaults.
  psql_exec postgres "REVOKE ALL ON DATABASE ${db} FROM PUBLIC"
  psql_exec postgres "GRANT ALL PRIVILEGES ON DATABASE ${db} TO ${role}"
  psql_exec "${db}" "GRANT ALL ON SCHEMA public TO ${role}"

  echo "    - ${db} (owner ${role})"
done

echo "==> Enabling PostGIS where geospatial data is owned"
# Organizations, assets, projects and warehouses all carry a location.
for svc in organization asset fleet construction inventory analytics; do
  psql_exec "rasta_${svc}" "CREATE EXTENSION IF NOT EXISTS postgis"
  psql_exec "rasta_${svc}" "CREATE EXTENSION IF NOT EXISTS pg_trgm"
done

echo "==> Creating infrastructure databases"
for db in "${INFRA_DATABASES[@]}"; do
  if ! psql -tAc "SELECT 1 FROM pg_database WHERE datname='${db}'" --username "$POSTGRES_USER" postgres | grep -q 1; then
    psql_exec postgres "CREATE DATABASE ${db} OWNER ${POSTGRES_USER} ENCODING 'UTF8'"
    echo "    - ${db}"
  fi
done

echo "==> PostgreSQL bootstrap complete"
