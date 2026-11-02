-- -----------------------------------------------------------------------------
-- Stored settings that reach a runtime role's sessions (#540 r1 F1, the
-- class beyond ACLs): pg_db_role_setting rows a superuser stored, applied at
-- every login with no privilege check — `ALTER ROLE <runtime> SET
-- session_replication_role = replica` switches the integrity triggers off as
-- surely as the review's parameter grant. One list, read by the split
-- (reset_runtime_settings resets each row, then fails unless none is left)
-- and the check (scripts/check-db-runtime-privileges-lib.mjs reports each).
-- A body for `stored_settings AS (this)`, RUNTIME_ROLE replaced; run in the
-- runtime role's own database.
--
-- A row reaches the role's sessions when it is the role's (in every database
-- or this one), this database's for every role, or every role's in every
-- database (ALTER ROLE ALL). A setting applies to the login role only — SET
-- ROLE takes none — so membership adds nothing here. Allowed: TimeZone
-- (lib/session-timezone.bash), statement_timeout
-- (lib/session-statement-timeout.bash), rasta.disposable_database
-- (lib/disposable-marker.bash). Every other parameter is a row.
--
--   label   what the check reports, and the split's error names: the
--           parameter and its scope, NEVER its value — a stored value may be
--           a secret (`app.api_token=…`), and the check's output and the
--           split's error both reach CI logs (#540 r2 R2-3)
--   reset   the statement that removes it; NULL for a name it cannot spell
--           safely — the split then fails on it (fail closed)
-- -----------------------------------------------------------------------------
SELECT format('a stored setting reaches its sessions: %s (%s)', s.name, s.scope) AS label,
  CASE WHEN s.name ~ '^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$' THEN s.reset END AS reset
FROM (
  SELECT split_part(cfg, '=', 1) AS name, -- never the value (R2-3): not selected at all
    CASE WHEN st.setrole = 0 AND st.setdatabase = 0 THEN 'every role, every database'
         WHEN st.setrole = 0 THEN 'every role in database ' || d.datname
         WHEN st.setdatabase = 0 THEN 'role ' || r.rolname || ', every database'
         ELSE 'role ' || r.rolname || ' in database ' || d.datname END AS scope,
    CASE WHEN st.setrole = 0 AND st.setdatabase = 0
           THEN 'ALTER ROLE ALL RESET ' || split_part(cfg, '=', 1)
         WHEN st.setrole = 0
           THEN format('ALTER DATABASE %I RESET ', d.datname) || split_part(cfg, '=', 1)
         WHEN st.setdatabase = 0
           THEN format('ALTER ROLE %I RESET ', r.rolname) || split_part(cfg, '=', 1)
         ELSE format('ALTER ROLE %I IN DATABASE %I RESET ', r.rolname, d.datname)
                || split_part(cfg, '=', 1) END AS reset
  FROM pg_db_role_setting st
    LEFT JOIN pg_roles r ON r.oid = st.setrole
    LEFT JOIN pg_database d ON d.oid = st.setdatabase,
    unnest(st.setconfig) cfg
  WHERE (st.setrole = 0 OR st.setrole = to_regrole(RUNTIME_ROLE))
    AND (st.setdatabase = 0 OR d.datname = current_database())
) s
WHERE lower(s.name) NOT IN ('timezone', 'statement_timeout', 'rasta.disposable_database')
