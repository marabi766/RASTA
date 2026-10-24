import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  discoverSchemaServices,
  discoverEnvServices,
  checkEnvServiceCoverage,
  normalizeSchemaDump,
  schemaDumpEvidence,
  checkSourceReference,
  schemaReferenceEvidence,
  schemaDiffSummary,
  drillPassed,
  checkServiceCoverage,
  compareSnapshots,
  ledgerPassed,
  compareLedgers,
  checkDatabaseCoverage,
  summarizeTables,
} from './backup-restore-drill-lib.mjs';

function snapshot() {
  const schemaDump = schemaDumpEvidence(dumpFixture(), 'pg_dump (PostgreSQL) 16.4');
  const reference = schemaReferenceEvidence(
    schemaDump,
    schemaDump,
    schemaDump,
    checkSourceReference(schemaDump, schemaDump, 'fixture'),
  );
  return {
    reference,
    schemaDump,
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
    referenceChecked: true,
    fixedPointEqual: true,
    allowanceChecked: true,
    schemaDumpEqual: true,
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

function dumpFixture(body = 'CREATE TABLE public.example (id integer);\n') {
  return Buffer.from(
    '--\n-- PostgreSQL database dump\n--\n\n-- Dumped from database version 16.4\n-- Dumped by pg_dump version 16.4\n\nSET statement_timeout = 0;\n' +
      body +
      '--\n-- PostgreSQL database dump complete\n--\n\n',
  );
}

test('dump normalization removes exactly the two fixed header version lines; all SQL/body/comment bytes survive', () => {
  const body = `CREATE FUNCTION public.fixture() RETURNS text AS $body$
-- Dumped by pg_dump version do not strip me
-- PostgreSQL database dump
RETURN 'PRIVATE_FUNCTION_BODY';
$body$ LANGUAGE sql;
COMMENT ON FUNCTION public.fixture() IS 'PRIVATE_COMMENT';
-- arbitrary SQL comment
`;
  const raw = dumpFixture(body);
  const expected = raw
    .toString()
    .replace('-- Dumped from database version 16.4\n-- Dumped by pg_dump version 16.4\n', '');
  assert.deepEqual(normalizeSchemaDump(raw), Buffer.from(expected));
  assert.ok(normalizeSchemaDump(raw).includes(Buffer.from(body)));
  // Different whitespace, trailing bytes, COMMENT ON text and function bodies must differ.
  for (const change of [
    body + '\n',
    body.replace('PRIVATE_COMMENT', 'CHANGED'),
    body.replace('RETURN', ' RETURN'),
  ]) {
    assert.equal(normalizeSchemaDump(raw).equals(normalizeSchemaDump(dumpFixture(change))), false);
  }
});

test('missing, empty, failed-shaped and truncated dump evidence fails closed', () => {
  for (const raw of [
    undefined,
    Buffer.alloc(0),
    Buffer.from('pg_dump: failed'),
    dumpFixture().subarray(0, -1),
    dumpFixture().subarray(0, -40),
    dumpFixture().subarray(5),
    dumpFixture(''),
  ]) {
    assert.throws(() => schemaDumpEvidence(raw, 'pg_dump (PostgreSQL) 16.4'));
  }
  for (const evidence of [undefined, {}, { bytes: 100, sha256: 'a' }]) {
    assert.throws(
      () => compareSnapshots(snapshot(), { ...snapshot(), schemaDump: evidence }),
      /Missing schema dump/,
    );
  }
});

test('schema gate cannot be omitted and byte mismatch or client version mismatch rejects acceptance', () => {
  const source = snapshot();
  for (const restored of [
    {
      ...snapshot(),
      schemaDump: schemaDumpEvidence(
        dumpFixture('CREATE TABLE changed (id integer);\n'),
        'pg_dump (PostgreSQL) 16.4',
      ),
    },
    { ...snapshot(), schemaDump: schemaDumpEvidence(dumpFixture(), 'pg_dump (PostgreSQL) 16.5') },
  ]) {
    const comparison = compareSnapshots(source, restored);
    assert.equal(comparison.schemaDumpEqual, false);
    assert.equal(drillPassed([comparison], 1, ledger(), ledger()), false);
  }
  const comparison = compareSnapshots(source, snapshot());
  assert.equal(drillPassed([comparison], 1, ledger(), ledger()), true);
  delete comparison.schemaDumpEqual;
  assert.equal(drillPassed([comparison], 1, ledger(), ledger()), false);
});

test('schema diagnostics and JSON disclose only identity and short byte summary', () => {
  const body =
    "-- Name: fixture(); Type: FUNCTION; Schema: public; Owner: owner\nCREATE FUNCTION fixture() AS $$PRIVATE_FUNCTION_BODY$$;\nCOMMENT ON FUNCTION fixture() IS 'PRIVATE_COMMENT';\n";
  const a = schemaDumpEvidence(dumpFixture(body), 'pg_dump (PostgreSQL) 16.4');
  const b = schemaDumpEvidence(
    dumpFixture(body.replace('PRIVATE_FUNCTION_BODY', 'OTHER_BODY')),
    a.version,
  );
  const diff = schemaDiffSummary(a, b);
  assert.equal(diff.identity, 'public.fixture() (FUNCTION)');
  assert.doesNotMatch(
    JSON.stringify({ a, b, diff }),
    /PRIVATE|OTHER_BODY|COMMENT ON|CREATE FUNCTION/,
  );
});

test('third-source discovery ignores migrators and refuses extra, missing, duplicate or empty runtime keys', () => {
  const discovered = discoverEnvServices(
    'DATABASE_URL_ECONOMIC=x\nDATABASE_URL_ECONOMIC_MIGRATOR=y\n',
  );
  assert.deepEqual(discovered, ['economic']);
  assert.deepEqual(discoverEnvServices(' export DATABASE_URL_NEW = x\n'), ['new']);
  checkEnvServiceCoverage(['economic'], discovered);
  for (const configured of [[], ['economic', 'unknown'], ['unknown']])
    assert.throws(() => checkEnvServiceCoverage(['economic'], configured));
  for (const text of ['', 'DATABASE_URL_ECONOMIC=x\nDATABASE_URL_ECONOMIC=y\n'])
    assert.throws(() => discoverEnvServices(text));
});

test('fixed restrict/unrestrict markers are retained byte for byte on modern clients', () => {
  const raw = Buffer.from(
    dumpFixture()
      .toString()
      .replace('-- Dumped from', '\\restrict RastaRestoreDrill\n\n-- Dumped from') +
      '\\unrestrict RastaRestoreDrill\n\n',
  );
  assert.deepEqual(
    normalizeSchemaDump(raw),
    Buffer.from(
      raw
        .toString()
        .replace('-- Dumped from database version 16.4\n-- Dumped by pg_dump version 16.4\n', ''),
    ),
  );
});

test('forged dump identities inside function bodies and COMMENT strings never enter diagnostics', () => {
  for (const sql of [
    "CREATE FUNCTION f() RETURNS text AS $body$\n-- Name: PRIVATE_BODY; Type: FUNCTION; Schema: private; Owner: owner\nRETURN 'secret';\n$body$ LANGUAGE sql;\n",
    "COMMENT ON FUNCTION f() IS 'line\n-- Name: PRIVATE_COMMENT; Type: FUNCTION; Schema: private; Owner: owner\nsecret';\n",
  ]) {
    const body =
      'CREATE TABLE fixture (id integer);\n-- Name: safe(); Type: FUNCTION; Schema: public; Owner: owner\n' +
      sql;
    const a = schemaDumpEvidence(dumpFixture(body), 'pg_dump (PostgreSQL) 16.4');
    const b = schemaDumpEvidence(dumpFixture(body.replace('secret', 'changed')), a.version);
    assert.equal(schemaDiffSummary(a, b).identity, 'public.safe() (FUNCTION)');
  }
});

const referenceVersion = 'pg_dump (PostgreSQL) 16.4';
const checkBody = `CREATE TABLE "public"."sample" (
    "amount" integer DEFAULT 0,
    CONSTRAINT "same_name" CHECK ((amount >= 0))
);
CREATE TABLE "audit"."sample" (
    "amount" integer,
    CONSTRAINT "same_name" CHECK ((amount >= 0))
);
`;
const evidence = (body) => schemaDumpEvidence(dumpFixture(body), referenceVersion);

test('SOURCE/REF allowance scopes identities by database/schema/table/name and preserves multiplicity', () => {
  const source = evidence(checkBody);
  const ref = evidence(checkBody.replaceAll('((amount >= 0))', '(amount >= 0)'));
  assert.deepEqual(checkSourceReference(source, ref, 'rasta_test'), {
    database: 'rasta_test',
    checkLinesDifferent: 2,
  });
  // Honest trust boundary: even a different bound passes this structural guard.
  assert.equal(
    checkSourceReference(source, evidence(checkBody.replaceAll('>= 0', '>= 1')), 'rasta_test')
      .checkLinesDifferent,
    2,
  );
  for (const body of [
    checkBody.replace('DEFAULT 0', 'DEFAULT 1'),
    checkBody.replace('"same_name"', '"renamed"'),
    checkBody.replace('"audit"."sample"', '"other"."sample"'),
    checkBody.replace('"public"."sample"', '"public"."other"'),
    checkBody.replace('    CONSTRAINT "same_name" CHECK ((amount >= 0))\n', ''),
    checkBody + '\n',
    checkBody.replace(
      '    "amount" integer DEFAULT 0,',
      '    CONSTRAINT "same_name" CHECK ((amount >= 0)),',
    ),
  ])
    assert.throws(() => checkSourceReference(source, evidence(body), 'rasta_test'));
});

test('CHECK-looking lines in functions, comments, COMMENT strings and nested SQL never qualify', () => {
  const forged = '    CONSTRAINT "same_name" CHECK ((amount >= 0))';
  for (const body of [
    `CREATE FUNCTION "public"."f"() RETURNS void AS $body$\nCREATE TABLE "public"."sample" (\n${forged}\n);\n$body$ LANGUAGE sql;\n`,
    `COMMENT ON TABLE "public"."sample" IS 'CREATE TABLE "public"."sample" (\n${forged}\n);';\n`,
    `/* outer /* nested */ CREATE TABLE "public"."sample" (\n${forged}\n); */\n`,
    `-- CREATE TABLE "public"."sample" (\n-- ${forged}\n-- );\n`,
    `CREATE FUNCTION "public"."f"() RETURNS void LANGUAGE sql BEGIN ATOMIC\nSELECT CASE WHEN true THEN 1 ELSE 0 END;\nCREATE TABLE "public"."sample" (\n${forged}\n);\nEND;\n`,
    `CREATE FUNCTION "public"."f"() RETURNS text AS E'escaped \\' quote\n${forged}\n' LANGUAGE sql;\n`,
  ]) {
    assert.throws(() =>
      checkSourceReference(
        evidence(checkBody + body),
        evidence(checkBody + body.replace('>= 0', '>= 1')),
        'rasta_test',
      ),
    );
  }
});

test('missing REF, fixed point or allowance and unstable REF cannot pass operator acceptance', () => {
  const source = snapshot();
  const ref = source.schemaDump;
  const allowed = checkSourceReference(ref, ref, 'rasta_test');
  for (const value of [undefined, {}, { database: 'rasta_test', checkLinesDifferent: 0 }])
    assert.throws(() => schemaReferenceEvidence(ref, ref, ref, value));
  for (const fixed of [undefined, {}, evidence(checkBody)])
    assert.throws(() => schemaReferenceEvidence(ref, ref, fixed, allowed));
  for (const reference of [undefined, {}, JSON.parse(JSON.stringify(source.reference))])
    assert.throws(() => compareSnapshots({ ...source, reference }, snapshot()));
  const result = compareSnapshots(source, snapshot());
  for (const key of ['referenceChecked', 'fixedPointEqual', 'allowanceChecked']) {
    const bypass = { ...result };
    delete bypass[key];
    assert.equal(drillPassed([bypass], 1, ledger(), ledger()), false);
  }
  assert.equal(drillPassed([result], 1, ledger(), ledger()), true);
});
