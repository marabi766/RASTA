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
  ['a string', `SELECT 'now()' FROM task WHERE lease_until IS NULL`],
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
    /DDL in a DO block/,
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
    /DDL in a DO block/,
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
    /DDL in a DO block/,
  );
});

test('the repository passes', () => {
  assert.deepEqual(utcClockProblems(REPOSITORY), []);
});
