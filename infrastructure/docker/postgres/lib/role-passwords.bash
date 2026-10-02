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
# POSTGRES_PASSWORD_AUDIT_MIGRATOR, …). The development default,
# rasta_<role>_dev_password, is published in this repository, so it is used for
# an unset variable **only** in the disposable bootstrap — compose's postgres
# container and CI's throwaway service — which says so explicitly with
# RASTA_DB_BOOTSTRAP=compose (Codex review of #176: a standalone upgrade of a
# real cluster must never give an owner role a known password because a
# variable was not exported). Every other invocation refuses.
#
# resolve_role_passwords refuses, before any role is created or altered:
#
#   * a role whose variable is unset, outside RASTA_DB_BOOTSTRAP=compose;
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

# Services whose runtime role owns nothing (D-045): `rasta_<svc>_migrator` owns
# the database and every object in it and runs the migrations; `rasta_<svc>`,
# the role the service connects as, gets only DML. lib/service-privilege-split.bash
# applies it; scripts/check-db-runtime-privileges.mjs fails CI if it does not hold.
# audit-service is split differently (its own schema, below in
# 00-init-databases.sh) and has its migrator listed separately.
PRIVILEGE_SPLIT_SERVICES=(
  supplier
  construction
)

# How a split service's runtime role gets its table rights
# (lib/service-privilege-split.bash): `migration` when its own migrations grant
# per table — supplier-service grants less than DML on its append-only tables —
# `default` (DML on every table, by default privileges) otherwise.
privilege_split_grants_mode() {
  case "$1" in
    supplier) printf 'migration' ;;
    *) printf 'default' ;;
  esac
}

# Every role this repository creates, in creation order.
rasta_roles() {
  local svc
  for svc in "${RASTA_SERVICES[@]}"; do printf '%s\n' "rasta_${svc}"; done
  printf '%s\n' rasta_audit_migrator
  for svc in "${PRIVILEGE_SPLIT_SERVICES[@]}"; do printf '%s\n' "rasta_${svc}_migrator"; done
}

role_password_var() {
  printf 'POSTGRES_PASSWORD_%s' "$(printf '%s' "${1#rasta_}" | tr '[:lower:]' '[:upper:]')"
}

declare -gA ROLE_PASSWORDS=()

# resolve_role_passwords [role …]
#
# Fills ROLE_PASSWORDS for the named roles — every role when none is named — or
# prints every problem and returns 1. A standalone split names its runtime role
# and its migrator, so an operator supplies those two passwords; both are still
# compared with every other role password the run knows. Reads nothing
# from, and writes nothing to, the database.
resolve_role_passwords() {
  local problems=0 role var value
  declare -A owner_of=()
  ROLE_PASSWORDS=()
  local roles=("$@")
  if ((${#roles[@]} == 0)); then
    mapfile -t roles < <(rasta_roles)
  fi

  if [[ -n "${POSTGRES_SERVICE_PASSWORD:-}" ]]; then
    echo "POSTGRES_SERVICE_PASSWORD is no longer read: each role has its own" >&2
    echo "  POSTGRES_PASSWORD_<ROLE> (see .env.example). Remove it and set those." >&2
    problems=$((problems + 1))
  fi

  # The superuser's password, however this run was handed it: the postgres
  # image passes POSTGRES_PASSWORD, a host-side run (CI) passes PGPASSWORD.
  local superuser_password="${POSTGRES_PASSWORD:-${PGPASSWORD:-}}"

  for role in "${roles[@]}"; do
    var="$(role_password_var "$role")"
    if [[ -n "${!var:-}" ]]; then
      value="${!var}"
    elif [[ "${RASTA_DB_BOOTSTRAP:-}" == compose ]]; then
      value="${role}_dev_password"
    else
      echo "${var} is not set. Outside the disposable compose bootstrap (RASTA_DB_BOOTSTRAP=compose)" >&2
      echo "  every role password is supplied explicitly: the development default is published." >&2
      problems=$((problems + 1))
      continue
    fi
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
  done

  # A subset — a standalone split names the runtime role and its migrator — is
  # still held against every other role password this run knows: each
  # POSTGRES_PASSWORD_<ROLE> set in the environment, and under the compose flag
  # each development default (Codex review of #176). Without it a migrator
  # given the runtime role's password, or another service's, would be accepted,
  # and that credential would log in as the owner.
  if (($# > 0)); then
    local other other_var other_value
    while IFS= read -r other; do
      [[ -n "${ROLE_PASSWORDS[$other]+set}" ]] && continue
      other_var="$(role_password_var "$other")"
      other_value="${!other_var:-}"
      if [[ -z "$other_value" && "${RASTA_DB_BOOTSTRAP:-}" == compose ]]; then
        other_value="${other}_dev_password"
      fi
      [[ -z "$other_value" ]] && continue
      if [[ -n "${owner_of[$other_value]:-}" ]]; then
        echo "${owner_of[$other_value]} equals ${other_var}; every role needs its own password" >&2
        problems=$((problems + 1))
      fi
    done < <(rasta_roles)
  fi

  if ((problems > 0)); then
    echo "Refusing to create or alter any role: ${problems} problem(s) above. Nothing was changed." >&2
    return 1
  fi
}
