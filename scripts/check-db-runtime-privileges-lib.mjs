// -----------------------------------------------------------------------------
// What a service's runtime database role may not hold (D-045), and the
// catalogue query that finds it if it does. scripts/check-db-runtime-privileges.mjs
// runs the query against every service database; this module is the part
// tests can execute without a cluster, plus the query itself so the live test
// (check-db-runtime-privileges.pg.test.mjs) runs exactly what CI runs.
// -----------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { servicesFromLibrary, splitServicesFromLibrary } from './infra-preflight-lib.mjs';

const privilegeLibrary = new URL('../infrastructure/docker/postgres/lib/', import.meta.url);
const reachableSql = readFileSync(
  new URL('runtime-reachable.sql', privilegeLibrary),
  'utf8',
).replaceAll('RUNTIME_ROLE', ":'runtime'");
export const requiredRuntimeFunctions = readFileSync(
  new URL('runtime-function-grants.txt', privilegeLibrary),
  'utf8',
)
  .split('\n')
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => {
    const parts = line.split('|');
    if (
      parts.length !== 2 ||
      !/^[a-z]+$/.test(parts[0]) ||
      !/^public\.[a-z_]+\([a-zA-Z",]+\)$/.test(parts[1])
    ) {
      throw new Error('malformed required runtime function list');
    }
    return parts;
  });
const requiredFunctionValues = requiredRuntimeFunctions
  .map(([service, signature]) => `('${service}', '${signature}')`)
  .join(',\n');

/**
 * Every service's place in the split: `split` (lib/service-privilege-split.bash)
 * or `audit` (its own schema, and its database since D-045). Throws when a
 * service is in neither or is unknown — a new service is split from its first
 * migration, by adding it to PRIVILEGE_SPLIT_SERVICES.
 */
export function classifyServices({
  services = servicesFromLibrary(),
  split = splitServicesFromLibrary(),
} = {}) {
  const placed = new Map();
  const place = (service, kind) => {
    if (placed.has(service)) {
      throw new Error(`${service} is both ${placed.get(service)} and ${kind}`);
    }
    placed.set(service, kind);
  };
  for (const service of split) place(service, 'split');
  place('audit', 'audit');
  for (const service of placed.keys()) {
    if (!services.includes(service)) throw new Error(`${service} is not in RASTA_SERVICES`);
  }
  const unplaced = services.filter((service) => !placed.has(service));
  if (unplaced.length > 0) {
    throw new Error(
      `${unplaced.join(', ')}: in RASTA_SERVICES but not in PRIVILEGE_SPLIT_SERVICES (D-045)`,
    );
  }
  return services.map((service) => ({
    service,
    kind: placed.get(service),
    database: `rasta_${service}`,
    runtime: `rasta_${service}`,
  }));
}

/**
 * One row per thing the runtime role holds that it must not, in the database
 * psql is connected to. Feed to `psql -v runtime=<role>` on stdin. Ownership
 * counts through membership of any kind (`pg_has_role … MEMBER`): a member
 * MEMBER is an intentionally conservative superset, including INHERIT FALSE
 * and SET FALSE membership; every forbidden-right rule uses it plus PUBLIC.
 *
 *   * role attributes: SUPERUSER, CREATEDB, CREATEROLE, BYPASSRLS;
 *   * owns the database, any non-system schema, relation, function or type;
 *   * CREATE on the database or on any non-system schema;
 *   * TRUNCATE, REFERENCES or TRIGGER on any table;
 *   * membership in any role that owns something here, is named `*_migrator`,
 *     or is superuser-capable;
 *   * extension relation writes, including inherited/PUBLIC and column grants;
 *   * any right on the migration ledger `_prisma_migrations`, table or column.
 */
export const FINDINGS_SQL = String.raw`
WITH me AS (
  SELECT oid, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
    FROM pg_roles WHERE rolname = :'runtime'
),
reachable AS (${reachableSql}),
required_functions AS MATERIALIZED (
  SELECT signature FROM (VALUES ${requiredFunctionValues}) v(service, signature)
  WHERE :'runtime' = 'rasta_' || service
),
user_ns AS (
  SELECT oid, nspname, nspowner FROM pg_namespace
   WHERE nspname NOT IN ('pg_catalog', 'information_schema')
     AND nspname NOT LIKE 'pg\_toast%' AND nspname NOT LIKE 'pg\_temp\_%'
),
user_tables AS (
  SELECT c.oid, n.nspname, c.relname, c.relkind, c.relowner FROM pg_class c
    JOIN user_ns n ON n.oid = c.relnamespace
)
SELECT finding FROM (
  SELECT 'role does not exist' AS finding WHERE NOT EXISTS (SELECT 1 FROM me)
  UNION ALL
  SELECT 'is ' || a FROM me,
    LATERAL (VALUES ('SUPERUSER', rolsuper), ('CREATEDB', rolcreatedb),
                    ('CREATEROLE', rolcreaterole), ('BYPASSRLS', rolbypassrls)) v(a, held)
   WHERE held
  UNION ALL
  SELECT 'owns database ' || d.datname FROM pg_database d, me
   WHERE d.datname = current_database() AND pg_has_role(me.oid, d.datdba, 'MEMBER')
  UNION ALL
  SELECT 'CREATE on database ' || current_database() FROM me
   WHERE EXISTS (SELECT 1 FROM reachable r WHERE r.oid <> 0 AND has_database_privilege(r.oid, current_database(), 'CREATE'))
  UNION ALL
  SELECT 'owns schema ' || n.nspname FROM user_ns n, me
   WHERE pg_has_role(me.oid, n.nspowner, 'MEMBER')
  UNION ALL
  SELECT 'CREATE on schema ' || n.nspname FROM user_ns n, me
   WHERE EXISTS (SELECT 1 FROM reachable r WHERE r.oid <> 0 AND has_schema_privilege(r.oid, n.oid, 'CREATE'))
  UNION ALL
  SELECT 'owns ' || CASE t.relkind WHEN 'S' THEN 'sequence' WHEN 'i' THEN 'index'
                       WHEN 'I' THEN 'index' WHEN 'v' THEN 'view'
                       WHEN 'm' THEN 'materialized view' ELSE 'table' END
         || ' ' || t.nspname || '.' || t.relname
    FROM user_tables t, me WHERE pg_has_role(me.oid, t.relowner, 'MEMBER')
  UNION ALL
  SELECT 'owns function ' || p.oid::regprocedure::text FROM pg_proc p
    JOIN user_ns n ON n.oid = p.pronamespace, me
   WHERE pg_has_role(me.oid, p.proowner, 'MEMBER')
  UNION ALL
  SELECT 'owns type ' || n.nspname || '.' || ty.typname FROM pg_type ty
    JOIN user_ns n ON n.oid = ty.typnamespace, me
   WHERE ty.typrelid = 0 AND ty.typelem = 0 AND pg_has_role(me.oid, ty.typowner, 'MEMBER')
  UNION ALL
  SELECT priv || ' on ' || t.nspname || '.' || t.relname
    FROM user_tables t, me, unnest(ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER']) priv
   WHERE t.relkind IN ('r', 'p') AND EXISTS (SELECT 1 FROM reachable r WHERE r.oid <> 0 AND has_table_privilege(r.oid, t.oid, priv))
  UNION ALL
  SELECT priv || ' on extension relation ' || t.nspname || '.' || t.relname
    FROM user_tables t, me,
         unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) priv
   WHERE t.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND EXISTS (SELECT 1 FROM pg_depend d
                  WHERE d.classid = 'pg_class'::regclass AND d.objid = t.oid AND d.deptype = 'e')
     AND (EXISTS (SELECT 1 FROM reachable r WHERE r.oid <> 0 AND has_table_privilege(r.oid, t.oid, priv))
          OR (priv IN ('INSERT', 'UPDATE', 'REFERENCES') AND EXISTS (SELECT 1 FROM reachable r WHERE r.oid <> 0 AND has_any_column_privilege(r.oid, t.oid, priv))))
  UNION ALL
  SELECT priv || ' on extension sequence ' || t.nspname || '.' || t.relname
    FROM user_tables t, me, unnest(ARRAY['USAGE', 'UPDATE']) priv
   WHERE t.relkind = 'S'
     AND EXISTS (SELECT 1 FROM pg_depend d
                  WHERE d.classid = 'pg_class'::regclass AND d.objid = t.oid AND d.deptype = 'e')
     AND EXISTS (SELECT 1 FROM reachable r WHERE r.oid <> 0 AND has_sequence_privilege(r.oid, t.oid, priv))
  UNION ALL
  SELECT 'member of ' || m.rolname || ' (could SET ROLE to an owner or superuser-capable role)'
    FROM pg_roles m, me
   WHERE m.oid <> me.oid AND pg_has_role(me.oid, m.oid, 'MEMBER')
     AND (m.rolsuper OR m.rolcreatedb OR m.rolcreaterole OR m.rolbypassrls
          OR m.rolname LIKE '%\_migrator'
          OR EXISTS (SELECT 1 FROM pg_database d
                      WHERE d.datname = current_database() AND d.datdba = m.oid)
          OR EXISTS (SELECT 1 FROM user_ns n WHERE n.nspowner = m.oid)
          OR EXISTS (SELECT 1 FROM user_tables t WHERE t.relowner = m.oid))
  UNION ALL
  SELECT 'a right on ' || t.nspname || '._prisma_migrations' FROM user_tables t, me
   WHERE t.relname = '_prisma_migrations'
     AND (EXISTS (SELECT 1 FROM reachable r WHERE r.oid <> 0 AND has_table_privilege(r.oid, t.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'))
          OR EXISTS (SELECT 1 FROM reachable r WHERE r.oid <> 0 AND has_any_column_privilege(r.oid, t.oid, 'SELECT, INSERT, UPDATE, REFERENCES')))
  UNION ALL
  SELECT 'member of predefined role ' || r.rolname FROM pg_roles r
    JOIN reachable h ON h.oid = r.oid
   WHERE r.rolname IN ('pg_write_all_data', 'pg_read_all_data', 'pg_write_server_files',
     'pg_read_server_files', 'pg_execute_server_program', 'pg_maintain')
  UNION ALL
  SELECT 'PUBLIC EXECUTE on migrator function ' || p.oid::regprocedure::text
    FROM pg_proc p JOIN pg_roles owner ON owner.oid = p.proowner,
      LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
   WHERE owner.rolname = :'runtime' || '_migrator' AND a.grantee = 0
     AND a.privilege_type = 'EXECUTE'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
       AND d.objid = p.oid AND d.deptype = 'e')
  UNION ALL
  SELECT 'reachable EXECUTE on definer/trigger function ' || p.oid::regprocedure::text
    FROM pg_proc p JOIN user_ns n ON n.oid = p.pronamespace
   WHERE (p.prosecdef OR p.prorettype IN ('trigger'::regtype, 'event_trigger'::regtype))
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
       AND d.objid = p.oid AND d.deptype = 'e')
     AND EXISTS (SELECT 1 FROM reachable r WHERE r.oid <> 0
       AND has_function_privilege(r.oid, p.oid, 'EXECUTE'))
  UNION ALL
  SELECT 'missing required runtime EXECUTE on ' || f.signature FROM required_functions f, me
   WHERE to_regprocedure(f.signature) IS NULL
      OR NOT has_function_privilege(me.oid, to_regprocedure(f.signature), 'EXECUTE')
) f
ORDER BY finding;
`;

/** The verdict for one service, from its findings: any finding fails. */
export function verdict({ service }, findings) {
  if (findings.length === 0) return { ok: true, line: `${service}: runtime role owns nothing` };
  return {
    ok: false,
    line: `${service}: the runtime role ${findings.length === 1 ? 'holds' : 'holds each of'}:\n${findings
      .map((f) => `    - ${f}`)
      .join('\n')}`,
  };
}

/**
 * One row per way a session on this database could start in a zone other than
 * UTC without the client asking (L7-37, review of #214): the database's own
 * default, the runtime role's and the migrator's — each must be `UTC` — and
 * any per-database override for either role here that is not. These are what
 * lib/session-timezone.bash sets; they are the guarantee a pooled connection
 * that drops the client's startup option still has. The server's
 * postgresql.conf is deliberately not consulted: these outrank it. Feed to
 * `psql -v runtime=<role> -v migrator=<role>` on stdin.
 */
export const TIMEZONE_FINDINGS_SQL = String.raw`
WITH roles AS (
  SELECT r.name, pr.oid FROM unnest(ARRAY[:'runtime', :'migrator']) AS r(name)
    LEFT JOIN pg_roles pr ON pr.rolname = r.name
),
here AS (SELECT oid FROM pg_database WHERE datname = current_database()),
zones AS (
  SELECT s.setdatabase, s.setrole, substr(cfg, strpos(cfg, '=') + 1) AS zone
    FROM pg_db_role_setting s, unnest(s.setconfig) cfg
   WHERE lower(split_part(cfg, '=', 1)) = 'timezone'
)
SELECT finding FROM (
  SELECT 'database ' || current_database() || ' default TimeZone is '
         || coalesce((SELECT z.zone FROM zones z, here
                       WHERE z.setdatabase = here.oid AND z.setrole = 0), 'unset') AS finding
   WHERE coalesce((SELECT z.zone FROM zones z, here
                    WHERE z.setdatabase = here.oid AND z.setrole = 0), '') <> 'UTC'
  UNION ALL
  SELECT 'role ' || r.name || ' does not exist' FROM roles r WHERE r.oid IS NULL
  UNION ALL
  SELECT 'role ' || r.name || ' default TimeZone is ' || coalesce(z.zone, 'unset')
    FROM roles r LEFT JOIN zones z ON z.setrole = r.oid AND z.setdatabase = 0
   WHERE r.oid IS NOT NULL AND coalesce(z.zone, '') <> 'UTC'
  UNION ALL
  SELECT 'role ' || r.name || ' in database ' || current_database()
         || ' overrides TimeZone to ' || z.zone
    FROM roles r JOIN zones z ON z.setrole = r.oid JOIN here ON z.setdatabase = here.oid
   WHERE z.zone <> 'UTC'
) f
ORDER BY finding;
`;

/** The verdict on one service's UTC session defaults, from TIMEZONE_FINDINGS_SQL's rows. */
export function timezoneVerdict({ service }, findings) {
  if (findings.length === 0) {
    return { ok: true, line: `${service}: database, runtime role and migrator default to UTC` };
  }
  return {
    ok: false,
    line: `${service}: sessions may not start in UTC:\n${findings.map((f) => `    - ${f}`).join('\n')}`,
  };
}
