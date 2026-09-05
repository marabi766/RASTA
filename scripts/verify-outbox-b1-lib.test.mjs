import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertB1Definitions,
  assertB1Inert,
  assertB1Objects,
  B1_INDEXDEFS,
  B1_INDEXES,
  B1_OUTBOX_COLUMNS,
  B1_SEQUENCE_COLUMNS,
  B1_SEQUENCE_PRIMARY_KEY,
  B1_SEQUENCE_TABLE,
} from './verify-outbox-b1-lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * The three B1 migrations, read from one service. They are byte-identical
 * across all eight — the outbox schema is the same everywhere — and a test
 * further down asserts that, so reading one here is not a sampling shortcut.
 */
const MIGRATIONS = [
  '20260905090000_outbox_stream_sequence',
  '20260905090100_outbox_stream_seq_columns',
  '20260905090200_outbox_stream_head_indexes',
];

const SERVICES = [
  'identity',
  'organization',
  'asset',
  'fleet',
  'maintenance',
  'economic',
  'marketplace',
  'document',
];

const migrationPath = (service, name, file) =>
  path.join(root, 'services', `${service}-service`, 'prisma', 'migrations', name, file);

const read = (service, name, file) => readFile(migrationPath(service, name, file), 'utf8');

// ---------------------------------------------------------------------------
// The assertions describe what the migrations actually create.
//
// These are the tests that would catch the constants drifting away from the
// SQL. Without them the verifier could pass against a schema nobody meant to
// ship, because it would be checking its own stale expectations.
// ---------------------------------------------------------------------------

test('every object the assertions expect is one the migrations create', async () => {
  const sql = (await Promise.all(MIGRATIONS.map((m) => read('document', m, 'migration.sql')))).join(
    '\n',
  );

  assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS "${B1_SEQUENCE_TABLE}"`));

  for (const [column] of B1_SEQUENCE_COLUMNS) {
    assert.match(sql, new RegExp(`"${column}"`), `${B1_SEQUENCE_TABLE}.${column} is not created`);
  }
  for (const [column] of B1_OUTBOX_COLUMNS) {
    assert.match(
      sql,
      new RegExp(`ADD COLUMN IF NOT EXISTS "${column}"`),
      `outbox_message.${column} is not added`,
    );
  }
  for (const index of B1_INDEXES) {
    assert.match(sql, new RegExp(`INDEX IF NOT EXISTS "${index}"`), `${index} is not created`);
  }
});

test('every object the migrations create is one the down migrations remove', async () => {
  const down = (await Promise.all(MIGRATIONS.map((m) => read('document', m, 'down.sql')))).join(
    '\n',
  );

  assert.match(down, new RegExp(`DROP TABLE IF EXISTS "${B1_SEQUENCE_TABLE}"`));
  for (const [column] of B1_OUTBOX_COLUMNS) {
    assert.match(
      down,
      new RegExp(`DROP COLUMN IF EXISTS "${column}"`),
      `outbox_message.${column} is never dropped — the migration is not reversible`,
    );
  }
  for (const index of B1_INDEXES) {
    assert.match(down, new RegExp(`DROP INDEX IF EXISTS "${index}"`), `${index} is never dropped`);
  }
});

test('each down migration removes its own _prisma_migrations row', async () => {
  // Prisma refuses to re-apply a migration whose ledger row survives, so a
  // rollback that leaves one behind can never be rolled forward again — the
  // failure mode is a database stuck half-reversed.
  for (const name of MIGRATIONS) {
    const down = await read('document', name, 'down.sql');
    assert.match(
      down,
      new RegExp(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${name}'`),
      `${name}/down.sql does not clear its ledger row`,
    );
  }
});

test('every B1 migration file sets a lock timeout and avoids CONCURRENTLY', async () => {
  for (const service of SERVICES) {
    for (const name of MIGRATIONS) {
      for (const file of ['migration.sql', 'down.sql']) {
        const sql = await read(service, name, file);
        assert.match(
          sql,
          /SET LOCAL lock_timeout = '3s';/,
          `${service}/${name}/${file} does not bound how long it waits for a lock`,
        );
        // Prisma wraps each migration file in a transaction, and
        // CREATE INDEX CONCURRENTLY cannot run inside one (SQLSTATE 25001).
        assert.doesNotMatch(
          sql,
          /CONCURRENTLY/,
          `${service}/${name}/${file} uses CONCURRENTLY, which Prisma cannot run`,
        );
      }
    }
  }
});

test('all eight services carry byte-identical B1 migrations', async () => {
  for (const name of MIGRATIONS) {
    for (const file of ['migration.sql', 'down.sql']) {
      const reference = await read(SERVICES[0], name, file);
      for (const service of SERVICES.slice(1)) {
        assert.equal(
          await read(service, name, file),
          reference,
          `${service}/${name}/${file} differs from ${SERVICES[0]} — the outbox schema must not fork`,
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// The generated SQL asserts the properties that actually matter.
//
// Each of these encodes a specific way B1 could be wrong while still passing a
// name-only existence check.
// ---------------------------------------------------------------------------

test('stream_seq is asserted nullable, so the B2 backfill window stays valid', () => {
  const [, type, nullable, def] = B1_OUTBOX_COLUMNS.find(([c]) => c === 'stream_seq');
  assert.equal(type, 'bigint');
  assert.equal(nullable, 'YES', 'a NOT NULL stream_seq would force a backfill into B1');
  assert.equal(def, null, 'stream_seq must not default — an unsequenced row is genuinely unset');

  const sql = assertB1Definitions();
  assert.match(sql, /outbox_message\.stream_seq is_nullable is %, expected YES/);
});

test('is_stream_head is asserted to default false, which is what makes B1 inert', () => {
  const [, type, nullable, def] = B1_OUTBOX_COLUMNS.find(([c]) => c === 'is_stream_head');
  assert.equal(type, 'boolean');
  assert.equal(nullable, 'NO');
  assert.equal(def, 'false');

  assert.match(
    assertB1Definitions(),
    /outbox_message\.is_stream_head default is %, expected false/,
  );
});

test('the unique index is asserted with its partial predicate, not just its name', () => {
  // Without WHERE stream_seq IS NOT NULL the index is a full unique index over
  // (topic, partition_key, stream_seq) — which rejects the second row whose
  // stream_seq is still NULL. Every service would stop writing events.
  assert.match(B1_INDEXDEFS.ux_outbox_stream_seq, /WHERE \(stream_seq IS NOT NULL\)$/);
  assert.match(B1_INDEXDEFS.ux_outbox_stream_seq, /^CREATE UNIQUE INDEX/);
  assert.match(assertB1Definitions(), /ux_outbox_stream_seq has the wrong definition/);
});

test('each head index is its ADR-050 counterpart narrowed by is_stream_head', () => {
  const pairs = [
    ['ix_outbox_head_fresh', '(created_at, id)'],
    ['ix_outbox_head_lease', '(claim_expires_at, created_at, id)'],
    ['ix_outbox_head_retry', '(next_attempt_at, created_at, id)'],
    ['ix_outbox_head_both', '(GREATEST(claim_expires_at, next_attempt_at), created_at, id)'],
  ];

  for (const [name, keys] of pairs) {
    const def = B1_INDEXDEFS[name];
    assert.ok(def, `${name} has no expected definition`);
    assert.ok(
      def.includes(`USING btree ${keys}`),
      `${name} must keep the ADR-050 key order ${keys} so B4 keeps the same plan shape`,
    );
    assert.ok(
      def.endsWith('AND is_stream_head)'),
      `${name} must be narrowed by is_stream_head — otherwise it duplicates ix_outbox_due_*`,
    );
  }
});

test('the counter table primary key is the stream identity itself', () => {
  assert.equal(B1_SEQUENCE_PRIMARY_KEY, 'topic,partition_key');
  // Not the aggregate id: ADR-036 deliberately puts several aggregates on one
  // partition key, so an aggregate-keyed counter would miss those streams.
  assert.doesNotMatch(B1_SEQUENCE_PRIMARY_KEY, /aggregate/);
  assert.match(assertB1Definitions(), /primary key is %, expected topic,partition_key/);
});

test('presence and absence are asserted against the same object list', () => {
  const present = assertB1Objects(true);
  const absent = assertB1Objects(false);

  for (const index of B1_INDEXES) {
    assert.ok(present.includes(`'${index}'`), `${index} is not checked on up`);
    assert.ok(absent.includes(`'${index}'`), `${index} is not checked on down`);
  }
  assert.match(present, new RegExp(`found % of ${B1_INDEXES.length}`));
  assert.match(present, /<> 1 THEN/, 'the sequence table must be required to exist on up');
  assert.match(absent, /<> 0 THEN/, 'the sequence table must be required to be gone on down');
});

test('inertness is asserted on data, not inferred from the migration text', () => {
  const sql = assertB1Inert();
  assert.match(sql, /WHERE "is_stream_head"/, 'no check that B1 set no head');
  assert.match(sql, /WHERE "stream_seq" IS NOT NULL/, 'no check that B1 allocated no sequence');
  assert.match(
    sql,
    new RegExp(`count\\(\\*\\) INTO n FROM "${B1_SEQUENCE_TABLE}"`),
    'no check that B1 wrote no counter row',
  );
});

test('B1 introduces no runtime behaviour: the migrations only add schema', async () => {
  // The phase boundary, enforced. B1 creates objects; it must not write data,
  // change a claim query, or touch anything B2-B6 owns.
  for (const service of SERVICES) {
    for (const name of MIGRATIONS) {
      const sql = await read(service, name, 'migration.sql');
      const statements = sql
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n');

      for (const forbidden of [
        /\bUPDATE\s+"?outbox_message/i,
        /\bINSERT\s+INTO/i,
        /\bDELETE\s+FROM/i,
      ]) {
        assert.doesNotMatch(
          statements,
          forbidden,
          `${service}/${name} writes data — B1 must be additive schema only`,
        );
      }
    }
  }
});
