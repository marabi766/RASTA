import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareSnapshots, ledgerPassed } from './backup-restore-drill-lib.mjs';

function snapshot() {
  return {
    tables: { 'public.wallet': '9007199254740993', 'public.empty': '0' },
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
  restored.tables = { 'public.empty': '0', 'public.wallet': '9007199254740993' };
  assert.deepEqual(compareSnapshots(snapshot(), restored), {
    tablesEqual: true,
    migrationsEqual: true,
  });
});

test('detects a single-row mismatch above the safe integer limit', () => {
  const restored = snapshot();
  restored.tables['public.wallet'] = '9007199254740992';
  assert.equal(compareSnapshots(snapshot(), restored).tablesEqual, false);
});

test('detects missing and extra tables, even empty ones and tables in another schema', () => {
  for (const change of [
    (s) => {
      delete s.tables['public.empty'];
    },
    (s) => {
      s.tables['audit.extra'] = '0';
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
