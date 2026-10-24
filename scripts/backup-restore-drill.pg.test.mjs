// Uses PGHOST/PGPORT/PGUSER/PGPASSWORD on an explicitly disposable PostgreSQL.
// Creates its own random database; never reads or writes an existing service database.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INVENTORY_SQL,
  LEDGER_SQL,
  FIXTURE_SQL,
  DATABASE_STATE_SQL,
  DATABASES_SQL,
  discoverSchemaServices,
  OBJECT_STATE_SQL,
  SEQUENCES_SQL,
  MIGRATIONS_SQL,
  compareSnapshots,
  compareLedgers,
  ledgerPassed,
  summarizeTables,
  checkDatabaseCoverage,
  drillPassed,
} from './backup-restore-drill-lib.mjs';

const database = `drill_test_${randomBytes(8).toString('hex')}`;
const directory = mkdtempSync(join(tmpdir(), 'drill-sql-test-'));
const dump = join(directory, 'database.dump');
let created = false;
function command(name, args, input) {
  const result = spawnSync(name, args, { input, encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function sql(input, db = database) {
  return command('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-d', db], input);
}
function snapshot() {
  return {
    tables: Object.fromEntries(
      sql(INVENTORY_SQL)
        .split('\n')
        .map((line) => {
          const { name, ...table } = JSON.parse(line);
          return [name, table];
        }),
    ),
    migrations: JSON.parse(sql(MIGRATIONS_SQL('public'))),
    databaseState: JSON.parse(sql(DATABASE_STATE_SQL)),
    objectState: {
      ...JSON.parse(sql(OBJECT_STATE_SQL)),
      sequences: sql(SEQUENCES_SQL)
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    },
  };
}
const ledger = () => JSON.parse(sql(LEDGER_SQL));

before(() => {
  assert.ok(
    process.env.PGHOST && process.env.PGUSER,
    'Explicit disposable PGHOST and PGUSER required',
  );
  sql(`CREATE DATABASE ${database} TEMPLATE template0`, 'postgres');
  created = true;
  sql(
    `REVOKE ALL ON DATABASE ${database} FROM PUBLIC;
    ALTER DATABASE ${database} SET rasta.disposable_database = 'true';
    ALTER ROLE "${process.env.PGUSER.replaceAll('"', '""')}" IN DATABASE ${database} SET TimeZone = 'UTC';`,
    'postgres',
  );
  sql(
    readFileSync(
      new URL(
        '../services/economic-service/prisma/migrations/20260828202043_init_economic/migration.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  sql(`CREATE EXTENSION postgis;
    CREATE TABLE _prisma_migrations (id text, migration_name text, checksum text,
      finished_at timestamp, rolled_back_at timestamp);
    INSERT INTO _prisma_migrations VALUES ('test', 'test', 'test', '2026-01-01', null);
    INSERT INTO ledger_account (id, organization_id, account_type, account_code, purpose, currency, created_by)
      VALUES ('ACC_SEED_PAYMENT_CLEARING', 'ORG-PLATFORM', 'ASSET', 'TEST-CLEARING', 'PAYMENT_CLEARING', 'IRR', 'test');`);
  sql(FIXTURE_SQL);
  // Stable roles and objects; no cluster-specific OID enters the evidence.
  sql(`CREATE ROLE drill_metadata_owner;
    CREATE ROLE drill_metadata_reader;
    CREATE SCHEMA drill_metadata;
    CREATE TABLE drill_metadata.sample (id integer);
    CREATE TABLE drill_metadata.owned_sample (id integer);
    REVOKE ALL ON drill_metadata.owned_sample FROM PUBLIC;
    CREATE SEQUENCE drill_metadata.counter;
    SELECT setval('drill_metadata.counter', 41, true);
    GRANT SELECT ON drill_metadata.sample TO drill_metadata_reader;
    GRANT USAGE ON SEQUENCE drill_metadata.counter TO drill_metadata_reader;
    ALTER DEFAULT PRIVILEGES IN SCHEMA drill_metadata GRANT SELECT ON TABLES TO drill_metadata_reader;`);
  command('pg_dump', ['-Fc', '-d', database, '-f', dump]);
  sql(`DROP DATABASE ${database}`, 'postgres');
  command('pg_restore', ['--create', '--exit-on-error', '-d', 'postgres', dump]);
});
after(() => {
  try {
    if (created) sql(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`, 'postgres');
    sql(
      'DROP ROLE IF EXISTS drill_metadata_reader; DROP ROLE IF EXISTS drill_metadata_owner;',
      'postgres',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('real inventory separates extension rows and detects equal-count value changes', () => {
  const before = snapshot();
  const summary = summarizeTables(before.tables);
  assert.deepEqual(summary.extension, { tables: 1, nonEmptyTables: 1, rows: '8500' });
  assert.ok(BigInt(summary.application.rows) < 100n);
  sql(`UPDATE ledger_account SET account_code = 'CHANGED' WHERE id = 'ACC_DRILL_WALLET';`);
  try {
    assert.equal(compareSnapshots(before, snapshot()).tablesEqual, false);
  } finally {
    sql(`UPDATE ledger_account SET account_code = 'DRILL-WALLET' WHERE id = 'ACC_DRILL_WALLET';`);
  }
});

test('real ledger SQL returns exact amounts; unbalanced journal and wallet hold mismatch fail', () => {
  assert.equal(ledgerPassed(ledger()), true);
  assert.equal(ledger().fixtureAmount, '9007199254740993');
  for (const [mutation, field] of [
    [
      `ALTER TABLE ledger_entry DISABLE TRIGGER ALL;
      UPDATE ledger_entry SET amount_minor = amount_minor + 1 WHERE id = 'LGE_DRILL_DEBIT';`,
      'journalMismatches',
    ],
    [
      `UPDATE wallet_hold SET status = 'RELEASED', resolved_at = now(), resolved_journal_id = 'JRN_DRILL_HOLD' WHERE id = 'HLD_DRILL';`,
      'walletMismatches',
    ],
  ]) {
    const result = sql(`BEGIN; ${mutation}\n${LEDGER_SQL}\nROLLBACK;`);
    assert.equal(JSON.parse(result)[field], '1');
    assert.equal(ledgerPassed(JSON.parse(result)), false);
  }
});

test('--create restores database ACL, owner, per-role settings, digests and exact ledger amounts; ACL drift fails', () => {
  // pg_dump omits this redundant explicit owner ACL; restored NULL must normalize identically.
  sql('REVOKE ALL ON drill_metadata.owned_sample FROM PUBLIC;');
  const before = snapshot();
  const beforeLedger = ledger();
  command('pg_dump', ['-Fc', '-d', database, '-f', dump]);
  sql(`DROP DATABASE ${database}`, 'postgres');
  command('pg_restore', ['--create', '--exit-on-error', '-d', 'postgres', dump]);
  assert.deepEqual(compareSnapshots(before, snapshot()), {
    tablesEqual: true,
    migrationsEqual: true,
    databaseStateEqual: true,
    objectStateEqual: true,
  });
  assert.equal(compareLedgers(beforeLedger, ledger()), true);
  sql(`GRANT CONNECT ON DATABASE ${database} TO PUBLIC`, 'postgres');
  try {
    const comparison = compareSnapshots(before, snapshot());
    assert.equal(comparison.databaseStateEqual, false);
    assert.equal(drillPassed([comparison], 1, beforeLedger, ledger()), false);
  } finally {
    sql(`REVOKE CONNECT ON DATABASE ${database} FROM PUBLIC`, 'postgres');
  }
});

test('pg_database coverage detects an unlisted real database', () => {
  const actual = JSON.parse(sql(DATABASES_SQL, 'postgres'));
  const expected = [
    ...discoverSchemaServices(new URL('..', import.meta.url).pathname).map(
      (service) => `rasta_${service}`,
    ),
    database,
  ];
  checkDatabaseCoverage(actual, expected);
  assert.throws(() =>
    checkDatabaseCoverage(
      actual,
      expected.filter((db) => db !== database),
    ),
  );
});

for (const [category, mutation, undo] of [
  [
    'table owner',
    'ALTER TABLE drill_metadata.owned_sample OWNER TO drill_metadata_owner',
    `ALTER TABLE drill_metadata.owned_sample OWNER TO "${process.env.PGUSER?.replaceAll('"', '""')}"`,
  ],
  [
    'schema owner',
    'ALTER SCHEMA drill_metadata OWNER TO drill_metadata_owner',
    `ALTER SCHEMA drill_metadata OWNER TO "${process.env.PGUSER?.replaceAll('"', '""')}"`,
  ],
  [
    'table grant',
    'REVOKE SELECT ON drill_metadata.sample FROM drill_metadata_reader',
    'GRANT SELECT ON drill_metadata.sample TO drill_metadata_reader',
  ],
  [
    'sequence grant',
    'REVOKE USAGE ON SEQUENCE drill_metadata.counter FROM drill_metadata_reader',
    'GRANT USAGE ON SEQUENCE drill_metadata.counter TO drill_metadata_reader',
  ],
  [
    'default privileges',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA drill_metadata REVOKE SELECT ON TABLES FROM drill_metadata_reader',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA drill_metadata GRANT SELECT ON TABLES TO drill_metadata_reader',
  ],
  [
    'sequence last_value',
    "SELECT setval('drill_metadata.counter', 42, true)",
    "SELECT setval('drill_metadata.counter', 41, true)",
  ],
  [
    'sequence is_called',
    "SELECT setval('drill_metadata.counter', 41, false)",
    "SELECT setval('drill_metadata.counter', 41, true)",
  ],
]) {
  test(`restored ${category} mutant independently fails the acceptance gate`, () => {
    const source = snapshot();
    const sourceLedger = ledger();
    // before() restored the archive; each mutant changes one category and undoes it below.
    assert.equal(
      drillPassed([compareSnapshots(source, snapshot())], 1, sourceLedger, ledger()),
      true,
    );
    try {
      sql(`${mutation};`);
      const restored = snapshot();
      if (category === 'table owner') {
        assert.equal(
          restored.objectState.relations.find(
            (object) => object.name === 'drill_metadata.owned_sample',
          ).owner,
          'drill_metadata_owner',
        );
      }
      if (category === 'schema owner') {
        assert.equal(
          restored.objectState.schemas.find((object) => object.name === 'drill_metadata').owner,
          'drill_metadata_owner',
        );
      }
      const comparison = compareSnapshots(source, restored);
      assert.equal(comparison.objectStateEqual, false, category);
      assert.equal(drillPassed([comparison], 1, sourceLedger, ledger()), false, category);
    } finally {
      sql(`${undo};`);
    }
    assert.deepEqual(snapshot(), source);
  });
}
