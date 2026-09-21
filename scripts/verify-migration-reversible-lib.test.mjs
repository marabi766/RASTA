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
  enumValues: [['y_one', 'V_ONE']],
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
  // A value inside an enum. The type-name check above passes whatever the
  // labels are, so a down script that rebuilt `notification_channel` and put
  // `EMAIL` back would look like a clean rollback.
  assert.match(script, /pg_enum e[\s\S]*e\.enumlabel = 'V_ONE'/);

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

test('assertionScript asks about an enum value in the type it belongs to', () => {
  // Two different enums may legally carry the same label, so the check has to
  // name both — otherwise removing `EMAIL` from one type would be reported as
  // done while it still stood in the other.
  const script = assertionScript(
    { tables: [], triggers: [], constraints: [], enumValues: [['a_type', 'SHARED']] },
    false,
    SCHEMA,
  );

  assert.match(script, /t\.typname = 'a_type'[\s\S]*e\.enumlabel = 'SHARED'/);
  assert.match(script, /enum value %\.% is still present/);
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
  assert.doesNotMatch(script, /pg_enum/);
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
  assert.deepEqual(indexes.toSorted(), [
    'audit_chain_head_month_idx',
    'audit_event_chain_idx',
    // The correction half, added by 20260912120000_audit_event_correction_index.
    'audit_event_correction_idx',
  ]);
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

// ---------------------------------------------------------------------------
// notification-service — NTF-001's initial migration
// ---------------------------------------------------------------------------

const NTF_001 = '20260917090000_init_notification';

function ntf001(file) {
  return readFileSync(
    join(ROOT, 'services', 'notification-service', 'prisma', 'migrations', NTF_001, file),
    'utf8',
  );
}

test('the notification dedupe foreign key is deferred, and the verifier names it', () => {
  // The consumer decides "fresh window or repeat" in one statement that names
  // the intent it is about to write. Only a deferred check lets that statement
  // precede the row; an immediate one would refuse every ingest. Asserted on
  // the SQL because a table-only check could not tell the two apart.
  const up = ntf001('migration.sql');
  assert.match(
    up,
    /ADD CONSTRAINT "notification_dedupe_intent_id_fkey"[\s\S]*?DEFERRABLE INITIALLY DEFERRED/,
  );
  assert.ok(EXPECTED.notification.constraints.includes('notification_dedupe_intent_id_fkey'));
});

test('every notification object the verifier asserts is created by a notification migration and dropped by its down script', () => {
  // Every migration's SQL, concatenated: NTF-001's tables and enums, and the
  // trigger pairs NTF-001 and NTF-002 each add.
  const up = migrationSql('notification');
  const down = migrationSql('notification', 'down.sql');
  const { tables, triggers, functions, types } = EXPECTED.notification;

  for (const name of [...tables, ...types]) {
    assert.ok(up.includes(`"${name}"`), `${name} is not created by ${NTF_001}`);
    assert.match(
      down,
      new RegExp(`DROP (TABLE|TYPE) IF EXISTS "${name}"`),
      `${name} is not dropped by down.sql`,
    );
  }
  for (const name of triggers) {
    assert.match(down, new RegExp(`DROP TRIGGER IF EXISTS "${name}"`));
  }
  for (const name of functions) {
    assert.match(up, new RegExp(`CREATE OR REPLACE FUNCTION ${name}\(\)`));
    assert.match(down, new RegExp(`DROP FUNCTION IF EXISTS ${name}\(\)`));
  }
  // NTF-004 widened an existing enum instead of creating a type, which the
  // loop above cannot see: `notification_channel` is created by NTF-001 and
  // dropped by its down script whether or not `EMAIL` was ever added to it.
  for (const [type, value] of EXPECTED.notification.enumValues) {
    assert.match(up, new RegExp(`ALTER TYPE "${type}" ADD VALUE IF NOT EXISTS '${value}'`));
    // PostgreSQL cannot drop an enum value, so the only honest reversal is a
    // rebuild — and a rebuild that forgot to move a column would leave the
    // schema unusable rather than merely un-reversed.
    assert.match(down, new RegExp(`ALTER TYPE "${type}" RENAME TO`));
    assert.match(down, new RegExp(`CREATE TYPE "${type}" AS ENUM`));
  }

  assert.match(
    down,
    new RegExp(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${NTF_001}'`),
  );
  // NTF-002's migration is a trigger pair and nothing else, so an inventory
  // that did not name both would make that whole migration invisible to the
  // up → down → up proof.
  assert.ok(EXPECTED.notification.triggers.includes('in_app_notification_state_write_once'));
  assert.ok(EXPECTED.notification.functions.includes('refuse_in_app_state_regression'));
  assert.match(
    down,
    /DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260917150000_in_app_read_state_write_once'/,
  );
});

/**
 * This assertion used to say the opposite, and the change is the point.
 *
 * notification-service had no outbox because it consumed events and published
 * none. `NTF-002`'s audit events gave it one, which put it in front of
 * `verify-outbox-claim-migration.mjs`'s discovery guard — a guard whose whole
 * job is to refuse a service that owns an outbox and is checked by nothing. It
 * did exactly that, in CI, on the first push of this change.
 *
 * The outbox arrived in a migration of its own rather than under the shared
 * names that verifier addresses, so it is accounted for the way supplier's is:
 * named in `FOLDED_INITIAL_MIGRATION` with the gate that does check it, and
 * listed in `EXPECTED.notification` so that gate really does.
 */
test('the notification outbox is verified by this gate, since the claim verifier defers to it', () => {
  const schema = readFileSync(
    join(ROOT, 'services', 'notification-service', 'prisma', 'schema.prisma'),
    'utf8',
  );
  assert.match(schema, /model\s+OutboxMessage\b/);

  // The two tables, so a down script that forgot them fails the round trip.
  assert.ok(EXPECTED.notification.tables.includes('outbox_message'));
  assert.ok(EXPECTED.notification.tables.includes('outbox_stream_sequence'));

  // The same five claim constraints supplier is checked against. Listing the
  // tables alone would pass a table check while leaving an outbox that
  // enforces nothing.
  for (const constraint of [
    'ck_outbox_claim_triple',
    'ck_outbox_claim_count_nonneg',
    'ck_outbox_attempts_nonneg',
    'ck_outbox_published_is_clean',
    'ck_outbox_next_attempt_requires_failure',
  ]) {
    assert.ok(
      EXPECTED.notification.constraints.includes(constraint),
      `EXPECTED.notification must check ${constraint}`,
    );
  }
});

// ---------------------------------------------------------------------------
// The AUD-003 correction index
// ---------------------------------------------------------------------------
//
// `20260912120000_audit_event_correction_index` adds one index and nothing
// else, which is precisely the shape this harness was blind to. An index the
// `EXPECTED` map does not name is an index the up assertion never looks for,
// the down assertion never misses, and the second `up` never has to restore —
// so a `down.sql` that drops the index but leaves its `_prisma_migrations` row
// behind produces a green run over a schema that is missing the index for good.
// Both halves are asserted here: the name is in the inventory, and the down
// script removes its own ledger row.

const CORRECTION_INDEX_MIGRATION = '20260912120000_audit_event_correction_index';

function auditMigration(name, file) {
  return readFileSync(
    join(ROOT, 'services', 'audit-service', 'prisma', 'migrations', name, file),
    'utf8',
  );
}

test('the audit entry names the correction index AUD-003 adds', () => {
  assert.ok(
    EXPECTED.audit.indexes.includes('audit_event_correction_idx'),
    'audit_event_correction_idx is not asserted by the verifier, so the reversibility ' +
      'gate cannot notice it going missing',
  );
});

test('the correction index migration creates the index the verifier asserts', () => {
  assert.match(
    auditMigration(CORRECTION_INDEX_MIGRATION, 'migration.sql'),
    /CREATE INDEX audit_event_correction_idx\b/,
  );
});

test('the correction index down script drops the index and its own ledger row', () => {
  const down = auditMigration(CORRECTION_INDEX_MIGRATION, 'down.sql');

  assert.match(down, /DROP INDEX IF EXISTS audit_event_correction_idx\b/);
  assert.match(
    down,
    new RegExp(`DELETE FROM "_prisma_migrations"[\\s\\S]*${CORRECTION_INDEX_MIGRATION}`),
    'the down script leaves its _prisma_migrations row behind, so `migrate deploy` ' +
      'considers the migration applied and the second `up` restores nothing',
  );
});

test('every audit migration reverses its own ledger row, and only its own', () => {
  const dir = join(ROOT, 'services', 'audit-service', 'prisma', 'migrations');
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.ok(names.length > 0);

  for (const name of names) {
    const down = auditMigration(name, 'down.sql');
    const deleted = [...down.matchAll(/"migration_name"\s*=\s*'([^']+)'/g)].map((m) => m[1]);

    assert.deepEqual(
      deleted,
      [name],
      `${name}/down.sql must delete exactly its own _prisma_migrations row`,
    );
  }
});
