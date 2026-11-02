-- -----------------------------------------------------------------------------
-- Every ACL entry of every object that carries one, seen from the database the
-- session is connected to (#540 r1 F1, D-097): the complete privilege universe
-- runtime-forbidden.sql and runtime-foreign.sql judge, so neither lists object
-- classes of its own. A body for `acl_entries AS (this)`; it reads only the
-- catalogue.
--
-- The classes are PostgreSQL 16's ACL columns, all of them: pg_database
-- (this database's row), pg_namespace, pg_class (every relation kind),
-- pg_attribute (column grants), pg_proc (every routine kind), pg_type (types
-- and domains), pg_language, pg_largeobject_metadata, pg_foreign_data_wrapper,
-- pg_foreign_server, pg_tablespace, pg_parameter_acl and pg_default_acl (every
-- object type). A catalogue ACL column that is not one of these — a later
-- PostgreSQL's — is a row of kind `unmodeled` with no ACL: a finding nobody
-- can revoke, so the split and the check fail closed on it.
--
-- One row per object and entry (grantor, grantee, privilege, grantable). An
-- object whose ACL is NULL holds its built-in privileges only, and has no
-- rows — but the database, whose built-in ACL is here, so PUBLIC's implicit
-- CONNECT and TEMPORARY are rows too; and a user routine (neither a system
-- nor an extension one), whose built-in EXECUTE for PUBLIC is a right: a
-- SECURITY DEFINER routine acts as its owner (runtime-foreign.sql counts it):
--
--   kind        database, schema, table, sequence, column, routine, type,
--               language, large object, foreign-data wrapper, server,
--               tablespace, parameter, default, unmodeled
--   oid, attnum the object (attnum: a column's; 0 otherwise)
--   shown       the object, for a finding
--   acl         its aclitem[] (the database's built-in default while NULL)
--   owner       its owner (a default ACL's: the role whose defaults they are)
--   system      it lives in pg_catalog, information_schema, pg_toast or a
--               temporary schema, or is a parameter (no user objects)
--   extension   it is a member of an extension
--   shared      a cluster-wide object (tablespace, parameter): the same in
--               every database
--   defaults    for kind `default`: the object type it applies to, as
--               ALTER DEFAULT PRIVILEGES names it (TABLES, …; NULL: unknown)
--   grantor, grantee, privilege, grantable   the entry (grantee 0 = PUBLIC)
--   built_in    the entry is part of the object's built-in privileges: its
--               pg_init_privs row (initdb's, or the extension script's), or —
--               without one — PostgreSQL's acldefault() for its owner, or
--               information_schema's own grant to PUBLIC (initdb records none
--               for it); a default ACL's built-in is acldefault() for a global
--               row, nothing (NULL) for a per-schema one
--   built_in_plain  the built-in privileges hold this privilege for this
--               grantee, with or without its grant option: an entry beyond
--               them only by its grant option has just that option to lose
--   init_kind   'i' (initdb), 'e' (an extension script) or NULL: whence a
--               pg_init_privs built-in came
--   revoke_prefix, privilege_sql, revoke_on
--               the REVOKE, `<prefix>REVOKE [GRANT OPTION FOR] <privilege_sql>
--               ON <revoke_on> FROM <grantee> CASCADE`, run as the grantor
-- -----------------------------------------------------------------------------
WITH modeled (catalog, acl_column) AS (VALUES
  ('pg_database', 'datacl'), ('pg_namespace', 'nspacl'), ('pg_class', 'relacl'),
  ('pg_attribute', 'attacl'), ('pg_proc', 'proacl'), ('pg_type', 'typacl'),
  ('pg_language', 'lanacl'), ('pg_largeobject_metadata', 'lomacl'),
  ('pg_foreign_data_wrapper', 'fdwacl'), ('pg_foreign_server', 'srvacl'),
  ('pg_tablespace', 'spcacl'), ('pg_parameter_acl', 'paracl'),
  ('pg_default_acl', 'defaclacl'),
  -- Not an ACL of an object: the built-in ACLs themselves.
  ('pg_init_privs', 'initprivs')
),
system_ns AS (
  SELECT oid FROM pg_namespace WHERE nspname = 'information_schema' OR nspname LIKE 'pg\_%'
),
objects (kind, aclkind, classid, oid, attnum, shown, raw_acl, owner, system, info_schema, shared,
         defaults, global_default, revoke_prefix, column_sql, revoke_on) AS (
  SELECT 'database', 'd', 'pg_database'::regclass, d.oid, 0, d.datname::text, d.datacl, d.datdba,
    false, false, false, NULL, false, '', '', format('DATABASE %I', d.datname)
  FROM pg_database d WHERE d.datname = current_database()
  UNION ALL
  SELECT 'schema', 'n', 'pg_namespace'::regclass, n.oid, 0, n.nspname::text, n.nspacl, n.nspowner,
    n.oid IN (SELECT oid FROM system_ns), n.nspname = 'information_schema', false, NULL, false,
    '', '', format('SCHEMA %I', n.nspname)
  FROM pg_namespace n
  UNION ALL
  SELECT CASE WHEN c.relkind = 'S' THEN 'sequence' ELSE 'table' END,
    CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END, 'pg_class'::regclass, c.oid, 0,
    n.nspname || '.' || c.relname, c.relacl, c.relowner,
    n.oid IN (SELECT oid FROM system_ns), n.nspname = 'information_schema', false, NULL, false, '', '',
    CASE WHEN c.relkind = 'S' THEN 'SEQUENCE ' ELSE 'TABLE ' END || format('%I.%I', n.nspname, c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  UNION ALL
  SELECT 'column', 'c', 'pg_class'::regclass, c.oid, a.attnum,
    format('%s.%s (%s)', n.nspname, c.relname, a.attname), a.attacl, c.relowner,
    n.oid IN (SELECT oid FROM system_ns), n.nspname = 'information_schema', false, NULL, false, '',
    format(' (%I)', a.attname), format('TABLE %I.%I', n.nspname, c.relname)
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE a.attacl IS NOT NULL AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'routine', 'f', 'pg_proc'::regclass, p.oid, 0, p.oid::regprocedure::text, p.proacl,
    p.proowner, p.pronamespace IN (SELECT oid FROM system_ns),
    p.pronamespace = 'information_schema'::regnamespace, false, NULL, false, '', '',
    'ROUTINE ' || p.oid::regprocedure
  FROM pg_proc p
  UNION ALL
  -- A user routine whose ACL is NULL, spelled out: PUBLIC's default EXECUTE is
  -- an entry to judge (runtime-foreign.sql). A branch of its own, so the
  -- planner still sees `proacl IS NOT NULL` above.
  SELECT 'routine', 'f', 'pg_proc'::regclass, p.oid, 0, p.oid::regprocedure::text,
    acldefault('f', p.proowner), p.proowner, false, false, false, NULL, false, '', '',
    'ROUTINE ' || p.oid::regprocedure
  FROM pg_proc p
  WHERE p.proacl IS NULL AND p.pronamespace NOT IN (SELECT oid FROM system_ns)
    AND NOT EXISTS (SELECT 1 FROM pg_depend m WHERE m.classid = 'pg_proc'::regclass
                      AND m.objid = p.oid AND m.deptype = 'e')
  UNION ALL
  -- Types and domains; an array type or a relation's row type has no ACL of its own.
  SELECT 'type', 'T', 'pg_type'::regclass, t.oid, 0, n.nspname || '.' || t.typname, t.typacl,
    t.typowner, n.oid IN (SELECT oid FROM system_ns), n.nspname = 'information_schema', false, NULL,
    false, '', '',
    CASE WHEN t.typtype = 'd' THEN 'DOMAIN ' ELSE 'TYPE ' END || format('%I.%I', n.nspname, t.typname)
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typacl IS NOT NULL
  UNION ALL
  SELECT 'language', 'l', 'pg_language'::regclass, l.oid, 0, l.lanname::text, l.lanacl, l.lanowner,
    false, false, false, NULL, false, '', '', format('LANGUAGE %I', l.lanname)
  FROM pg_language l
  UNION ALL
  SELECT 'large object', 'L', 'pg_largeobject'::regclass, lo.oid, 0, lo.oid::text, lo.lomacl,
    lo.lomowner, false, false, false, NULL, false, '', '', format('LARGE OBJECT %s', lo.oid)
  FROM pg_largeobject_metadata lo
  UNION ALL
  SELECT 'foreign-data wrapper', 'F', 'pg_foreign_data_wrapper'::regclass, w.oid, 0,
    w.fdwname::text, w.fdwacl, w.fdwowner, false, false, false, NULL, false, '', '',
    format('FOREIGN DATA WRAPPER %I', w.fdwname)
  FROM pg_foreign_data_wrapper w
  UNION ALL
  SELECT 'server', 'S', 'pg_foreign_server'::regclass, s.oid, 0, s.srvname::text, s.srvacl,
    s.srvowner, false, false, false, NULL, false, '', '', format('FOREIGN SERVER %I', s.srvname)
  FROM pg_foreign_server s
  UNION ALL
  SELECT 'tablespace', 't', 'pg_tablespace'::regclass, ts.oid, 0, ts.spcname::text, ts.spcacl,
    ts.spcowner, false, false, true, NULL, false, '', '', format('TABLESPACE %I', ts.spcname)
  FROM pg_tablespace ts
  UNION ALL
  -- A parameter's ACL row exists once anything was granted on it; its
  -- built-in is the bootstrap superuser's alone.
  SELECT 'parameter', 'p', 'pg_parameter_acl'::regclass, pa.oid, 0, pa.parname::text, pa.paracl,
    10::oid, true, false, true, NULL, false, '', '', format('PARAMETER %s', pa.parname)
  FROM pg_parameter_acl pa
  UNION ALL
  SELECT 'default', CASE da.defaclobjtype WHEN 'S' THEN 's' ELSE da.defaclobjtype::text END,
    'pg_default_acl'::regclass, da.oid, 0,
    format('%s of %s%s', coalesce(t.objects, 'objects of unknown type ' || da.defaclobjtype::text),
      pg_get_userbyid(da.defaclrole), coalesce(' in schema ' || n.nspname, '')),
    da.defaclacl, da.defaclrole, false, false, false, t.objects, da.defaclnamespace = 0,
    'ALTER DEFAULT PRIVILEGES '
      || CASE WHEN n.oid IS NULL THEN '' ELSE format('IN SCHEMA %I ', n.nspname) END, '', t.objects
  FROM pg_default_acl da
    LEFT JOIN (VALUES ('r', 'TABLES'), ('S', 'SEQUENCES'), ('f', 'FUNCTIONS'), ('T', 'TYPES'),
                      ('n', 'SCHEMAS')) t(objtype, objects) ON t.objtype = da.defaclobjtype
    LEFT JOIN pg_namespace n ON n.oid = da.defaclnamespace
),
resolved AS (
  SELECT o.*,
    CASE WHEN o.kind = 'default' THEN o.raw_acl
         ELSE coalesce(o.raw_acl, acldefault(o.aclkind::"char", o.owner)) END AS acl,
    i.initprivs, i.privtype AS init_kind,
    -- pg_depend's own index, not a CTE: every routine may be asked.
    EXISTS (SELECT 1 FROM pg_depend m WHERE m.classid = o.classid AND m.objid = o.oid
              AND m.deptype = 'e') AS extension
  FROM objects o
    LEFT JOIN pg_init_privs i ON i.classoid = o.classid AND i.objoid = o.oid AND i.objsubid = o.attnum
  -- A NULL ACL is the built-in default and nothing else: no entry to judge,
  -- but for the database, whose default lets PUBLIC in (a user routine's
  -- arrives spelled out, above).
  WHERE o.raw_acl IS NOT NULL OR o.kind = 'database'
),
built_in AS (
  SELECT r.*,
    CASE
      WHEN r.kind = 'default' THEN
        CASE WHEN r.global_default AND r.defaults IS NOT NULL
             THEN acldefault(r.aclkind::"char", r.owner) END
      WHEN r.initprivs IS NOT NULL THEN r.initprivs
      -- initdb grants information_schema to PUBLIC without recording it.
      WHEN r.info_schema AND r.raw_acl IS NOT NULL THEN
        acldefault(r.aclkind::"char", r.owner)
          || makeaclitem(0, r.owner, CASE r.kind WHEN 'schema' THEN 'USAGE' WHEN 'routine' THEN 'EXECUTE'
                                                 ELSE 'SELECT' END, false)
      ELSE acldefault(CASE WHEN r.kind = 'column' THEN 'c' ELSE r.aclkind END::"char", r.owner)
    END AS default_acl
  FROM resolved r
)
SELECT b.kind, b.oid, b.attnum, b.shown, b.acl, b.owner, b.system, b.extension, b.shared,
  b.defaults, e.grantor, e.grantee, e.privilege_type AS privilege, e.is_grantable AS grantable,
  EXISTS (SELECT 1 FROM aclexplode(b.default_acl) d
           WHERE d.grantee = e.grantee AND d.privilege_type = e.privilege_type
             AND (d.is_grantable OR NOT e.is_grantable)) AS built_in,
  EXISTS (SELECT 1 FROM aclexplode(b.default_acl) d
           WHERE d.grantee = e.grantee AND d.privilege_type = e.privilege_type) AS built_in_plain,
  b.init_kind, b.revoke_prefix, e.privilege_type || b.column_sql AS privilege_sql, b.revoke_on
FROM built_in b CROSS JOIN LATERAL aclexplode(b.acl) e
UNION ALL
SELECT 'unmodeled', NULL, 0, format('%s.%s', c.relname, a.attname), NULL, NULL, true, false, true,
  NULL, NULL, NULL, NULL, false, false, false, NULL, NULL, NULL, NULL
FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
WHERE c.relnamespace = 'pg_catalog'::regnamespace AND c.relkind = 'r'
  AND a.atttypid = 'aclitem[]'::regtype AND NOT a.attisdropped
  AND (c.relname, a.attname) NOT IN (SELECT catalog, acl_column FROM modeled)
