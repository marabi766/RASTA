#!/bin/bash
# -----------------------------------------------------------------------------
# Optional: a service's runtime sessions get a statement_timeout set on the
# database side (#268 r4, docs/11 § 11.2).
#
# A service applies one itself only when DATABASE_STATEMENT_TIMEOUT_MS is set:
# loadEnv writes it into the connection's startup `options`, after checking it
# is above every operation budget the service declares. Behind PgBouncer in
# transaction pooling that option never reaches the server — `options` has to
# be in `ignore_startup_parameters` (for the UTC option, lib/session-timezone.bash),
# and a listed parameter is dropped. There, a timeout holds only as the runtime
# role's own default:
#
#   ALTER ROLE rasta_<svc> IN DATABASE rasta_<svc> SET statement_timeout = '<ms>ms'
#
# Configured per service, and only when asked for: POSTGRES_STATEMENT_TIMEOUT_MS_<SVC>
# (POSTGRES_STATEMENT_TIMEOUT_MS_FLEET, …), whole milliseconds, 1000..3600000 —
# the bounds DATABASE_STATEMENT_TIMEOUT_MS has. Unset or empty, nothing is done
# and an existing setting is left as it is; this never removes one. Pick a
# value above the service's largest operation budget — the floor its loadEnv
# names when DATABASE_STATEMENT_TIMEOUT_MS is set lower (docs/11 § 11.2 lists
# them) — because nothing on the database side checks it. The runtime role
# only: migrations keep their own limits (D-048), so the migrator is never
# given one. Idempotent: ALTER … SET replaces the value. SQL on stdin (D-047).
# A malformed value or a failed ALTER returns non-zero, and every caller passes
# that on (`|| return 1`), errexit or not.
#
# The value is read in the postgres container. A file-backed one
# (.env.migrator, which compose loads into it) reaches every path, the
# bootstrap included once the container is recreated; one exported in the
# host shell reaches `pnpm db:privilege-split`, `db:supplier-privilege-split`
# and `db:rotate-role-passwords` only, which hand every
# POSTGRES_STATEMENT_TIMEOUT_MS_* of their environment to `docker compose
# exec` (scripts/postgres-exec.bash).
# -----------------------------------------------------------------------------

# runtime_statement_timeout_variable <service> → POSTGRES_STATEMENT_TIMEOUT_MS_<SVC>
runtime_statement_timeout_variable() {
  local stem="${1^^}"
  printf 'POSTGRES_STATEMENT_TIMEOUT_MS_%s' "${stem//-/_}"
}

# ensure_runtime_statement_timeout <service> <database> <runtime role>
ensure_runtime_statement_timeout() {
  local svc="${1:?a service is required}" db="${2:?a database is required}"
  local runtime="${3:?a runtime role is required}"
  local variable value
  variable="$(runtime_statement_timeout_variable "${svc}")"
  value="${!variable:-}"
  [[ -z "${value}" ]] && return 0
  # Digits only, and at most seven of them, before any arithmetic: a longer
  # number wraps in bash's 64-bit arithmetic and could land inside the range
  # (Codex r4 on #268, F5: 18446744073709552616 read as 1000).
  if [[ ! "${value}" =~ ^[0-9]{1,7}$ ]] || ((10#${value} < 1000 || 10#${value} > 3600000)); then
    echo "${variable} must be whole milliseconds from 1000 to 3600000" >&2
    return 1
  fi
  value=$((10#${value}))
  # Checked here rather than left to errexit: the standalone split runs this
  # under `upgrade_service_split … || exit 1`, where errexit is off, and a
  # failed ALTER was reported as applied (Codex r4 on #268, F3).
  if ! printf '%s\n' "ALTER ROLE ${runtime} IN DATABASE ${db} SET statement_timeout = '${value}ms';" |
    psql -v ON_ERROR_STOP=1 -X -q --username "${POSTGRES_USER:?POSTGRES_USER must name the superuser}" \
      --dbname postgres -f -; then
    echo "${variable}: setting statement_timeout for ${runtime} on ${db} FAILED" >&2
    return 1
  fi
  echo "    - ${runtime} sessions on ${db} default to statement_timeout ${value} ms (${variable})"
}
