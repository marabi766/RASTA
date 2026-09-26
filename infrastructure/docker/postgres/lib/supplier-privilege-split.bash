#!/bin/bash
# -----------------------------------------------------------------------------
# supplier-service privilege split: the runtime role owns nothing.
#
#   pnpm db:supplier-privilege-split          (an existing local cluster)
#   bash .../supplier-privilege-split.bash [database]   (any cluster, as superuser)
#
# Sourced by ../00-init-databases.sh for a fresh cluster, and run on its own for
# an existing one. Idempotent: every statement converges on the same end state,
# so running it twice — or on a cluster that already has it — changes nothing.
#
# ## Why (Codex review of #120, findings 2 and round-2 1–2)
#
# The performance tables are frozen, append-only or insert-only by trigger. A
# trigger is a barrier only against a role that cannot remove it, and the table
# owner can: ALTER TABLE ... DISABLE TRIGGER, ALTER, DROP. The database owner
# can go further and DROP DATABASE. Until now `rasta_supplier` — the role the
# service connects as — was both, and held CREATEDB.
#
# ## What it does
#
#   * `rasta_supplier_migrator` exists and logs in (CREATEDB, for the shadow
#     database `prisma migrate dev` provisions locally — as audit's migrator).
#   * `rasta_supplier` loses CREATEDB and CREATEROLE.
#   * The database and **every object in it** — schema `public` if it names
#     the runtime role, tables, types, functions, the Prisma ledger — are
#     reassigned to the migrator. Nothing moves: the tables stay in `public`,
#     so a database migrated on main keeps every row and its migration ledger.
#   * The runtime role keeps CONNECT on the database and USAGE on `public`, and
#     nothing else at this level. Its table grants come from migration
#     `20260926130000_supplier_runtime_privileges`, which the migrator applies.
#
# ## Upgrading an existing database — the order matters
#
#   1. this script (as the superuser);
#   2. `pnpm --filter @rasta/supplier-service db:migrate` with
#      DATABASE_URL_SUPPLIER_MIGRATOR set — it applies the grants.
#
# Between 1 and 2 the service has no table grants and cannot serve; it refuses
# to start as an owner either way (PrismaService.assertRuntimeRole).
#
# `scripts/supplier-privilege-split.pg.test.mjs` runs exactly this upgrade on a
# database seeded the way main leaves it.
# -----------------------------------------------------------------------------

SUPPLIER_RUNTIME_ROLE=rasta_supplier
SUPPLIER_MIGRATOR_ROLE=rasta_supplier_migrator

_split_psql() {
  psql -v ON_ERROR_STOP=1 -X -q --username "$POSTGRES_USER" --dbname "$1" -c "$2"
}

# split_supplier_privileges [database]
split_supplier_privileges() {
  local db="${1:-rasta_supplier}"
  local runtime="${SUPPLIER_RUNTIME_ROLE}"
  local migrator="${SUPPLIER_MIGRATOR_ROLE}"
  local password="${ROLE_PASSWORDS[$migrator]:?the migrator password was not resolved}"

  _split_psql postgres "DO \$\$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${migrator}') THEN
        CREATE ROLE ${migrator} LOGIN CREATEDB;
      END IF;
    END \$\$;"
  _split_psql postgres "ALTER ROLE ${migrator} WITH LOGIN PASSWORD '${password}'"

  # The runtime role can no longer create — or, owning none, drop — a database.
  _split_psql postgres "ALTER ROLE ${runtime} NOCREATEDB NOCREATEROLE"

  _split_psql postgres "ALTER DATABASE ${db} OWNER TO ${migrator}"

  # Tables, types, functions, the ledger, and `public` itself if a pre-15
  # cluster made the runtime role its owner. Also any other database the
  # runtime role still owns — which is the point.
  _split_psql "${db}" "REASSIGN OWNED BY ${runtime} TO ${migrator}"

  # Database level: CONNECT, nothing more. TEMP and CREATE are withdrawn.
  _split_psql postgres "REVOKE ALL ON DATABASE ${db} FROM PUBLIC"
  _split_psql postgres "REVOKE ALL ON DATABASE ${db} FROM ${runtime}"
  _split_psql postgres "GRANT CONNECT ON DATABASE ${db} TO ${runtime}"

  # Schema level: USAGE only — no CREATE, so it cannot add objects it would own.
  _split_psql "${db}" "REVOKE ALL ON SCHEMA public FROM PUBLIC"
  _split_psql "${db}" "REVOKE ALL ON SCHEMA public FROM ${runtime}"
  _split_psql "${db}" "GRANT USAGE ON SCHEMA public TO ${runtime}"

  # Functions: no EXECUTE for PUBLIC (Codex review of #120, round 3).
  #
  # PostgreSQL grants EXECUTE on every new function to PUBLIC. A later
  # migration that created a SECURITY DEFINER function as the migrator would
  # hand the runtime role whatever that function does, with the migrator's
  # rights. Two statements close it:
  #
  #   * the migrator's default privileges in this database stop granting
  #     EXECUTE to PUBLIC on functions it creates from now on. This is the
  #     *global* form, deliberately without `IN SCHEMA`: PostgreSQL documents
  #     that a per-schema default can only add to the global defaults, never
  #     revoke them, and PUBLIC's EXECUTE is a global default — the `IN SCHEMA
  #     public` form was measured to leave a new function executable by the
  #     runtime role (PostgreSQL 16);
  #   * every function the migrator already owns here — the trigger functions
  #     of an upgraded database — loses PUBLIC's and the runtime role's EXECUTE.
  #     An extension's functions are left alone: they are the extension's, and
  #     changing their ACL would diverge from what the extension installs.
  #
  # Triggers keep working: PostgreSQL checks EXECUTE on a trigger function when
  # the trigger is created, not when it fires, so the runtime role's INSERTs and
  # UPDATEs still run every guard (test/runtime-privileges.int-spec.ts proves
  # both halves). Nothing needs EXECUTE granted back today; a function the
  # service must call directly gets an explicit GRANT in its own migration.
  _split_psql "${db}" "ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC"
  _split_psql "${db}" "DO \$\$
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

  echo "    - ${db}: owned by ${migrator}; ${runtime} has CONNECT, USAGE on public, no CREATEDB, no EXECUTE"
}

# Run directly (not sourced): resolve passwords exactly as the bootstrap does,
# then split the named database.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
  : "${POSTGRES_USER:?POSTGRES_USER must name the superuser}"
  # shellcheck source=role-passwords.bash
  source "$(dirname "${BASH_SOURCE[0]}")/role-passwords.bash"
  resolve_role_passwords || exit 1
  echo "==> supplier-service privilege split"
  split_supplier_privileges "${1:-rasta_supplier}"
fi
