import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import * as realFs from 'node:fs';
import { EventEmitter } from 'node:events';
import { execFileSync, spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
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
  InputFileError,
  readRegularFile,
  writeReportAtomically,
  reapProcessGroup,
  createProcessRunner,
  finalizeCleanup,
  verifyResourceKinds,
  KILL_CONFIRMATION_DEADLINE_MS,
} from './backup-restore-drill-lib.mjs';
import {
  adoptPid,
  disposeOwned,
  hasLiveProcesses,
  holdUntil,
  ownedDirectory,
  ownerSettings,
  pollUntil,
  spawnOwned,
  stopOwned,
  waitForGroup,
  waitForPid,
} from './backup-restore-drill-test-support.mjs';
import { shellLoops, spawnViolations, waitViolations } from './backup-restore-drill-test-shell.mjs';

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

// PostgreSQL prints a CASE expression over several physical lines (a real one: identity's
// registration-intake actor constraint) and deparses `ANY ((ARRAY[...])::text[])` differently in
// the reference. The constraint owns every one of its physical lines, and only those.
const caseBody = `CREATE TABLE "public"."intake" (
    "kind" character varying(16) NOT NULL,
    CONSTRAINT "ck_actor" CHECK (
CASE
    WHEN (("kind")::"text" = 'A'::"text") THEN true
    WHEN (("kind")::"text" = ANY ((ARRAY['B'::character varying, 'C'::character varying])::"text"[])) THEN false
    ELSE false
END),
    CONSTRAINT "ck_other" CHECK (("kind" <> ''::"text"))
);
`;
test('a multi-line CHECK may differ on its own lines only, once per constraint', () => {
  const source = evidence(caseBody);
  const ref = evidence(
    caseBody.replace(
      `ANY ((ARRAY['B'::character varying, 'C'::character varying])::"text"[])`,
      `ANY (ARRAY[('B'::character varying)::"text", ('C'::character varying)::"text"])`,
    ),
  );
  assert.deepEqual(checkSourceReference(source, ref, 'rasta_test'), {
    database: 'rasta_test',
    checkLinesDifferent: 1,
    checkConstraints: [{ schema: 'public', table: 'intake', name: 'ck_actor' }],
  });
  // Two of its lines differ: still one constraint.
  const two = evidence(
    caseBody.replace('THEN true', 'THEN (true)').replace(`'B'::character varying, 'C'`, `'B', 'C'`),
  );
  assert.deepEqual(checkSourceReference(source, two, 'rasta_test'), {
    database: 'rasta_test',
    checkLinesDifferent: 2,
    checkConstraints: [{ schema: 'public', table: 'intake', name: 'ck_actor' }],
  });
  // Separated differences (the first WHEN and the ELSE, the line between them unchanged): still
  // one entry, as adjacent ones are.
  const separated = evidence(
    caseBody.replace('THEN true', 'THEN (true)').replace('ELSE false', 'ELSE (false)'),
  );
  assert.deepEqual(checkSourceReference(source, separated, 'rasta_test'), {
    database: 'rasta_test',
    checkLinesDifferent: 2,
    checkConstraints: [{ schema: 'public', table: 'intake', name: 'ck_actor' }],
  });
  // Every line of the span, with and without gaps: one entry.
  const everyOther = evidence(
    caseBody
      .replace('THEN true', 'THEN (true)')
      .replace(`'B'::character varying, 'C'`, `'B', 'C'`)
      .replace('ELSE false', 'ELSE (false)'),
  );
  assert.deepEqual(checkSourceReference(source, everyOther, 'rasta_test'), {
    database: 'rasta_test',
    checkLinesDifferent: 3,
    checkConstraints: [{ schema: 'public', table: 'intake', name: 'ck_actor' }],
  });
  // Two ADJACENT constraints that both changed (the last line of one, the line of the next):
  // two entries, one per constraint.
  const neighbours = evidence(
    caseBody
      .replace('END),\n', 'END ),\n')
      .replace(`CHECK (("kind" <> ''::"text"))`, `CHECK ("kind" <> ''::"text")`),
  );
  assert.deepEqual(checkSourceReference(source, neighbours, 'rasta_test'), {
    database: 'rasta_test',
    checkLinesDifferent: 2,
    checkConstraints: [
      { schema: 'public', table: 'intake', name: 'ck_actor' },
      { schema: 'public', table: 'intake', name: 'ck_other' },
    ],
  });
  for (const body of [
    // outside the constraint: the column, the closing line
    caseBody.replace('character varying(16)', 'character varying(17)'),
    caseBody.replace('\n);\n', '\n) WITH (fillfactor=50);\n'),
    // the structure of the constraint: fewer lines, another name
    caseBody.replace('END),\n', 'END),\n\n'),
    caseBody.replace('    ELSE false\nEND)', '    ELSE false END)'),
    caseBody.replace('"ck_actor"', '"ck_renamed"'),
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

// A stub that holds a process group with a `sleep` inside a shell loop forks a child every poll,
// and a recovery inspecting that group can catch the child mid-exec (its environment reads empty),
// call the group unproven and refuse it: a failure of the stub, not of the drill (#478 follow-up,
// task 278). holdUntil (backup-restore-drill-test-support.mjs) is the one wait that stays a
// single process, and the boundary is the BEHAVIOUR: every fixture source (the test files, the
// support module and the guard itself) is read through its decoded string values, so no spelling
// of a forking poll gets past it.
const FIXTURE_SOURCE = /^backup-restore-drill(?:.*\.test|-test-[a-z]+)\.mjs$/;
const HOLDER_FILE = 'backup-restore-drill-test-support.mjs';

test('no fixture source polls with a forking shell loop, and none starts a child except through the owner', () => {
  const names = readdirSync(new URL('.', import.meta.url)).filter((name) =>
    FIXTURE_SOURCE.test(name),
  );
  for (const expected of [
    'backup-restore-drill.test.mjs',
    'backup-restore-drill-cli.test.mjs',
    'backup-restore-drill-recovery.test.mjs',
    'backup-restore-drill-summary.test.mjs',
    'backup-restore-drill-workflow.test.mjs',
    'backup-restore-drill.pg.test.mjs',
    HOLDER_FILE,
    'backup-restore-drill-test-shell.mjs',
  ])
    assert.ok(names.includes(expected), `${expected} is read (${names.join(', ')})`);
  for (const name of names) {
    const source = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
    assert.deepEqual(waitViolations(source, { holder: name === HOLDER_FILE }), [], name);
    assert.deepEqual(spawnViolations(source, { owner: name === HOLDER_FILE }), [], name);
  }
});

test('the shell-loop guard reads what the shell would run, not how the text is spelled', async () => {
  // The same shell text written into JS source three ways: a quoted string (escapes written out),
  // a template with raw line breaks, and a template with a substitution after it.
  // This file is itself a fixture source and is read by the guard: the loops it must refuse are
  // spelled with a marker inside `do`, which is taken out here, so that no string of this file is
  // a loop.
  const unmark = (text) => text.replaceAll('·', '');
  const spellings = (text) => [
    `const stub = ${JSON.stringify(text)};`,
    'const stub = `' + text.replace(/[\\`]|\$\{/g, (m) => `\\${m}`) + '`;',
    'const stub = `#!/bin/sh\n' + text.replace(/[\\`]|\$\{/g, (m) => `\\${m}`) + '\n${extra}`;',
  ];
  const forms = {
    'the original polling loop': 'while [ ! -f f ]; d·o sleep 0.05; d·one',
    'a no-op before the sleep': 'while [ ! -f f ]; d·o :; sleep 0.05; d·one',
    'a line break after do': 'while [ ! -f f ]; d·o\n  sleep 0.05\ndone',
    'a continued line': 'while [ ! -f f ]; d·o \\\n sleep 0.05; d·one',
    until: 'until [ -f f ]; d·o sleep 1; d·one',
    'a for loop': 'for i in 1 2 3; d·o sleep 1; d·one',
    'another binary': 'while ! test -f f; d·o ls /; d·one',
    'a command substitution': 'while [ ! -f f ]; d·o read -t 1 $(sleep 1); d·one',
    'a loop in a nested shell': "sh -c 'while true; d·o sleep 1; d·one'",
    'a loop in eval': 'eval "until [ -f f ]; d·o :; sleep 1; d·one"',
    'a loop after then': 'if true; then while [ ! -f f ]; d·o sleep 1; d·one; fi',
    'a loop in a group': '{ while [ ! -f f ]; d·o sleep 1; d·one; }',
  };
  for (const [name, marked] of Object.entries(forms))
    for (const source of spellings(unmark(marked))) {
      assert.ok(waitViolations(source).length > 0, `${name}: refused in a test file (${source})`);
      assert.ok(
        waitViolations(source, { holder: true }).some((message) => /forks/.test(message)),
        `${name}: refused even in the holder, whose loop may only run builtins (${source})`,
      );
    }
  // The shell joins a continued line INSIDE a word: a builtin split that way is still the builtin,
  // and a binary split that way is still the binary.
  const continued = (command) => `while [ ! -f f ]; d·o ${command}; d·one`;
  const split = (word) => `${word.slice(0, 2)}\\\n${word.slice(2)}`;
  assert.deepEqual(
    waitViolations(spellings(unmark(continued(`${split('read')} -t 0.05 -u 9 _ || :`)))[0], {
      holder: true,
    }),
    [],
  );
  assert.match(
    waitViolations(spellings(unmark(continued(`${split('sleep')} 1`)))[0], { holder: true }).join(),
    /runs sleep,/,
  );
  // What stays allowed: single waits that are not loops, and holdUntil's own text.
  for (const fine of [
    'exec sleep 30',
    'sleep 60 & echo $! > pid',
    'sleep 1; touch done',
    'waiting for the record to name the group',
  ])
    for (const source of spellings(fine)) assert.deepEqual(waitViolations(source), [], fine);
  const directory = ownedDirectory('drill-guard-holder-');
  try {
    const held = holdUntil(directory, join(directory, 'release'));
    for (const source of spellings(held)) {
      assert.deepEqual(waitViolations(source, { holder: true }), [], source);
      assert.equal(waitViolations(source).length, 1, 'a test file may not spell it out itself');
    }
    assert.equal(shellLoops(held).length, 1);
    assert.deepEqual(shellLoops(held)[0].commands.sort(), [':', '[', 'read']);
  } finally {
    await disposeOwned(directory);
  }
});

test('the spawn guard refuses every route to an asynchronous child that skips the owner', () => {
  for (const source of [
    "import { spawn } from 'node:child_process';",
    "import { exec, execFileSync } from 'child_process';",
    "import { spawn as launch } from 'node:child_process';",
    "import { fork } from 'node:child_process';",
    "import * as cp from 'node:child_process';",
    "import cp from 'node:child_process';",
    "const cp = await import('node:child_process');",
    "const cp = createRequire(import.meta.url)('child_process');",
  ])
    assert.ok(spawnViolations(source).length > 0, source);
  for (const source of [
    "import { execFileSync, spawnSync } from 'node:child_process';",
    "import { spawnSync as run } from 'node:child_process';",
    "const name = 'node:child_process';",
  ])
    assert.deepEqual(spawnViolations(source), [], source);
  assert.deepEqual(
    spawnViolations("import { spawn } from 'node:child_process';", { owner: true }),
    [],
  );
});

test('waitForPid returns only a whole pid line; an empty or partial file is not a pid', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-support-pid-'));
  try {
    const path = join(directory, 'pid');
    // `echo $$ > file` creates the file before it writes: both states must keep the wait going.
    writeFileSync(path, '');
    await assert.rejects(waitForPid(path, 150), /timed out after 150 ms waiting for a process id/);
    writeFileSync(path, '4242');
    await assert.rejects(waitForPid(path, 150), /timed out/);
    writeFileSync(path, '0\n');
    await assert.rejects(waitForPid(path, 150), /timed out/);
    const waiting = waitForPid(path);
    await sleep(60);
    writeFileSync(path, '4242\n');
    assert.equal(await waiting, 4242);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('holdUntil keeps its process group at ONE process while it waits, then exits 0 when the file appears', async () => {
  const directory = ownedDirectory('drill-support-hold-');
  try {
    const release = join(directory, 'release');
    const members = (pgid) =>
      spawnSync('ps', ['-eo', 'pid=,pgid='], { encoding: 'utf8' })
        .stdout.split('\n')
        .filter((line) => Number(line.trim().split(/\s+/)[1]) === pgid).length;
    const holder = spawnOwned(directory, '/bin/bash', ['-c', holdUntil(directory, release)], {
      detached: true,
      stdio: 'ignore',
    });
    const exited = new Promise((resolve) => holder.once('exit', (code) => resolve(code)));
    await new Promise((resolve) => holder.once('spawn', resolve));
    // A forking poll would put a short-lived `sleep` into the group every 50 ms: sample across
    // many polls (about a second) and never see a second member.
    let most = 0;
    for (let sample = 0; sample < 40; sample++) {
      most = Math.max(most, members(holder.pid));
      await sleep(25);
    }
    assert.equal(most, 1, 'the waiting group is the shell alone');
    writeFileSync(release, '');
    assert.equal(await exited, 0, 'the status of the last timed-out read is not the stub’s status');
  } finally {
    await disposeOwned(directory);
  }
});

test('pollUntil accepts a condition only if it is seen within the budget (monotonic deadline)', async () => {
  // Driven clock: the first reading fixes the deadline (0 + 5), the second follows the check.
  const clock =
    (...readings) =>
    () =>
      readings.shift();
  assert.equal(await pollUntil(() => 'seen', 'x', 5, clock(0, 4)), 'seen');
  await assert.rejects(
    pollUntil(() => 'seen', 'a late condition', 5, clock(0, 6)),
    /timed out after 5 ms waiting for a late condition \(seen only after the deadline\)/,
    'true on the first check, but observed after the deadline',
  );
  await assert.rejects(
    pollUntil(() => 'seen', 'x', 5, clock(0, 5)),
    /timed out/,
    'the deadline itself is already late',
  );
  // The reviewed case on the real clock: false at first, true at the next check, which comes one
  // 25 ms tick later, past a 5 ms budget.
  let checks = 0;
  await assert.rejects(
    pollUntil(() => ++checks === 2, 'a second look', 5),
    /timed out after 5 ms waiting for a second look \(seen only after the deadline\)/,
  );
  assert.equal(checks, 2);
  // Never true: the budget message without the late-observation suffix.
  await assert.rejects(
    pollUntil(() => false, 'nothing', 30),
    /waiting for nothing$/,
  );
  // A check that throws is not swallowed.
  await assert.rejects(
    pollUntil(() => {
      throw new RangeError('boom');
    }, 'x'),
    RangeError,
  );
  assert.equal(await pollUntil(() => 7, 'x'), 7, 'the default budget accepts a prompt answer');
});

// --- the fixture owner (task 283: every process a fixture starts, stopped and confirmed gone
// --- BEFORE its directory is removed) --------------------------------------------------------
test('the fixture owner records a child at spawn and stops it, confirmed, before the directory goes', async () => {
  const directory = ownedDirectory('drill-owner-spawn-');
  // Nothing about this process names the directory: only the registration made by the spawn can
  // tell the owner it is the fixture's.
  const child = spawnOwned(directory, 'sleep', ['60'], { detached: true, stdio: 'ignore' });
  const pgid = child.pid;
  assert.equal(
    hasLiveProcesses(directory),
    true,
    'registered by the spawn, before anything awaited',
  );
  await disposeOwned(directory);
  // Nothing of it runs when dispose returns; the zombie this process has yet to reap is not it.
  await pollUntil(() => !groupExists(pgid), 'the group to be reaped');
  assert.equal(existsSync(directory), false);
});

test('the fixture owner also finds a group nobody registered: its environment names the directory', async () => {
  const directory = ownedDirectory('drill-owner-sweep-');
  const pidFile = join(directory, 'grandchild');
  // The parent starts a child in a NEW session and group (what a drill-spawned stub is) and holds.
  spawnOwned(
    directory,
    '/bin/bash',
    [
      '-c',
      `setsid sleep 600 </dev/null >/dev/null 2>&1 & echo $! > '${pidFile}'; ${holdUntil(directory, join(directory, 'release'))}`,
    ],
    { env: { ...process.env, PATH: `${directory}:${process.env.PATH}` }, stdio: 'ignore' },
  );
  const grandchild = await waitForPid(pidFile);
  assert.equal(pidAlive(grandchild), true);
  await disposeOwned(directory);
  await pollUntil(() => !pidAlive(grandchild), 'the unregistered member to be reaped', 5_000);
});

test('a group whose pid a test reads from a file is owned from then on, whatever it carries', async () => {
  const directory = ownedDirectory('drill-owner-adopt-');
  const pidFile = join(directory, 'leader');
  // The started shell names the directory in its command line, the group it starts does not: no
  // environment variable, no argument. Only adopting the pid makes it the fixture's.
  spawnOwned(
    directory,
    '/bin/bash',
    ['-c', `setsid sleep 600 </dev/null >/dev/null 2>&1 & echo $! > '${pidFile}'; exec sleep 600`],
    { stdio: 'ignore' },
  );
  const leader = await waitForGroup(directory, pidFile);
  assert.equal(pidAlive(leader), true);
  await disposeOwned(directory);
  await pollUntil(() => !pidAlive(leader), 'the adopted group to be reaped', 5_000);
});

test('a fixture that cannot confirm its processes gone keeps its directory and fails', async () => {
  const directory = ownedDirectory('drill-owner-survivor-');
  spawnOwned(directory, '/bin/bash', ['-c', holdUntil(directory, join(directory, 'release'))], {
    detached: true,
    stdio: 'ignore',
  });
  const budget = ownerSettings.stopBudgetMs;
  try {
    // No time to confirm anything: the stop is reported unconfirmed and nothing is removed.
    ownerSettings.stopBudgetMs = 0;
    await assert.rejects(disposeOwned(directory), /timed out after 0 ms waiting for the fixture/);
    assert.equal(existsSync(directory), true, 'the directory stays while a process is unconfirmed');
  } finally {
    ownerSettings.stopBudgetMs = budget;
    await disposeOwned(directory);
  }
  assert.equal(existsSync(directory), false);
});

test('a directory the owner did not create cannot hold or start anything', () => {
  const stranger = mkdtempSync(join(tmpdir(), 'drill-owner-stranger-'));
  try {
    assert.throws(() => holdUntil(stranger, join(stranger, 'r')), /not created by ownedDirectory/);
    assert.throws(() => spawnOwned(stranger, 'true', []), /not created by ownedDirectory/);
    return assert.rejects(stopOwned(stranger), /not created by ownedDirectory/);
  } finally {
    rmSync(stranger, { recursive: true, force: true });
  }
});

test('the after-hook fails a test that ends with a fixture process alive, and stops that process', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-hook-'));
  try {
    const support = new URL('./backup-restore-drill-test-support.mjs', import.meta.url).href;
    const pidFile = join(directory, 'pid');
    writeFileSync(
      join(directory, 'leak.test.mjs'),
      `import { test } from 'node:test';
import { holdUntil, ownedDirectory, spawnOwned, waitForPid } from ${JSON.stringify(support)};
test('leaks a held process', async () => {
  const fixture = ownedDirectory('drill-hook-leak-');
  spawnOwned(fixture, '/bin/bash', ['-c', "echo $$ > '${pidFile}'; " + holdUntil(fixture, fixture + '/release')], {
    detached: true,
    stdio: 'ignore',
  });
  await waitForPid(${JSON.stringify(pidFile)});
});
test('a test that disposes is not blamed', async () => {});
`,
    );
    const result = spawnSync(
      process.execPath,
      ['--test', '--test-reporter=tap', join(directory, 'leak.test.mjs')],
      {
        encoding: 'utf8',
        timeout: 60_000,
        killSignal: 'SIGKILL',
        // Inside a test run this variable makes a nested `node --test` skip its files.
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      },
    );
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /not ok 1 - leaks a held process/);
    assert.match(result.stdout, /the test left processes of its fixture running/);
    assert.match(result.stdout, /\nok 2 - a test that disposes is not blamed/);
    const leaked = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(leaked > 0);
    await pollUntil(() => !pidAlive(leaked), 'the leaked process to be reaped');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// The process lifecycle boundary: real children for what the kernel decides, a fake spawn for
// the orderings a real child cannot be forced into.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const groupExists = (pgid) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function becomesGone(pid) {
  await pollUntil(() => !pidAlive(pid), `process ${pid} to exit`);
  return true;
}
function fakeChild(pid) {
  const child = new EventEmitter();
  Object.assign(child, {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
  });
  child.finish = (code) => {
    child.emit('exit', code, null);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', code, null);
  };
  return child;
}
// Real children are started through the fixture owner of `directory`, so a test that fails before
// its own cleanup leaves nothing running.
const realRunner = (directory, overrides = {}) =>
  createProcessRunner({
    report: {},
    persist: () => {},
    cwd: tmpdir(),
    env: { PATH: process.env.PATH },
    drainMilliseconds: 200,
    spawn: (command, args, options) => spawnOwned(directory, command, args, options),
    ...overrides,
  });

test('a leader that exits 0 while a descendant holds stdout/stderr is reaped long before the timeout and recorded', async () => {
  const directory = ownedDirectory('drill-runner-');
  try {
    const report = {};
    const runner = realRunner(directory, { report });
    const started = Date.now();
    const output = await runner.run(
      '/bin/sh',
      ['-c', `sleep 60 & echo $! > '${directory}/pid'; echo leader-output`],
      { timeout: 60_000 },
    );
    const descendant = Number(readFileSync(join(directory, 'pid'), 'utf8'));
    adoptPid(directory, descendant);
    assert.equal(output, 'leader-output');
    // The drain bound is 200 ms and the timeout a minute: half the timeout still tells them apart
    // by two orders of magnitude, so a loaded machine cannot turn a pass into a failure.
    assert.ok(Date.now() - started < 30_000, 'reaped by the drain bound, not the 60 s timeout');
    assert.equal(report.reapedProcessGroups.length, 1);
    assert.equal(report.orphanProcessGroups, undefined);
    assert.deepEqual(report.processGroups, []);
    assert.ok(await becomesGone(descendant), 'the descendant holding the pipes is gone');
  } finally {
    await disposeOwned(directory);
  }
});

test('a timeout is a failure whatever exit code follows the kill', async () => {
  const kills = [];
  const child = fakeChild(424242);
  const runner = createProcessRunner({
    report: {},
    persist: () => {},
    spawn: () => child,
    // The kill takes effect the way SIGKILL does: the child exits (here with code 0).
    kill: (pgid) => {
      kills.push(pgid);
      child.finish(0);
    },
    reap: async () => 'gone',
  });
  const command = runner.run('slow', [], { timeout: 30, privateOutput: true, database: 'rasta_x' });
  await assert.rejects(command, (error) => {
    assert.deepEqual(error.privateFailure, {
      stage: undefined,
      database: 'rasta_x',
      exitCode: 0,
      timedOut: true,
    });
    return true;
  });
  assert.deepEqual(kills, [424242]);
  const plain = fakeChild(424243);
  const second = createProcessRunner({
    report: {},
    persist: () => {},
    spawn: () => plain,
    kill: () => plain.finish(0),
    reap: async () => 'gone',
  }).run('slow', [], { timeout: 30 });
  await assert.rejects(second, /Command timed out \(exit 0\)/);
});

test('a persist failure right after spawn still reaps the group and confirms it is gone', async () => {
  const directory = ownedDirectory('drill-runner-persist-');
  try {
    const reaped = [];
    const failed = [];
    const report = {};
    const runner = realRunner(directory, {
      report,
      persist: () => {
        throw new Error('Could not write report (ENOSPC)');
      },
      persistFailed: (stage) => failed.push(stage),
      currentStage: () => 'migrate identity',
      reap: (pgid) => {
        reaped.push(pgid);
        return reapProcessGroup(pgid);
      },
    });
    await assert.rejects(
      runner.run('/bin/sh', ['-c', 'sleep 60 & wait']),
      /Could not record process group/,
    );
    assert.equal(reaped.length, 1, 'the group went through the reap, not a single kill');
    assert.deepEqual(failed, ['migrate identity']);
    assert.equal(runner.groups.size, 0);
    assert.deepEqual(report.processGroups, []);
    // The group, whatever it had forked by then, is confirmed gone.
    assert.throws(() => process.kill(-reaped[0], 0), /ESRCH/);
  } finally {
    await disposeOwned(directory);
  }
});

test('a group that survives the kill after a persist failure stays owned and is reported', async () => {
  const child = fakeChild(424250);
  const kills = [];
  const report = {};
  const runner = createProcessRunner({
    report,
    persist: () => {
      throw new Error('Could not write report (EIO)');
    },
    spawn: () => child,
    kill: (pgid) => kills.push(pgid),
    reap: async () => 'orphan',
  });
  const command = runner.run('x', []);
  child.finish(null);
  await assert.rejects(command, /Could not record process group/);
  assert.deepEqual(kills, [424250]);
  assert.deepEqual([...runner.groups], [424250]);
  assert.deepEqual(report.processGroups, [424250]);
  assert.deepEqual(report.orphanProcessGroups, [424250]);
});

test('a cleanup command continues after a persist failure, which is still reported', async () => {
  const child = fakeChild(424260);
  const failed = [];
  const runner = createProcessRunner({
    report: {},
    persist: () => {
      throw new Error('Could not write report (EACCES)');
    },
    persistFailed: (stage) => failed.push(stage),
    currentStage: () => 'cleanup',
    spawn: () => child,
    kill: () => assert.fail('a cleanup command is not killed for an unrecorded group'),
    reap: async () => 'gone',
  });
  const command = runner.run('down', [], { cleanup: true });
  child.stdout.write('done\n');
  child.finish(0);
  assert.equal(await command, 'done');
  assert.deepEqual(failed, ['cleanup']);
});

test('an orphan stays owned: in the report list, the signal set and the retry set until it is gone', async () => {
  const listed = [];
  const kills = [];
  const report = {};
  const first = fakeChild(424270);
  const second = fakeChild(424271);
  const queue = [first, second];
  const survivors = new Set([424270]);
  const runner = createProcessRunner({
    report,
    persist: () => listed.push([...report.processGroups]),
    spawn: () => queue.shift(),
    kill: (pgid) => kills.push(pgid),
    reap: async (pgid) => (survivors.has(pgid) ? 'orphan' : 'gone'),
  });
  const one = runner.run('a', []);
  first.finish(0);
  // The command itself succeeded; only the group's disappearance is unconfirmed.
  assert.equal(await one, '');
  assert.deepEqual(report.processGroups, [424270]);
  assert.deepEqual(report.orphanProcessGroups, [424270]);
  assert.equal(report.reapedProcessGroups.length, 1);
  // A later command persists the orphan alongside its own group: the runbook list keeps it.
  const two = runner.run('b', []);
  assert.deepEqual(listed.at(-1), [424270, 424271]);
  second.finish(0);
  await two;
  assert.deepEqual(report.processGroups, [424270]);
  // Signals retry it, before and during cleanup.
  runner.stopActive();
  runner.killOrphans();
  assert.deepEqual(kills, [424270, 424270]);
  // A retry that still finds it keeps it owned; the one that finds it gone releases it.
  await runner.retryOrphans();
  assert.deepEqual([...runner.orphans], [424270]);
  assert.deepEqual(report.orphanProcessGroups, [424270]);
  survivors.clear();
  await runner.retryOrphans();
  assert.equal(runner.groups.size, 0);
  assert.deepEqual(report.processGroups, []);
  assert.deepEqual(report.orphanProcessGroups, []);
  assert.equal(report.reapedProcessGroups.length, 1, 'a retry does not record the group twice');
});

test('an error event on a child that has a pid still settles its group', async () => {
  const child = fakeChild(424280);
  const reaped = [];
  const runner = createProcessRunner({
    report: {},
    persist: () => {},
    spawn: () => child,
    kill: () => {},
    reap: async (pgid) => {
      reaped.push(pgid);
      return 'orphan';
    },
  });
  const command = runner.run('x', [], { privateOutput: true, database: 'rasta_x' });
  child.emit('error', new Error('boom'));
  await assert.rejects(command, (error) => error.privateFailure.exitCode === null);
  assert.deepEqual(reaped, [424280]);
  assert.deepEqual([...runner.groups], [424280], 'unconfirmed: still owned');
  assert.equal(
    await createProcessRunner({
      report: {},
      persist: () => {},
      spawn: () => {
        const noPid = fakeChild(undefined);
        queueMicrotask(() => noPid.emit('error', new Error('ENOENT')));
        return noPid;
      },
    })
      .run('missing', [])
      .catch((error) => error.message),
    'Could not start command',
  );
});

// A runner on fake children: `children[pgid]` is finished by the test; `reap` is injectable.
function fakeRunner(pgids, { reap = async () => 'gone', report = {} } = {}) {
  const children = new Map(pgids.map((pgid) => [pgid, fakeChild(pgid)]));
  const queue = [...children.values()];
  const runner = createProcessRunner({
    report,
    persist: () => {},
    spawn: () => queue.shift(),
    kill: () => {},
    reap,
  });
  return { runner, children, report };
}

test('settleAll waits for every command, siblings of a rejected one included, and their reaps', async () => {
  const reaped = [];
  const { runner, children } = fakeRunner([5001, 5002, 5003], {
    reap: async (pgid) => {
      await sleep(40);
      reaped.push(pgid);
      return 'gone';
    },
  });
  const commands = [1, 2, 3].map(() => runner.run('x', []));
  // The first command fails at once (what a Promise.all consumer would stop at).
  children.get(5001).finish(1);
  await assert.rejects(commands[0], /Command failed/);
  let barrier = false;
  const waiting = runner.settleAll().then(() => {
    barrier = true;
  });
  await sleep(120);
  assert.equal(barrier, false, 'two siblings are still running');
  assert.deepEqual(reaped, [5001]);
  children.get(5002).finish(0);
  await sleep(120);
  assert.equal(barrier, false, 'one sibling is still running');
  children.get(5003).finish(0);
  await waiting;
  assert.deepEqual(reaped.sort(), [5001, 5002, 5003], 'every group was reaped before the barrier');
  assert.equal(runner.groups.size, 0);
  await Promise.all(commands.slice(1));
});

test('settleAll also waits for a command started while it waits, and never rejects', async () => {
  const { runner, children } = fakeRunner([5011, 5012]);
  const first = runner.run('a', []);
  let barrier = false;
  const waiting = runner.settleAll().then(() => {
    barrier = true;
  });
  const second = runner.run('b', []);
  children.get(5011).finish(2);
  await assert.rejects(first);
  await sleep(40);
  assert.equal(barrier, false);
  children.get(5012).finish(0);
  await second;
  await waiting;
  assert.equal(barrier, true);
});

test('verifyResourceKinds keeps every outcome: no short-circuit on the first rejection', async () => {
  const finished = [];
  const result = await verifyResourceKinds(['container', 'volume', 'network'], async (kind) => {
    if (kind === 'container') throw new Error('exit 1');
    await sleep(kind === 'volume' ? 40 : 80);
    finished.push(kind);
    return kind === 'volume' ? 'abc123' : '';
  });
  assert.deepEqual(finished, ['volume', 'network'], 'resolved only after every check settled');
  assert.deepEqual(result, { leftovers: ['volume'], unverified: ['container'] });
});

test('the reviewer trigger: a failing container check while volume and network still run', async () => {
  const reaped = [];
  const report = {};
  const { runner, children } = fakeRunner([5021, 5022, 5023], {
    report,
    reap: async (pgid) => {
      reaped.push(pgid);
      return 'gone';
    },
  });
  let verdictAt;
  const verdict = finalizeCleanup({
    runner,
    report,
    teardown: async () => {
      // A Promise.all consumer: rejects as soon as the first check does, siblings keep running.
      await Promise.all(['container', 'volume', 'network'].map(() => runner.run('docker', [])));
    },
  }).then((value) => {
    verdictAt = reaped.length;
    return value;
  });
  await sleep(30);
  children.get(5021).finish(1);
  await sleep(80);
  assert.equal(verdictAt, undefined, 'no verdict while two checks are still running');
  assert.equal(runner.groups.size, 2);
  children.get(5022).finish(0);
  await sleep(40);
  assert.equal(verdictAt, undefined, 'no verdict while one check is still running');
  children.get(5023).finish(0);
  const result = await verdict;
  assert.equal(verdictAt, 3, 'every group was reaped and recorded before the verdict');
  assert.equal(result.passed, false);
  assert.equal(runner.groups.size, 0);
  assert.equal(
    report.reapedProcessGroups,
    undefined,
    'groups that were already gone are not listed',
  );
});

test('a sibling that only becomes an orphan after the failed step is retried before the verdict', async () => {
  const seen = new Map();
  const report = {};
  const { runner, children } = fakeRunner([5041, 5042], {
    report,
    // The first reap of 5042 finds a survivor; the retry finds it gone.
    reap: async (pgid) => {
      seen.set(pgid, (seen.get(pgid) ?? 0) + 1);
      return pgid === 5042 && seen.get(pgid) === 1 ? 'orphan' : 'gone';
    },
  });
  const verdict = finalizeCleanup({
    runner,
    report,
    teardown: async () => {
      await Promise.all([runner.run('a', []), runner.run('b', [])]);
    },
  });
  await sleep(20);
  children.get(5041).finish(1);
  await sleep(40);
  children.get(5042).finish(0);
  const result = await verdict;
  assert.deepEqual(result.orphanRetry, { retried: [5042], remaining: [] });
  assert.equal(seen.get(5042), 2, 'retried after it settled');
  assert.deepEqual(report.orphanProcessGroups, []);
  assert.equal(result.passed, false, 'the failed step still fails the cleanup');
});

test('teardown starts only after a command still running from earlier has settled', async () => {
  const { runner, children } = fakeRunner([5051]);
  const earlier = runner.run('main-step', []);
  const order = [];
  const verdict = finalizeCleanup({
    runner,
    report: {},
    teardown: async () => {
      order.push('teardown');
    },
  });
  await sleep(40);
  assert.deepEqual(order, [], 'the earlier command is still running');
  children.get(5051).finish(0);
  await earlier;
  assert.equal((await verdict).passed, true);
  assert.deepEqual(order, ['teardown']);
});

// One orphan (group 5031) known before cleanup starts; the retry finds it gone or not.
async function cleanupWithOrphan(teardown, { survives }) {
  const alive = new Set([5031]);
  const report = {};
  const { runner, children } = fakeRunner([5031], {
    report,
    reap: async (pgid) => (survives && alive.has(pgid) ? 'orphan' : 'gone'),
  });
  const first = runner.run('earlier', []);
  children.get(5031).finish(0);
  await first;
  if (!survives) {
    // The orphan existed when the cleanup began; only the retry sees it disappear.
    runner.orphans.add(5031);
    runner.groups.add(5031);
    report.processGroups = [5031];
    report.orphanProcessGroups = [5031];
  }
  assert.deepEqual(report.orphanProcessGroups, [5031]);
  const verdict = await finalizeCleanup({ runner, report, teardown: () => teardown(runner) });
  return { verdict, report, runner };
}

for (const [name, teardown] of [
  [
    'compose down rejects',
    async () => {
      throw new Error('compose down failed');
    },
  ],
  [
    'the resource listing rejects',
    async () => {
      // `down` succeeded; then the enumeration itself throws.
      await verifyResourceKinds(['container'], async () => 'x');
      throw new Error('docker ls failed');
    },
  ],
  [
    'a resource check rejects (all-settled outcome)',
    () =>
      verifyResourceKinds(['container', 'volume', 'network'], async (kind) => {
        if (kind === 'volume') throw new Error('exit 1');
        return '';
      }),
  ],
]) {
  test(`a known orphan is retried and the outcome recorded when ${name}`, async () => {
    const stillThere = await cleanupWithOrphan(teardown, { survives: true });
    assert.equal(stillThere.verdict.passed, false);
    assert.deepEqual(stillThere.verdict.orphanRetry, { retried: [5031], remaining: [5031] });
    assert.deepEqual(stillThere.report.orphanProcessGroups, [5031], 'still owned for recovery');
    const released = await cleanupWithOrphan(teardown, { survives: false });
    assert.equal(released.verdict.passed, false, 'the failed step still fails the cleanup');
    assert.deepEqual(released.verdict.orphanRetry, { retried: [5031], remaining: [] });
    assert.deepEqual(released.report.orphanProcessGroups, [], 'the retry released the group');
    assert.deepEqual(released.report.processGroups, []);
  });
}

test('a clean teardown with a released orphan passes and records the retry', async () => {
  const { verdict } = await cleanupWithOrphan(async () => ({ leftovers: [], unverified: [] }), {
    survives: false,
  });
  assert.equal(verdict.passed, true);
  assert.deepEqual(verdict.orphanRetry, { retried: [5031], remaining: [] });
});

test('leftover resources and unverified kinds fail the verdict', async () => {
  const { runner, report } = fakeRunner([]);
  for (const torn of [{ leftovers: ['volume'] }, { unverified: ['network'] }]) {
    const verdict = await finalizeCleanup({ runner, report, teardown: async () => torn });
    assert.equal(verdict.passed, false);
  }
  assert.equal(
    (await finalizeCleanup({ runner, report, teardown: async () => ({}) })).passed,
    true,
  );
});

// A child that survives SIGKILL (uninterruptible I/O) and NEVER emits exit/close/error: the
// fake `kill` only records. Each stop reason must still end at the runner's own deadline.
const NEVER_EXITS = 150;
const stopReasons = [
  ['timeout', (runner) => runner.run('slow', [], { timeout: 20, privateOutput: true }), 'timeout'],
  [
    'timeout of a cleanup command',
    (runner) => runner.run('down', [], { timeout: 20, cleanup: true, privateOutput: true }),
    'timeout',
  ],
  [
    'output overflow',
    (runner, child) => {
      const command = runner.run('noisy', [], { timeout: 60_000, privateOutput: true });
      child.stdout.write('0123456789');
      return command;
    },
    'output',
  ],
  [
    'a group whose pgid could not be persisted',
    (runner) => runner.run('x', [], { timeout: 60_000, privateOutput: true }),
    'unrecorded',
    {
      persist: () => {
        throw new Error('Could not write report (EIO)');
      },
    },
  ],
  [
    'stopActive() (a signal)',
    (runner) => {
      const command = runner.run('long', [], { timeout: 60_000, privateOutput: true });
      runner.stopActive();
      return command;
    },
    'signal',
  ],
];
for (const [name, start, reason, extra = {}] of stopReasons) {
  test(`a command that never exits after SIGKILL (${name}) is released at the kill deadline, unconfirmed and recorded`, async () => {
    const child = fakeChild(424900);
    const kills = [];
    const report = {};
    const runner = createProcessRunner({
      report,
      persist: () => {},
      spawn: () => child,
      kill: (pgid) => kills.push(pgid),
      reap: async () => 'orphan',
      maxOutputBytes: 4,
      killDeadlineMilliseconds: NEVER_EXITS,
      currentStage: () => 'cleanup',
      ...extra,
    });
    const started = Date.now();
    const command = start(runner, child);
    const rejection = assert.rejects(command, (error) => {
      assert.equal(error.code, 'KILL_UNCONFIRMED');
      assert.equal(error.privateFailure.killUnconfirmed, true);
      assert.equal(error.privateFailure.reason, reason);
      return true;
    });
    let barrier = false;
    const waiting = runner.settleAll().then(() => {
      barrier = true;
    });
    await sleep(NEVER_EXITS / 3);
    assert.equal(barrier, false, 'the deadline has not expired yet');
    await rejection;
    await waiting;
    // The injected deadline (150 ms), not the default one (10 s): half the default still tells
    // them apart by a factor of 30 without a machine-speed assumption.
    assert.ok(
      Date.now() - started < KILL_CONFIRMATION_DEADLINE_MS / 2,
      'released by the injected deadline, not the default one',
    );
    assert.ok(kills.includes(424900));
    // The group stays owned and unconfirmed: report list, signal set, retry set.
    assert.deepEqual(report.unconfirmedProcessGroups, [{ pgid: 424900, stage: 'cleanup', reason }]);
    assert.deepEqual(report.orphanProcessGroups, [424900]);
    assert.deepEqual(report.processGroups, [424900]);
    assert.deepEqual([...runner.orphans], [424900]);

    // Cleanup finishes FAILED, still retries the group, and the final report is written.
    const verdict = await finalizeCleanup({ runner, report, teardown: async () => ({}) });
    assert.equal(verdict.passed, false);
    assert.deepEqual(verdict.orphanRetry, { retried: [424900], remaining: [424900] });
    const directory = mkdtempSync(join(tmpdir(), 'drill-unconfirmed-'));
    try {
      const path = join(directory, 'report.json');
      report.cleanup = { passed: false, orphanProcessGroups: report.orphanProcessGroups };
      report.finishedAt = 'set';
      writeReportAtomically(path, report, { durable: true });
      const written = JSON.parse(readFileSync(path, 'utf8'));
      assert.deepEqual(written.orphanProcessGroups, [424900]);
      assert.equal(written.unconfirmedProcessGroups[0].pgid, 424900);
      assert.equal(written.finishedAt, 'set');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    // A late event from the stuck child changes nothing.
    child.finish(null);
    await sleep(20);
    assert.deepEqual(report.orphanProcessGroups, [424900]);
  });
}

test('an unconfirmed group that disappears later is released by the retry, the record stays', async () => {
  const child = fakeChild(424910);
  const report = {};
  let gone = false;
  const runner = createProcessRunner({
    report,
    persist: () => {},
    spawn: () => child,
    kill: () => {},
    reap: async () => (gone ? 'gone' : 'orphan'),
    killDeadlineMilliseconds: 40,
  });
  await assert.rejects(runner.run('slow', [], { timeout: 10 }), { code: 'KILL_UNCONFIRMED' });
  assert.deepEqual(report.orphanProcessGroups, [424910]);
  gone = true;
  const verdict = await finalizeCleanup({ runner, report, teardown: async () => ({}) });
  assert.deepEqual(verdict.orphanRetry, { retried: [424910], remaining: [] });
  assert.equal(verdict.passed, true);
  assert.deepEqual(report.orphanProcessGroups, []);
  assert.equal(report.unconfirmedProcessGroups.length, 1);
});

test('a stuck command does not hold back its siblings or the barrier beyond the deadline', async () => {
  const stuck = fakeChild(424920);
  const fine = fakeChild(424921);
  const queue = [stuck, fine];
  const report = {};
  const runner = createProcessRunner({
    report,
    persist: () => {},
    spawn: () => queue.shift(),
    kill: () => {},
    reap: async (pgid) => (pgid === 424920 ? 'orphan' : 'gone'),
    killDeadlineMilliseconds: 80,
  });
  const first = runner.run('stuck', [], { timeout: 10 });
  const second = runner.run('fine', [], { timeout: 60_000 });
  const settled = Promise.allSettled([first, second]);
  fine.finish(0);
  const [one, two] = await settled;
  assert.equal(one.status, 'rejected');
  assert.equal(two.status, 'fulfilled');
  await runner.settleAll();
  assert.deepEqual(report.orphanProcessGroups, [424920]);
});

test('a child that exits within the deadline is a plain timeout, nothing is left unconfirmed', async () => {
  const child = fakeChild(424930);
  const report = {};
  const runner = createProcessRunner({
    report,
    persist: () => {},
    spawn: () => child,
    kill: () => setTimeout(() => child.finish(137), 20),
    reap: async () => 'gone',
    killDeadlineMilliseconds: 300,
  });
  await assert.rejects(runner.run('slow', [], { timeout: 10 }), /Command timed out \(exit 137\)/);
  await sleep(350);
  assert.equal(report.unconfirmedProcessGroups, undefined);
  assert.equal(report.orphanProcessGroups, undefined);
  assert.deepEqual(report.processGroups, []);
});

test('a leader that exited before the deadline is settled by the drain and reap, not rejected as unconfirmed', async () => {
  const child = fakeChild(424940);
  const report = {};
  const runner = createProcessRunner({
    report,
    persist: () => {},
    spawn: () => child,
    kill: () => child.emit('exit', 137, null),
    reap: async () => 'gone',
    drainMilliseconds: 5_000,
    killDeadlineMilliseconds: 40,
  });
  await assert.rejects(runner.run('slow', [], { timeout: 10 }), /Command timed out \(exit 137\)/);
  assert.equal(report.unconfirmedProcessGroups, undefined);
});

// --- readRegularFile: the one reader of files somebody else could have substituted -------------
test('readRegularFile reads a regular file within its bound and refuses everything else by kind', () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-read-regular-'));
  try {
    const file = join(directory, 'f');
    writeFileSync(file, 'héllo', { mode: 0o600 });
    assert.equal(readRegularFile(file, { maxBytes: 100 }), 'héllo');
    writeFileSync(join(directory, 'empty'), '');
    assert.equal(readRegularFile(join(directory, 'empty'), { maxBytes: 0 }), '');
    const kind = (action) => {
      try {
        action();
      } catch (error) {
        assert.ok(error instanceof InputFileError);
        assert.doesNotMatch(error.message, new RegExp(directory));
        return error.kind;
      }
      return 'accepted';
    };
    // Exactly the cap is fine; one byte more is refused, on the descriptor's size.
    assert.equal(readRegularFile(file, { maxBytes: 6 }), 'héllo');
    assert.equal(
      kind(() => readRegularFile(file, { maxBytes: 5 })),
      'too-large',
    );
    assert.equal(
      kind(() => readRegularFile(join(directory, 'absent'), { maxBytes: 9 })),
      'missing',
    );
    assert.equal(
      kind(() => readRegularFile(directory, { maxBytes: 9 })),
      'not-file',
    );
    symlinkSync(file, join(directory, 'link'));
    assert.equal(readRegularFile(join(directory, 'link'), { maxBytes: 9 }), 'héllo');
    assert.equal(
      kind(() => readRegularFile(join(directory, 'link'), { maxBytes: 9, noFollow: true })),
      'open',
    );
    // The caller's own refusal (owner, mode) propagates untouched.
    assert.throws(
      () =>
        readRegularFile(file, {
          maxBytes: 9,
          inspect: () => {
            throw new RangeError('mine');
          },
        }),
      RangeError,
    );
    // A FIFO is refused by kind, and the open itself does not wait for a writer: the child has a
    // deadline, so a blocking open fails here instead of hanging the suite.
    const fifo = join(directory, 'fifo');
    execFileSync('mkfifo', [fifo]);
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { readRegularFile } from ${JSON.stringify(new URL('./backup-restore-drill-lib.mjs', import.meta.url).href)};
         try { readRegularFile(process.argv[1], { maxBytes: 9 }); console.log('accepted'); } catch (e) { console.log(e.kind); }`,
        '--',
        fifo,
      ],
      { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' },
    );
    assert.equal(child.signal, null, 'the open blocked on a FIFO');
    assert.equal(child.stdout.trim(), 'not-file');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
