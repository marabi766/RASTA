// pnpm test:utc-clock-sites: the guard refuses each way a clock can reach a timestamp(3)
// column in the session's zone, and the tree as it stands passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  claimSubqueryProblems,
  cliSqlSites,
  psqlText,
  REVIEWED_DO_BLOCKS,
  definitionBinding,
  REVIEWED_FUNCTIONS,
  REVIEWED_LITERALS,
  clocksIn,
  contentHash,
  definitionProblems,
  localVariableProblems,
  problemsIn,
  replayMigrations,
  siteKey,
  utcClockProblems,
} from './utc-clock-sites-lib.mjs';
import { lex } from './eligibility-clock-sql.mjs';
import { psqlSql, sqlSinkTexts, UNKNOWN_SQL } from './utc-clock-sinks.mjs';
import { fixtureGitEnv } from './fixture-git-env.mjs';
import { authoredFiles } from './authored-source-inventory.cjs';

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { tables, functions } = replayMigrations([
  `CREATE TABLE "task" (
     "id" TEXT NOT NULL,
     "lease_until" TIMESTAMP(3),
     "due_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "made_at" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC', now()),
     "aware_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
     CONSTRAINT "task_pkey" PRIMARY KEY ("id")
   );
   CREATE TABLE aware (id text, at timestamptz(3));
   CREATE TABLE gone (at timestamp(3));
   DROP TABLE gone;
   CREATE FUNCTION old_one() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
   CREATE FUNCTION standard(a text) RETURNS text LANGUAGE sql IMMUTABLE RETURN lower(a);
   CREATE TABLE after_standard (at timestamp(3));
   CREATE FUNCTION kept() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END $fn$;
   DROP FUNCTION old_one;`,
  `ALTER TABLE "task" ALTER COLUMN "made_at" SET DEFAULT CURRENT_TIMESTAMP;
   ALTER TABLE "task" ALTER COLUMN "made_at" SET DEFAULT timezone('UTC', now()),
     ADD COLUMN "added_at" TIMESTAMP(3) DEFAULT now();
   ALTER TABLE aware RENAME COLUMN at TO seen_at;
   ALTER TABLE aware ALTER COLUMN seen_at TYPE timestamp(3);
   ALTER TABLE aware ALTER COLUMN seen_at TYPE timestamptz(3);`,
]);
const scope = new Map([...tables].map(([table, columns]) => [table, [columns]]));
scope.set('aware_and_ts', [new Map([['at', { type: 'ts', sessionDefault: false }]])]);

test('migrations replay into types and defaults', () => {
  const task = tables.get('task');
  assert.deepEqual(task.get('lease_until'), { type: 'ts', sessionDefault: false });
  assert.deepEqual(task.get('due_at'), { type: 'ts', sessionDefault: true });
  assert.deepEqual(task.get('made_at'), { type: 'ts', sessionDefault: false });
  assert.deepEqual(task.get('added_at'), { type: 'ts', sessionDefault: true });
  assert.equal(task.get('aware_at').type, 'tz');
  assert.equal(tables.get('aware').get('seen_at').type, 'tz');
  assert.equal(tables.has('gone'), false);
  assert.equal(tables.has('after_standard'), true, 'a function without $$ swallows nothing');
  assert.deepEqual([...functions.keys()], ['standard(a text)', 'kept()']);
});

for (const [name, sql] of [
  ['assignment', `UPDATE task SET lease_until = now() + interval '1 second'`],
  ['comparison', `SELECT id FROM task WHERE lease_until <= clock_timestamp()`],
  ['statement_timestamp', `SELECT id FROM task WHERE lease_until <= statement_timestamp()`],
  ['transaction_timestamp', `SELECT id FROM task WHERE lease_until <= transaction_timestamp()`],
  ['keyword', `UPDATE task SET lease_until = CURRENT_TIMESTAMP`],
  ['keyword with precision', `UPDATE task SET lease_until = CURRENT_TIMESTAMP(3)`],
  ['quoted', `UPDATE "task" SET "lease_until" = now()`],
  ['session wall clock', `UPDATE task SET lease_until = LOCALTIMESTAMP`],
  ['session wall clock pinned', `UPDATE task SET lease_until = LOCALTIMESTAMP AT TIME ZONE 'UTC'`],
  ['the wrong zone', `UPDATE task SET lease_until = now() AT TIME ZONE 'Asia/Tehran'`],
  ['one of two pinned', `UPDATE task SET lease_until = now() AT TIME ZONE 'UTC', due_at = now()`],
  ['spliced table', `UPDATE \u0000table\u0000 SET x = now()`],
  ['a fragment', `updated_at = now()`],
  ['a bare fragment', `clock_timestamp()`],
  ['an insert left to the default', `INSERT INTO task (id) VALUES ($1)`],
  ['an insert without a list', `INSERT INTO task SELECT * FROM task`],
  // The class: other spellings of an explicit default.
  ['DEFAULT VALUES', `INSERT INTO task DEFAULT VALUES`],
  [
    'DEFAULT in a second row',
    `INSERT INTO task (id,due_at,added_at) VALUES ($1,$2,$3),($4,DEFAULT,$5)`,
  ],
  ['DEFAULT in a tuple SET', `UPDATE task SET (id,due_at) = ($1,DEFAULT)`],
  [
    'DEFAULT on conflict',
    `INSERT INTO task (id,due_at) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET due_at = DEFAULT`,
  ],
  ['DEFAULT, quoted and aliased', `UPDATE "public"."task" AS t SET "due_at" = DEFAULT`],
  ['DEFAULT behind a comment', `UPDATE task SET due_at = /* later */ DEFAULT`],
  ['an aliased insert left to the default', `INSERT INTO task AS t (id) VALUES ($1)`],
  [
    'MERGE, not modelled',
    `MERGE INTO task USING src ON true WHEN NOT MATCHED THEN INSERT (id) VALUES (1)`,
  ],
  ['a positional insert with a clock', `INSERT INTO aware_and_ts VALUES ($1, now())`],
  // The class: other spellings of a clock.
  ['upper case quoted', `UPDATE task SET lease_until = "NOW"()`],
  ['qualified clock_timestamp', `UPDATE task SET lease_until = pg_catalog.clock_timestamp()`],
  ['a clock with space and comment', `UPDATE task SET lease_until = now ( /* x */ )`],
  ['timeofday', `UPDATE task SET lease_until = timeofday()::timestamp`],
  ['a string clock', `UPDATE task SET lease_until = 'now'`],
  ['a string clock cast', `UPDATE task SET lease_until = 'now'::timestamptz`],
  ['today', `UPDATE task SET lease_until = 'today'::timestamp`],
  ['an escaped string clock', `UPDATE task SET lease_until = E'tomorrow'`],
  ['a cast is no pin', `UPDATE task SET lease_until = now()::timestamp`],
  // The class: a pin undone, or not a pin.
  [
    'pinned, then zoned again',
    `UPDATE task SET lease_until = now() AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tehran'`,
  ],
  [
    'parenthesized, then zoned',
    `UPDATE task SET lease_until = (now() AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Tehran'`,
  ],
  [
    'pinned, then cast back',
    `UPDATE task SET lease_until = (now() AT TIME ZONE 'UTC')::timestamptz`,
  ],
  [
    'pinned, then CAST back',
    `UPDATE task SET lease_until = CAST(now() AT TIME ZONE 'UTC' AS timestamptz)`,
  ],
  [
    'pinned, then cast the long way',
    `UPDATE task SET lease_until = (now() AT TIME ZONE 'UTC')::timestamp with time zone`,
  ],
  [
    'timezone(), then zoned',
    `UPDATE task SET lease_until = timezone('UTC', now()) AT TIME ZONE 'Asia/Tehran'`,
  ],
  [
    'zoned by timezone()',
    `UPDATE task SET lease_until = timezone('Asia/Tehran', now() AT TIME ZONE 'UTC')`,
  ],
  ['timezone() in the wrong zone', `UPDATE task SET lease_until = timezone('Asia/Tehran', now())`],
  ['a call is not a grouping', `UPDATE task SET lease_until = shift(now()) AT TIME ZONE 'UTC'`],
  [
    'arithmetic inside the pin',
    `UPDATE task SET lease_until = (now() + interval '1 day') AT TIME ZONE 'UTC'`,
  ],
  // The class: tables the guard cannot resolve.
  ['a read of an unresolved table', `SELECT id FROM not_a_table WHERE at <= now()`],
  ['a table of another schema', `UPDATE other.task SET lease_until = now()`],
  ['an insert into an unresolved table', `INSERT INTO not_a_table (id) VALUES ($1)`],
  ['a DEFAULT on an unresolved table', `UPDATE not_a_table SET at = DEFAULT`],
  ['a table spliced in quotes', `UPDATE "\uE0000\uE001" SET lease_until = now()`],
  ['an insert into a spliced table', `INSERT INTO \uE0000\uE001 (id) VALUES ($1)`],
  ['a DEFAULT on a spliced table', `UPDATE \uE0000\uE001 SET x = DEFAULT`],
  // PR #906 r2 F2, one per escape: a target, string, table or pin the guard cannot read is refused.
  ['UPDATE ONLY (table)', `UPDATE ONLY (task) SET due_at=DEFAULT`],
  ['UPDATE table * aliased', `UPDATE task * AS t SET due_at = DEFAULT`],
  ['prose naming UPDATE and DEFAULT: an UPDATE not read', `please update the default`],
  ['a dollar-quoted clock', `UPDATE task SET lease_until = $$now$$`],
  ['a tagged dollar-quoted clock', `UPDATE task SET lease_until = $t$ tomorrow $t$`],
  ['an E-string escape', `UPDATE task SET lease_until = E'\\x6eow'`],
  ['a U& escape', `UPDATE task SET lease_until = U&'\\006eow'`],
  ['a backslash read either way', `UPDATE task SET lease_until = '\\x6eow'`],
  ['a clock among date fields', `UPDATE task SET lease_until = 'tomorrow 10:00'`],
  ['an unresolved pg_ table', `SELECT id FROM pg_missing WHERE at <= now()`],
  ['another schema shadowing a known table', `UPDATE other.aware SET seen_at = now()`],
  ['a comma-joined table', `SELECT 1 FROM aware, task WHERE lease_until < now()`],
  [
    'a comma after a join',
    `SELECT 1 FROM aware a JOIN aware b ON a.id = b.id, task WHERE lease_until < now()`,
  ],
  ['FROM ONLY (table)', `SELECT 1 FROM ONLY (task) WHERE lease_until < now()`],
  [
    'a pin cast back through a qualified type',
    `UPDATE task SET lease_until = ((now() AT TIME ZONE 'UTC')::pg_catalog.timestamptz) AT TIME ZONE 'UTC'`,
  ],
  [
    'a pin cast to a quoted type',
    `UPDATE task SET lease_until = (now() AT TIME ZONE 'UTC')::"timestamptz"`,
  ],
  [
    'a pin in coalesce() with a timestamptz column',
    `UPDATE task SET lease_until = coalesce(now() AT TIME ZONE 'UTC', a.seen_at) FROM aware a`,
  ],
  [
    'a pin nested in a call',
    `UPDATE task SET lease_until = greatest(x, ((now() AT TIME ZONE 'UTC')))`,
  ],
  [
    'a pin in a CASE branch',
    `UPDATE task SET lease_until = CASE WHEN $1 THEN now() AT TIME ZONE 'UTC' ELSE a.seen_at END FROM aware a`,
  ],
  [
    'a pin in a zoned date_trunc',
    `UPDATE task SET lease_until = date_trunc('day', now() AT TIME ZONE 'UTC', 'UTC')`,
  ],
  [
    'a cast binds the zone, not the pin',
    `UPDATE task SET lease_until = now() AT TIME ZONE 'UTC'::timestamp(3)`,
  ],
  // The coverage review of this change (FU-226), one per gap.
  ['a timestamp cast beside a bare clock', `SELECT id FROM aware WHERE $1::timestamp(3) <= now()`],
  [
    'a typed record beside a bare clock',
    `SELECT r.id FROM jsonb_to_recordset($1) AS r(id text, at timestamp) WHERE r.at < now()`,
  ],
  [
    'a CTE named as the UPDATE target',
    `WITH task AS (SELECT id FROM aware) UPDATE task SET lease_until = now()`,
  ],
  [
    'a CTE named as the DELETE target',
    `WITH task AS (SELECT id FROM aware) DELETE FROM task WHERE lease_until < now()`,
  ],
  [
    'a call in FROM',
    `SELECT d.id FROM due_tasks() d JOIN aware a ON a.id = d.id WHERE d.lease_until < now()`,
  ],
  [
    'a comment inside an E-string',
    `UPDATE task SET id = E'it\\'s -- note', lease_until = now() WHERE id = $1`,
  ],
  // The general rule: what does not lex is still read, never skipped.
  ['an unterminated string clock', `UPDATE task SET lease_until = 'now`],
  [
    'a stray quote hides nothing',
    `SELECT id FROM aware; it's: UPDATE task SET lease_until = now()`,
  ],
  [
    'a pin in a piece of a statement',
    `UPDATE task SET lease_until = now() AT TIME ZONE 'UTC'), x)`,
  ],
]) {
  test(`refused: ${name}`, () => {
    assert.notEqual(problemsIn(sql, scope).length, 0, sql);
  });
}

for (const [name, sql] of [
  ['pinned comparison', `SELECT id FROM task WHERE lease_until <= (now() AT TIME ZONE 'UTC')`],
  ['pinned lowercase', `SELECT id FROM task WHERE lease_until <= (now() at time zone 'utc')`],
  ['timezone()', `UPDATE task SET lease_until = timezone('UTC', clock_timestamp())`],
  ['floored', `UPDATE task SET lease_until = date_trunc('milliseconds', now() AT TIME ZONE 'UTC')`],
  ['a timestamptz column', `UPDATE aware SET seen_at = now()`],
  ['a reading of the clock', `SELECT clock_timestamp() AS now`],
  ['a cast reading', `SELECT clock_timestamp()::timestamptz(3) AS now`],
  ['an insert naming the columns', `INSERT INTO task (id, due_at, added_at) VALUES ($1, $2, $3)`],
  ['a comment', `-- now()\nSELECT 1`],
  ['a string', `SELECT 'now and then, a word in a sentence' FROM task WHERE lease_until IS NULL`],
  // PR #906 r1 F2: the reviewer's false positive, and the class.
  ['a parenthesized clock', `UPDATE task SET lease_until = (clock_timestamp()) AT TIME ZONE 'UTC'`],
  ['nested parentheses', `UPDATE task SET lease_until = ((now())) AT TIME ZONE 'UTC'`],
  [
    'grouped after a keyword',
    `SELECT (now()) AT TIME ZONE 'UTC' FROM task WHERE lease_until IS NULL`,
  ],
  ['qualified timezone()', `UPDATE task SET lease_until = pg_catalog.timezone('UTC', now())`],
  ['quoted timezone()', `UPDATE task SET lease_until = "timezone"('UTC', now())`],
  ['the printed form', `UPDATE task SET lease_until = timezone('UTC'::text, now())`],
  ['parenthesized in timezone()', `UPDATE task SET lease_until = timezone('UTC', (now()))`],
  ['a quoted clock, pinned', `UPDATE task SET lease_until = pg_catalog."now"() AT TIME ZONE 'UTC'`],
  [
    'pinned, then a plain timestamp cast',
    `UPDATE task SET lease_until = (now() AT TIME ZONE 'UTC')::timestamp(3)`,
  ],
  ['SET DEFAULT on a safe column', `UPDATE task SET made_at = DEFAULT`],
  ['DEFAULT on a timestamptz table', `UPDATE aware SET seen_at = DEFAULT`],
  // The pins production writes (FU-226): a clause, a CTE body, a call ending the timestamp.
  [
    'a pin under extract()',
    `SELECT extract(epoch FROM (now() AT TIME ZONE 'UTC') - min(lease_until)) FROM task`,
  ],
  [
    'a pin in FILTER (WHERE …)',
    `SELECT count(*) FILTER (WHERE lease_until <= (now() AT TIME ZONE 'UTC')) FROM task`,
  ],
  [
    'a pin in a CTE UPDATE',
    `WITH c AS (UPDATE task SET lease_until = (now() AT TIME ZONE 'UTC') RETURNING id) SELECT id FROM c`,
  ],
  [
    'a pin under to_char() in another call',
    `UPDATE task SET lease_until = $1 WHERE jsonb_build_object('a', to_char(now() AT TIME ZONE 'UTC', 'YYYY')) IS NOT NULL`,
  ],
  [
    'a floored pin plus an interval',
    `UPDATE task SET lease_until = date_trunc('milliseconds', now() AT TIME ZONE 'UTC') + interval '1 second'`,
  ],
  [
    'a pin before FOR UPDATE',
    `SELECT id FROM task WHERE lease_until < now() AT TIME ZONE 'UTC' FOR UPDATE SKIP LOCKED`,
  ],
  ['a pin before ORDER … DESC', `SELECT id FROM task ORDER BY now() AT TIME ZONE 'UTC' DESC`],
  [
    'a sentence mentioning now',
    `UPDATE task SET lease_until = $1 WHERE note = 'it is ended from now on, never in the past'`,
  ],
  ['FOR UPDATE is no write', `SELECT id FROM task WHERE id = $1 FOR UPDATE`],
  ['a catalogue read', `SELECT now() - backend_start FROM pg_stat_activity`],
  ['a clock over a CTE', `WITH c AS (SELECT id FROM aware) SELECT now() FROM c`],
]) {
  test(`allowed: ${name}`, () => {
    assert.deepEqual(problemsIn(sql, scope), []);
  });
}

test('R4 reads the signature: a timestamptz parameter or result is no conversion', () => {
  const sql = (signature) =>
    `CREATE TABLE aware (at timestamptz(3)); CREATE FUNCTION f(${signature} LANGUAGE plpgsql AS $$BEGIN PERFORM 1 FROM aware; RETURN now(); END$$;`;
  assert.deepEqual(live(sql('x timestamptz) RETURNS timestamptz(3)')), []);
  assert.deepEqual(live(sql('x timestamp with time zone) RETURNS boolean')), []);
  assert.notEqual(live(sql('x timestamp(3)) RETURNS boolean')).length, 0);
});

test('R4: a timestamp variable beside a bare clock is refused, a timestamptz one is not', () => {
  const body = (type) =>
    `DECLARE opens ${type}; BEGIN IF clock_timestamp() < opens THEN RETURN NEW; END IF; END`;
  assert.equal(localVariableProblems(body('timestamp(3)')).length, 1);
  assert.equal(localVariableProblems(body('timestamp')).length, 1);
  assert.equal(localVariableProblems(body('timestamp without time zone')).length, 1);
  assert.deepEqual(localVariableProblems(body('timestamptz(3)')), []);
  assert.deepEqual(localVariableProblems(body('timestamp with time zone')), []);
});

test('R4 reads types as PostgreSQL does: qualified, quoted, a DEFAULT, a cast, an anchor', () => {
  const routine = (declare) =>
    `CREATE TABLE aware (at timestamptz(3)); CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$DECLARE ${declare}; BEGIN PERFORM 1 FROM aware WHERE at < now(); END$$;`;
  for (const declare of [
    'v timestamp DEFAULT now()',
    'v pg_catalog.timestamp := now()',
    'v "timestamp"(3)',
    'v aware.at%TYPE',
    'r aware%ROWTYPE',
    'v int := extract(epoch FROM now()::timestamp)',
  ]) {
    assert.match(live(routine(declare)).join(), /R4/, declare);
  }
  assert.deepEqual(live(routine('v pg_catalog.timestamptz')), []);
});

test('a trigger assigning a bare clock names no table, and is still refused', () => {
  assert.notEqual(problemsIn(`BEGIN NEW."due_at" := now(); RETURN NEW; END`, scope).length, 0);
});

// PR #906 r1 F2, the reviewer's four, on the reviewer's table: its only default is due_at's.
const reviewers = replayMigrations([
  `CREATE TABLE task (id text, due_at timestamp(3) DEFAULT CURRENT_TIMESTAMP)`,
]).tables;
const reviewersScope = new Map([['task', [reviewers.get('task')]]]);
for (const sql of [
  `INSERT INTO task (id,due_at) VALUES ($1,DEFAULT)`,
  `UPDATE task SET due_at=DEFAULT`,
  `UPDATE task SET due_at=pg_catalog."now"()`,
  `UPDATE unknown_table SET due_at=now()`,
  // The same, spelled otherwise.
  `INSERT INTO task (id,due_at) VALUES ($1,$2),($3,DEFAULT)`,
  `INSERT INTO task (id,due_at) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET due_at = DEFAULT`,
]) {
  test(`the reviewer's probe is refused: ${sql}`, () => {
    assert.notEqual(problemsIn(sql, reviewersScope).length, 0);
  });
}

test('explicit DEFAULT on a column whose default is safe stays allowed', () => {
  const { tables: t } = replayMigrations([
    `CREATE TABLE s (id text, made_at timestamp(3) DEFAULT timezone('UTC', now()), n int DEFAULT 1)`,
  ]);
  const only = new Map([['s', [t.get('s')]]]);
  assert.deepEqual(problemsIn(`INSERT INTO s (id, made_at) VALUES ($1, DEFAULT)`, only), []);
  assert.deepEqual(problemsIn(`UPDATE s SET made_at = DEFAULT, n = DEFAULT`, only), []);
});

const replaying = (sql) => replayMigrations([sql]);
const live = (sql) => {
  const { tables: t, functions: f, views: v } = replaying(sql);
  const s = new Map([...t].map(([table, columns]) => [table, [columns]]));
  return [...f.values(), ...v.values()].flatMap((definition) => definitionProblems(definition, s));
};
const TS = `CREATE TABLE task (id text, due_at timestamp(3));`;
const BODY = `BEGIN UPDATE task SET due_at = now(); RETURN NEW; END`;

for (const [name, sql] of [
  ['a dollar body', `${TS} CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$${BODY}$$;`],
  ['a tagged body', `${TS} CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $x$${BODY}$x$;`],
  [
    'a single-quoted body',
    `${TS} CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS '${BODY}';`,
  ],
  [
    'AS before LANGUAGE',
    `${TS} CREATE FUNCTION f() RETURNS trigger AS '${BODY}' LANGUAGE plpgsql;`,
  ],
  [
    'a quoted body with a doubled quote',
    `${TS} CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN UPDATE task SET due_at = ''now''; RETURN NEW; END';`,
  ],
  [
    'a procedure',
    `${TS} CREATE PROCEDURE p() LANGUAGE plpgsql AS $$BEGIN UPDATE task SET due_at = now(); END$$;`,
  ],
  [
    'a standard SQL function',
    `${TS} CREATE FUNCTION f() RETURNS timestamp LANGUAGE sql RETURN now();`,
  ],
  ['a view', `${TS} CREATE VIEW v AS SELECT id FROM task WHERE due_at <= now();`],
  [
    'a materialized view',
    `${TS} CREATE MATERIALIZED VIEW v AS SELECT id FROM task WHERE due_at <= now();`,
  ],
  [
    'a replaced view',
    `${TS} CREATE OR REPLACE VIEW v AS SELECT id FROM task WHERE due_at <= clock_timestamp();`,
  ],
  [
    'a timestamp parameter',
    `CREATE TABLE aware (at timestamptz(3)); CREATE FUNCTION f(x timestamp) RETURNS boolean LANGUAGE plpgsql AS $$BEGIN PERFORM 1 FROM aware; RETURN x < now(); END$$;`,
  ],
  [
    'a timestamp result',
    `CREATE TABLE aware (at timestamptz(3)); CREATE FUNCTION f() RETURNS timestamp(3) LANGUAGE plpgsql AS $$BEGIN PERFORM 1 FROM aware; RETURN now(); END$$;`,
  ],
  [
    'dynamic SQL',
    `CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$BEGIN EXECUTE 'UPDATE task SET due_at = now()'; END$$;`,
  ],
  [
    'an overload is not overwritten',
    `${TS} CREATE FUNCTION f(a int) RETURNS void LANGUAGE plpgsql AS $$BEGIN UPDATE task SET due_at = now(); END$$; CREATE FUNCTION f(a text) RETURNS void LANGUAGE plpgsql AS $$BEGIN NULL; END$$;`,
  ],
  [
    'dropping another overload keeps it',
    `${TS} CREATE FUNCTION f(a int) RETURNS void LANGUAGE plpgsql AS $$BEGIN UPDATE task SET due_at = now(); END$$; DROP FUNCTION f(text);`,
  ],
]) {
  test(`a live definition is replayed and refused: ${name}`, () => {
    assert.notEqual(live(sql).length, 0, sql);
  });
}

test('a trigger routine is read against the table it fires on', () => {
  const {
    tables: t,
    functions: f,
    triggers,
  } = replaying(
    `CREATE TABLE task (due_at timestamp(3)); CREATE TABLE aware (at timestamptz(3));
     CREATE FUNCTION stamp() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
       PERFORM 1 FROM aware; NEW."due_at" := now(); RETURN NEW; END$$;
     CREATE TRIGGER x BEFORE INSERT ON "task" FOR EACH ROW EXECUTE FUNCTION stamp();`,
  );
  const s = new Map([...t].map(([table, columns]) => [table, [columns]]));
  const [stamp] = f.values();
  assert.deepEqual(definitionProblems(stamp, s), []);
  assert.match(definitionProblems(stamp, s, triggers.get('stamp')).join(), /task\.due_at/);
});

test('a routine with a RAISE or SELECT INTO still names no table for its bare clock', () => {
  for (const body of [
    `BEGIN NEW."due_at" := now(); RAISE EXCEPTION 'x' USING ERRCODE = 'y'; RETURN NEW; END`,
    `BEGIN NEW."due_at" := now(); SELECT 1 INTO v; RETURN NEW; END`,
  ]) {
    assert.match(
      definitionProblems({ body, header: '', language: 'plpgsql' }, scope).join(),
      /R3/,
      body,
    );
  }
});

test('a definition replaced or dropped is no longer read', () => {
  const unsafe = `${TS} CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$BEGIN UPDATE task SET due_at = now(); END$$;`;
  const safe = `CREATE OR REPLACE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$BEGIN NULL; END$$;`;
  assert.deepEqual(live(`${unsafe} ${safe}`), []);
  assert.deepEqual(live(`${unsafe} DROP FUNCTION f;`), []);
  assert.deepEqual(
    live(`${TS} CREATE VIEW v AS SELECT now() FROM task WHERE due_at IS NULL; DROP VIEW v;`),
    [],
  );
  assert.deepEqual(replaying(`${unsafe} DROP PROCEDURE IF EXISTS f();`).functions.size, 0);
});

test('a semicolon or comment in a body or string splits nothing', () => {
  const {
    tables: t,
    functions: f,
    unmodelled,
  } = replaying(
    `-- CREATE TABLE commented (at timestamp(3));
     /* DROP TABLE kept; */
     CREATE TABLE kept (note text DEFAULT 'a;b,c', at timestamp(3) DEFAULT now());
     CREATE FUNCTION g() RETURNS void LANGUAGE plpgsql AS 'BEGIN PERFORM 1; PERFORM 2; END';
     CREATE TABLE after_it (at timestamp(3));\r\nCOMMENT ON TABLE kept IS 'a; DROP TABLE kept';`,
  );
  assert.deepEqual([...t.keys()], ['kept', 'after_it']);
  assert.deepEqual([...t.get('kept').keys()], ['note', 'at']);
  assert.equal(t.get('kept').get('at').sessionDefault, true);
  assert.equal(f.size, 1);
  assert.deepEqual(unmodelled, []);
});

for (const [name, sql] of [
  ['an unknown statement', `CREATE RULE r AS ON INSERT TO t DO NOTHING;`],
  ['a domain', `CREATE DOMAIN d AS timestamp(3) DEFAULT now();`],
  ['an aggregate', `CREATE AGGREGATE a (int) (sfunc = f, stype = int);`],
  ['a renamed function', `ALTER FUNCTION f() RENAME TO g;`],
  ['a table of another schema', `CREATE TABLE other.t (at timestamp(3));`],
  ['CREATE TABLE AS', `CREATE TABLE t AS SELECT now() AS at;`],
  ['CREATE TABLE LIKE', `CREATE TABLE s (at timestamp(3)); CREATE TABLE t (LIKE s INCLUDING ALL);`],
  ['INHERITS', `CREATE TABLE s (at timestamp(3)); CREATE TABLE t (id int) INHERITS (s);`],
  ['PARTITION OF an unknown table', `CREATE TABLE t PARTITION OF nothing DEFAULT;`],
  ['ALTER of an unknown table', `ALTER TABLE nothing ADD COLUMN at timestamp(3) DEFAULT now();`],
  ['RENAME of an unknown table', `ALTER TABLE nothing RENAME TO t;`],
  [
    'SET DEFAULT on an unknown column',
    `CREATE TABLE t (id int); ALTER TABLE t ALTER COLUMN at SET DEFAULT now();`,
  ],
  [
    'SET TYPE on an unknown column',
    `CREATE TABLE t (id int); ALTER TABLE t ALTER COLUMN at TYPE timestamp(3);`,
  ],
  [
    'DROP DEFAULT on an unknown column',
    `CREATE TABLE t (id int); ALTER TABLE t ALTER COLUMN at DROP DEFAULT;`,
  ],
  [
    'RENAME COLUMN of an unknown column',
    `CREATE TABLE t (id int); ALTER TABLE t RENAME COLUMN at TO was;`,
  ],
  ['an ALTER action not modelled', `CREATE TABLE t (id int); ALTER TABLE t INHERIT s;`],
  ['a CHECK with a clock', `CREATE TABLE t (at timestamp(3), CHECK (at < now()));`],
  ['an inline CHECK with a clock', `CREATE TABLE t (at timestamp(3) CHECK (at < now()));`],
  [
    'a generated column with a clock',
    `CREATE TABLE t (at timestamp(3) GENERATED ALWAYS AS (now()) STORED);`,
  ],
  [
    'an added CHECK with a clock',
    `CREATE TABLE t (at timestamp(3)); ALTER TABLE t ADD CONSTRAINT c CHECK (at < now());`,
  ],
  [
    'an added CHECK not modelled',
    `CREATE TABLE t (at timestamp(3)); ALTER TABLE t ADD CHECK (at IS NOT NULL);`,
  ],
  [
    'a trigger WHEN with a clock',
    `CREATE TRIGGER x BEFORE UPDATE ON t FOR EACH ROW WHEN (NEW.at < now()) EXECUTE FUNCTION f();`,
  ],
  ['a policy with a clock', `CREATE POLICY p ON t USING (at < now());`],
  ['an index with a clock', `CREATE INDEX i ON t (at) WHERE at < now();`],
  [
    'a routine in a language not read',
    `CREATE FUNCTION f() RETURNS void LANGUAGE plpython3u AS $$x$$;`,
  ],
  ['a C routine', `CREATE FUNCTION f() RETURNS void LANGUAGE c AS 'lib', 'sym';`],
  ['a routine with no language', `CREATE FUNCTION f() RETURNS void AS $$x$$;`],
  [
    'an escape-string body',
    `CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS E'BEGIN NULL; END';`,
  ],
  [
    'a routine outside public',
    `CREATE FUNCTION other.f() RETURNS void LANGUAGE plpgsql AS $$BEGIN NULL; END$$;`,
  ],
  [
    'a BEGIN ATOMIC body',
    `CREATE FUNCTION f() RETURNS void LANGUAGE sql BEGIN ATOMIC SELECT 1; END;`,
  ],
]) {
  test(`a migration form not modelled is refused: ${name}`, () => {
    assert.notEqual(replaying(sql).unmodelled.length, 0, sql);
  });
}

test('DDL in a DO block is collected for review; a DO without DDL is one-shot', () => {
  assert.equal(
    replaying(`DO $$BEGIN CREATE FUNCTION f() RETURNS void AS 'x'; END$$;`).doBlocks.length,
    1,
  );
  assert.equal(
    replaying(`DO $$BEGIN EXECUTE 'ALTER TABLE t ADD COLUMN a timestamp(3)'; END$$;`).doBlocks
      .length,
    1,
  );
  assert.equal(replaying(`DO $$BEGIN RAISE NOTICE 'x'; END$$;`).doBlocks.length, 0);
  // PR #906 r2 F2: read from the body's tokens, so format() hides nothing and a hint is no DDL.
  assert.equal(
    replaying(`DO $$BEGIN EXECUTE format('CREATE %s v AS SELECT now()', 'VIEW'); END$$;`).doBlocks
      .length,
    1,
  );
  assert.equal(
    replaying(`DO $$BEGIN ALTER TABLE t ALTER COLUMN a SET DEFAULT now(); END$$;`).doBlocks.length,
    1,
  );
  assert.equal(
    replaying(`DO $$BEGIN RAISE 'run CREATE FUNCTION first'; END$$;`).doBlocks.length,
    0,
  );
  assert.notEqual(replaying(`DO LANGUAGE plpython3u $$x$$;`).unmodelled.length, 0);
  // A backslash read either way: with standard_conforming_strings off, \x41LTER is ALTER.
  assert.equal(replaying(`DO 'BEGIN \\x41LTER TABLE t ADD COLUMN a int; END';`).doBlocks.length, 1);
  assert.notEqual(replaying(`DO $$BEGIN RAISE 'x; END$$;`).unmodelled.length, 0);
});

test('a default that may read the clock counts as session-dependent, also through an unknown call', () => {
  const { tables: t } = replaying(
    `CREATE TABLE t (a timestamp(3) DEFAULT my_clock(), b timestamp(3) DEFAULT timezone('UTC', now()),
       c timestamp(3) DEFAULT 'now', d timestamp(3) DEFAULT date_trunc('milliseconds', now() AT TIME ZONE 'UTC'),
       e timestamp(3) DEFAULT '2020-01-01');`,
  );
  const session = (column) => t.get('t').get(column).sessionDefault;
  assert.deepEqual(['a', 'b', 'c', 'd', 'e'].map(session), [true, false, true, false, false]);
});

test('conditional DDL replays as PostgreSQL runs it (PR #906 r2 F2)', () => {
  const at = (sql) => replaying(`CREATE TABLE t (at timestamp(3) DEFAULT now()); ${sql}`);
  // IF NOT EXISTS on a column already there is a no-op: its default stays.
  assert.equal(
    at(`ALTER TABLE t ADD COLUMN IF NOT EXISTS at timestamp(3);`).tables.get('t').get('at')
      .sessionDefault,
    true,
  );
  assert.notEqual(at(`ALTER TABLE t ADD COLUMN at timestamp(3);`).unmodelled.length, 0);
  assert.notEqual(at(`ALTER TABLE t DROP COLUMN gone;`).unmodelled.length, 0);
  assert.deepEqual(at(`ALTER TABLE t DROP COLUMN IF EXISTS gone;`).unmodelled, []);
});

test('a partition has a map of its own; its own defaults and column ALTERs are refused', () => {
  const tree = `CREATE TABLE p (id int, at timestamp(3) DEFAULT now()) PARTITION BY RANGE (at);`;
  const { tables: t } = replaying(`${tree} CREATE TABLE p_1 PARTITION OF p DEFAULT;`);
  assert.notEqual(t.get('p'), t.get('p_1'));
  for (const sql of [
    `CREATE TABLE p_1 PARTITION OF p (at DEFAULT now()) FOR VALUES FROM ('2020-01-01') TO ('2021-01-01');`,
    `CREATE TABLE p_1 PARTITION OF p DEFAULT; ALTER TABLE ONLY p_1 ALTER COLUMN at DROP DEFAULT;`,
    `CREATE TABLE p_1 PARTITION OF p DEFAULT; ALTER TABLE p ALTER COLUMN at SET DEFAULT now();`,
    `CREATE TABLE p_1 PARTITION OF p DEFAULT; ALTER TABLE p RENAME TO q;`,
  ]) {
    assert.notEqual(replaying(`${tree} ${sql}`).unmodelled.length, 0, sql);
  }
  assert.deepEqual(
    replaying(`${tree} ALTER TABLE p ADD CONSTRAINT c UNIQUE (id, at);`).unmodelled,
    [],
  );
});

test('a type is read as PostgreSQL reads it: qualified or quoted, it is the same', () => {
  const type = (declaration) =>
    replaying(`CREATE TABLE t (at ${declaration});`).tables.get('t').get('at').type;
  assert.equal(type('pg_catalog.timestamp(3)'), 'ts');
  assert.equal(type('"timestamp"(3)'), 'ts');
  assert.equal(type('timestamp(3) without time zone'), 'ts');
  assert.equal(type('pg_catalog.timestamptz'), 'tz');
  assert.equal(type('timestamp(3) with time zone'), 'tz');
  assert.equal(type('other.timestamp'), 'other');
});

test('a trigger binding it cannot resolve, DDL in a routine, a statement it cannot read: refused', () => {
  for (const sql of [
    `CREATE TABLE t (id int); CREATE TRIGGER x BEFORE INSERT ON other.t FOR EACH ROW EXECUTE FUNCTION f();`,
    `CREATE TRIGGER x BEFORE INSERT ON nothing FOR EACH ROW EXECUTE FUNCTION f();`,
    `CREATE TABLE t (id int); CREATE TRIGGER x BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION other.f();`,
    `CREATE TABLE t (at timestamp(3) DEFAULT 'now`,
    `CREATE TABLE t (at timestamp(3);`,
  ]) {
    assert.notEqual(replaying(sql).unmodelled.length, 0, sql);
  }
  for (const sql of [
    `CREATE TYPE span AS (opened timestamp(3));`,
    `CREATE TABLE t ("due-at" timestamp(3) DEFAULT CURRENT_TIMESTAMP);`,
    `CREATE TABLE a (id int); DROP TABLE a, other.b;`,
  ]) {
    assert.notEqual(replaying(sql).unmodelled.length, 0, sql);
  }
  const { tables: dropped } = replaying(
    `CREATE TABLE a (id int); CREATE TABLE b (at timestamptz); DROP TABLE a, "b" CASCADE;`,
  );
  assert.deepEqual([...dropped.keys()], []);
  // A trigger is bound as PostgreSQL binds it: the name folded, and through a table rename.
  for (const sql of [
    `CREATE TRIGGER x BEFORE INSERT ON task FOR EACH ROW EXECUTE FUNCTION Touch();`,
    `CREATE TRIGGER x BEFORE INSERT ON task FOR EACH ROW EXECUTE FUNCTION touch(); ALTER TABLE task RENAME TO job;`,
  ]) {
    const r = replaying(
      `CREATE TABLE task (lease_until timestamp(3)); CREATE TABLE aware (at timestamptz(3));
       CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM 1 FROM aware; NEW.lease_until := now(); RETURN NEW; END$$; ${sql}`,
    );
    const s = new Map([...r.tables].map(([table, columns]) => [table, [columns]]));
    const [touch] = r.functions.values();
    assert.match(
      definitionProblems(touch, s, r.triggers.get('touch')).join(),
      /of its trigger's table/,
      sql,
    );
  }
  assert.notEqual(
    contentHash(`BEGIN RAISE NOTICE E'can\\'t -- a'; END`),
    contentHash(`BEGIN RAISE NOTICE E'can\\'t -- b'; END`),
  );
  assert.match(
    live(
      `CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$BEGIN ALTER TABLE t ADD COLUMN a int; END$$;`,
    ).join(),
    /DDL in a routine body/,
  );
});

test('IF NOT EXISTS on a known table leaves what is known', () => {
  const { tables: t } = replaying(
    `CREATE TABLE t (at timestamp(3)); CREATE TABLE IF NOT EXISTS t (at timestamptz(3));`,
  );
  assert.equal(t.get('t').get('at').type, 'ts');
});

test('a mixed-case column is the column', () => {
  const { tables: t } = replaying(`CREATE TABLE t (Due_At timestamp(3) DEFAULT now());`);
  const s = new Map([['t', [t.get('t')]]]);
  assert.notEqual(problemsIn(`UPDATE t SET due_at = now()`, s).length, 0);
  assert.notEqual(problemsIn(`UPDATE t SET due_at = DEFAULT`, s).length, 0);
  assert.notEqual(problemsIn(`INSERT INTO t (due_at) VALUES (DEFAULT)`, s).length, 0);
  assert.deepEqual(problemsIn(`INSERT INTO t (due_at) VALUES ($1)`, s), []);
});

test('a partition has the columns of its parent', () => {
  const { tables: t, unmodelled } = replaying(
    `CREATE TABLE p (at timestamp(3) DEFAULT now()) PARTITION BY RANGE (at);
     CREATE TABLE p_1 PARTITION OF p DEFAULT;`,
  );
  assert.deepEqual(unmodelled, []);
  assert.equal(t.get('p_1').get('at').sessionDefault, true);
});

test('a reviewed exemption is bound to the reviewed content', () => {
  assert.equal(contentHash(`BEGIN  x; -- note\r\nEND`), contentHash(`BEGIN x;\nEND`));
  assert.notEqual(contentHash(`BEGIN x; END`), contentHash(`BEGIN y; END`));
  // Inside a string a line ending is a token's content: canonical, so CRLF = LF (checklist 16).
  assert.equal(contentHash(`RAISE 'a\r\nb'`), contentHash(`RAISE 'a\nb'`));
  assert.notEqual(contentHash(`RAISE 'a b'`), contentHash(`RAISE 'a\nb'`));
  for (const entry of [...REVIEWED_FUNCTIONS, ...REVIEWED_DO_BLOCKS]) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.ok(entry.why.length > 0);
  }
  for (const entry of REVIEWED_LITERALS) {
    assert.ok((entry.text ?? entry.sha256).length > 0 && entry.why.length > 0);
  }
});

test('a routine exemption is bound to signature, trigger bindings and column types (PR #906 r2 F2)', () => {
  const sql = (extra = '') =>
    `CREATE TABLE f (recorded_at timestamptz(3)); CREATE TABLE g (recorded_at timestamptz(3));
     CREATE FUNCTION stamp() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW."recorded_at" := clock_timestamp(); RETURN NEW; END$$;
     CREATE TRIGGER x BEFORE INSERT ON f FOR EACH ROW EXECUTE FUNCTION stamp(); ${extra}`;
  const binding = (text) => {
    const r = replaying(text);
    const s = new Map([...r.tables].map(([table, columns]) => [table, [columns]]));
    const [routine] = r.functions.values();
    return definitionBinding(routine, s, r.triggers.get(routine.name));
  };
  const reviewed = binding(sql());
  assert.equal(binding(sql().replaceAll(' ', '  ').replaceAll('\n', '\r\n')), reviewed);
  for (const changed of [
    sql('CREATE TRIGGER y BEFORE INSERT ON g FOR EACH ROW EXECUTE FUNCTION stamp();'),
    sql('ALTER TABLE f ALTER COLUMN recorded_at TYPE timestamp(3);'),
    sql('ALTER TABLE f ADD COLUMN at timestamp(3);'),
    sql().replace('stamp()', 'stamp(a int)'),
    sql().replace('RETURNS trigger', 'RETURNS trigger SECURITY DEFINER'),
  ]) {
    assert.notEqual(binding(changed), reviewed, changed);
  }
});

test('clocksIn reports each clock on its own', () => {
  const clocks = (sql) => clocksIn(lex(sql)).map((clock) => clock.utc);
  assert.deepEqual(clocks(`SELECT now(), now() AT TIME ZONE 'UTC'`), [false, true]);
});

/** The whole scan over a repository of one service, in a git checkout of its own. */
function scanOf(service, migration, source = '', extra = {}, collect = utcClockProblems) {
  const migrations = typeof migration === 'string' ? [['1_init', migration]] : migration;
  const root = mkdtempSync(join(tmpdir(), 'utc-clock-sites-'));
  try {
    const write = (path, text) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    for (const [name, text] of migrations)
      write(`services/${service}/prisma/migrations/${name}/migration.sql`, text);
    write(`services/${service}/prisma/schema.prisma`, 'model Anything {\n  id String @id\n}\n');
    // Generated declarations prove Sql versus scalar types, but are not authored sinks.
    write('.gitignore', '**/generated/prisma/index.d.ts\n');
    write(`services/${service}/src/generated/prisma/index.d.ts`, `export namespace Prisma {
      class Sql { strings: string[]; values: unknown[]; }
      function sql(strings: TemplateStringsArray, ...values: unknown[]): Sql;
      function join(values: readonly unknown[], separator?: string, prefix?: string, suffix?: string): Sql;
      function raw(value: string): Sql;
      const empty: Sql;
    }`);
    write(`services/${service}/src/temporal/saga-start.store.ts`, source);
    for (const [path, text] of Object.entries(extra)) write(path, text);
    execFileSync('git', ['init', '-q'], { cwd: root, env: fixtureGitEnv() });
    execFileSync('git', ['add', '-A'], { cwd: root, env: fixtureGitEnv() });
    // The reviewed entries name this repository's sites, which that one does not have.
    return collect(root).filter((problem) => typeof problem !== 'string' || !problem.startsWith('stale reviewed entry'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the scan reads a clock-free DEFAULT in production source', () => {
  const migration = `CREATE TABLE task (id text, due_at timestamp(3) DEFAULT CURRENT_TIMESTAMP);`;
  const source = 'export const sql = `UPDATE task SET due_at = DEFAULT WHERE id = $1`;';
  assert.deepEqual(scanOf('x-service', migration), []);
  assert.match(scanOf('x-service', migration, source).join(), /R2 update leaves task\.due_at/);
});

test('the scan refuses what the replay could not model', () => {
  assert.match(scanOf('x-service', `CREATE DOMAIN d AS int;`).join(), /not modelled/);
  assert.match(
    scanOf('x-service', `DO $$BEGIN EXECUTE 'CREATE TABLE t (id int)'; END$$;`).join(),
    /DDL or SQL in a DO block/,
  );
});

/** This repository's migrations of `service`, as [directory, text], to replay in a fixture. */
const migrationsOf = (service) =>
  authoredFiles(join(REPOSITORY, 'services', service, 'prisma/migrations'))
    .filter((path) => path.endsWith('/migration.sql'))
    .sort()
    .map((path) => [basename(dirname(path)), readFileSync(path, 'utf8')]);

test('an exemption holds for what was reviewed, and not once a trigger binds it elsewhere', () => {
  const analytics = migrationsOf('analytics-service');
  assert.deepEqual(scanOf('analytics-service', analytics), []);
  // The reviewer's probe: the unchanged routine attached to a table whose recorded_at is timestamp(3).
  const attached = [
    ...analytics,
    [
      '99999999999999_attach',
      `CREATE TABLE "fact_new" ("recorded_at" TIMESTAMP(3) NOT NULL);
       CREATE TRIGGER "fact_new_recorded_at" BEFORE INSERT ON "fact_new"
         FOR EACH ROW EXECUTE FUNCTION fact_recorded_at_now();`,
    ],
  ];
  assert.match(
    scanOf('analytics-service', attached).join(),
    /fact_recorded_at_now: R1 .*fact_new\.recorded_at/,
  );
  assert.match(scanOf('other-service', analytics).join(), /fact_recorded_at_now: R3/);
});

test('a DO block exemption holds in its own migration only', () => {
  const [entry] = REVIEWED_DO_BLOCKS;
  const migrations = migrationsOf(entry.service);
  assert.deepEqual(scanOf(entry.service, migrations), []);
  const [, text] = migrations.find(([name]) => name === entry.migration);
  const copy = /DO \$canonicalise\$[\s\S]*?\$canonicalise\$;/.exec(text)[0];
  assert.match(
    scanOf(entry.service, [...migrations, ['99999999999999_copy', copy]]).join(),
    /DDL or SQL in a DO block/,
  );
});

test('a literal exemption holds while the column types it assumed hold', () => {
  const marketplace = migrationsOf('marketplace-service');
  const source = readFileSync(
    join(REPOSITORY, 'services/marketplace-service/src/temporal/saga-start.store.ts'),
    'utf8',
  );
  assert.deepEqual(scanOf('marketplace-service', marketplace, source), []);
  const retyped = [
    ...marketplace,
    ['99999999999999_retype', `ALTER TABLE "order" ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(3);`],
  ];
  assert.match(
    scanOf('marketplace-service', retyped, source).join(),
    /saga-start\.store\.ts:61: R1/,
  );
});

test('a reviewed DO block covers its reviewed content only', () => {
  const [entry] = REVIEWED_DO_BLOCKS;
  assert.match(
    scanOf(entry.service, `DO $$BEGIN EXECUTE 'CREATE VIEW v AS SELECT 1'; END$$;`).join(),
    /DDL or SQL in a DO block/,
  );
});

// PR #979 r1: what the guard cannot read is refused, never read as absent.
for (const [name, sql] of [
  // F1: a U& identifier, SQL in a string, a DO or EXECUTE statement (the review's probes).
  ['F1 a U& clock', String.raw`UPDATE task SET lease_until = U&"\006Eow"()`],
  ['F1 a U& clock with UESCAPE', `UPDATE task SET lease_until = U&"!006Eow" UESCAPE '!' ()`],
  ['F1 a U& column', String.raw`UPDATE task SET U&"lease\005Funtil" = now()`],
  ['F1 a DO block', `DO $$ BEGIN UPDATE task SET lease_until = now(); END $$`],
  ['F1 EXECUTE', `SELECT 1 FROM aware; EXECUTE 'UPDATE task SET lease_until = now()'`],
  ['F1 a DO block with no SQL', `DO $$ BEGIN NULL; END $$`],
  ['F1 EXECUTE of a prepared statement', `SELECT 1 FROM aware; EXECUTE stamp_task`],
  // The class: SQL in any string (a scheduled job), a string it cannot decode, a search_path.
  [
    'F1 SQL in a string',
    `SELECT cron.schedule('j', '* * * * *', 'INSERT INTO task (id) VALUES (1)')`,
  ],
  ['F1 a clock call in a string', `SELECT 1 FROM aware WHERE id = $1 AND 'now()' IS NOT NULL`],
  ['F1 a string with UESCAPE', `SELECT 1 FROM aware WHERE id = U&'!0061' UESCAPE '!'`],
  ['F3 a search_path change', `SET search_path TO shadow`],
  ['F3 a setting not named', `SELECT set_config($1, 'shadow', true) FROM aware`],
  ['F3 SET ROLE ("$user" is on the search_path)', `SET ROLE tenant_owner`],
  ['F3 set_config of the role', `SELECT set_config('role', 'tenant_owner', false)`],
  ['F3 a quoted schema keeps its case', `UPDATE "PUBLIC".aware SET seen_at = now()`],
  ['F3 a quoted table keeps its case', `UPDATE "Aware" SET seen_at = now()`],
  // F2: the two forms main refused, and a table named outside FROM.
  [
    'F2 a subquery CTE',
    `SELECT 1 FROM (WITH task AS (SELECT 1 AS id) SELECT id FROM task) s, task, aware WHERE task.lease_until < now()`,
  ],
  [
    'F2 a WINDOW name',
    `SELECT 1 FROM task, aware WHERE task.lease_until < now() WINDOW w AS (), task AS (ORDER BY 1)`,
  ],
  [
    'F2 a table in a cast',
    `SELECT 1 FROM aware WHERE (jsonb_populate_record(NULL::task, $1)).lease_until < now()`,
  ],
  // The class: a CTE name outside its WITH's scope is a relation to resolve (`x` is none).
  [
    'F2 out of its subquery',
    `SELECT 1 FROM (WITH x AS (SELECT 1 AS id) SELECT id FROM x) s, x, aware WHERE x.at < now()`,
  ],
  ['F2 a WINDOW', `SELECT 1 FROM x, aware WHERE x.at < now() WINDOW w AS (), x AS (ORDER BY 1)`],
  [
    'F2 after a WINDOW',
    `SELECT 1 FROM aware WINDOW w AS (), x AS (ORDER BY 1) ORDER BY (SELECT max(at) FROM x WHERE at < now())`,
  ],
  ['F2 in its own body', `WITH x AS (SELECT at FROM x WHERE at < now()) SELECT 1 FROM x, aware`],
  [
    'F2 a DELETE target is no CTE',
    `WITH x AS (SELECT 1) DELETE FROM x USING aware WHERE x.at < now()`,
  ],
]) {
  test(`unreadable is refused (PR #979 r1): ${name}`, () => {
    assert.notEqual(problemsIn(sql, scope).length, 0, sql);
  });
}

for (const [name, sql] of [
  [
    'prose in a string',
    `SELECT 1 FROM aware WHERE note = 'it''s an update of a row' AND seen_at < now()`,
  ],
  ['a statement word alone', `SELECT 1 FROM aware WHERE kind = 'UPDATE' AND seen_at < now()`],
  ['a named setting', `SELECT set_config('lock_timeout', $1, true)`],
  ['a SET that moves no name', `SET LOCAL lock_timeout = '1s'; SET app.tenant = 'x'`],
  ['a CTE in its scope', `WITH x AS (SELECT 1 AS id) SELECT now() FROM x, aware`],
  ['a quoted CTE in its scope', `WITH "X" AS (SELECT 1 AS id) SELECT now() FROM "X", aware`],
  [
    'a recursive CTE in its body',
    `WITH RECURSIVE x AS (SELECT 1 AS id UNION SELECT id FROM x) SELECT now() FROM x, aware`,
  ],
]) {
  test(`readable is read (PR #979 r1): ${name}`, () => {
    assert.deepEqual(problemsIn(sql, scope), []);
  });
}

const BASE = `CREATE TABLE task (id text, lease_until timestamp(3), due_at timestamp(3));`;
for (const [name, sql] of [
  // F3: the review's probes, then the class: a search_path change anywhere, a second CREATE.
  ['F3 SET search_path', `CREATE SCHEMA s; SET search_path TO s; CREATE TABLE task (id text);`],
  ['F3 set_config', `SELECT set_config('search_path', 's2', false);`],
  [
    'F3 "PUBLIC"',
    `CREATE SCHEMA "PUBLIC"; CREATE TABLE "PUBLIC".task (lease_until timestamptz(3));`,
  ],
  ['F3 "Public"', `ALTER TABLE "Public".task ALTER COLUMN lease_until TYPE timestamptz(3);`],
  ['F3 a second CREATE TABLE', `CREATE TABLE task (id text, lease_until timestamptz(3));`],
  ['F3 RESET', `RESET search_path;`],
  ['F3 a setting not named', `SELECT set_config(concat('search', '_path'), 's', false);`],
  ['F3 a DO block', `DO $$BEGIN PERFORM set_config('search_path', 's', false); END$$;`],
  ['F3 a DO block setting one not named', `DO $$BEGIN PERFORM set_config(v, 's', false); END$$;`],
  ['F3 SET SCHEMA', `SET SCHEMA 'shadow';`],
  ['F3 RESET ALL', `RESET ALL;`],
  ['F3 a DO block SET ROLE', `DO $$BEGIN SET ROLE tenant_owner; END$$;`],
  ['F3 CREATE SCHEMA ("$user")', `CREATE SCHEMA rasta;`],
  [
    'F3 a routine header',
    `CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql SET search_path = s AS $$BEGIN NULL; END$$;`,
  ],
  ['F3 a second PARTITION OF', `CREATE TABLE task PARTITION OF task DEFAULT;`],
  ['F3 a second view', `CREATE VIEW v AS SELECT 1; CREATE VIEW v AS SELECT 2;`],
  [
    'F3 a second routine',
    `CREATE FUNCTION f() RETURNS int LANGUAGE sql AS 'SELECT 1'; CREATE FUNCTION f() RETURNS int LANGUAGE sql AS 'SELECT 2';`,
  ],
  // F4: a quoted name the patterns would cut; the class: every quoted name they read.
  ['F4 a name with a space', `CREATE TABLE t (id text, "lease until" timestamp(3) DEFAULT now());`],
  ['F4 ADD COLUMN', `ALTER TABLE task ADD COLUMN "held until" timestamp(3) DEFAULT now();`],
  ['F4 DROP COLUMN', `ALTER TABLE task DROP COLUMN "lease_until x";`],
  [
    'F4 DROP FUNCTION',
    `CREATE FUNCTION my() RETURNS int LANGUAGE sql AS 'SELECT 1'; DROP FUNCTION "my fn"();`,
  ],
  [
    'F4 U& with UESCAPE',
    `ALTER TABLE task ADD COLUMN U&"at" UESCAPE '!' timestamp(3) DEFAULT now();`,
  ],
  // F4: a column definition read from its tokens, what it does not read refused.
  ['F4 a clause not read', `CREATE TABLE t (at timestamp(3) DEFAULT now() COLLATE "C");`],
  ['F4 a type not read', `CREATE TABLE t (at timestamp(3) varying);`],
  ['F4 a word after a clause', `CREATE TABLE t (at timestamp(3) NOT NULL whatever);`],
  [
    'F4 a clock in a CHECK after DEFAULT',
    `CREATE TABLE t (at timestamptz(3) DEFAULT now() CHECK (at < now()));`,
  ],
  // F1 in a migration: SQL in a string of a one-shot statement may run later.
  [
    'F1 a scheduled job',
    `SELECT cron.schedule('j', '* * * * *', $$UPDATE task SET lease_until = now()$$);`,
  ],
]) {
  test(`a migration the replay cannot read is refused (PR #979 r1): ${name}`, () => {
    assert.notEqual(replayMigrations([BASE, sql]).unmodelled.length, 0, sql);
  });
}

test('F3: a setting that moves no name replays', () => {
  const { unmodelled } = replayMigrations([
    BASE,
    `SET LOCAL lock_timeout = '5s'; SET CONSTRAINTS ALL IMMEDIATE; SELECT set_config('statement_timeout', '0', true);
     DO $$BEGIN SET LOCAL statement_timeout = 0; PERFORM set_config('rasta.x', '1', true); END$$;`,
  ]);
  assert.deepEqual(unmodelled, []);
});

// FU-266 (#1010 r2): a routine may pin its own path to the catalogue, temporary relations last.
const PIN = `SET search_path = pg_catalog, pg_temp`;
test('FU-266: a routine pinning search_path to pg_catalog, pg_temp replays', () => {
  const { unmodelled } = replayMigrations([
    BASE,
    `CREATE FUNCTION g() RETURNS trigger LANGUAGE plpgsql ${PIN} AS $$BEGIN RETURN NEW; END$$;
     CREATE OR REPLACE FUNCTION h() RETURNS trigger LANGUAGE plpgsql SET search_path TO pg_catalog, pg_temp
       AS $$BEGIN RETURN NEW; END$$;`,
  ]);
  assert.deepEqual(unmodelled, []);
});
for (const [name, sql] of [
  ['the pin as a session SET', `${PIN};`],
  ['the pin on a database', `ALTER DATABASE d ${PIN};`],
  ['the pin on a role', `ALTER ROLE r ${PIN};`],
  ['the pin by ALTER FUNCTION', `ALTER FUNCTION g() ${PIN};`],
  ['a third schema', `CREATE FUNCTION g() RETURNS void LANGUAGE sql ${PIN}, s AS 'SELECT 1';`],
  [
    'temporary first',
    `CREATE FUNCTION g() RETURNS void LANGUAGE sql SET search_path = pg_temp, pg_catalog AS 'SELECT 1';`,
  ],
  [
    'a quoted name',
    `CREATE FUNCTION g() RETURNS void LANGUAGE sql SET search_path = "PG_CATALOG", pg_temp AS 'SELECT 1';`,
  ],
  [
    'the catalogue alone',
    `CREATE FUNCTION g() RETURNS void LANGUAGE sql SET search_path = pg_catalog AS 'SELECT 1';`,
  ],
]) {
  test(`FU-266: a path that is not the pin is refused: ${name}`, () => {
    assert.notEqual(replayMigrations([BASE, sql]).unmodelled.length, 0, sql);
  });
}

test('F4: a DEFAULT is read to its end, past CASE … NULL … END and IS [NOT] NULL', () => {
  const at = (definition) => replaying(`CREATE TABLE t (${definition});`).tables.get('t').get('at');
  assert.deepEqual(
    at(`at timestamp(3) DEFAULT CASE WHEN true IS NULL THEN NULL ELSE my_clock() END`),
    { type: 'ts', sessionDefault: true },
  );
  assert.equal(
    at(`at timestamp(3) DEFAULT CASE WHEN x IS NOT NULL THEN NULL ELSE now() END NOT NULL`)
      .sessionDefault,
    true,
  );
  assert.equal(at(`at timestamp(3) DEFAULT NULL NOT NULL`).sessionDefault, false);
  const flags = `CREATE TABLE f (a boolean DEFAULT 1 IS NOT NULL AND true, b boolean DEFAULT 2 IS NULL OR false);`;
  assert.deepEqual(replaying(flags).unmodelled, []);
  const added = replayMigrations([
    BASE,
    `ALTER TABLE task ADD COLUMN at timestamp(3) DEFAULT CASE WHEN true IS NULL THEN NULL ELSE my_clock() END;`,
  ]);
  assert.equal(added.tables.get('task').get('at').sessionDefault, true);
});

test('F4: the clauses main uses are read', () => {
  const { tables: t, unmodelled } = replayMigrations([
    `CREATE TABLE s (id text PRIMARY KEY);
     CREATE TABLE t (
       "at" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC') CONSTRAINT c CHECK (at IS NOT NULL),
       v BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
       w BIGINT GENERATED BY DEFAULT AS IDENTITY (START 1) UNIQUE,
       s_id TEXT NULL REFERENCES s(id) ON DELETE SET NULL ON UPDATE CASCADE,
       due TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP REFERENCES s (id) ON DELETE NO ACTION
     );`,
  ]);
  assert.deepEqual(unmodelled, []);
  assert.deepEqual(t.get('t').get('at'), { type: 'ts', sessionDefault: false });
  assert.deepEqual(t.get('t').get('due'), { type: 'ts', sessionDefault: true });
});

// PR #979 r2: each probe the reviewer ran, then the siblings of its class.
const R2 = replayMigrations([
  `CREATE TABLE task (id text, lease_until timestamp(3), due_at timestamp(3) DEFAULT CURRENT_TIMESTAMP);
   CREATE TABLE "Task2" (id text, lease_until timestamp(3));
   CREATE TABLE aware (id text, seen_at timestamptz(3));`,
]).tables;
const r2Scope = new Map([...R2].map(([table, columns]) => [table, [columns]]));
for (const [name, sql] of [
  // r2 F1.1: SQL that does not start at the string's first token.
  [
    'F1 BEGIN; INSERT',
    `SELECT dblink_exec('c', 'BEGIN; INSERT INTO task (id) VALUES (1); COMMIT')`,
  ],
  [
    'F1 BEGIN; UPDATE … DEFAULT',
    `SELECT dblink_exec('c', 'BEGIN; UPDATE task SET lease_until = DEFAULT; COMMIT')`,
  ],
  ['F1 after a semicolon', `SELECT dblink_exec('c', ';INSERT INTO task (id) VALUES (1)')`],
  ['F1 concatenated', `SELECT dblink_exec('c', 'INS' || 'ERT INTO task (id) VALUES (1)')`],
  ['F1 START TRANSACTION', `SELECT dblink_exec('c', 'START TRANSACTION; DELETE FROM task')`],
  ['F1 EXPLAIN ANALYZE', `SELECT dblink_exec('c', 'EXPLAIN ANALYZE UPDATE task SET id = id')`],
  // r2 F1.3: the forms the prefilter dropped, read by problemsIn too.
  ['F1 SET ROLE', `SET ROLE shadow_owner`],
  ['F1 SET SCHEMA', `SET SCHEMA 'shadow'`],
  ['F1 SET SESSION AUTHORIZATION', `SET SESSION AUTHORIZATION shadow`],
  ['F1 SET LOCAL SESSION AUTHORIZATION', `SET LOCAL SESSION AUTHORIZATION shadow`],
  ['F1 RESET ALL', `RESET ALL`],
  ['F1 RESET ROLE', `RESET ROLE`],
  ['F1 a spliced setting', `SET LOCAL \uE0000\uE001 = 'x'`],
  ['F1 a setting FROM CURRENT', `SET search_path FROM CURRENT`],
  // r2 F2: a table named outside FROM, qualified, quoted or in another schema.
  [
    'F2 NULL::public.task',
    `SELECT 1 FROM aware WHERE (jsonb_populate_record(NULL::public.task, $1)).lease_until < now()`,
  ],
  [
    'F2 NULL::"Task2"',
    `SELECT 1 FROM aware WHERE (jsonb_populate_record(NULL::"Task2", $1)).lease_until < now()`,
  ],
  [
    'F2 NULL::pg_temp.task',
    `SELECT 1 FROM aware WHERE (jsonb_populate_record(NULL::pg_temp.task, $1)).lease_until < now()`,
  ],
  [
    'F2 NULL::"public".task',
    `SELECT 1 FROM aware WHERE (jsonb_populate_record(NULL::"public".task, $1)).lease_until < now()`,
  ],
  [
    'F2 CAST AS a type of another schema',
    `SELECT 1 FROM aware WHERE (jsonb_populate_record(CAST(NULL AS shadow.row_of), $1)).lease_until < now()`,
  ],
  [
    'F2 a type of another schema',
    `SELECT 1 FROM aware WHERE (jsonb_populate_record(NULL::shadow.row_of, $1)).lease_until < now()`,
  ],
]) {
  test(`unreadable is refused (PR #979 r2): ${name}`, () => {
    assert.notEqual(problemsIn(sql, r2Scope).length, 0, sql);
  });
}

for (const [name, sql] of [
  ['prose that starts with Set', `Set to 1 for each audit producer configured as traffic-expected`],
  ['prose that starts with reset', `reset the development database or move it through the API`],
  ['a word alone', `set`],
  ['prose after a semicolon', `unset; set it with DATABASE_STATEMENT_TIMEOUT_MS instead`],
  ['SET TRANSACTION', `SET TRANSACTION READ ONLY`],
  ['SET SESSION CHARACTERISTICS', `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`],
  ['RESET of a listed setting', `RESET statement_timeout`],
  [
    'a table of public in a cast, beside its timestamptz column',
    `SELECT 1 FROM aware WHERE (jsonb_populate_record(NULL::public.aware, $1)).seen_at < now()`,
  ],
  ['a pg_catalog type', `SELECT now()::pg_catalog.timestamptz FROM aware`],
  [
    'a non-ASCII string or quoted name',
    `SELECT 1 FROM aware WHERE id = 'tâche' AND seen_at < now()`,
  ],
]) {
  test(`readable is read (PR #979 r2): ${name}`, () => {
    assert.deepEqual(problemsIn(sql, r2Scope), []);
  });
}

const BASE_R2 = `CREATE TABLE task (id text, at timestamp(3) DEFAULT now(), lease_until timestamp(3));
  CREATE FUNCTION f() RETURNS int LANGUAGE sql AS 'SELECT 1';
  CREATE VIEW v AS SELECT 1;`;
for (const [name, sql] of [
  // r2 F1.1, F1.2: a scheduled job, at any position of its string or one level down in a DO body.
  [
    'F1 a job after BEGIN',
    `SELECT cron.schedule('j', '* * * * *', 'BEGIN; INSERT INTO task (id) VALUES (1); END');`,
  ],
  // r2 F4: a name the `\w+` patterns would cut.
  ['F4 DROP COLUMN at$x', `ALTER TABLE task DROP COLUMN at$x;`],
  ['F4 DROP COLUMN até', `ALTER TABLE task DROP COLUMN até;`],
  ['F4 RENAME TO held$until', `ALTER TABLE task RENAME COLUMN lease_until TO held$until;`],
  ['F4 RENAME TO U&"held"', `ALTER TABLE task RENAME COLUMN lease_until TO U&"held";`],
  ['F4 DROP FUNCTION f$x()', `DROP FUNCTION f$x();`],
  ['F4 DROP VIEW v$x', `DROP VIEW v$x;`],
  // The class: every other pattern reads names the same way.
  ['F4 a U& ADD COLUMN', String.raw`ALTER TABLE task ADD COLUMN U&"held\005Fat" timestamp(3);`],
  [
    'F4 a trigger on task$x',
    `CREATE TRIGGER t BEFORE INSERT ON task$x FOR EACH ROW EXECUTE FUNCTION f();`,
  ],
  ['F4 SET TYPE of até', `ALTER TABLE task ALTER COLUMN até TYPE timestamptz(3);`],
  ['F4 DROP TABLE task$x', `DROP TABLE task$x;`],
  ['F4 RENAME TABLE to a non-ASCII name', `ALTER TABLE task RENAME TO tâche;`],
  ['F4 a no-break space in a name', `ALTER TABLE task DROP COLUMN IF EXISTS at\u00A0x;`],
]) {
  test(`a migration the replay cannot read is refused (PR #979 r2): ${name}`, () => {
    const replay = replayMigrations([BASE_R2, sql]);
    assert.notEqual(replay.unmodelled.length, 0, sql);
    assert.ok(replay.tables.get('task').has('at'), 'the at column is still modelled');
  });
}

test('r2 F4: a non-ASCII character in a string is read, and is no name', () => {
  const { unmodelled } = replayMigrations([
    BASE_R2,
    `COMMENT ON TABLE task IS 'tâche — l''état'; COMMENT ON COLUMN task.at IS $$à\u00A0b$$;`,
  ]);
  assert.deepEqual(unmodelled, []);
});

test('r2 F1.2: SQL in a string of a DO block goes to review', () => {
  for (const sql of [
    `DO $d$ BEGIN PERFORM cron.schedule('j', '* * * * *', 'UPDATE task SET lease_until = now()'); END $d$;`,
    `DO $d$ BEGIN PERFORM cron.schedule('j', '* * * * *', $q$INSERT INTO task (id) VALUES (1)$q$); END $d$;`,
    `DO $d$ BEGIN PERFORM dblink_exec('c', 'BEGIN; INSERT INTO task (id) VALUES (1); COMMIT'); END $d$;`,
  ]) {
    const { doBlocks, unmodelled } = replayMigrations([BASE_R2, sql]);
    assert.deepEqual([doBlocks.length, unmodelled], [1, []], sql);
  }
  // A message is prose, and no DO block to review.
  assert.equal(
    replayMigrations([BASE_R2, `DO $$BEGIN RAISE NOTICE 'the job ran'; END$$;`]).doBlocks.length,
    0,
  );
});

test('r2 F1.3: the scan reads every literal, a SET ROLE with no clock word included', () => {
  const migration = `CREATE TABLE task (id text, at timestamp(3));`;
  for (const sql of [
    `SET ROLE shadow_owner`,
    `SET SCHEMA 'shadow'`,
    `SET SESSION AUTHORIZATION shadow`,
    `RESET ALL`,
  ]) {
    const source = `export const sql = \`${sql}\`;`;
    assert.match(
      scanOf('x-service', migration, source).join(),
      /R0 what the guard cannot read/,
      sql,
    );
  }
  const concatenated =
    "export const sql = `SELECT dblink_exec('c', 'INS' || 'ERT INTO task (id) VALUES (1)')`;";
  assert.match(scanOf('x-service', migration, concatenated).join(), /R0/);
  assert.deepEqual(
    scanOf('x-service', migration, "export const help = 'Set to 1 for each producer';"),
    [],
  );
});

// FU-274: accepted on main d3aa0748d (probes recorded in task 1305's evidence).
const R3_BASE = `CREATE TABLE task (id text, lease_until timestamp(3));
  CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $$UPDATE task SET lease_until = now()$$;
  CREATE VIEW v AS SELECT lease_until < now() FROM task;`;
const migrationRefused = (sql) => {
  const r = replayMigrations([R3_BASE, sql]);
  assert.ok(r.unmodelled.length + r.doBlocks.length > 0, sql);
  return r;
};
for (const expression of [
  `U&'UPDATE task SET lease_until = now()' UESCAPE '!'`,
  `U&'opaque value' UESCAPE '!'`,
]) {
  for (const sql of [
    `SELECT ${expression};`,
    `SELECT cron.schedule('j', '* * * * *', ${expression});`,
    `DO $d$ BEGIN PERFORM ${expression}; END $d$;`,
    `DO $d$ BEGIN PERFORM cron.schedule('j', '* * * * *', ${expression}); END $d$;`,
  ])
    test(`FU-274 undecodable string: ${sql}`, () => migrationRefused(sql));
}
for (const sql of [
  `DROP FUNCTION f.x();`,
  `DROP FUNCTION IF EXISTS f.x;`,
  `DROP ROUTINE f.x(int);`,
  `DROP FUNCTION "f".x();`,
  `DROP VIEW v.x;`,
  `DROP MATERIALIZED VIEW IF EXISTS v.x;`,
  `CREATE OR REPLACE VIEW v.x AS SELECT 1;`,
  `CREATE TABLE p PARTITION OF task.x FOR VALUES IN (1);`,
  `DROP FUNCTION public.f.x();`,
  `DROP VIEW public.v.x;`,
  `CREATE VIEW public.v.x AS SELECT 1;`,
]) {
  test(`FU-274 qualified name is never cut: ${sql}`, () => {
    const r = migrationRefused(sql);
    assert.equal(r.functions.size, 1, 'public f remains live');
    assert.match(r.views.get('v').body, /now\(\)/, 'public v retains its clock body');
    assert.equal(r.tables.has('p'), false);
  });
}
for (const sql of [
  `DROP FUNCTION public.f();`,
  `DROP VIEW "public"."v";`,
  `CREATE OR REPLACE VIEW public.v AS SELECT 1;`,
  `CREATE TABLE p PARTITION OF public.task FOR VALUES IN (1);`,
])
  test(`FU-274 readable qualified name: ${sql}`, () => {
    assert.deepEqual(replayMigrations([R3_BASE, sql]).unmodelled, []);
  });
for (const expression of [
  `'INSERT' || chr(32) || 'INTO task (id) VALUES (1)'`,
  `concat_ws(' ', 'INSERT', 'INTO task (id) VALUES (1)')`,
  `format('%s INTO task (id) VALUES (1)', 'INSERT')`,
  `'IN' || chr(83) || 'ERT INTO task (id) VALUES (1)'`,
  `replace('XNSERT INTO task (id) VALUES (1)', 'X', 'I')`,
  `opaque_builder('pieces', $1)`,
]) {
  for (const call of [
    'dblink_exec',
    'unknown_executor',
    'shadow.format',
    '"select"',
    'shadow.select',
    'rasta.pg_catalog.format',
  ]) {
    const sql = `SELECT ${call}('c', ${expression});`;
    test(`FU-274 opaque SQL input: ${sql}`, () => {
      assert.match(problemsIn(sql, r2Scope).join(), /R0/);
      migrationRefused(sql);
      migrationRefused(`DO $$BEGIN PERFORM ${call}('c', ${expression}); END$$;`);
      migrationRefused(`DO $$<<job>> BEGIN PERFORM ${call}('c', ${expression}); END job$$;`);
      assert.match(definitionProblems({ body: sql, header: '' }, r2Scope).join(), /R0/);
    });
  }
}
for (const sql of [
  `DISCARD ALL;`,
  `DISCARD PLANS;`,
  `DISCARD TEMP;`,
  `DISCARD SEQUENCES;`,
  `UPDATE pg_settings SET setting = 'shadow' WHERE name = 'search_path';`,
  `WITH x AS (SELECT 1) UPDATE ONLY (pg_catalog.pg_settings) SET setting = $1;`,
  `UPDATE "pg_catalog"."pg_settings" SET setting = $1;`,
  `INSERT INTO pg_catalog.pg_settings (name, setting) VALUES ($1, $2);`,
  `DELETE FROM ONLY pg_settings WHERE name = $1;`,
  `MERGE INTO pg_settings USING task ON true WHEN MATCHED THEN UPDATE SET setting = $1;`,
])
  test(`FU-274 session change: ${sql}`, () => {
    assert.match(problemsIn(sql, r2Scope).join(), /R0/);
    migrationRefused(sql);
    migrationRefused(`DO $$BEGIN ${sql} END$$;`);
  });
for (const sql of [
  `CREATE EXTENSION dblink;`,
  `CREATE EXTENSION IF NOT EXISTS pg_cron;`,
  `CREATE EXTENSION unreviewed_executor;`,
  `CREATE EXTENSION pg_trgm WITH SCHEMA shadow;`,
])
  test(`FU-274 executor boundary: ${sql}`, () => {
    migrationRefused(sql);
    assert.match(problemsIn(sql, r2Scope).join(), /R0/);
  });
for (const sql of [`CREATE EXTENSION IF NOT EXISTS btree_gist;`, `CREATE EXTENSION pg_trgm;`])
  test(`FU-274 non-executing extension: ${sql}`, () => {
    assert.deepEqual(replayMigrations([sql]).unmodelled, []);
    assert.deepEqual(problemsIn(sql, r2Scope), []);
  });
for (const setting of [`role = 'shadow'`, `"role" = 'shadow'`, `unknown_setting = 'shadow'`]) {
  test(`FU-274 routine header session change: ${setting}`, () => {
    migrationRefused(`CREATE FUNCTION g() RETURNS int LANGUAGE sql SET ${setting} AS 'SELECT 1';`);
    migrationRefused(`CREATE FUNCTION g() RETURNS int AS 'SELECT 1' LANGUAGE sql SET ${setting};`);
  });
}
for (const modifier of ['TEMP', 'TEMPORARY', 'GLOBAL TEMPORARY', 'LOCAL TEMP']) {
  test(`FU-274 production table shadow: ${modifier}`, () => {
    assert.match(problemsIn(`CREATE ${modifier} TABLE task (id text);`, r2Scope).join(), /R0/);
  });
}
for (const expression of [
  `'INSERT' || chr(32) || 'INTO task (id) VALUES (1)'`,
  `concat_ws(' ', 'INSERT', 'INTO task (id) VALUES (1)')`,
  `format('%s INTO task (id) VALUES (1)', 'INSERT')`,
])
  test(`FU-274 labeled body: ${expression}`, () => {
    migrationRefused(`DO $$<<job>> BEGIN PERFORM dblink_exec('c', ${expression}); END job$$;`);
  });

test('FU-274 value calls and prose remain readable', () => {
  for (const sql of [
    `SELECT pg_catalog.format('%s', concat_ws(' ', 'one', 'two'));`,
    `SELECT replace('opaque data', 'a', 'b');`,
    `Discard version changes before retrying`,
  ])
    assert.deepEqual(problemsIn(sql, r2Scope), [], sql);
  assert.deepEqual(
    replayMigrations([
      `CREATE FUNCTION g() RETURNS int LANGUAGE sql SET statement_timeout = '1s' AS 'SELECT 1';`,
    ]).unmodelled,
    [],
  );
});
test('FU-274 scan reaches opaque input without clock words', () => {
  assert.match(
    scanOf(
      'x-service',
      R3_BASE,
      `export const sql = "SELECT unknown_executor('pieces', $1)";`,
    ).join(),
    /R0/,
  );
});

// r1: the executor may consume text through data flow, outside its argument parentheses.
const R1_FRAGMENTS = `'SEL' || chr(69) || 'CT 1 FROM task WHERE lease_until < n' || chr(111) || 'w()'`;
for (const [probe, sql] of [
  ['VALUES', `SELECT query_to_xml(q.s, true, false, NULL) FROM (VALUES (${R1_FRAGMENTS})) q(s)`],
  ['subquery', `SELECT query_to_xml(q.s, true, false, NULL) FROM (SELECT ${R1_FRAGMENTS} AS s) q`],
  ['CTE', `WITH q(s) AS (SELECT ${R1_FRAGMENTS}) SELECT query_to_xml(s, true, false, NULL) FROM q`],
  ['LATERAL', `SELECT * FROM (VALUES (${R1_FRAGMENTS})) q(s), LATERAL ts_stat(q.s)`],
  ['parameter', `SELECT query_to_xml($1, true, false, NULL)`],
  ['direct control', `SELECT query_to_xml(${R1_FRAGMENTS}, true, false, NULL)`],
]) {
  test(`FU-274 r1 executor data flow: ${probe}`, () => {
    assert.match(problemsIn(sql, r2Scope).join(), /R0/);
    assert.match(definitionProblems({ body: sql, header: '' }, r2Scope).join(), /R0/);
    migrationRefused(`${sql};`);
    migrationRefused(`DO $outer$<<job>> BEGIN PERFORM (${sql}); END job$outer$;`);
  });
}
for (const call of [
  'query_to_xml',
  'query_to_xmlschema',
  'query_to_xml_and_xmlschema',
  'ts_stat',
  'ts_rewrite',
  'dblink_exec',
  'dblink_send_query',
  'cron.schedule',
  'cron.schedule_in_database',
  'pg_background_launch',
  'pg_catalog."query_to_xml"',
  '"pg_catalog".ts_stat',
  '"cron"."schedule"',
]) {
  test(`FU-274 r1 executor without literal input: ${call}`, () => {
    const body = `<<job>> DECLARE q text; BEGIN q := ${R1_FRAGMENTS}; PERFORM ${call}(q); END job`;
    assert.match(problemsIn(`SELECT ${call}($1)`, r2Scope).join(), /R0/);
    assert.match(definitionProblems({ body, header: '' }, r2Scope).join(), /R0/);
    migrationRefused(`DO $outer$${body}$outer$;`);
    migrationRefused(`DO $outer$<<job>> BEGIN PERFORM ${call}(q); END job$outer$;`);
  });
}
test('FU-274 r1 executor in a headless string uses the same reader', () => {
  const sql = `SELECT $b$ts_stat($1)$b$`;
  assert.match(problemsIn(sql, r2Scope).join(), /R0/);
  migrationRefused(`${sql};`);
  migrationRefused(`DO $outer$BEGIN PERFORM $b$ts_stat($1)$b$; END$outer$;`);
});

// Each review body reaches the shared reader through production strings, one-shot migrations,
// and DO-body strings. Routine DDL refusal alone must not mask a broken string reader.
for (const [probe, kind, body] of [
  [
    'labeled EXECUTE',
    'FUNCTION f() RETURNS void',
    `<<l>> BEGIN EXECUTE 'UPDATE task SET lease_until = n' || 'ow()'; END`,
  ],
  [
    'labeled INSERT',
    'FUNCTION f() RETURNS void',
    `<<l>> BEGIN INSERT INTO task (id) VALUES (1); END`,
  ],
  [
    'procedure',
    'PROCEDURE p()',
    `<<l>> BEGIN EXECUTE 'UPDATE task SET lease_until = n' || 'ow()'; END`,
  ],
  [
    'DECLARE then label',
    'FUNCTION f() RETURNS void',
    `DECLARE x int := 1; <<l>> BEGIN EXECUTE 'UPDATE task SET lease_until = n' || 'ow()'; END`,
  ],
  [
    'empty DECLARE',
    'FUNCTION f() RETURNS void',
    `DECLARE BEGIN INSERT INTO task (id) VALUES (1); END`,
  ],
  [
    'RETURN QUERY EXECUTE',
    'FUNCTION f() RETURNS SETOF task',
    `<<l>> BEGIN RETURN QUERY EXECUTE 'SEL' || chr(69) || 'CT * FROM task'; END`,
  ],
  ['BEGIN control', 'FUNCTION f() RETURNS void', `BEGIN INSERT INTO task (id) VALUES (1); END`],
  [
    'format EXECUTE',
    'PROCEDURE p()',
    `<<l>> DECLARE q text; BEGIN q := format('%s', 'pieces'); EXECUTE q; END`,
  ],
]) {
  test(`FU-274 r1 body reader: ${probe}`, () => {
    assert.match(
      problemsIn(`CREATE ${kind} LANGUAGE plpgsql AS $b$${body}$b$`, r2Scope).join(),
      /R0/,
    );
    assert.match(problemsIn(`SELECT $b$${body}$b$`, r2Scope).join(), /R0/);
    migrationRefused(`SELECT $b$${body}$b$;`);
    migrationRefused(`DO $outer$<<job>> BEGIN PERFORM $b$${body}$b$; END job$outer$;`);
    assert.ok(definitionProblems({ body, header: '' }, r2Scope).length > 0);
  });
}
for (const prefix of ['<<l>>', 'DECLARE', 'BEGIN', 'THEN', 'ELSE', 'LOOP', 'RETURN QUERY']) {
  test(`FU-274 r1 statement start: ${prefix}`, () => {
    assert.match(problemsIn(`${prefix} EXECUTE $1`, r2Scope).join(), /R0/);
    assert.match(
      problemsIn(`SELECT $b$${prefix} INSERT INTO task (id) VALUES (1)$b$`, r2Scope).join(),
      /R0/,
    );
  });
}
for (const kind of [
  'FUNCTION f() RETURNS void',
  'OR REPLACE FUNCTION f() RETURNS void',
  'PROCEDURE p()',
]) {
  test(`FU-274 r1 production routine DDL: ${kind}`, () => {
    // No string or clock: routine creation is refused independently of body recognition.
    assert.match(problemsIn(`CREATE ${kind} LANGUAGE plpgsql AS $1`, r2Scope).join(), /R0/);
  });
}
test('FU-274 r1 source scan reaches both readers without clock words', () => {
  for (const sql of [
    `SELECT query_to_xml($1, true, false, NULL)`,
    `CREATE PROCEDURE p() LANGUAGE plpgsql AS $$<<l>> BEGIN INSERT INTO task (id) VALUES (1); END$$`,
    `SELECT $$<<l>> BEGIN INSERT INTO task (id) VALUES (1); END$$`,
  ])
    assert.match(
      scanOf('x-service', R3_BASE, `export const sql = ${JSON.stringify(sql)};`).join(),
      /R0/,
    );
});

// r2: every DDL expression crosses the same executor boundary before replay dispatch.
// Even slots PostgreSQL restricts to immutable expressions must refuse, without type inference.
const R2_SQL_TEXT = `$q$SELECT 1 FROM task WHERE lease_until < now()$q$`;
const R2_DDL_SLOTS = [
  ['policy USING', (e) => `CREATE POLICY p ON task USING (${e})`],
  ['policy WITH CHECK', (e) => `CREATE POLICY p ON task FOR INSERT WITH CHECK (${e})`],
  ['ALTER policy USING', (e) => `ALTER POLICY p ON task USING (${e})`],
  ['ALTER policy WITH CHECK', (e) => `ALTER POLICY p ON task WITH CHECK (${e})`],
  ['column CHECK', (e) => `CREATE TABLE t2 (id text CHECK (${e}))`],
  ['table CHECK', (e) => `CREATE TABLE t3 (id text, CONSTRAINT c CHECK (${e}))`],
  ['ADD CONSTRAINT CHECK', (e) => `ALTER TABLE task ADD CONSTRAINT c CHECK (${e})`],
  ['ADD COLUMN CHECK', (e) => `ALTER TABLE task ADD COLUMN x text CHECK (${e})`],
  [
    'trigger WHEN',
    (e) => `CREATE TRIGGER tr BEFORE UPDATE ON task FOR EACH ROW WHEN (${e}) EXECUTE FUNCTION f()`,
  ],
  ['TYPE USING', (e) => `ALTER TABLE task ALTER COLUMN id TYPE text USING ((${e})::text)`],
  [
    'SET DATA TYPE USING',
    (e) => `ALTER TABLE task ALTER id SET DATA TYPE text USING ((${e})::text)`,
  ],
  ['column DEFAULT', (e) => `CREATE TABLE t4 (x boolean DEFAULT (${e}))`],
  ['SET DEFAULT', (e) => `ALTER TABLE task ALTER COLUMN id SET DEFAULT ((${e})::text)`],
  ['ADD COLUMN DEFAULT', (e) => `ALTER TABLE task ADD COLUMN x boolean DEFAULT (${e})`],
  ['GENERATED AS', (e) => `CREATE TABLE t5 (x boolean GENERATED ALWAYS AS (${e}) STORED)`],
  [
    'ADD GENERATED',
    (e) => `ALTER TABLE task ADD COLUMN x boolean GENERATED ALWAYS AS (${e}) STORED`,
  ],
  ['index expression', (e) => `CREATE INDEX i ON task ((${e}))`],
  ['index WHERE', (e) => `CREATE UNIQUE INDEX i ON task (id) WHERE (${e})`],
  ['domain CHECK', (e) => `CREATE DOMAIN d AS text CHECK (${e})`],
  ['ALTER domain CHECK', (e) => `ALTER DOMAIN d ADD CONSTRAINT c CHECK (${e})`],
  ['view expression', (e) => `CREATE VIEW v2 AS SELECT (${e}) AS x`],
  [
    'SQL routine expression',
    (e) => `CREATE FUNCTION g() RETURNS boolean LANGUAGE sql RETURN (${e})`,
  ],
  [
    'partition bound',
    (e) => `CREATE TABLE child PARTITION OF parent FOR VALUES IN (((${e})::text))`,
  ],
];
const R2_DDL_BASE = `${R3_BASE}; CREATE TABLE parent (id text) PARTITION BY LIST (id);`;
for (const [slot, ddl] of R2_DDL_SLOTS) {
  for (const [input, expression] of [
    ['plain SQL', `query_to_xml(${R2_SQL_TEXT}, true, false, '') IS NOT NULL`],
    ['fragment SQL', `query_to_xml(${R1_FRAGMENTS}, true, false, '') IS NOT NULL`],
    ['ts_stat subquery', `EXISTS (SELECT 1 FROM ts_stat(${R2_SQL_TEXT}))`],
  ]) {
    test(`FU-274 r2 DDL executor: ${slot} / ${input}`, () => {
      const r = replayMigrations([R2_DDL_BASE, `${ddl(expression)};`]);
      assert.equal(r.unmodelled.length, 1);
      assert.match(r.unmodelled[0], /SQL-text executor in a migration statement/);
      assert.equal(r.doBlocks.length, 0, 'refused directly, never exempted as a DO body');
    });
  }
}
for (const call of [
  'query_to_xmlschema',
  'query_to_xml_and_xmlschema',
  'ts_rewrite',
  'dblink',
  'dblink_exec',
  'dblink_send_query',
  'pg_background_launch',
  'cron.schedule',
  'cron.schedule_in_database',
  'pg_catalog."query_to_xml"',
  '"pg_catalog".ts_stat',
  '"cron"."schedule"',
]) {
  test(`FU-274 r2 DDL executor spelling: ${call}`, () => {
    // No SQL/clock in the argument: recognition must not depend on reading its value.
    const sql = `CREATE POLICY p ON task USING (${call}(id) IS NOT NULL);`;
    assert.match(
      replayMigrations([R2_DDL_BASE, sql]).unmodelled.join(),
      /SQL-text executor in a migration statement/,
    );
  });
}
test('FU-274 r2 ordinary DDL expressions and executor names as data remain readable', () => {
  const r = replayMigrations([
    R2_DDL_BASE,
    `CREATE POLICY p ON task USING (length(id) > 0) WITH CHECK (id <> 'query_to_xml($1)');
     ALTER POLICY p ON task USING (id <> 'ts_stat($1)');
     CREATE TABLE t2 (id text DEFAULT 'dblink_exec($1)' CHECK (length(id) > 0));
     ALTER TABLE task ADD CONSTRAINT c CHECK (id <> 'cron.schedule($1)');
     ALTER TABLE task ALTER COLUMN id TYPE text USING lower(id);
     CREATE TRIGGER tr BEFORE UPDATE ON task FOR EACH ROW WHEN (NEW.id <> 'pg_background_launch($1)')
       EXECUTE FUNCTION f();
     CREATE INDEX i ON task ((lower(id))) WHERE length(id) > 0;
     COMMENT ON TABLE task IS 'query_to_xml($1)';`,
  ]);
  assert.deepEqual(r.unmodelled, []);
  assert.deepEqual(r.doBlocks, []);
  assert.deepEqual(r.triggers.get('f'), ['task']);
});

test('the repository passes', () => {
  assert.deepEqual(utcClockProblems(REPOSITORY), []);
});

// FU-283: creation must fail before a later literal can resolve its shadow as a replayed table.
const FU283_BASE = `CREATE TABLE task (id text, recorded_at timestamptz(3));`;
const FU283_SCOPE = new Map(
  [...replayMigrations([FU283_BASE]).tables].map(([name, columns]) => [name, [columns]]),
);
const FU283_REVIEW_PROBES = [
  `SELECT 1 AS update INTO TEMP task`,
  `SELECT id AS delete INTO TEMPORARY TABLE task FROM other`,
  `SELECT update INTO TEMP task FROM other`,
  `SELECT update.id INTO TEMP task FROM other update`,
  `SELECT 1 AS delete INTO pg_temp.task`,
  `SELECT 1 AS update INTO task2`,
  `SELECT 1 AS insert INTO TEMP task`,
  `SELECT 1 AS merge INTO TEMP task`,
  `SELECT 1 AS x INTO TEMP task`,
  `SELECT 1 update INTO task2`,
  `SELECT 1 AS insert INTO task2`,
  `SELECT 1 AS merge INTO pg_temp.task`,
  `SELECT id FROM other update INTO TEMP task`,
  `SELECT insert.id INTO task2 FROM other insert`,
  `SELECT merge.id INTO task2 FROM other merge`,
  `SELECT begin insert INTO task2 FROM other`,
  `SELECT loop merge INTO pg_temp.task FROM other`,
];
const FU283_CREATIONS = [
  `CREATE TEMP VIEW fact AS SELECT 1 AS id`,
  `CREATE TEMPORARY SEQUENCE fact`,
  `CREATE GLOBAL TEMPORARY TABLE fact (id text)`,
  `CREATE LOCAL TEMP TABLE fact (id text)`,
  `CREATE OR REPLACE TEMPORARY VIEW fact AS SELECT 1 AS id`,
  `CREATE TEMP MATERIALIZED VIEW fact AS SELECT 1 AS id`,
  `CREATE TEMP unknown_object fact`,
  `CrEaTe /* modifier */ TeMpOrArY /* object */ ViEw fact AS SELECT 1 AS id`,
  `CREATE TABLE pg_temp.fact (recorded_at timestamp(3))`,
  `CREATE VIEW "PG_TEMP"."Fact" AS SELECT 1 AS id`,
  `CREATE SEQUENCE "Pg_TeMp_42".fact`,
  `CREATE MATERIALIZED VIEW PG_TEMP_123.fact AS SELECT 1 AS id`,
  `CREATE TYPE pg_temp.fact AS ENUM ('one')`,
  `CREATE TABLE pg_temp /* schema */ . "Fact" AS SELECT 1 AS id`,
  `CREATE TABLE U&"pg_\\0074emp".fact (id text)`,
  `CREATE TEMP TABLE fact AS SELECT 1 AS id`,
  `CREATE TABLE $1.fact (id text)`,
  `CREATE TABLE fact (id text, LIKE pg_temp.other)`,
  `SELECT 1 AS id INTO TEMP fact`,
  `SELECT 1 AS id INTO TEMPORARY TABLE fact`,
  `SELECT 1 AS id INTO UNLOGGED fact`,
  `SELECT 1 AS id INTO TABLE fact`,
  `SELECT 1 AS id INTO fact`,
  `SELECT 1 AS id INTO pg_temp.fact`,
  `SELECT 1 AS id INTO "PG_TEMP_42" . "Fact"`,
  `WITH x AS (SELECT 1 AS id) SELECT id INTO /* target */ tEmP fact FROM x`,
  `SELECT (SELECT 1) AS id INTO TEMP fact`,
  `SELECT x.update INTO TEMP fact FROM task x`,
  `SELECT * INTO TEMP fact FROM task`,
  `SELECT 1 INTO $1`,
  ...FU283_REVIEW_PROBES.flatMap((sql) => [sql, `EXPLAIN ANALYZE ${sql}`]),
  `IMPORT FOREIGN SCHEMA s FROM SERVER srv INTO pg_temp`,
  `IMPORT FOREIGN SCHEMA s FROM SERVER srv INTO public`,
  `COPY task INTO $1`, // Unknown INTO in SQL: refuse, never infer safety.
  `SELECT (SELECT 1 AS insert) INTO task2`,
  `WITH x AS (SELECT 1 AS update) SELECT 1 AS merge INTO task2`,
];
for (const sql of FU283_CREATIONS) {
  test(`FU-283 creation boundary: ${sql}`, () => {
    assert.match(problemsIn(sql, FU283_SCOPE).join(), /R0/);
    assert.ok(replayMigrations([`${FU283_BASE}; ${sql};`]).unmodelled.length > 0, sql);
    assert.match(
      definitionProblems({ body: sql, header: '', language: 'sql' }, FU283_SCOPE).join(),
      /R0/,
    );
    // Quoted SQL data must still reach the existing string boundary.
    assert.match(problemsIn(`SELECT $quoted$${sql}$quoted$`, FU283_SCOPE).join(), /R0/);
  });
}
for (const sql of [
  `CREATE TEMP VIEW fact AS SELECT 1 AS id`,
  `CREATE SEQUENCE pg_temp.fact`,
  `SELECT 1 INTO TEMP fact`,
  `SELECT 1 INTO TEMPORARY TABLE fact`,
  `SELECT 1 INTO UNLOGGED fact`,
  `SELECT 1 INTO "PG_TEMP_1".fact`,
]) {
  test(`FU-283 PL/pgSQL creation boundary: ${sql}`, () => {
    const body = `<<scope>> DECLARE v int; BEGIN ${sql}; END scope`;
    assert.ok(replayMigrations([`DO $body$${body}$body$;`]).unmodelled.length > 0);
    assert.match(
      definitionProblems({ body, header: '', language: 'plpgsql' }, FU283_SCOPE).join(),
      /R0/,
    );
  });
}
for (const sql of [
  `SET search_path TO pg_temp, public`,
  `SET LOCAL "search_path" = 'pg_temp_42, public'`,
  `sEt /* setting */ SeArCh_PaTh TO "PG_TEMP", public`,
  `SELECT set_config('search_path', 'pg_temp,public', false)`,
  `SELECT "pg_catalog"."set_config"($s$search_path$s$, $p$pg_temp_42,public$p$, true)`,
  `SELECT set_config('search_path', $1, false)`,
  `SET search_path FROM CURRENT`,
]) {
  test(`FU-283 temporary search path: ${sql}`, () => {
    assert.match(problemsIn(sql, FU283_SCOPE).join(), /R0/);
    assert.ok(replayMigrations([`${sql};`]).unmodelled.length > 0);
    assert.ok(replayMigrations([`DO $$BEGIN ${sql}; END$$;`]).unmodelled.length > 0);
    assert.match(definitionProblems({ body: sql, header: '' }, FU283_SCOPE).join(), /R0/);
  });
}
test('FU-283 non-temporary names and data still pass', () => {
  const benign = [
    `CREATE TABLE fact (temp text, temporary text, pg_temp text)`,
    `CREATE TABLE pg_temp_like (id text)`,
    `CREATE TABLE public.fact (id text)`,
    `CREATE VIEW fact AS SELECT 'pg_temp.x' AS temp`,
    `CREATE SEQUENCE temp`,
    `SELECT 'pg_temp.x', $q$pg_temp_42.fact$q$, 'temporary', 'INTO TEMP'`,
    `SELECT temp, temporary, pg_temp FROM task`,
    `INSERT INTO task (id) SELECT 'pg_temp.x'`,
    `WITH x AS (SELECT 1) INSERT INTO task (id) SELECT 'x' FROM x`,
    `SELECT /* CREATE TEMP VIEW pg_temp.fact */ 1`,
  ];
  for (const sql of benign) {
    assert.deepEqual(problemsIn(sql, FU283_SCOPE), [], sql);
    assert.deepEqual(replayMigrations([`${FU283_BASE}; ${sql};`]).unmodelled, [], sql);
  }
  for (const sql of [
    `GRANT CREATE ON SCHEMA $1 TO role`,
    `GRANT USAGE, CREATE ON SCHEMA $1 TO role`,
    `REVOKE CREATE, USAGE ON SCHEMA $1 FROM role`,
    `ALTER DEFAULT PRIVILEGES GRANT CREATE ON SCHEMAS TO role`,
  ]) {
    assert.deepEqual(problemsIn(sql, FU283_SCOPE), [], sql);
    assert.deepEqual(replayMigrations([sql]).unmodelled, [], sql);
    assert.ok(
      definitionProblems({ body: sql, header: '', language: 'sql' }, FU283_SCOPE).every(
        (p) => !p.startsWith('R0'),
      ),
      sql,
    );
  }
  for (const language of ['plpgsql', "'plpgsql'"]) {
    const replay = replayMigrations([
      `CREATE FUNCTION f() RETURNS int LANGUAGE ${language}
      AS $$DECLARE v int; BEGIN SELECT 1 INTO v; RETURN v; END$$;`,
    ]);
    assert.deepEqual(replay.unmodelled, []);
    assert.deepEqual(definitionProblems([...replay.functions.values()][0], FU283_SCOPE), []);
  }
  assert.deepEqual(
    replayMigrations([`DO $$DECLARE v int; BEGIN SELECT 1 INTO v; END$$;`]).unmodelled,
    [],
  );
  // Unspecified/SQL language must not acquire the variable-assignment exception.
  assert.match(
    definitionProblems({ body: 'SELECT 1 INTO fact', header: '' }, FU283_SCOPE).join(),
    /R0/,
  );
});
test('FU-283 r2 only privilege-list CREATE exempts an unresolved target', () => {
  assert.match(
    problemsIn(`\uE0000\uE001 insert INTO task (id) VALUES ('x')`, FU283_SCOPE).join(),
    /R0.*INTO/,
  );
  for (const prefix of [
    '',
    '\uE0000\uE001 ',
    'EXPLAIN ',
    'EXPLAIN ANALYZE ',
    'EXPLAIN (ANALYZE) ',
  ]) {
    for (const tail of ['(x int)', 'AS SELECT 1']) {
      const sql = `${prefix}CREATE TABLE \uE0001\uE001 ${tail}`;
      assert.match(problemsIn(sql, FU283_SCOPE).join(), /R0.*CREATE target/, sql);
      assert.ok(replayMigrations([sql]).unmodelled.length > 0, sql);
      assert.match(
        definitionProblems({ body: sql, header: '', language: 'sql' }, FU283_SCOPE).join(),
        /R0.*CREATE target/,
        sql,
      );
    }
  }
});
test('FU-283 r2 keyword labels without INTO and proven writes keep their classification', () => {
  for (const prose of [
    `signed into its token`,
    `With holdFunds=true the money is moved into escrow`,
    `holds CREATE on schema $1`,
  ])
    assert.deepEqual(problemsIn(prose, FU283_SCOPE), [], prose);
  for (const sql of [
    `SELECT has_sequence_privilege('legacy_runtime_seq', 'UPDATE') AS update`,
    `SELECT 1 AS delete, 2 AS insert, 3 AS merge`,
    `SELECT update, update.id FROM task update`,
    `SELECT 'INTO task', "into" FROM task`,
    `INSERT /* target */ INTO task (id) VALUES ('x')`,
    `WITH x AS (SELECT 1) INSERT INTO task (id) SELECT 'x' FROM x`,
    `WITH RECURSIVE x(id) AS NOT MATERIALIZED (SELECT 1), y AS (SELECT 2)
       INSERT INTO task (id) SELECT 'x' FROM x`,
    `EXPLAIN (ANALYZE) INSERT INTO task (id) VALUES ('x')`,
    `WITH x AS (INSERT INTO task (id) VALUES ('x') RETURNING id) SELECT * FROM x`,
  ]) {
    assert.deepEqual(problemsIn(sql, FU283_SCOPE), [], sql);
    assert.deepEqual(
      definitionProblems({ body: sql, header: '', language: 'sql' }, FU283_SCOPE),
      [],
      sql,
    );
    // EXPLAIN is not replayed, independently of this creation boundary.
    if (!sql.startsWith('EXPLAIN'))
      assert.deepEqual(replayMigrations([FU283_BASE, sql]).unmodelled, [], sql);
  }
  for (const prefix of ['', 'EXPLAIN ANALYZE ', 'WITH x AS (SELECT 1) ']) {
    const sql = `${prefix}MERGE INTO task USING task s ON false WHEN MATCHED THEN DELETE`;
    // MERGE retains its pre-existing R2 refusal; it must never acquire a creation/R0 refusal.
    assert.deepEqual(problemsIn(sql, FU283_SCOPE), ['R2 MERGE INTO task is not modelled'], sql);
    assert.deepEqual(
      definitionProblems({ body: sql, header: '', language: 'sql' }, FU283_SCOPE),
      ['R2 MERGE INTO task is not modelled'],
      sql,
    );
    assert.ok(
      replayMigrations([FU283_BASE, sql]).unmodelled.every((p) => !p.includes('created relation')),
      sql,
    );
  }
});
test('FU-283 source inventory reaches clock-free creation literals', () => {
  for (const sql of [FU283_CREATIONS[0], FU283_CREATIONS[8], FU283_CREATIONS[18]])
    assert.match(
      scanOf('x-service', FU283_BASE, `export const sql = ${JSON.stringify(sql)};`).join(),
      /R0/,
    );
});

const sinkSchema = 'CREATE TABLE task (id text, at timestamptz(3));';
const prismaImport = "import { Prisma as P } from '../generated/prisma';";
const numericFiles = {
  'services/x-service/src/limit.ts': 'export const MAX = 2_147_483_647;',
  'services/x-service/src/reexport.ts': "export { MAX as LIMIT } from './limit';",
};
const sinkTextsOf = (source, extra) => scanOf('x-service', sinkSchema, source, extra, (root) => sqlSinkTexts(root).map((s) => s.text));
for (const [name, pattern, source, extra] of [
  ['mapped SQL tuples', /INSERT INTO task.*VALUES/s, `${prismaImport}
    function run(ids: string[]) {
      const rows = P.join(ids.map(id => P.sql\`(\${id}, (now() AT TIME ZONE 'UTC'))\`));
      db.$executeRaw(P.sql\`INSERT INTO task (id, at) VALUES \${rows}\`);
    }`],
  ['push-only fragment list', /SELECT id FROM task WHERE/s, `${prismaImport}
    function predicate(id: string, flag: boolean) {
      const parts = []; if (flag) parts.push(P.sql\`id = \${id}\`);
      return parts.length ? P.sql\`(\${P.join(parts, ' OR ')})\` : null;
    }
    function run(id: string) { db.$queryRaw(P.sql\`SELECT id FROM task WHERE \${predicate(id, true)}\`); }`],
  ['mapped bound scalar', /WHERE id IN /, `${prismaImport} function run(ids: string[]) { db.$queryRaw(P.sql\`SELECT id FROM task WHERE id IN (\${P.join(ids.map(id => id))})\`); }`],
  ['mapped Sql scalar', /WHERE id IN /, `${prismaImport} function run(ids: string[]) { db.$queryRaw(P.sql\`SELECT id FROM task WHERE id IN (\${P.join(ids.map(id => P.sql\`\${id}\`))})\`); }`],
  ['scalar Set list', /WHERE id IN .* AND id =/s, `${prismaImport}
    function run(ids: readonly string[], tenant: string) {
      db.$queryRaw(P.sql\`SELECT id FROM task WHERE id IN (\${P.join([...new Set(ids)].sort())}) AND id = \${tenant}\`);
    }`],
  ['numeric import alias', /2147483647/, `import { LIMIT as MAX } from '../reexport';
    const NOW = "(now() AT TIME ZONE 'UTC')"; const PREDICATE = \`1 < \${MAX}\`;
    const SQL = \`SELECT \${NOW} WHERE \${PREDICATE}\`;
    db.$queryRawUnsafe(SQL);`, numericFiles],
]) test(`sink proof: ${name}`, () => {
  const texts = sinkTextsOf(source, extra);
  assert.ok(texts.length && texts.every((text) => typeof text === 'string'));
  assert.match(texts.join('\n'), pattern);
});

for (const [name, source, extra = {}] of [
  ['non-tuple map fragment', `${prismaImport} function run(ids: string[]) { db.$queryRaw(P.sql\`SELECT \${P.join(ids.map(() => P.sql\`1\`))}\`); }`],
  ['unknown-cardinality separator', `${prismaImport} function run(ids: string[]) { db.$queryRaw(P.sql\`SELECT \${P.join(ids, ' INTO TEMP task SELECT ')}\`); }`],
  ['fragment list length mutation', `${prismaImport} function run() { const parts = []; parts.push(P.sql\`id = 1\`); parts.length = runtime; db.$queryRaw(P.sql\`SELECT 1 WHERE \${P.join(parts)}\`); }`],
  ['looped fragment pushes', `${prismaImport} function run(ids: string[]) { const parts = []; for (const id of ids) parts.push(P.sql\`id = \${id}\`); db.$queryRaw(P.sql\`SELECT 1 WHERE \${P.join(parts)}\`); }`],
  ['replaced Array.push', `${prismaImport} Array.prototype.push = runtime; function run() { const parts = []; parts.push(P.sql\`id = 1\`); db.$queryRaw(P.sql\`SELECT 1 WHERE \${P.join(parts)}\`); }`],
  ['numeric expression is unresolved', 'const n = 1 + 2; db.$queryRawUnsafe(`SELECT ${n}`);'],
  ['object concatenation', `${prismaImport} db.$queryRawUnsafe('SELECT ' + P.sql\`1\`);`],
  ['object interpolation', `${prismaImport} db.$queryRawUnsafe(\`SELECT \${P.sql\`1\`}\`);`],
  ['escaped Sql fragment', `${prismaImport} const part = P.sql\`SELECT 1\`; leak(part); db.$queryRaw(part);`],
  ['nested Sql mutation', `${prismaImport} const part = P.sql\`SELECT 1\`; part.strings[0] = runtime; db.$queryRaw(part);`],
  ['aliased Sql escape', `${prismaImport} const part = P.sql\`SELECT 1\`; const alias = part; leak(alias); db.$queryRaw(part);`],
  ['mutating Sql helper', `${prismaImport} function mutate(p) { p.strings[0] = runtime; } const part = P.sql\`SELECT 1\`; mutate(part); db.$queryRaw(part);`],
  ['exported Sql fragment', `${prismaImport} export const part = P.sql\`SELECT 1\`; db.$queryRaw(part);`],
  ['custom map method', `${prismaImport} const ids = { map: custom }; db.$queryRaw(P.sql\`SELECT \${P.join(ids.map(id => P.sql\`(1)\`))}\`);`],
  ['replaced array join', "const pieces = ['SELECT 1']; pieces.join = runtime; db.$queryRawUnsafe(pieces.join(''));"],
  ['escaped string array', `const pieces = ['SELECT 1']; mutate(pieces); db.$queryRawUnsafe(pieces.join(''));`],
  ['shadow generated client', `${prismaImport} db.$queryRaw(P.sql\`SELECT 1\`);`,
    { 'services/x-service/src/generated/prisma.ts': 'export const Prisma = { sql: custom };' }],
  ['unknown inside error constructor', 'throw new Error(db.$queryRawUnsafe(runtime));'],
  ['unknown expression', 'db.$queryRawUnsafe(runtime);'],
  ['reassigned builder', "let build = () => 'SELECT 1'; build = runtime; db.$queryRawUnsafe(build());"],
  ['unknown builder', 'db.$queryRawUnsafe(build());'],
  ['shadowed String.raw', 'const String = { raw: custom }; db.$queryRawUnsafe(String.raw`SELECT 1`);'],
  ['escaped list', `${prismaImport} function run() { const parts = []; leak(parts); parts.push(P.sql\`id = 1\`); db.$queryRaw(P.sql\`SELECT 1 WHERE \${P.join(parts)}\`); }`],
  ['unknown pushed fragment', `${prismaImport} function run() { const parts = []; parts.push(build()); db.$queryRaw(P.sql\`SELECT 1 WHERE \${P.join(parts)}\`); }`],
  ['arbitrary tag', 'db.$queryRawUnsafe(custom`SELECT 1`);'],
  ['fake Prisma', 'const P = evil; db.$queryRaw(P.sql`SELECT 1`);'],
  ['raw runtime fragment', `${prismaImport} db.$queryRaw(P.sql\`SELECT \${P.raw(runtime)}\`);`],
  ['unresolved map body', `${prismaImport} function run(ids: string[]) { db.$queryRaw(P.sql\`SELECT \${P.join(ids.map(id => build(id)))}\`); }`],
  ['unresolved list', `${prismaImport} function run(ids: unknown[]) { db.$queryRaw(P.sql\`SELECT \${P.join(ids)}\`); }`],
  ['unresolved separator', `${prismaImport} db.$queryRaw(P.sql\`SELECT \${P.join([1, 2], runtime)}\`);`],
  ['mutable import', "import { MAX } from '../limit'; db.$queryRawUnsafe(`SELECT ${MAX}`);",
    { 'services/x-service/src/limit.ts': 'export let MAX = 1;' }],
  ['mutated const', "const SQL = 'SELECT 1'; SQL = runtime; db.$queryRawUnsafe(SQL);"],
  ['import cycle', "import { MAX } from '../limit'; db.$queryRawUnsafe(`SELECT ${MAX}`);",
    { 'services/x-service/src/limit.ts': "import { OTHER } from './other'; export const MAX = OTHER;",
      'services/x-service/src/other.ts': "import { MAX } from './limit'; export const OTHER = MAX;" }],
]) test(`sink refusal: ${name}`, () => assert.ok(sinkTextsOf(source, extra).includes(null)));


test('numeric SQL text preserves an imported alias value', () => {
  const texts = sinkTextsOf("import { LIMIT } from '../reexport'; db.$queryRawUnsafe(`SELECT ${LIMIT}`);", numericFiles);
  assert.deepEqual(texts, ['SELECT 2147483647']);
});

const roleFiles = {
  'services/x-service/src/role.ts': `interface Client { $queryRawUnsafe(q: string): unknown }
    const SQL = 'SELECT 1';
    export function check(client: Client) { return client.$queryRawUnsafe(SQL); }`,
};
const adapter = `import { check as verify } from '../role';
  class Gate {
    private readonly adapter = { $queryRawUnsafe: (q: string, ...values: unknown[]) =>
      track(() => base.$queryRawUnsafe(q, ...values)) };
    run() { return verify(this.adapter); }
  }`;
test('sink proof: forwarded interface callback', () => {
  assert.deepEqual(scanOf('x-service', sinkSchema, adapter, roleFiles), []);
});
for (const [name, source, extra] of [
  ['mutating builder parameter', `${prismaImport} function mutate<T extends { strings: string[] }>(p: T): T { p.strings.push(runtime); return p; } db.$queryRaw(mutate(P.sql\`SELECT 1\`));`],
  ['opaque mutating builder', `${prismaImport} function mutate(p) { Reflect.set(p, 'strings', [runtime]); return p; } db.$queryRaw(mutate(P.sql\`SELECT 1\`));`],
  ['global array join replacement', "Array.prototype.join = runtime; const pieces = ['SELECT 1']; db.$queryRawUnsafe(pieces.join(''));"],
  ['raw join object conversion', `${prismaImport} db.$queryRawUnsafe(['SELECT ', P.sql\`1\`].join(''));`],
  ['exported forwarding arrow', "export const run = (q: string) => db.$queryRawUnsafe(q); run('SELECT 1');"],
  ['exported adapter', `import { check } from '../role'; export const adapter = { $queryRawUnsafe: (q: string) => base.$queryRawUnsafe(q) }; check(adapter);`, roleFiles],
  ['escaped forwarding function', "function run(q: string) { db.$queryRawUnsafe(q); } run('SELECT 1'); leak(run);"],
  ['bound forwarding escape', "function run(q: string) { db.$queryRawUnsafe(q); } run('SELECT 1'); leak(run.bind(null, runtime));"],
  ['explicit call forwarding', "function run(q: string) { db.$queryRawUnsafe(q); } run('SELECT 1'); run.call(null, runtime);"],
  ['mutated dispatch function', adapter, { ...roleFiles, 'services/x-service/src/role.ts': roleFiles['services/x-service/src/role.ts'] + '\ncheck = runtime;' }],
  ['unknown query callback', 'function run(query: (q: string) => unknown) { query(runtime); }'],
  ['unknown destructured query', 'function run(client: { query: (q: string) => unknown }) { const { query } = client; query(runtime); }'],
  ['owner escape', adapter.replace('return verify(this.adapter);', 'leak(this); return verify(this.adapter);'), roleFiles],
  ['dynamic member escape', adapter.replace('return verify(this.adapter);', 'leak(this[runtime]); return verify(this.adapter);'), roleFiles],
  ['computed adapter escape', adapter.replace('return verify(this.adapter);', "leak(this['adapter']); return verify(this.adapter);"), roleFiles],
  ['escaped adapter', adapter.replace('verify(this.adapter)', 'leak(this.adapter)'), roleFiles],
  ['additional unknown caller', adapter.replace('return verify(this.adapter);', 'leak(this.adapter); return verify(this.adapter);'), roleFiles],
  ['unresolved forwarding argument', adapter, { ...roleFiles,
    'services/x-service/src/role.ts': roleFiles['services/x-service/src/role.ts'].replace("const SQL = 'SELECT 1'", 'const SQL = runtime') }],
  ['escaped receiving parameter', adapter, { ...roleFiles,
    'services/x-service/src/role.ts': roleFiles['services/x-service/src/role.ts'].replace('return client.', 'leak(client); return client.') }],
  ['escaped query parameter', adapter.replace('track(() =>', 'track(q, () =>'), roleFiles],
  ['finite annotation still needs every caller', "function run(q: 'SELECT 1') { db.$queryRawUnsafe(q); } run(runtime);"],
  ['multiple callers include unknown', "function run(q: string) { db.$queryRawUnsafe(q); } run('SELECT 1'); run(runtime);"],
  ['unresolved sink inside error', 'throw new Error(db.$queryRawUnsafe(runtime));'],
]) test(`sink forwarding refuses: ${name}`, () => {
  assert.match(scanOf('x-service', sinkSchema, source, extra).join(), /R0 unresolved SQL/);
});

for (const source of [
  'db.$executeRawUnsafe(String.raw`${`\\u0053ELECT 1`} INTO TEMP task`);',
  'db.$executeRawUnsafe("SELECT 1 IN" + "TO TEMP task");',
  'const s = "SELECT 1"; db.$executeRawUnsafe(`${s} INTO TEMP task`);',
  'db.$executeRawUnsafe(`${runtime} INTO TEMP task`);',
  'db.$executeRawUnsafe(`CREATE TABLE "${runtime}".task (id text)`);',
  `${prismaImport} db.$queryRaw(P.sql\`SELECT \${P.join([P.sql\`now() INTO TEMP task\`])}\`);`,
]) test(`joined SQL is classified: ${source}`, () => assert.ok(scanOf('x-service', sinkSchema, source).length));

test('quoted CREATE target preserves splice provenance', () => {
  assert.match(problemsIn('CREATE TABLE "\uE0000\uE001".task (id text)', scope).join(), /CREATE target/);
});
test('joined fragment with no keyword is SQL in its outer SELECT', () => {
  const source = `${prismaImport} function run(ids: string[]) {
    const tail = P.sql\`INTO TEMP task\`;
    db.$queryRaw(P.sql\`SELECT 1 \${P.join([tail])}\`);
  }`;
  assert.match(scanOf('x-service', sinkSchema, source).join(), /INTO whose created relation/);
});

test('String.raw interpolations retain cooked JavaScript values', () => {
  assert.deepEqual(sinkTextsOf('db.$queryRawUnsafe(String.raw`${`\\u0053ELECT 1`} WHERE 1 = 1`);'), ['SELECT 1 WHERE 1 = 1']);
});

// r2: each proof has a refusal counterpart using the same typed Prisma fixture.
for (const [name, source, pattern] of [
  ['literal raw join arguments', `${prismaImport} const SEP = ' OR '; const PRE = '('; const POST = ')';
    db.$queryRaw(P.sql\`SELECT 1 WHERE \${P.join([P.sql\`id = 1\`, P.sql\`id = 2\`], SEP, PRE, POST)}\`);`, /WHERE \(id = 1 OR id = 2\)/],
  ['array scalar spread', `${prismaImport} function run(ids: string[]) {
    db.$queryRaw(P.sql\`SELECT \${P.join([...ids], ',', '(', ')')}\`); }`, /SELECT \(.*\)/],
  ['push scalar spread', `${prismaImport} function run(ids: string[]) {
    const parts = []; parts.push(...ids); db.$queryRaw(P.sql\`SELECT \${P.join(parts)}\`); }`, /SELECT /],
  ['unescaped scalar const list', `${prismaImport} const ids = ['a', 'b'];
    db.$queryRaw(P.sql\`SELECT \${P.join(ids, ' OR ')}\`);`, / OR /],
  ['this parameter forwarding', "function run(this: void, q: string) { db.$queryRawUnsafe(q); } run('SELECT 1');", /SELECT 1/],
  ['this parameter builder', "function build(this: void, q: string) { return q; } db.$queryRawUnsafe(build('SELECT 1'));", /SELECT 1/],
  ['this parameter safe refs', `${prismaImport} function consume(this: void, p: P.Sql) { db.$queryRaw(p); }
    const part = P.sql\`SELECT 1\`; consume(part);`, /SELECT 1/],
  ['private direct forwarding', "class Gate { private run(q: string) { db.$queryRawUnsafe(q); } go() { this.run('SELECT 1'); } }", /SELECT 1/],
]) test(`r2 proof: ${name}`, () => {
  const texts = sinkTextsOf(source);
  assert.ok(texts.length && texts.every((text) => typeof text === 'string'), JSON.stringify(texts));
  assert.match(texts.join('\n'), pattern);
});
test('r2 proof: this parameter adapter dispatch', () => {
  const extra = { ...roleFiles, 'services/x-service/src/role.ts':
    roleFiles['services/x-service/src/role.ts'].replace('check(client:', 'check(this: void, client:') };
  assert.deepEqual(scanOf('x-service', sinkSchema, adapter, extra), []);
});
for (const [name, source] of [
  ['runtime raw separator', `${prismaImport} function run(sep: string) {
    db.$queryRaw(P.sql\`SELECT \${P.join([1, 2], sep)}\`); }`],
  ['runtime raw prefix', `${prismaImport} function run(pre: string) {
    db.$queryRaw(P.sql\`SELECT \${P.join([1], ',', pre)}\`); }`],
  ['runtime raw suffix', `${prismaImport} function run(post: string) {
    db.$queryRaw(P.sql\`SELECT \${P.join([1], ',', '', post)}\`); }`],
  ['array spread raw separator', `${prismaImport} function run(ids: string[]) {
    db.$queryRaw(P.sql\`SELECT \${P.join([...ids], ' OR at < now() OR ')}\`); }`],
  ['push spread raw separator', `${prismaImport} function run(ids: string[]) {
    const parts = []; parts.push(...ids); db.$queryRaw(P.sql\`SELECT \${P.join(parts, ' OR at < now() OR ')}\`); }`],
  ['array spread Sql elements', `${prismaImport} function run(ids: P.Sql[]) {
    db.$queryRaw(P.sql\`SELECT \${P.join([...ids])}\`); }`],
  ['push spread Sql elements', `${prismaImport} function run(ids: P.Sql[]) {
    const parts = []; parts.push(...ids); db.$queryRaw(P.sql\`SELECT \${P.join(parts)}\`); }`],
  ['escaped scalar const list', `${prismaImport} const ids = ['a']; extend(ids);
    db.$queryRaw(P.sql\`SELECT \${P.join(ids, ' OR at < now() OR ')}\`);`],
  ['aliased scalar const list', `${prismaImport} const ids = ['a']; const alias = ids; alias.push('b');
    db.$queryRaw(P.sql\`SELECT \${P.join(ids, ' OR at < now() OR ')}\`);`],
  ['assigned scalar const list', `${prismaImport} const ids = ['a']; Object.assign(ids, ['b', 'c']);
    db.$queryRaw(P.sql\`SELECT \${P.join(ids, ' OR at < now() OR ')}\`);`],
  ['this parameter runtime forwarding', "function run(this: void, q: string, r: string) { db.$queryRawUnsafe(q); } run(runtime, 'SELECT 1');"],
  ['this parameter runtime builder', "function build(this: void, q: string, r: string) { return q; } db.$queryRawUnsafe(build(runtime, 'SELECT 1'));"],
  ['this parameter escaped fragment', `${prismaImport} function leak(this: void, p: P.Sql) { expose(p); }
    const part = P.sql\`SELECT 1\`; leak(part); db.$queryRaw(part);`],
  ['spread forwarding arguments', "function run(q: string) { db.$queryRawUnsafe(q); } run(...['SELECT 1']);"],
  ['rest forwarding parameter', "function run(...q: string[]) { db.$queryRawUnsafe(q[0]); } run('SELECT 1');"],
  ['dynamic private caller', "class Gate { private run(q: string) { db.$queryRawUnsafe(q); } a() { this.run('SELECT 1'); } b(k: 'run') { this[k](runtime); } }"],
  ['decorated private method', "class Gate { @OnEvent('query') private run(q: string) { db.$queryRawUnsafe(q); } a() { this.run('SELECT 1'); } }"],
  ['tagged forwarding caller', "function run(q: string) { db.$queryRawUnsafe(q); } run`SELECT 1`;"],
]) test(`r2 refusal: ${name}`, () => assert.ok(sinkTextsOf(source).includes(null)));
for (const [name, args, expected] of [
  ['separator', "[1, 2], ' OR at < now() OR '", / OR at < now\(\) OR /],
  ['prefix', "[1], ',', 'now() + '", /now\(\) \+ /],
  ['suffix', "[1], ',', '', ' + now()'", / \+ now\(\)/],
]) test(`r2 raw ${name} retains SQL text`, () => {
  const source = `${prismaImport} db.$queryRaw(P.sql\`UPDATE task SET at = \${P.join(${args})}\`);`;
  assert.match(sinkTextsOf(source).join(), expected);
  const migration = 'CREATE TABLE task (id text, at timestamp(3));';
  assert.match(scanOf('x-service', migration, source).join(), /R1/);
});

test('FU-324 refuses locking membership subqueries, including tuple DELETE and ANY ARRAY', () => {
  const from = 'FROM t LIMIT 1 /* gap */ LOCK';
  const forms = [`id IN (SELECT id ${from})`, `(id, org) IN (SELECT id, org ${from})`,
    `id = ANY(ARRAY(SELECT id ${from}))`, `id = ALL(SELECT id ${from})`];
  for (const membership of forms) {
    for (const lock of ['FOR UPDATE', 'FOR NO KEY UPDATE SKIP LOCKED', 'FOR SHARE']) {
      const sql = `DELETE FROM t WHERE ${membership.replace('LOCK', lock)}`;
      assert.match(claimSubqueryProblems(sql).join(), /WITH picked AS MATERIALIZED/);
    }
  }
  assert.match(claimSubqueryProblems('DELETE FROM t WHERE id IN (TABLE t LIMIT 1 FOR UPDATE)').join(), /MATERIALIZED/);
  const cte = `WITH picked AS MATERIALIZED (SELECT id FROM t LIMIT 1 FOR UPDATE SKIP LOCKED)
    UPDATE t SET lease = 1 FROM picked WHERE t.id = picked.id`;
  assert.deepEqual(claimSubqueryProblems(cte), []);
  // FU-325: a string that holds a picker is refused wherever it stands; nothing proves it is not executed.
  assert.match(claimSubqueryProblems(`SELECT 'IN (SELECT id FOR UPDATE)'`).join(), /FU-324/);
});

test('FU-324 PostgreSQL comment boundaries cannot hide a locking picker', () => {
  for (const end of ['\r', '\n', '\r\n']) {
    for (const form of [
      'id IN (SELECT id',
      '(id, org) IN (SELECT id, org',
      'id = ANY(ARRAY(SELECT id',
      'id = SOME(SELECT id',
      'id = ALL(SELECT id',
    ]) {
      for (const lock of ['UPDATE', 'NO KEY UPDATE', 'SHARE', 'KEY SHARE']) {
        const suffix = form.includes('ARRAY') ? '))' : ')';
        for (const position of ['start', 'select', 'lock']) {
          let sql = `DELETE FROM t WHERE ${form} FROM t LIMIT 1 FOR ${lock}${suffix}`;
          if (position === 'start') sql = `-- comment${end}${sql}`;
          if (position === 'select') sql = sql.replace('SELECT', `-- comment${end}SELECT`);
          if (position === 'lock') sql = sql.replace('FOR ', `FOR -- comment${end}`);
          assert.match(claimSubqueryProblems(sql).join(), /FU-324/, sql);
        }
      }
    }
  }
  assert.match(
    claimSubqueryProblems(
      'DELETE FROM t WHERE id IN (SELECT id /* outer /* nested */ end */ FROM t FOR UPDATE)',
    ).join(),
    /FU-324/,
  );
});

test('FU-324 refuses derived locking pickers and unreadable SQL', () => {
  for (const sql of [
    'UPDATE t SET lease = 1 FROM (SELECT id FROM t LIMIT 1 FOR UPDATE) due WHERE t.id = due.id',
    'DELETE FROM t USING (SELECT id FROM t LIMIT 1 FOR UPDATE) due WHERE t.id = due.id',
    'UPDATE t SET lease = 1 FROM LATERAL (SELECT id FROM t FOR SHARE) due',
    "DELETE FROM t WHERE id IN (SELECT 'unterminated FOR UPDATE)",
    'DELETE FROM t /* unclosed /* nested */',
    'DELETE FROM t WHERE id IN (SELECT id FROM t FOR UPDATE',
    'SELECT (1',
  ])
    assert.match(claimSubqueryProblems(sql).join(), /FU-324/, sql);
  assert.deepEqual(claimSubqueryProblems('SELECT id FROM t LIMIT 1 FOR UPDATE'), []);
});

for (const [name, path, wrap] of [
  ['source literal', 'services/x-service/src/claim.ts', (s) => `const sql = ${JSON.stringify(s)};`],
  ['migration DML', 'services/x-service/prisma/migrations/2_claim/migration.sql', (s) => s],
  [
    'SQL routine',
    'services/x-service/prisma/migrations/2_claim/migration.sql',
    (s) => `CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $$${s}$$; DROP FUNCTION f();`,
  ],
  [
    'PLpgSQL routine',
    'services/x-service/prisma/migrations/2_claim/migration.sql',
    (s) => `CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$BEGIN ${s}; END$$;`,
  ],
  [
    'DO',
    'services/x-service/prisma/migrations/2_claim/migration.sql',
    (s) => `DO $$BEGIN ${s}; END$$;`,
  ],
  ['down migration', 'services/x-service/prisma/migrations/1_init/down.sql', (s) => s],
  ['operational SQL', 'scripts/claim.sql', (s) => s],
  ['operational JS', 'scripts/claim.mjs', (s) => `db.query(${JSON.stringify(s)});`],
  ['opaque operational SQL', 'scripts/claim.mjs', () => 'db.$queryRawUnsafe(runtime);'],
  ['operational shell', 'scripts/claim.sh', (s) => `psql <<'SQL'\n${s};\nSQL`],
])
  test(`FU-324 checks ${name} before clock exemptions`, () => {
    const bad = 'DELETE FROM task WHERE id IN (-- comment\rSELECT id FROM task LIMIT 1 FOR UPDATE)';
    const found = scanOf('x-service', 'CREATE TABLE task (id text);', '', { [path]: wrap(bad) });
    assert.match(found.filter((p) => p.includes(path)).join(), /FU-324/);
  });

// FU-325 (PR #1070 r2 F1): the escapes the review executed. No statement head is needed to be read.
const PICKED = '(SELECT id FROM task LIMIT 1 FOR UPDATE SKIP LOCKED)';
const CLAIM = `WITH args(n) AS (SELECT 1) DELETE FROM task WHERE id IN ${PICKED}`;
const quoted = (text) => `'${text.replaceAll("'", "''")}'`;

for (const [name, path, wrap] of [
  ['source literal', 'services/x-service/src/claim.ts', (s) => `const sql = ${JSON.stringify(s)};`],
  ['source literal parts', 'services/x-service/src/claim.ts', (s) =>
    `const sql = \`${s.replace('FOR UPDATE', "FOR ${('UP')}${'DA' + 'TE'}")}\`;`],
  ['migration DML', 'services/x-service/prisma/migrations/2_claim/migration.sql', (s) => s],
  ['SQL routine', 'services/x-service/prisma/migrations/2_claim/migration.sql', (s) =>
    `CREATE FUNCTION f() RETURNS void LANGUAGE sql AS ${quoted(s)}; DROP FUNCTION f();`],
  ['PLpgSQL routine', 'services/x-service/prisma/migrations/2_claim/migration.sql', (s) =>
    `CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $f$BEGIN EXECUTE ${quoted(`; EXPLAIN ANALYZE ${s}`)}; END$f$;`],
  ['down migration', 'services/x-service/prisma/migrations/1_init/down.sql', (s) => s],
  ['operational SQL', 'scripts/claim.sql', (s) => `SELECT ${quoted(s)};`],
  ['operational JS', 'scripts/claim.mjs', (s) => `db.query('WI' + ${JSON.stringify(s.slice(2))});`],
  ['JS psql argument', 'scripts/claim.mjs', (s) => `spawnSync('psql', ['-X', '-c', ${JSON.stringify(s)}]);`],
  ['shell attached -c', 'scripts/claim.sh', (s) => `psql -c${JSON.stringify(s)}`],
  ['shell here-document', 'scripts/claim.sh', (s) => `psql <<'SQL'\n${s};\nSQL`],
])
  test(`FU-325 reads ${name} with no statement head it knows`, () => {
    const found = scanOf('x-service', 'CREATE TABLE task (id text);', '', { [path]: wrap(CLAIM) });
    assert.match(found.filter((p) => p.includes(path)).join(), /FU-324/);
  });

// FU-337 refuses SQL built at run time at its site (tests below); these read what FU-324 makes of the pieces.
const fu324 = (...read) => claimSubqueryProblems(...read).filter((problem) => !problem.startsWith('FU-337'));

test('FU-325 SQL is composed and decoded before it is classified, in every quoting', () => {
  for (const sql of [
    `CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $body$${CLAIM}$body$`,
    `CREATE FUNCTION f() RETURNS void LANGUAGE sql AS E'${CLAIM.replace('FOR', '\\x46OR')}'`,
    `DO $$BEGIN EXECUTE E'${CLAIM.replace('FOR', '\\106OR')}'; END$$`,
    `DO $a$BEGIN EXECUTE $b$<<l>> ${CLAIM}$b$; END$a$`,
    `DO $$BEGIN EXECUTE 'DEL' || 'ETE FROM task WHERE id IN (SELECT id FROM task FOR UP' || 'DATE)'; END$$`,
    `SELECT 'DELETE FROM task WHERE id IN (SELECT id FROM task FOR UP'\n  'DATE)'`,
    // An operand that is not a constant is unknown text: it may be the lock clause, or the picker.
    `DO $$BEGIN EXECUTE 'DELETE FROM task WHERE id IN (SELECT id FROM task LIMIT 1 ' || lock_clause || ')'; END$$`,
    `DO $$BEGIN EXECUTE 'DELETE FROM task WHERE id IN (SELECT id FROM task FOR ' || upper(mode)::text || ')'; END$$`,
    `DO $$BEGIN EXECUTE 'DELETE FROM task WHERE id IN (' || picker || ')'; END$$`,
    `DO $$BEGIN EXECUTE 'DELETE FROM task WHERE id = ANY ((' || picker || '))'; END$$`,
    `DO $$BEGIN EXECUTE U&'DELETE FROM task WHERE id IN (SELECT id FROM task !0046OR UPDATE)' UESCAPE '!'; END$$`,
    `DO $$BEGIN EXECUTE 'DELETE FROM task WHERE id IN (SELECT id FROM ' || quote_ident(t)::text || ' FOR UPDATE)'; END$$`,
    `DO $$BEGIN EXECUTE 'DELETE FROM task USING (' || picker || ') due WHERE task.id = due.id'; END$$`,
    `DO $$BEGIN EXECUTE q || ''' AND id IN (SELECT id FROM task FOR /* c */ UPDATE)'; END$$`,
  ])
    assert.match(claimSubqueryProblems(sql).join(), /FU-324/, sql);
  for (const sql of [
    `DO $$BEGIN RAISE EXCEPTION 'List them with: SELECT id FROM task t WHERE NOT EXISTS (SELECT 1 FROM p) for a person''s update'; END$$`,
    `DO $$BEGIN EXECUTE 'SELECT count(*) FROM ' || quote_ident(t) || ' WHERE a = ''x'''; EXECUTE 'CREATE INDEX i ON t (' || col || ')'; END$$`,
    `SELECT string_agg(n || ' (' || s || ')', ', ') FROM task WHERE id = 'it''s' || $1 || ' (' || pct || '%)'`,
    `DO $$BEGIN EXECUTE 'DELETE FROM t WHERE EXISTS (SELECT 1 FROM ' || quote_ident(t) || ' x WHERE x.id = ' || quote_literal(v) || ')'; END$$`,
    `DO $$BEGIN EXECUTE 'WITH picked AS MATERIALIZED (SELECT id FROM ' || quote_ident(t) || ' LIMIT 1 FOR UPDATE) DELETE FROM task USING picked'; END$$`,
    `WITH picked AS MATERIALIZED ${PICKED} DELETE FROM task USING picked WHERE task.id = picked.id`,
  ])
    assert.deepEqual(fu324(sql), [], sql);
});

test('FU-324 cannot be waived by a matching reviewed DO block', () => {
  // PR #1070 r2: the entry hashes the whole string token, as the replay does, so it really matches.
  for (const [body, claim] of [
    [`$$BEGIN EXECUTE 'DROP TABLE task'; END$$`, false],
    [`$$BEGIN EXECUTE 'DEL' || 'ETE FROM task WHERE id IN (SELECT id FROM task FOR UP' || 'DATE)'; END$$`, true],
  ]) {
    REVIEWED_DO_BLOCKS.push({ service: 'x-service', migration: '1_init', sha256: contentHash(body) });
    try {
      const found = scanOf('x-service', `CREATE TABLE task (id text); DO ${body};`).join();
      assert.doesNotMatch(found, /DDL or SQL in a DO block/);
      assert.equal(/FU-324/.test(found), claim, body);
    } finally { REVIEWED_DO_BLOCKS.pop(); }
  }
});

// PR #1082 r1 (F1–F3): the review's probes and their cross-product, quoting × wrapper × entry
// point. Split 1 is the review's: its first piece alone is an unbalanced statement, which
// origin/main refused. The pieces of split 2 say nothing alone: only composing them finds it.
const SPLITS = [
  ['DELETE FROM task WHERE id IN (SELECT id FROM task LIMIT 1 FOR UP', '', 'DATE SKIP LOCKED)'],
  ['EXPLAIN DELETE FROM task WHERE id = (SE', 'LECT id FROM task LIMIT 1 FOR UP', 'DATE SKIP LOCKED)'],
];
const QUOTINGS = [quoted, (s) => `E${quoted(s).replace('FOR', '\\x46OR')}`,
  (s) => `U&${quoted(s).replace('FOR', '\\0046OR')}`, (s) => `$q$${s}$q$`];
const WRAPPERS = [
  (a, b, c) => `${a}::text || ${b}::pg_catalog.varchar || ${c}`,
  (a, b, c) => `(${a}) || ((${b}) || ${c})`,
  (a, b, c) => `CAST(${a} AS text) || CAST(${b} AS pg_catalog.text) || CAST(${c} AS varchar)`,
  (a, b, c) => `${a} COLLATE "C" || ${b} COLLATE pg_catalog."C" || ${c}`,
  (a, b, c) => `CAST((${a})::text || ${b} AS varchar) COLLATE "C" || (${c})`,
];
const TS_WRAPPERS = [
  (a, b, c) => `(${a} as string) + (${b} as string) + (${c} as const)`,
  (a, b, c) => `(${a} satisfies string) + (${b} satisfies string) + ${c}`,
  (a, b, c) => `${a}! + ${b}! + ${c}`,
  (a, b, c) => `<string>${a} + <string>${b} + ${c}`,
  (a, b, c) => `\`\${${a} as string}\${(${b})!}\${<string>${c}}\``,
];
const doBody = (expression) => `$do$BEGIN EXECUTE ${expression}; END;$do$`;
const WRAPPED = SPLITS.flatMap((split) =>
  QUOTINGS.flatMap((quote) => WRAPPERS.map((wrap) => doBody(wrap(...split.map(quote))))));
const PROBE = SPLITS[0].join('');
const QUOTED = [quoted(PROBE), QUOTINGS[1](PROBE), QUOTINGS[2](PROBE), `${quoted(SPLITS[0][0])} || ${quoted(SPLITS[0][2])}`,
  quoted(PROBE.replace('FOR UP', 'FOR /* c */ UP'))].map(doBody);
const chain = (n) => Array(n).fill(String.raw`'/* \n */ '`).join(' || ');
const js = (text) => `spawnSync('psql', ['-X', '-c', ${JSON.stringify(text)}]);`;
const sh = (text) => `psql -X -c '${text.replaceAll("'", `'\\''`)}'\n`;
const ENTRY_POINTS = {
  'scripts/r1/N.sql': (text) => text,
  'services/x-service/prisma/migrations/2_r1_N/migration.sql': (text) => text,
  'scripts/r1/N.mjs': js,
  'services/x-service/src/r1/N.ts': (text) => `export const sql = ${JSON.stringify(text)};`,
  'scripts/r1/N.sh': sh,
};
let r1;
/** One scan of every entry point (a scan takes seconds): the `path:line`s it must refuse, and those it did. */
function r1Scan() {
  if (r1) return r1;
  const files = {}, expected = { F1: [], F2: [], F3: [] }, reviewed = [];
  const add = (finding, path, text) => { files[path] = text; expected[finding].push(`${path}:1`); };
  const everywhere = (finding, name, body) => {
    for (const [path, wrap] of Object.entries(ENTRY_POINTS)) add(finding, path.replace('N', name), wrap(`DO ${body};`));
    reviewed.push({ service: 'x-service', migration: `2_r1_${name}`, sha256: contentHash(body) });
  };
  WRAPPED.forEach((body, n) => everywhere('F2', `w${n}`, body));
  everywhere('F3', 'budget', doBody(`${chain(6)} || ${quoted(PROBE)}`));
  // The review's text, and one with no statement head: only opening its string finds the SQL.
  for (const [n, body] of QUOTED.entries()) for (const [name, text] of [['do', `DO ${body};`], ['call', `CALL run(${body});`]]) {
    for (const ext of ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts']) add('F1', `scripts/r1/${name}${n}.${ext}`, js(text));
    for (const ext of ['sh', 'bash']) add('F1', `scripts/r1/${name}${n}.${ext}`, sh(text));
  }
  const parts = SPLITS.flatMap((split) => TS_WRAPPERS.map((wrap) => wrap(...split.map((s) => JSON.stringify(s)))));
  files['scripts/r1/wrappers.ts'] = parts.map((part) => `run(${part});\n`).join('');
  expected.F2.push(...parts.map((_, n) => `scripts/r1/wrappers.ts:${n + 1}`));
  // Ordinary data and accepted SQL in the same places: read, and not refused.
  files['scripts/r1/fine.ts'] = `run(('EXPLAIN SELECT (' as string) + n + ')', 'see (the list' as string, <string>'(for update)');\n`;
  files['scripts/r1/fine.sh'] = `echo 'waiting for update (1 of 2)' "$(date)"\n${sh(`DO ${doBody(`'CREATE INDEX i ON t (' || col || ')'`)};`)}`;
  files['scripts/r1/fine.sql'] = `SELECT CAST('a' AS text) || ('b')::text COLLATE "C" || U&'d\\0061ta' || x, ${chain(5)};`;
  REVIEWED_DO_BLOCKS.push(...reviewed);
  try {
    const found = scanOf('x-service', 'CREATE TABLE task (id text);', '', files);
    assert.doesNotMatch(found.join(), /DDL or SQL in a DO block/);
    const refused = found.filter((p) => /locking subquery/.test(p)).map((p) => p.split(': ')[0]);
    r1 = { missed: (finding) => expected[finding].filter((p) => !refused.includes(p)),
      unexpected: refused.filter((p) => !Object.values(expected).flat().includes(p)) };
  } finally { REVIEWED_DO_BLOCKS.splice(-reviewed.length); }
  return r1;
}

test('PR #1082 r1 F1: a text is opened before it is judged, never dropped for what it seems to hold', () => {
  assert.deepEqual(r1Scan().missed('F1'), []);
  assert.deepEqual(r1Scan().unexpected, []);
});

test('PR #1082 r1 F2: a text is composed through the syntax that leaves it the text it is', () => {
  for (const body of WRAPPED) assert.match(claimSubqueryProblems(`DO ${body};`).join(), /FU-324/, body);
  assert.deepEqual(r1Scan().missed('F2'), []);
  // Composed where this reader does not follow: a piece is judged with unknown text where it ends,
  // and a piece origin/main read for its statement head is still read so.
  for (const sql of [
    `SELECT concat('EXPLAIN DELETE FROM task WHERE id = (SE', 'LECT id FROM task FOR UPDATE)')`,
    `SELECT format('%s%s', 'EXPLAIN DELETE FROM task WHERE id IN (', picker)`,
    `SELECT concat('EXPLAIN DELETE FROM task WHERE id = (SELECT id FROM task ', lock_clause, ')')`,
    `SELECT upper('EXPLAIN DELETE FROM task WHERE id = (SELECT id FROM task FOR UP')::bpchar || 'DATE)'`,
    `SELECT concat('DELETE FROM task WHERE id = (SE', rest)`,
    // An operand that is not a constant is read too; a name is a constant only where nothing else may set it.
    `DO ${doBody(`'x' || lower(${quoted(`EXPLAIN ${PROBE}`)})`)}`,
    `DO $$DECLARE a CONSTANT text := ${quoted(SPLITS[1][0])}; b CONSTANT text := ${quoted(SPLITS[1][1])}; BEGIN EXECUTE a || b || 'DATE)'; END$$`,
    `DO $$DECLARE p CONSTANT text := 'SELECT 1'; BEGIN DECLARE p text := picker; BEGIN EXECUTE 'EXPLAIN DELETE FROM task WHERE id IN (' || p || ')'; END; END$$`,
    `DO $$DECLARE p CONSTANT text := '(x'; BEGIN EXECUTE r.p || ' FOR UPDATE)'; END$$`,
  ])
    assert.match(claimSubqueryProblems(sql).join(), /FU-324/, sql);
  for (const sql of [
    `DO $$DECLARE p CONSTANT text := 'SELECT id FROM task'; BEGIN EXECUTE 'SELECT count(*) FROM (' || p || ') s'; EXECUTE p || ' LIMIT 1'; END$$`,
    `SELECT concat('see (the list', x), '(for update)', upper('a (b')::bpchar || 'c)', u & 'x' FROM t WHERE id IN ('a') AND b = ANY (('{a}')::text[])`,
    `DO ${doBody(`'WITH picked AS MATERIALIZED (SELECT id FROM ' || quote_ident(t) || (' LIMIT 1 FOR UPDATE)')::text || ' DELETE FROM task USING picked'`)}`,
  ])
    assert.deepEqual(fu324(sql), [], sql);
});

test('PR #1082 r1 F3: a text with more readings than the budget is refused, never read as empty', () => {
  for (const n of [5, 6, 7, 8, 12])
    assert.match(claimSubqueryProblems(`DO ${doBody(`${chain(n)} || ${quoted(PROBE)}`)};`).join(), /FU-324/, String(n));
  assert.deepEqual(r1Scan().missed('F3'), []);
  // Whatever it holds, and through every composition: nothing proves what was not read.
  for (const sql of [`SELECT ${chain(8)}`, `SELECT ${quoted(`a note: ${chain(8)}`)}`, `SELECT CAST((${chain(8)})::text AS text) COLLATE "C" || 'x'`, `DO ${doBody(`a || (${chain(8)})`)}`])
    assert.match(claimSubqueryProblems(sql).join(), /FU-324/, sql);
  assert.deepEqual(fu324(`DO ${doBody(`${chain(5)} || x`)}`), []);
});

// PR #1082 r2 N1: a name's spelling does not prove its binding. PostgreSQL 16 runs each UNPROVEN
// text with other text where 0b3fe835 read the `SELECT 1` of a constant that is not what is read.
const ONE = `CONSTANT text := 'SELECT 1'`;
const run = (name) => `EXECUTE 'DELETE FROM task WHERE id IN (' || ${name} || ')'`;
const viaColumn = (name) => `q text; BEGIN SELECT 'DELETE FROM task WHERE id IN (' || ${name} || ')' INTO q FROM picker; EXECUTE q; END`;
const claimFn = (args, body) => `CREATE FUNCTION claim(${args}) RETURNS void LANGUAGE plpgsql AS $$${body}$$;`;
const LONG = 'a'.repeat(63);
const UNPROVEN = [
  // The review's: a nested constant beside a parameter (IN; OUT, set with `=`; INOUT), read before
  // the nested block or after it.
  claimFn('p text', `BEGIN ${run('p')}; DECLARE p ${ONE}; BEGIN NULL; END; END;`),
  claimFn('OUT p text', `BEGIN p = picker(); DECLARE p ${ONE}; BEGIN NULL; END; ${run('p')}; END;`),
  claimFn('INOUT p text', `DECLARE n int; BEGIN DECLARE p ${ONE}; BEGIN NULL; END; ${run('p')}; END;`),
  // Read before its declaration, the name is still the parameter.
  claimFn('p text', `DECLARE q text := 'DELETE FROM task WHERE id IN (' || p || ')'; p ${ONE}; BEGIN EXECUTE q; END;`),
  // A column: under variable_conflict (directive, or the session's setting), and beside "P".
  claimFn('', `#variable_conflict use_column\nDECLARE p ${ONE}; ${viaColumn('p')};`),
  `SET plpgsql.variable_conflict = use_column; DO $$DECLARE p ${ONE}; ${viaColumn('p')}$$;`,
  `DO $$DECLARE "P" ${ONE}; ${viaColumn('p')}$$;`,
  `DO $$DECLARE p ${ONE}; ${viaColumn('"P"')}$$;`,
  // A handler's own SQLERRM, a cursor argument of the same 63 bytes, a longer name (`ép`).
  `DO $$DECLARE sqlerrm ${ONE}; BEGIN RAISE EXCEPTION '%', picker(); EXCEPTION WHEN others THEN ${run('sqlerrm')}; END$$;`,
  `DO $$DECLARE ${LONG} ${ONE}; c CURSOR (${LONG}b text) FOR SELECT 'DELETE FROM task WHERE id IN (' || ${LONG} || ')'; q text; BEGIN OPEN c(picker()); FETCH c INTO q; EXECUTE q; END$$;`,
  claimFn('p text', `DECLARE ép ${ONE}; BEGIN ${run('p')}; END;`),
  // The type decides the value: a `name` ends at 63 bytes (`… FOR UPDATE`), a char(n) loses its spaces.
  `DO $$DECLARE p CONSTANT name := '${'SELECT id FROM task LIMIT 1 FOR UPDATE'.padStart(63)}d_at'; BEGIN ${run('p')}; END$$;`,
  `DO $$DECLARE s CONSTANT char(2) := '  '; BEGIN EXECUTE 'DELETE FROM task WHERE id IN (SELECT id FROM task LIMIT 1 FOR UP' || s || 'DATE)'; END$$;`,
  // Not a read of the variable: a type of that name (after `::`, before a string), and a word SQL
  // reads as a keyword's value (USER is the role's name), quoted where it is declared or not.
  `DO $$DECLARE p CONSTANT text := 'WITH picked AS MATERIALIZED '; BEGIN EXECUTE head()::p || '${PICKED}'; END$$;`,
  `DO $$DECLARE p CONSTANT text := 'WITH picked AS MATERIALIZED '; BEGIN EXECUTE 'DELETE FROM task WHERE id IN ' || p '${PICKED}'; END$$;`,
  `DO $$DECLARE user ${ONE}; BEGIN ${run('user')}; END$$;`,
  `DO $$DECLARE "current_schema" ${ONE}; BEGIN ${run('current_schema')}; END$$;`,
  // No chain starts at a name that is no text: what follows it is read alone too (`SELECT 1)`).
  claimFn('p text', `BEGIN EXECUTE p || 'SELECT 1)'; DECLARE p CONSTANT text := '('; BEGIN NULL; END; END;`),
  // A hole in the block: `nested` may be `DECLARE p text := picker(); BEGIN`.
  `DO $o$BEGIN EXECUTE 'DO $x$DECLARE p CONSTANT text := ''SELECT 1''; BEGIN ' || nested || ' ${run('p').replaceAll("'", "''")}; END; END$x$'; END$o$;`,
];
// A text nothing runs as one block proves no scope: the piece of a body, and a script, which psql
// runs statement by statement (the DECLARE fails, the SELECT reads the column p).
const NO_BLOCK = [
  `DECLARE p ${ONE}; BEGIN NULL; END; ${run('p')}; END;`,
  `DECLARE p ${ONE}; BEGIN; SELECT run_sql('DELETE FROM task WHERE id IN (' || p || ')') FROM (SELECT picker() AS p) s; END;`,
];
// Refused by 0b3fe835 too, and still: an unproven constant is ALSO read as its text, in any case;
// a name that qualifies a column, or is called, is not the constant.
const STILL_REFUSED = [
  `DO $$BEGIN DECLARE a CONSTANT text := ${quoted(SPLITS[1][0])}; B CONSTANT text := ${quoted(SPLITS[1][1])}; BEGIN EXECUTE A || "b" || 'DATE SKIP LOCKED)'; END; END$$;`,
  `DO $$DECLARE a CONSTANT text := ${quoted(SPLITS[1][0])}; B CONSTANT text := ${quoted(SPLITS[1][1])}; BEGIN EXECUTE A || "b" || 'DATE SKIP LOCKED)'; END$$;`,
  claimFn('text', `BEGIN DECLARE p ${ONE}; BEGIN NULL; END; DECLARE p ALIAS FOR $1; BEGIN ${run('p')}; END; END;`),
  `DO $$DECLARE p CONSTANT text := '1)'; q text; BEGIN SELECT 'DELETE FROM task WHERE id IN (' || p.picker || ')' INTO q FROM pickers p; EXECUTE q; END$$;`,
  `DO $$DECLARE p CONSTANT text := '1)'; BEGIN EXECUTE 'DELETE FROM task WHERE id IN (' || p(1) || ')'; END$$;`,
];
// Proven: the shape of service-privilege-split.bash (nested blocks, a handler, IF, LOOP, CASE), and
// a constant of the outermost block, which shadows a parameter of its name.
const PROVEN = [
  `DO $$DECLARE Pending CONSTANT text := 'SELECT id FROM task';
    still CONSTANT text := 'SELECT EXISTS (SELECT 1 FROM (' || pending || ') p WHERE p.id = $1)'; n int;
  BEGIN
    EXECUTE 'SELECT count(*) FROM (' || pending || ') p' INTO n;
    LOOP EXIT WHEN n = 0; IF n > 1 THEN n := CASE WHEN n > 2 THEN 1 ELSE 0 END; END IF;
      BEGIN n := n - 1; EXCEPTION WHEN others THEN NULL; END;
      CASE n WHEN 1 THEN NULL; ELSE NULL; END CASE;
      DECLARE m int; BEGIN m := n; END;
      EXECUTE pending || ' ORDER BY id LIMIT 1' INTO n;
      EXECUTE 'SELECT count(*) FROM (' || "pending" || ') p' INTO n; EXECUTE still INTO n USING n;
    END LOOP;
  END$$;`,
  claimFn('p text', `DECLARE p CONSTANT pg_catalog.varchar := 'SELECT id FROM task'; BEGIN EXECUTE 'SELECT count(*) FROM (' || P || ') s'; END;`),
];

test('PR #1082 r2 N1: a constant is read alone only where its binding is proven', () => {
  for (const sql of [...UNPROVEN, ...NO_BLOCK, ...STILL_REFUSED])
    assert.match(claimSubqueryProblems(sql).join(), /FU-324/, sql);
  for (const sql of PROVEN) assert.deepEqual(claimSubqueryProblems(sql), [], sql);
  // One reading does not stand for the other: the same text as a block, then as a script.
  const [seen, body] = [new Set(), `DECLARE p ${ONE}; BEGIN ${run('p')}; END;`];
  assert.deepEqual(claimSubqueryProblems(body, seen, true, true), []);
  assert.match(claimSubqueryProblems(body, seen, true).join(), /FU-324/);
});

test('PR #1082 r2 N1: in every file type, and under a reviewed DO block', () => {
  const files = {}, expected = [], reviewed = [];
  const everywhere = (name, text, refused) => {
    const migration = `services/x-service/prisma/migrations/2_r2_${name}/migration.sql`;
    const paths = { [`scripts/r2/${name}.sql`]: text, [migration]: text };
    for (const ext of ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts']) paths[`scripts/r2/${name}.${ext}`] = js(text);
    for (const ext of ['sh', 'bash']) paths[`scripts/r2/${name}.${ext}`] = sh(text);
    Object.assign(files, paths);
    if (refused) expected.push(...Object.keys(paths).map((path) => `${path}:1`));
    const body = /^(?:SET [^;]*; )?DO (\$(\w*)\$[^]*\$\2\$);$/.exec(text)?.[1];
    if (body) reviewed.push({ service: 'x-service', migration: `2_r2_${name}`, sha256: contentHash(body) });
  };
  UNPROVEN.forEach((text, n) => everywhere(`u${n}`, text, true));
  NO_BLOCK.forEach((text, n) => everywhere(`n${n}`, text, true));
  PROVEN.forEach((text, n) => everywhere(`p${n}`, text, false));
  // The session's setting, made by another literal of the same file.
  files['scripts/r2/session.ts'] = `${js('SET plpgsql.variable_conflict = use_column;')}\n${js(`DO $$DECLARE p ${ONE}; ${viaColumn('p')}$$;`)}`;
  expected.push('scripts/r2/session.ts:2');
  REVIEWED_DO_BLOCKS.push(...reviewed);
  try {
    const found = scanOf('x-service', 'CREATE TABLE task (id text);', '', files);
    assert.equal(reviewed.length, 13);
    assert.doesNotMatch(found.join(), /DDL or SQL in a DO block/);
    const refused = found.filter((p) => /locking subquery/.test(p)).map((p) => p.split(': ')[0]);
    assert.deepEqual(expected.filter((p) => !refused.includes(p)), []);
    assert.deepEqual(refused.filter((p) => !expected.includes(p)), []);
  } finally { REVIEWED_DO_BLOCKS.splice(-reviewed.length); }
});

test('FU-324 opaque inventory is exact, reasoned, and cannot waive readable SQL', () => {
  const path = 'scripts/claim.mjs', source = 'db.$queryRawUnsafe(runtime);';
  // The key is the file, the callee and the digest of the call: not a line (it moves with any edit).
  const key = siteKey(path, '$queryRawUnsafe', source.slice(0, -1));
  assert.match(key, /^scripts\/claim\.mjs:\$queryRawUnsafe:sha256:[0-9a-f]{64}$/);
  const inventory = (entries) => ({ 'scripts/opaque-sql-sinks.json': JSON.stringify(entries) });
  const scan = (text, entries) => scanOf('x-service', 'CREATE TABLE task (id text);', '', {
    [path]: text, ...inventory(entries),
  }).filter((p) => p.includes('FU-324'));
  const entries = { [key]: 'Test adapter, SQL supplied by caller' };
  assert.deepEqual(scan(source, entries), []);
  assert.match(scan(source + '\ndb.query(other);', entries).join(), /unresolved executable SQL/);
  assert.deepEqual(scan('// moved\n\n    db.$queryRawUnsafe(runtime);', entries), []);
  for (const text of ['', 'db.$queryRawUnsafe(runtime, 1);', 'db.$executeRawUnsafe(runtime);', 'db.$queryRawUnsafe("SELECT 1");'])
    assert.match(scan(text, entries).join(), /stale or invalid opaque SQL inventory entry/);
  for (const text of ['db.$queryRawUnsafe(runtime, 1);', 'db.$queryRawUnsafe(other);', 'db.$executeRawUnsafe(runtime);', 'tx.$queryRawUnsafe(runtime);'])
    assert.match(scan(text, entries).join(), /unresolved executable SQL \[scripts\/claim\.mjs:\$\w+:sha256:/, text);
  assert.match(scan(source, { [key]: '' }).join(), /unresolved executable SQL/);
  // The same call, readable now: its entry is stale, it does not stay in use.
  assert.match(scan(`const runtime = 'SELECT 1';\n${source}`, entries).join(), /stale or invalid opaque SQL inventory entry/);
  const bad = 'DELETE FROM task WHERE id IN (SELECT id FROM task FOR UPDATE)';
  assert.match(scan(`db.$queryRawUnsafe(${JSON.stringify(bad)});`, entries).join(), /locking subquery/);
});

// FU-325 part 2: SQL is found where it is executed. A CLI site is read, or it is listed.
test('FU-325 psql arguments are normalized before the SQL word is read', () => {
  const word = (argv) => psqlSql(argv)?.map(({ at, text, file }) => file ?? text ?? argv[at]);
  for (const argv of [['-c', CLAIM], [`-c${CLAIM}`], ['-XqAtc', CLAIM], [`-Xc${CLAIM}`], ['--command', CLAIM],
    [`--command=${CLAIM}`], [`--comm=${CLAIM}`], ['-d', 'db', '-v', 'x=-c', '--dbname=x', '--set', 'a=b', '-c', CLAIM]])
    assert.deepEqual(word(argv), [CLAIM], argv.join(' '));
  assert.deepEqual(word(['-X', '--file=a.sql', '-fb.sql', '-f', '-']), ['a.sql', 'b.sql', '-']);
  assert.deepEqual(word(['-X', 'db', '--', '-c', CLAIM]), []); // standard input
  for (const argv of [['-Q'], [undefined, '-c', 'SELECT 1'], [UNKNOWN_SQL, '-c', 'SELECT 1'], [`--${UNKNOWN_SQL}=x`]])
    assert.equal(psqlSql(argv), null);
});

const claimScan = (files) =>
  scanOf('x-service', 'CREATE TABLE task (id text);', '', files).filter((p) => p.includes('FU-324'));

test('FU-325 every execution site is read by its context: CLI spellings, workflows, JS, seeds', () => {
  const q = JSON.stringify(CLAIM);
  const files = {
    'ops/attached.sh': `psql -c${q}`,
    'ops/long.sh': `psql -X --command=${q}`,
    'ops/cluster.sh': `docker exec -i pg psql -XqAtc ${q}`,
    'ops/nested.sh': `bash -c 'psql --comm=${q}'`,
    'ops/substitution.sh': `n="$(psql -At --command=${q})"`,
    'ops/heredoc.sh': 'psql -X <<SQL\nDELETE FROM task WHERE id IN (SELECT id FROM task LIMIT 1 $LOCK);\nSQL',
    'ops/herestring.sh': `psql <<<${q}`,
    'ops/variable.sh': `psql -v lock='FOR UPDATE' -c 'DELETE FROM task WHERE id IN (SELECT id FROM task LIMIT 1 :lock)'`,
    'ops/file.sh': 'psql -f ops/fixtures/claim.sql',
    // What a CLI is given is executed, whatever its head: a text that does not close is unreadable.
    'ops/unclosed.sh': `psql -c 'SET search_path = (public'`,
    'ops/fixtures/claim.sql': CLAIM,
    '.github/workflows/ci.yml': `jobs:\n  a:\n    steps:\n      - run: |\n          psql --command=${q}\n`,
    'ops/spawn.mjs': `spawnSync('psql', ['-X', ${JSON.stringify(`--command=${CLAIM}`)}]);`,
    'ops/wrapped.mjs': `run('docker', ['exec', 'pg', '/usr/bin/psql', '-Xc', ${q}]);`,
    'ops/command.mjs': `execSync(${JSON.stringify(`psql -X --command=${q}`)});`,
    'services/x-service/prisma/seed.ts': 'db.$executeRawUnsafe(runtimeSql);',
    // What cannot be read is an unresolved site, never an absent one.
    'ops/runtime.sh': 'psql -c "$RUNTIME_SQL"',
    'ops/more.sh': 'psql -c "SELECT 1; $MORE"',
    'ops/gexec.sh': `psql -c "SELECT 'DELETE FROM task' \\\\gexec"`,
    'ops/pipe.sh': 'printf %s "$1" | psql -f -',
    'ops/words.sh': 'psql $ARGS',
    'ops/option.sh': 'psql "$FIRST" -c "SELECT 1"',
    'ops/elsewhere.sh': 'psql -f /tmp/elsewhere.sql',
    'ops/bench.sh': 'pgbench -f probe.sql',
    'ops/runtime.mjs': "spawnSync('psql', ['-c', runtimeSql]);",
    'ops/argv.mjs': "spawnSync('psql', args);",
    'ops/spread.mjs': "spawnSync('psql', ['-d', ...rest, '-c', 'SELECT 1']);",
    'ops/shell.mjs': 'spawn(\'bash\', [\'-c\', `psql -c "${sql}"`]);',
    'ops/name.mjs': "export const TOOL = { psql: 'psql' };",
    'ops/Makefile': 'seed:\n\tpsql -f seed.sql\n',
  };
  const found = claimScan(files);
  for (const path of Object.keys(files).filter((p) => !p.endsWith('.sql')))
    assert.ok(found.some((p) => p.startsWith(path)), `${path}\n${found.join('\n')}`);
});

test('FU-325 readable, proven sites pass; documents and tests are not execution sites', () => {
  const picked = `WITH picked AS MATERIALIZED ${PICKED} DELETE FROM task USING picked WHERE task.id = picked.id;`;
  assert.deepEqual(claimScan({
    'ops/ok.sh': [`psql -X -v ON_ERROR_STOP=1 --username "$U" --dbname "$1" -c 'SELECT 1'`,
      `n="$(psql -X -At -c 'SHOW max_connections')"`, `psql -c "SELECT 1 FROM pg_database WHERE 1 IN (SELECT 1)"`,
      `psql -X <<'SQL'`, '\\set ON_ERROR_STOP on', `\\if :flag`, picked, '\\endif', 'SQL'].join('\n'),
    'ops/fixtures/ok.sql': picked,
    '.github/workflows/ci.yml': `jobs:\n  a:\n    steps:\n      - run: >-\n          psql -U rasta\n          -c 'SELECT 1'\n      - run: psql -f ops/fixtures/ok.sql\n`,
    'ops/ok.mjs': `spawnSync('psql', ['-X', '-d', database, '-c', ${JSON.stringify(picked)}]);`,
    'README.md': 'psql -c "$ANY"',
    'ops/test/run.sh': 'psql -c "$ANY"',
  }), []);
});

test('FU-325 the inventory lists CLI sites as it lists calls: new, stale and readable SQL fail', () => {
  const js = "spawnSync('psql', ['-c', runtimeSql]);";
  const pipe = '# split\nprintf %s "$1" | psql -f -';
  const listed = siteKey('ops/pipe.sh', 'cli', pipe.split('\n')[1]);
  const keys = { [listed]: 'SQL text of the caller', [siteKey('ops/run.mjs', 'psql', js.slice(0, -1))]: 'SQL text of the caller' };
  const scan = (sh, entries = keys) => claimScan({
    'ops/pipe.sh': sh, 'ops/run.mjs': js, 'scripts/opaque-sql-sinks.json': JSON.stringify(entries),
  });
  const stale = new RegExp(`stale or invalid opaque SQL inventory entry: ${listed}`);
  assert.deepEqual(scan(pipe), []);
  // The same command on another line, or spaced differently, is the same site; a changed one is not.
  assert.deepEqual(scan(`\n\n${pipe.replace(' | ', '  |  ')}`), []);
  assert.match(scan(`${pipe}\npsql -c "$2"`).join(), /pipe\.sh:3: FU-324: unresolved executable SQL/);
  assert.match(scan(pipe.replace('$1', '$2')).join(), new RegExp(`pipe\\.sh:2: FU-324: unresolved executable SQL[^]*${stale.source}`));
  assert.match(scan(`#\npsql -c 'SELECT 1'`).join(), stale);
  assert.match(scan(`#\npsql -c ${JSON.stringify(CLAIM)}`).join(), /locking subquery[^]*stale or invalid/);
  // A listed site waives nothing that is readable: the picker before the unread meta-command.
  assert.match(scan(`#\npsql --command=${JSON.stringify(`${CLAIM} \\gexec`)}`).join(), /locking subquery/);
  assert.match(scan(pipe, { ...keys, [listed]: ' ' }).join(), /unresolved executable SQL/);
});

// PR #1109 r1: the site is found by its command word (F1), its input is the one the CLI receives
// (F2) and its SQL is complete (F3; PR #1111 r1 item 1), or the site is unresolved. One file per case.
const UNSAFE = `DELETE FROM task WHERE id IN ${PICKED}`;
const SAFE = `WITH picked(id) AS MATERIALIZED ${PICKED} DELETE FROM task USING picked WHERE task.id = picked.id`;
const workflow = (run, step = '') => `jobs:\n  a:\n    steps:\n      - ${step}run: |\n${run.replace(/^/gm, '          ')}\n`;
const inShells = (files, name, script) => Object.assign(files, {
  [`ops/${name}.sh`]: script, [`ops/${name}.bash`]: script, [`.github/workflows/${name}.yml`]: workflow(script) });
/** Asserts that exactly the files of `refused` have an unresolved site: none of `passing` has any FU-324. */
function assertUnresolved(refused, passing, fixtures = {}) {
  const found = claimScan({ ...fixtures, ...refused, ...passing });
  const unresolved = new Set(found.filter((p) => p.includes('unresolved executable SQL')).map((p) => p.split(':')[0]));
  assert.deepEqual(Object.keys(refused).filter((path) => !unresolved.has(path)), [], 'accepted');
  assert.deepEqual(found.filter((p) => Object.keys(passing).some((path) => p.startsWith(`${path}:`))), []);
}

test('PR #1109 r1 F1: a SQL CLI is found by its command word, whatever follows its name', () => {
  const commands = ['`psql mydb -c "${runtimeSql}"`', '`/usr/bin/psql mydb -c "${runtimeSql}"`', '`"psql" mydb -c "${runtimeSql}"`',
    '`\'psql\' mydb -c "${runtimeSql}"`', `'psql mydb -c "' + runtimeSql + '"'`, `'ps' + 'ql ' + db + ' -c "' + runtimeSql + '"'`,
    '`bash -c \'psql mydb -c "${runtimeSql}"\'`', '`sh -c \'psql mydb -c "${runtimeSql}"\'`', '`true && psql mydb -c "${runtimeSql}"`',
    '`true; psql mydb -c "${runtimeSql}"`', "'cat x.sql | psql mydb'", "'psql mydb'", '`PGPASSWORD=x psql mydb -c "${runtimeSql}"`',
    "'pgbench mydb -f probe.sql'", "'/usr/lib/postgresql/16/bin/pgbench mydb -f probe.sql'", `'"\${PSQL:-psql}" mydb -c "$SQL"'`, `'psql could not be started'`,
    '`psql -d mydb -c "${runtimeSql}"`']; // the last one: the review's control, refused before too
  const refused = {};
  commands.forEach((command, i) => {
    for (const ext of ['js', 'cjs', 'mjs', 'jsx', 'ts', 'cts', 'mts', 'tsx']) refused[`scripts/c${i}.${ext}`] = `execSync(${command});`;
    // Under every root, and not by the call it stands in: held in a constant, handed to a wrapper.
    for (const dir of ['services/x-service/src', 'services/x-service/prisma', 'packages/p/src', 'apps/web/src'])
      refused[`${dir}/c${i}.ts`] = `const held = ${command};\nrun('bash', ['-c', held]);`;
  });
  for (const [i, script] of ['psql mydb -c "$RUNTIME"', '"psql" mydb -c "$RUNTIME"', '/usr/bin/psql mydb -c "$RUNTIME"', 'true && psql mydb -c "$RUNTIME"',
    'cat x.sql | psql mydb', `bash -c 'psql mydb -c "$RUNTIME"'`, `sh -c 'psql mydb -c "$RUNTIME"'`, 'pgbench mydb -f probe.sql',
    '"${PSQL:-psql}" mydb -c "$RUNTIME"', 'node scripts/psql-wrapper.mjs -c "$RUNTIME"', 'psql -c "$SQL"',
    // Another program in front decides what the CLI receives: its words are not read as the CLI's.
    `docker exec pg psql -c 'SELECT 1'`, `xargs -I{} psql -c '{}'`, `bash -c 'psql -c "$X"; exec "$@"' -- psql -c 'SELECT 1'`].entries()) inShells(refused, `s${i}`, script);
  // The program named by a composed text is no argv site of utc-clock-sinks.mjs: it is one here.
  for (const [i, call] of ['execFileSync(`${PG_BIN}/psql`, ["-c", runtimeSql]);', `spawnSync('ps' + 'ql', ['-c', runtimeSql]);`,
    'execFileSync(`${PG_BIN}/pgbench`, ["-f", file]);', `spawnSync(binDir + '/psql', ['-c', 'SELECT 1']);`,
    // Words in front of the name in its argv: that program decides what the CLI receives.
    `spawnSync('xargs', ['-I{}', 'psql', '-c', '{}']);`, `run('docker', ['exec', 'pg', 'psql', '-c', 'SELECT 1']);`,
    `spawnSync('env', ['psql', '-c', 'SELECT 1']);`].entries()) refused[`scripts/n${i}.mjs`] = call;
  const passing = { 'scripts/ok.mjs': `execSync(${JSON.stringify(`psql mydb -c 'SELECT 1'`)});`,
    'scripts/ok-path.ts': `const held = ${JSON.stringify(`/usr/bin/psql mydb -c '${SAFE}'`)};\nrun(held);`,
    'scripts/words.mjs': `export const note = 'postgresql-client provides the SQL shell';` };
  inShells(passing, 'ok', `psql mydb -c 'SELECT 1'\n"psql" -d mydb -c '${SAFE}'`);
  assertUnresolved(refused, passing);
});

test('PR #1109 r1 F2: a file and standard input are read only where they are what the CLI receives', () => {
  const texts = (script, read = (name) => `file ${name}`) => cliSqlSites(script, read).map(({ text }) => text);
  const f = 'psql -f fixtures/claim.sql';
  assert.deepEqual(texts(`${f} --file=b.sql\nPGPASSWORD=x psql -fc.sql\nn="$(psql -f d.sql)"\nif ! psql -f e.sql; then exit 1; fi`),
    ['file d.sql', 'file fixtures/claim.sql', 'file b.sql', 'file c.sql', 'file e.sql']);
  // The directory is not the one this was given: a change of it anywhere in the script, another
  // program in front of the CLI, shell text run by something else, a path that is not a plain relative one.
  for (const script of [`cd ops\n${f}`, `cd ops && ${f}`, `cd "$DIR"\n${f}`, `pushd ops\n${f}\npopd`, `(cd ops && ${f})`, `${f}\ncd ops`,
    `n="$(cd ops && ${f})"`, `cd ops\nn="$(${f})"`, `chroot /mnt ${f}`, `docker exec pg ${f}`, `docker compose exec db ${f}`, `sudo -u postgres ${f}`,
    `env -C ops ${f}`, `source ./lib.sh\n${f}`, `. ./lib.sh\n${f}`, `eval "$MOVE"\n${f}`, 'psql -f /tmp/claim.sql', 'psql --file=/tmp/claim.sql', 'psql -f ~/claim.sql', 'psql -f "$FILE"', 'psql -f "fixtures/$NAME.sql"',
    'psql -f "a b.sql"', 'psql -f fixtures/*.sql'])
    assert.deepEqual(texts(script), [null], script);
  for (const script of [`bash -c 'cd ops && ${f}'`, `cd ops\nbash -c '${f}'`, `bash -c '${f}'`, `ssh host bash <<'EOF'\n${f}\nEOF`])
    assert.deepEqual(texts(script).filter((text) => text !== null), [], script);
  assert.deepEqual(texts(f, null), [null]);
  // Standard input: the command's one `<<<` or `<<`, on descriptor 0, and no other `<` on its lines.
  assert.deepEqual(texts(`psql -X <<< 'SELECT 1'`), ['SELECT 1']);
  assert.deepEqual(texts(`psql -X 2>&1 <<-'SQL' | tee log\nSELECT 2;\nSQL\necho x | psql -f - <<SQL\nSELECT 3;\nSQL`), ['SELECT 2;', 'SELECT 3;']);
  for (const script of [`psql <<< 'SELECT 1' <&3`, `psql <<< 'SELECT 1' 0<&3`, `psql <<< 'SELECT 1' < "$OTHER"`, `psql <<'SQL' < other.sql\nSELECT 1;\nSQL`,
    `psql 3<<< 'SELECT 1'`, `psql 3<<'SQL'\nSELECT 1;\nSQL`, `psql <<< 'SELECT 1' <<SQL\n$RUNTIME\nSQL`, `psql <<SQL <<< 'SELECT 1'\n$RUNTIME\nSQL`,
    `psql <<< "$RUNTIME" <<< 'SELECT 1'`, `psql <<A <<'B'\n$RUNTIME\nA\nSELECT 1;\nB`, 'psql < other.sql', 'psql -f - < other.sql', `psql {fd}<<< 'SELECT 1'`,
    `psql -f <(echo 'SELECT 1')`, `{ psql; } <<< 'SELECT 1'`, 'echo "SELECT 1" | psql', `psql <<< 'SELECT 1' 0>&3`,
    `psql <<'END SQL'\nSELECT 1;\nEND\n${UNSAFE}\nEND SQL`, `psql <<END$x\nSELECT 1;\nEND\n${UNSAFE}\nEND$x`])
    assert.deepEqual(texts(script).filter((text) => text !== null), [], script);
  // The review's trigger, and where a file sets the directory: the root file is not the one executed.
  const fixtures = { 'fixtures/claim.sql': 'SELECT 1', 'ops/fixtures/claim.sql': UNSAFE, 'tmp/claim.sql': 'SELECT 1' };
  const refused = { '.github/workflows/step.yml': workflow(f, 'working-directory: ops\n        '),
    '.github/workflows/defaults.yml': `defaults:\n  run:\n    working-directory: ops\n${workflow(f)}`,
    '.github/workflows/job.yml': workflow(f).replace('    steps:', '    defaults:\n      run:\n        working-directory: ops\n    steps:'),
    '.github/workflows/with.yml': `jobs:\n  a:\n    steps:\n      - uses: x\n        with:\n          script: ${f}\n`,
    '.github/workflows/checkout.yml': workflow(f).replace('      - run', '      - uses: actions/checkout@v4\n        with:\n          path: ops\n      - run'),
    '.github/workflows/alias.yml': `jobs:\n  a:\n    steps:\n      - &step\n        run: ${f}\n  b:\n    defaults: { run: { working-directory: ops } }\n    steps:\n      - *step\n`,
    '.github/workflows/merge.yml': `x: &dir { working-directory: ops }\njobs:\n  a:\n    steps:\n      - <<: *dir\n        run: ${f}\n`,
    'docker-compose.yml': `services:\n  db:\n    command: ${f}\n`, 'ops/values.yaml': workflow(f),
    'scripts/cwd.mjs': `execSync('${f}', { cwd: 'ops' });`, 'scripts/plain.mjs': `execSync('${f}');`, 'scripts/absolute.mjs': `execSync('psql -f /tmp/claim.sql');`,
    'scripts/stdin.mjs': `execSync(${JSON.stringify(`psql <<< 'SELECT 1' <&3`)}, { shell: '/bin/bash' });` };
  inShells(refused, 'cd', `cd ops\n${f}`);
  inShells(refused, 'absolute', 'psql -f /tmp/claim.sql');
  inShells(refused, 'fd', `psql <<< 'SELECT 1' <&3`);
  // A script file runs where its caller stands (`cd ops && bash run.sh`, a package script): only a workflow step starts at the root.
  Object.assign(refused, { 'ops/run.sh': f, 'ops/run.bash': f });
  const passing = { '.github/workflows/file.yml': workflow(f) };
  inShells(passing, 'ok', `psql -X <<'SQL'\nSELECT 1;\nSQL\npsql <<< 'SELECT 1'`);
  assertUnresolved(refused, passing, fixtures);
});

test('PR #1109 r1 F3, PR #1111 r1 item 1: a part this cannot read, anywhere in the executed text, leaves the site unresolved', () => {
  const U = UNKNOWN_SQL;
  for (const text of [`DELETE FROM task ${U}`, `EXPLAIN ${U}`, `DELETE FROM task WHERE id = ${U}`, `SELECT ${U} FROM task`, `DO $$BEGIN ${U}; END$$`,
    `DO 'BEGIN ${U}; END'`, `SELECT 1 FROM pg_database WHERE datname = '${U}'`, 'DELETE FROM task WHERE id = :picker', `DELETE FROM task WHERE id = :'picker'`,
    'DELETE FROM :"table"', '\\set q :input\n:q', '\\echo start\n:statement', '\\if :flag\n:statement\n\\endif', 'SELECT 1; \\echo next\n:statement',
    `SELECT 'DELETE FROM task' AS q\n\\gexec`, `\\echo -- \\\\ ${UNSAFE};`, '\\i other.sql', '\\copy task FROM stdin', '\\echo a \\\\ SELECT 1', '\\', U])
    assert.equal(psqlText(text).whole, false, text);
  // A meta-command is its line, not SQL: its words (a quote, a variable) are not read as a statement.
  assert.deepEqual(psqlText(`\\set ON_ERROR_STOP on\n\\if :flag\nSELECT 1; \\echo it's :done\n\\endif\nSELECT id::text, tags[1:2], ':x', $$ :y \\z $$ FROM task -- :c`),
    { sql: `\n\nSELECT 1; \n\nSELECT id::text, tags[1:2], ':x', $$ :y \\z $$ FROM task  `, whole: true });
  // What is readable is still checked: before the part that is not, and under a meta-command that is not read.
  assert.equal(claimSubqueryProblems(psqlText(`${UNSAFE} \\gexec`).sql).length, 1);
  assert.equal(claimSubqueryProblems(psqlText(`\\echo a\n${UNSAFE}; SELECT :x`).sql).length, 1);
  // A comment mark in a meta-command is one of its words: it hides nothing of the lines after it.
  assert.equal(claimSubqueryProblems(psqlText(`\\echo /*\n${UNSAFE};\n-- */`).sql).length, 1);
  const refused = {};
  for (const [i, script] of ['psql -c "DELETE FROM task $WHERE"', 'psql -c "EXPLAIN $SQL"', 'psql -c "DELETE FROM task WHERE id = $picker"',
    'psql -c "DELETE FROM task WHERE id = ${picker}"', 'psql -c "SELECT $expr FROM task"', 'psql -c "DO \\$\\$BEGIN ${statement}; END\\$\\$"',
    'psql -c "CREATE FUNCTION f() RETURNS void LANGUAGE sql AS \\$\\$ $body \\$\\$"', `psql -c "SELECT 1 FROM pg_database WHERE datname = '$1'"`,
    `psql -c "ALTER DATABASE \\"$1\\" SET app.flag = 'true'"`, `psql <<'SQL'\nDELETE FROM task WHERE id = :picker;\nSQL`,
    `psql <<'SQL'\n\\set q :input\n:q\nSQL`, `psql <<'SQL'\n\\echo start\n:statement\nSQL`, `psql <<'SQL'\n\\if :flag\n:statement\n\\endif\nSQL`,
    `psql <<'SQL'\nSELECT 1; \\echo next\n:statement\nSQL`, 'psql <<SQL\nDELETE FROM task WHERE id = $picker;\nSQL', 'psql <<< "DELETE FROM task $WHERE"',
    'psql -f fixtures/set.sql', 'psql -c "$SQL"'].entries()) inShells(refused, `f${i}`, script);
  for (const [i, call] of ['execSync(`psql -c "DELETE FROM task ${where}"`);', 'execSync(`psql mydb -c "DELETE FROM task WHERE id = ${picker}"`);',
    'execSync(`psql -c "EXPLAIN ${sql}"`);', 'execSync(`psql -c \'DO $$BEGIN ${statement}; END$$\'`);', 'execSync(`psql -c "${sql}"`);',
    `spawnSync('psql', ['-c', 'DELETE FROM task WHERE id = :picker']);`, `spawnSync('psql', ['-c', ${JSON.stringify('\\echo a\n:statement')}]);`,
    `spawnSync('psql', ['-c', runtimeSql]);`].entries()) refused[`scripts/f${i}.mjs`] = call;
  // What reads the YAML puts text in before any shell: a workflow expression inside quotes, any other reader anywhere.
  for (const [i, run] of ["psql -c 'DELETE FROM task WHERE id IN ${{ inputs.picker }}'", "psql <<'SQL'\nDELETE FROM task WHERE id IN ${{ inputs.picker }};\nSQL",
    "psql <<< 'DELETE FROM task ${{ inputs.tail }}'", "psql -c 'SELECT 1' '${{ inputs.more }}'"].entries()) refused[`.github/workflows/e${i}.yml`] = workflow(run);
  refused['docker-compose.yml'] = "services:\n  db:\n    command: psql -c 'DELETE FROM task WHERE id IN ${PICKER}'\n";
  refused['chart/templates/job.yaml'] = "spec:\n  command: psql -c 'DELETE FROM task WHERE id IN {{ .Values.picker }}'\n";
  const passing = { 'scripts/ok.mjs': `spawnSync('psql', ['-X', '-d', database, '-c', ${JSON.stringify(SAFE)}]);` };
  inShells(passing, 'ok', `psql -d mydb -c '${SAFE}'\npsql -X <<'SQL'\n\\set ON_ERROR_STOP on\n\\if :flag\n${SAFE};\n\\endif\n\\echo done :rows\nSQL`);
  assertUnresolved(refused, passing, { 'fixtures/set.sql': '\\set q :input\n:q\n' });
  // A listed here-document is listed with its text: another text is another site.
  const doc = 'psql <<SQL\nDELETE FROM task WHERE id = $picker;\nSQL';
  const listed = { 'scripts/opaque-sql-sinks.json': JSON.stringify({ [siteKey('ops/doc.sh', 'cli', doc)]: 'Row id of the caller' }) };
  assert.deepEqual(claimScan({ 'ops/doc.sh': `# moved\n${doc}`, ...listed }), []);
  assert.match(claimScan({ 'ops/doc.sh': doc.replace('id =', 'id <>'), ...listed }).join(), /unresolved executable SQL[^]*stale or invalid/);
});

test('FU-333 a CTE column list is read as PostgreSQL reads it: the picker passes with it, a malformed list refuses', () => {
  const claim = (head) => `${head} AS MATERIALIZED ${PICKED} DELETE FROM task USING picked WHERE task.id = picked.id`;
  for (const head of ['WITH picked', 'WITH picked(id)', 'WITH picked (id)', 'with picked /* list */ ( id , "other col" )',
    'WITH RECURSIVE picked(id)', 'WITH a(x, y) AS (SELECT 1, 2), picked(id)', 'WITH a AS (SELECT 1), "Picked"("ID")']) {
    assert.deepEqual(claimSubqueryProblems(claim(head)), [], head);
    assert.deepEqual(claimSubqueryProblems(claim(head).replace(' MATERIALIZED', '')), [], head);
  }
  for (const head of ['WITH picked()', 'WITH picked(id,)', 'WITH picked(,id)', 'WITH picked(id other)', 'WITH picked((id))',
    'WITH picked(id.x)', 'WITH picked(1)', "WITH picked('id')", 'WITH picked(id)(id)', 'WITH (id)', 'WITH picked(id) x',
    'WITH picked(id = 1)', 'WITH picked(SELECT 1)', 'SELECT picked(id)', 'WITH a AS (SELECT 1) SELECT picked(id)', 'WITH 1(id)'])
    assert.equal(claimSubqueryProblems(claim(head)).length, 1, head);
  // A piece of a text (its `(` is not in it) is no list either.
  assert.equal(claimSubqueryProblems(claim('WITH picked x id)'), new Set(), false).length, 1);
  // The list changes nothing else: a picker in the membership test stays refused, and the head of
  // a statement is its head with or without the list (the literal is read as executed: `(1`).
  assert.equal(claimSubqueryProblems(`WITH picked(id) AS (SELECT 1) DELETE FROM task WHERE id IN ${PICKED}`).length, 1);
  const heads = ['WITH a', 'WITH a(n)', 'WITH RECURSIVE a(n, m)', 'WITH a(n,)'];
  const found = claimScan(Object.fromEntries(heads.map((head, i) =>
    [`ops/head${i}.mjs`, `export const sql = ${JSON.stringify(`${head} AS (SELECT 1) SELECT (1`)};`])));
  assert.deepEqual(found.map((p) => p.split(':')[0]), ['ops/head0.mjs', 'ops/head1.mjs', 'ops/head2.mjs']);
});

// FU-337, the execution boundary: SQL that a text builds and runs is one complete text of literals
// and proven constants, or its site is refused unless the inventory lists it (file + digest + reason).
const PIECES = ['EXPLAIN DELETE FROM task WHERE id = (SEL', 'ECT id FROM task LIMIT 1 F', 'OR UPDATE SKIP LOCKED) AND 1 = 1'];
const sqlString = (text) => `'${text.replaceAll("'", "''")}'`;
const dynamicSite = (problems) => problems.filter((p) => /^FU-337: .* \[EXECUTE:sha256:[0-9a-f]{64}\]$/s.test(p));
const runs = (expression, declare = '') => `DO $do$${declare}BEGIN EXECUTE ${expression}; END$do$;`;
const boundaryScan = (files, migrations = 'CREATE TABLE task (id text);') =>
  scanOf('x-service', migrations, '', files).filter((p) => /FU-3(?:24|37)/.test(p));

test('FU-337 PR #1082 r2 N2: the three pieces joined through a form the reader does not follow are refused at the site', () => {
  const [a, b, c] = PIECES.map(sqlString);
  const constants = (init) => `DECLARE a CONSTANT text ${init} ${a}; b CONSTANT text ${init} ${b}; c CONSTANT text ${init} ${c}; `;
  const refused = {
    concat: runs(`concat(${a}, ${b}, ${c})`),
    format: runs(`format('%s%s%s', ${a}, ${b}, ${c})`),
    'format, a piece in the format': runs(`format(${a} || '%s' || ${c}, ${b})`),
    "typed text '…'": runs(`text ${a} || text ${b} || text ${c}`),
    'text(…)': runs(`text(${a}) || text(${b}) || text(${c})`),
    '::varchar(1000)': runs(`${a}::varchar(1000) || ${b}::varchar(1000) || ${c}::varchar(1000)`),
    '::"text"': runs(`${a}::"text" || ${b}::"text" || ${c}::"text"`),
    'constants, DEFAULT': runs('a || b || c', constants('DEFAULT')),
    'constants, =': runs('a || b || c', constants('=')),
    'two constants, DEFAULT': runs('a || b', `DECLARE a CONSTANT text DEFAULT ${sqlString(PIECES[0] + PIECES[1])}; b CONSTANT text DEFAULT ${c}; `),
    variables: runs('a || b || c', `DECLARE a text := ${a}; b text := ${b}; c text := ${c}; `),
    'a parameter': `CREATE FUNCTION f(p text) RETURNS void LANGUAGE plpgsql AS $$BEGIN EXECUTE ${a} || p; END$$;`,
    'a constant of a nested block': `DO $$BEGIN DECLARE a CONSTANT text := ${a}; BEGIN EXECUTE a || ${b} || ${c}; END; END$$;`,
    concat_ws: runs(`concat_ws('', ${a}, ${b}, ${c})`),
    array_to_string: runs(`array_to_string(ARRAY[${a}, ${b}, ${c}], '')`),
    'a subquery': runs(`(SELECT string_agg(x, '') FROM unnest(ARRAY[${a}, ${b}, ${c}]) x)`),
    replace: runs(`replace(${a} || 'X' || ${c}, 'X', ${b})`),
    CASE: runs(`${a} || CASE WHEN true THEN ${b} END || ${c}`),
    quote_literal: runs(`${a} || quote_literal(x) || ${c}`),
    quote_ident: runs(`'ALTER ROLE ' || quote_ident(x) || ' NOLOGIN'`),
    '::bpchar': runs(`${a}::bpchar || ${b} || ${c}`),
    'a call of the whole': runs(`lower(${a} || ${b} || ${c})`),
    'a text after the expression': runs(`${a} || ${b} ${c}.x`),
    'nothing after EXECUTE': runs(''),
  };
  for (const [name, sql] of Object.entries(refused)) assert.equal(dynamicSite(claimSubqueryProblems(sql)).length, 1, name);
  // The expression ends where the statement does, not at a word inside its parentheses.
  const joined = (tail) => dynamicSite(claimSubqueryProblems(runs(`format('%s%s', (SELECT string_agg(x, '') FROM a JOIN b USING (id)), ${tail})`)));
  assert.notDeepEqual(joined(a), joined(b));
  // What the reader composes is one text, read as executed: the picker in it is the FU-324 refusal.
  for (const sql of [runs(`${a} || ${b} || ${c}`), runs('a || b || c', constants(':=')), runs(`CAST((${a})::text || ${b} AS text) || (${c} COLLATE "C")`)])
    assert.deepEqual(claimSubqueryProblems(sql).map((p) => p.slice(0, 6)), ['FU-324'], sql);
  // A text that is only executed as a whole is strict there, whatever its head: `(1` is unclosed.
  assert.deepEqual(claimSubqueryProblems(runs(`'SET x = ' || '(1'`)).map((p) => p.slice(0, 6)), ['FU-324']);
  const picked = `WITH picked AS MATERIALIZED ${PICKED} DELETE FROM task USING picked WHERE task.id = picked.id`;
  const accepted = [
    runs(sqlString('ALTER TABLE task DISABLE TRIGGER t')), runs(`'ALTER TABLE task ' || 'DISABLE' || ' TRIGGER t'`),
    runs(`CAST(('ALTER TABLE task ')::text || U&'DISABLE' AS text) || (' TRIGGER t' COLLATE "C")`),
    runs(`${sqlString(picked.slice(0, 40))} || ${sqlString(picked.slice(40))}`), runs(`E'SELECT \\'x\\''`), runs('$q$SELECT 1$q$ INTO n'),
    runs(`'SELECT count(*) FROM (' || pending || ') p' INTO n`, `DECLARE pending CONSTANT text := 'SELECT 1'; n int; `),
    // A proven constant that starts the expression is an operand too (it follows EXECUTE).
    runs(`pending || ' LIMIT 1' INTO n; EXECUTE pending`, `DECLARE pending CONSTANT text := 'SELECT 1'; n int; `),
    runs(`'DELETE FROM task WHERE id = $1' USING some.id`),
  ];
  for (const sql of accepted) assert.deepEqual(claimSubqueryProblems(sql), [], sql);
});

test('FU-337 EXECUTE is a site wherever PL/pgSQL runs it, and nowhere else', () => {
  const built = `concat('SELECT ', '1')`;
  const sites = [
    `DO $$BEGIN EXECUTE ${built}; END$$;`, `do $$begin execute /* c */ ${built}; end$$;`, `DO $$BEGIN NULL; EXECUTE ${built}; END$$;`,
    `DO $$BEGIN IF true THEN EXECUTE ${built}; ELSE NULL; END IF; END$$;`, `DO $$BEGIN IF true THEN NULL; ELSE EXECUTE ${built}; END IF; END$$;`,
    `DO $$BEGIN LOOP EXECUTE ${built}; END LOOP; END$$;`,
    `DO $$BEGIN <<l>> EXECUTE ${built}; END$$;`, `DO $$BEGIN NULL; EXCEPTION WHEN others THEN EXECUTE ${built}; END$$;`,
    `CREATE FUNCTION f() RETURNS SETOF int LANGUAGE plpgsql AS $$BEGIN RETURN QUERY EXECUTE ${built}; END$$;`,
    `DO $$DECLARE r record; BEGIN FOR r IN EXECUTE ${built} LOOP NULL; END LOOP; END$$;`,
    `DO $$DECLARE k refcursor; BEGIN OPEN k FOR EXECUTE ${built}; END$$;`,
    `DO $$BEGIN EXECUTE ${built} USING 1; END$$;`, `DO $$DECLARE n int; BEGIN EXECUTE ${built} INTO n; END$$;`,
    `DO 'BEGIN EXECUTE concat(''SELECT '', ''1''); END';`, `DO $a$BEGIN EXECUTE $b$DO $c$BEGIN EXECUTE ${built}; END$c$$b$; END$a$;`,
    // A piece: the statement may start where the text does, or after a part that is not in it.
    `EXECUTE ${built}`, `EXECUTE ${built} INTO n; END`, `\uE0000\uE001 EXECUTE ${built};`,
    // A prepared statement is run by name, and these functions execute their argument.
    `PREPARE p AS SELECT 1; EXECUTE p;`, `SELECT query_to_xml(${built}, true, false, '');`, `SELECT ts_stat('SELECT 1');`,
    `SELECT "query_to_xmlschema"('SELECT 1', true, false, '');`,
  ];
  for (const sql of sites) assert.ok(dynamicSite(claimSubqueryProblems(sql)).length >= 1, sql);
  for (const sql of sites.slice(0, 13)) assert.deepEqual(claimSubqueryProblems(sql.replaceAll(built, `'SELECT ' || '1'`)), [], sql);
  const none = [
    'GRANT EXECUTE ON FUNCTION f() TO r; REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION f() FROM r;',
    'ALTER DEFAULT PRIVILEGES FOR ROLE m REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;',
    'CREATE TRIGGER t BEFORE INSERT ON task FOR EACH ROW EXECUTE FUNCTION f(); CREATE TRIGGER u AFTER UPDATE ON task FOR EACH ROW WHEN (true) EXECUTE PROCEDURE f();',
    `SELECT has_function_privilege('r', 'f()', 'EXECUTE'), privilege_type = 'EXECUTE', ARRAY['SELECT', 'execute'] FROM x;`,
    'SELECT id, execute FROM job; SELECT j.execute FROM job j;',
    `SELECT 'they must execute the plan first', 'we execute (a, b) later';`,
    `SELECT concat('SELECT ', '1');`,
  ];
  for (const sql of none) assert.deepEqual(claimSubqueryProblems(sql), [], sql);
});

test('FU-337 the boundary holds in every file that runs SQL; the inventory lists a site by file and digest; a migration is outside', () => {
  const body = (expression) => `DO $$BEGIN EXECUTE ${expression}; END$$;`;
  const built = body(`format('ALTER ROLE %I NOLOGIN', r)`);
  const files = {
    'ops/built.sql': built,
    'ops/heredoc.sh': `psql -X <<'SQL'\n${built}\nSQL`,
    'ops/expanded.sh': `psql -X <<SQL\n${body("'ALTER ROLE $ROLE NOLOGIN'").replaceAll('$$', '\\$\\$')}\nSQL`,
    'ops/word.sh': `run_sql "$db" "${built.replaceAll('$$', '\\$\\$')}"`,
    // An expansion is a part that is not in the text: in a word, in a here-document written to a file.
    'ops/word-expansion.sh': `run_sql "$db" "${body("'ALTER ROLE $ROLE NOLOGIN'").replaceAll('$$', '\\$\\$')}"`,
    'ops/written.sh': `cat > /tmp/roles.sql <<SQL\n${body("'ALTER ROLE $ROLE NOLOGIN'").replaceAll('$$', '\\$\\$')}\nSQL`,
    'ops/option-expansion.sh': `psql -X -c "${body("'ALTER ROLE $ROLE NOLOGIN'").replaceAll('$$', '\\$do\\$')}"`,
    'ops/option.sh': `psql -X -c ${JSON.stringify(built.replaceAll('$$', '$do$')).replaceAll('$', '\\$')}`,
    '.github/workflows/ci.yml': `jobs:\n  a:\n    steps:\n      - run: |\n          psql -X <<'SQL'\n          ${built}\n          SQL\n`,
    'ops/literal.mjs': `export const sql = ${JSON.stringify(built)};`,
    'ops/template.mjs': `export const toggle = (action) => \`${body("'ALTER TABLE task ${action} TRIGGER t'")}\`;`,
    'services/x-service/prisma/seed.ts': `db.$executeRawUnsafe(${JSON.stringify(built)});`,
    'scripts/run.mjs': `db.$executeRawUnsafe(${JSON.stringify(built)});`,
    // Only the call has the whole text: no literal of the file holds the word.
    'scripts/split.mjs': `const a = 'SET x = 1; EXEC', b = "UTE format('ALTER ROLE %I NOLOGIN', r)";\ndb.$executeRawUnsafe(a + b);`,
  };
  const found = boundaryScan(files, [['1_init', 'CREATE TABLE task (id text);'], ['2_roles', built]]);
  const key = (problem) => /\[(.*:EXECUTE:sha256:[0-9a-f]{64})\]$/.exec(problem)?.[1];
  for (const path of Object.keys(files)) assert.ok(found.some((p) => p.startsWith(`${path}:`) && key(p)?.startsWith(`${path}:EXECUTE:`)), `${path}\n${found.join('\n')}`);
  // Every problem is one of these sites, or (#1109 r1 F3) the CLI site of a text with a shell
  // expansion in it; the migration's DO block is its own review, not this rule's.
  const listable = (problem) => /\[(.*:sha256:[0-9a-f]{64})\]$/.exec(problem)?.[1];
  assert.deepEqual(found.filter((p) => !key(p)).map((p) => listable(p).split(':sha256:')[0]).sort(), ['ops/expanded.sh:cli', 'ops/option-expansion.sh:cli']);
  assert.ok(!found.some((p) => p.includes('prisma/migrations')));
  // Listed with a reason: nothing is left. The key is the file and the digest of the expression.
  const inventory = (entries) => ({ 'scripts/opaque-sql-sinks.json': JSON.stringify(entries) });
  const reasons = Object.fromEntries([...new Set(found.map(listable))].map((k) => [k, 'role names from the catalogue, sqlString by %I']));
  assert.deepEqual(boundaryScan({ ...files, ...inventory(reasons) }), []);
  const one = { 'ops/built.sql': built };
  const listed = key(boundaryScan(one)[0]);
  assert.deepEqual(boundaryScan({ ...one, ...inventory({ [listed]: 'reviewed' }) }), []);
  // The same expression elsewhere in the file, on other lines, spaced differently, is the same site.
  assert.deepEqual(boundaryScan({ 'ops/built.sql': `SELECT 1;\n\n${built.replace("format('", "format\n  ( '")}\n${built}`, ...inventory({ [listed]: 'reviewed' }) }), []);
  const stale = /stale or invalid opaque SQL inventory entry/;
  for (const [what, text] of Object.entries({
    'another expression': built.replace('NOLOGIN', 'LOGIN'), 'another argument': built.replace(', r)', ', s)'),
    'the same expression in another file': null, 'a reason of spaces': built,
  })) {
    const scan = boundaryScan({ [text === null ? 'ops/other.sql' : 'ops/built.sql']: text ?? built, ...inventory({ [listed]: what === 'a reason of spaces' ? ' ' : 'reviewed' }) });
    assert.equal(scan.filter(key).length, 1, what);
    assert.ok(scan.some((p) => stale.test(p)), what);
  }
  // Composed now, or gone: the entry is stale. A listed site waives nothing that is readable.
  assert.match(boundaryScan({ 'ops/built.sql': body("'ALTER ROLE r NOLOGIN'"), ...inventory({ [listed]: 'reviewed' }) }).join(), stale);
  const beside = boundaryScan({ 'ops/built.sql': `${built}\n${CLAIM};`, ...inventory({ [listed]: 'reviewed' }) });
  assert.deepEqual(beside.map((p) => p.split(': ')[1]), ['FU-324']);
  // A part that is not in the text keeps its identity: another hole is another expression.
  const hole = (name) => boundaryScan({ 'ops/template.mjs': files['ops/template.mjs'].replaceAll('action', name) }).map(key);
  assert.notDeepEqual(hole('action'), hole('other'));
  const expansion = (name) => boundaryScan({ 'ops/expanded.sh': files['ops/expanded.sh'].replace('$ROLE', name) }).map(key).filter(Boolean);
  assert.notDeepEqual(expansion('$ROLE'), expansion('$OTHER'));
  // Read as the shell's text and as psql's (a here-document, a -c word): one site, one key.
  assert.equal(new Set(expansion('$ROLE')).size, 1);
  assert.equal(new Set(found.filter((p) => p.startsWith('ops/option-expansion.sh:')).map(key).filter(Boolean)).size, 1);
});

test('FU-337 no cut of a picker passes through a join the reader does not follow', () => {
  const picker = PIECES.join('');
  const forms = [
    (a, b, c) => `concat(${a}, ${b}, ${c})`, (a, b, c) => `format('%s%s%s', ${a}, ${b}, ${c})`,
    (a, b, c) => `text ${a} || text ${b} || text ${c}`, (a, b, c) => `${a}::varchar(1000) || ${b} || ${c}::"text"`,
    (a, b, c) => `${a} || v || ${b} || ${c}`,
  ];
  let passed = 0, total = 0;
  for (let i = 1; i < picker.length; i += 3) for (let j = i + 1; j < picker.length; j += 3) for (const form of forms) {
    total += 1;
    if (claimSubqueryProblems(runs(form(...[picker.slice(0, i), picker.slice(i, j), picker.slice(j)].map(sqlString)))).length === 0) passed += 1;
  }
  assert.ok(total > 2000);
  assert.equal(passed, 0);
});
