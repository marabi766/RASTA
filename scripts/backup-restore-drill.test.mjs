import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import * as realFs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  discoverSchemaServices,
  discoverEnvServices,
  checkEnvServiceCoverage,
  normalizeSchemaDump,
  schemaDumpEvidence,
  dumpSchema,
  dumpPath,
  collectSchemaReference,
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
  writeReportAtomically,
  reapProcessGroup,
} from './backup-restore-drill-lib.mjs';

const SUFFIX = '0123456789abcdef';
const REF_DB = `drill_ref_${SUFFIX}`;
const FIXED_DB = `drill_fixed_${SUFFIX}`;
// Issues dumps the way the collection boundary does: only dumpSchema can create provenance.
const issue = (database, label, options, body, version = 'pg_dump (PostgreSQL) 16.4') =>
  dumpSchema(database, label, () => ({ raw: dumpFixture(body), version }), options).evidence;

// kind 'source' carries REF built from its own dumps; kind 'restored' is the post-restore side.
function snapshot(kind = 'source', { body, version } = {}) {
  const schemaDump = issue('fixture', kind, undefined, body, version);
  let reference;
  if (kind === 'source') {
    const input = issue('fixture', 'reference-input');
    const ref = issue(REF_DB, 'reference', { restoredFrom: input });
    const fixed = issue(FIXED_DB, 'fixed-point', { restoredFrom: ref });
    reference = schemaReferenceEvidence(
      schemaDump,
      ref,
      fixed,
      checkSourceReference(schemaDump, ref, 'fixture'),
    );
  }
  return {
    ...(reference && { reference }),
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
  const restored = snapshot('restored');
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
  const restored = snapshot('restored');
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
    const restored = snapshot('restored');
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
    const restored = snapshot('restored');
    restored.migrations[0][field] = value;
    assert.equal(compareSnapshots(snapshot(), restored).migrationsEqual, false, field);
  }
});

test('refuses missing, malformed, empty or unfinished evidence', () => {
  for (const restored of [
    null,
    {},
    { tables: {}, migrations: [] },
    { ...snapshot('restored'), tables: { 'public.wallet': 10 } },
    { ...snapshot('restored'), tables: { 'public.wallet': '-1' } },
    { ...snapshot('restored'), migrations: [] },
    { ...snapshot('restored'), migrations: [{ ...snapshot().migrations[0], finished_at: null }] },
    {
      ...snapshot('restored'),
      migrations: [{ ...snapshot().migrations[0], rolled_back_at: '2026-10-23' }],
    },
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
    const restored = snapshot('restored');
    restored.databaseState[field] = value;
    assert.equal(compareSnapshots(snapshot(), restored).databaseStateEqual, false, field);
  }
});

test('same row count with different content fails the digest comparison', () => {
  const restored = snapshot('restored');
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
  const same = ledger();
  assert.equal(compareLedgers(same, same), false, 'SOURCE compared with itself');
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
  const missing = snapshot('restored');
  delete missing.objectState;
  assert.throws(() => compareSnapshots(snapshot(), missing), /Missing object state/);
  for (const field of ['schemas', 'relations', 'defaultPrivileges', 'sequences']) {
    const restored = snapshot('restored');
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
      () => compareSnapshots(snapshot(), { ...snapshot('restored'), schemaDump: evidence }),
      /Missing schema dump/,
    );
  }
});

test('schema gate cannot be omitted and byte mismatch or client version mismatch rejects acceptance', () => {
  const source = snapshot();
  for (const restored of [
    snapshot('restored', { body: 'CREATE TABLE changed (id integer);\n' }),
    snapshot('restored', { version: 'pg_dump (PostgreSQL) 16.5' }),
  ]) {
    const comparison = compareSnapshots(source, restored);
    assert.equal(comparison.schemaDumpEqual, false);
    assert.equal(drillPassed([comparison], 1, ledger(), ledger()), false);
  }
  const comparison = compareSnapshots(source, snapshot('restored'));
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
    "CREATE FUNCTION f() RETURNS text LANGUAGE sql BEGIN ATOMIC\nSELECT CASE WHEN true THEN 'value' ELSE 'other' END;\n-- Name: PRIVATE_ATOMIC; Type: FUNCTION; Schema: private; Owner: owner\nSELECT 'secret';\nEND;\n",
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
    checkConstraints: [
      { schema: 'public', table: 'sample', name: 'same_name' },
      { schema: 'audit', table: 'sample', name: 'same_name' },
    ],
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
    assert.throws(() => compareSnapshots({ ...source, reference }, snapshot('restored')));
  const result = compareSnapshots(source, snapshot('restored'));
  for (const key of ['referenceChecked', 'fixedPointEqual', 'allowanceChecked']) {
    const bypass = { ...result };
    delete bypass[key];
    assert.equal(drillPassed([bypass], 1, ledger(), ledger()), false);
  }
  assert.equal(drillPassed([result], 1, ledger(), ledger()), true);
});

test('dump provenance refuses aliases, forged evidence, wrong databases/labels and mixed invocations', () => {
  const d = (database, label, options, body, version = referenceVersion) =>
    issue(database, label, options, body, version);
  const accept = (a, b, c) =>
    schemaReferenceEvidence(a, b, c, checkSourceReference(a, b, 'fixture'));
  // Each case changes exactly one link of an otherwise valid SOURCE -> input -> REF -> fixed chain.
  const build = ({
    source = d('fixture', 'source'),
    input = d('fixture', 'reference-input'),
    ref = (i) => d(REF_DB, 'reference', { restoredFrom: i }),
    fixed = (r) => d(FIXED_DB, 'fixed-point', { restoredFrom: r }),
  } = {}) => {
    const r = ref(input);
    return [source, r, fixed(r)];
  };
  assert.ok(accept(...build()));
  const source = d('fixture', 'source');
  const input = d('fixture', 'reference-input');
  const [, otherRef] = build();
  const changed = 'CREATE TABLE changed (id integer);\n';
  const [a, b, c] = build();
  for (const bad of [
    [b, b, b],
    [a, b, b],
    [a, a, c],
    [issue('x', 'source'), b, c],
    [a, b, issue('x', 'fixed-point')],
    [a, { ...b, content: b.content }, c],
    build({ source: d('other', 'source') }),
    build({ source: d('fixture', 'restored') }),
    build({ ref: (i) => d(REF_DB, 'fixed-point', { restoredFrom: i }) }),
    build({ ref: (i) => d('drill_ref_fedcba9876543210', 'reference', { restoredFrom: i }) }),
    build({ fixed: (r) => d(REF_DB, 'fixed-point', { restoredFrom: r }) }),
    build({ fixed: (r) => d(FIXED_DB, 'reference', { restoredFrom: r }) }),
    build({ fixed: (r) => d('drill_fixed_fedcba9876543210', 'fixed-point', { restoredFrom: r }) }),
    // Lineage: the restore input is bound, not only the dump outputs.
    build({ ref: () => d(REF_DB, 'reference') }),
    build({ ref: () => d(REF_DB, 'reference', { restoredFrom: source }), source }),
    build({ input: d('other', 'reference-input') }),
    build({ input: d('fixture', 'restored') }),
    build({ input: d('fixture', 'reference-input', undefined, changed) }),
    build({
      input: d('fixture', 'reference-input', undefined, undefined, 'pg_dump (PostgreSQL) 16.5'),
    }),
    build({ fixed: () => d(FIXED_DB, 'fixed-point') }),
    // SOURCE is never itself the product of a restore.
    build({ source: d('fixture', 'source', { restoredFrom: input }) }),
    // The wrong VALID evidence object: SOURCE's separate dump instead of REF.
    build({ input, fixed: () => d(FIXED_DB, 'fixed-point', { restoredFrom: input }) }),
    build({ fixed: () => d(FIXED_DB, 'fixed-point', { restoredFrom: otherRef }) }),
  ])
    assert.throws(() => accept(...bad), /Invalid schema dump provenance/);
  // Unissued or copied evidence can never be named as a restore input.
  for (const forged of [evidence(), { ...input }, { content: input.content }])
    assert.throws(
      () => d(REF_DB, 'reference', { restoredFrom: forged }),
      /Invalid schema dump provenance/,
    );
});

test('compareSnapshots binds the restored dump and SOURCE by provenance and identity', () => {
  const source = snapshot();
  const restored = snapshot('restored');
  assert.ok(compareSnapshots(source, restored));
  // Comparing a database with itself must never pass the gates.
  assert.throws(() => compareSnapshots(source, source), /Invalid restored schema dump provenance/);
  for (const bad of [
    { ...restored, schemaDump: source.schemaDump },
    { ...restored, schemaDump: snapshot().schemaDump },
    { ...restored, schemaDump: issue('other', 'restored') },
    // A restored dump is the archive's own restore, never a derived reference dump.
    { ...restored, schemaDump: issue('fixture', 'restored', { restoredFrom: source.schemaDump }) },
    { ...restored, schemaDump: issue('fixture', 'reference-input') },
    { ...restored, schemaDump: { ...restored.schemaDump, content: restored.schemaDump.content } },
  ])
    assert.throws(() => compareSnapshots(source, bad), /Invalid restored schema dump provenance/);
  // SOURCE with equal bytes, but not the dump REF was built from.
  assert.throws(
    () => compareSnapshots({ ...source, schemaDump: snapshot().schemaDump }, restored),
    /Missing schema reference evidence/,
  );
});

test('collectSchemaReference restores the reference input, then REF, and records each lineage', async () => {
  const sourceDump = issue('fixture', 'source');
  const calls = [];
  const dumped = [];
  const collect = (extra = {}) => ({
    database: 'fixture',
    suffix: SUFFIX,
    sourceDump,
    dump: (name, label, options) => {
      const result = dumpSchema(
        name,
        label,
        () => ({
          raw: dumpFixture(),
          version: referenceVersion,
          path: `/private/${name}-${label}.sql`,
        }),
        options,
      );
      dumped.push({ name, label, restoredFrom: options?.restoredFrom, ...result });
      return result;
    },
    create: (name) => calls.push(['create', name]),
    restore: (name, input) => calls.push(['restore', name, input]),
    drop: (name) => calls.push(['drop', name]),
    ...extra,
  });
  const result = await collectSchemaReference(collect());
  const [separate, reference, fixed] = dumped;
  assert.deepEqual(
    dumped.map(({ name, label }) => [name, label]),
    [
      ['fixture', 'reference-input'],
      [REF_DB, 'reference'],
      [FIXED_DB, 'fixed-point'],
    ],
  );
  // REF is restored from the separate SOURCE dump, the fixed point from REF itself.
  const restores = calls.filter(([kind]) => kind === 'restore');
  assert.deepEqual(
    restores.map(([, name]) => name),
    [REF_DB, FIXED_DB],
  );
  assert.equal(restores[0][2], separate.evidence);
  assert.equal(restores[1][2], reference.evidence);
  assert.equal(reference.restoredFrom, separate.evidence);
  assert.equal(fixed.restoredFrom, reference.evidence);
  assert.equal(dumpPath(restores[1][2]), `/private/${REF_DB}-reference.sql`);
  assert.equal(result.reference, reference.evidence);
  assert.equal(result.fixedPoint, fixed.evidence);
  assert.throws(() => dumpPath(sourceDump), /Missing schema dump file/);
});

test('collectSchemaReference refuses a dump that drops or changes the restore lineage', async () => {
  const sourceDump = issue('fixture', 'source');
  for (const [mode, expected] of [
    ['ignores-lineage', /Invalid schema dump provenance/],
    ['fixed-from-input', /Invalid schema dump provenance/],
    ['ref-from-source', /Invalid schema dump provenance/],
    // A valid, equal-content input that was never the one restored.
    ['ref-from-other-input', /Invalid schema dump provenance/],
  ]) {
    const dropped = [];
    let input;
    await assert.rejects(
      collectSchemaReference({
        database: 'fixture',
        suffix: SUFFIX,
        sourceDump,
        dump: (name, label, options) => {
          const restoredFrom =
            mode === 'ignores-lineage'
              ? undefined
              : mode === 'fixed-from-input' && label === 'fixed-point'
                ? input
                : mode === 'ref-from-source' && label === 'reference'
                  ? sourceDump
                  : mode === 'ref-from-other-input' && label === 'reference'
                    ? issue('fixture', 'reference-input')
                    : options?.restoredFrom;
          const result = dumpSchema(
            name,
            label,
            () => ({ raw: dumpFixture(), version: referenceVersion }),
            { restoredFrom },
          );
          if (label === 'reference-input') input = result.evidence;
          return result;
        },
        create: () => {},
        restore: () => {},
        drop: (name) => dropped.push(name),
      }),
      expected,
      mode,
    );
    assert.deepEqual(dropped, [REF_DB, FIXED_DB], mode);
  }
});

test('scratch DROP failures retain the exact original collection error and attempt both drops', async () => {
  const original = new Error('original collection refusal');
  const dropError = new Error('drop refusal');
  const source = evidence(checkBody);
  const dropped = [],
    failed = [];
  await assert.rejects(
    collectSchemaReference({
      database: 'fixture',
      suffix: '0123456789abcdef',
      sourceDump: source,
      dump: () => ({ path: 'fixture.sql', evidence: source }),
      create: () => {
        throw original;
      },
      restore: () => {},
      drop: (name) => {
        dropped.push(name);
        throw dropError;
      },
      scratchDropFailed: (name, error) => {
        failed.push({ name, error });
      },
    }),
    (error) => error === original,
  );
  assert.deepEqual(dropped, ['drill_ref_0123456789abcdef', 'drill_fixed_0123456789abcdef']);
  assert.deepEqual(
    failed,
    dropped.map((name) => ({ name, error: dropError })),
  );
});

// ---- Atomic report: a kill or failure at any stage leaves a complete, parseable report ----

const provisional = {
  project: 'restore-drill-0123456789abcdef',
  temporary: '/tmp/x',
  passed: false,
};
const complete = { ...provisional, databases: ['x'.repeat(5000)], finishedAt: 'now' };
const reportPaths = () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-report-unit-'));
  return { directory, path: join(directory, 'report.json') };
};
const readReport = (path) => JSON.parse(readFileSync(path, 'utf8'));
const faulty = (stage, onStage = () => {}) => ({
  ...realFs,
  openSync: (...args) => {
    if (stage === 'open' && args[1] === 'wx')
      throw Object.assign(new Error(args[0]), { code: 'EIO' });
    return realFs.openSync(...args);
  },
  writeSync: (...args) => {
    if (stage === 'write') {
      realFs.writeSync(args[0], args[1], args[2], Math.floor(args[3] / 2), args[4]);
      throw Object.assign(new Error('write'), { code: 'ENOSPC' });
    }
    return realFs.writeSync(...args);
  },
  fsyncSync: (...args) => {
    onStage('fsync');
    if (stage === 'fsync') throw Object.assign(new Error('fsync'), { code: 'EIO' });
    return realFs.fsyncSync(...args);
  },
  renameSync: (...args) => {
    onStage('rename');
    if (stage === 'rename') throw Object.assign(new Error(args.join(' ')), { code: 'EXDEV' });
    return realFs.renameSync(...args);
  },
});

test('report is replaced through an exclusive private sibling: write, fsync, rename, then the directory', () => {
  const { directory, path } = reportPaths();
  try {
    const calls = [];
    const record =
      (name) =>
      (...args) => {
        calls.push([name, args[1], args[2], args[0]]);
        return realFs[name](...args);
      };
    const fs = {
      openSync: record('openSync'),
      writeSync: record('writeSync'),
      fsyncSync: record('fsyncSync'),
      closeSync: record('closeSync'),
      renameSync: record('renameSync'),
      unlinkSync: record('unlinkSync'),
    };
    writeReportAtomically(path, provisional, { fs });
    assert.deepEqual(
      calls.map(([name]) => name),
      ['openSync', 'writeSync', 'fsyncSync', 'closeSync', 'renameSync'],
    );
    // Exclusive creation (never through a symlink) with private permissions, beside the report.
    assert.deepEqual(calls[0].slice(1, 3), ['wx', 0o600]);
    assert.match(
      calls[4][3],
      new RegExp(`^${path.replace(/[.]/g, '\\.')}\\.[a-f0-9]{16}\\.tmp$`),
      'sibling',
    );
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readReport(path), provisional);
    // Only a durable write also fsyncs the parent directory.
    calls.length = 0;
    writeReportAtomically(path, complete, { fs, durable: true });
    assert.deepEqual(
      calls.map(([name]) => name),
      [
        'openSync',
        'writeSync',
        'fsyncSync',
        'closeSync',
        'renameSync',
        'openSync',
        'fsyncSync',
        'closeSync',
      ],
    );
    assert.equal(calls[5][1], 'r');
    assert.equal(calls[4][3], calls[0][3], 'the renamed file is the one created');
    assert.deepEqual(readReport(path), complete);
    assert.deepEqual(readdirSync(directory), ['report.json']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('open, write, fsync and rename failures keep the previous report and never quote the path', () => {
  for (const stage of ['open', 'write', 'fsync', 'rename']) {
    const { directory, path } = reportPaths();
    try {
      writeReportAtomically(path, provisional);
      assert.throws(
        () => writeReportAtomically(path, complete, { fs: faulty(stage) }),
        (error) =>
          /^Could not write report \(\w+\)$/.test(error.message) &&
          !error.message.includes(directory),
        stage,
      );
      assert.deepEqual(readReport(path), provisional, stage);
      assert.deepEqual(readdirSync(directory), ['report.json'], `${stage}: sibling removed`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('a directory fsync failure leaves the complete new report and is not reported as durable', () => {
  const { directory, path } = reportPaths();
  try {
    assert.equal(writeReportAtomically(path, provisional, { durable: true }), true);
    assert.equal(writeReportAtomically(path, provisional), false, 'not requested, not claimed');
    const fs = {
      ...realFs,
      fsyncSync: (fd) => {
        if (realFs.fstatSync(fd).isDirectory())
          throw Object.assign(new Error(path), { code: 'EIO' });
        return realFs.fsyncSync(fd);
      },
    };
    assert.equal(writeReportAtomically(path, complete, { fs, durable: true }), false);
    assert.deepEqual(readReport(path), complete);
    assert.deepEqual(readdirSync(directory), ['report.json']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SIGKILL at any stage of the final write leaves the provisional or the complete report', () => {
  // A real process kills itself inside the write; the residue is private and the report parses.
  const library = new URL('./backup-restore-drill-lib.mjs', import.meta.url).href;
  for (const [stage, expected] of [
    ['open', provisional],
    ['write', provisional],
    ['fsync', provisional],
    ['rename', complete],
  ]) {
    const { directory, path } = reportPaths();
    try {
      writeFileSync(
        join(directory, 'child.mjs'),
        `import * as fs from 'node:fs';
import { writeReportAtomically } from ${JSON.stringify(library)};
const [path, stage] = process.argv.slice(2);
const kill = () => process.kill(process.pid, 'SIGKILL');
writeReportAtomically(path, ${JSON.stringify(provisional)});
writeReportAtomically(path, ${JSON.stringify(complete)}, { fs: {
  ...fs,
  openSync: (...a) => { const fd = fs.openSync(...a); if (stage === 'open' && a[1] === 'wx') kill(); return fd; },
  writeSync: (fd, bytes, offset, length, position) => {
    const written = fs.writeSync(fd, bytes, offset, stage === 'write' ? Math.floor(length / 2) : length, position);
    if (stage === 'write') kill();
    return written;
  },
  fsyncSync: (fd) => { fs.fsyncSync(fd); if (stage === 'fsync') kill(); },
  renameSync: (...a) => { fs.renameSync(...a); if (stage === 'rename') kill(); },
} });
`,
      );
      const result = spawnSync(process.execPath, [join(directory, 'child.mjs'), path, stage]);
      assert.equal(result.signal, 'SIGKILL', stage);
      const report = readReport(path);
      assert.deepEqual(report, expected, stage);
      assert.ok(report.project && report.temporary, stage);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      // Residue of the interrupted sibling is private too (and absent once renamed).
      for (const name of readdirSync(directory).filter((entry) => entry.endsWith('.tmp')))
        assert.equal(statSync(join(directory, name)).mode & 0o777, 0o600, `${stage} residue`);
      if (stage !== 'rename')
        assert.equal(readdirSync(directory).filter((entry) => entry.endsWith('.tmp')).length, 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('process groups: nothing left is gone; members are killed and confirmed; survivors are orphans', async () => {
  const waits = [];
  const wait = (ms) => waits.push(ms);
  const group = (states) => {
    const killed = [];
    return {
      killed,
      alive: () => (states.length > 1 ? states.shift() : states[0]),
      kill: (pgid) => killed.push(pgid),
    };
  };
  const gone = group([false]);
  assert.equal(await reapProcessGroup(41, { ...gone, wait }), 'gone');
  assert.deepEqual(gone.killed, []);
  const reaped = group([true, true, false]);
  assert.equal(await reapProcessGroup(42, { ...reaped, wait }), 'reaped');
  assert.deepEqual(reaped.killed, [42]);
  const stuck = group([true]);
  assert.equal(await reapProcessGroup(43, { ...stuck, wait, attempts: 3 }), 'orphan');
  assert.deepEqual(stuck.killed, [43]);
  assert.equal(waits.length, 1 + 3);
});
