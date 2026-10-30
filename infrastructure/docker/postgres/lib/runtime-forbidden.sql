-- -----------------------------------------------------------------------------
-- The rights a service's runtime role may never hold (D-045): ONE list, read by
-- the split (lib/service-privilege-split.bash revokes every ACL entry it finds,
-- then fails unless nothing is held) and by the catalogue check
-- (scripts/check-db-runtime-privileges-lib.mjs reports every row held).
--
-- The policy is the `rules` table; the rest finds the objects each rule names.
-- A body for `WITH reachable AS (runtime-reachable.sql), forbidden AS (this)`,
-- with RUNTIME_ROLE and MIGRATOR_ROLE replaced by string literals (or psql
-- variables). One row per object, privilege and ACL (a column's own ACL is a
-- row of its own):
--
--   scope        general, or extension (the split runs it after its table grants)
--   label        what the check reports
--   privilege    as aclexplode() spells it
--   acl          the aclitem[] that grants it (the built-in default while NULL)
--   owner        the object's owner, who can lend a grantor its grant option
--   public_only  only PUBLIC's entry is forbidden (a migrator function's EXECUTE)
--   revoke_prefix, revoke_what, revoke_on
--                the REVOKE: `<prefix>REVOKE <what> ON <on> FROM <grantee>
--                CASCADE`, run as the entry's grantor
--   held         a role of the closure effectively holds it (has_*_privilege;
--                the entry itself where no such function exists)
--
-- Not here: role attributes, ownership and membership, predefined roles and
-- the required runtime EXECUTE list — the check's own rules (no REVOKE of an
-- ACL entry repairs them). Migration-mode table DML is the services' own
-- migrations' business, and not yet checked (#421 follow-up F3b).
-- -----------------------------------------------------------------------------
WITH rules (scope, class, privileges, label) AS (VALUES
  ('general', 'database', ARRAY['CREATE', 'TEMPORARY'], '%s on database %s'),
  ('general', 'schema', ARRAY['CREATE'], '%s on schema %s'),
  -- Tables, views, materialized views and foreign tables: DML is the grants
  -- mode's business; these three never are.
  ('general', 'relation', ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER'], '%s on %s'),
  -- USAGE and SELECT are nextval and currval; UPDATE is setval.
  ('general', 'sequence', ARRAY['UPDATE'], '%s on sequence %s'),
  ('general', 'ledger',
    ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'],
    'a right on %2$s'),
  ('general', 'definer function', ARRAY['EXECUTE'],
    'reachable EXECUTE on definer/trigger function %2$s'),
  ('general', 'migrator function', ARRAY['EXECUTE'], 'PUBLIC EXECUTE on migrator function %2$s'),
  -- Default privileges: what every object created later would grant.
  ('general', 'default tables', ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER'],
    'default %s on new tables of %s'),
  ('general', 'default sequences', ARRAY['UPDATE'], 'default %s on new sequences of %s'),
  ('general', 'default functions', ARRAY['EXECUTE'], 'default %s on new functions of %s'),
  ('general', 'default schemas', ARRAY['CREATE'], 'default %s on new schemas of %s'),
  -- An extension's relations are read-only to a service, in every mode.
  ('extension', 'extension relation',
    ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'],
    '%s on extension relation %s'),
  ('extension', 'extension sequence', ARRAY['USAGE', 'UPDATE'], '%s on extension sequence %s')
),
user_ns AS (
  SELECT oid, nspname, nspowner, coalesce(nspacl, acldefault('n', nspowner)) AS nspacl
    FROM pg_namespace
   WHERE nspname <> 'information_schema' AND nspname NOT LIKE 'pg\_%'
),
rel AS (
  SELECT c.oid, c.relkind, c.relowner,
    coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END::"char", c.relowner))
      AS relacl,
    format('%I.%I', n.nspname, c.relname) AS target,
    n.nspname || '.' || c.relname AS shown,
    CASE
      WHEN EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
                     AND d.objid = c.oid AND d.deptype = 'e')
        THEN CASE WHEN c.relkind = 'S' THEN 'extension sequence' ELSE 'extension relation' END
      WHEN c.relkind = 'S' THEN 'sequence'
      WHEN c.relname = '_prisma_migrations' THEN 'ledger'
      ELSE 'relation'
    END AS class
  FROM pg_class c JOIN user_ns n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
),
objects (class, kind, oid, attnum, shown, acl, owner, revoke_prefix, column_sql, revoke_on) AS (
  SELECT 'database', 'database', d.oid, 0, d.datname::text,
    coalesce(d.datacl, acldefault('d', d.datdba)), d.datdba, '', '',
    format('DATABASE %I', d.datname)
  FROM pg_database d WHERE d.datname = current_database()
  UNION ALL
  SELECT 'schema', 'schema', n.oid, 0, n.nspname::text, n.nspacl, n.nspowner, '', '',
    format('SCHEMA %I', n.nspname)
  FROM user_ns n
  UNION ALL
  SELECT r.class, CASE WHEN r.relkind = 'S' THEN 'sequence' ELSE 'table' END, r.oid, 0, r.shown,
    r.relacl, r.relowner, '', '', CASE WHEN r.relkind = 'S' THEN 'SEQUENCE ' ELSE 'TABLE ' END || r.target
  FROM rel r
  UNION ALL
  -- A column's grant is not in the table's ACL, and a table-level REVOKE may
  -- already have taken it: a row of its own, re-read before it is revoked.
  SELECT r.class, 'column', r.oid, a.attnum, r.shown, a.attacl, r.relowner, '',
    format(' (%I)', a.attname),
    'TABLE ' || r.target
  FROM rel r JOIN pg_attribute a ON a.attrelid = r.oid
  WHERE r.relkind <> 'S' AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
  UNION ALL
  -- ROUTINE, not FUNCTION: a procedure or an aggregate is revoked the same way.
  SELECT c.class, 'function', p.oid, 0, p.oid::regprocedure::text,
    coalesce(p.proacl, acldefault('f', p.proowner)), p.proowner, '', '',
    'ROUTINE ' || p.oid::regprocedure
  FROM pg_proc p JOIN user_ns n ON n.oid = p.pronamespace,
    LATERAL (VALUES
      (CASE WHEN p.prosecdef OR p.prorettype IN ('trigger'::regtype, 'event_trigger'::regtype)
         THEN 'definer function' END),
      (CASE WHEN p.proowner = to_regrole(MIGRATOR_ROLE) THEN 'migrator function' END)) c(class)
  WHERE c.class IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
      AND d.objid = p.oid AND d.deptype = 'e')
  UNION ALL
  SELECT 'default ' || t.objects, 'default', da.oid, 0,
    pg_get_userbyid(da.defaclrole) || coalesce(' in schema ' || n.nspname, ''), da.defaclacl,
    da.defaclrole, 'ALTER DEFAULT PRIVILEGES '
      || CASE WHEN n.oid IS NULL THEN '' ELSE format('IN SCHEMA %I ', n.nspname) END, '',
    upper(t.objects)
  FROM pg_default_acl da
    JOIN (VALUES ('r', 'tables'), ('S', 'sequences'), ('f', 'functions'), ('n', 'schemas'))
      t(objtype, objects) ON t.objtype = da.defaclobjtype
    LEFT JOIN pg_namespace n ON n.oid = da.defaclnamespace
  UNION ALL
  -- The migrator's functions, while it has no global default of its own: the
  -- built-in one, EXECUTE to PUBLIC.
  SELECT 'default functions', 'default', m.oid, 0, m.rolname::text, acldefault('f', m.oid), m.oid,
    'ALTER DEFAULT PRIVILEGES ', '', 'FUNCTIONS'
  FROM pg_roles m
  WHERE m.rolname = MIGRATOR_ROLE
    AND NOT EXISTS (SELECT 1 FROM pg_default_acl da WHERE da.defaclrole = m.oid
      AND da.defaclnamespace = 0 AND da.defaclobjtype = 'f')
)
SELECT ru.scope, format(ru.label, priv, o.shown) AS label, priv AS privilege, o.acl, o.owner,
  o.class = 'migrator function' AS public_only,
  o.revoke_prefix, priv || o.column_sql AS revoke_what, o.revoke_on,
  CASE
    WHEN o.kind = 'default' OR o.class = 'migrator function' THEN EXISTS (
      SELECT 1 FROM aclexplode(o.acl) a JOIN reachable r ON r.oid = a.grantee
      WHERE a.privilege_type = priv AND (o.class <> 'migrator function' OR a.grantee = 0))
    ELSE EXISTS (SELECT 1 FROM reachable r WHERE r.oid <> 0 AND CASE o.kind
      WHEN 'database' THEN has_database_privilege(r.oid, o.oid, priv)
      WHEN 'schema' THEN has_schema_privilege(r.oid, o.oid, priv)
      WHEN 'sequence' THEN has_sequence_privilege(r.oid, o.oid, priv)
      WHEN 'function' THEN has_function_privilege(r.oid, o.oid, priv)
      WHEN 'column' THEN has_column_privilege(r.oid, o.oid, o.attnum::smallint, priv)
      ELSE has_table_privilege(r.oid, o.oid, priv)
        OR (priv IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
            AND has_any_column_privilege(r.oid, o.oid, priv))
    END)
  END AS held
FROM objects o JOIN rules ru ON ru.class = o.class, unnest(ru.privileges) priv
WHERE o.kind <> 'column' OR priv IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
