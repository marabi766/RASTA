#!/bin/bash
# -----------------------------------------------------------------------------
# Role passwords: one per database role, resolved and checked before anything
# touches the cluster (L7-33).
#
# Sourced by ../00-init-databases.sh (first start of a fresh volume) and by
# rotate-role-passwords.bash (`pnpm db:rotate-role-passwords`, an existing
# volume). It lives in a subdirectory so the postgres image's entrypoint, which
# runs every *.sh directly under /docker-entrypoint-initdb.d, never runs it on
# its own.
#
# Every role reads POSTGRES_PASSWORD_<ROLE> (POSTGRES_PASSWORD_IDENTITY,
# POSTGRES_PASSWORD_AUDIT_MIGRATOR, …), with a distinct development default,
# rasta_<role>_dev_password. Real environments set every variable.
#
# resolve_role_passwords refuses, before any role is created or altered:
#
#   * the old shared POSTGRES_SERVICE_PASSWORD, still set — roles would get
#     passwords that silently differ from the connection strings beside it;
#   * a password that is not URL-safe — it is used unescaped in SQL here and in
#     every DATABASE_URL_*;
#   * two roles with the same password, or a role with the superuser's. Equal
#     passwords make separate roles a formality: whoever holds the identity
#     credential could log in as rasta_audit_migrator, the owner of the
#     append-only audit schema, simply by changing the user name.
#
# Errors name variables, never values.
# -----------------------------------------------------------------------------

RASTA_SERVICES=(
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

# Every role this repository creates, in creation order.
rasta_roles() {
  local svc
  for svc in "${RASTA_SERVICES[@]}"; do printf '%s\n' "rasta_${svc}"; done
  printf '%s\n' rasta_audit_migrator
}

role_password_var() {
  printf 'POSTGRES_PASSWORD_%s' "$(printf '%s' "${1#rasta_}" | tr '[:lower:]' '[:upper:]')"
}

declare -gA ROLE_PASSWORDS=()

# Fills ROLE_PASSWORDS for every role, or prints every problem and returns 1.
# Reads nothing from, and writes nothing to, the database.
resolve_role_passwords() {
  local problems=0 role var value
  declare -A owner_of=()
  ROLE_PASSWORDS=()

  if [[ -n "${POSTGRES_SERVICE_PASSWORD:-}" ]]; then
    echo "POSTGRES_SERVICE_PASSWORD is no longer read: each role has its own" >&2
    echo "  POSTGRES_PASSWORD_<ROLE> (see .env.example). Remove it and set those." >&2
    problems=$((problems + 1))
  fi

  # The superuser's password, however this run was handed it: the postgres
  # image passes POSTGRES_PASSWORD, a host-side run (CI) passes PGPASSWORD.
  local superuser_password="${POSTGRES_PASSWORD:-${PGPASSWORD:-}}"

  while IFS= read -r role; do
    var="$(role_password_var "$role")"
    value="${!var:-${role}_dev_password}"
    if [[ ! "$value" =~ ^[A-Za-z0-9_.~-]{16,}$ ]]; then
      echo "${var}: at least 16 characters from [A-Za-z0-9_.~-] (it is used unescaped in URLs)" >&2
      problems=$((problems + 1))
      continue
    fi
    if [[ -n "$superuser_password" && "$value" == "$superuser_password" ]]; then
      echo "${var} equals the superuser's password; every role needs its own" >&2
      problems=$((problems + 1))
    fi
    if [[ -n "${owner_of[$value]:-}" ]]; then
      echo "${var} equals ${owner_of[$value]}; every role needs its own password" >&2
      problems=$((problems + 1))
    else
      owner_of[$value]="$var"
    fi
    ROLE_PASSWORDS[$role]="$value"
  done < <(rasta_roles)

  if ((problems > 0)); then
    echo "Refusing to create or alter any role: ${problems} problem(s) above. Nothing was changed." >&2
    return 1
  fi
}
