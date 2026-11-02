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
/** The rights the runtime role may never hold: the same file the split revokes from. */
const forbiddenSql = readFileSync(
  new URL('runtime-forbidden.sql', privilegeLibrary),
  'utf8',
).replaceAll('MIGRATOR_ROLE', "(:'runtime' || '_migrator')");

// The split reads the list with the same three patterns (restore_runtime_function_grants).
const SERVICE = /^[a-z][a-z0-9]*$/;
const SIGNATURE = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\([A-Za-z0-9_.",]*\)$/;
const MIGRATION = /^[0-9]{14}_[a-z0-9_]+$/;

/**
 * runtime-function-grants.txt: `[service, signature, migration]` per line —
 * the last one too, newline or not; a malformed line throws.
 */
export function parseRequiredRuntimeFunctions(text) {
  return text
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const parts = line.split('|');
      if (
        parts.length !== 3 ||
        !SERVICE.test(parts[0]) ||
        !SIGNATURE.test(parts[1]) ||
        !MIGRATION.test(parts[2])
      ) {
        throw new Error('malformed required runtime function list');
      }
      return parts;
    });
}

export const requiredRuntimeFunctions = parseRequiredRuntimeFunctions(
  readFileSync(new URL('runtime-function-grants.txt', privilegeLibrary), 'utf8'),
);

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
 *   * membership in any role that owns something here, is named `*_migrator`,
 *     or is superuser-capable, and in the predefined roles that read or write
 *     everything or the server's files;
 *   * a required runtime function (runtime-function-grants.txt) it cannot run;
 *   * every right of runtime-forbidden.sql — the rules the split revokes by:
 *     CREATE or TEMPORARY on the database, CREATE on a schema, TRUNCATE,
 *     REFERENCES or TRIGGER on a table, view or foreign table (a column's
 *     REFERENCES too), UPDATE on a sequence, any right on the migration ledger,
 *     EXECUTE on a definer or trigger function, PUBLIC EXECUTE on a migrator
 *     function, a default privilege that would grant any of these to a later
 *     object, and writes on an extension's relations and sequences.
 *
 * `required` is the list to hold the role to (a test passes its own).
 */
export function findingsSql(required = requiredRuntimeFunctions) {
  const requiredFunctionValues = required
    .map(([service, signature]) => `('${service}', '${signature}')`)
    .join(',\n');
  return String.raw`
WITH me AS (
  SELECT oid, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
    FROM pg_roles WHERE rolname = :'runtime'
),
reachable AS (${reachableSql}),
forbidden AS (${forbiddenSql}),
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
SELECT DISTINCT finding FROM (
  SELECT 'is ' || a AS finding FROM me,
    LATERAL (VALUES ('SUPERUSER', rolsuper), ('CREATEDB', rolcreatedb),
                    ('CREATEROLE', rolcreaterole), ('BYPASSRLS', rolbypassrls)) v(a, held)
   WHERE held
  UNION ALL
  SELECT 'owns database ' || d.datname FROM pg_database d, me
   WHERE d.datname = current_database() AND pg_has_role(me.oid, d.datdba, 'MEMBER')
  UNION ALL
  SELECT 'owns schema ' || n.nspname FROM user_ns n, me
   WHERE pg_has_role(me.oid, n.nspowner, 'MEMBER')
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
  SELECT f.label FROM forbidden f WHERE f.held
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
  SELECT 'member of predefined role ' || r.rolname FROM pg_roles r
    JOIN reachable h ON h.oid = r.oid
   WHERE r.rolname IN ('pg_write_all_data', 'pg_read_all_data', 'pg_write_server_files',
     'pg_read_server_files', 'pg_execute_server_program', 'pg_maintain')
  UNION ALL
  SELECT 'missing required runtime EXECUTE on ' || f.signature FROM required_functions f, me
   WHERE to_regprocedure(f.signature) IS NULL
      OR NOT has_function_privilege(me.oid, to_regprocedure(f.signature), 'EXECUTE')
) f
ORDER BY finding;
`;
}

export const FINDINGS_SQL = findingsSql();

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
