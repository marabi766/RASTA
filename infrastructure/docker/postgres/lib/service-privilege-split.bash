#!/bin/bash
# -----------------------------------------------------------------------------
# Per-service privilege split (D-045): the runtime role owns nothing.
#
#   pnpm db:privilege-split <service>                     (an existing local cluster)
#   bash .../service-privilege-split.bash <service> [db]  (any cluster, as superuser)
#
# Sourced by ../00-init-databases.sh for every PRIVILEGE_SPLIT_SERVICES entry of
# a fresh cluster, and run on its own to upgrade an existing one. Idempotent:
# every statement converges on the same end state, so a second run — or a run on
# a cluster that already has it — changes nothing.
#
# ## Why
#
# A database trigger, a CHECK constraint or a revoked privilege is a barrier
# only against a role that cannot remove it, and a table's owner can: ALTER
# TABLE ... DISABLE TRIGGER, DROP CONSTRAINT, DROP TABLE, GRANT back to itself.
# The database's owner can go further and DROP DATABASE. Until this split, each
# service connected as `rasta_<svc>`, which was both — so every integrity
# trigger the service has (construction's criteria freeze, tender status and
# key guards; economic's ledger immutability; …) was something any SQL running
# as the service could switch off. supplier-service was split first (Codex
# review of #120); this is the same mechanism, made generic.
#
# ## What it does, for service <svc>
#
#   * `rasta_<svc>_migrator` exists and logs in. It holds CREATEDB only for the
#     shadow database `prisma migrate dev` provisions locally; production runs
#     `migrate deploy`, which needs none.
#   * `rasta_<svc>` — the runtime role — loses CREATEDB, CREATEROLE and
#     BYPASSRLS.
#   * The database and **every object in it** (schema `public` if it names the
#     runtime role, tables, sequences, types, functions, the Prisma ledger) are
#     reassigned to the migrator. Nothing moves, so an existing database keeps
#     every row and its migration history.
#   * The runtime role keeps CONNECT on the database and USAGE on `public`:
#     no CREATE (it cannot add objects it would own), no TEMP.
#   * PUBLIC loses EXECUTE on functions the migrator creates, and on those it
#     already owns (supplier's finding, Codex review of #120 round 3): a later
#     SECURITY DEFINER function must not hand the runtime role the migrator's
#     rights. Triggers still fire — EXECUTE on a trigger function is checked
#     when the trigger is created, not when it fires.
#   * Table rights, by grants mode:
#       default    — DML (SELECT, INSERT, UPDATE, DELETE) on every table and
#                    USAGE, SELECT on every sequence in `public`, now and — by
#                    ALTER DEFAULT PRIVILEGES FOR ROLE the migrator — on every
#                    table and sequence it creates later. Never TRUNCATE,
#                    REFERENCES or TRIGGER.
#       migration  — nothing here: each table's grant is in the service's own
#                    migrations (supplier-service grants less than DML on its
#                    append-only and insert-only tables).
#   * The migration ledger `_prisma_migrations` is created **here**, with
#     Prisma's own DDL, owned by the migrator and granted to no one — before any
#     migration runs (Codex review of #176). Left to Prisma, a fresh database's
#     ledger would be created by the first `migrate deploy` and inherit the
#     default DML grant above, so the runtime role could edit migration history
#     for the whole of that run, and for good if the run failed before
#     scripts/prisma.mjs's post-migration revoke (which stays, belt and braces).
#     Prisma adopts a ledger it finds: `migrate deploy` reads the table and
#     applies what it does not list.
#
# ## Upgrading an existing database — the order matters
#
#   1. this script, as the superuser;
#   2. `pnpm --filter @rasta/<svc>-service db:migrate` with
#      DATABASE_URL_<SVC>_MIGRATOR set.
#
# docs/runbooks/db-role-split.md has the whole procedure, and
# scripts/check-db-runtime-privileges.mjs is the check that it held.
# -----------------------------------------------------------------------------

_svc_split_psql() {
  psql -v ON_ERROR_STOP=1 -X -q --username "$POSTGRES_USER" --dbname "$1" -c "$2"
}

# Prisma's migration ledger, exactly as its schema engine creates it on
# PostgreSQL (prisma 6; compared column for column with a Prisma-made one by
# scripts/check-db-runtime-privileges.pg.test.mjs).
_prisma_ledger_ddl() {
  printf '%s' "CREATE TABLE IF NOT EXISTS \"$1\".\"_prisma_migrations\" (
    \"id\"                  VARCHAR(36) PRIMARY KEY NOT NULL,
    \"checksum\"            VARCHAR(64) NOT NULL,
    \"finished_at\"         TIMESTAMPTZ,
    \"migration_name\"      VARCHAR(255) NOT NULL,
    \"logs\"                TEXT,
    \"rolled_back_at\"      TIMESTAMPTZ,
    \"started_at\"          TIMESTAMPTZ NOT NULL DEFAULT now(),
    \"applied_steps_count\" INTEGER NOT NULL DEFAULT 0
  )"
}

# own_migration_ledger <database> <schema> <migrator> <runtime>
#
# The ledger exists, belongs to the migrator and grants nothing to PUBLIC or the
# runtime role — in one transaction, so it is never visible with a grant. Created
# *as* the migrator, so an existing one (REASSIGNed above) and a new one end the
# same; the REVOKE also undoes the default DML grant a migrator-created table
# receives.
own_migration_ledger() {
  local db="$1" schema="$2" migrator="$3" runtime="$4"
  _svc_split_psql "${db}" "BEGIN;
    SET LOCAL ROLE ${migrator};
    $(_prisma_ledger_ddl "${schema}");
    REVOKE ALL ON TABLE \"${schema}\".\"_prisma_migrations\" FROM PUBLIC, ${runtime};
    COMMIT;"
}

# split_service_privileges <service> [database] [default|migration]
split_service_privileges() {
  local svc="${1:?a service name is required}"
  local db="${2:-rasta_${svc}}"
  local mode="${3:-default}"
  local runtime="rasta_${svc}"
  local migrator="rasta_${svc}_migrator"
  local password="${ROLE_PASSWORDS[$migrator]:?the ${migrator} password was not resolved (is ${svc} in PRIVILEGE_SPLIT_SERVICES?)}"

  if [[ "${mode}" != default && "${mode}" != migration ]]; then
    echo "grants mode must be 'default' or 'migration', not '${mode}'" >&2
    return 1
  fi

  _svc_split_psql postgres "DO \$\$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${migrator}') THEN
        CREATE ROLE ${migrator} LOGIN CREATEDB;
      END IF;
    END \$\$;"
  _svc_split_psql postgres "ALTER ROLE ${migrator} WITH LOGIN PASSWORD '${password}'"

  # The runtime role can no longer create — or, owning none, drop — a database.
  _svc_split_psql postgres "ALTER ROLE ${runtime} NOCREATEDB NOCREATEROLE NOBYPASSRLS"

  _svc_split_psql postgres "ALTER DATABASE ${db} OWNER TO ${migrator}"

  # Tables, sequences, types, functions, the ledger, and `public` itself if a
  # pre-15 cluster made the runtime role its owner.
  _svc_split_psql "${db}" "REASSIGN OWNED BY ${runtime} TO ${migrator}"

  # Database level: CONNECT, nothing more. TEMP and CREATE are withdrawn.
  _svc_split_psql postgres "REVOKE ALL ON DATABASE ${db} FROM PUBLIC"
  _svc_split_psql postgres "REVOKE ALL ON DATABASE ${db} FROM ${runtime}"
  _svc_split_psql postgres "GRANT CONNECT ON DATABASE ${db} TO ${runtime}"

  # Schema level: USAGE only — no CREATE, so it cannot add objects it would own.
  _svc_split_psql "${db}" "REVOKE ALL ON SCHEMA public FROM PUBLIC"
  _svc_split_psql "${db}" "REVOKE ALL ON SCHEMA public FROM ${runtime}"
  _svc_split_psql "${db}" "GRANT USAGE ON SCHEMA public TO ${runtime}"

  # Functions: no EXECUTE for PUBLIC. The global form, deliberately without
  # `IN SCHEMA`: a per-schema default can only add to the global defaults,
  # never revoke them (measured on PostgreSQL 16 for supplier-service).
  _svc_split_psql "${db}" "ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC"
  _svc_split_psql "${db}" "DO \$\$
    DECLARE fn regprocedure;
    BEGIN
      FOR fn IN
        SELECT p.oid::regprocedure
          FROM pg_proc p
         WHERE p.proowner = '${migrator}'::regrole
           AND NOT EXISTS (
             SELECT 1 FROM pg_depend d
              WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
           )
      LOOP
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, ${runtime}', fn);
      END LOOP;
    END \$\$;"

  if [[ "${mode}" == default ]]; then
    # Exactly DML, whatever the tables held before: an upgraded database's
    # runtime role held ALL as their owner, and REASSIGN does not carry a
    # former owner's rights over as grants — but say it rather than rely on it.
    _svc_split_psql "${db}" "REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${runtime}"
    _svc_split_psql "${db}" "REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${runtime}"
    _svc_split_psql "${db}" "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${runtime}"
    _svc_split_psql "${db}" "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${runtime}"
    _svc_split_psql "${db}" "ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtime}"
    _svc_split_psql "${db}" "ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${runtime}"
  fi

  # The migration ledger is the migrator's alone, from before the first
  # migration: a runtime role that could write it could mark a guard-creating
  # migration as already applied. Last, so the grants above cannot reach it.
  own_migration_ledger "${db}" public "${migrator}" "${runtime}"

  echo "    - ${db}: owned by ${migrator}; ${runtime} has CONNECT, USAGE on public, no CREATEDB, no EXECUTE, grants: ${mode}; ledger pre-created, no runtime rights"
}

# split_audit_database_privileges [database]
#
# audit-service keeps its tables in schema `audit`, owned by
# `rasta_audit_migrator` (ADR-053 § 6, 00-init-databases.sh), so its tables were
# never the runtime role's. Its *database* still was: `rasta_audit` owned
# database `rasta_audit`, and with it schema `public` (through
# pg_database_owner), CREATE on the database and DROP DATABASE. This hands the
# database to the migrator and leaves the runtime role CONNECT on it and USAGE
# on `audit` (granted by the bootstrap) — no CREATE, no TEMP, nothing in
# `public`, no CREATEDB. The table grants stay where they are, in audit's
# migrations.
split_audit_database_privileges() {
  local db="${1:-rasta_audit}"
  local runtime=rasta_audit
  local migrator=rasta_audit_migrator

  _svc_split_psql postgres "ALTER ROLE ${runtime} NOCREATEDB NOCREATEROLE NOBYPASSRLS"
  _svc_split_psql postgres "ALTER DATABASE ${db} OWNER TO ${migrator}"
  _svc_split_psql "${db}" "REASSIGN OWNED BY ${runtime} TO ${migrator}"
  _svc_split_psql postgres "REVOKE ALL ON DATABASE ${db} FROM PUBLIC"
  _svc_split_psql postgres "REVOKE ALL ON DATABASE ${db} FROM ${runtime}"
  _svc_split_psql postgres "GRANT CONNECT ON DATABASE ${db} TO ${runtime}"
  _svc_split_psql "${db}" "REVOKE ALL ON SCHEMA public FROM PUBLIC"
  _svc_split_psql "${db}" "REVOKE ALL ON SCHEMA public FROM ${runtime}"
  # Its migrations run with `?schema=audit`, so that is where Prisma keeps the
  # ledger; the same pre-creation, so it never holds a runtime grant either.
  own_migration_ledger "${db}" audit "${migrator}" "${runtime}"

  echo "    - ${db}: database owned by ${migrator}; ${runtime} has CONNECT and USAGE on audit, no CREATEDB; ledger pre-created"
}

# Run directly (not sourced): split the named service's database with the
# grants mode the bootstrap gives it. The runtime role's and the migrator's
# passwords are resolved — POSTGRES_PASSWORD_<SVC> and
# POSTGRES_PASSWORD_<SVC>_MIGRATOR, both exported: outside the compose container
# (RASTA_DB_BOOTSTRAP=compose) there is no development fallback — and refused
# if they are equal, or equal to any other role password in the environment
# (lib/role-passwords.bash). audit's split sets no password at all.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
  : "${POSTGRES_USER:?POSTGRES_USER must name the superuser}"
  svc="${1:?usage: service-privilege-split.bash <service> [database]}"
  # shellcheck source=role-passwords.bash
  source "$(dirname "${BASH_SOURCE[0]}")/role-passwords.bash"
  if [[ "${svc}" == audit ]]; then
    echo "==> audit-service database ownership"
    split_audit_database_privileges "${2:-rasta_audit}"
    exit 0
  fi
  if [[ " ${PRIVILEGE_SPLIT_SERVICES[*]} " != *" ${svc} "* ]]; then
    echo "${svc} is not in PRIVILEGE_SPLIT_SERVICES (lib/role-passwords.bash)" >&2
    exit 1
  fi
  resolve_role_passwords "rasta_${svc}" "rasta_${svc}_migrator" || exit 1
  echo "==> ${svc}-service privilege split"
  split_service_privileges "${svc}" "${2:-rasta_${svc}}" "$(privilege_split_grants_mode "${svc}")"
fi
