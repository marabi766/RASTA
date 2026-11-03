// -----------------------------------------------------------------------------
// What a service's runtime database role may not hold (D-045), and the
// catalogue query that finds it if it does. scripts/check-db-runtime-privileges.mjs
// runs the query against every service database; this module is the part
// tests can execute without a cluster, plus the query itself so the live test
// (check-db-runtime-privileges.pg.test.mjs) runs exactly what CI runs.
// -----------------------------------------------------------------------------
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  ROLE_LIBRARY,
  servicesFromLibrary,
  splitServicesFromLibrary,
} from './infra-preflight-lib.mjs';

const privilegeLibrary = new URL('../infrastructure/docker/postgres/lib/', import.meta.url);
const reachableSql = readFileSync(
  new URL('runtime-reachable.sql', privilegeLibrary),
  'utf8',
).replaceAll('RUNTIME_ROLE', ":'runtime'");
/** Everything the runtime role may hold, per policy: the file the split grants and revokes by. */
export const allowlistSql = readFileSync(
  new URL('runtime-allowlist.sql', privilegeLibrary),
  'utf8',
);
/** What it may not — the allowlist turned round: the same file the split revokes from. */
const forbiddenSql = readFileSync(new URL('runtime-forbidden.sql', privilegeLibrary), 'utf8')
  .replaceAll('MIGRATOR_ROLE', "(:'runtime' || '_migrator')")
  .replaceAll('RUNTIME_ROLE', ":'runtime'")
  .replaceAll('RUNTIME_POLICY', ":'policy'");
/**
 * Every service's runtime role, as the SQL files take them: a text[] of
 * `rasta_<svc>` for each RASTA_SERVICES entry — what the split passes too
 * (lib/service-privilege-split.bash _runtime_roles_sql). Each name matched
 * SERVICE_NAME, so it is a safe literal.
 */
const SERVICE_NAME = /^[a-z][a-z0-9]*$/;
export function runtimeRolesSql(services = servicesFromLibrary()) {
  for (const service of services) {
    if (!SERVICE_NAME.test(service)) throw new Error(`unreadable service name: ${service}`);
  }
  return `ARRAY[${services.map((service) => `'rasta_${service}'`).join(', ')}]::text[]`;
}
const RUNTIME_ROLES = runtimeRolesSql();
/**
 * Each query below starts with this. They read a few thousand catalogue rows;
 * their estimates cross jit_above_cost, and compiling then costs about a
 * second a query for nothing (measured on PG16: 1.4 s against 0.2 s). The
 * split's sessions set the same (lib/service-privilege-split.bash).
 */
const NO_JIT = 'SET jit = off;';
/** Every ACL entry of every object (#540 r1 F1): the inventory both rule files judge. */
const aclEntriesSql = readFileSync(new URL('runtime-acl-entries.sql', privilegeLibrary), 'utf8');
/** The roles no runtime role may be a member of — the split's list. */
/** Stored settings that reach the runtime role's sessions — the split resets the same rows. */
const settingsSql = readFileSync(
  new URL('runtime-settings.sql', privilegeLibrary),
  'utf8',
).replaceAll('RUNTIME_ROLE', ":'runtime'");
const dangerousSql = readFileSync(
  new URL('runtime-dangerous-roles.sql', privilegeLibrary),
  'utf8',
).replaceAll('RUNTIME_ROLES', RUNTIME_ROLES);
/** The one file of declared foreign-access exceptions (#540 r1 F2). */
export const foreignExceptionsSql = readFileSync(
  new URL('runtime-foreign-exceptions.sql', privilegeLibrary),
  'utf8',
);
/** What other services' runtime roles hold in a database: the file the split revokes from. */
const foreignSql = readFileSync(new URL('runtime-foreign.sql', privilegeLibrary), 'utf8')
  .replaceAll('RUNTIME_ROLES', RUNTIME_ROLES)
  .replaceAll('RUNTIME_ROLE', ":'runtime'");

/**
 * One line of runtime-function-grants.txt, matched whole: exactly three
 * non-empty fields. The split's _runtime_function_grant_rows uses this very
 * pattern, and check-db-runtime-privileges-lib.test.mjs runs both on one corpus
 * (#520 r1 R2).
 */
export const FUNCTION_GRANT_LINE =
  /^[a-z][a-z0-9]*[|][a-z_][a-z0-9_]*[.][a-z_][a-z0-9_]*[(][A-Za-z0-9_.",]*[)][|][0-9]{14}_[a-z0-9_]+$/;

/**
 * runtime-function-grants.txt: `[service, signature, migration]` per line —
 * the last one too, newline or not. An empty line or one starting with `#` is
 * skipped; any other line that FUNCTION_GRANT_LINE does not match whole, or a
 * NUL byte anywhere, throws.
 */
export function parseRequiredRuntimeFunctions(text) {
  if (text.includes('\0')) throw new Error('malformed required runtime function list');
  return text
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      if (!FUNCTION_GRANT_LINE.test(line))
        throw new Error('malformed required runtime function list');
      return line.split('|'); // exactly three: no field may hold a `|`
    });
}

export const requiredRuntimeFunctions = parseRequiredRuntimeFunctions(
  readFileSync(new URL('runtime-function-grants.txt', privilegeLibrary), 'utf8'),
);

/**
 * Each split service's grants mode, as the split itself gets it:
 * privilege_split_grants_mode of lib/role-passwords.bash, run by bash (the
 * script on stdin, the library's path in the environment: no argv).
 */
export function grantsModesFromLibrary(library = ROLE_LIBRARY) {
  const result = spawnSync('bash', [], {
    input:
      'source "$RASTA_ROLE_LIBRARY" && for svc in "${PRIVILEGE_SPLIT_SERVICES[@]}"; do ' +
      'printf "%s %s\\n" "$svc" "$(privilege_split_grants_mode "$svc")"; done\n',
    env: { ...process.env, RASTA_ROLE_LIBRARY: library },
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`grants modes unreadable: ${result.stderr}`);
  return new Map(
    result.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(' ')),
  );
}

/**
 * The runtime-allowlist.sql policy a service is held to — the split's choice
 * (split_service_privileges, split_audit_database_privileges): `audit`;
 * `default` in grants mode default; the service's own in mode migration.
 * Anything else throws.
 */
export function policyFor(service, kind, mode) {
  if (kind === 'audit') return 'audit';
  if (mode === 'default') return 'default';
  if (mode === 'migration') return service;
  throw new Error(`${service}: unknown grants mode ${mode}`);
}

/**
 * Every service's place in the split: `split` (lib/service-privilege-split.bash)
 * or `audit` (its own schema, and its database since D-045), and the policy it
 * is held to. Throws when a service is in neither or is unknown — a new
 * service is split from its first migration, by adding it to
 * PRIVILEGE_SPLIT_SERVICES.
 */
export function classifyServices({
  services = servicesFromLibrary(),
  split = splitServicesFromLibrary(),
  modes,
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
  const grantsModes = modes ?? grantsModesFromLibrary();
  return services.map((service) => ({
    service,
    kind: placed.get(service),
    database: `rasta_${service}`,
    runtime: `rasta_${service}`,
    policy: policyFor(service, placed.get(service), grantsModes.get(service)),
  }));
}

/**
 * One row per thing the runtime role holds that it must not, in the database
 * psql is connected to, or is allowed and does not hold. Feed to
 * `psql -v runtime=<role> -v policy=<policy>` on stdin. Ownership counts through membership of any kind
 * (`pg_has_role … MEMBER`): a member MEMBER is an intentionally conservative
 * superset, including INHERIT FALSE and SET FALSE membership; every
 * forbidden-right rule uses it plus PUBLIC.
 *
 *   * role attributes: SUPERUSER, CREATEDB, CREATEROLE, BYPASSRLS, REPLICATION;
 *   * owns the database, any non-system schema, relation, function or type —
 *     and anything else of any class, here or cluster-wide (pg_shdepend:
 *     large objects, foreign-data wrappers and servers, tablespaces,
 *     publications, subscriptions, event triggers, languages, …) — and
 *     anything in a database the check cannot connect to;
 *   * membership in any role of runtime-dangerous-roles.sql (an owner of
 *     anything anywhere, a migrator, any service's runtime role, a role with
 *     an attribute above, a predefined role); a member of its own;
 *   * a stored setting that reaches its sessions, but TimeZone, statement_timeout
 *     and the disposable marker (runtime-settings.sql: the split resets the same);
 *   * lo_compat_privileges on (it switches every large object's ACL off);
 *   * a required runtime function (runtime-function-grants.txt) it cannot run;
 *   * every right of runtime-forbidden.sql — the rules the split revokes by:
 *     whatever the policy's runtime-allowlist.sql rows do not allow, on the
 *     database, every schema, relation (each partition), column, sequence,
 *     non-extension routine and default privilege, held directly, through
 *     PUBLIC or through any role of the closure; a grant option on anything;
 *     and a broken policy;
 *   * every right the policy allows on an object it names (or each object of
 *     a `schema.*` row), on the schema or the database, that the runtime role
 *     does NOT hold: the allowlist and the services' migrations say the same
 *     thing, or the check fails.
 *
 * `required` is the list to hold the role to (a test passes its own).
 */
export function findingsSql(required = requiredRuntimeFunctions) {
  // Each signature matched FUNCTION_GRANT_LINE: no quote but `"`.
  const functionRows =
    required.length === 0
      ? 'SELECT NULL::text AS service, NULL::text AS signature WHERE false'
      : `SELECT * FROM (VALUES ${required
          .map(([service, signature]) => `('${service}', '${signature}')`)
          .join(',\n')}) v(service, signature)`;
  return String.raw`${NO_JIT}
WITH me AS (
  SELECT oid, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication
    FROM pg_roles WHERE rolname = :'runtime'
),
reachable AS (${reachableSql}),
allowlist AS (${allowlistSql}),
runtime_functions AS (${functionRows}),
acl_entries AS (${aclEntriesSql}),
dangerous AS (${dangerousSql}),
stored_settings AS (${settingsSql}),
forbidden AS (${forbiddenSql}),
required_functions AS MATERIALIZED (
  SELECT signature FROM runtime_functions WHERE :'runtime' = 'rasta_' || service
),
-- What the policy allows on each object it names that exists, or each object
-- a schema.* row covers (never the ledger, never an extension relation). A row
-- naming no object is the allowlist test's to find: it holds each policy to
-- the services' migrations, row for row.
allowed_objects AS (
  SELECT a.class, a.object AS shown, priv, c.oid, c.relkind
    FROM allowlist a CROSS JOIN unnest(a.privileges) priv
    JOIN pg_class c ON c.oid = to_regclass(a.object)
   WHERE a.policy = :'policy' AND a.class IN ('relation', 'sequence') AND a.object NOT LIKE '%.*'
  UNION ALL
  SELECT a.class, n.nspname || '.' || c.relname, priv, c.oid, c.relkind
    FROM allowlist a CROSS JOIN unnest(a.privileges) priv
    JOIN pg_namespace n ON n.nspname = split_part(a.object, '.', 1)
    JOIN pg_class c ON c.relnamespace = n.oid
     AND CASE a.class WHEN 'sequence' THEN c.relkind = 'S'
                      ELSE c.relkind IN ('r', 'p', 'v', 'm', 'f') END
   WHERE a.policy = :'policy' AND a.class IN ('relation', 'sequence') AND a.object LIKE '%.*'
     AND c.relname <> '_prisma_migrations'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
                       AND d.objid = c.oid AND d.deptype = 'e')
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
                    ('CREATEROLE', rolcreaterole), ('BYPASSRLS', rolbypassrls),
                    ('REPLICATION', rolreplication)) v(a, held)
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
  -- Every class, every database (#540 r1 F1): pg_shdepend records each owner
  -- but the bootstrap superuser's (a superuser, reported above). Here and
  -- cluster-wide objects by name; another database's when the check visits it
  -- (runtime-foreign.sql), or here if it cannot.
  SELECT 'owns ' || pg_describe_object(s.classid, s.objid, s.objsubid)
         || CASE WHEN s.refobjid = me.oid THEN '' ELSE ', through ' || pg_get_userbyid(s.refobjid) END
    FROM pg_shdepend s JOIN reachable h ON h.oid = s.refobjid, me
   WHERE s.refclassid = 'pg_authid'::regclass AND s.deptype = 'o'
     AND (s.dbid = 0 OR s.dbid = (SELECT oid FROM pg_database WHERE datname = current_database()))
  UNION ALL
  SELECT 'owns or is granted something in database ' || d.datname
         || ', which accepts no connections and so cannot be checked'
    FROM pg_shdepend s JOIN reachable h ON h.oid = s.refobjid
    JOIN pg_database d ON d.oid = s.dbid
   WHERE s.refclassid = 'pg_authid'::regclass AND NOT d.datallowconn
  UNION ALL
  SELECT f.label FROM forbidden f WHERE f.held
  UNION ALL
  SELECT 'member of ' || m.rolname || ' (could SET ROLE to an owner or superuser-capable role)'
    FROM pg_roles m, me
   WHERE m.oid <> me.oid AND pg_has_role(me.oid, m.oid, 'MEMBER')
     AND m.oid IN (SELECT d.oid FROM dangerous d) AND m.rolname NOT LIKE 'pg\_%'
  UNION ALL
  -- Every predefined role (#540 r1 F1): reading every table or setting, the
  -- server's files, signalling other backends, …
  SELECT 'member of predefined role ' || r.rolname FROM pg_roles r
    JOIN reachable h ON h.oid = r.oid, me
   WHERE r.rolname LIKE 'pg\_%' AND r.oid <> me.oid
  UNION ALL
  -- A member reaches every grant the runtime role holds (#540 r1 F2).
  SELECT 'role ' || pg_get_userbyid(am.member) || ' is a member of the runtime role'
    FROM pg_auth_members am, me WHERE am.roleid = me.oid
  UNION ALL
  SELECT label FROM stored_settings
  UNION ALL
  SELECT 'lo_compat_privileges is on: no large object''s ACL is checked'
   WHERE current_setting('lo_compat_privileges') = 'on'
  UNION ALL
  SELECT 'missing required runtime EXECUTE on ' || f.signature FROM required_functions f, me
   WHERE to_regprocedure(f.signature) IS NULL
      OR NOT has_function_privilege(me.oid, to_regprocedure(f.signature), 'EXECUTE')
  UNION ALL
  -- CASE, not AND: a has_*_privilege only ever sees an object of its kind.
  SELECT format('allowed but not held: %s on %s%s (runtime-allowlist.sql and the migrations disagree)',
                o.priv, CASE o.class WHEN 'sequence' THEN 'sequence ' ELSE '' END, o.shown)
    FROM allowed_objects o, me
   WHERE NOT CASE
     WHEN o.class = 'sequence' THEN CASE WHEN o.relkind = 'S'
       THEN has_sequence_privilege(me.oid, o.oid, o.priv) ELSE false END
     ELSE CASE WHEN o.relkind <> 'S' THEN has_table_privilege(me.oid, o.oid, o.priv) ELSE false END
   END
  UNION ALL
  SELECT format('allowed but not held: %s on %s %s (runtime-allowlist.sql and the database disagree)',
                priv, a.class, a.object)
    FROM allowlist a CROSS JOIN unnest(a.privileges) priv, me
   WHERE a.policy IN (:'policy', '*') AND a.class IN ('database', 'schema', 'type')
     AND NOT CASE a.class
       WHEN 'database' THEN has_database_privilege(me.oid, current_database(), priv)
       -- A type as a relation: judged once it exists (its migration made it).
       WHEN 'type' THEN CASE WHEN to_regtype(a.object) IS NULL THEN true
                             ELSE has_type_privilege(me.oid, to_regtype(a.object), priv) END
       ELSE CASE WHEN to_regnamespace(a.object) IS NULL THEN false
                 ELSE has_schema_privilege(me.oid, to_regnamespace(a.object), priv) END
     END
  UNION ALL
  SELECT format('allowed but not held: %s on %s of %s in schema %s (runtime-allowlist.sql)',
                priv, a.class, :'runtime' || '_migrator', a.object)
    FROM allowlist a CROSS JOIN unnest(a.privileges) priv, me
   WHERE a.policy = :'policy' AND a.class IN ('default tables', 'default sequences')
     AND NOT EXISTS (
       SELECT 1 FROM pg_default_acl da CROSS JOIN LATERAL aclexplode(da.defaclacl) x
        WHERE da.defaclrole = to_regrole(:'runtime' || '_migrator')
          AND da.defaclnamespace = to_regnamespace(a.object)
          AND da.defaclobjtype = CASE a.class WHEN 'default tables' THEN 'r' ELSE 'S' END::"char"
          AND x.grantee = me.oid AND x.privilege_type = priv)
) f
ORDER BY finding;
`;
}

export const FINDINGS_SQL = findingsSql();

/**
 * One row per right another service's runtime role holds in the database psql
 * is connected to (#540 r1 F2): runtime-foreign.sql, the rules the split
 * revokes by — CONNECT, any ACL entry beyond the built-in privileges on any
 * object, through itself, PUBLIC or a role it is a member of; ownership of
 * anything here — less runtime-foreign-exceptions.sql. Feed to
 * `psql -v runtime=<this database's runtime role, or empty>`. The check runs it in every
 * database it can connect to: the whole (database, runtime role) matrix.
 */
export const FOREIGN_FINDINGS_SQL = String.raw`${NO_JIT}
WITH acl_entries AS (${aclEntriesSql}),
dangerous AS (${dangerousSql}),
foreign_exceptions AS (${foreignExceptionsSql}),
foreign_rights AS (${foreignSql})
SELECT DISTINCT label FROM foreign_rights WHERE held ORDER BY label;
`;

/**
 * Every database of the cluster as ONE JSON array of `{"name", "connectable"}`
 * records (#540 r2 R2-2): a name is a JSON string, so a newline or a `|` in
 * it is a character of the name — it can never forge a second row. Read with
 * parseDatabases.
 */
export const CONNECTABLE_DATABASES_SQL =
  "SELECT coalesce(jsonb_agg(jsonb_build_object('name', datname, 'connectable', datallowconn) ORDER BY datname), '[]') FROM pg_database;";

/** PostgreSQL's NAMEDATALEN - 1: no database name is longer, in bytes. */
const MAX_NAME_BYTES = 63;

/**
 * CONNECTABLE_DATABASES_SQL's output → `[{ name, connectable }]`, or a throw:
 * anything but an array of records with exactly a non-empty string `name` of
 * at most 63 bytes and no NUL, and a boolean `connectable`, each name once, is
 * refused rather than guessed at (#540 r2 R2-2). Every name PostgreSQL can
 * hold passes: psqlRows hands it to libpq as a quoted value, never as a
 * connection string.
 */
export function parseDatabases(text) {
  let records;
  try {
    records = JSON.parse(text);
  } catch {
    throw new Error('unreadable database list: not JSON');
  }
  if (!Array.isArray(records)) throw new Error('unreadable database list: not an array');
  const seen = new Set();
  return records.map((record) => {
    const keys = record !== null && typeof record === 'object' ? Object.keys(record).sort() : [];
    if (
      keys.join(',') !== 'connectable,name' ||
      typeof record.name !== 'string' ||
      typeof record.connectable !== 'boolean'
    ) {
      throw new Error(`unreadable database record: ${JSON.stringify(record)}`);
    }
    const { name } = record;
    if (name === '' || name.includes('\0') || Buffer.byteLength(name) > MAX_NAME_BYTES) {
      throw new Error(`unsupported database name: ${JSON.stringify(name)}`);
    }
    if (seen.has(name)) throw new Error(`database listed twice: ${JSON.stringify(name)}`);
    seen.add(name);
    return { name, connectable: record.connectable };
  });
}

/**
 * A database name for a report line: as it is when it is plain, else as a
 * JSON string — a newline in a name cannot write a line of its own (an `ok`
 * the check never gave).
 */
export function shownDatabase(name) {
  return /^[A-Za-z0-9_.-]+$/.test(name) ? name : JSON.stringify(name);
}

/**
 * libpq's `-d` takes a connection string when the value holds `=` or starts
 * `postgres://` / `postgresql://` — a database named `dbname=postgres` would
 * be connected to `postgres` (#540 r2 R2-2). So the name always goes in as
 * the quoted value of `dbname=` — `'` and `\` escaped — which libpq takes
 * literally and never expands again.
 */
export function databaseConnectionString(name) {
  return `dbname='${name.replace(/[\\']/g, (c) => `\\${c}`)}'`;
}

/**
 * Prepended to every query the check runs in a database: the session must be
 * in the database it asked for (psql variable `expected_database`), or the
 * query fails — whatever libpq, a service file or the environment did with
 * the name (#540 r2 R2-2).
 */
export const SAME_DATABASE_SQL = String.raw`SET rasta.expected_database = :'expected_database';
DO $$ BEGIN
  IF current_database() <> current_setting('rasta.expected_database') THEN
    RAISE EXCEPTION 'connected to database %, not the one asked for: %',
      quote_ident(current_database()), quote_ident(current_setting('rasta.expected_database'));
  END IF;
END $$;
`;

/**
 * Runs `sql` in `database` as psql on stdin (`variables` as `-v`), the name
 * passed literally and the connected database verified first; returns the
 * output's non-empty lines. A failure throws. `run` is spawnSync's shape (a
 * test passes its own).
 */
export function psqlRows(database, sql, variables = {}, run = spawnSync) {
  const result = run(
    'psql',
    [
      '-X',
      '-q',
      '-tA',
      '-v',
      'ON_ERROR_STOP=1',
      '-v',
      `expected_database=${database}`,
      ...Object.entries(variables).flatMap(([name, value]) => ['-v', `${name}=${value}`]),
      '-d',
      databaseConnectionString(database),
    ],
    { input: SAME_DATABASE_SQL + sql, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`${shownDatabase(database)}: the catalogue query failed\n${result.stderr}`);
  }
  return result.stdout.split('\n').filter(Boolean);
}

/**
 * The (database, own runtime role) visits that cover every (database, runtime
 * role) pair (#540 r1 F2): every database that accepts connections, with its
 * service's runtime role ('' where no service owns it) — FOREIGN_FINDINGS_SQL
 * judges all the others there. A database that accepts none cannot hold a
 * foreign right over a connection; a service database among them is still a
 * problem (it is not checked), and so is a service database that is missing.
 * `databases` are parseDatabases' records.
 */
export function matrix(entries, databases) {
  const owners = new Map(entries.map(({ database, runtime }) => [database, runtime]));
  const seen = new Set();
  const visits = [];
  for (const { name: database, connectable } of databases) {
    seen.add(database);
    if (connectable) visits.push({ database, runtime: owners.get(database) ?? '' });
    else if (owners.has(database)) {
      visits.push({ database, problem: 'accepts no connections, so it cannot be checked' });
    }
  }
  for (const database of owners.keys()) {
    if (!seen.has(database)) visits.push({ database, problem: 'does not exist' });
  }
  return visits;
}

/** The verdict for one database's foreign runtime roles, from FOREIGN_FINDINGS_SQL's rows. */
export function foreignVerdict(database, findings) {
  const shown = shownDatabase(database);
  if (findings.length === 0) {
    return { ok: true, line: `${shown}: no other service's runtime role holds anything` };
  }
  return {
    ok: false,
    line: `${shown}: another service's runtime role holds:\n${findings
      .map((f) => `    - ${f}`)
      .join('\n')}`,
  };
}

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
