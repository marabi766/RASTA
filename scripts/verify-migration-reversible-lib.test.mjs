import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { EXPECTED, assertionScript } from './verify-migration-reversible-lib.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The expectations `verify-migration-reversible.mjs` checks, tested as code.
 *
 * Two different things are proven here and they are worth keeping apart.
 *
 * `assertionScript` is a pure SQL builder, so it can be checked directly: that
 * every object kind produces a catalog lookup, that `present` really inverts
 * the test rather than only changing the wording, and that the two kinds added
 * for AUD-003 — indexes and enum types — look in the catalogs those objects
 * actually live in. A builder that emitted a `pg_tables` lookup for an index
 * would report "still present" forever and fail every rollback.
 *
 * The `EXPECTED` lists are checked against the migrations themselves. A name in
 * that map is a claim that some migration creates the object; a stale or
 * misspelled name would silently pass the up assertion's opposite — it can
 * never be present, so `down` succeeds vacuously — which is exactly the class
 * of failure this whole verifier exists to catch. So every name is required to
 * appear in the service's SQL, and the AUD-003 objects are additionally
 * required to be dropped by the migration that adds them.
 */

const SCHEMA = 'migration_check';

/** Every `migration.sql` a service ships, concatenated in application order. */
function migrationSql(service, file = 'migration.sql') {
  const dir = join(ROOT, 'services', `${service}-service`, 'prisma', 'migrations');
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => readFileSync(join(dir, name, file), 'utf8'))
    .join('\n');
}

const AUD_003 = '20260910120000_audit_chain_head';

function aud003(file) {
  return readFileSync(
    join(ROOT, 'services', 'audit-service', 'prisma', 'migrations', AUD_003, file),
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// assertionScript
// ---------------------------------------------------------------------------

const SAMPLE = {
  tables: ['t_one'],
  triggers: ['g_one'],
  constraints: ['c_one'],
  indexes: ['i_one'],
  types: ['y_one'],
  functions: ['f_one'],
};

/** How many object kinds `SAMPLE` names — one check each. */
const SAMPLE_KINDS = Object.keys(SAMPLE).length;

test('assertionScript looks each object kind up in the catalog it lives in', () => {
  const script = assertionScript(SAMPLE, true, SCHEMA);

  assert.match(script, /pg_tables\s+WHERE schemaname = 'migration_check' AND tablename = 't_one'/);
  assert.match(script, /pg_trigger t[\s\S]*t\.tgname = 'g_one'/);
  assert.match(script, /pg_constraint con[\s\S]*con\.conname = 'c_one'/);
  // Indexes are relations, not `pg_indexes` rows: an index on a partitioned
  // parent is `relkind = 'I'`, and `audit_event_chain_idx` is exactly that.
  assert.match(script, /pg_class c[\s\S]*c\.relname = 'i_one'[\s\S]*relkind IN \('i', 'I'\)/);
  assert.match(script, /pg_type t[\s\S]*t\.typname = 'y_one'/);
  // A trigger function is a `pg_proc` row and survives `DROP TRIGGER`, so it
  // has to be asked about by name or an orphan goes unnoticed until the second
  // `up` fails to create it.
  assert.match(script, /pg_proc p[\s\S]*p\.proname = 'f_one'/);

  // And every one of them is scoped to the throwaway schema, never to the
  // search path — a check that found the object in the real schema would
  // report a rollback as complete while the real one still stood.
  const lookups = script.match(/nspname = '[^']+'|schemaname = '[^']+'/g) ?? [];
  assert.equal(lookups.length, SAMPLE_KINDS);
  assert.ok(lookups.every((lookup) => lookup.endsWith(`'${SCHEMA}'`)));
});

test('assertionScript inverts the test, not merely the wording, for absence', () => {
  const present = assertionScript(SAMPLE, true, SCHEMA);
  const absent = assertionScript(SAMPLE, false, SCHEMA);

  assert.equal((present.match(/IF NOT EXISTS/g) ?? []).length, SAMPLE_KINDS);
  assert.equal((present.match(/is missing/g) ?? []).length, SAMPLE_KINDS);

  assert.equal((absent.match(/IF NOT EXISTS/g) ?? []).length, 0);
  assert.equal((absent.match(/IF EXISTS/g) ?? []).length, SAMPLE_KINDS);
  assert.equal((absent.match(/is still present/g) ?? []).length, SAMPLE_KINDS);
});

test('assertionScript stays silent about object kinds a service does not list', () => {
  // The four services that predate AUD-003 declare neither key, and adding the
  // two kinds must not make their scripts assert anything new.
  const script = assertionScript(
    { tables: ['t_one'], triggers: [], constraints: [] },
    true,
    SCHEMA,
  );

  assert.doesNotMatch(script, /pg_class/);
  assert.doesNotMatch(script, /pg_type/);
  assert.doesNotMatch(script, /pg_proc/);
  assert.match(script, /tablename = 't_one'/);
});

// ---------------------------------------------------------------------------
// The AUD-003 entry
// ---------------------------------------------------------------------------

test('the audit entry names every object AUD-003 adds', () => {
  const { tables, triggers, constraints, indexes, types, functions } = EXPECTED.audit;

  assert.ok(tables.includes('audit_chain_head'));
  assert.deepEqual(triggers.filter((name) => name.startsWith('audit_chain_head')).sort(), [
    'audit_chain_head_forward_only',
    'audit_chain_head_no_truncate',
  ]);
  assert.deepEqual(indexes.sort(), ['audit_chain_head_month_idx', 'audit_event_chain_idx']);
  assert.deepEqual(types, ['audit_chain_scope']);
  // Both trigger functions, not only AUD-003's: the AUD-001 one carries the
  // append-only refusal and is dropped by the same chain reversal, so leaving
  // it unasserted would let a rollback orphan it unnoticed.
  assert.deepEqual([...functions].sort(), ['refuse_chain_head_regression', 'refuse_mutation']);

  // The rules that make the head describe a chain something could actually
  // produce. Listed by name rather than by count so a future rename fails here
  // instead of quietly reducing what the rollback proves.
  for (const name of [
    'audit_chain_head_scope_shape',
    'audit_chain_head_month_is_first_day',
    'audit_chain_head_state',
    'audit_chain_head_segment_start_ordered',
    'audit_chain_head_single_record_segment',
    'audit_chain_head_hash_is_sha256',
  ]) {
    assert.ok(constraints.includes(name), `${name} is not asserted by the verifier`);
  }
});

test('every AUD-003 object the verifier asserts is created by the AUD-003 migration', () => {
  const sql = aud003('migration.sql');
  const added = [
    'audit_chain_head',
    'audit_chain_head_forward_only',
    'audit_chain_head_no_truncate',
    'audit_chain_head_month_idx',
    'audit_event_chain_idx',
    'audit_chain_scope',
    'refuse_chain_head_regression',
    'audit_chain_head_scope_shape',
    'audit_chain_head_month_is_first_day',
    'audit_chain_head_state',
    'audit_chain_head_segment_start_ordered',
    'audit_chain_head_single_record_segment',
    'audit_chain_head_hash_is_sha256',
  ];

  for (const name of added) {
    assert.match(
      sql,
      new RegExp(`(CREATE (TABLE|TYPE|INDEX|TRIGGER|FUNCTION)|CONSTRAINT) ${name}\\b`),
    );
  }
});

test('every AUD-003 object the verifier asserts is dropped by its down script', () => {
  const down = aud003('down.sql');

  // The CHECK constraints are columns of the table and go with it; the
  // triggers, the index, the enum and the table itself each need their own
  // statement, and a missing one is a `down` that leaves an object the second
  // `up` would then fail to create.
  for (const statement of [
    /DROP TRIGGER IF EXISTS audit_chain_head_no_truncate\b/,
    /DROP TRIGGER IF EXISTS audit_chain_head_forward_only\b/,
    /DROP INDEX IF EXISTS audit_chain_head_month_idx\b/,
    /DROP TABLE IF EXISTS audit_chain_head\b/,
    /DROP FUNCTION IF EXISTS refuse_chain_head_regression\(\)/,
    /DROP TYPE IF EXISTS audit_chain_scope\b/,
    /DROP INDEX IF EXISTS audit_event_chain_idx\b/,
  ]) {
    assert.match(down, statement);
  }

  // And the row that makes the forward migration re-appliable. Without it an
  // up → down → up cycle ends without the head table it is meant to restore,
  // and the verifier's second `up` would apply nothing.
  assert.match(down, /DELETE FROM "_prisma_migrations"[\s\S]*20260910120000_audit_chain_head/);
});

// ---------------------------------------------------------------------------
// Every service's list, against its own migrations
// ---------------------------------------------------------------------------

test('no expected object names an object no migration creates', () => {
  for (const [service, expected] of Object.entries(EXPECTED)) {
    const sql = migrationSql(service);
    const names = [
      ...expected.tables,
      ...expected.triggers,
      ...expected.constraints,
      ...(expected.indexes ?? []),
      ...(expected.types ?? []),
      ...(expected.functions ?? []),
    ];

    for (const name of names) {
      assert.ok(
        sql.includes(name),
        `${service}-service: "${name}" is asserted by the verifier but appears in no migration`,
      );
    }
  }
});
