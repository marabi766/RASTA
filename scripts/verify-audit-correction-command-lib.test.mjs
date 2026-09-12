import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ACCEPTED_MARKER,
  CLEAR_PROBES,
  COLUMNS,
  COMMAND_ROW,
  MIGRATION,
  PRIMARY_KEY,
  SQLSTATE,
  SURVIVORS,
  TABLE,
  assertState,
  insertCommand,
  refusalProbe,
} from './verify-audit-correction-command-lib.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIGRATIONS_DIR = join(ROOT, 'services', 'identity-service', 'prisma', 'migrations');

/**
 * What `verify-audit-correction-command-migration.mjs` expects, tested as code.
 *
 * Two different things are proven here, and they are worth keeping apart.
 *
 * `assertState` and `insertCommand` are pure builders, so they can be checked
 * directly: that `present: false` inverts what is asserted rather than only the
 * wording, that survivors and other migrations are asserted present in *both*
 * directions, and that the probe builder can omit a column rather than only
 * override it. A builder whose absence branch merely reworded its exception
 * would pass every rollback it was ever pointed at.
 *
 * The constants are checked against the migration itself. Every column
 * signature, the primary key and every survivor name is a claim about SQL on
 * disk; a stale or misspelled one would make the corresponding assertion
 * vacuous, which is the exact class of failure this verifier exists to catch.
 *
 * None of this replaces the up → down → up run. A generated string is not a
 * rollback; these tests only ensure the string says what it should.
 */

const migrationFile = (name, file) => readFileSync(join(MIGRATIONS_DIR, name, file), 'utf8');

/** Every `migration.sql` identity ships, concatenated in application order. */
function identitySql(file = 'migration.sql') {
  return migrationNames()
    .map((name) => migrationFile(name, file))
    .join('\n');
}

function migrationNames() {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

// ---------------------------------------------------------------------------
// The constants describe the migration on disk
// ---------------------------------------------------------------------------

test('the migration this verifier reverses exists, with both directions', () => {
  assert.ok(migrationNames().includes(MIGRATION), `${MIGRATION} is not in identity's chain`);
  assert.match(migrationFile(MIGRATION, 'migration.sql'), new RegExp(`CREATE TABLE "${TABLE}"`));
  assert.ok(migrationFile(MIGRATION, 'down.sql').length > 0);
});

test('every column the verifier asserts is declared by the migration, and no other', () => {
  const body = migrationFile(MIGRATION, 'migration.sql').match(
    new RegExp(`CREATE TABLE "${TABLE}" \\(([\\s\\S]*?)\\n\\);`),
  );
  assert.ok(body, 'the CREATE TABLE statement could not be read');

  const declared = [...body[1].matchAll(/^\s{4}"([a-z_]+)"/gm)].map((match) => match[1]);

  assert.deepEqual(
    COLUMNS.map((column) => column.name).toSorted(),
    declared.toSorted(),
    'the asserted column list and the migration disagree — a column the list omits is a ' +
      'column the rollback proof never looks at',
  );
});

test('each asserted signature matches how the migration declares that column', () => {
  const sql = migrationFile(MIGRATION, 'migration.sql');
  // `data_type|length|datetime_precision|is_nullable|default`, as PostgreSQL's
  // catalog reports the declaration on the left.
  const declarations = {
    'VARCHAR(256) NOT NULL': 'character varying|256|-|NO|-',
    'VARCHAR(255) NOT NULL': 'character varying|255|-|NO|-',
    'CHAR(64) NOT NULL': 'character|64|-|NO|-',
    'VARCHAR(64) NOT NULL': 'character varying|64|-|NO|-',
    'VARCHAR(26) NOT NULL': 'character varying|26|-|NO|-',
    'JSONB NOT NULL': 'jsonb|-|-|NO|-',
    'TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP':
      'timestamp without time zone|-|3|NO|CURRENT_TIMESTAMP',
  };

  for (const { name, signature } of COLUMNS) {
    const line = sql.match(new RegExp(`^\\s{4}"${name}" (.+?),?$`, 'm'));
    assert.ok(line, `${name} is not declared by ${MIGRATION}`);
    assert.equal(
      declarations[line[1]],
      signature,
      `${name} is declared ${line[1]}, which is not the asserted signature ${signature}`,
    );
  }
});

test('the primary key is asserted by its definition, in the order the migration declares', () => {
  const sql = migrationFile(MIGRATION, 'migration.sql');
  assert.match(sql, new RegExp(`CONSTRAINT "${PRIMARY_KEY.name}" PRIMARY KEY`));

  const columns = sql
    .match(/PRIMARY KEY \(([^)]*)\)/)[1]
    .split(',')
    .map((part) => part.trim().replaceAll('"', ''));

  assert.equal(
    PRIMARY_KEY.definition,
    `PRIMARY KEY (${columns.join(', ')})`,
    'the asserted key definition and the migration disagree on the columns or their order — ' +
      'and only the order distinguishes a key that indexes the actor first from one that does not',
  );
  assert.equal(columns[0], 'actor_id', 'the caller-chosen key must not be the leading column');
});

test('the probe row populates every column the verifier asserts', () => {
  assert.deepEqual(
    Object.keys(COMMAND_ROW).toSorted(),
    COLUMNS.map((column) => column.name).toSorted(),
    'a probe that leaves a column out would not prove anything about a real row',
  );
});

test('every survivor names an object some identity migration creates', () => {
  const sql = identitySql();
  for (const [kind, names] of Object.entries(SURVIVORS)) {
    for (const name of names) {
      assert.ok(
        sql.includes(name),
        `${kind}: no identity migration creates "${name}", so asserting it survives is vacuous`,
      );
    }
  }
});

test('no survivor is an object this migration itself owns', () => {
  const owned = [TABLE, PRIMARY_KEY.name];
  for (const names of Object.values(SURVIVORS)) {
    for (const name of names) {
      assert.ok(
        !owned.includes(name),
        `"${name}" is created by ${MIGRATION}, so it cannot also be required to survive its rollback`,
      );
    }
  }
});

test('the down script drops the table and deletes exactly its own ledger row', () => {
  const down = migrationFile(MIGRATION, 'down.sql');

  assert.match(down, new RegExp(`DROP TABLE IF EXISTS "${TABLE}"`));
  assert.deepEqual(
    [...down.matchAll(/"migration_name"\s*=\s*'([^']+)'/g)].map((match) => match[1]),
    [MIGRATION],
    'the down script must delete its own _prisma_migrations row and no other: leaving it ' +
      'behind makes the migration permanently unappliable, deleting another rewrites a ' +
      'migration that was never reversed',
  );
});

test('the down script removes nothing a survivor depends on', () => {
  const down = migrationFile(MIGRATION, 'down.sql');
  const dropped = [...down.matchAll(/DROP\s+\w+(?:\s+IF\s+EXISTS)?\s+"?([a-z_]+)"?/gi)].map(
    (match) => match[1],
  );

  assert.deepEqual(dropped, [TABLE], 'a down script that removes more than it added is an outage');
});

// ---------------------------------------------------------------------------
// insertCommand
// ---------------------------------------------------------------------------

test('insertCommand writes every column by default', () => {
  const statement = insertCommand();
  for (const { name } of COLUMNS) assert.ok(statement.includes(name), `${name} is not inserted`);
  assert.ok(statement.includes(`INSERT INTO "${TABLE}"`));
});

test('insertCommand overrides a column rather than adding one', () => {
  const statement = insertCommand({ actor_id: 'NULL' });
  assert.match(statement, /\(actor_id, idempotency_key/);
  assert.ok(statement.includes('NULL'));
  assert.ok(!statement.includes(COMMAND_ROW.actor_id));
});

test('insertCommand omits a column set to undefined, so a default can be observed', () => {
  const statement = insertCommand({ created_at: undefined });
  assert.ok(!statement.includes('created_at'), 'a supplied value would hide the column default');
  for (const { name } of COLUMNS.filter((column) => column.name !== 'created_at')) {
    assert.ok(statement.includes(name));
  }
});

test('the probe cleanup is scoped to this verifier own rows', () => {
  assert.match(CLEAR_PROBES, /WHERE actor_id LIKE 'USR_ACCCHK%'/);
  assert.ok(
    COMMAND_ROW.actor_id.includes('USR_ACCCHK'),
    'the probe row is outside its own cleanup',
  );
});

// ---------------------------------------------------------------------------
// refusalProbe
//
// The regression these tests guard is specific and was live: every negative
// probe used to assert a substring of `prisma db execute`'s output, and that
// output is Prisma's rendering of the PostgreSQL error, not the error. For a
// NOT NULL violation Prisma prints only `Failing row contains (null, …)`, so a
// probe expecting `null value in column "actor_id"` could never pass; for a
// value-too-long it prints `P2000 … Column: (not available)`, which is the
// same sentence for every column of every width, so the two width probes could
// not be told apart even if one of them silently stopped failing. Asserting
// PostgreSQL's own diagnostics is what makes those probes mean anything.
// ---------------------------------------------------------------------------

test('refusalProbe asks PostgreSQL why it refused, rather than reading Prisma output', () => {
  const { script } = refusalProbe({
    statement: insertCommand({ actor_id: 'NULL' }),
    sqlstate: SQLSTATE.NOT_NULL_VIOLATION,
    table: TABLE,
    column: 'actor_id',
  });

  assert.match(script, /^\s*DO \$\$/);
  assert.match(script, /END\s*\$\$;$/);
  assert.ok(script.includes(insertCommand({ actor_id: 'NULL' })), 'the statement is not run');
  assert.match(script, /GET STACKED DIAGNOSTICS/);
  for (const item of [
    'RETURNED_SQLSTATE',
    'TABLE_NAME',
    'COLUMN_NAME',
    'CONSTRAINT_NAME',
    'MESSAGE_TEXT',
  ]) {
    assert.ok(script.includes(item), `${item} is not read, so it cannot be asserted`);
  }
});

test('refusalProbe fails the probe when the statement is accepted', () => {
  const { script } = refusalProbe({
    statement: insertCommand(),
    sqlstate: SQLSTATE.UNIQUE_VIOLATION,
  });

  // After the handler, not inside it: a statement that raised nothing must be
  // reported as accepted rather than passing for want of an exception.
  assert.ok(script.includes(ACCEPTED_MARKER), 'an accepted statement would look like a refusal');
  assert.ok(
    script.indexOf(ACCEPTED_MARKER) > script.indexOf('GET STACKED DIAGNOSTICS'),
    'the acceptance check must come after the exception handler, or it always fires',
  );
});

test('refusalProbe expects every declared diagnostic, by exact value', () => {
  const notNull = refusalProbe({
    statement: insertCommand({ target_id: 'NULL' }),
    sqlstate: SQLSTATE.NOT_NULL_VIOLATION,
    table: TABLE,
    column: 'target_id',
  });

  assert.equal(
    notNull.expected,
    `refused: sqlstate=[23502] table=[${TABLE}] column=[target_id] constraint=[]`,
    'a not-null probe proves the column, by name, in the right table',
  );

  const key = refusalProbe({
    statement: insertCommand(),
    sqlstate: SQLSTATE.UNIQUE_VIOLATION,
    table: TABLE,
    constraint: PRIMARY_KEY.name,
  });

  assert.ok(key.expected.includes(`constraint=[${PRIMARY_KEY.name}]`));
  assert.ok(key.expected.includes(`sqlstate=[23505]`));
});

test('refusalProbe leaves an undeclared message a prefix match, not a wildcard', () => {
  const withMessage = refusalProbe({
    statement: insertCommand({ request_hash: `repeat('a', 65)` }),
    sqlstate: SQLSTATE.STRING_TOO_LONG,
    message: 'value too long for type character(64)',
  });
  const withoutMessage = refusalProbe({
    statement: insertCommand({ request_hash: `repeat('a', 65)` }),
    sqlstate: SQLSTATE.STRING_TOO_LONG,
  });

  // 22001 carries no table, column or constraint — the message is the only
  // evidence of *which* width refused, so that probe declares it and the line
  // still ends with it.
  assert.ok(withMessage.expected.endsWith('message=[value too long for type character(64)]'));
  assert.ok(withMessage.expected.startsWith(withoutMessage.expected));
  assert.ok(!withoutMessage.expected.includes('message='));
});

test('the raised line orders its fields the way an expectation is built', () => {
  const { script, expected } = refusalProbe({
    statement: insertCommand(),
    sqlstate: SQLSTATE.NOT_NULL_VIOLATION,
  });

  // The placeholders and the arguments have to agree, or the line names the
  // wrong diagnostic and every expectation built from it is a false negative.
  assert.match(
    script,
    /RAISE EXCEPTION 'refused: sqlstate=\[%\] table=\[%\] column=\[%\] constraint=\[%\] message=\[%\]',\s*state, tbl, col, con, msg;/,
  );
  assert.equal(expected, 'refused: sqlstate=[23502] table=[] column=[] constraint=[]');
});

// ---------------------------------------------------------------------------
// assertState
// ---------------------------------------------------------------------------

const OTHERS = ['20260826163355_init_identity', '20260911120000_security_event_outbox'];

test('assertState inverts what is asserted for absence, not merely the wording', () => {
  const present = assertState({ present: true });
  const absent = assertState({ present: false });

  assert.match(present, new RegExp(`table_name = '${TABLE}';[\\s\\S]*?IF n <> 1 THEN`));
  assert.match(absent, new RegExp(`table_name = '${TABLE}';[\\s\\S]*?IF n <> 0 THEN`));
  assert.ok(present.includes(`must exist`));
  assert.ok(absent.includes(`must be gone`));
});

test('assertState checks the column shape only where the table should exist', () => {
  const present = assertState({ present: true });
  const absent = assertState({ present: false });

  for (const { name, signature } of COLUMNS) {
    assert.ok(present.includes(`column_name = '${name}'`), `${name} is not asserted`);
    assert.ok(present.includes(signature), `${name}'s signature is not asserted`);
  }
  assert.ok(present.includes(PRIMARY_KEY.definition));
  assert.ok(present.includes(`must have exactly ${COLUMNS.length} columns`));

  // A dropped table has no columns to have the wrong shape; asserting it would
  // only report the absence twice, and would fail for the right reason by luck.
  assert.ok(!absent.includes(PRIMARY_KEY.definition));
  assert.ok(!absent.includes('columns, found'));
});

test('assertState asserts the ledger row in both directions', () => {
  assert.match(
    assertState({ present: true }),
    new RegExp(`migration_name = '${MIGRATION}';[\\s\\S]*?IF n <> 1 THEN`),
  );
  assert.match(
    assertState({ present: false }),
    new RegExp(`migration_name = '${MIGRATION}';[\\s\\S]*?IF n <> 0 THEN`),
  );
});

test('every other migration keeps its ledger row across the rollback', () => {
  for (const present of [true, false]) {
    const script = assertState({ present, otherMigrations: OTHERS });
    for (const name of OTHERS) {
      assert.match(
        script,
        new RegExp(`migration_name = '${name}';[\\s\\S]*?IF n <> 1 THEN`),
        `${name}'s ledger row is not required to survive (present: ${present})`,
      );
    }
  }
});

test('the ledger is counted, so an extra or missing row is caught as well as a named one', () => {
  assert.match(
    assertState({ present: true, otherMigrations: OTHERS }),
    new RegExp(`ledger must hold exactly % rows[\\s\\S]*?${OTHERS.length + 1}, n;`),
  );
  assert.match(
    assertState({ present: false, otherMigrations: OTHERS }),
    new RegExp(`ledger must hold exactly % rows[\\s\\S]*?${OTHERS.length}, n;`),
  );
});

test('every survivor is asserted present in both directions', () => {
  for (const present of [true, false]) {
    const script = assertState({ present, otherMigrations: OTHERS });
    for (const [kind, names] of Object.entries(SURVIVORS)) {
      for (const name of names) {
        assert.ok(
          script.includes(`'${name}'`),
          `${kind} "${name}" is not asserted when present is ${present}`,
        );
      }
    }
  }
});

test('each survivor kind is looked up in the catalog that kind lives in', () => {
  const script = assertState({ present: true });

  // An index looked for in `information_schema.tables` can never be found, so
  // the up assertion would fail forever; one looked for by name alone in
  // `pg_class` would match a table of the same name. Each kind gets its own
  // catalog, and the relkind/tgisinternal filters are part of the lookup.
  assert.match(script, /information_schema\.tables[\s\S]*?table_name = 'user'/);
  assert.match(script, /pg_class c JOIN pg_namespace[\s\S]*?relkind IN \('i', 'I'\)/);
  assert.match(
    script,
    /pg_constraint c JOIN pg_namespace[\s\S]*?conname = 'ck_outbox_claim_triple'/,
  );
  assert.match(script, /pg_trigger t JOIN pg_class[\s\S]*?NOT t\.tgisinternal/);
  assert.match(
    script,
    /pg_proc p JOIN pg_namespace[\s\S]*?proname = 'security_event_outbox_guard'/,
  );
});

test('assertState is a DO block, because prisma db execute reports only an exit status', () => {
  for (const present of [true, false]) {
    const script = assertState({ present });
    assert.match(script, /^\s*DO \$\$/);
    assert.match(script, /END\s*\$\$;$/);
    assert.ok(script.includes('RAISE EXCEPTION'));
  }
});
