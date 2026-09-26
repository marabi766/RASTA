#!/bin/bash
# -----------------------------------------------------------------------------
# Marks each service database as disposable, so the demo seeds may write it.
#
#   pnpm db:mark-disposable        # an existing development volume
#
# Every `prisma/seed.ts` refuses to write unless the database it is connected
# to carries `rasta.disposable_database=true` as a database-level setting
# (packages/config seed-guard, `assertDemoSeedDatabase`). The environment
# checks before it (NODE_ENV, RASTA_ALLOW_DEMO_SEED) describe the shell; a
# shell holding a production DATABASE_URL_* passes them. This marker describes
# the database, and only this bootstrap sets it:
#
#   - 00-init-databases.sh sources this file and marks each service database
#     *that run creates*, in development (docker compose) and in CI. A
#     database that already existed is never marked by the bootstrap: run
#     against a cluster it did not create, it must not make that cluster's
#     databases seedable;
#   - run on its own — `pnpm db:mark-disposable`, which executes inside the
#     compose `postgres` container and nowhere else — it marks the service
#     databases of an existing development volume, which the postgres image
#     never re-initialises. That is a deliberate act on a local volume.
#
# Residual: the marker is part of the database. A dump of a marked
# development database restored into another cluster carries it, and seeds
# would then accept that database. Restore a development dump only into a
# disposable cluster (docs/deployment/README.md § Demo seeds).
#
# Production never runs either. And a service role cannot set the marker on
# its own database: on PostgreSQL 15+, `ALTER DATABASE ... SET` of a custom
# parameter needs the superuser (or an explicit GRANT SET), which is refused
# to a database owner — verified against PostgreSQL 16.
#
# Never run this against a cluster whose data somebody needs.
# -----------------------------------------------------------------------------

# The setting the seed guard reads. Keep in step with
# DISPOSABLE_DATABASE_SETTING in packages/config/src/seed-guard.ts.
DISPOSABLE_DATABASE_SETTING=rasta.disposable_database

# mark_disposable_database <database>
# Idempotent: ALTER DATABASE ... SET replaces the stored value.
mark_disposable_database() {
  psql -v ON_ERROR_STOP=1 -X -q --username "$POSTGRES_USER" --dbname postgres \
    -c "ALTER DATABASE \"$1\" SET ${DISPOSABLE_DATABASE_SETTING} = 'true'"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  : "${POSTGRES_USER:?POSTGRES_USER must name the superuser}"

  # shellcheck source=role-passwords.bash
  source "$(dirname "${BASH_SOURCE[0]}")/role-passwords.bash"

  marked=0
  for svc in "${RASTA_SERVICES[@]}"; do
    db="rasta_${svc}"
    if [[ "$(psql -X -tA --username "$POSTGRES_USER" --dbname postgres \
      -c "SELECT 1 FROM pg_database WHERE datname = '${db}'")" != "1" ]]; then
      echo "    - ${db}: not present, skipped"
      continue
    fi
    mark_disposable_database "$db"
    echo "    - ${db}: marked disposable"
    marked=$((marked + 1))
  done
  echo "==> ${marked} database(s) marked ${DISPOSABLE_DATABASE_SETTING}=true"
fi
