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
#   * `rasta_<svc>` — the runtime role — loses SUPERUSER, CREATEDB,
#     CREATEROLE and BYPASSRLS.
#   * The database and **every object in it** (tables, sequences, types,
#     functions, the Prisma ledger) are reassigned to the migrator, and so is
#     schema `public` whoever owns it — the runtime role, `pg_database_owner`,
#     or the superuser on a cluster upgraded from PostgreSQL 14 or older, which
#     REASSIGN OWNED does not reach (Codex round 4 on #176). Nothing moves, so
#     an existing database keeps every row and its migration history.
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
#   * Sessions default to UTC on the database side (lib/session-timezone.bash):
#     the database, the runtime role and the migrator each carry
#     `TimeZone = 'UTC'`, so a connection that sends no startup option — one
#     behind PgBouncer — still runs in UTC (L7-37).
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

# SQL goes to psql on stdin (`-f -`), never as `-c` text: some of it carries
# a role's password (ALTER ROLE … PASSWORD), and a process's argv is readable
# by every local user while it runs (D-045 follow-up, Codex on #191). `printf`
# is a shell builtin, so the text is never an argument of any process either.
_svc_split_psql() {
  printf '%s\n' "$2" | psql -v ON_ERROR_STOP=1 -X -q --username "$POSTGRES_USER" --dbname "$1" -f -
}

# shellcheck source=session-timezone.bash
source "$(dirname "${BASH_SOURCE[0]}")/session-timezone.bash"

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

# revoke_owner_memberships <database> <runtime>
#
# The runtime role is a member of nothing that could act as an owner here
# (Codex round 3 on #176). On an existing cluster it may have been granted the
# migrator — or any owner, or a superuser-capable role — WITH INHERIT FALSE:
# it then inherits nothing and owns nothing, yet `SET ROLE` makes it that role,
# and every guard is liftable again. Every direct membership of the runtime
# role in a role that can reach (through further membership) a role that owns
# something in this database, is named `*_migrator`, or holds SUPERUSER,
# CREATEDB, CREATEROLE or BYPASSRLS is revoked — whoever granted it.
revoke_owner_memberships() {
  local db="$1" runtime="$2"
  _svc_split_psql "${db}" "DO \$\$
    DECLARE grant_row record;
    BEGIN
      FOR grant_row IN
        WITH dangerous AS (
          SELECT r.oid FROM pg_roles r
           WHERE r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls
              OR r.rolname LIKE '%\\_migrator'
              OR EXISTS (SELECT 1 FROM pg_database d
                          WHERE d.datname = current_database() AND d.datdba = r.oid)
              OR EXISTS (SELECT 1 FROM pg_namespace n
                          WHERE n.nspowner = r.oid
                            AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                            AND n.nspname NOT LIKE 'pg\\_%')
              OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                          WHERE c.relowner = r.oid
                            AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                            AND n.nspname NOT LIKE 'pg\\_%')
        )
        SELECT granted.rolname AS granted, grantor.rolname AS grantor
          FROM pg_auth_members am
          JOIN pg_roles granted ON granted.oid = am.roleid
          JOIN pg_roles grantor ON grantor.oid = am.grantor
         WHERE am.member = '${runtime}'::regrole
           AND EXISTS (SELECT 1 FROM dangerous d WHERE pg_has_role(am.roleid, d.oid, 'MEMBER'))
      LOOP
        EXECUTE format('REVOKE %I FROM %I GRANTED BY %I CASCADE',
                       grant_row.granted, '${runtime}', grant_row.grantor);
      END LOOP;
    END \$\$;"
}

# rotate_and_verify_split_logins <service> <database>
#
# For a standalone run (an upgrade of a cluster this repository did not just
# bootstrap): the exported runtime password might be stale — not the one the
# runtime role really has — so the comparison with the migrator's proved
# nothing about the live credential (Codex round 3 on #176). The runtime role's
# password is therefore set to the supplied value in this same run, so no older
# credential survives, and both supplied credentials are then proven by
# logging in over TCP — PGHOST when it names a host, else 127.0.0.1 — where the
# server checks the password (a Unix socket may be trusted without one). The
# two were already refused if equal (resolve_role_passwords).
rotate_and_verify_split_logins() {
  local svc="$1" db="$2"
  local runtime="rasta_${svc}" migrator="rasta_${svc}_migrator"
  local host="${PGHOST:-127.0.0.1}" port="${PGPORT:-5432}" role failed=0
  [[ "${host}" == /* ]] && host=127.0.0.1
  _svc_split_psql postgres "ALTER ROLE ${runtime} WITH LOGIN PASSWORD '${ROLE_PASSWORDS[$runtime]}'"
  for role in "${runtime}" "${migrator}"; do
    if ! PGPASSWORD="${ROLE_PASSWORDS[$role]}" psql -X -q -tA -h "${host}" -p "${port}" \
      --username "${role}" --dbname "${db}" -c 'SELECT 1' >/dev/null 2>&1; then
      echo "${role} cannot log in to ${db} at ${host}:${port} with the password just set" >&2
      failed=1
    fi
  done
  if ((failed)); then
    echo "Login verification failed: fix pg_hba or the supplied value and run the split again." >&2
    return 1
  fi
  echo "    - ${runtime} and ${migrator} each log in with the password just set; no older one remains for ${runtime}"
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
  _svc_split_psql postgres "ALTER ROLE ${runtime} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS"

  _svc_split_psql postgres "ALTER DATABASE ${db} OWNER TO ${migrator}"

  # Tables, sequences, types, functions, the ledger, and `public` itself if a
  # pre-15 cluster made the runtime role its owner.
  _svc_split_psql "${db}" "REASSIGN OWNED BY ${runtime} TO ${migrator}"

  # `public` whoever owns it — REASSIGN moves only what the runtime role owned.
  # On a cluster upgraded from PostgreSQL 14 or older the superuser owns it,
  # and once the grants below are revoked the migrator would hold no CREATE
  # there: it could neither create the ledger nor run a migration (Codex round
  # 4 on #176). Before the revokes and the ledger.
  _svc_split_psql "${db}" "ALTER SCHEMA public OWNER TO ${migrator}"

  # No back door: no membership in the migrator or any other owner.
  revoke_owner_memberships "${db}" "${runtime}"

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

  ensure_utc_session_defaults "${db}" "${runtime}" "${migrator}"

  echo "    - ${db}: owned by ${migrator}; ${runtime} has CONNECT, USAGE on public, no CREATEDB, no EXECUTE, grants: ${mode}; ledger pre-created, no runtime rights; sessions default to UTC"
}

# split_audit_database_privileges [database] [service]
#
# audit-service keeps its tables in schema `audit`, owned by
# `rasta_audit_migrator` (ADR-053 § 6, 00-init-databases.sh), so its tables were
# never the runtime role's. Its *database* still was: `rasta_audit` owned
# database `rasta_audit`, and with it schema `public` (through
# pg_database_owner), CREATE on the database and DROP DATABASE. This hands the
# database, `public` and `audit` to the migrator — creating the migrator, and
# `audit`, if an older cluster lacks them — and leaves the runtime role CONNECT
# on the database and USAGE on `audit`: no CREATE, no TEMP, nothing in
# `public`, no CREATEDB, no membership in an owner. The table grants stay where
# they are, in audit's migrations. `service` (default `audit`) names the roles
# — `rasta_<service>` and `rasta_<service>_migrator` — so a throwaway pair can
# be split the same way in a test.
split_audit_database_privileges() {
  local db="${1:-rasta_audit}"
  local svc="${2:-audit}"
  local runtime="rasta_${svc}"
  local migrator="rasta_${svc}_migrator"
  local password="${ROLE_PASSWORDS[$migrator]:?the ${migrator} password was not resolved}"

  _svc_split_psql postgres "DO \$\$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${migrator}') THEN
        CREATE ROLE ${migrator} LOGIN CREATEDB;
      END IF;
    END \$\$;"
  _svc_split_psql postgres "ALTER ROLE ${migrator} WITH LOGIN PASSWORD '${password}'"
  _svc_split_psql postgres "ALTER ROLE ${runtime} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS"
  _svc_split_psql postgres "ALTER DATABASE ${db} OWNER TO ${migrator}"
  _svc_split_psql "${db}" "REASSIGN OWNED BY ${runtime} TO ${migrator}"
  # Both schemas whoever owns them (see split_service_privileges).
  _svc_split_psql "${db}" "ALTER SCHEMA public OWNER TO ${migrator}"
  _svc_split_psql "${db}" "CREATE SCHEMA IF NOT EXISTS audit AUTHORIZATION ${migrator}"
  _svc_split_psql "${db}" "ALTER SCHEMA audit OWNER TO ${migrator}"
  revoke_owner_memberships "${db}" "${runtime}"
  _svc_split_psql postgres "REVOKE ALL ON DATABASE ${db} FROM PUBLIC"
  _svc_split_psql postgres "REVOKE ALL ON DATABASE ${db} FROM ${runtime}"
  _svc_split_psql postgres "GRANT CONNECT ON DATABASE ${db} TO ${runtime}"
  _svc_split_psql "${db}" "REVOKE ALL ON SCHEMA public FROM PUBLIC"
  _svc_split_psql "${db}" "REVOKE ALL ON SCHEMA public FROM ${runtime}"
  # USAGE on `audit` and nothing more, as the bootstrap grants it: no CREATE.
  _svc_split_psql "${db}" "REVOKE ALL ON SCHEMA audit FROM PUBLIC"
  _svc_split_psql "${db}" "REVOKE ALL ON SCHEMA audit FROM ${runtime}"
  _svc_split_psql "${db}" "GRANT USAGE ON SCHEMA audit TO ${runtime}"
  # Its migrations run with `?schema=audit`, so that is where Prisma keeps the
  # ledger; the same pre-creation, so it never holds a runtime grant either.
  own_migration_ledger "${db}" audit "${migrator}" "${runtime}"

  ensure_utc_session_defaults "${db}" "${runtime}" "${migrator}"

  echo "    - ${db}: database, public and audit owned by ${migrator}; ${runtime} has CONNECT and USAGE on audit, no CREATEDB; ledger pre-created; sessions default to UTC"
}

# upgrade_service_split <service> <database> <default|migration|audit>
#
# The standalone upgrade of an existing cluster, one service: resolve the
# runtime role's and the migrator's passwords — both supplied, distinct, and
# distinct from every other role password the run knows — split the database
# (`audit` mode: split_audit_database_privileges), then set the runtime role's
# password and prove both logins (rotate_and_verify_split_logins). audit goes
# through the same credential step as every other service (Codex round 4 on
# #176): an audit cluster whose two roles shared a password is otherwise left
# with it. Needs role-passwords.bash sourced.
upgrade_service_split() {
  local svc="$1" db="$2" mode="$3"
  resolve_role_passwords "rasta_${svc}" "rasta_${svc}_migrator" || return 1
  echo "==> ${svc}-service privilege split"
  if [[ "${mode}" == audit ]]; then
    split_audit_database_privileges "${db}" "${svc}"
  else
    split_service_privileges "${svc}" "${db}" "${mode}"
  fi
  rotate_and_verify_split_logins "${svc}" "${db}"
}

# Run directly (not sourced): upgrade_service_split for the named service, with
# the grants mode the bootstrap gives it (audit: its own split). The runtime
# role's and the migrator's passwords — POSTGRES_PASSWORD_<SVC> and
# POSTGRES_PASSWORD_<SVC>_MIGRATOR — are both exported: outside the compose
# container (RASTA_DB_BOOTSTRAP=compose) there is no development fallback, and
# they are refused if equal, or equal to any other role password in the
# environment (lib/role-passwords.bash).
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
  : "${POSTGRES_USER:?POSTGRES_USER must name the superuser}"
  svc="${1:?usage: service-privilege-split.bash <service> [database]}"
  # shellcheck source=role-passwords.bash
  source "$(dirname "${BASH_SOURCE[0]}")/role-passwords.bash"
  if [[ "${svc}" == audit ]]; then
    mode=audit
  elif [[ " ${PRIVILEGE_SPLIT_SERVICES[*]} " == *" ${svc} "* ]]; then
    mode="$(privilege_split_grants_mode "${svc}")"
  else
    echo "${svc} is not in PRIVILEGE_SPLIT_SERVICES (lib/role-passwords.bash)" >&2
    exit 1
  fi
  upgrade_service_split "${svc}" "${2:-rasta_${svc}}" "${mode}" || exit 1
fi
