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
  if [[ ! "${value}" =~ ^[0-9]+$ ]] || ((10#${value} < 1000 || 10#${value} > 3600000)); then
    echo "${variable} must be whole milliseconds from 1000 to 3600000" >&2
    return 1
  fi
  value=$((10#${value}))
  printf '%s\n' "ALTER ROLE ${runtime} IN DATABASE ${db} SET statement_timeout = '${value}ms';" |
    psql -v ON_ERROR_STOP=1 -X -q --username "${POSTGRES_USER:?POSTGRES_USER must name the superuser}" \
      --dbname postgres -f -
  echo "    - ${runtime} sessions on ${db} default to statement_timeout ${value} ms (${variable})"
}
