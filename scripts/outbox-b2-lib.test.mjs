// -----------------------------------------------------------------------------
// ADR-051 Phase B2 — the fail-closed tests.
//
// Everything here is pure: option parsing, the environment interlock, the URL
// resolution, and the shape of the SQL the tool will send. No database, so it
// runs in `pnpm verify` on any machine.
//
// The correctness of the backfill itself is not testable here and is not
// tested here — `outbox-b2-backfill.pg.test.mjs` runs the same SQL against a
// real PostgreSQL. What these tests cover is the half that has to hold before
// a single row is touched: that the tool refuses rather than guesses.
// -----------------------------------------------------------------------------
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ALLOWED_ENVIRONMENTS,
  B2RefusalError,
  MAX_BATCH_SIZE,
  SERVICES,
  assertEnvironment,
  assignBatchSql,
  b1PreconditionSql,
  counterUpsertSql,
  databaseUrlKey,
  headMaintenanceSql,
  parseOptions,
  planSql,
  resolveDatabaseUrl,
  runServiceBackfill,
  vacuumFactsSql,
  vacuumSql,
  verifySql,
} from './outbox-b2-lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

const refusal = (fn) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof B2RefusalError, `expected a refusal, got ${error}`);
    return error.message;
  }
  assert.fail('expected a refusal, the call succeeded');
};

// ---------------------------------------------------------------------------
// Target selection — the flag that stops a keystroke from touching eight
// databases.
// ---------------------------------------------------------------------------

test('a run with no target is refused', () => {
  const message = refusal(() => parseOptions([], {}));
  assert.match(message, /No target selected/);
  for (const service of SERVICES) assert.match(message, new RegExp(service));
});

test('an unknown service is refused rather than skipped', () => {
  assert.match(
    refusal(() => parseOptions(['--service', 'supplier'], {})),
    /Unknown service/,
  );
  assert.match(
    refusal(() => parseOptions(['--service', 'Document'], {})),
    /Unknown service/,
  );
});

test('--all selects exactly the eight B1 databases', () => {
  assert.deepEqual(parseOptions(['--all'], {}).services, SERVICES);
});

test('--all and --service contradict each other', () => {
  assert.match(
    refusal(() => parseOptions(['--all', '--service', 'document'], {})),
    /contradict/,
  );
});

test('naming one service twice is refused, so a batch is never counted twice', () => {
  assert.match(
    refusal(() => parseOptions(['--service', 'document', '--service', 'document'], {})),
    /more than once/,
  );
});

test('--service is repeatable', () => {
  const options = parseOptions(['--service', 'document', '--service', 'economic'], {});
  assert.deepEqual(options.services, ['document', 'economic']);
});

// ---------------------------------------------------------------------------
// Writing is opt-in.
// ---------------------------------------------------------------------------

test('a run without --apply is a plan', () => {
  assert.equal(parseOptions(['--service', 'document'], {}).apply, false);
  assert.equal(parseOptions(['--service', 'document', '--dry-run'], {}).apply, false);
});

test('--apply is the only thing that turns writing on', () => {
  assert.equal(parseOptions(['--service', 'document', '--apply'], {}).apply, true);
});

test('--dry-run and --apply together are refused rather than resolved', () => {
  assert.match(
    refusal(() => parseOptions(['--service', 'document', '--dry-run', '--apply'], {})),
    /contradict/,
  );
});

// ---------------------------------------------------------------------------
// Batch bounds — the ADR-051 § B2 ceiling is enforced, not documented.
// ---------------------------------------------------------------------------

test('the batch size defaults to the ADR ceiling', () => {
  assert.equal(parseOptions(['--service', 'document'], {}).batchSize, MAX_BATCH_SIZE);
  assert.equal(MAX_BATCH_SIZE, 5000);
});

test('a batch size above the ceiling is refused', () => {
  assert.match(
    refusal(() => parseOptions(['--service', 'document', '--batch-size', '5001'], {})),
    /exceeds the ADR-051 § B2 ceiling of 5000/,
  );
});

test('a batch size that is not a positive integer is refused', () => {
  for (const bad of ['0', '-1', '1.5', 'many', '', '1e3']) {
    assert.match(
      refusal(() => parseOptions(['--service', 'document', '--batch-size', bad], {})),
      /must be a positive integer/,
      `--batch-size ${JSON.stringify(bad)} was accepted`,
    );
  }
});

test('--max-batches takes the positive integer rule', () => {
  assert.match(
    refusal(() => parseOptions(['--service', 'document', '--max-batches', '0'], {})),
    /must be a positive integer/,
  );
  assert.equal(parseOptions(['--service', 'document', '--max-batches', '3'], {}).maxBatches, 3);
});

test('--vacuum-every is refused by name, pointing at the maintenance command (D-045)', () => {
  const reason = refusal(() => parseOptions(['--service', 'document', '--vacuum-every', '2'], {}));
  assert.match(reason, /--vacuum-every was removed/);
  assert.match(reason, /runtime role/);
  assert.match(reason, /scripts\/outbox-b2-vacuum\.mjs/);
});

test('an unbounded run has no batch limit', () => {
  assert.equal(parseOptions(['--service', 'document'], {}).maxBatches, Infinity);
});

test('an option missing its value is refused rather than reading the next flag', () => {
  assert.match(
    refusal(() => parseOptions(['--service', 'document', '--batch-size', '--apply'], {})),
    /needs a value/,
  );
});

test('an unknown option is refused and the known ones are named', () => {
  const message = refusal(() => parseOptions(['--service', 'document', '--force'], {}));
  assert.match(message, /Unknown option "--force"/);
  assert.match(message, /--apply/);
});

// ---------------------------------------------------------------------------
// Environment — production is refused, and so is anything unrecognised.
// ---------------------------------------------------------------------------

test('NODE_ENV=production is refused', () => {
  const message = refusal(() => assertEnvironment({ NODE_ENV: 'production' }));
  assert.match(message, /Refusing to run with NODE_ENV=production/);
  assert.match(
    refusal(() => parseOptions(['--service', 'document', '--apply'], { NODE_ENV: 'production' })),
    /NODE_ENV=production/,
  );
});

test('an unrecognised NODE_ENV is refused rather than assumed safe', () => {
  for (const bad of ['staging', 'prod', 'Production', 'live']) {
    assert.match(
      refusal(() => assertEnvironment({ NODE_ENV: bad })),
      /unrecognised NODE_ENV/,
      `NODE_ENV=${bad} was accepted`,
    );
  }
});

test('an unset NODE_ENV means development', () => {
  assert.equal(assertEnvironment({}), 'development');
  assert.equal(assertEnvironment({ NODE_ENV: '' }), 'development');
  for (const env of ALLOWED_ENVIRONMENTS) assert.equal(assertEnvironment({ NODE_ENV: env }), env);
});

// ---------------------------------------------------------------------------
// Connection resolution — one service, one database (A-01).
// ---------------------------------------------------------------------------

test('each service resolves through its own DATABASE_URL_<SERVICE>', () => {
  for (const service of SERVICES) {
    assert.equal(databaseUrlKey(service), `DATABASE_URL_${service.toUpperCase()}`);
  }
});

test('a shared DATABASE_URL is never a fallback', () => {
  const message = refusal(() =>
    resolveDatabaseUrl('document', { DATABASE_URL: 'postgresql://shared/everything' }),
  );
  assert.match(message, /DATABASE_URL_DOCUMENT is not set/);
  assert.match(message, /never through a shared DATABASE_URL/);
});

test('the refusal names the variable and not its value', () => {
  const message = refusal(() => resolveDatabaseUrl('economic', {}));
  assert.doesNotMatch(message, /postgresql:/);
  assert.match(message, /DATABASE_URL_ECONOMIC/);
});

test('a resolved URL is returned unchanged', () => {
  const url = 'postgresql://u:p@localhost:5433/rasta_document?schema=public';
  assert.equal(resolveDatabaseUrl('document', { DATABASE_URL_DOCUMENT: url }), url);
});

// ---------------------------------------------------------------------------
// The SQL says what the ADR says.
//
// These are shape assertions, not correctness ones — correctness is proved
// against a real database. What they catch is the SQL quietly drifting away
// from the four properties B2 is allowed to have.
// ---------------------------------------------------------------------------

test('the batch selects only unpublished, unsequenced rows', () => {
  const sql = assignBatchSql();
  assert.match(sql, /WHERE "published_at" IS NULL\s*\n\s*AND "stream_seq" IS NULL/);
});

test('the batch is ordered by (created_at, id), bounded, and locked', () => {
  const sql = assignBatchSql();
  assert.match(sql, /ORDER BY "created_at", "id"/);
  assert.match(sql, /LIMIT \$1/);
  assert.match(sql, /FOR UPDATE/);
});

test('the sequence is a window function over (created_at, id), not a JavaScript order', () => {
  assert.match(
    assignBatchSql(),
    /row_number\(\) OVER \(\s*\n\s*PARTITION BY b\."topic", b\."partition_key"\s*\n\s*ORDER BY b\."created_at", b\."id"/,
  );
});

test('the assignment is gated on the ordering guard, so a tripped batch writes nothing', () => {
  const sql = assignBatchSql();
  const numbered = sql.indexOf('numbered AS (');
  const update = sql.indexOf('UPDATE "outbox_message" o');
  assert.ok(numbered > 0 && update > numbered);
  assert.match(sql.slice(numbered, update), /WHERE \(SELECT violations FROM guard\) = 0/);
});

test('the counter upsert never moves a counter backwards', () => {
  const sql = counterUpsertSql();
  assert.match(sql, /"next_seq"\s*= GREATEST\(s\."next_seq", EXCLUDED\."next_seq"\)/);
  assert.match(sql, /"published_seq" = GREATEST\(s\."published_seq", EXCLUDED\."published_seq"\)/);
  assert.match(sql, /max\("stream_seq"\)\s*AS max_seq/);
  assert.match(sql, /min\("stream_seq"\) FILTER \(WHERE "published_at" IS NULL\)/);
});

test('the head is the lowest sequenced unpublished row, and rewrites nothing else', () => {
  const sql = headMaintenanceSql();
  assert.match(sql, /min\("stream_seq"\) AS head_seq/);
  assert.match(sql, /WHERE "stream_seq" IS NOT NULL\s*\n\s*AND "published_at" IS NULL/);
  assert.match(sql, /AND o\."is_stream_head" IS DISTINCT FROM w\.is_head/);
});

test('the plan is only counts — nothing in it can mutate', () => {
  const sql = planSql();
  assert.doesNotMatch(sql, /\b(UPDATE|INSERT|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/i);
  assert.match(sql, /^\s*SELECT/);
});

test('the verification is only counts', () => {
  assert.doesNotMatch(verifySql(), /\b(UPDATE|INSERT|DELETE|TRUNCATE|ALTER|DROP)\b/i);
});

test('vacuum is ANALYZE on the outbox table and nothing else', () => {
  assert.equal(vacuumSql(), 'VACUUM (ANALYZE) "outbox_message"');
  assert.equal(
    vacuumSql('"public"."outbox_message"'),
    'VACUUM (ANALYZE) "public"."outbox_message"',
  );
});

test('the vacuum facts are read-only and name the outbox table only', () => {
  assert.doesNotMatch(vacuumFactsSql(), /\b(UPDATE|INSERT|DELETE|TRUNCATE|ALTER|DROP|VACUUM)\b/i);
  assert.match(vacuumFactsSql(), /to_regclass\('"outbox_message"'\)/);
  // Ownership, directly or by inherited membership, and the manual counters.
  assert.match(vacuumFactsSql(), /pg_has_role\(current_user, c\.relowner, 'USAGE'\)/);
  assert.match(vacuumFactsSql(), /s\.vacuum_count/);
  assert.match(vacuumFactsSql(), /s\.analyze_count/);
});

/**
 * A port that answers the backfill's own SQL with canned counts and records
 * every statement. One stream of two rows: one batch assigns both, the next
 * selects none.
 */
function scriptedPort() {
  const executed = [];
  const queried = [];
  const batches = [
    { selected: 2, updated: 2, streams: 1, violations: 0 },
    { selected: 0, updated: 0, streams: 0, violations: 0 },
  ];
  const answer = (sql) => {
    queried.push(sql);
    if (sql === b1PreconditionSql()) return [];
    if (sql === planSql()) return [{ pending_unsequenced: 2 }];
    if (sql === assignBatchSql()) return [batches.shift()];
    if (sql === counterUpsertSql()) return [{ written: 1 }];
    if (sql === headMaintenanceSql()) return [{ changed: 1 }];
    if (sql === verifySql()) return [{ remaining: 0 }];
    throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
  };
  const port = {
    query: async (sql) => answer(sql),
    execute: async (sql) => {
      executed.push(sql);
      return 0;
    },
    transaction: async (fn) => fn({ query: async (sql) => answer(sql) }),
  };
  return { port, executed, queried };
}

test('an apply never vacuums and says the vacuum is required, naming the table (D-045)', async () => {
  const { port, executed, queried } = scriptedPort();
  const events = [];
  const result = await runServiceBackfill({
    service: 'document',
    db: port,
    options: parseOptions(['--service', 'document', '--apply'], {}),
    emit: (event) => events.push(event),
  });

  assert.equal(result.mutated, true);
  // No VACUUM through any path: the runtime role's would be skipped by
  // PostgreSQL and reported as success.
  assert.deepEqual(executed, []);
  assert.equal(
    queried.some((sql) => /\bVACUUM\b/i.test(sql)),
    false,
  );
  const vacuum = events.filter((event) => event.type === 'vacuum');
  assert.equal(vacuum.length, 1);
  assert.equal(vacuum[0].status, 'required');
  assert.equal(vacuum[0].table, 'outbox_message');
  assert.equal(vacuum[0].ok, undefined, 'a vacuum that did not happen was reported as ok');
  assert.match(vacuum[0].reason, /scripts\/outbox-b2-vacuum\.mjs --service document/);
  assert.equal(events.find((event) => event.type === 'done').vacuum, 'required');
  assert.equal(result.vacuum, 'required');
});

test('a plan owes no vacuum and reports none', async () => {
  const { port, executed } = scriptedPort();
  const events = [];
  await runServiceBackfill({
    service: 'document',
    db: port,
    options: parseOptions(['--service', 'document'], {}),
    emit: (event) => events.push(event),
  });
  assert.deepEqual(executed, []);
  assert.deepEqual(
    events.filter((event) => event.type === 'vacuum'),
    [],
  );
});

test('no B2 SQL names another service or a shared sequence table', () => {
  const everything = [
    assignBatchSql(),
    counterUpsertSql(),
    headMaintenanceSql(),
    planSql(),
    verifySql(),
    vacuumSql(),
  ].join('\n');
  assert.doesNotMatch(everything, /\b\w+\.(outbox_message|outbox_stream_sequence)\b/);
  assert.doesNotMatch(everything, /nextval|BIGSERIAL|SEQUENCE\s+"/i);
});

// ---------------------------------------------------------------------------
// B2 is invoked, never triggered.
// ---------------------------------------------------------------------------

test('the backfill CLI is in no automated gate', async () => {
  const files = [
    'package.json',
    'turbo.json',
    path.join('.github', 'workflows', 'ci.yml'),
    path.join('.github', 'workflows', 'pr.yml'),
  ];
  for (const file of files) {
    const contents = await readFile(path.join(root, file), 'utf8').catch(() => null);
    if (contents === null) continue;
    assert.doesNotMatch(
      contents,
      /outbox-b2-backfill\.mjs/,
      `${file} invokes the B2 backfill CLI — it must only ever be run by hand`,
    );
  }
});

test('neither B2 test script is the backfill, and the PostgreSQL one is not in verify', async () => {
  const { scripts } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

  // The pure tests belong in the gate; the PostgreSQL ones need a live
  // database, so `verify` must not depend on infrastructure being up.
  assert.match(scripts.verify, /pnpm run test:outbox-b2 &&/);
  assert.doesNotMatch(scripts.verify, /test:outbox-b2-pg/);

  // Both test scripts run a test file. Neither runs the tool.
  assert.match(scripts['test:outbox-b2'], /--test scripts\/outbox-b2-lib\.test\.mjs$/);
  assert.match(scripts['test:outbox-b2-pg'], /--test scripts\/outbox-b2-backfill\.pg\.test\.mjs$/);
});

test('no Prisma migration contains B2 DML', async () => {
  const { globSync } = await import('node:fs');
  const files = globSync('services/*/prisma/migrations/**/*.sql', { cwd: root });
  assert.ok(files.length > 0, 'no migrations found — the glob is wrong');
  for (const file of files) {
    const sql = await readFile(path.join(root, file), 'utf8');
    assert.doesNotMatch(
      sql,
      /UPDATE\s+"?outbox_message"?\s+SET/i,
      `${file} updates outbox_message — B2 data changes belong in the tool, not a migration`,
    );
    assert.doesNotMatch(
      sql,
      /INSERT\s+INTO\s+"?outbox_stream_sequence"?/i,
      `${file} writes outbox_stream_sequence — that is B2 tool work, not a migration`,
    );
  }
});
