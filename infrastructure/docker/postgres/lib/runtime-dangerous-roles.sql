-- -----------------------------------------------------------------------------
-- The roles a runtime role must never be a member of, by any path (INHERIT or
-- not, SET or not — a member reaches a role's powers by SET ROLE): one list,
-- read by the split (revoke_owner_memberships), the check
-- (check-db-runtime-privileges-lib.mjs) and runtime-foreign.sql. A body for
-- `dangerous AS (this)`, RUNTIME_ROLES replaced by a text[] of every service's
-- runtime role the caller knows.
--
--   * a role holding SUPERUSER, CREATEDB, CREATEROLE, BYPASSRLS or
--     REPLICATION (#540 r1 F1: REPLICATION streams every database's WAL);
--   * a migrator (`*_migrator`), or any service's runtime role — a role of
--     RUNTIME_ROLES or one with a `<name>_migrator` beside it: its grants are
--     its service's, never another's (#540 r1 F2);
--   * a predefined role (`pg_*`: reading every table, the server's files,
--     signalling backends, …);
--   * the owner of anything, in any database: pg_shdepend records the owner of
--     every object of every class — relation, routine, type, schema, large
--     object, foreign-data wrapper, server, tablespace, publication,
--     subscription, event trigger, language, database, … — for every role but
--     the bootstrap superuser, who is a superuser (#540 r1 F1).
-- -----------------------------------------------------------------------------
SELECT r.oid FROM pg_roles r
 WHERE r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication
    OR r.rolname LIKE '%\_migrator'
    OR r.rolname = ANY (RUNTIME_ROLES)
    OR EXISTS (SELECT 1 FROM pg_roles m WHERE m.rolname = r.rolname || '_migrator')
    OR r.rolname LIKE 'pg\_%'
    OR EXISTS (SELECT 1 FROM pg_shdepend s
                WHERE s.refclassid = 'pg_authid'::regclass AND s.refobjid = r.oid
                  AND s.deptype = 'o')
