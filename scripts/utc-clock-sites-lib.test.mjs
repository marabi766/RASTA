// pnpm test:utc-clock-sites: the guard refuses each way a clock can reach a timestamp(3)
// column in the session's zone, and the tree as it stands passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  localVariableProblems,
  problemsIn,
  replayMigrations,
  utcClockProblems,
} from './utc-clock-sites-lib.mjs';

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
  assert.deepEqual([...functions.keys()], ['kept']);
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
]) {
  test(`allowed: ${name}`, () => {
    assert.deepEqual(problemsIn(sql, scope), []);
  });
}

test('R4: a timestamp variable beside a bare clock is refused, a timestamptz one is not', () => {
  const body = (type) =>
    `DECLARE opens ${type}; BEGIN IF clock_timestamp() < opens THEN RETURN NEW; END IF; END`;
  assert.equal(localVariableProblems(body('timestamp(3)')).length, 1);
  assert.equal(localVariableProblems(body('timestamp')).length, 1);
  assert.equal(localVariableProblems(body('timestamp without time zone')).length, 1);
  assert.deepEqual(localVariableProblems(body('timestamptz(3)')), []);
  assert.deepEqual(localVariableProblems(body('timestamp with time zone')), []);
});

test('a trigger assigning a bare clock names no table, and is still refused', () => {
  assert.notEqual(problemsIn(`BEGIN NEW."due_at" := now(); RETURN NEW; END`, scope).length, 0);
});

test('the repository passes', () => {
  assert.deepEqual(utcClockProblems(resolve(dirname(fileURLToPath(import.meta.url)), '..')), []);
});
