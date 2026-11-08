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
  utcClockProblems,
} from './utc-clock-sites-lib.mjs';
import { lex } from './eligibility-clock-sql.mjs';
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
    assert.match(problemsIn(body, scope).join(), /R3/, body);
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
function scanOf(service, migration, source = '') {
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
    write(`services/${service}/src/temporal/saga-start.store.ts`, source);
    execFileSync('git', ['init', '-q'], { cwd: root, env: fixtureGitEnv() });
    execFileSync('git', ['add', '-A'], { cwd: root, env: fixtureGitEnv() });
    // The reviewed entries name this repository's sites, which that one does not have.
    return utcClockProblems(root).filter((problem) => !problem.startsWith('stale reviewed entry'));
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

test('the repository passes', () => {
  assert.deepEqual(utcClockProblems(REPOSITORY), []);
});
