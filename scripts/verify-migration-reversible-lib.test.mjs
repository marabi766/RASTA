import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED,
  assertionScript,
  assertSnapshotScript,
  createScratchDatabase,
  dropScratchDatabase,
  ledgerAssertionScript,
  libpqInvocation,
  libpqUrl,
  newScratchDatabase,
  psqlRunner,
  recordSnapshotScript,
  scratchDatabaseSql,
  snapshotQuery,
  snapshotStoreScript,
  sqlstateFrom,
  staleScratchDatabases,
  verifierConnection,
  verifierRoleProblem,
} from './verify-migration-reversible-lib.mjs';

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
    // The tender-evidence projection, added by 20261001110000_tender_evidence.
    'ix_bid_access_evidence_tender',
    // D-046's evidence, added by 20261003120000_payment_reconciliation_evidence.
    'ix_payment_reconciliation_evidence_intent',
    // The held receipts, added by 20261001130000_tender_receipt_pending.
    'ix_tender_receipt_pending_held',
    'ux_payment_reconciliation_evidence_audit_event',
    'ux_tender_receipt_link_event',
    'ux_tender_receipt_link_previous',
    'ux_tender_receipt_link_receipt',
    'ux_tender_receipt_pending_previous',
    'ux_tender_receipt_pending_receipt',
  ]);
  assert.deepEqual(types, ['audit_chain_scope']);
  // Both trigger functions, not only AUD-003's: the AUD-001 one carries the
  // append-only refusal and is dropped by the same chain reversal, so leaving
  // it unasserted would let a rollback orphan it unnoticed.
  assert.deepEqual([...functions].sort(), [
    'payment_reconciliation_evidence_append_only',
    'refuse_chain_head_regression',
    'refuse_mutation',
    'tender_evidence_append_only',
  ]);

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
    assert.match(up, new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\(\\)`));
    assert.match(down, new RegExp(`DROP FUNCTION IF EXISTS ${name}\\(\\)`));
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

// ---------------------------------------------------------------------------
// Platform-wide: every migration is reversible, and every service is verified
// ---------------------------------------------------------------------------

/** Every service directory that ships Prisma migrations. */
function servicesWithMigrations() {
  return readdirSync(join(ROOT, 'services'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((dir) => {
      try {
        return readdirSync(join(ROOT, 'services', dir, 'prisma', 'migrations')).length > 0;
      } catch {
        return false;
      }
    })
    .map((dir) => dir.replace(/-service$/, ''))
    .sort();
}

function migrationNames(service) {
  const dir = join(ROOT, 'services', `${service}-service`, 'prisma', 'migrations');
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

test('every migration of every service has a down.sql', () => {
  // The six initial migrations that had none put five whole services beyond
  // the reversibility gate; this keeps a seventh from joining them silently.
  const missing = servicesWithMigrations().flatMap((service) =>
    migrationNames(service)
      .filter((name) => {
        try {
          readFileSync(
            join(ROOT, 'services', `${service}-service`, 'prisma', 'migrations', name, 'down.sql'),
          );
          return false;
        } catch {
          return true;
        }
      })
      .map((name) => `${service}/${name}`),
  );
  assert.deepEqual(missing, []);
});

/** SQL with its comments removed, so a commented-out statement never counts. */
function withoutComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

/**
 * The names a script deletes from the ledger — only real `DELETE FROM
 * "_prisma_migrations" WHERE "migration_name" = '…'` statements, one or two
 * lines, outside comments.
 */
function ledgerDeletes(sql) {
  return [
    ...withoutComments(sql).matchAll(
      /^\s*DELETE\s+FROM\s+"_prisma_migrations"\s+WHERE\s+"migration_name"\s*=\s*'([^']+)'\s*;/gim,
    ),
  ].map((m) => m[1]);
}

test('every down.sql of every service deletes exactly its own ledger row', () => {
  // supplier's blank-text hardening was the one that did not: after a
  // whole-chain rollback its row survived, `migrate deploy` skipped it, and
  // the weaker predicates came back under the same names.
  //
  // A DELETE, not merely the name next to a `migration_name` predicate (Codex
  // post-merge review of #105, finding 4): an UPDATE that marks the row rolled
  // back, or a SELECT, names it just as well and removes nothing.
  for (const service of servicesWithMigrations()) {
    for (const name of migrationNames(service)) {
      const down = readFileSync(
        join(ROOT, 'services', `${service}-service`, 'prisma', 'migrations', name, 'down.sql'),
        'utf8',
      );
      assert.deepEqual(ledgerDeletes(down), [name], `${service}/${name}/down.sql`);
      const named = [...withoutComments(down).matchAll(/"migration_name"\s*=\s*'([^']+)'/g)];
      assert.equal(
        named.length,
        1,
        `${service}/${name}/down.sql touches the ledger other than by its one DELETE`,
      );
    }
  }
});

test('the ledger-delete matcher accepts only a real DELETE of the row', () => {
  const row = `"_prisma_migrations" WHERE "migration_name" = '20260101000000_a';`;
  assert.deepEqual(ledgerDeletes(`DELETE FROM ${row}`), ['20260101000000_a']);
  assert.deepEqual(
    ledgerDeletes(
      `DELETE FROM "_prisma_migrations"\n WHERE "migration_name" = '20260101000000_a';`,
    ),
    ['20260101000000_a'],
  );
  assert.deepEqual(
    ledgerDeletes(
      `UPDATE "_prisma_migrations" SET rolled_back_at = now() WHERE "migration_name" = '20260101000000_a';`,
    ),
    [],
  );
  assert.deepEqual(ledgerDeletes(`SELECT 1 FROM ${row}`), []);
  assert.deepEqual(ledgerDeletes(`-- DELETE FROM ${row}`), []);
  assert.deepEqual(ledgerDeletes(`/* DELETE FROM ${row} */`), []);
});

// ---------------------------------------------------------------------------
// Extensions (Codex post-merge review of #105, finding 3)
// ---------------------------------------------------------------------------

/** Extension names a script creates, and names it drops, outside comments. */
function extensionStatements(sql) {
  const text = withoutComments(sql);
  const names = (pattern) => [...text.matchAll(pattern)].map((m) => m[1].replaceAll('"', ''));
  return {
    created: names(/CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[a-z0-9_]+"?)/gi),
    dropped: names(/DROP\s+EXTENSION\s+(?:IF\s+EXISTS\s+)?("?[a-z0-9_]+"?)/gi),
  };
}

test('an extension a migration creates is dropped by its down.sql or kept by a named allowance', () => {
  for (const service of servicesWithMigrations()) {
    const kept = EXPECTED[service].keptExtensions ?? {};
    for (const name of migrationNames(service)) {
      const dir = join(ROOT, 'services', `${service}-service`, 'prisma', 'migrations', name);
      const up = extensionStatements(readFileSync(join(dir, 'migration.sql'), 'utf8'));
      const down = extensionStatements(readFileSync(join(dir, 'down.sql'), 'utf8'));
      for (const extension of up.created) {
        assert.ok(
          down.dropped.includes(extension) || (kept[name] ?? []).includes(extension),
          `${service}/${name} creates ${extension}; its down.sql must drop it, or ` +
            `EXPECTED.${service}.keptExtensions must name it for this migration`,
        );
      }
    }
  }
});

test('every kept-extension allowance is for an extension its migration creates and its down keeps', () => {
  // The allowance cannot be required to match at run time — whether
  // `IF NOT EXISTS` created anything depends on the cluster — so it is pinned
  // here: it may not outlive the statement that justifies it.
  for (const [service, entry] of Object.entries(EXPECTED)) {
    for (const [name, extensions] of Object.entries(entry.keptExtensions ?? {})) {
      const dir = join(ROOT, 'services', `${service}-service`, 'prisma', 'migrations', name);
      const up = extensionStatements(readFileSync(join(dir, 'migration.sql'), 'utf8'));
      const down = extensionStatements(readFileSync(join(dir, 'down.sql'), 'utf8'));
      for (const extension of extensions) {
        assert.ok(
          up.created.includes(extension),
          `${service}/${name} does not create ${extension}`,
        );
        assert.ok(
          !down.dropped.includes(extension),
          `${service}/${name} drops ${extension} after all`,
        );
      }
    }
  }
});

test('the only kept-extension allowances are marketplace pg_trgm and organization btree_gist', () => {
  const allowances = Object.entries(EXPECTED).flatMap(([service, entry]) =>
    Object.entries(entry.keptExtensions ?? {}).flatMap(([name, extensions]) =>
      extensions.map((extension) => `${service}/${name}: ${extension}`),
    ),
  );
  assert.deepEqual(allowances, [
    'marketplace/20260829185748_init_marketplace: pg_trgm',
    'organization/20260925150000_policy_timeline_and_primary_contact: btree_gist',
  ]);
});

test('the snapshot lists every extension with its version and schema, unstripped', () => {
  const sql = snapshotQuery('migration_check');
  assert.match(sql, /FROM pg_extension e JOIN pg_namespace n ON n\.oid = e\.extnamespace/);
  assert.match(sql, /'extension ' \|\| e\.extname \|\| ' version=' \|\| e\.extversion/);
  // Outside the stripped items: a scratch database's target schema is public,
  // and stripping `public.` there would rename every extension's schema.
  assert.match(sql, /AS item FROM items\s+UNION ALL[\s\S]*FROM pg_extension/);
  // The schema under test reads `(target)`; any other schema by its name.
  assert.match(
    sql,
    /CASE WHEN n\.nspname IN \('migration_check', 'migration_check'\) THEN '\(target\)'\s+ELSE n\.nspname END/,
  );
  // In a scratch database the target's deploy puts extensions in public.
  assert.match(
    snapshotQuery('migration_check_ref', 'public'),
    /IN \('migration_check_ref', 'public'\)/,
  );
  assert.throws(() => snapshotQuery('migration_check', 'bad"home'));
});

test('a kept extension is excused by exact name, and only as its exact post-deploy row', () => {
  const script = assertSnapshotScript('meta', 'after:m1', 'target', 'down: m1', undefined, {
    keptExtensions: ['btree_gist'],
    keptFrom: 'post-up',
  });
  assert.match(script, /split_part\(u, ' ', 1\) = 'extension'/);
  assert.match(script, /split_part\(u, ' ', 2\) = ANY \(ARRAY\['btree_gist'\]::text\[\]\)/);
  // The whole row — name, version and schema — must be one recorded after deploy.
  assert.match(script, /AND u IN \(SELECT item FROM "meta"\.snapshot WHERE label = 'post-up'\)/);
  assert.doesNotMatch(script, /LIKE/);
  // No allowance: an empty list, so every extension difference fails.
  assert.match(
    assertSnapshotScript('meta', 'after:m1', 'target', 'ctx'),
    /ANY \(ARRAY\[\]::text\[\]\)/,
  );
  assert.throws(() =>
    assertSnapshotScript('meta', 'l', 'target', 'ctx', undefined, {
      keptExtensions: ["x' OR 1=1"],
      keptFrom: 'post-up',
    }),
  );
  // An allowance without the state it must match is refused, not widened.
  assert.throws(
    () =>
      assertSnapshotScript('meta', 'l', 'target', 'ctx', undefined, { keptExtensions: ['citext'] }),
    /needs keptFrom/,
  );
});

test('every service with migrations is in EXPECTED and in test:migration', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const verified = [
    ...pkg.scripts['test:migration'].matchAll(/verify-migration-reversible\.mjs (\S+)/g),
  ].map((m) => m[1]);

  for (const service of servicesWithMigrations()) {
    assert.ok(EXPECTED[service], `${service} has no EXPECTED entry`);
    assert.ok(verified.includes(service), `${service} is not in the root test:migration chain`);
  }
});

// ---------------------------------------------------------------------------
// The exact-inverse builders (behaviour is proven against PostgreSQL by the
// CLI; these pin the parts that are pure)
// ---------------------------------------------------------------------------

test('snapshotQuery reads only the named schema and strips its name', () => {
  const sql = snapshotQuery('migration_check');
  assert.match(sql, /nspname = 'migration_check'/);
  assert.match(sql, /'"migration_check"\.', ''/);
  assert.match(sql, /'migration_check\.', ''/);
  // Extension members and the ledger are excluded, not compared.
  assert.match(sql, /deptype = 'e'/);
  assert.match(sql, /relname = '_prisma_migrations'/);
});

test('the builders refuse identifiers that would have to be quoted into SQL', () => {
  assert.throws(() => snapshotQuery('bad"schema'));
  assert.throws(() => recordSnapshotScript('meta', "x'; DROP TABLE t; --", 'ref'));
  assert.throws(() => assertSnapshotScript('meta', 'a b', 'ref', 'ctx'));
  assert.throws(() => ledgerAssertionScript(["m'1"], 'ctx'));
});

test('an allowance is escaped, and required to match rather than merely tolerated', () => {
  const script = assertSnapshotScript('meta', 'after:m1', 'target', "down: it's", {
    missing: [`constraint t.c CHECK ((s = 'A'::"E"))`],
    unexpected: [],
  });
  assert.match(script, /'constraint t\.c CHECK \(\(s = ''A''::"E"\)\)'/);
  assert.match(script, /<@ missing/);
  assert.match(script, /no longer matches/);
  assert.match(script, /down: it''s/);
});

test('the ledger assertion reads every row: any unfinished or rolled-back one fails', () => {
  const script = ledgerAssertionScript(['20260101000000_a', '20260102000000_b'], 'after up');
  assert.match(script, /ARRAY\['20260101000000_a', '20260102000000_b'\]/);
  assert.match(script, /WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL/);
  // The compared set is every row — no filter that could hide a leftover.
  assert.match(script, /INTO actual\s+FROM "_prisma_migrations";/);
  assert.doesNotMatch(script, /finished_at IS NOT NULL AND rolled_back_at IS NULL/);
  assert.doesNotMatch(script, /still has a row/);
  assert.match(ledgerAssertionScript([], 'after the last down'), /ARRAY\[\]::text\[\]/);
});

test('after a down, the ledger assertion requires that migration to have no row at all', () => {
  const script = ledgerAssertionScript(['20260101000000_a'], 'down: b', '20260102000000_b');
  assert.match(
    script,
    /IF EXISTS \(SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20260102000000_b'\)/,
  );
  assert.match(script, /still has a row for %, in any state/);
  assert.throws(() => ledgerAssertionScript([], 'ctx', "b'; DROP TABLE x; --"));
});

test('the only inexact-inverse allowance is marketplace cancel_before_hold', () => {
  const allowances = Object.entries(EXPECTED).flatMap(([service, entry]) =>
    Object.keys(entry.inexactInverse ?? {}).map((name) => `${service}/${name}`),
  );
  assert.deepEqual(allowances, ['marketplace/20260830103500_cancel_before_hold']);
});

// ---------------------------------------------------------------------------
// Kept extensions against PostgreSQL (Codex review of #117, finding 4)
//
// With MIGRATION_LIB_TEST_DATABASE_URL (a role that may CREATE DATABASE, as
// the development and CI service roles may), each case runs in a throwaway
// database: record the state before, "deploy" citext at one version into the
// schema under test, record that as post-up, apply the case's "down", and
// assert. CI sets MIGRATION_LIB_TEST_DATABASE_REQUIRED=true, so there the cases
// cannot be skipped by a missing URL.
// ---------------------------------------------------------------------------

const libDatabaseUrl = process.env.MIGRATION_LIB_TEST_DATABASE_URL;
if (process.env.MIGRATION_LIB_TEST_DATABASE_REQUIRED === 'true' && !libDatabaseUrl) {
  throw new Error(
    'MIGRATION_LIB_TEST_DATABASE_REQUIRED is set but MIGRATION_LIB_TEST_DATABASE_URL is not',
  );
}

/** What the scratch databases this file creates say they are for. */
const LIB_PURPOSE = 'migration-lib-test';

/** Creates and marks this run's scratch database, the way the verifier does. */
function createAsOwner(scratch) {
  const created = createScratchDatabase(psqlRunner(libDatabaseUrl), scratch);
  assert.equal(created.ok, true, created.output);
}

/** Drops this run's scratch database the way the verifier does: marked, as its owner, never FORCE. */
function dropAsOwner(scratch, options) {
  return dropScratchDatabase(psqlRunner(libDatabaseUrl), scratch, options);
}

function psqlAt(url, script, database) {
  const target = new URL(url);
  target.search = '';
  if (database) target.pathname = `/${database}`;
  const { target: psqlTarget, env } = libpqInvocation(target.toString());
  return spawnSync('psql', [psqlTarget, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

/** Runs `down` after a citext 1.5 "deploy", then the down-script assertion. */
function keptExtensionCase(down, keptExtensions) {
  const scratch = newScratchDatabase(LIB_PURPOSE, 'kept_ext');
  const database = scratch.name;
  const must = (result, what) => {
    if (result.status !== 0) throw new Error(`${what}: ${result.stderr}`);
  };
  createAsOwner(scratch);
  // A failed cleanup fails the test — but never hides the failure the case
  // itself hit first, which stays the one reported (review of #133, finding 3).
  let primary = null;
  try {
    const run = (script) => psqlAt(libDatabaseUrl, script, database);
    must(
      run(
        'CREATE SCHEMA target; CREATE SCHEMA elsewhere;' +
          snapshotStoreScript('meta') +
          recordSnapshotScript('meta', 'before', 'target'),
      ),
      'record before',
    );
    must(
      run(
        "CREATE EXTENSION citext VERSION '1.5' SCHEMA target;" +
          recordSnapshotScript('meta', 'post-up', 'target'),
      ),
      'deploy',
    );
    if (down) must(run(down), 'down');
    return run(
      assertSnapshotScript('meta', 'before', 'target', 'down: m1', undefined, {
        keptExtensions,
        keptFrom: 'post-up',
      }),
    );
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    const dropped = dropAsOwner(scratch);
    // eslint-disable-next-line no-unsafe-finally
    if (!primary && !dropped.ok) throw new Error(`cleanup failed: ${dropped.output}`);
  }
}

test(
  'a kept extension left exactly as deployed passes',
  { skip: !libDatabaseUrl && 'MIGRATION_LIB_TEST_DATABASE_URL is not set' },
  () => {
    const result = keptExtensionCase(null, ['citext']);
    assert.equal(result.status, 0, result.stderr);
  },
);

test(
  'a kept extension left at another version fails',
  { skip: !libDatabaseUrl && 'MIGRATION_LIB_TEST_DATABASE_URL is not set' },
  () => {
    const result = keptExtensionCase("ALTER EXTENSION citext UPDATE TO '1.6';", ['citext']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /present but not expected:\s+extension citext version=1\.6/);
  },
);

test(
  'a kept extension moved to another schema fails',
  { skip: !libDatabaseUrl && 'MIGRATION_LIB_TEST_DATABASE_URL is not set' },
  () => {
    // Left at the same version, in another schema. (Recreated rather than
    // ALTER … SET SCHEMA, which a trusted extension's members refuse to a
    // non-superuser.)
    const result = keptExtensionCase(
      "DROP EXTENSION citext; CREATE EXTENSION citext VERSION '1.5' SCHEMA elsewhere;",
      ['citext'],
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /extension citext version=1\.5 schema=elsewhere/);
  },
);

test(
  'an extension left behind without an allowance fails',
  { skip: !libDatabaseUrl && 'MIGRATION_LIB_TEST_DATABASE_URL is not set' },
  () => {
    const result = keptExtensionCase(null, []);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /extension citext version=1\.5 schema=\(target\)/);
  },
);

// ---------------------------------------------------------------------------
// Scratch databases: created marked, dropped only if marked, as their owner
//
// CI verifies as the service roles, which own their scratch databases but are
// not superusers. `DROP DATABASE … WITH (FORCE)` failed there once (main,
// cd0c39a): FORCE must terminate every backend in the database, and a role
// that is not a superuser may terminate only its own — an autovacuum worker,
// or any other role's session, fails the whole statement with "permission
// denied to terminate process". The helper drops without FORCE (PostgreSQL
// then stops autovacuum workers itself), retries only on SQLSTATE 55006, and
// touches nothing that is not this role's marked scratch database.
// ---------------------------------------------------------------------------

test('each run gets its own scratch database name, marked with its run id and creation time', () => {
  const now = new Date('2026-09-28T08:00:00.000Z');
  const a = newScratchDatabase(LIB_PURPOSE, 'organization', { now, runId: '0123456789abcdef' });
  assert.deepEqual(a, {
    name: 'rasta_scratch_organization_0123456789abcdef',
    marker: `rasta-scratch:${LIB_PURPOSE}:0123456789abcdef:2026-09-28T08:00:00.000Z`,
  });
  const b = newScratchDatabase(LIB_PURPOSE, 'organization');
  const c = newScratchDatabase(LIB_PURPOSE, 'organization');
  assert.notEqual(b.name, c.name);
  for (const [label, purpose] of [
    ['Upper', LIB_PURPOSE],
    ['a-b', LIB_PURPOSE],
    ['x'.repeat(25), LIB_PURPOSE],
    ['ok', "p'; --"],
  ]) {
    assert.throws(() => newScratchDatabase(purpose, label), /Not a scratch database/);
  }
  for (const name of ['postgres', 'template1', 'rasta_identity', 'rasta_scratch_x"; --']) {
    assert.throws(() => scratchDatabaseSql({ ...a, name }), /Not a scratch database name/);
  }
  assert.throws(
    () => scratchDatabaseSql({ ...a, marker: `rasta-scratch:${LIB_PURPOSE}` }),
    /marker/,
  );
});

test('the drop never uses FORCE, and checks this run’s marker before it changes anything', () => {
  const scratch = newScratchDatabase(LIB_PURPOSE, 'x');
  const sql = scratchDatabaseSql(scratch);
  assert.doesNotMatch(Object.values(sql).join('\n'), /FORCE/);
  assert.equal(sql.mark, `COMMENT ON DATABASE "${scratch.name}" IS '${scratch.marker}';`);
  assert.equal(sql.drop, `DROP DATABASE IF EXISTS "${scratch.name}";`);
  const refuse = sql.prepare.indexOf('RAISE EXCEPTION');
  assert.ok(refuse > 0 && refuse < sql.prepare.indexOf('ALTER DATABASE'));
  for (const check of ['current_database()', 'current_user', `'${scratch.marker}'`]) {
    assert.ok(sql.inspect.includes(check) && sql.prepare.includes(check), check);
  }
  assert.match(sql.prepare, /usename = current_user/);
});

test('psql gets libpq’s own URL parameters, and none of Prisma’s', () => {
  const url = libpqUrl(
    'postgresql://u:p@db.example:5432/rasta?schema=public&sslmode=verify-full&sslrootcert=%2Fetc%2Fca.pem&connect_timeout=5&application_name=verifier&connection_limit=3&pool_timeout=10&pgbouncer=true',
  );
  const params = new URL(url).searchParams;
  assert.equal(params.get('sslmode'), 'verify-full');
  assert.equal(params.get('sslrootcert'), '/etc/ca.pem');
  assert.equal(params.get('connect_timeout'), '5');
  assert.equal(params.get('application_name'), 'verifier');
  for (const prismaOnly of ['schema', 'connection_limit', 'pool_timeout', 'pgbouncer']) {
    assert.equal(params.has(prismaOnly), false, prismaOnly);
  }
});

test('a startup option reaches libpq percent-encoded, never with `+` for its space (L7-37)', () => {
  // libpq decodes %XX in a URI and nothing else: `-c+TimeZone=UTC` is refused
  // by the server as an unknown parameter `+TimeZone`.
  const given = 'postgresql://u@db.example/rasta_x?schema=public&options=-c%20TimeZone%3DUTC';
  assert.equal(libpqUrl(given), 'postgresql://u@db.example/rasta_x?options=-c%20TimeZone%3DUTC');
  // …including after a `URLSearchParams` edit upstream has already written `+`.
  const edited = new URL(given);
  edited.searchParams.set('schema', 'scratch');
  assert.match(edited.toString(), /options=-c\+TimeZone/);
  assert.equal(
    libpqInvocation(edited.toString()).target,
    'postgresql://u@db.example/rasta_x?options=-c%20TimeZone%3DUTC',
  );
});

test('psql gets the password in its environment, never in its argv', () => {
  // Built, not written: a fixture password, set through URL so it is encoded
  // as a real one would be (and no credentialed URI sits in the source).
  const withPassword = new URL(
    'postgresql://rasta_x_migrator@db.example:5432/rasta_x?schema=public&sslmode=require',
  );
  withPassword.password = 'p@ss:w0rd';
  assert.match(withPassword.toString(), /:p%40ss%3Aw0rd@/);
  const inUserinfo = libpqInvocation(withPassword.toString());
  assert.equal(
    inUserinfo.target,
    'postgresql://rasta_x_migrator@db.example:5432/rasta_x?sslmode=require',
  );
  assert.deepEqual(inUserinfo.env, { PGPASSWORD: 'p@ss:w0rd' });

  const inQuery = libpqInvocation('postgresql://db.example/rasta_x?user=u&password=s3cret');
  assert.equal(inQuery.target, 'postgresql://db.example/rasta_x?user=u');
  assert.deepEqual(inQuery.env, { PGPASSWORD: 's3cret' });

  // No password to move: nothing is set, so an inherited PGPASSWORD or
  // ~/.pgpass still applies as it did before.
  const none = libpqInvocation('postgresql://u@db.example/rasta_x');
  assert.equal(none.target, 'postgresql://u@db.example/rasta_x');
  assert.deepEqual(none.env, {});
});

test('psqlRunner starts psql with no password in its argv', (t) => {
  // A psql on PATH that records what it was started with.
  const dir = mkdtempSync(join(tmpdir(), 'psql-argv-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seen = join(dir, 'seen');
  writeFileSync(
    join(dir, 'psql'),
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${seen}'\nprintf 'PGPASSWORD=%s\\n' "$PGPASSWORD" >> '${seen}'\necho 1\n`,
    { mode: 0o755 },
  );
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });

  const secret = 'n0t-in-argv';
  const result = psqlRunner(`postgresql://rasta_x_migrator:${secret}@db.example/rasta_x`)(
    'SELECT 1',
  );

  assert.equal(result.ok, true, result.output);
  const lines = readFileSync(seen, 'utf8').trim().split('\n');
  const passed = lines.slice(0, -1);
  assert.equal(passed[0], 'postgresql://rasta_x_migrator@db.example/rasta_x');
  assert.equal(passed.join('\n').includes(secret), false, passed.join(' '));
  assert.equal(lines.at(-1), `PGPASSWORD=${secret}`);
});

/**
 * Every source file the repository runs, scripts and services alike — never
 * node_modules or build output.
 */
function runnableSources() {
  const roots = [join(ROOT, 'scripts')];
  for (const service of readdirSync(join(ROOT, 'services'))) {
    for (const part of ['src', 'test', 'prisma', 'scripts']) {
      roots.push(join(ROOT, 'services', service, part));
    }
  }
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:[cm]?js|ts)$/.test(entry.name)) files.push(path);
    }
  };
  roots.forEach(walk);
  return files;
}

/**
 * Tests that hand `--url` to a CLI only to prove it is refused, with a
 * credential-free placeholder. Nothing else may name the flag.
 */
const URL_FLAG_REFUSAL_TESTS = new Set(['scripts/outbox-b2-vacuum.pg.test.mjs']);

/** Every shell script the repository runs, outside node_modules. */
function shellScripts() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:sh|bash)$/.test(entry.name)) files.push(path);
    }
  };
  ['infrastructure', 'scripts'].forEach((root) => walk(join(ROOT, root)));
  return files;
}

const PG_CLIENT =
  /(?<![\w./-])(psql|pg_dump|pg_dumpall|pg_restore|createdb|createuser|dropdb|dropuser)\b/g;

/**
 * Each PostgreSQL client command in a shell script, as written: from the
 * program name to the end of the command — an unquoted newline that is not a
 * line continuation, or an unquoted `|`, `;` or `&`. Quoted text may span
 * lines. Comment lines are skipped.
 */
function pgClientCommands(source) {
  const commands = [];
  for (const match of source.matchAll(PG_CLIENT)) {
    const lineStart = source.lastIndexOf('\n', match.index) + 1;
    if (source.slice(lineStart, match.index).trimStart().startsWith('#')) continue;
    let quote = null;
    let end = match.index;
    for (; end < source.length; end += 1) {
      const char = source[end];
      if (quote) {
        if (char === '\\' && quote === '"') end += 1;
        else if (char === quote) quote = null;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '\\') end += 1;
      else if (char === '\n' || char === '|' || char === ';' || char === '&') break;
    }
    commands.push({
      text: source.slice(match.index, end),
      line: source.slice(0, match.index).split('\n').length,
    });
  }
  return commands;
}

/**
 * Why a PostgreSQL client command's argv could carry a credential, or null.
 * Its `-c` text must be literal SQL with no password in it — a bare
 * expansion (`-c "$2"`, `-c "${sql}"`) can carry anything a caller passes,
 * an ALTER ROLE … PASSWORD included, so such SQL goes on stdin (`-f -`).
 */
function pgClientArgvProblem(command) {
  if (/postgres(?:ql)?:\/\/[^\s"'/@:]+:[^\s"'@$]+@/.test(command)) return 'a credentialed URI';
  for (const [, quoted] of command.matchAll(
    /\s(?:-[A-Za-z]*c|--command)(?:\s+|=)("(?:[^"\\]|\\.)*"|'[^']*'|\S+)/g,
  )) {
    if (/PASSWORD/i.test(quoted)) return 'a PASSWORD in its -c text';
    if (/^["']?\$(?:\{?\w+\}?|\d)["']?$/.test(quoted)) {
      return `-c ${quoted}, which could carry any SQL, a password included (use -f - and stdin)`;
    }
  }
  return null;
}

test('no PostgreSQL client in a shell script gets a credential in its argv (D-045 follow-up)', () => {
  const offenders = [];
  let seen = 0;
  for (const file of shellScripts()) {
    for (const command of pgClientCommands(readFileSync(file, 'utf8'))) {
      seen += 1;
      const problem = pgClientArgvProblem(command.text);
      if (problem) offenders.push(`${file.slice(ROOT.length)}:${command.line}: ${problem}`);
    }
  }
  assert.ok(seen > 5, `only ${seen} psql invocations found — the scan is not reading the scripts`);
  assert.deepEqual(offenders, []);
});

test('the shell argv rule catches what it must and passes what it may', () => {
  for (const bad of [
    'psql -v ON_ERROR_STOP=1 --dbname "$1" -c "$2"',
    'psql -X -q -c "${sql}"',
    'psql -X -tAc "$1"',
    'psql --command="$2"',
    `psql -c "ALTER ROLE r WITH PASSWORD '\${pw}'"`,
    'psql "postgresql://u:secret@db/x" -c "SELECT 1"',
  ]) {
    assert.notEqual(pgClientArgvProblem(bad), null, bad);
  }
  for (const good of [
    'psql -v ON_ERROR_STOP=1 --dbname "$1" -f -',
    `psql -tAc "SELECT 1 FROM pg_database WHERE datname='\${db}'" --username "$POSTGRES_USER" postgres`,
    'psql -X -q -tA -h 127.0.0.1 --username "$role" -c \'SELECT 1\'',
    'psql "postgresql://rasta_economic@localhost:5432/rasta_economic" -c "SELECT 1"',
  ]) {
    assert.equal(pgClientArgvProblem(good), null, good);
  }
});

test('our code puts no database url on a command line (D-045 follow-up; Prisma itself: D-047)', () => {
  // A process's argv is readable by every local user while it runs (`ps`,
  // /proc/<pid>/cmdline). Prisma takes the url from the environment through
  // `--schema`; psql takes the password from PGPASSWORD (libpqInvocation).
  // This holds for the commands *we* start. Prisma's own schema-engine child
  // still receives the url as `--datasource` during migrate commands — a
  // third-party residual recorded as D-047 in docs/23, not covered here.
  const urlFlag = new RegExp(`['"]--${'url'}['"]`);
  const spawnsPsql = /spawn(?:Sync)?\(\s*'psql'/;
  const offenders = [];
  for (const file of runnableSources()) {
    const source = readFileSync(file, 'utf8');
    const name = file.slice(ROOT.length);
    if (urlFlag.test(source) && !URL_FLAG_REFUSAL_TESTS.has(name)) {
      offenders.push(`${name}: passes a url to Prisma as an argument`);
    }
    if (
      spawnsPsql.test(source) &&
      source.includes('new URL(') &&
      !source.includes('libpqInvocation(')
    ) {
      offenders.push(`${name}: builds a url and starts psql without libpqInvocation`);
    }
  }
  // A workflow's credentialed url belongs in an environment assignment
  // (`KEY: value`, `KEY=value \`), never in a command's arguments.
  const credentialed = /postgres(?:ql)?:\/\/[^:/@"\s]+:[^@"\s]+@/;
  const assignment = /^\s*-?\s*[A-Z_][A-Z0-9_]*[:=]\s*/;
  const workflows = join(ROOT, '.github', 'workflows');
  for (const name of readdirSync(workflows)) {
    readFileSync(join(workflows, name), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (credentialed.test(line) && !assignment.test(line)) {
          offenders.push(
            `.github/workflows/${name}:${i + 1}: a credentialed url outside an env assignment`,
          );
        }
      });
  }
  assert.deepEqual(offenders, []);
});

test('the SQLSTATE is read from its field, never from the message', () => {
  assert.equal(
    sqlstateFrom(
      'ERROR:  55006: database "rasta_scratch_x" is being accessed by other users\nDETAIL:  There is 1 other session using the database.',
    ),
    '55006',
  );
  assert.equal(
    sqlstateFrom(
      'FEHLER:  55006: auf Datenbank »rasta_scratch_x« wird von anderen Benutzern zugegriffen',
    ),
    '55006',
  );
  assert.equal(
    sqlstateFrom(
      'NOTICE:  00000: database "rasta_scratch_y" does not exist, skipping\nERROR:  42501: must be owner of database rasta_scratch_d55006',
    ),
    '42501',
  );
  assert.equal(
    sqlstateFrom('ERROR:  42501: must be owner of database rasta_scratch_d55006'),
    '42501',
  );
  assert.equal(sqlstateFrom('psql: error: connection to server failed'), null);
});

test('the drop retries on SQLSTATE 55006 alone, a bounded number of times', () => {
  const marked = { ok: true, stdout: 'marked\n', output: '', sqlstate: null };
  const fine = { ok: true, stdout: '', output: '', sqlstate: null };
  const inUseLocalized = {
    ok: false,
    stdout: '',
    output: 'FEHLER:  55006: auf Datenbank »rasta_scratch_x« wird zugegriffen',
    sqlstate: '55006',
  };
  const ownerNamed55006 = {
    ok: false,
    stdout: '',
    output:
      'ERROR:  42501: must be owner of database rasta_scratch_d55006 (is being accessed by other users)',
    sqlstate: '42501',
  };
  const script = (answers) => {
    const calls = [];
    return {
      calls,
      run: (sql) => {
        calls.push(
          sql.startsWith('SELECT') ? 'inspect' : sql.startsWith('DO') ? 'prepare' : 'drop',
        );
        return answers.shift() ?? fine;
      },
    };
  };
  const pause = () => {};
  const scratch = newScratchDatabase(LIB_PURPOSE, 'x');
  const drop = (run) => dropScratchDatabase(run, scratch, { pause });

  const leaving = script([marked, fine, inUseLocalized, inUseLocalized]);
  assert.deepEqual(drop(leaving.run), { ok: true, refused: false, output: '', attempts: 3 });
  assert.deepEqual(leaving.calls, ['inspect', 'prepare', 'drop', 'drop', 'drop']);

  const notOwner = script([marked, fine, ownerNamed55006]);
  assert.equal(drop(notOwner.run).attempts, 1);
  assert.deepEqual(notOwner.calls, ['inspect', 'prepare', 'drop']);

  const staying = script([marked, fine, inUseLocalized, inUseLocalized, inUseLocalized]);
  assert.equal(drop(staying.run).attempts, 3);

  const absent = script([{ ...marked, stdout: 'absent\n' }]);
  assert.deepEqual(drop(absent.run), { ok: true, refused: false, output: '', attempts: 0 });
  assert.deepEqual(absent.calls, ['inspect']);
  const otherRun = script([
    { ...marked, stdout: "refuse:it does not carry this run's scratch marker\n" },
  ]);
  const refusal = drop(otherRun.run);
  assert.equal(refusal.refused, true);
  assert.deepEqual(otherRun.calls, ['inspect']);
});

test('a failed mark reports whether the unmarked database was cleaned up', () => {
  const scratch = newScratchDatabase(LIB_PURPOSE, 'x');
  const answers = (list) => {
    const queue = [...list];
    return () => queue.shift();
  };
  const ok = { ok: true, output: '' };
  const markFailed = { ok: false, output: 'ERROR:  42501: must be owner' };
  const cleaned = createScratchDatabase(answers([ok, markFailed, ok]), scratch);
  assert.equal(cleaned.ok, false);
  assert.match(cleaned.output, /marking .* failed[\s\S]*dropped again/);
  const stuck = createScratchDatabase(
    answers([ok, markFailed, { ok: false, output: 'ERROR:  55006: in use' }]),
    scratch,
  );
  assert.equal(stuck.ok, false);
  assert.match(stuck.output, /dropping the unmarked database failed too[\s\S]*55006/);
});

test('stale marked scratch databases are only reported, and only when older than a day', () => {
  const now = new Date('2026-09-28T12:00:00.000Z');
  const old = newScratchDatabase(LIB_PURPOSE, 'old', { now: new Date('2026-09-26T12:00:00.000Z') });
  const fresh = newScratchDatabase(LIB_PURPOSE, 'fresh', {
    now: new Date('2026-09-28T11:00:00.000Z'),
  });
  const calls = [];
  const run = (sql) => {
    calls.push(sql);
    return {
      ok: true,
      stdout: [
        `${old.name} ${old.marker}`,
        `${fresh.name} ${fresh.marker}`,
        'rasta_scratch_unmarked_x ',
      ].join('\n'),
    };
  };
  assert.deepEqual(staleScratchDatabases(run, { now }), [
    { name: old.name, createdAt: '2026-09-26T12:00:00.000Z' },
  ]);
  // Read-only: one SELECT, nothing else.
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^SELECT/);
});

// Another role's session in the scratch database, as a stand-in for the
// autovacuum worker CI met (whose timing a test cannot control). CI points it
// at a second service role; REQUIRED makes a missing URL an error there.
const foreignDatabaseUrl = process.env.MIGRATION_LIB_TEST_FOREIGN_DATABASE_URL;
if (process.env.MIGRATION_LIB_TEST_DATABASE_REQUIRED === 'true' && !foreignDatabaseUrl) {
  throw new Error(
    'MIGRATION_LIB_TEST_DATABASE_REQUIRED is set but MIGRATION_LIB_TEST_FOREIGN_DATABASE_URL is not',
  );
}
const noDatabase = !libDatabaseUrl && 'MIGRATION_LIB_TEST_DATABASE_URL is not set';
const noForeign =
  (!libDatabaseUrl || !foreignDatabaseUrl) &&
  'MIGRATION_LIB_TEST_DATABASE_URL and MIGRATION_LIB_TEST_FOREIGN_DATABASE_URL are not both set';

/** Another role connected to `database` for `seconds`, once it is visibly there. */
async function foreignSession(database, seconds) {
  const target = new URL(foreignDatabaseUrl);
  target.search = '';
  target.pathname = `/${database}`;
  const { target: psqlTarget, env } = libpqInvocation(target.toString());
  const child = spawn('psql', [psqlTarget, '-X', '-q', '-c', `SELECT pg_sleep(${seconds})`], {
    stdio: 'ignore',
    env: { ...process.env, ...env },
  });
  const exited = new Promise((resolveExit) => child.on('exit', resolveExit));
  for (let i = 0; i < 100; i += 1) {
    const seen = scalarAt(
      `SELECT count(*) FROM pg_stat_activity WHERE datname = '${database}' AND usename <> current_user`,
    );
    if (seen === '1') return { child, exited };
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill();
  throw new Error('the foreign session never connected');
}

/** One value, unaligned, as the dropping role, from its own database. */
function scalarAt(sql) {
  const result = psqlRunner(libDatabaseUrl)(sql);
  assert.equal(result.ok, true, result.output);
  return result.stdout.trim();
}

function freshScratch(label = 'drop') {
  const scratch = newScratchDatabase(LIB_PURPOSE, label);
  createAsOwner(scratch);
  return scratch;
}

const exists = (database) =>
  scalarAt(`SELECT count(*) FROM pg_database WHERE datname = '${database}'`) === '1';
const allowsConnections = (database) =>
  scalarAt(`SELECT datallowconn FROM pg_database WHERE datname = '${database}'`) === 't';

/** Connects to `database` as the dropping role and reads one value: proves it is still usable. */
const connectable = (database) => {
  const target = new URL(libDatabaseUrl);
  target.pathname = `/${database}`;
  return psqlRunner(target.toString())('SELECT 1').stdout.trim() === '1';
};

test(
  'a created scratch database carries this run’s marker, and the drop removes it',
  { skip: noDatabase },
  () => {
    const scratch = freshScratch();
    assert.equal(
      scalarAt(
        `SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = '${scratch.name}'`,
      ),
      scratch.marker,
    );
    const dropped = dropAsOwner(scratch);
    assert.equal(dropped.ok, true, dropped.output);
    assert.equal(exists(scratch.name), false);
  },
);

test(
  'a run never drops another run’s scratch database, even under the same name and purpose',
  { skip: noDatabase },
  () => {
    // Two worktrees against one server: run B holds run A's name — which a
    // random run id makes impossible in practice — but not A's marker.
    const runA = freshScratch('shared');
    const runB = { ...newScratchDatabase(LIB_PURPOSE, 'shared'), name: runA.name };
    try {
      const refused = dropAsOwner(runB);
      assert.equal(refused.refused, true);
      assert.match(refused.output, /this run's scratch marker/);
      assert.equal(exists(runA.name), true);
      assert.equal(allowsConnections(runA.name), true);
      assert.equal(connectable(runA.name), true);
    } finally {
      assert.equal(dropAsOwner(runA).ok, true);
    }
  },
);

test(
  'a database with a scratch name but no marker is refused, and left untouched and connectable',
  { skip: noDatabase },
  () => {
    const scratch = newScratchDatabase(LIB_PURPOSE, 'unmarked');
    const created = psqlRunner(libDatabaseUrl)(
      `CREATE DATABASE "${scratch.name}" TEMPLATE template1;`,
    );
    assert.equal(created.ok, true, created.output);
    try {
      const refused = dropAsOwner(scratch);
      assert.equal(refused.refused, true);
      assert.equal(exists(scratch.name), true);
      assert.equal(allowsConnections(scratch.name), true);
      assert.equal(connectable(scratch.name), true);
    } finally {
      // Only this test knows the database is its own, so it cleans up directly.
      const cleaned = psqlRunner(libDatabaseUrl)(`DROP DATABASE IF EXISTS "${scratch.name}";`);
      assert.equal(cleaned.ok, true, cleaned.output);
    }
  },
);

test('the database the session is connected to is refused', { skip: noDatabase }, () => {
  const scratch = freshScratch('self');
  const target = new URL(libDatabaseUrl);
  target.pathname = `/${scratch.name}`;
  const fromInside = dropScratchDatabase(psqlRunner(target.toString()), scratch);
  assert.equal(fromInside.refused, true);
  assert.match(fromInside.output, /connected to/);
  assert.equal(allowsConnections(scratch.name), true);
  assert.equal(dropAsOwner(scratch).ok, true);
});

test('psql connects with libpq parameters left in the URL', { skip: noDatabase }, () => {
  const target = new URL(libDatabaseUrl);
  target.searchParams.set('schema', 'public');
  target.searchParams.set('connect_timeout', '5');
  target.searchParams.set('application_name', 'rasta_scratch_probe');
  const seen = psqlRunner(target.toString())("SELECT current_setting('application_name')");
  assert.equal(seen.ok, true, seen.output);
  assert.equal(seen.stdout.trim(), 'rasta_scratch_probe');
});

test(
  'another role’s marked scratch database is refused and left untouched; its 42501 is not retried',
  { skip: noForeign },
  () => {
    // Named with 55006 in it, so a text match on the output would have retried.
    const scratch = newScratchDatabase(LIB_PURPOSE, 'd55006');
    const foreign = psqlRunner(foreignDatabaseUrl);
    assert.equal(createScratchDatabase(foreign, scratch).ok, true);
    try {
      const refused = dropAsOwner(scratch);
      assert.equal(refused.refused, true);
      assert.match(refused.output, /owned by another role/);
      assert.equal(exists(scratch.name), true);
      assert.equal(allowsConnections(scratch.name), true);
      const direct = psqlRunner(libDatabaseUrl)(`DROP DATABASE "${scratch.name}";`);
      assert.equal(direct.ok, false);
      assert.equal(direct.sqlstate, '42501');
      assert.match(direct.output, /55006/);
    } finally {
      assert.equal(dropScratchDatabase(foreign, scratch).ok, true);
    }
  },
);

test(
  'the failure CI met: FORCE, as the owner, is refused while another role is connected',
  { skip: noForeign },
  async () => {
    const scratch = freshScratch();
    const holder = await foreignSession(scratch.name, 3);
    try {
      const forced = psqlRunner(libDatabaseUrl)(`DROP DATABASE "${scratch.name}" WITH (FORCE);`);
      assert.equal(forced.ok, false, 'FORCE dropped a database another role was connected to');
      assert.equal(forced.sqlstate, '42501');
      assert.match(forced.output, /terminate process/);
    } finally {
      await holder.exited;
      assert.equal(dropAsOwner(scratch).ok, true);
    }
  },
);

test(
  "the owner's drop waits for another role's session to leave, then drops",
  { skip: noForeign },
  async () => {
    const scratch = freshScratch();
    const holder = await foreignSession(scratch.name, 2);
    const dropped = dropAsOwner(scratch);
    await holder.exited;
    assert.equal(dropped.ok, true, dropped.output);
    assert.equal(exists(scratch.name), false);
  },
);

test(
  "the owner's drop never terminates a session that is not its own: it reports it",
  { skip: noForeign },
  async () => {
    const scratch = freshScratch();
    const holder = await foreignSession(scratch.name, 9);
    try {
      const refused = dropAsOwner(scratch, { attempts: 1 });
      assert.equal(refused.ok, false);
      assert.match(refused.output, /55006/);
      assert.equal(holder.child.exitCode, null);
      assert.equal(exists(scratch.name), true);
    } finally {
      await holder.exited;
      assert.equal(dropAsOwner(scratch).ok, true);
    }
  },
);

test('a migrator-verified service connects as its named migrator only, never DATABASE_URL (Codex on #178)', () => {
  const migratorServices = Object.entries(EXPECTED)
    .filter(([, entry]) => entry.connectAs === 'migrator')
    .map(([service]) => service);
  assert.ok(migratorServices.includes('construction'), migratorServices.join(', '));
  for (const service of migratorServices) {
    const key = `DATABASE_URL_${service.toUpperCase()}_MIGRATOR`;
    // Both set: the named migrator wins.
    assert.deepEqual(
      verifierConnection(service, {
        DATABASE_URL: 'postgresql://other@h/d',
        [key]: 'postgresql://m@h/d',
      }),
      { key, url: 'postgresql://m@h/d' },
    );
    // Only the generic one: refused, naming the variable — never a fallback.
    const refused = verifierConnection(service, {
      DATABASE_URL: 'postgresql://other@h/d',
      [`DATABASE_URL_${service.toUpperCase()}`]: 'postgresql://runtime@h/d',
    });
    assert.equal(refused.url, undefined);
    assert.equal(refused.key, key);
    assert.match(refused.error, new RegExp(`${key} is not set`));
    assert.ok(!refused.error.includes('other@'));
  }
});

test('a runtime-verified service keeps its order: DATABASE_URL, then DATABASE_URL_<SVC>', () => {
  const runtimeService = Object.entries(EXPECTED).find(([, entry]) => !entry.connectAs)?.[0];
  if (!runtimeService) return; // every service verified as its migrator — nothing to order
  const key = `DATABASE_URL_${runtimeService.toUpperCase()}`;
  assert.deepEqual(verifierConnection(runtimeService, { DATABASE_URL: 'a', [key]: 'b' }), {
    key: 'DATABASE_URL',
    url: 'a',
  });
  assert.deepEqual(verifierConnection(runtimeService, { [key]: 'b' }), { key, url: 'b' });
  assert.match(verifierConnection(runtimeService, {}).error, new RegExp(`${key} is not set`));
});

test('a migrator-verified service is verified only as exactly its migrator — never a superuser or another role (Codex round 3)', () => {
  assert.equal(
    verifierRoleProblem(
      'construction',
      'rasta_construction_migrator|rasta_construction_migrator|f\n',
    ),
    null,
  );
  assert.match(
    verifierRoleProblem('construction', 'rasta|rasta|t'),
    /rasta, a superuser — not rasta_construction_migrator/,
  );
  assert.match(
    verifierRoleProblem('construction', 'rasta_construction|rasta_construction|f'),
    /connected as rasta_construction — not rasta_construction_migrator/,
  );
  assert.match(
    verifierRoleProblem('construction', 'rasta_construction_migrator|rasta_construction|f'),
    /rasta_construction \(SET ROLE rasta_construction_migrator\) — not/,
  );
  assert.match(verifierRoleProblem('construction', ''), /could not tell/);
  const runtimeService = Object.entries(EXPECTED).find(([, entry]) => !entry.connectAs)?.[0];
  if (runtimeService) assert.equal(verifierRoleProblem(runtimeService, 'rasta|rasta|t'), null);
});
