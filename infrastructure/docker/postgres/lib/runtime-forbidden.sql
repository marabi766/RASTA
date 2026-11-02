-- -----------------------------------------------------------------------------
-- The rights a service's runtime role must not hold (D-045): everything the
-- allowlist does not allow (#421 r1 F3b). ONE query, read by the split
-- (lib/service-privilege-split.bash revokes every ACL entry it finds, then
-- fails unless nothing is held) and by the catalogue check
-- (scripts/check-db-runtime-privileges-lib.mjs reports every row held).
--
-- A body for `WITH reachable AS (runtime-reachable.sql), allowlist AS
-- (runtime-allowlist.sql), runtime_functions AS (<service, signature> rows of
-- runtime-function-grants.txt), acl_entries AS (runtime-acl-entries.sql),
-- forbidden AS (this)`, with RUNTIME_ROLE, MIGRATOR_ROLE and RUNTIME_POLICY
-- replaced by string literals (or psql variables). Every object that carries
-- an ACL is judged (#540 r1 F1: the complete inventory, runtime-acl-entries.sql):
--
--   * the database, each non-system schema, relation (each partition too),
--     column with an ACL of its own, sequence, non-extension routine and
--     default ACL for tables, sequences, functions and schemas: each privilege
--     its kind has becomes a row unless the policy allows it; an allowed
--     privilege is a row only as a grant option, which nothing allows — or
--     when it is granted to PUBLIC or to a role of the closure other than the
--     runtime role itself, which every other role would then share (#540 r1
--     F2): only the runtime role's own grant is allowed;
--   * everything else — pg_catalog's and information_schema's relations,
--     columns, routines and the schemas themselves; extension routines; types
--     and domains; languages; large objects; foreign-data wrappers and
--     servers; tablespaces; parameters (pg_parameter_acl: SET, ALTER SYSTEM);
--     default ACLs for types or of a type PostgreSQL adds later: any entry
--     for a role of the closure that is not part of the object's built-in
--     privileges (pg_init_privs, else acldefault) is a row — except USAGE on
--     a type the policy names, granted to the runtime role itself;
--   * a catalogue ACL column runtime-acl-entries.sql does not model: a row
--     nothing can revoke (fail closed).
--
-- One row per object, privilege and ACL:
--
--   scope        general, or extension (the split runs it after its table grants)
--   label        what the check reports
--   privilege    as aclexplode() spells it
--   grant_option only the grant option is forbidden (the privilege is allowed)
--   acl          the aclitem[] that grants it (the built-in default while NULL)
--   owner        the object's owner, who can lend a grantor its grant option
--   public_only  only PUBLIC's entry is forbidden (a migrator function's EXECUTE)
--   privilege_sql  the privilege as GRANT/REVOKE name it, a column's included
--   revoke_prefix, revoke_what, revoke_on
--                the REVOKE: `<prefix>REVOKE <what> ON <on> FROM <grantee>
--                CASCADE`, run as the entry's grantor
--   held         a role of the closure effectively holds it (has_*_privilege;
--                the entry itself where no such function exists)
--   grantees     the only grantees whose entries are forbidden (NULL: every
--                role of the closure)
--
-- Rows with no ACL report a broken policy: none named RUNTIME_POLICY, a service
-- with a policy of its own held to another, or an allowlist row asking for more
-- than its class's ceiling — or a catalogue ACL nobody models. The split
-- cannot revoke them; it fails on them.
--
-- Not here: role attributes, ownership and membership, predefined roles and
-- the required runtime EXECUTE list — the check's own rules (no REVOKE of an
-- ACL entry repairs them) — another service's runtime role in this database
-- (runtime-foreign.sql), and an allowed right the role does NOT hold (the
-- check's: the split runs before the migrations that grant it).
-- -----------------------------------------------------------------------------
WITH ceiling (class, privileges) AS (VALUES
  ('database', ARRAY['CONNECT']),
  ('schema', ARRAY['USAGE']),
  -- Never TRUNCATE, REFERENCES or TRIGGER; never setval (sequence UPDATE).
  ('relation', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
  ('sequence', ARRAY['USAGE', 'SELECT']),
  ('extension relation', ARRAY['SELECT']),
  ('extension sequence', ARRAY['SELECT']),
  ('default tables', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
  ('default sequences', ARRAY['USAGE', 'SELECT']),
  -- An enum a runtime cast or function names (audit's).
  ('type', ARRAY['USAGE'])
),
-- What this policy allows, within each class's ceiling. The ledger, a definer
-- or trigger function, default function/schema privileges: no class, nothing.
-- A `type` row names `schema.type`.
granted AS (
  SELECT a.class, a.object, priv
    FROM allowlist a JOIN ceiling c ON c.class = a.class, unnest(a.privileges) priv
   WHERE a.policy IN (RUNTIME_POLICY, '*') AND priv = ANY (c.privileges)
),
listed AS (
  SELECT to_regprocedure(f.signature) AS oid FROM runtime_functions f
   WHERE 'rasta_' || f.service = RUNTIME_ROLE
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
    n.nspname || '.' || c.relname AS shown, n.nspname,
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
rel_allowed AS (
  SELECT r.*, ARRAY(SELECT g.priv FROM granted g WHERE g.class = r.class
                      AND g.object IN (r.shown, r.nspname || '.*', '*')) AS allowed
    FROM rel r
),
objects (class, kind, oid, attnum, shown, acl, owner, revoke_prefix, column_sql, revoke_on,
         privileges, allowed) AS (
  SELECT 'database', 'database', d.oid, 0, d.datname::text,
    coalesce(d.datacl, acldefault('d', d.datdba)), d.datdba, '', '',
    format('DATABASE %I', d.datname), ARRAY['CREATE', 'TEMPORARY', 'CONNECT'],
    ARRAY(SELECT g.priv FROM granted g WHERE g.class = 'database')
  FROM pg_database d WHERE d.datname = current_database()
  UNION ALL
  SELECT 'schema', 'schema', n.oid, 0, n.nspname::text, n.nspacl, n.nspowner, '', '',
    format('SCHEMA %I', n.nspname), ARRAY['CREATE', 'USAGE'],
    ARRAY(SELECT g.priv FROM granted g WHERE g.class = 'schema' AND g.object = n.nspname)
  FROM user_ns n
  UNION ALL
  SELECT r.class, CASE WHEN r.relkind = 'S' THEN 'sequence' ELSE 'table' END, r.oid, 0, r.shown,
    r.relacl, r.relowner, '', '', CASE WHEN r.relkind = 'S' THEN 'SEQUENCE ' ELSE 'TABLE ' END || r.target,
    CASE WHEN r.relkind = 'S' THEN ARRAY['USAGE', 'SELECT', 'UPDATE']
         ELSE ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] END,
    r.allowed
  FROM rel_allowed r
  UNION ALL
  -- A column's grant is not in the table's ACL, and a table-level REVOKE may
  -- already have taken it: a row of its own, re-read before it is revoked.
  -- Allowed what its relation is.
  SELECT r.class, 'column', r.oid, a.attnum, format('%s (%s)', r.shown, a.attname), a.attacl,
    r.relowner, '',
    format(' (%I)', a.attname), 'TABLE ' || r.target,
    ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'], r.allowed
  FROM rel_allowed r JOIN pg_attribute a ON a.attrelid = r.oid
  WHERE r.relkind <> 'S' AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
  UNION ALL
  -- Every non-extension routine: EXECUTE only where runtime-function-grants.txt
  -- lists it for this service, and never on a definer or trigger function.
  -- ROUTINE, not FUNCTION: a procedure or an aggregate is revoked the same way.
  SELECT c.class, 'function', p.oid, 0, p.oid::regprocedure::text,
    coalesce(p.proacl, acldefault('f', p.proowner)), p.proowner, '', '',
    'ROUTINE ' || p.oid::regprocedure, ARRAY['EXECUTE'],
    CASE WHEN c.class = 'function' AND p.oid IN (SELECT l.oid FROM listed l)
         THEN ARRAY['EXECUTE'] ELSE ARRAY[]::text[] END
  FROM pg_proc p JOIN user_ns n ON n.oid = p.pronamespace,
    LATERAL (VALUES
      (CASE WHEN p.prosecdef OR p.prorettype IN ('trigger'::regtype, 'event_trigger'::regtype)
         THEN 'definer function' ELSE 'function' END),
      -- PUBLIC's EXECUTE, even on a listed one: the runtime role's is its own grant.
      (CASE WHEN p.proowner = to_regrole(MIGRATOR_ROLE) THEN 'migrator function' END)) c(class)
  WHERE c.class IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
      AND d.objid = p.oid AND d.deptype = 'e')
  UNION ALL
  -- Default privileges: what every object created later would grant. Only the
  -- migrator's, in a schema its policy names, may grant anything.
  SELECT 'default ' || t.objects, 'default', da.oid, 0,
    pg_get_userbyid(da.defaclrole) || coalesce(' in schema ' || n.nspname, ''), da.defaclacl,
    da.defaclrole, 'ALTER DEFAULT PRIVILEGES '
      || CASE WHEN n.oid IS NULL THEN '' ELSE format('IN SCHEMA %I ', n.nspname) END, '',
    upper(t.objects), t.privileges,
    ARRAY(SELECT g.priv FROM granted g WHERE g.class = 'default ' || t.objects
            AND g.object = n.nspname AND da.defaclrole = to_regrole(MIGRATOR_ROLE))
  FROM pg_default_acl da
    JOIN (VALUES
      ('r', 'tables', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']),
      ('S', 'sequences', ARRAY['USAGE', 'SELECT', 'UPDATE']),
      ('f', 'functions', ARRAY['EXECUTE']),
      ('n', 'schemas', ARRAY['CREATE', 'USAGE'])) t(objtype, objects, privileges)
      ON t.objtype = da.defaclobjtype
    LEFT JOIN pg_namespace n ON n.oid = da.defaclnamespace
  UNION ALL
  -- The migrator's functions, while it has no global default of its own: the
  -- built-in one, EXECUTE to PUBLIC.
  SELECT 'default functions', 'default', m.oid, 0, m.rolname::text, acldefault('f', m.oid), m.oid,
    'ALTER DEFAULT PRIVILEGES ', '', 'FUNCTIONS', ARRAY['EXECUTE'], ARRAY[]::text[]
  FROM pg_roles m
  WHERE m.rolname = MIGRATOR_ROLE
    AND NOT EXISTS (SELECT 1 FROM pg_default_acl da WHERE da.defaclrole = m.oid
      AND da.defaclnamespace = 0 AND da.defaclobjtype = 'f')
),
labels (class, label) AS (VALUES
  ('database', '%s on database %s'),
  ('schema', '%s on schema %s'),
  ('relation', '%s on %s'),
  ('sequence', '%s on sequence %s'),
  ('ledger', 'a right on %2$s'),
  ('extension relation', '%s on extension relation %s'),
  ('extension sequence', '%s on extension sequence %s'),
  ('definer function', 'reachable EXECUTE on definer/trigger function %2$s'),
  ('function', 'EXECUTE on function %2$s, not in runtime-function-grants.txt'),
  ('migrator function', 'PUBLIC EXECUTE on migrator function %2$s'),
  ('default tables', 'default %s on new tables of %s'),
  ('default sequences', 'default %s on new sequences of %s'),
  ('default functions', 'default %s on new functions of %s'),
  ('default schemas', 'default %s on new schemas of %s')
)
SELECT CASE WHEN o.class LIKE 'extension %' THEN 'extension' ELSE 'general' END AS scope,
  CASE WHEN p.grant_option THEN 'grant option: ' ELSE '' END || format(l.label, p.priv, o.shown)
    AS label,
  p.priv AS privilege, p.grant_option, o.acl, o.owner,
  o.class = 'migrator function' AS public_only,
  p.priv || o.column_sql AS privilege_sql,
  o.revoke_prefix,
  CASE WHEN p.grant_option THEN 'GRANT OPTION FOR ' ELSE '' END || p.priv || o.column_sql AS revoke_what,
  o.revoke_on,
  CASE
    WHEN o.kind = 'default' OR o.class = 'migrator function' THEN EXISTS (
      SELECT 1 FROM aclexplode(o.acl) a JOIN reachable r ON r.oid = a.grantee
      WHERE a.privilege_type = p.priv AND (a.is_grantable OR NOT p.grant_option)
        AND (o.class <> 'migrator function' OR a.grantee = 0))
    ELSE EXISTS (SELECT 1 FROM reachable r WHERE r.oid <> 0 AND CASE o.kind
      WHEN 'database' THEN has_database_privilege(r.oid, o.oid, p.want)
      WHEN 'schema' THEN has_schema_privilege(r.oid, o.oid, p.want)
      WHEN 'sequence' THEN has_sequence_privilege(r.oid, o.oid, p.want)
      WHEN 'function' THEN has_function_privilege(r.oid, o.oid, p.want)
      WHEN 'column' THEN has_column_privilege(r.oid, o.oid, o.attnum::smallint, p.want)
      ELSE has_table_privilege(r.oid, o.oid, p.want)
        OR (p.priv IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
            AND has_any_column_privilege(r.oid, o.oid, p.want))
    END)
  END AS held,
  NULL::oid[] AS grantees
FROM objects o JOIN labels l ON l.class = o.class,
  LATERAL (
    SELECT priv, false AS grant_option, priv AS want
      FROM unnest(o.privileges) priv WHERE NOT priv = ANY (o.allowed)
    UNION ALL
    SELECT priv, true, priv || ' WITH GRANT OPTION'
      FROM unnest(o.privileges) priv
     WHERE priv = ANY (o.allowed) AND o.class <> 'migrator function'
  ) p
WHERE o.kind <> 'column' OR p.priv IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
UNION ALL
-- An allowed privilege granted to PUBLIC or to another role of the closure,
-- not to the runtime role itself: every role holds PUBLIC's, every member the
-- group's — another service's runtime role among them (#540 r1 F2). An
-- extension's own grant to PUBLIC (pg_init_privs) stays; the migrator
-- function's PUBLIC EXECUTE is its class's row.
SELECT CASE WHEN o.class LIKE 'extension %' THEN 'extension' ELSE 'general' END,
  format('%s on %s %s, granted to %s, not to the runtime role itself', x.privilege_type, o.class,
         o.shown, CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END),
  x.privilege_type, false, o.acl, o.owner, false, x.privilege_type || o.column_sql,
  o.revoke_prefix, x.privilege_type || o.column_sql, o.revoke_on, true, ARRAY[x.grantee]
FROM objects o CROSS JOIN LATERAL aclexplode(o.acl) x
WHERE x.privilege_type = ANY (o.allowed) AND o.class <> 'migrator function'
  AND x.grantee IN (SELECT r.oid FROM reachable r)
  AND x.grantee IS DISTINCT FROM to_regrole(RUNTIME_ROLE)
  AND NOT EXISTS (
    SELECT 1 FROM pg_init_privs i CROSS JOIN LATERAL aclexplode(i.initprivs) d
     WHERE i.privtype = 'e' AND i.objoid = o.oid AND i.objsubid = o.attnum
       AND i.classoid = CASE o.kind WHEN 'database' THEN 'pg_database'::regclass
                                    WHEN 'schema' THEN 'pg_namespace'::regclass
                                    WHEN 'function' THEN 'pg_proc'::regclass
                                    ELSE 'pg_class'::regclass END
       AND d.grantee = x.grantee AND d.privilege_type = x.privilege_type)
UNION ALL
-- Every other ACL (#540 r1 F1): an entry for a role of the closure beyond the
-- object's built-in privileges. Only its grant option, where the built-in
-- privileges (or the policy's USAGE on a type, to the runtime role itself)
-- hold the privilege without one.
SELECT CASE WHEN e.extension THEN 'extension' ELSE 'general' END,
  CASE WHEN g.option_only THEN 'grant option: ' ELSE '' END
    || format('%s on %s%s %s, granted to %s, beyond the built-in privileges', e.privilege,
              CASE WHEN e.system AND e.kind <> 'parameter' THEN 'system '
                   WHEN e.extension THEN 'extension ' ELSE '' END,
              e.kind, e.shown, CASE WHEN e.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(e.grantee) END),
  e.privilege, g.option_only, e.acl, e.owner, false, e.privilege_sql, e.revoke_prefix,
  CASE WHEN g.option_only THEN 'GRANT OPTION FOR ' ELSE '' END || e.privilege_sql, e.revoke_on, true,
  ARRAY[e.grantee]
FROM acl_entries e,
  LATERAL (SELECT e.kind = 'type' AND e.grantee = to_regrole(RUNTIME_ROLE)
                  AND EXISTS (SELECT 1 FROM granted t WHERE t.class = 'type' AND t.object = e.shown
                                AND t.priv = e.privilege) AS allowed) a,
  LATERAL (SELECT e.built_in_plain OR a.allowed AS option_only) g
WHERE e.kind <> 'unmodeled' AND NOT e.built_in AND e.grantee IN (SELECT r.oid FROM reachable r)
  AND NOT (a.allowed AND NOT e.grantable)
  -- What the rows above judge, privilege by privilege.
  AND NOT (e.kind = 'database'
           OR (NOT e.system AND e.kind IN ('schema', 'table', 'sequence', 'column'))
           OR (NOT e.system AND e.kind = 'routine' AND NOT e.extension)
           OR (e.kind = 'default' AND e.defaults IN ('TABLES', 'SEQUENCES', 'FUNCTIONS', 'SCHEMAS')))
UNION ALL
SELECT 'general', problem, NULL, false, NULL::aclitem[], NULL::oid, false, NULL, NULL, NULL, NULL, true,
  NULL::oid[]
FROM (
  SELECT format('no runtime allowlist for policy %s (runtime-allowlist.sql)', RUNTIME_POLICY)
   WHERE NOT EXISTS (SELECT 1 FROM allowlist a WHERE a.policy = RUNTIME_POLICY)
  UNION ALL
  SELECT format('%s has a runtime allowlist of its own, yet is held to policy %s',
                RUNTIME_ROLE, RUNTIME_POLICY)
   WHERE RUNTIME_POLICY <> substr(RUNTIME_ROLE, 7)
     AND EXISTS (SELECT 1 FROM allowlist a WHERE a.policy = substr(RUNTIME_ROLE, 7))
  UNION ALL
  SELECT format('runtime-allowlist.sql: %s allows %s on %s %s, beyond what its class may hold',
                a.policy, priv, a.class, a.object)
    FROM allowlist a LEFT JOIN ceiling c ON c.class = a.class, unnest(a.privileges) priv
   WHERE c.class IS NULL OR NOT priv = ANY (c.privileges)
  UNION ALL
  SELECT format('the ACL column %s is not modeled (runtime-acl-entries.sql): nothing checks it',
                e.shown)
    FROM acl_entries e WHERE e.kind = 'unmodeled'
) broken(problem)
