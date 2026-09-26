#!/bin/bash
# -----------------------------------------------------------------------------
# Re-applies every role's password from the current environment to an existing
# cluster. Non-destructive: ALTER ROLE ... PASSWORD and nothing else — no data,
# no database, no grant is touched.
#
#   pnpm db:rotate-role-passwords
#
# Why it exists: the postgres image runs 00-init-databases.sh only when its
# data directory is empty. A volume created before per-role passwords (L7-33),
# or before a password was changed in .env, keeps the old ones, and the
# services' connection strings stop matching. `pnpm infra:reset` would fix
# that by deleting every row; this fixes it without.
#
# The command runs inside the postgres container (docker compose exec), so it
# sees the environment compose gave the container. After editing .env, run
# `pnpm infra:up` first: compose recreates the container with the new values
# (the data volume is kept, and the init scripts do not run again).
#
# Passwords are resolved and checked exactly as the bootstrap checks them —
# including that no two roles, and no role and the superuser, share one —
# before the first ALTER. Each role is then logged into over TCP with its new
# password, so a success here means the connection strings will work.
# -----------------------------------------------------------------------------
set -euo pipefail

# shellcheck source=role-passwords.bash
source "$(dirname "${BASH_SOURCE[0]}")/role-passwords.bash"
resolve_role_passwords || exit 1

: "${POSTGRES_USER:?POSTGRES_USER must name the superuser}"

superuser_sql() {
  psql -v ON_ERROR_STOP=1 -X -q -tA --username "$POSTGRES_USER" --dbname postgres -c "$1"
}

# The database each role logs into for the check.
role_database() {
  case "$1" in
    rasta_audit_migrator) printf 'rasta_audit' ;;
    rasta_supplier_migrator) printf 'rasta_supplier' ;;
    *) printf '%s' "$1" ;;
  esac
}

rotated=0
missing=()
while IFS= read -r role; do
  if [[ "$(superuser_sql "SELECT 1 FROM pg_roles WHERE rolname = '${role}'")" != "1" ]]; then
    missing+=("$role")
    continue
  fi
  superuser_sql "ALTER ROLE ${role} WITH PASSWORD '${ROLE_PASSWORDS[$role]}'"
  rotated=$((rotated + 1))
done < <(rasta_roles)

failed=()
while IFS= read -r role; do
  [[ " ${missing[*]} " == *" ${role} "* ]] && continue
  if ! PGPASSWORD="${ROLE_PASSWORDS[$role]}" psql -X -q -tA -h 127.0.0.1 \
    --username "$role" --dbname "$(role_database "$role")" -c 'SELECT 1' >/dev/null 2>&1; then
    failed+=("$role")
  fi
done < <(rasta_roles)

echo "==> ${rotated} role password(s) re-applied from the environment"
if ((${#missing[@]} > 0)); then
  echo "    not present in this cluster, left alone: ${missing[*]}" >&2
  echo "    (the bootstrap creates them: 00-init-databases.sh is idempotent)" >&2
fi
if ((${#failed[@]} > 0)); then
  echo "    login with the new password FAILED for: ${failed[*]}" >&2
  exit 1
fi
echo "==> every rotated role logs in with its own password"
