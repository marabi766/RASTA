#!/bin/bash
# -----------------------------------------------------------------------------
# Every session on a service database defaults to UTC, set on the database side
# (L7-37, review of #214).
#
# The services also ask for it at connection startup (`options=-c TimeZone=UTC`,
# packages/config database-session.ts), but a client option is not a guarantee:
# behind PgBouncer in transaction pooling (docs/11) an unknown startup parameter
# is refused at connect unless it is in `ignore_startup_parameters`, and once
# listed there it is dropped — the server never sees it, and server connections
# are shared by every client of the pool. What the server itself applies to
# every new backend is the role's and the database's own default, so that is
# where UTC is made to hold:
#
#   ALTER ROLE <role> SET TimeZone = 'UTC'                      every database
#   ALTER ROLE <role> IN DATABASE <db> SET TimeZone = 'UTC'     beats an older
#                                                               per-database override
#   ALTER DATABASE <db> SET TimeZone = 'UTC'                    any other role there
#
# The most specific setting wins (role in database, then role, then database,
# then the server's postgresql.conf), so the three together leave no non-UTC
# default for these roles on this database whatever the server says. A client
# that sends its own TimeZone still overrides them — ours sends UTC.
#
# Idempotent: ALTER … SET replaces the value. SQL goes to psql on stdin, never
# as `-c` text (D-047). scripts/check-db-runtime-privileges.mjs fails CI if a
# service database, its runtime role or its migrator lacks it.
# -----------------------------------------------------------------------------

# ensure_utc_session_defaults <database> <role> [role …]
ensure_utc_session_defaults() {
  local db="${1:?a database is required}"
  shift
  local sql="ALTER DATABASE ${db} SET TimeZone = 'UTC';" role
  for role in "$@"; do
    sql+="
ALTER ROLE ${role} SET TimeZone = 'UTC';
ALTER ROLE ${role} IN DATABASE ${db} SET TimeZone = 'UTC';"
  done
  printf '%s\n' "${sql}" |
    psql -v ON_ERROR_STOP=1 -X -q --username "${POSTGRES_USER:?POSTGRES_USER must name the superuser}" \
      --dbname postgres -f -
}
