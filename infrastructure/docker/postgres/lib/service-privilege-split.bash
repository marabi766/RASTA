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
#     CREATEROLE, BYPASSRLS and REPLICATION; it is a member of no role it must
#     not reach (runtime-dangerous-roles.sql), and no role is a member of it.
#   * The database and **every object in it** (tables, sequences, types,
#     functions, the Prisma ledger) are reassigned to the migrator, and so is
#     schema `public` whoever owns it — the runtime role, `pg_database_owner`,
#     or the superuser on a cluster upgraded from PostgreSQL 14 or older, which
#     REASSIGN OWNED does not reach (Codex round 4 on #176). Nothing moves, so
#     an existing database keeps every row and its migration history.
#   * The runtime role keeps CONNECT on the database and USAGE on `public`:
#     no CREATE (it cannot add objects it would own), no TEMP.
#   * No other service's runtime role holds anything in the database (#540 r1
#     F2): no CONNECT, no right on any object, through itself, PUBLIC or a
#     role it is a member of, and owns nothing there (runtime-foreign.sql).
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
#   * Extension relations keep at most SELECT in every mode (including audit);
#     the superuser removes legacy writes after the application grants above.
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
#   * Optionally, the runtime role's sessions on the database get a
#     `statement_timeout` (lib/session-statement-timeout.bash): only when
#     POSTGRES_STATEMENT_TIMEOUT_MS_<SVC> is set — the way to have one behind
#     PgBouncer, which drops the services' own startup option (#268 r4).
#   * It fails, and never reports success, when any statement fails (#540 r2
#     R2-1), and ends by reading the catalogue back: nothing forbidden is held
#     (assert_no_forbidden_rights) and everything above is in place
#     (assert_split_end_state).
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
# JIT off: the privilege queries read a few thousand catalogue rows, and
# compiling them costs a second each for nothing (as
# scripts/check-db-runtime-privileges-lib.mjs NO_JIT).
#
# Every call's status is passed on explicitly — `… || return 1`, never left to
# errexit (#540 r2 R2-1): the standalone split runs under
# `upgrade_service_split … || exit 1`, and bash switches errexit off for
# everything a `||` tests, so an unchecked failure here was ignored and the
# split went on to report success. scripts/service-privilege-split-faults.test.mjs
# fails every psql call of every entry point in turn and requires the run to
# stop there and fail.
_svc_split_psql() {
  printf '%s\n' "$2" | PGOPTIONS="${PGOPTIONS:-} -c jit=off" \
    psql -v ON_ERROR_STOP=1 -X -q --username "$POSTGRES_USER" --dbname "$1" -f -
}

# _split_names <service> <database>
#
# The split spells the service's roles and database into SQL unquoted, and
# hands the database to psql as `--dbname`, which libpq reads as a connection
# string when it holds `=` or starts `postgres://` (#540 r2 R2-2). So both are
# plain lower-case identifiers — a letter or `_`, then letters, digits and `_`,
# the roles within PostgreSQL's 63 bytes — and anything else is refused, never
# interpreted. assert_split_end_state then checks current_database() too.
_split_names() {
  local svc="$1" db="$2"
  if [[ ! "${svc}" =~ ^[a-z][a-z0-9_]{0,44}$ ]]; then
    printf 'unsupported service name %q: the split takes [a-z][a-z0-9_]{0,44} only\n' "${svc}" >&2
    return 1
  fi
  if [[ ! "${db}" =~ ^[a-z_][a-z0-9_]{0,62}$ ]]; then
    printf 'unsupported database name %q: the split takes [a-z_][a-z0-9_]{0,62} only\n' "${db}" >&2
    return 1
  fi
}

# shellcheck source=session-timezone.bash
source "$(dirname "${BASH_SOURCE[0]}")/session-timezone.bash"
# shellcheck source=session-statement-timeout.bash
source "$(dirname "${BASH_SOURCE[0]}")/session-statement-timeout.bash"

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

# reset_runtime_settings <database> <runtime>
#
# Every stored setting that reaches the runtime role's sessions but TimeZone,
# statement_timeout and the disposable marker (runtime-settings.sql, shared
# with the check) is RESET: a superuser's `ALTER ROLE … SET
# session_replication_role = replica` is applied at each login with no
# privilege check (#540 r1 F1, beyond ACLs). Fails when one is left — a
# name the file will not spell into a RESET included.
reset_runtime_settings() {
  local db="$1" runtime="$2" settings
  settings="$(cat "$(dirname "${BASH_SOURCE[0]}")/runtime-settings.sql")" || return 1
  settings="${settings//RUNTIME_ROLE/\'${runtime}\'}"
  _svc_split_psql "${db}" "DO \$\$
    DECLARE row record; left_over text;
    BEGIN
      FOR row IN WITH stored_settings AS (${settings})
                 SELECT reset FROM stored_settings WHERE reset IS NOT NULL ORDER BY 1 LOOP
        EXECUTE row.reset;
      END LOOP;
      WITH stored_settings AS (${settings})
      SELECT string_agg(label, '; ' ORDER BY label) INTO left_over FROM stored_settings;
      IF left_over IS NOT NULL THEN
        RAISE EXCEPTION 'the split cannot reset %''s settings: %', '${runtime}', left_over;
      END IF;
    END \$\$;"
}

# revoke_owner_memberships <database> <runtime>
#
# The runtime role is a member of nothing that could act as an owner (Codex
# round 3 on #176). On an existing cluster it may have been granted the
# migrator — or any owner, or a superuser-capable role — WITH INHERIT FALSE:
# it then inherits nothing and owns nothing, yet `SET ROLE` makes it that role,
# and every guard is liftable again. Every direct membership, whoever granted
# it, in a role that reaches (through further membership) a role of
# runtime-dangerous-roles.sql — SUPERUSER, CREATEDB, CREATEROLE, BYPASSRLS or
# REPLICATION; a migrator; any service's runtime role; a predefined role; the
# owner of anything of any class in any database (#540 r1 F1) — is revoked:
# the runtime role's own, and every other service's runtime role's too, whose
# way into this database it would be (#540 r1 F2). And no role is a member of
# this runtime role: a member reaches every grant it holds.
revoke_owner_memberships() {
  local db="$1" runtime="$2" dangerous runtimes
  dangerous="$(_runtime_dangerous_sql)" || return 1
  runtimes="$(_runtime_roles_sql)"
  _svc_split_psql "${db}" "DO \$\$
    DECLARE grant_row record;
    BEGIN
      FOR grant_row IN
        WITH dangerous AS (${dangerous}),
        runtimes AS (
          SELECT r.oid FROM pg_roles r
           WHERE r.rolname = '${runtime}' OR r.rolname = ANY (${runtimes})
              OR EXISTS (SELECT 1 FROM pg_roles m WHERE m.rolname = r.rolname || '_migrator')
        )
        SELECT granted.rolname AS granted, member.rolname AS member, grantor.rolname AS grantor
          FROM pg_auth_members am
          JOIN pg_roles granted ON granted.oid = am.roleid
          JOIN pg_roles member ON member.oid = am.member
          JOIN pg_roles grantor ON grantor.oid = am.grantor
         WHERE (am.member IN (SELECT oid FROM runtimes)
                AND EXISTS (SELECT 1 FROM dangerous d WHERE pg_has_role(am.roleid, d.oid, 'MEMBER')))
            OR am.roleid = '${runtime}'::regrole
         ORDER BY 1, 2, 3
      LOOP
        EXECUTE format('REVOKE %I FROM %I GRANTED BY %I CASCADE',
                       grant_row.granted, grant_row.member, grant_row.grantor);
      END LOOP;
    END \$\$;"
}

# reassign_foreign_ownership <database> <migrator> <runtime>
#
# What another service's runtime role owns in this database — directly; an
# owner it reaches through membership lost that membership above — becomes the
# migrator's, object by object (#540 r1 F2). Not REASSIGN OWNED: that would
# hand the migrator that role's shared objects too, its own database among
# them. Every class pg_shdepend records is named by pg_identify_object, which
# spells it as ALTER … OWNER TO does; one ALTER cannot take (an event trigger
# needs a superuser owner) fails the split.
reassign_foreign_ownership() {
  local db="$1" migrator="$2" runtime="$3" runtimes
  runtimes="$(_runtime_roles_sql)"
  _svc_split_psql "${db}" "DO \$\$
    DECLARE owned record;
    BEGIN
      FOR owned IN
        SELECT upper(replace(replace(i.type, 'foreign-data wrapper', 'foreign data wrapper'),
                             'statistics object', 'statistics')) AS kind,
               i.identity, pg_get_userbyid(s.refobjid) AS owner
          FROM pg_shdepend s
          JOIN pg_roles r ON r.oid = s.refobjid,
          LATERAL pg_identify_object(s.classid, s.objid, s.objsubid) i
         WHERE s.refclassid = 'pg_authid'::regclass AND s.deptype = 'o'
           AND s.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
           AND r.rolname <> '${runtime}'
           AND (r.rolname = ANY (${runtimes})
                OR EXISTS (SELECT 1 FROM pg_roles m WHERE m.rolname = r.rolname || '_migrator'))
         ORDER BY 1, 2
      LOOP
        BEGIN
          EXECUTE format('ALTER %s %s OWNER TO %I', owned.kind, owned.identity, '${migrator}');
        EXCEPTION WHEN OTHERS THEN
          RAISE EXCEPTION 'cannot take % % from %, another service''s runtime role: %',
            lower(owned.kind), owned.identity, owned.owner, SQLERRM;
        END;
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
  _split_names "${svc}" "${db}" || return 1
  # Checked itself (#540 r2 R2-1): an older password equal to the supplied one
  # would still let both logins below succeed.
  if ! _svc_split_psql postgres "ALTER ROLE ${runtime} WITH LOGIN PASSWORD '${ROLE_PASSWORDS[$runtime]}'"; then
    echo "setting ${runtime}'s password FAILED; its older one may still be in force" >&2
    return 1
  fi
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

# grant_service_tables <service> <database> <default|migration>
# Analytics grants are migration-managed, even for an older caller passing
# default explicitly. A split re-run must never reopen baseline INSERT.
#
# Default mode grants the `default` policy of runtime-allowlist.sql — its
# `schema.*` relation and sequence rows (GRANT … ON ALL … IN SCHEMA) and its
# default-privilege rows (ALTER DEFAULT PRIVILEGES FOR ROLE the migrator) — and
# refuses a row of any other class, so what is granted is what is allowed. The
# schema's USAGE is the split's own statement. One transaction, so the
# runtime role is never between the REVOKE and the GRANT; the split has
# already added the same grants in its ownership handoff.
grant_service_tables() {
  local svc="$1" db="$2" mode="$3" sql
  sql="$(_service_table_grants_sql "${svc}" "${mode}")" || return 1
  [[ -n "${sql}" ]] || return 0
  # One transaction: the runtime role is never between the REVOKE and the
  # GRANT (#540 r3 R3-1).
  _svc_split_psql "${db}" "BEGIN;
    ${sql}
    COMMIT;"
}

# _service_table_grants_sql <service> <default|migration> [exact|additive]
#
# grant_service_tables' statements, nothing in migration mode. `additive`
# grants the policy and revokes nothing: the split runs it inside the
# ownership handoff's transaction (_split_database), so the runtime role that
# owned its tables keeps DML on them throughout (#540 r3 R3-1) — and it cannot
# fail there on a grant the runtime role passed on under a grant option, which
# the cleanup removes later. `exact` (the default) is the policy and nothing
# else, after the cleanup.
_service_table_grants_sql() {
  local svc="$1" mode="$2" how="${3:-exact}"
  local runtime="rasta_${svc}" migrator="rasta_${svc}_migrator" allowlist revokes=""
  [[ "${svc}" == analytics ]] && mode=migration
  if [[ "${mode}" == default ]]; then
    allowlist="$(_runtime_allowlist_sql)" || return 1
    # Exactly the policy, whatever the tables held before: an upgraded
    # database's runtime role held ALL as their owner, and REASSIGN does not
    # carry a former owner's rights over as grants — but say it rather than
    # rely on it.
    [[ "${how}" == exact ]] && revokes="REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${runtime};
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${runtime};"
    printf '%s' "${revokes}
    DO \$\$
      DECLARE g record;
      BEGIN
        FOR g IN WITH allowlist AS (${allowlist})
          SELECT class, object, array_to_string(privileges, ', ') AS privileges FROM allowlist
           WHERE policy = 'default' ORDER BY class, object
        LOOP
          IF g.class IN ('relation', 'sequence') AND g.object LIKE '%.*' THEN
            EXECUTE format('GRANT %s ON ALL %s IN SCHEMA %I TO %I', g.privileges,
              CASE g.class WHEN 'relation' THEN 'TABLES' ELSE 'SEQUENCES' END,
              split_part(g.object, '.', 1), '${runtime}');
          ELSIF g.class IN ('default tables', 'default sequences') THEN
            EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT %s ON %s TO %I',
              '${migrator}', g.object, g.privileges, upper(substr(g.class, 9)), '${runtime}');
          ELSIF g.class <> 'schema' THEN
            RAISE EXCEPTION 'runtime-allowlist.sql: the split grants no % row in policy default', g.class;
          END IF;
        END LOOP;
      END \$\$;"
  fi
}

# Every service's runtime role this run knows, as a text[]: RASTA_SERVICES
# (lib/role-passwords.bash) when it is loaded — the bootstrap and a standalone
# run load it — else none; runtime-foreign.sql and runtime-dangerous-roles.sql
# add every role with a `<name>_migrator` beside it either way.
_runtime_roles_sql() {
  local svc list=""
  if declare -p RASTA_SERVICES >/dev/null 2>&1; then
    for svc in "${RASTA_SERVICES[@]}"; do list+="${list:+, }'rasta_${svc}'"; done
  fi
  printf 'ARRAY[%s]::text[]' "${list}"
}

# The roles no runtime role may be a member of (runtime-dangerous-roles.sql),
# shared with the catalogue check.
_runtime_dangerous_sql() {
  local sql
  sql="$(cat "$(dirname "${BASH_SOURCE[0]}")/runtime-dangerous-roles.sql")" || return 1
  printf '%s' "${sql//RUNTIME_ROLES/$(_runtime_roles_sql)}"
}

# Shared with the catalogue checker. Do not replace MEMBER with USAGE/SET:
# this deliberately conservative closure also includes non-inherited memberships.
_runtime_reachable_sql() {
  local sql
  sql="$(cat "$(dirname "${BASH_SOURCE[0]}")/runtime-reachable.sql")" || return 1
  printf '%s' "${sql//RUNTIME_ROLE/\'${1}\'}"
}

# The allowlist, shared with the catalogue check (runtime-allowlist.sql).
_runtime_allowlist_sql() {
  cat "$(dirname "${BASH_SOURCE[0]}")/runtime-allowlist.sql"
}

# _runtime_function_grant_rows [file]
#
# Every row of runtime-function-grants.txt, `service|signature|migration`, one
# per line — or, for a malformed file, nothing and a failure. The grammar is the
# checker's (parseRequiredRuntimeFunctions), and a test holds both to the same
# corpus (#520 r1 R2): an empty line or one starting with `#` is skipped; every
# other line is EXACTLY three non-empty fields, each matching its pattern, the
# whole raw line matched at once — no field more or less, no empty one, no
# trailing `|`, no blank or carriage return. A NUL byte anywhere refuses the
# file (bash would drop it unseen). The last line is read with or without its
# newline.
_runtime_function_grant_rows() {
  local file="${1:-$(dirname "${BASH_SOURCE[0]}")/runtime-function-grants.txt}" line number=0
  local line_re='^[a-z][a-z0-9]*[|][a-z_][a-z0-9_]*[.][a-z_][a-z0-9_]*[(][A-Za-z0-9_.",]*[)][|][0-9]{14}_[a-z0-9_]+$'
  if [[ ! -r "${file}" ]] || [[ "$(LC_ALL=C tr -d '\000' < "${file}" | wc -c)" != "$(wc -c < "${file}")" ]]; then
    echo "runtime-function-grants.txt: unreadable, or holds a NUL byte; nothing restored" >&2
    return 1
  fi
  while IFS= read -r line || [[ -n "${line}" ]]; do
    number=$((number + 1))
    [[ -z "${line}" || "${line}" == \#* ]] && continue
    if [[ ! "${line}" =~ ${line_re} ]]; then
      echo "runtime-function-grants.txt: malformed line ${number}; nothing restored" >&2
      return 1
    fi
    printf '%s\n' "${line}"
  done < "${file}"
}

# The listed functions as `runtime_functions (service, signature)` rows. A
# signature holds no quote of either kind but `"` (the line pattern), so it is
# a safe string literal.
_runtime_functions_sql() {
  local rows values="" service signature migration
  rows="$(_runtime_function_grant_rows)" || return 1
  while IFS='|' read -r service signature migration; do
    [[ -n "${service}" ]] || continue
    values+="${values:+, }('${service}', '${signature}')"
  done <<< "${rows}"
  if [[ -n "${values}" ]]; then
    printf 'SELECT * FROM (VALUES %s) v(service, signature)' "${values}"
  else
    printf 'SELECT NULL::text AS service, NULL::text AS signature WHERE false'
  fi
}

# _runtime_forbidden_sql <runtime> <migrator> <policy>
#
# The closure, the allowlist and the forbidden rights, all shared with the
# catalogue check: runtime-forbidden.sql over the runtime role's
# runtime-reachable.sql, runtime-allowlist.sql's <policy>, the listed
# functions and every ACL entry here (runtime-acl-entries.sql) — and, scope
# `foreign`, runtime-foreign.sql: what every other service's runtime role holds
# in this database. Fails, printing nothing usable, when a file is unreadable
# or the function list malformed: call it as
# `sql="$(_runtime_forbidden_sql …)" || return 1`.
_runtime_forbidden_sql() {
  local lib forbidden foreign allowlist functions entries dangerous exceptions runtimes reachable
  lib="$(dirname "${BASH_SOURCE[0]}")"
  reachable="$(_runtime_reachable_sql "${1}")" || return 1
  forbidden="$(cat "${lib}/runtime-forbidden.sql")" || return 1
  foreign="$(cat "${lib}/runtime-foreign.sql")" || return 1
  entries="$(cat "${lib}/runtime-acl-entries.sql")" || return 1
  exceptions="$(cat "${lib}/runtime-foreign-exceptions.sql")" || return 1
  dangerous="$(_runtime_dangerous_sql)" || return 1
  allowlist="$(_runtime_allowlist_sql)" || return 1
  functions="$(_runtime_functions_sql)" || return 1
  runtimes="$(_runtime_roles_sql)"
  forbidden="${forbidden//MIGRATOR_ROLE/\'${2}\'}"
  forbidden="${forbidden//RUNTIME_ROLE/\'${1}\'}"
  forbidden="${forbidden//RUNTIME_POLICY/\'${3}\'}"
  foreign="${foreign//RUNTIME_ROLES/${runtimes}}"
  foreign="${foreign//RUNTIME_ROLE/\'${1}\'}"
  printf 'WITH reachable AS (%s), allowlist AS (%s), runtime_functions AS (%s), acl_entries AS (%s), dangerous AS (%s), foreign_exceptions AS (%s), own_rights AS (%s), foreign_rights AS (%s), forbidden AS (SELECT * FROM own_rights UNION ALL SELECT * FROM foreign_rights)' \
    "${reachable}" "${allowlist}" "${functions}" "${entries}" "${dangerous}" \
    "${exceptions}" "${forbidden}" "${foreign}"
}

# ## Namespace access for whoever acts (#540 r3 R3-1)
#
# The split acts AS other roles: the cleanup revokes each entry as its grantor
# (and lends a grant option as the object's owner), and the function repair
# grants as the migrator. A role names an object only through a schema it has
# USAGE on, and the split itself takes that USAGE away — not only by revoking a
# schema's ACL entry (which _split_containers delays), but by revoking a
# membership it came through (revoke_owner_memberships), by handing a schema
# the role owned to the migrator (REASSIGN OWNED, the runtime role's own) or
# taking it from another service's runtime role (reassign_foreign_ownership).
# So, whatever took it, the role is given USAGE on every schema the statement
# names just before it acts (rasta_split_lent.lend): granted to that exact
# role, recorded in a ledger of loans in the same transaction, and revoked —
# that entry only — at the very end (_return_lent_namespaces). A run that fails
# before the end leaves the ledger; the next run's end returns what it lists.
#
# The ledger is schema `rasta_split_lent` in the database being split: a
# superuser's, granted to no one, with nothing in it but its table and the
# function; it is refused if it exists otherwise, and gone once the split ends.
_namespace_ledger_sql() {
  # One statement (a DO block is one transaction), so a caller that runs the
  # captured SQL statement by statement runs it whole.
  printf '%s' "DO \$ledger\$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
                  WHERE n.nspname = 'rasta_split_lent' AND NOT r.rolsuper) THEN
        RAISE EXCEPTION 'schema rasta_split_lent exists and is not a superuser''s: the split will not use it';
      END IF;
      CREATE SCHEMA IF NOT EXISTS rasta_split_lent;
      REVOKE ALL ON SCHEMA rasta_split_lent FROM PUBLIC;
      IF to_regclass('rasta_split_lent.namespace_usage') IS NULL THEN
        CREATE TABLE rasta_split_lent.namespace_usage (
          namespace oid NOT NULL, grantee oid NOT NULL, PRIMARY KEY (namespace, grantee));
      END IF;
    -- lend(principal, target): USAGE on every schema <target> — a REVOKE's
    -- ON clause, as runtime-acl-entries.sql spells it — names that
    -- <principal> cannot use; returns how many were lent. A target of a kind
    -- it does not know fails, never lends nothing.
    CREATE OR REPLACE FUNCTION rasta_split_lent.lend(principal name, target text)
      RETURNS integer LANGUAGE plpgsql AS \$f\$
    DECLARE
      kind text := substring(target FROM '^(TABLE|SEQUENCE|ROUTINE|TYPE|DOMAIN) ');
      named text := substr(target, length(coalesce(kind, '')) + 2);
      who oid := (SELECT oid FROM pg_roles WHERE rolname = principal);
      needed oid[];
      nsp oid;
      lent integer := 0;
    BEGIN
      IF who IS NULL THEN
        RAISE EXCEPTION 'the split cannot lend schema access to %: no such role', principal;
      ELSIF kind IN ('TABLE', 'SEQUENCE') THEN
        needed := ARRAY(SELECT c.relnamespace FROM pg_class c WHERE c.oid = named::regclass);
      ELSIF kind = 'ROUTINE' THEN
        -- Its argument types' schemas too: the signature names them.
        needed := ARRAY(SELECT p.pronamespace FROM pg_proc p WHERE p.oid = named::regprocedure
                        UNION
                        SELECT t.typnamespace FROM pg_proc p
                          CROSS JOIN LATERAL unnest(p.proargtypes::oid[]) a(type)
                          JOIN pg_type t ON t.oid = a.type
                         WHERE p.oid = named::regprocedure);
      ELSIF kind IN ('TYPE', 'DOMAIN') THEN
        needed := ARRAY(SELECT t.typnamespace FROM pg_type t WHERE t.oid = named::regtype);
      ELSIF target ~ '^(DATABASE|SCHEMA|LANGUAGE|LARGE OBJECT|FOREIGN DATA WRAPPER|FOREIGN SERVER|TABLESPACE|PARAMETER) '
         OR target IN ('TABLES', 'SEQUENCES', 'FUNCTIONS', 'TYPES', 'SCHEMAS') THEN
        -- Named without a schema (a default ACL's IN SCHEMA is not checked).
        RETURN 0;
      ELSE
        RAISE EXCEPTION 'the split cannot tell which schemas % names', target;
      END IF;
      IF cardinality(needed) = 0 THEN
        RAISE EXCEPTION 'the split cannot find %', target;
      END IF;
      FOREACH nsp IN ARRAY needed LOOP
        CONTINUE WHEN has_schema_privilege(who, nsp, 'USAGE');
        EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I',
                       (SELECT nspname FROM pg_namespace WHERE oid = nsp), principal);
        INSERT INTO rasta_split_lent.namespace_usage VALUES (nsp, who) ON CONFLICT DO NOTHING;
        lent := lent + 1;
      END LOOP;
      RETURN lent;
    END \$f\$;
    REVOKE ALL ON FUNCTION rasta_split_lent.lend(name, text) FROM PUBLIC;
      IF EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname = 'rasta_split_lent'
                   AND EXISTS (SELECT 1 FROM aclexplode(n.nspacl) x WHERE x.grantee <> n.nspowner))
         OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
                     WHERE c.relnamespace = 'rasta_split_lent'::regnamespace
                       AND (NOT r.rolsuper
                            OR c.relname NOT IN ('namespace_usage', 'namespace_usage_pkey')
                            OR EXISTS (SELECT 1 FROM aclexplode(c.relacl) x
                                                       WHERE x.grantee <> c.relowner)))
         OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                     WHERE p.pronamespace = 'rasta_split_lent'::regnamespace
                       AND (NOT r.rolsuper OR p.oid <> 'rasta_split_lent.lend(name, text)'::regprocedure
                            OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner)))
      THEN
        RAISE EXCEPTION 'schema rasta_split_lent holds something besides the split''s own ledger, or grants it';
      END IF;
    END \$ledger\$;"
}

# _open_namespace_ledger <database>
_open_namespace_ledger() {
  _svc_split_psql "$1" "$(_namespace_ledger_sql)"
}

# _return_lent_namespaces <database>
#
# Every loan the ledger lists is revoked — the entry the loan made (the schema
# owner's grant of USAGE to that role) and nothing else — except a loan to a
# role that has since become the schema's owner (the migrator, lent USAGE on
# another service's runtime role's schema in the general cleanup, then handed
# it by reassign_foreign_ownership): an owner keeps its USAGE. The runtime
# role's USAGE on its own schema is never a loan: the handoff grants it first.
# Then the ledger is dropped, object by object (a CASCADE could take what is
# not the split's). One statement, one transaction: the loans and their
# record go together.
_return_lent_namespaces() {
  local db="$1"
  _svc_split_psql "${db}" "DO \$return\$
    DECLARE loan record;
    BEGIN
      FOR loan IN SELECT n.nspname, r.rolname, n.nspowner = r.oid AS owns
                    FROM rasta_split_lent.namespace_usage u
                    JOIN pg_namespace n ON n.oid = u.namespace
                    JOIN pg_roles r ON r.oid = u.grantee
                   ORDER BY 1, 2
      LOOP
        CONTINUE WHEN loan.owns;
        EXECUTE format('REVOKE USAGE ON SCHEMA %I FROM %I', loan.nspname, loan.rolname);
      END LOOP;
      DROP FUNCTION rasta_split_lent.lend(name, text);
      DROP TABLE rasta_split_lent.namespace_usage;
      DROP SCHEMA rasta_split_lent;
    END \$return\$;"
}

# Revoke actual ACL entries as THEIR grantor: PG16 object REVOKE GRANTED BY
# cannot name a different current_user, so the privileged session switches to
# each grantor, then resets. CASCADE takes dependent grant chains with it — and
# so may take an entry a later REVOKE would have named, whose grantor then
# holds nothing on the object and is refused (#421 r1 F1). So the cleanup runs
# to a fixed point over the LIVE ACL (#421 r1 F1):
#
#   * one entry at a time, in grantor and command order, the ACL read afresh
#     before every REVOKE, so an entry a CASCADE took is simply gone;
#   * an entry whose grantor no longer holds the grant option — PG16 keeps a
#     column grant made under a TABLE-level grant option when that option is
#     revoked, and its grantor can revoke it no more — is revoked with the
#     option lent by the object's owner and taken back at once, in the same
#     transaction, so the grantor ends with exactly what it had;
#   * before the grantor — or the owner lending — acts, it is lent USAGE on
#     every schema the statement names that it cannot use
#     (rasta_split_lent.lend, #540 r3 R3-1): a membership revoked, an ownership
#     handed over or a schema entry revoked earlier must not leave it unable to
#     name what it still has to revoke;
#   * each REVOKE must remove its own entry, so the loop ends within as many
#     passes as there were entries (plus one per loan, which may add an entry
#     of its own); it fails closed if one does not.
#
# The loop ending is not convergence: assert_no_forbidden_rights, last in the
# split, is. 'extension' is separate so every mode runs it AFTER application
# table grants; 'foreign' is the other services' runtime roles' entries here,
# each row naming its grantee (never this runtime role's).
#
# <scopes> is one scope or several, comma-separated. <phase> `objects` leaves
# out every entry on the database or a schema itself: a grantor that lost
# USAGE on a schema can no longer name the objects in it it still has to
# revoke, and that holds ACROSS scopes — the general cleanup removing a
# grantor's USAGE before the extension or the foreign cleanup needs it
# (#540 r2 R2-4). So each scope runs with `objects`, and the database's and the
# schemas' own entries are revoked only once every scope's objects are done
# (_split_containers: `all`, every scope at once, containers last).
_restrict_reachable_acl() {
  local db="$1" runtime="$2" migrator="$3" scope="$4" policy="$5" phase="${6:-objects}" forbidden
  if [[ "${phase}" != objects && "${phase}" != all ]] || [[ ! "${scope}" =~ ^[a-z]+(,[a-z]+)*$ ]]; then
    echo "_restrict_reachable_acl: scopes '${scope}', phase '${phase}' (objects|all)" >&2
    return 1
  fi
  forbidden="$(_runtime_forbidden_sql "${runtime}" "${migrator}" "${policy}")" || return 1
  _svc_split_psql "${db}" "DO \$\$
    DECLARE
      pending CONSTANT text := \$q\$${forbidden},
        entries AS (
          SELECT DISTINCT a.grantor, a.grantee, f.privilege, f.acl, f.owner,
            f.privilege_sql, f.revoke_prefix, f.revoke_what, f.revoke_on
          FROM forbidden f CROSS JOIN LATERAL aclexplode(f.acl) a
          WHERE f.scope = ANY (string_to_array('${scope}', ',')) AND a.privilege_type = f.privilege
            AND (a.is_grantable OR NOT f.grant_option)
            AND a.grantee = ANY (coalesce(f.grantees, ARRAY(SELECT oid FROM reachable)))
            AND (NOT f.public_only OR a.grantee = 0)
            AND ('${phase}' = 'all' OR f.revoke_on !~ '^(SCHEMA|DATABASE) '))
        SELECT pg_get_userbyid(e.grantor) AS grantor,
          format('%sREVOKE %s ON %s FROM %s CASCADE', e.revoke_prefix, e.revoke_what,
            e.revoke_on, CASE WHEN e.grantee = 0 THEN 'PUBLIC'
                              ELSE quote_ident(pg_get_userbyid(e.grantee)) END) AS command,
          pg_get_userbyid(e.owner) AS owner,
          format('GRANT %s ON %s TO %I WITH GRANT OPTION', e.privilege_sql, e.revoke_on,
            pg_get_userbyid(e.grantor)) AS lend,
          format(CASE WHEN EXISTS (SELECT 1 FROM aclexplode(e.acl) o WHERE o.grantor = e.owner
                   AND o.grantee = e.grantor AND o.privilege_type = e.privilege)
                 THEN 'REVOKE GRANT OPTION FOR %s ON %s FROM %I CASCADE'
                 ELSE 'REVOKE %s ON %s FROM %I CASCADE' END,
            e.privilege_sql, e.revoke_on, pg_get_userbyid(e.grantor)) AS take_back,
          e.revoke_on AS target,
          e.revoke_prefix = '' AND e.grantor <> e.owner AS lendable,
          -- A schema's or the database's entry last: a grantor that lost USAGE
          -- on the schema could no longer name the objects it still has to
          -- revoke (#540 r1 F2 revokes a closure role's allowed USAGE too).
          e.revoke_on ~ '^(SCHEMA|DATABASE) ' AS container
        FROM entries e\$q\$;
      still CONSTANT text := 'SELECT EXISTS (SELECT 1 FROM (' || pending || ') p
        WHERE p.grantor = \$1 AND p.command = \$2)';
      item record;
      passes integer;
      remains boolean;
    BEGIN
      EXECUTE 'SELECT count(*) FROM (' || pending || ') p' INTO passes;
      LOOP
        EXECUTE pending || ' ORDER BY container, grantor, command LIMIT 1' INTO item;
        EXIT WHEN item.command IS NULL;
        IF passes = 0 THEN
          RAISE EXCEPTION 'the % ACL cleanup did not converge: % (as %) is still pending',
            '${scope}', item.command, item.grantor;
        END IF;
        passes := passes - 1;
        -- The grantor can name the object, however it lost its schema (#540
        -- r3 R3-1); a loan may add an entry this cleanup then revokes.
        passes := passes + rasta_split_lent.lend(item.grantor, item.target);
        BEGIN
          EXECUTE format('SET LOCAL ROLE %I', item.grantor);
          EXECUTE item.command;
          EXECUTE 'RESET ROLE';
        EXCEPTION WHEN insufficient_privilege THEN
          NULL; -- an orphaned entry: lent its grant option below
        END;
        EXECUTE still INTO STRICT remains USING item.grantor, item.command;
        IF remains AND item.lendable THEN
          passes := passes + rasta_split_lent.lend(item.owner, item.target);
          EXECUTE format('SET LOCAL ROLE %I', item.owner);
          EXECUTE item.lend;
          EXECUTE format('SET LOCAL ROLE %I', item.grantor);
          EXECUTE item.command;
          EXECUTE format('SET LOCAL ROLE %I', item.owner);
          EXECUTE item.take_back;
          EXECUTE 'RESET ROLE';
          EXECUTE still INTO STRICT remains USING item.grantor, item.command;
        END IF;
        IF remains THEN
          RAISE EXCEPTION 'the % ACL cleanup did not converge: % (as %) left its entry',
            '${scope}', item.command, item.grantor;
        END IF;
      END LOOP;
    END \$\$;"
}

# assert_no_forbidden_rights <database> <runtime> <migrator> <policy>
#
# The split's last word, and what convergence means: no role of the closure
# HOLDS any right of runtime-forbidden.sql (has_*_privilege) — anything the
# policy does not allow — in any scope: what scripts/check-db-runtime-privileges.mjs
# would report from the same files. A right no REVOKE removes (a predefined
# role's), or a broken policy, fails the split here, as it fails the check,
# instead of the split ending as if it had converged.
assert_no_forbidden_rights() {
  local db="$1" runtime="$2" migrator="$3" policy="$4" forbidden
  forbidden="$(_runtime_forbidden_sql "${runtime}" "${migrator}" "${policy}")" || return 1
  _svc_split_psql "${db}" "DO \$\$
    DECLARE left_over text;
    BEGIN
      EXECUTE \$q\$${forbidden}
        SELECT string_agg(DISTINCT label, '; ' ORDER BY label) FROM forbidden WHERE held\$q\$
        INTO left_over;
      IF left_over IS NOT NULL THEN
        RAISE EXCEPTION 'the split did not converge: % still holds %', '${runtime}', left_over;
      END IF;
    END \$\$;"
}

# restrict_foreign_access <database> <runtime> <migrator> <policy>
#
# Every other service's runtime role leaves this database with nothing
# (#540 r1 F2): what it owned here is the migrator's, its memberships in an
# owner or this runtime role are gone (revoke_owner_memberships), and every ACL
# entry it — or PUBLIC, or a role it is a member of — holds here beyond the
# built-in privileges is revoked, CONNECT included.
restrict_foreign_access() {
  local db="$1" runtime="$2" migrator="$3" policy="$4"
  reassign_foreign_ownership "${db}" "${migrator}" "${runtime}" || return 1
  _restrict_reachable_acl "${db}" "${runtime}" "${migrator}" foreign "${policy}"
}

# restrict_extension_relations <database> <runtime> [migrator] [policy]
# (Every policy allows the same on extensions: SELECT.) Objects only: the
# containers wait for _split_containers (#540 r2 R2-4).
restrict_extension_relations() {
  _restrict_reachable_acl "$1" "$2" "${3:-${2}_migrator}" extension "${4:-default}" objects
}

# restrict_service_functions_and_rights <database> <runtime> <migrator> <policy>
# Objects only, as above.
restrict_service_functions_and_rights() {
  local db="$1" runtime="$2" migrator="$3" policy="$4"
  _svc_split_psql "${db}" "ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC" || return 1
  _restrict_reachable_acl "${db}" "${runtime}" "${migrator}" general "${policy}" objects || return 1
}

# _split_containers <database> <runtime> <migrator> <policy> <schema>
#
# The database's and the schemas' own ACLs, once every scope's objects are
# done (#540 r2 R2-4): until then a grantor still has the USAGE it needs to
# name what it has to revoke — PUBLIC's included, which the explicit revokes
# here used to take before any object cleanup. Then PUBLIC and the runtime
# role keep nothing on the database or on `public` (and <schema>) but the
# runtime role's CONNECT and its USAGE on <schema> — each REVOKE and its GRANT
# in one transaction, so the runtime role is never without them — and the
# cleanup runs once more over every scope with containers included, last.
_split_containers() {
  local db="$1" runtime="$2" migrator="$3" policy="$4" schema="$5" each revokes=""
  _svc_split_psql postgres "BEGIN;
    REVOKE ALL ON DATABASE ${db} FROM PUBLIC;
    REVOKE ALL ON DATABASE ${db} FROM ${runtime};
    GRANT CONNECT ON DATABASE ${db} TO ${runtime};
    COMMIT;" || return 1
  # USAGE only — no CREATE, so it cannot add objects it would own; nothing in
  # `public` when its schema is another (audit).
  for each in public "${schema}"; do
    revokes+="REVOKE ALL ON SCHEMA ${each} FROM PUBLIC; REVOKE ALL ON SCHEMA ${each} FROM ${runtime}; "
  done
  _svc_split_psql "${db}" "BEGIN;
    ${revokes}
    GRANT USAGE ON SCHEMA ${schema} TO ${runtime};
    COMMIT;" || return 1
  _restrict_reachable_acl "${db}" "${runtime}" "${migrator}" general,extension,foreign "${policy}" all
}

# assert_split_end_state <service> <database> <runtime> <migrator> <schema> <mode> <policy>
#
# What the split promises beyond "no forbidden right" (assert_no_forbidden_rights),
# read back from the catalogue as the split's last step (#540 r2 R2-1): a
# statement that failed — or, through some path not yet known, did nothing —
# fails the split here rather than leaving it to report success. Checked: the
# session is on <database>; neither role is missing and the migrator logs in;
# the runtime role has no SUPERUSER, CREATEDB, CREATEROLE, BYPASSRLS or
# REPLICATION; the migrator owns the database, `public` and <schema>; the runtime
# role owns nothing here or cluster-wide; no role is a member of it, and no
# service's runtime role is a member of a runtime-dangerous-roles.sql role; no
# stored setting reaches its sessions (runtime-settings.sql); it holds CONNECT
# and USAGE on <schema> — in default mode its policy's table, sequence and
# default grants, and EXECUTE on each listed function that exists; the ledger
# exists, is the migrator's and grants PUBLIC and the runtime role nothing;
# the migrator holds USAGE and CREATE on <schema>; every schema access lent to
# a role the split acted as is returned (no rasta_split_lent left);
# UTC is the database's, both roles' and both roles' in-database default; and
# the statement_timeout asked for is set. Each failure is named — a setting by
# its parameter and scope, never its value (#540 r2 R2-3).
assert_split_end_state() {
  local svc="$1" db="$2" runtime="$3" migrator="$4" schema="$5" mode="$6" policy="$7"
  local dangerous settings allowlist functions runtimes variable timeout=""
  dangerous="$(_runtime_dangerous_sql)" || return 1
  settings="$(cat "$(dirname "${BASH_SOURCE[0]}")/runtime-settings.sql")" || return 1
  settings="${settings//RUNTIME_ROLE/\'${runtime}\'}"
  allowlist="$(_runtime_allowlist_sql)" || return 1
  functions="$(_runtime_functions_sql)" || return 1
  runtimes="$(_runtime_roles_sql)"
  variable="$(runtime_statement_timeout_variable "${svc}")"
  # Already refused unless whole milliseconds in range (ensure_runtime_statement_timeout).
  [[ -n "${!variable:-}" ]] && timeout="$((10#${!variable}))"
  _svc_split_psql "${db}" "DO \$\$
    DECLARE left_over text;
    BEGIN
      WITH rt AS (SELECT * FROM pg_roles WHERE rolname = '${runtime}'),
      mg AS (SELECT * FROM pg_roles WHERE rolname = '${migrator}'),
      here AS (SELECT oid, datdba FROM pg_database WHERE datname = current_database()),
      dangerous AS (${dangerous}),
      allowlist AS (${allowlist}),
      runtime_functions AS (${functions}),
      stored_settings AS (${settings}),
      runtimes AS (
        SELECT r.oid FROM pg_roles r
         WHERE r.rolname = '${runtime}' OR r.rolname = ANY (${runtimes})
            OR EXISTS (SELECT 1 FROM pg_roles m WHERE m.rolname = r.rolname || '_migrator')
      ),
      ledger AS (SELECT c.* FROM pg_class c WHERE c.oid = to_regclass('${schema}._prisma_migrations')),
      problems (problem) AS (
        SELECT format('connected to database %s, not ${db}', quote_ident(current_database()))
         WHERE current_database() <> '${db}'
        UNION ALL SELECT 'role ${runtime} does not exist' WHERE NOT EXISTS (SELECT 1 FROM rt)
        UNION ALL SELECT 'role ${migrator} does not exist or cannot log in'
         WHERE NOT EXISTS (SELECT 1 FROM mg WHERE mg.rolcanlogin)
        UNION ALL SELECT '${runtime} keeps ' || v.attribute
          FROM rt, LATERAL (VALUES (rt.rolsuper, 'SUPERUSER'), (rt.rolcreatedb, 'CREATEDB'),
            (rt.rolcreaterole, 'CREATEROLE'), (rt.rolbypassrls, 'BYPASSRLS'),
            (rt.rolreplication, 'REPLICATION')) v(held, attribute)
         WHERE v.held
        UNION ALL SELECT format('database ${db} is owned by %s, not ${migrator}', pg_get_userbyid(here.datdba))
          FROM here WHERE here.datdba IS DISTINCT FROM (SELECT oid FROM mg)
        UNION ALL SELECT format('schema %s is owned by %s, not ${migrator}', s.name,
                                coalesce(pg_get_userbyid(n.nspowner), 'nobody: it does not exist'))
          FROM (SELECT DISTINCT unnest(ARRAY['public', '${schema}']) AS name) s
          LEFT JOIN pg_namespace n ON n.nspname = s.name
         WHERE n.nspowner IS DISTINCT FROM (SELECT oid FROM mg)
        UNION ALL SELECT format('${runtime} still owns %s', pg_describe_object(d.classid, d.objid, d.objsubid))
          FROM pg_shdepend d
         WHERE d.refclassid = 'pg_authid'::regclass AND d.deptype = 'o'
           AND d.refobjid = (SELECT oid FROM rt) AND d.dbid IN (0, (SELECT oid FROM here))
        UNION ALL SELECT format('%s is a member of ${runtime}', pg_get_userbyid(am.member))
          FROM pg_auth_members am WHERE am.roleid = (SELECT oid FROM rt)
        UNION ALL SELECT format('%s is a member of %s', pg_get_userbyid(am.member), pg_get_userbyid(am.roleid))
          FROM pg_auth_members am
         WHERE am.member IN (SELECT oid FROM runtimes)
           AND EXISTS (SELECT 1 FROM dangerous d WHERE pg_has_role(am.roleid, d.oid, 'MEMBER'))
        UNION ALL SELECT label FROM stored_settings
        UNION ALL SELECT '${runtime} lacks CONNECT on database ${db}'
         WHERE NOT has_database_privilege('${runtime}', current_database(), 'CONNECT')
        UNION ALL SELECT '${runtime} lacks USAGE on schema ${schema}'
         WHERE CASE WHEN to_regnamespace('${schema}') IS NULL THEN true
                    ELSE NOT has_schema_privilege('${runtime}', to_regnamespace('${schema}'), 'USAGE') END
        UNION ALL SELECT format('${migrator} lacks %s on schema ${schema}', priv)
          FROM unnest(ARRAY['USAGE', 'CREATE']) priv
         WHERE to_regnamespace('${schema}') IS NOT NULL AND EXISTS (SELECT 1 FROM mg)
           AND NOT has_schema_privilege('${migrator}', to_regnamespace('${schema}'), priv)
        UNION ALL SELECT 'schema access the split lent is not all returned: rasta_split_lent is left'
         WHERE to_regnamespace('rasta_split_lent') IS NOT NULL
        UNION ALL SELECT format('${runtime} lacks %s on %s %s', priv, a.class, c.oid::regclass)
          FROM allowlist a CROSS JOIN unnest(a.privileges) priv
          JOIN pg_namespace n ON n.nspname = split_part(a.object, '.', 1)
          JOIN pg_class c ON c.relnamespace = n.oid
         WHERE '${mode}' = 'default' AND a.policy = 'default' AND a.object LIKE '%.*'
           AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
                             AND d.objid = c.oid AND d.deptype = 'e')
           -- One CASE, so a privilege is only ever asked of its own kind.
           AND CASE WHEN a.class = 'sequence' AND c.relkind = 'S'
                      THEN NOT has_sequence_privilege('${runtime}', c.oid, priv)
                    WHEN a.class = 'relation' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
                         AND c.relname <> '_prisma_migrations'
                      THEN NOT has_table_privilege('${runtime}', c.oid, priv)
                    ELSE false END
        UNION ALL SELECT format('${migrator} grants ${runtime} no default %s on new %s of %s',
                                priv, substr(a.class, 9), a.object)
          FROM allowlist a CROSS JOIN unnest(a.privileges) priv
         WHERE '${mode}' = 'default' AND a.policy = 'default'
           AND a.class IN ('default tables', 'default sequences')
           AND NOT EXISTS (
             SELECT 1 FROM pg_default_acl da CROSS JOIN LATERAL aclexplode(da.defaclacl) x
              WHERE da.defaclrole = (SELECT oid FROM mg)
                AND da.defaclnamespace = to_regnamespace(a.object)
                AND da.defaclobjtype = CASE a.class WHEN 'default tables' THEN 'r' ELSE 'S' END::\"char\"
                AND x.grantee = (SELECT oid FROM rt) AND x.privilege_type = priv)
        UNION ALL SELECT format('${runtime} lacks EXECUTE on %s', f.signature)
          FROM runtime_functions f
         WHERE f.service = '${svc}' AND to_regprocedure(f.signature) IS NOT NULL
           AND NOT has_function_privilege('${runtime}', to_regprocedure(f.signature), 'EXECUTE')
        UNION ALL SELECT 'the migration ledger ${schema}._prisma_migrations does not exist'
         WHERE NOT EXISTS (SELECT 1 FROM ledger)
        UNION ALL SELECT format('the migration ledger is owned by %s, not ${migrator}', pg_get_userbyid(l.relowner))
          FROM ledger l WHERE l.relowner IS DISTINCT FROM (SELECT oid FROM mg)
        UNION ALL SELECT format('the migration ledger grants %s to %s', x.privilege_type,
                                CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END)
          FROM ledger l CROSS JOIN LATERAL aclexplode(l.relacl) x
         WHERE x.grantee = 0 OR x.grantee = (SELECT oid FROM rt)
        UNION ALL SELECT 'no TimeZone = UTC default for ' || w.what
          FROM (SELECT 'database ${db}' AS what, 0::oid AS role, (SELECT oid FROM here) AS db
                UNION ALL SELECT 'role ' || r.rolname, r.oid, 0::oid
                  FROM pg_roles r WHERE r.rolname IN ('${runtime}', '${migrator}')
                UNION ALL SELECT 'role ' || r.rolname || ' in database ${db}', r.oid, (SELECT oid FROM here)
                  FROM pg_roles r WHERE r.rolname IN ('${runtime}', '${migrator}')) w
         WHERE NOT EXISTS (SELECT 1 FROM pg_db_role_setting st, unnest(st.setconfig) cfg
                            WHERE st.setrole = w.role AND st.setdatabase = w.db
                              AND lower(cfg) = 'timezone=utc')
        UNION ALL SELECT 'no statement_timeout = ${timeout}ms for ${runtime} on ${db}'
         WHERE '${timeout}' <> '' AND NOT EXISTS (
           SELECT 1 FROM pg_db_role_setting st, unnest(st.setconfig) cfg
            WHERE st.setrole = (SELECT oid FROM rt) AND st.setdatabase = (SELECT oid FROM here)
              AND cfg = 'statement_timeout=${timeout}ms')
      )
      SELECT string_agg(problem, '; ' ORDER BY problem) INTO left_over FROM problems;
      IF left_over IS NOT NULL THEN
        RAISE EXCEPTION 'the split did not reach its end state: %', left_over;
      END IF;
    END \$\$;"
}

# Repair grants stripped by pre-407 splitters, even when migrations are already
# recorded as applied. Never turn an allowlisted signature into a SECURITY
# DEFINER/trigger back door. Every line of runtime-function-grants.txt is read —
# the last one too, with or without its newline — and a malformed one refuses
# before anything is restored (_runtime_function_grant_rows, #520 r1 R2).
# A listed function that does not exist is skipped only while the migration
# that creates it has not been applied (bootstrap, a pending, failed or
# rolled-back one: it grants EXECUTE itself when it runs); with that migration
# recorded as applied in the ledger, it is gone, and the split refuses (#421 r1
# F5). The types are schema-qualified, so search_path decides nothing.
restore_runtime_function_grants() {
  local svc="$1" db="$2" runtime="$3" migrator="$4" rows service signature migration
  rows="$(_runtime_function_grant_rows)" || return 1
  while IFS='|' read -r service signature migration; do
    [[ -n "${service}" && "${service}" == "${svc}" ]] || continue
    _svc_split_psql "${db}" "DO \$\$
      DECLARE
        fn oid := to_regprocedure('${signature}');
        recorded boolean := false;
      BEGIN
        IF fn IS NULL THEN
          -- Read only once the ledger exists: a bootstrap runs before it does.
          IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
            EXECUTE 'SELECT EXISTS (SELECT 1 FROM public._prisma_migrations
                       WHERE migration_name = \$1 AND finished_at IS NOT NULL
                         AND rolled_back_at IS NULL)' INTO recorded USING '${migration}';
          END IF;
          IF recorded THEN
            RAISE EXCEPTION 'required runtime function % is missing, yet migration % is recorded as applied',
              '${signature}', '${migration}';
          END IF;
          RETURN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = fn
          AND p.proowner = '${migrator}'::regrole AND NOT p.prosecdef
          AND p.prorettype NOT IN ('trigger'::regtype,'event_trigger'::regtype)
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
            AND d.objid = p.oid AND d.deptype = 'e')) THEN
          RAISE EXCEPTION 'required runtime function has unsafe ownership or definition';
        END IF;
        PERFORM rasta_split_lent.lend('${migrator}', 'ROUTINE ' || fn::regprocedure);
        EXECUTE format('SET LOCAL ROLE %I', '${migrator}');
        EXECUTE format('GRANT EXECUTE ON ROUTINE %s TO %I', fn::regprocedure, '${runtime}');
        EXECUTE 'RESET ROLE';
      END \$\$;" || return 1
  done <<< "${rows}"
}

# _split_database <service> <database> <default|migration> <policy> <schema>
#
# The split itself, for both entry points below: <schema> is where the
# service's tables and its ledger live (`public`; audit's `audit`). In order:
#
#   1. the migrator exists, logs in with its password; the runtime role loses
#      every attribute; the database, everything the runtime role owned and the
#      schemas become the migrator's — the runtime role keeping CONNECT and its
#      USAGE in the same transactions; no back door through membership; no
#      stored setting;
#   2. every scope's OBJECT entries: general, then the function repair and the
#      table grants (exact; step 1 added them), then extension, then foreign — the database's and the
#      schemas' own entries wait (#540 r2 R2-4);
#   3. the containers (_split_containers), every scope at once;
#   4. the ledger, UTC, the optional statement_timeout; then every schema
#      access lent since the ledger of loans was opened (after step 1) is
#      returned (#540 r3 R3-1);
#   5. the two end-state checks: nothing forbidden is held
#      (assert_no_forbidden_rights) and everything promised is in place
#      (assert_split_end_state).
#
# Every step's failure is passed on (#540 r2 R2-1).
_split_database() {
  local svc="$1" db="$2" mode="$3" policy="$4" schema="$5"
  local runtime="rasta_${svc}" migrator="rasta_${svc}_migrator" password tables
  _split_names "${svc}" "${db}" || return 1
  password="${ROLE_PASSWORDS[$migrator]:-}"
  if [[ -z "${password}" ]]; then
    echo "the ${migrator} password was not resolved (is ${svc} in PRIVILEGE_SPLIT_SERVICES?)" >&2
    return 1
  fi

  _svc_split_psql postgres "DO \$\$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${migrator}') THEN
        CREATE ROLE ${migrator} LOGIN CREATEDB;
      END IF;
    END \$\$;" || return 1
  _svc_split_psql postgres "ALTER ROLE ${migrator} WITH LOGIN PASSWORD '${password}'" || return 1

  # The runtime role can no longer create — or, owning none, drop — a database.
  _svc_split_psql postgres "ALTER ROLE ${runtime} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION" || return 1

  # The handoffs, each with the access the runtime role needs in the same
  # transaction (#540 r3 R3-1): an owner's rights are not grants, so the
  # runtime role that owned the database or <schema> — or reached it through a
  # membership revoked below — would otherwise be locked out from here until
  # _split_containers, and for good if the split stopped in between. A grant
  # made BEFORE the handoff would not survive it: ALTER … OWNER rewrites the
  # old owner's entries as the new owner's.
  _svc_split_psql postgres "BEGIN;
    ALTER DATABASE ${db} OWNER TO ${migrator};
    GRANT CONNECT ON DATABASE ${db} TO ${runtime};
    COMMIT;" || return 1

  # Tables, sequences, types, functions, the ledger, and `public` itself if a
  # pre-15 cluster made the runtime role its owner. Then `public` whoever owns
  # it — REASSIGN moves only what the runtime role owned. On a cluster upgraded
  # from PostgreSQL 14 or older the superuser owns it, and once the grants
  # below are revoked the migrator would hold no CREATE there: it could neither
  # create the ledger nor run a migration (Codex round 4 on #176). Before the
  # revokes and the ledger. <schema> too, created if an older cluster lacks it
  # (audit). The migrator, now its owner, holds USAGE and CREATE on <schema>:
  # an owner can revoke its own rights, and a former owner's revoked ones pass
  # to it as they are. In default mode the runtime role's table and sequence
  # grants are in the same transaction too (added; grant_service_tables makes
  # them exact after the cleanup): the tables it owned are the migrator's from
  # the same instant, and it never stands without DML on them.
  tables="$(_service_table_grants_sql "${svc}" "${mode}" additive)" || return 1
  local handoff="REASSIGN OWNED BY ${runtime} TO ${migrator};
    ALTER SCHEMA public OWNER TO ${migrator};"
  if [[ "${schema}" != public ]]; then
    handoff+="
    CREATE SCHEMA IF NOT EXISTS ${schema} AUTHORIZATION ${migrator};
    ALTER SCHEMA ${schema} OWNER TO ${migrator};"
  fi
  _svc_split_psql "${db}" "BEGIN;
    ${handoff}
    GRANT USAGE ON SCHEMA ${schema} TO ${runtime};
    DO \$\$ BEGIN
      IF NOT has_schema_privilege('${migrator}', '${schema}', 'USAGE')
         OR NOT has_schema_privilege('${migrator}', '${schema}', 'CREATE') THEN
        GRANT USAGE, CREATE ON SCHEMA ${schema} TO ${migrator};
      END IF;
    END \$\$;
    ${tables}
    COMMIT;" || return 1

  # No back door: no membership in the migrator or any other owner.
  revoke_owner_memberships "${db}" "${runtime}" || return 1
  reset_runtime_settings "${db}" "${runtime}" || return 1

  # Every role the split acts as from here gets the schema access it needs.
  _open_namespace_ledger "${db}" || return 1

  # Objects, scope by scope; the containers after all of them.
  restrict_service_functions_and_rights "${db}" "${runtime}" "${migrator}" "${policy}" || return 1
  restore_runtime_function_grants "${svc}" "${db}" "${runtime}" "${migrator}" || return 1
  grant_service_tables "${svc}" "${db}" "${mode}" || return 1
  restrict_extension_relations "${db}" "${runtime}" "${migrator}" "${policy}" || return 1
  restrict_foreign_access "${db}" "${runtime}" "${migrator}" "${policy}" || return 1
  _split_containers "${db}" "${runtime}" "${migrator}" "${policy}" "${schema}" || return 1

  # The migration ledger is the migrator's alone, from before the first
  # migration: a runtime role that could write it could mark a guard-creating
  # migration as already applied. After the grants, so they cannot reach it.
  own_migration_ledger "${db}" "${schema}" "${migrator}" "${runtime}" || return 1

  ensure_utc_session_defaults "${db}" "${runtime}" "${migrator}" || return 1
  ensure_runtime_statement_timeout "${svc}" "${db}" "${runtime}" || return 1

  # The very end: every schema access lent above is taken back.
  _return_lent_namespaces "${db}" || return 1

  assert_no_forbidden_rights "${db}" "${runtime}" "${migrator}" "${policy}" || return 1
  assert_split_end_state "${svc}" "${db}" "${runtime}" "${migrator}" "${schema}" "${mode}" "${policy}" || return 1
}

# split_service_privileges <service> [database] [default|migration] [policy]
#
# The runtime role is held to runtime-allowlist.sql's policy: `default` in
# default mode, the service's own in migration mode. A test splitting a
# throwaway pair the way a migration-mode service is split names that
# service's policy.
split_service_privileges() {
  local svc="${1:?a service name is required}"
  local db="${2:-rasta_${svc}}"
  local mode="${3:-default}"
  [[ "${svc}" == analytics ]] && mode=migration
  local policy="${4:-$([[ "${mode}" == default ]] && echo default || echo "${svc}")}"

  if [[ "${mode}" != default && "${mode}" != migration ]]; then
    echo "grants mode must be 'default' or 'migration', not '${mode}'" >&2
    return 1
  fi
  _split_database "${svc}" "${db}" "${mode}" "${policy}" public || return 1

  echo "    - ${db}: owned by rasta_${svc}_migrator; rasta_${svc} has CONNECT, USAGE on public, no CREATEDB, no direct definer/trigger EXECUTE, grants: ${mode}; ledger pre-created, no runtime rights; sessions default to UTC"
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
# they are, in audit's migrations (migration mode), and its migrations run with
# `?schema=audit`, so that is where Prisma keeps the ledger. Held to the
# `audit` policy of runtime-allowlist.sql, whatever `service` is: `service`
# (default `audit`) names the roles — `rasta_<service>` and
# `rasta_<service>_migrator` — so a throwaway pair can be split the same way in
# a test.
split_audit_database_privileges() {
  local db="${1:-rasta_audit}"
  local svc="${2:-audit}"
  _split_database "${svc}" "${db}" migration audit audit || return 1

  echo "    - ${db}: database, public and audit owned by rasta_${svc}_migrator; rasta_${svc} has CONNECT and USAGE on audit, no CREATEDB; ledger pre-created; sessions default to UTC"
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
    split_audit_database_privileges "${db}" "${svc}" || return 1
  else
    split_service_privileges "${svc}" "${db}" "${mode}" || return 1
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
