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
  EXCLUDED_DATABASES,
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
});
after(() => {
  try {
    if (created) sql(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`, 'postgres');
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
  const before = snapshot();
  const beforeLedger = ledger();
  command('pg_dump', ['-Fc', '-d', database, '-f', dump]);
  sql(`DROP DATABASE ${database}`, 'postgres');
  command('pg_restore', ['--create', '--exit-on-error', '-d', 'postgres', dump]);
  assert.deepEqual(compareSnapshots(before, snapshot()), {
    tablesEqual: true,
    migrationsEqual: true,
    databaseStateEqual: true,
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
  const expected = actual.filter((db) => !Object.hasOwn(EXCLUDED_DATABASES, db));
  checkDatabaseCoverage(actual, expected);
  assert.throws(() =>
    checkDatabaseCoverage(
      actual,
      expected.filter((db) => db !== database),
    ),
  );
});
