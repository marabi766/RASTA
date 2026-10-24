import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  discoverSchemaServices,
  checkServiceCoverage,
  compareSnapshots,
  ledgerPassed,
  compareLedgers,
  checkDatabaseCoverage,
  summarizeTables,
} from './backup-restore-drill-lib.mjs';

function snapshot() {
  return {
    tables: {
      'public.wallet': { rows: '9007199254740993', kind: 'application', digest: 'a'.repeat(32) },
      'public.empty': { rows: '0', kind: 'application', digest: 'b'.repeat(32) },
    },
    objectState: {
      schemas: [{ name: 'public', owner: 'migrator' }],
      relations: [{ name: 'public.wallet', owner: 'migrator', acl: null }],
      defaultPrivileges: [],
      sequences: [],
    },
    databaseState: { owner: 'migrator', acl: ['migrator=CTc/migrator'], settings: [] },
    migrations: [
      {
        id: 'migration-id',
        migration_name: '20261023_example',
        checksum: 'abc',
        started_at: '2026-10-23T00:00:00',
        finished_at: '2026-10-23T00:00:01',
        rolled_back_at: null,
        logs: null,
        applied_steps_count: 1,
      },
    ],
  };
}

test('identical snapshots pass, independent of table key order', () => {
  const restored = snapshot();
  restored.tables = Object.fromEntries(Object.entries(restored.tables).reverse());
  assert.deepEqual(compareSnapshots(snapshot(), restored), {
    tablesEqual: true,
    migrationsEqual: true,
    databaseStateEqual: true,
    objectStateEqual: true,
  });
});

test('detects a single-row mismatch above the safe integer limit', () => {
  const restored = snapshot();
  restored.tables['public.wallet'].rows = '9007199254740992';
  assert.equal(compareSnapshots(snapshot(), restored).tablesEqual, false);
});

test('detects missing and extra tables, even empty ones and tables in another schema', () => {
  for (const change of [
    (s) => {
      delete s.tables['public.empty'];
    },
    (s) => {
      s.tables['audit.extra'] = { ...s.tables['public.empty'] };
    },
  ]) {
    const restored = snapshot();
    change(restored);
    assert.equal(compareSnapshots(snapshot(), restored).tablesEqual, false);
  }
});

test('compares every migration field, not just migration row counts', () => {
  for (const [field, value] of [
    ['id', 'different-id'],
    ['checksum', 'different'],
    ['logs', 'unexpected'],
    ['finished_at', '2026-10-23T01:00:00'],
    ['applied_steps_count', 2],
    ['migration_name', '20261024_other'],
  ]) {
    const restored = snapshot();
    restored.migrations[0][field] = value;
    assert.equal(compareSnapshots(snapshot(), restored).migrationsEqual, false, field);
  }
});

test('refuses missing, malformed, empty or unfinished evidence', () => {
  for (const restored of [
    null,
    {},
    { tables: {}, migrations: [] },
    { ...snapshot(), tables: { 'public.wallet': 10 } },
    { ...snapshot(), tables: { 'public.wallet': '-1' } },
    { ...snapshot(), migrations: [] },
    { ...snapshot(), migrations: [{ ...snapshot().migrations[0], finished_at: null }] },
    { ...snapshot(), migrations: [{ ...snapshot().migrations[0], rolled_back_at: '2026-10-23' }] },
  ])
    assert.throws(() => compareSnapshots(snapshot(), restored));
});

function ledger() {
  return {
    journalsChecked: '2',
    entriesChecked: '4',
    walletsChecked: '1',
    journalMismatches: '0',
    walletMismatches: '0',
    amountsByCurrency: [{ currency: 'IRR', total: '18014398509486986' }],
    fixtureAmount: '9007199254740993',
  };
}

test('a balanced, populated ledger passes', () => {
  assert.equal(ledgerPassed(ledger()), true);
});

test('refuses either ledger mismatch, even when source and restore share the same corruption', () => {
  for (const field of ['journalMismatches', 'walletMismatches']) {
    assert.equal(ledgerPassed({ ...ledger(), [field]: '1' }), false);
  }
});

test('refuses vacuous financial success and missing or malformed financial evidence', () => {
  for (const field of ['journalsChecked', 'entriesChecked', 'walletsChecked']) {
    assert.equal(ledgerPassed({ ...ledger(), [field]: '0' }), false);
  }
  assert.throws(() => ledgerPassed(null));
  assert.throws(() => ledgerPassed({ ...ledger(), walletMismatches: undefined }));
  assert.throws(() => ledgerPassed({ ...ledger(), walletMismatches: 0 }));
});

test('compares owner, ACL and per-database role settings', () => {
  for (const [field, value] of [
    ['owner', 'rasta'],
    ['acl', null],
    ['settings', [{ role: '*', config: ['TimeZone=Asia/Tehran'] }]],
  ]) {
    const restored = snapshot();
    restored.databaseState[field] = value;
    assert.equal(compareSnapshots(snapshot(), restored).databaseStateEqual, false, field);
  }
});

test('same row count with different content fails the digest comparison', () => {
  const restored = snapshot();
  restored.tables['public.wallet'].digest = 'c'.repeat(32);
  assert.equal(compareSnapshots(snapshot(), restored).tablesEqual, false);
});

test('separates application, migration and extension counts using BigInt', () => {
  const tables = snapshot().tables;
  tables['public.spatial_ref_sys'] = { rows: '8500', kind: 'extension' };
  tables['public._prisma_migrations'] = { rows: '1', kind: 'migration' };
  assert.deepEqual(summarizeTables(tables), {
    application: { tables: 2, nonEmptyTables: 1, rows: '9007199254740993' },
    migration: { tables: 1, nonEmptyTables: 1, rows: '1' },
    extension: { tables: 1, nonEmptyTables: 1, rows: '8500' },
  });
});

test('compares source and restored ledger, amounts and counts even if both balance', () => {
  assert.equal(compareLedgers(ledger(), ledger()), true);
  for (const update of [
    { journalsChecked: '3' },
    { amountsByCurrency: [{ currency: 'IRR', total: '18014398509486987' }] },
  ]) {
    assert.equal(compareLedgers(ledger(), { ...ledger(), ...update }), false);
  }
  assert.throws(() => compareLedgers(ledger(), { ...ledger(), fixtureAmount: '9007199254740992' }));
});

test('database coverage fails on unexpected, missing or malformed databases', () => {
  checkDatabaseCoverage(
    ['rasta_economic', 'keycloak', 'temporal', 'temporal_visibility'],
    ['rasta_economic'],
  );
  for (const actual of [
    null,
    [],
    ['rasta_economic', 'unlisted'],
    ['rasta_other'],
    ['rasta_economic', 'rasta_economic'],
  ]) {
    assert.throws(() => checkDatabaseCoverage(actual, ['rasta_economic']));
  }
});

test('the comparator tests remain wired into verify and the existing CI jobs', async () => {
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(pkg.scripts['test:backup-restore-drill-lib'], /backup-restore-drill\.test\.mjs/);
  assert.match(pkg.scripts['test:backup-restore-drill-pg'], /backup-restore-drill\.pg\.test\.mjs/);
  assert.match(pkg.scripts.verify, /pnpm run test:backup-restore-drill-lib/);
  assert.match(ci, /run: pnpm run test:backup-restore-drill-lib/);
  assert.match(ci, /run: pnpm run test:backup-restore-drill-pg/);
});

test('schema discovery independently rejects a schema missing from RASTA_SERVICES, and reverse drift', () => {
  const root = mkdtempSync(join(tmpdir(), 'drill-coverage-'));
  try {
    assert.throws(() => discoverSchemaServices(root));
    mkdirSync(join(root, 'services'));
    assert.throws(() => discoverSchemaServices(root), /Empty/);
    mkdirSync(join(root, 'services/new-service/prisma'), { recursive: true });
    assert.throws(() => discoverSchemaServices(root));
    writeFileSync(join(root, 'services/new-service/prisma/schema.prisma'), '');
    assert.throws(() => discoverSchemaServices(root), /Empty schema/);
    writeFileSync(join(root, 'services/new-service/prisma/schema.prisma'), 'datasource db {}');
    const discovered = discoverSchemaServices(root);
    assert.deepEqual(discovered, ['new']);
    assert.throws(
      () => checkServiceCoverage(discovered, ['economic']),
      /missing from RASTA_SERVICES \[new\]; absent schemas \[economic\]/,
    );
    checkServiceCoverage(discovered, ['new']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('object evidence is required and each category affects the comparator', () => {
  const missing = snapshot();
  delete missing.objectState;
  assert.throws(() => compareSnapshots(snapshot(), missing), /Missing object state/);
  for (const field of ['schemas', 'relations', 'defaultPrivileges', 'sequences']) {
    const restored = snapshot();
    restored.objectState[field] = [{ drift: field }];
    assert.equal(compareSnapshots(snapshot(), restored).objectStateEqual, false);
  }
});
