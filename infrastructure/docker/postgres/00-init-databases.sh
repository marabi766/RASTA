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

  # CREATEDB is granted for local development only: `prisma migrate dev`
  # provisions a temporary shadow database to diff against. Production applies
  # migrations with `prisma migrate deploy`, which needs no shadow database and
  # therefore no such privilege — and never runs this script.
  psql_exec postgres "DO \$\$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
        CREATE ROLE ${role} LOGIN CREATEDB PASSWORD '${SERVICE_PASSWORD}';
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

# -----------------------------------------------------------------------------
# audit-service: a second role, because an append-only claim needs a barrier the
# service cannot lift.
#
# ADR-053 § 6 layer 1 revokes UPDATE/DELETE/TRUNCATE on `audit_event` from
# `rasta_audit`. Measured against PostgreSQL 16.4, that revoke does bite — an
# owner denied a privilege really is refused. But it is not an *independent*
# barrier, because the owner can grant it straight back to itself with no
# error, and a table-ownership split alone does not help either: `rasta_audit`
# owns the database, so it owns schema `public` through `pg_database_owner` and
# can `DROP TABLE` — or `DROP SCHEMA public CASCADE` — over any other role's
# objects there. Both were reproduced on a disposable database.
#
# What holds is a schema the runtime role does not own. `rasta_audit_migrator`
# owns schema `audit` and everything in it; `rasta_audit` gets USAGE and
# nothing more, so UPDATE, DELETE, TRUNCATE, DROP TABLE, DROP SCHEMA and CREATE
# in that schema are each refused with SQLSTATE 42501, while INSERT and SELECT
# work. The runtime role cannot widen its own grants: only an object's owner
# can, and it owns none of them.
#
# The two roles are deliberately not members of one another — membership would
# hand back exactly the powers this separates.
# -----------------------------------------------------------------------------
echo "==> Creating the audit migrator role and its owned schema"

# CREATEDB for the same local-development reason the service roles have it:
# `prisma migrate dev` provisions a shadow database. `migrate deploy`, which is
# what production runs, needs neither.
psql_exec postgres "DO \$\$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rasta_audit_migrator') THEN
      CREATE ROLE rasta_audit_migrator LOGIN CREATEDB PASSWORD '${SERVICE_PASSWORD}';
    END IF;
  END \$\$;"

psql_exec postgres "GRANT CONNECT ON DATABASE rasta_audit TO rasta_audit_migrator"

# Idempotent for a database that already exists from an earlier bootstrap:
# CREATE SCHEMA IF NOT EXISTS does not set ownership on an existing schema, so
# the ALTER follows unconditionally and both paths converge on the same state.
psql_exec rasta_audit "CREATE SCHEMA IF NOT EXISTS audit AUTHORIZATION rasta_audit_migrator"
psql_exec rasta_audit "ALTER SCHEMA audit OWNER TO rasta_audit_migrator"

# USAGE only. No CREATE: the runtime role must not be able to add objects it
# would then own, which is how it would get mutation rights back.
psql_exec rasta_audit "REVOKE ALL ON SCHEMA audit FROM rasta_audit"
psql_exec rasta_audit "GRANT USAGE ON SCHEMA audit TO rasta_audit"

# Table-level grants are issued by the migration itself, because the tables do
# not exist yet and a default-privilege rule here would silently widen to every
# future table.
echo "    - schema audit (owner rasta_audit_migrator, rasta_audit has USAGE only)"

# -----------------------------------------------------------------------------
# Extensions go into template1, so every database created afterwards inherits
# them — including the throwaway shadow databases `prisma migrate dev` creates.
#
# The alternative is granting each service role superuser so it can run
# CREATE EXTENSION itself, which would undo the privilege separation this
# script exists to establish (ADR-005). In production the DBA provisions
# extensions and `migrate deploy` uses no shadow database at all.
# -----------------------------------------------------------------------------
echo "==> Installing extensions into template1"
for ext in postgis ltree pg_trgm pgcrypto; do
  psql_exec template1 "CREATE EXTENSION IF NOT EXISTS ${ext}"
  echo "    - ${ext}"
done

echo "==> Ensuring extensions in already-created service databases"
for svc in "${SERVICES[@]}"; do
  for ext in postgis ltree pg_trgm pgcrypto; do
    psql_exec "rasta_${svc}" "CREATE EXTENSION IF NOT EXISTS ${ext}"
  done
done

echo "==> Creating infrastructure databases"
for db in "${INFRA_DATABASES[@]}"; do
  if ! psql -tAc "SELECT 1 FROM pg_database WHERE datname='${db}'" --username "$POSTGRES_USER" postgres | grep -q 1; then
    psql_exec postgres "CREATE DATABASE ${db} OWNER ${POSTGRES_USER} ENCODING 'UTF8'"
    echo "    - ${db}"
  fi
done

echo "==> PostgreSQL bootstrap complete"
