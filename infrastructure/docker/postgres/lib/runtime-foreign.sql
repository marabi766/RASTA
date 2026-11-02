-- -----------------------------------------------------------------------------
-- What OTHER services' runtime roles hold in this database (#540 r1 F2,
-- D-097): every service's database refuses every runtime role but its own.
-- The check (check-db-runtime-privileges-lib.mjs) runs this in EVERY database
-- of the cluster it can connect to — each service's, and every other — so it
-- covers each (database, runtime role) pair; the split runs it in its own
-- database and revokes what it finds there.
--
-- A body for `WITH acl_entries AS (runtime-acl-entries.sql), dangerous AS
-- (runtime-dangerous-roles.sql), foreign_exceptions AS
-- (runtime-foreign-exceptions.sql), foreign_rights AS (this)`, with
-- RUNTIME_ROLE (this database's own runtime role; '' for a database no service
-- owns) and RUNTIME_ROLES (a text[] of every service's runtime role) replaced.
-- A foreign runtime role is any role of RUNTIME_ROLES, or with a
-- `<name>_migrator` beside it, that is not RUNTIME_ROLE. For each, through
-- itself, PUBLIC or any role it is a MEMBER of (runtime-reachable.sql's
-- conservative closure):
--
--   * every ACL entry on every object here (runtime-acl-entries.sql: the
--     database, schemas, relations, columns, sequences, routines, types,
--     languages, large objects, foreign-data wrappers and servers, default
--     ACLs) that is not part of the object's built-in privileges — and on the
--     database every entry, built-in or not (PUBLIC's default CONNECT and
--     TEMPORARY included): no CONNECT, no TEMPORARY, no CREATE; and on a user
--     routine (not a system or extension one) every entry too: PUBLIC's
--     default EXECUTE runs a SECURITY DEFINER routine as its owner. PUBLIC's
--     other built-in defaults — USAGE on a type, a language, schema `public`
--     of a database no service owns — reach no data;
--   * ownership of anything here, of any class (pg_shdepend), this database
--     included;
--   * CONNECT however it is held (has_database_privilege: a superuser too).
--
-- An entry reached through a role it must not be a member of at all
-- (runtime-dangerous-roles.sql: this database's runtime role, a migrator, an
-- owner, …) is not revocable here — revoking it would strip that role — and
-- has no ACL: the split revokes the membership first and fails if the row
-- remains. Ownership and CONNECT rows have no ACL either: the split reassigns
-- and revokes before it asserts.
--
-- runtime-foreign-exceptions.sql declares, per database, a database-level
-- privilege PUBLIC may keep there; for every service database it declares
-- none. Same columns as runtime-forbidden.sql, `scope` 'foreign'.
-- -----------------------------------------------------------------------------
WITH here AS (
  SELECT oid, datname FROM pg_database WHERE datname = current_database()
),
runtimes AS (
  SELECT r.oid, r.rolname::text AS rolname FROM pg_roles r
   WHERE (r.rolname = ANY (RUNTIME_ROLES)
          OR EXISTS (SELECT 1 FROM pg_roles m WHERE m.rolname = r.rolname || '_migrator'))
     AND r.rolname <> RUNTIME_ROLE
),
closure AS (
  SELECT f.oid AS runtime, f.rolname, g.oid AS grantee, g.rolname::text AS through
    FROM runtimes f JOIN pg_roles g ON pg_has_role(f.oid, g.oid, 'MEMBER')
  UNION ALL
  SELECT f.oid, f.rolname, 0::oid, 'PUBLIC' FROM runtimes f
),
excepted AS (
  SELECT x.privilege, x.grantee FROM foreign_exceptions x, here WHERE x.database = here.datname
)
SELECT 'foreign' AS scope,
  format('%s: %s%s on %s %s, through %s', c.rolname,
         CASE WHEN option_only THEN 'grant option: ' ELSE '' END, e.privilege, e.kind, e.shown,
         CASE WHEN c.grantee = c.runtime THEN 'its own grant' ELSE c.through END) AS label,
  e.privilege, option_only AS grant_option,
  CASE WHEN revocable THEN e.acl END AS acl, e.owner, false AS public_only, e.privilege_sql,
  e.revoke_prefix, CASE WHEN option_only THEN 'GRANT OPTION FOR ' ELSE '' END || e.privilege_sql,
  e.revoke_on, true AS held, ARRAY[e.grantee] AS grantees
FROM acl_entries e JOIN closure c ON c.grantee = e.grantee,
  LATERAL (SELECT e.kind = 'database'
                    OR (e.kind = 'routine' AND NOT e.system AND NOT e.extension) AS every_entry) k,
  LATERAL (SELECT NOT k.every_entry AND e.built_in_plain AS option_only,
                  c.grantee = c.runtime OR c.grantee = 0
                    OR c.grantee NOT IN (SELECT d.oid FROM dangerous d) AS revocable) v
WHERE e.kind <> 'unmodeled' AND NOT e.shared
  AND (k.every_entry OR NOT e.built_in)
  AND NOT (e.kind = 'database' AND EXISTS (
    SELECT 1 FROM excepted x WHERE x.privilege = e.privilege
      AND x.grantee = CASE WHEN e.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(e.grantee) END))
UNION ALL
SELECT 'foreign',
  format('%s owns %s%s', c.rolname, pg_describe_object(s.classid, s.objid, s.objsubid),
         CASE WHEN c.grantee = c.runtime THEN '' ELSE ', through ' || c.through END),
  NULL, false, NULL::aclitem[], NULL::oid, false, NULL, NULL, NULL, NULL, true, NULL::oid[]
FROM pg_shdepend s JOIN closure c ON c.grantee = s.refobjid AND c.grantee <> 0, here
WHERE s.refclassid = 'pg_authid'::regclass AND s.deptype = 'o'
  AND (s.dbid = here.oid OR (s.classid = 'pg_database'::regclass AND s.objid = here.oid))
UNION ALL
SELECT 'foreign', format('%s can CONNECT to database %s', f.rolname, here.datname),
  NULL, false, NULL::aclitem[], NULL::oid, false, NULL, NULL, NULL, NULL, true, NULL::oid[]
FROM runtimes f, here
WHERE has_database_privilege(f.oid, here.oid, 'CONNECT')
  AND NOT EXISTS (SELECT 1 FROM excepted x WHERE x.privilege = 'CONNECT' AND x.grantee = 'PUBLIC')
