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
  SCHEMA_DUMP_FLAGS,
  DUMP_RESTRICT_KEY,
  dumpSchema,
  collectSchemaReference,
  checkSourceReference,
  schemaReferenceEvidence,
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
const suffix = randomBytes(8).toString('hex');
const scratch = [`drill_ref_${suffix}`, `drill_fixed_${suffix}`];
let referenceMilliseconds = 0;
let created = false;
let initialSnapshot;
const initialRestores = [];
let initialLedger;
function command(name, args, input, privateOutput = false) {
  const result = spawnSync(name, args, { input, encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, privateOutput ? 'private schema command failed' : result.stderr);
  return result.stdout.trim();
}
function sql(input, db = database) {
  return command('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-d', db], input);
}
const dumpVersion = command('pg_dump', ['--version']);
const dumpFlags = [
  ...SCHEMA_DUMP_FLAGS,
  ...(command('pg_dump', ['--help']).includes('--restrict-key')
    ? [`--restrict-key=${DUMP_RESTRICT_KEY}`]
    : []),
];
let dumpMilliseconds = 0;
// `claimed` is the database name written into the provenance; it equals the pg_dump -d target
// except where a test deliberately simulates a scratch database from drifted bytes.
function schemaDump(db = database, label = 'source', options, claimed = db) {
  const result = spawnSync('pg_dump', [...dumpFlags, '-d', db], { timeout: 60_000 });
  assert.equal(result.status, 0, 'schema dump command failed');
  return dumpSchema(
    claimed,
    label,
    () => ({
      raw: result.stdout,
      version: dumpVersion,
    }),
    options,
  );
}
// The operator path's own sequence, over PostgreSQL: SOURCE bytes into REF, REF into the fixed point.
async function collectReference(sourceDump, onRestore = () => {}) {
  const started = performance.now();
  try {
    return await collectSchemaReference({
      database,
      suffix,
      sourceDump,
      dump: (name, label, options) => schemaDump(name, label, options),
      create: (name) => sql(`CREATE DATABASE "${name}" TEMPLATE template0`, 'postgres'),
      restore: (name, input) => {
        onRestore(name, input);
        command('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', name], input.content, true);
      },
      drop: (name) => sql(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`, 'postgres'),
    });
  } finally {
    referenceMilliseconds += performance.now() - started;
  }
}
// 'source' before a restore, 'restored' after it: the label is part of the dump's provenance.
function snapshot(label = 'source') {
  const started = performance.now();
  const schema = schemaDump(database, label).evidence;
  dumpMilliseconds += performance.now() - started;
  return {
    schemaDump: schema,
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
// SOURCE with the REF built from this very dump (compareSnapshots binds it by identity).
async function sourceSnapshot(onRestore) {
  const state = snapshot('source');
  state.reference = await collectReference(state.schemaDump, onRestore);
  return state;
}
// One REF round trip serves every test that starts from the restored fixture and undoes its change:
// each of those asserts the state returned to this baseline before it finishes.
let baseline;
const baselineSnapshot = async () => (baseline ??= await sourceSnapshot());
const withoutReference = (state) => {
  const rest = { ...state };
  delete rest.reference;
  return rest;
};
const ledger = () => JSON.parse(sql(LEDGER_SQL));

before(async () => {
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
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    REVOKE EXECUTE ON FUNCTION public.reject_ledger_mutation() FROM PUBLIC;
    CREATE POLICY drill_ledger_policy ON public.ledger_entry USING (organization_id = current_setting('rasta.organization_id', true));
    ALTER TABLE public.ledger_entry ENABLE ROW LEVEL SECURITY;
    COMMENT ON FUNCTION public.reject_ledger_mutation() IS 'drill comment must survive';
    CREATE TABLE drill_metadata.deparse_sample (a integer, b integer,
      CONSTRAINT drill_deparse_check CHECK (a BETWEEN 0 AND 10 AND b >= 0));
    CREATE TABLE drill_metadata.sample (id integer);
    CREATE TABLE drill_metadata.owned_sample (id integer);
    REVOKE ALL ON drill_metadata.owned_sample FROM PUBLIC;
    CREATE SEQUENCE drill_metadata.counter;
    SELECT setval('drill_metadata.counter', 41, true);
    GRANT SELECT ON drill_metadata.sample TO drill_metadata_reader;
    GRANT USAGE ON SEQUENCE drill_metadata.counter TO drill_metadata_reader;
    ALTER DEFAULT PRIVILEGES IN SCHEMA drill_metadata GRANT SELECT ON TABLES TO drill_metadata_reader;`);
  initialSnapshot = await sourceSnapshot((name, input) => initialRestores.push({ name, input }));
  initialLedger = ledger();
  command('pg_dump', ['-Fc', '-d', database, '-f', dump]);
  sql(`DROP DATABASE ${database}`, 'postgres');
  command('pg_restore', ['--create', '--exit-on-error', '-d', 'postgres', dump]);
  // Later tests take their own SOURCE (with its own REF) from the now-restored fixture.
});
after(() => {
  try {
    for (const name of scratch) sql(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`, 'postgres');
    if (created) sql(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`, 'postgres');
    sql(
      'DROP ROLE IF EXISTS drill_metadata_reader; DROP ROLE IF EXISTS drill_metadata_owner;',
      'postgres',
    );
  } finally {
    console.error(
      `Reference restore + fixed point: ${Math.round(referenceMilliseconds)} ms; schema-only dump collection total: ${Math.round(dumpMilliseconds)} ms`,
    );
    rmSync(directory, { recursive: true, force: true });
  }
});

test('unchanged migrated fixture passes its first restore against REF, with real CHECK deparse drift', () => {
  assert.equal(initialSnapshot.reference.checkLinesDifferent, 1);
  assert.equal(
    initialSnapshot.schemaDump.content.equals(initialSnapshot.reference.reference.content),
    false,
  );
  assert.equal(
    drillPassed(
      [compareSnapshots(initialSnapshot, snapshot('restored'))],
      1,
      initialLedger,
      ledger(),
    ),
    true,
  );
  // The operator-path sequence over real PostgreSQL: SOURCE bytes into REF, then REF bytes into
  // the fixed point. This fixture has real CHECK deparse drift, so a wrong input differs in bytes.
  assert.deepEqual(
    initialRestores.map(({ name }) => name),
    scratch,
  );
  assert.ok(initialRestores[0].input.content.equals(initialSnapshot.schemaDump.content));
  assert.equal(initialRestores[1].input, initialSnapshot.reference.reference);
  assert.equal(initialRestores[1].input.content.equals(initialRestores[0].input.content), false);
  // A database compared with itself is not a restore: the restored side needs its own provenance.
  assert.throws(() => compareSnapshots(initialSnapshot, initialSnapshot));
});

test('real inventory separates extension rows and detects equal-count value changes', async () => {
  const before = await sourceSnapshot();
  const summary = summarizeTables(before.tables);
  assert.deepEqual(summary.extension, { tables: 1, nonEmptyTables: 1, rows: '8500' });
  assert.ok(BigInt(summary.application.rows) < 100n);
  sql(`UPDATE ledger_account SET account_code = 'CHANGED' WHERE id = 'ACC_DRILL_WALLET';`);
  try {
    assert.equal(compareSnapshots(before, snapshot('restored')).tablesEqual, false);
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

test('--create restores database ACL, owner, per-role settings, digests and exact ledger amounts; ACL drift fails', async () => {
  // pg_dump omits this redundant explicit owner ACL; restored NULL must normalize identically.
  sql('REVOKE ALL ON drill_metadata.owned_sample FROM PUBLIC;');
  const before = await sourceSnapshot();
  const beforeLedger = ledger();
  command('pg_dump', ['-Fc', '-d', database, '-f', dump]);
  sql(`DROP DATABASE ${database}`, 'postgres');
  command('pg_restore', ['--create', '--exit-on-error', '-d', 'postgres', dump]);
  assert.deepEqual(compareSnapshots(before, snapshot('restored')), {
    referenceChecked: true,
    fixedPointEqual: true,
    allowanceChecked: true,
    schemaDumpEqual: true,
    tablesEqual: true,
    migrationsEqual: true,
    databaseStateEqual: true,
    objectStateEqual: true,
  });
  assert.equal(compareLedgers(beforeLedger, ledger()), true);
  assert.equal(
    sql(`SELECT has_database_privilege('public', '${database}', 'CONNECT')`, 'postgres'),
    'f',
  );
  sql(`GRANT CONNECT ON DATABASE ${database} TO PUBLIC`, 'postgres');
  assert.equal(
    sql(`SELECT has_database_privilege('public', '${database}', 'CONNECT')`, 'postgres'),
    't',
  );
  try {
    const comparison = compareSnapshots(before, snapshot('restored'));
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
  test(`restored ${category} mutant independently fails the acceptance gate`, async () => {
    const source = await baselineSnapshot();
    const sourceLedger = ledger();
    // before() restored the archive; each mutant changes one category and undoes it below.
    assert.equal(
      drillPassed([compareSnapshots(source, snapshot('restored'))], 1, sourceLedger, ledger()),
      true,
    );
    try {
      sql(`${mutation};`);
      const restored = snapshot('restored');
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
    assert.deepEqual(snapshot('restored'), withoutReference(source));
  });
}

// Fixtures supplement the real initial migration: the real append-only function gets an
// explicit restricted ACL, and an RLS policy is added because this migration has none.
for (const [category, mutation, verify, baseline] of [
  [
    'schema CREATE grant',
    'GRANT CREATE ON SCHEMA public TO PUBLIC',
    "SELECT has_schema_privilege('public', 'public', 'CREATE')",
    'f',
  ],
  [
    'function EXECUTE grant',
    'GRANT EXECUTE ON FUNCTION public.reject_ledger_mutation() TO PUBLIC',
    "SELECT has_function_privilege('public', 'public.reject_ledger_mutation()', 'EXECUTE')",
    'f',
  ],
  [
    'append-only trigger enabled state',
    'ALTER TABLE public.ledger_entry DISABLE TRIGGER trg_ledger_entry_immutable',
    "SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'public.ledger_entry'::regclass AND tgname = 'trg_ledger_entry_immutable'",
    'O',
  ],
  [
    'RLS policy',
    'DROP POLICY drill_ledger_policy ON public.ledger_entry',
    "SELECT count(*) FROM pg_policy WHERE polrelid = 'public.ledger_entry'::regclass AND polname = 'drill_ledger_policy'",
    '1',
  ],
  [
    'ledger constraint',
    'ALTER TABLE public.ledger_entry DROP CONSTRAINT ck_ledger_entry_amount_positive',
    "SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.ledger_entry'::regclass AND conname = 'ck_ledger_entry_amount_positive'",
    '1',
  ],
]) {
  test(`restored ${category} changes existing state and schema bytes; independent mutant fails drill`, async () => {
    const source = await baselineSnapshot();
    const sourceLedger = ledger();
    assert.equal(sql(verify), baseline);
    assert.equal(
      drillPassed([compareSnapshots(source, snapshot('restored'))], 1, sourceLedger, ledger()),
      true,
    );
    command('pg_dump', ['-Fc', '-d', database, '-f', dump]);
    try {
      sql(mutation);
      assert.notEqual(sql(verify), baseline, 'mutation must change real state before drill');
      const comparison = compareSnapshots(source, snapshot('restored'));
      assert.equal(comparison.schemaDumpEqual, false);
      assert.equal(drillPassed([comparison], 1, sourceLedger, ledger()), false);
    } finally {
      sql(`DROP DATABASE ${database}`, 'postgres');
      command('pg_restore', ['--create', '--exit-on-error', '-d', 'postgres', dump]);
    }
    assert.equal(sql(verify), baseline);
    assert.equal(
      drillPassed([compareSnapshots(source, snapshot('restored'))], 1, sourceLedger, ledger()),
      true,
    );
  });
}

test('database NULL ACL and explicit acldefault compare equally, PUBLIC grant still fails', () => {
  sql(`CREATE DATABASE drill_acl_normalization TEMPLATE template0`, 'postgres');
  try {
    const baseline = JSON.parse(sql(DATABASE_STATE_SQL, 'drill_acl_normalization'));
    assert.equal(
      sql(
        "SELECT datacl IS NULL FROM pg_database WHERE datname = 'drill_acl_normalization'",
        'postgres',
      ),
      't',
    );
    sql('REVOKE ALL ON DATABASE drill_acl_normalization FROM drill_metadata_reader', 'postgres');
    assert.equal(
      sql(
        "SELECT datacl IS NULL FROM pg_database WHERE datname = 'drill_acl_normalization'",
        'postgres',
      ),
      'f',
    );
    assert.deepEqual(JSON.parse(sql(DATABASE_STATE_SQL, 'drill_acl_normalization')), baseline);
    sql('GRANT CREATE ON DATABASE drill_acl_normalization TO PUBLIC', 'postgres');
    assert.notDeepEqual(JSON.parse(sql(DATABASE_STATE_SQL, 'drill_acl_normalization')), baseline);
  } finally {
    sql('DROP DATABASE drill_acl_normalization', 'postgres');
  }
});

for (const [category, mutation] of [
  [
    'CHECK bound',
    'ALTER TABLE public.ledger_entry DROP CONSTRAINT ck_ledger_entry_amount_positive; ALTER TABLE public.ledger_entry ADD CONSTRAINT ck_ledger_entry_amount_positive CHECK (amount_minor >= 1)',
  ],
  [
    'renamed CHECK',
    'ALTER TABLE public.ledger_entry RENAME CONSTRAINT ck_ledger_entry_amount_positive TO drill_renamed_check',
  ],
]) {
  test(`restored ${category} refuses REF equality then restored baseline passes`, async () => {
    const source = await baselineSnapshot(),
      sourceLedger = ledger();
    command('pg_dump', ['-Fc', '-d', database, '-f', dump]);
    assert.equal(
      drillPassed([compareSnapshots(source, snapshot('restored'))], 1, sourceLedger, ledger()),
      true,
    );
    try {
      sql(mutation);
      const comparison = compareSnapshots(source, snapshot('restored'));
      assert.equal(comparison.schemaDumpEqual, false);
      assert.equal(drillPassed([comparison], 1, sourceLedger, ledger()), false);
    } finally {
      sql(`DROP DATABASE ${database}`, 'postgres');
      command('pg_restore', ['--create', '--exit-on-error', '-d', 'postgres', dump]);
    }
    assert.equal(
      drillPassed([compareSnapshots(source, snapshot('restored'))], 1, sourceLedger, ledger()),
      true,
    );
  });
}

test('SOURCE default drift and unstable simulated REF refuse at their own comparison, then original reference passes', async () => {
  const source = await baselineSnapshot(),
    sourceLedger = ledger();
  const ref = source.reference.reference;
  command('pg_dump', ['-Fc', '-d', database, '-f', dump]);
  try {
    sql('ALTER TABLE public.ledger_entry ALTER COLUMN amount_minor SET DEFAULT 1');
    // The drifted SOURCE is a valid SOURCE dump; only the SOURCE/REF structural guard refuses it.
    const changed = schemaDump(database, 'source').evidence;
    assert.throws(() => checkSourceReference(changed, ref, database), /non-CHECK difference/);
    // Simulated unstable REF: drifted bytes issued as the REF's fixed point with correct lineage and
    // labels, so the refusal comes from the fixed-point byte comparison and nothing earlier.
    const unstable = schemaDump(
      database,
      'fixed-point',
      { restoredFrom: ref },
      scratch[1],
    ).evidence;
    assert.throws(
      () =>
        schemaReferenceEvidence(
          source.schemaDump,
          ref,
          unstable,
          checkSourceReference(source.schemaDump, ref, database),
        ),
      /unstable REF fixed-point/,
    );
  } finally {
    sql(`DROP DATABASE ${database}`, 'postgres');
    command('pg_restore', ['--create', '--exit-on-error', '-d', 'postgres', dump]);
  }
  assert.equal(
    drillPassed([compareSnapshots(source, snapshot('restored'))], 1, sourceLedger, ledger()),
    true,
  );
});

test('sequence NULL ACL equals explicit owner defaults, but a real SELECT revocation refuses', () => {
  const db = `${database}_sequence_acl`;
  sql(`CREATE DATABASE ${db} TEMPLATE template0`, 'postgres');
  try {
    sql(
      `GRANT CREATE ON SCHEMA public TO drill_metadata_owner;
      SET ROLE drill_metadata_owner;
      CREATE SEQUENCE public.default_acl_counter;
      RESET ROLE;`,
      db,
    );
    const state = () => JSON.parse(sql(OBJECT_STATE_SQL, db));
    const allowed = () =>
      sql(
        "SELECT has_sequence_privilege('drill_metadata_owner', 'public.default_acl_counter', 'SELECT')",
        db,
      );
    assert.equal(
      sql(
        "SELECT relacl IS NULL FROM pg_class WHERE oid='public.default_acl_counter'::regclass",
        db,
      ),
      't',
    );
    assert.equal(allowed(), 't');
    const baseline = state();
    sql('REVOKE ALL ON SEQUENCE public.default_acl_counter FROM drill_metadata_reader', db);
    assert.equal(
      sql(
        "SELECT relacl IS NULL FROM pg_class WHERE oid='public.default_acl_counter'::regclass",
        db,
      ),
      'f',
    );
    assert.equal(allowed(), 't');
    assert.deepEqual(state(), baseline);
    sql('REVOKE SELECT ON SEQUENCE public.default_acl_counter FROM drill_metadata_owner', db);
    assert.equal(allowed(), 'f');
    assert.notDeepEqual(state(), baseline);
    sql('GRANT SELECT ON SEQUENCE public.default_acl_counter TO drill_metadata_owner', db);
    assert.equal(allowed(), 't');
    assert.deepEqual(state(), baseline);
  } finally {
    sql(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`, 'postgres');
  }
});
