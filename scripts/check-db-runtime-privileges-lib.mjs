// -----------------------------------------------------------------------------
// What a service's runtime database role may not hold (D-045), and the
// catalogue query that finds it if it does. scripts/check-db-runtime-privileges.mjs
// runs the query against every service database; this module is the part
// tests can execute without a cluster, plus the query itself so the live test
// (check-db-runtime-privileges.pg.test.mjs) runs exactly what CI runs.
// -----------------------------------------------------------------------------
import { servicesFromLibrary, splitServicesFromLibrary } from './infra-preflight-lib.mjs';

/**
 * Services whose runtime role still owns its database and tables, each to be
 * split in its own PR (D-045, issue #150). The check expects these to FAIL and
 * fails CI when one of them passes — a stale entry would hide a regression —
 * so this list only ever shrinks, until it is empty and D-045 is resolved.
 */
export const PENDING_SPLIT = Object.freeze([
  'identity',
  'organization',
  'asset',
  'fleet',
  'maintenance',
  'marketplace',
  'procurement',
  'inventory',
  'contract',
  'economic',
  'notification',
  'document',
  'analytics',
]);

/**
 * Every service's place in the split: `split` (lib/service-privilege-split.bash),
 * `audit` (its own schema, and its database since D-045) or `pending`. Throws
 * when a service is in no list or in two — a new service has to be placed.
 */
export function classifyServices({
  services = servicesFromLibrary(),
  split = splitServicesFromLibrary(),
  pending = PENDING_SPLIT,
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
  for (const service of pending) place(service, 'pending');
  for (const service of placed.keys()) {
    if (!services.includes(service)) throw new Error(`${service} is not in RASTA_SERVICES`);
  }
  const unplaced = services.filter((service) => !placed.has(service));
  if (unplaced.length > 0) {
    throw new Error(
      `${unplaced.join(', ')}: in RASTA_SERVICES but neither split nor pending (D-045)`,
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
 * counts through membership (`pg_has_role … USAGE`): a role that inherits the
 * owner's rights is the owner for every purpose here.
 *
 *   * role attributes: SUPERUSER, CREATEDB, CREATEROLE, BYPASSRLS;
 *   * owns the database, any non-system schema, relation, function or type;
 *   * CREATE on the database or on any non-system schema;
 *   * TRUNCATE, REFERENCES or TRIGGER on any table;
 *   * any right on the migration ledger `_prisma_migrations`.
 */
export const FINDINGS_SQL = String.raw`
WITH me AS (
  SELECT oid, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
    FROM pg_roles WHERE rolname = :'runtime'
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
   WHERE d.datname = current_database() AND pg_has_role(me.oid, d.datdba, 'USAGE')
  UNION ALL
  SELECT 'CREATE on database ' || current_database() FROM me
   WHERE has_database_privilege(me.oid, current_database(), 'CREATE')
  UNION ALL
  SELECT 'owns schema ' || n.nspname FROM user_ns n, me
   WHERE pg_has_role(me.oid, n.nspowner, 'USAGE')
  UNION ALL
  SELECT 'CREATE on schema ' || n.nspname FROM user_ns n, me
   WHERE has_schema_privilege(me.oid, n.oid, 'CREATE')
  UNION ALL
  SELECT 'owns ' || CASE t.relkind WHEN 'S' THEN 'sequence' WHEN 'i' THEN 'index'
                       WHEN 'I' THEN 'index' WHEN 'v' THEN 'view'
                       WHEN 'm' THEN 'materialized view' ELSE 'table' END
         || ' ' || t.nspname || '.' || t.relname
    FROM user_tables t, me WHERE pg_has_role(me.oid, t.relowner, 'USAGE')
  UNION ALL
  SELECT 'owns function ' || p.oid::regprocedure::text FROM pg_proc p
    JOIN user_ns n ON n.oid = p.pronamespace, me
   WHERE pg_has_role(me.oid, p.proowner, 'USAGE')
  UNION ALL
  SELECT 'owns type ' || n.nspname || '.' || ty.typname FROM pg_type ty
    JOIN user_ns n ON n.oid = ty.typnamespace, me
   WHERE ty.typrelid = 0 AND ty.typelem = 0 AND pg_has_role(me.oid, ty.typowner, 'USAGE')
  UNION ALL
  SELECT priv || ' on ' || t.nspname || '.' || t.relname
    FROM user_tables t, me, unnest(ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER']) priv
   WHERE t.relkind IN ('r', 'p') AND has_table_privilege(me.oid, t.oid, priv)
  UNION ALL
  SELECT 'a right on ' || t.nspname || '._prisma_migrations' FROM user_tables t, me
   WHERE t.relname = '_prisma_migrations'
     AND has_table_privilege(me.oid, t.oid, 'SELECT, INSERT, UPDATE, DELETE')
) f
ORDER BY finding;
`;

/**
 * The verdict for one service, from its findings.
 *
 *   split / audit  — must hold nothing: any finding fails.
 *   pending        — expected to own its database; if it holds nothing it was
 *                    split without being moved off PENDING_SPLIT, and that
 *                    stale entry fails too.
 */
export function verdict({ service, kind }, findings) {
  if (kind === 'pending') {
    return findings.length > 0
      ? { ok: true, line: `${service}: pending (D-045) — runtime role still owns its database` }
      : {
          ok: false,
          line:
            `${service}: holds nothing a runtime role may not, but is still on PENDING_SPLIT — ` +
            'move it to PRIVILEGE_SPLIT_SERVICES',
        };
  }
  if (findings.length === 0) return { ok: true, line: `${service}: runtime role owns nothing` };
  return {
    ok: false,
    line: `${service}: the runtime role ${findings.length === 1 ? 'holds' : 'holds each of'}:\n${findings
      .map((f) => `    - ${f}`)
      .join('\n')}`,
  };
}
