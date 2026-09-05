// -----------------------------------------------------------------------------
// ADR-051 Phase B2 — the correctness tests, against real PostgreSQL.
//
// Every one of these runs the tool's own SQL through the tool's own
// orchestration. Nothing is mocked and nothing is re-implemented here: the
// library is imported, the port is the same Prisma port the CLI uses, and the
// schema is built from the shipped migration files.
//
// Isolation: each test creates its own throwaway schema on a service database
// and drops it afterwards. Nothing runs against `public`, so a developer's
// outbox is never touched, and no test can see another test's rows — which
// also means fixture order cannot decide a result.
//
//   pnpm test:outbox-b2-pg      (needs `pnpm infra:up` and a repo-root .env)
//
// Run it explicitly. It is not in `pnpm verify`, not in CI's default gate, and
// not in `pnpm test:migration` — B2 is an operator-invoked tool and its data
// tests need a live database.
// -----------------------------------------------------------------------------
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { B2RefusalError, parseOptions, runServiceBackfill, vacuumSql } from './outbox-b2-lib.mjs';
import { prismaPort } from './outbox-b2-prisma-port.mjs';
import {
  createOutboxSchema,
  deployOutboxSchema,
  dropOutboxSchema,
  insertRowsSql,
  publishSql,
  urlWithSchema,
} from './outbox-b2-fixture.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(REPO_ROOT, 'scripts', 'outbox-b2-backfill.mjs');

/**
 * Two different service databases, because one of the required properties is
 * that a backfill of one cannot reach the other. A single database with two
 * schemas would not prove it.
 */
function baseUrl(service) {
  const key = `DATABASE_URL_${service.toUpperCase()}`;
  const url = process.env[key];
  if (!url) {
    throw new Error(
      `${key} is not set. These tests run against a real PostgreSQL: start it with ` +
        '`pnpm infra:up`, copy .env.example to .env, and run them with ' +
        '`node --env-file=.env --test scripts/outbox-b2-backfill.pg.test.mjs`.',
    );
  }
  return url;
}

const admins = new Map();

before(() => {
  for (const service of ['document', 'economic']) {
    admins.set(service, prismaPort(service, baseUrl(service)));
  }
});

after(async () => {
  await Promise.all([...admins.values()].map((port) => port.close()));
});

let counter = 0;
const nextSchema = () => `b2_test_${process.pid}_${(counter += 1)}`;

/**
 * A throwaway schema on `service`, carrying the real outbox schema, dropped
 * whatever the test does.
 */
async function withOutbox(service, fn) {
  const admin = admins.get(service);
  const schema = nextSchema();
  await createOutboxSchema(admin, schema);
  const url = urlWithSchema(baseUrl(service), schema);
  const db = prismaPort(service, url);
  try {
    await deployOutboxSchema(db);
    return await fn({ db, url, schema, service });
  } finally {
    await db.close();
    await dropOutboxSchema(admin, schema);
  }
}

const options = (argv) => parseOptions(['--service', 'document', ...argv], {});

/** Run the library the way the CLI does, collecting the NDJSON events. */
async function backfill(db, argv, { service = 'document' } = {}) {
  const events = [];
  const result = await runServiceBackfill({
    service,
    db,
    options: options(argv),
    emit: (event) => events.push(event),
  });
  return { events, result, event: (type) => events.find((e) => e.type === type) };
}

const scalar = async (db, sql) => {
  const [row] = await db.query(sql);
  return Number(Object.values(row)[0]);
};

const rows = (db, sql) => db.query(sql);

/**
 * A fingerprint of everything B2 is allowed to change, plus the columns it is
 * not. Two identical fingerprints mean the database did not move.
 */
const FINGERPRINT = `
SELECT md5(coalesce(string_agg(line, '|' ORDER BY line), '')) AS f FROM (
  SELECT "id" || ':' || coalesce("stream_seq"::text, '-') || ':' || "is_stream_head"::text
      || ':' || coalesce("published_at"::text, '-') AS line
    FROM "outbox_message"
  UNION ALL
  SELECT 'seq:' || "topic" || ':' || "partition_key" || ':' || "next_seq" || ':' || "published_seq"
    FROM "outbox_stream_sequence"
) t`;

const fingerprint = async (db) => (await db.query(FINGERPRINT))[0].f;

/**
 * Run the real CLI as a child process.
 *
 * The exit status *is* the contract these tests exist to pin down, so it is
 * read from the process itself. Nothing here stubs `process.exitCode`,
 * substitutes a stand-in binary, or infers success from the library's return
 * value — an operator's shell sees this number and nothing else.
 */
function runCli(argv, env = {}) {
  const childEnv = { ...process.env, NODE_ENV: 'test', DATABASE_URL: '', ...env };
  // An explicit `undefined` *removes* the variable rather than setting it to
  // the string "undefined". That is how a test omits one service's connection
  // while the repo-root .env has supplied all eight to this process.
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
  }
  const result = spawnSync(process.execPath, [CLI, ...argv], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: childEnv,
  });
  const events = result.stdout.trim()
    ? result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : [];
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    events,
    of: (type) => events.filter((event) => event.type === type),
    summary: events.at(-1),
  };
}

/** The three summary counters, as one comparable object. */
const tally = (run) => ({
  ok: run.summary.ok,
  incomplete: run.summary.incomplete,
  refused: run.summary.refused,
});

// ---------------------------------------------------------------------------
// Deterministic ordering
// ---------------------------------------------------------------------------

test('(created_at, id) is the tie-breaker when a whole stream shares one timestamp', async () => {
  await withOutbox('document', async ({ db }) => {
    // Twelve rows, one stream, one identical created_at — ADR-051 § 5 test 1.
    // The ids are inserted in an order unrelated to their sort order, so a
    // result that followed insertion order rather than (created_at, id) would
    // differ.
    await db.execute(
      insertRowsSql({
        prefix: 'SAME',
        topic: 't.a',
        partitionKey: 'K1',
        count: 12,
        msOffsets: Array(12).fill(0),
      }),
    );
    // A second stream, same timestamps, to prove the partition is the stream
    // and not the table.
    await db.execute(
      insertRowsSql({
        prefix: 'OTHER',
        topic: 't.a',
        partitionKey: 'K2',
        count: 12,
        msOffsets: Array(12).fill(0),
      }),
    );

    await backfill(db, ['--apply']);

    // The comparison is made by PostgreSQL, against its own ORDER BY, so no
    // JavaScript collation opinion enters it.
    const wrong = await scalar(
      db,
      `SELECT count(*) FROM (
         SELECT "stream_seq",
                row_number() OVER (PARTITION BY "topic", "partition_key"
                                   ORDER BY "created_at", "id") AS rn
           FROM "outbox_message"
       ) t WHERE "stream_seq" IS DISTINCT FROM rn`,
    );
    assert.equal(wrong, 0, 'a sequence disagreed with (created_at, id) order');

    const distinctTimestamps = await scalar(
      db,
      'SELECT count(DISTINCT "created_at") FROM "outbox_message"',
    );
    assert.equal(distinctTimestamps, 1, 'the fixture did not actually share a timestamp');
  });
});

test('a stream larger than one batch is numbered with no duplicate, gap or reorder', async () => {
  await withOutbox('document', async ({ db }) => {
    // 5,200 rows in ONE stream at the ADR ceiling of 5,000 per batch: the
    // stream necessarily spans a batch boundary, which is the case the anchor
    // (`base_seq` = the stream's current max) exists to handle.
    await db.execute(
      insertRowsSql({ prefix: 'BIG', topic: 't.a', partitionKey: 'HOT', count: 5200 }),
    );
    // A second stream interleaved in time, so the boundary falls inside both.
    await db.execute(
      insertRowsSql({ prefix: 'SML', topic: 't.a', partitionKey: 'COLD', count: 300, from: 1 }),
    );

    const { events, result } = await backfill(db, ['--apply']);
    assert.ok(result.batches.length >= 2, 'the fixture did not span a batch boundary');
    assert.equal(events.filter((e) => e.type === 'vacuum').length, result.batches.length);

    const hot = await rows(
      db,
      `SELECT count(*)::int                     AS n,
              count(DISTINCT "stream_seq")::int AS distinct_seq,
              min("stream_seq")::int            AS lo,
              max("stream_seq")::int            AS hi
         FROM "outbox_message" WHERE "partition_key" = 'HOT'`,
    );
    assert.deepEqual(
      { n: hot[0].n, distinct_seq: hot[0].distinct_seq, lo: hot[0].lo, hi: hot[0].hi },
      { n: 5200, distinct_seq: 5200, lo: 1, hi: 5200 },
      'the sequence is not a dense 1..n — a duplicate or a gap crossed the batch boundary',
    );

    const reordered = await scalar(
      db,
      `SELECT count(*) FROM (
         SELECT "stream_seq",
                row_number() OVER (PARTITION BY "topic", "partition_key"
                                   ORDER BY "created_at", "id") AS rn
           FROM "outbox_message"
       ) t WHERE "stream_seq" IS DISTINCT FROM rn`,
    );
    assert.equal(reordered, 0, 'a row crossed a batch boundary and came back out of order');
  });
});

test('several streams inside one batch each get their own 1..n', async () => {
  await withOutbox('document', async ({ db }) => {
    for (const [prefix, key] of [
      ['M1', 'K1'],
      ['M2', 'K2'],
      ['M3', 'K3'],
    ]) {
      await db.execute(
        insertRowsSql({ prefix, topic: 't.a', partitionKey: key, count: 4, from: 1 }),
      );
    }
    // One batch, comfortably larger than all twelve rows.
    const { result } = await backfill(db, ['--apply', '--batch-size', '50']);
    assert.equal(result.batches.length, 1);
    assert.equal(result.batches[0].streams, 3);

    const perStream = await rows(
      db,
      `SELECT "partition_key", min("stream_seq")::int AS lo, max("stream_seq")::int AS hi
         FROM "outbox_message" GROUP BY "partition_key" ORDER BY "partition_key"`,
    );
    assert.deepEqual(
      perStream.map((r) => [r.partition_key, r.lo, r.hi]),
      [
        ['K1', 1, 4],
        ['K2', 1, 4],
        ['K3', 1, 4],
      ],
    );
  });
});

// ---------------------------------------------------------------------------
// What B2 must not touch
// ---------------------------------------------------------------------------

test('rows published before the backfill are left completely untouched', async () => {
  await withOutbox('document', async ({ db }) => {
    await db.execute(insertRowsSql({ prefix: 'HIST', topic: 't.a', partitionKey: 'K1', count: 6 }));
    await db.execute(publishSql('^HIST-'));
    await db.execute(
      insertRowsSql({ prefix: 'LIVE', topic: 't.a', partitionKey: 'K1', count: 4, from: 100 }),
    );

    const before = await fingerprint(db);
    await backfill(db, ['--apply']);

    const history = await rows(
      db,
      `SELECT "id", "stream_seq", "is_stream_head"
         FROM "outbox_message" WHERE "id" LIKE 'HIST-%' ORDER BY "id"`,
    );
    assert.equal(history.length, 6);
    for (const row of history) {
      assert.equal(row.stream_seq, null, `${row.id} was sequenced — B2 must skip published rows`);
      assert.equal(row.is_stream_head, false, `${row.id} was flagged head`);
    }

    // The live rows start at 1, not at 7: the published history is not part of
    // the stream's sequence space, which is what makes B2's numbering
    // independent of `purgePublished` having run or not.
    const live = await rows(
      db,
      `SELECT min("stream_seq")::int AS lo, max("stream_seq")::int AS hi
         FROM "outbox_message" WHERE "id" LIKE 'LIVE-%'`,
    );
    assert.deepEqual([live[0].lo, live[0].hi], [1, 4]);
    assert.notEqual(before, await fingerprint(db), 'the fixture proved nothing — nothing changed');
  });
});

test('only unpublished rows with a NULL sequence are backfilled', async () => {
  await withOutbox('document', async ({ db }) => {
    await db.execute(insertRowsSql({ prefix: 'A', topic: 't.a', partitionKey: 'K1', count: 5 }));
    // Pre-set a sequence on one row, as a partial earlier run would have left
    // it, and prove the re-run neither renumbers nor skips past it.
    await db.execute(`UPDATE "outbox_message" SET "stream_seq" = 1 WHERE "id" = 'A-00000001'`);

    await backfill(db, ['--apply']);

    const seqs = await rows(
      db,
      `SELECT "id", "stream_seq"::int AS s FROM "outbox_message" ORDER BY "id"`,
    );
    assert.deepEqual(
      seqs.map((r) => r.s),
      [1, 2, 3, 4, 5],
      'the pre-set sequence was renumbered, or the rest did not continue from it',
    );
  });
});

// ---------------------------------------------------------------------------
// Heads and counters
// ---------------------------------------------------------------------------

test('exactly one head per stream with unpublished sequenced rows, and none for a published one', async () => {
  await withOutbox('document', async ({ db }) => {
    await db.execute(insertRowsSql({ prefix: 'P', topic: 't.a', partitionKey: 'PEND', count: 5 }));
    await db.execute(insertRowsSql({ prefix: 'Q', topic: 't.a', partitionKey: 'MIXED', count: 4 }));
    await db.execute(insertRowsSql({ prefix: 'R', topic: 't.b', partitionKey: 'PEND', count: 3 }));

    await backfill(db, ['--apply']);

    // Now publish the head of MIXED and re-run: the head must move to the next
    // unpublished sequence, and the fully published stream must lose its head.
    await db.execute(publishSql('^Q-00000001$'));
    await db.execute(insertRowsSql({ prefix: 'S', topic: 't.a', partitionKey: 'GONE', count: 2 }));
    await backfill(db, ['--apply']);
    await db.execute(publishSql('^S-'));
    await backfill(db, ['--apply']);

    const heads = await rows(
      db,
      `SELECT "topic", "partition_key", "id", "stream_seq"::int AS s
         FROM "outbox_message" WHERE "is_stream_head" ORDER BY "topic", "partition_key"`,
    );
    assert.deepEqual(
      heads.map((h) => [h.topic, h.partition_key, h.id, h.s]),
      [
        ['t.a', 'MIXED', 'Q-00000002', 2],
        ['t.a', 'PEND', 'P-00000001', 1],
        ['t.b', 'PEND', 'R-00000001', 1],
      ],
      'the head is not the lowest unpublished sequence of each stream',
    );

    const gone = await scalar(
      db,
      `SELECT count(*) FROM "outbox_message"
        WHERE "partition_key" = 'GONE' AND "is_stream_head"`,
    );
    assert.equal(gone, 0, 'a fully published stream still has a head');
  });
});

test('the counter rows describe the state the backfill created', async () => {
  await withOutbox('document', async ({ db }) => {
    await db.execute(insertRowsSql({ prefix: 'P', topic: 't.a', partitionKey: 'PEND', count: 5 }));
    await db.execute(insertRowsSql({ prefix: 'Q', topic: 't.a', partitionKey: 'MIXED', count: 4 }));
    await backfill(db, ['--apply']);
    await db.execute(publishSql('^Q-0000000[12]$'));
    await backfill(db, ['--apply']);

    const counters = await rows(
      db,
      `SELECT "partition_key", "next_seq"::int AS n, "published_seq"::int AS p
         FROM "outbox_stream_sequence" ORDER BY "partition_key"`,
    );
    assert.deepEqual(
      counters.map((c) => [c.partition_key, c.n, c.p]),
      [
        // MIXED: 4 rows numbered 1..4, seq 1 and 2 published, so the head is 3
        // and `published_seq` is head - 1 = 2 — which is what D-4's
        // `stream_seq = published_seq + 1` needs to select row 3.
        ['MIXED', 5, 2],
        // PEND: nothing published, so the head is 1 and published_seq is 0.
        ['PEND', 6, 0],
      ],
    );

    // The head B2 marked and the head D-4 computes are the same row.
    const disagree = await scalar(
      db,
      `SELECT count(*) FROM "outbox_message" m
         JOIN "outbox_stream_sequence" s
           ON s."topic" = m."topic" AND s."partition_key" = m."partition_key"
        WHERE m."is_stream_head" IS DISTINCT FROM
              (m."stream_seq" = s."published_seq" + 1 AND m."published_at" IS NULL)`,
    );
    assert.equal(disagree, 0, 'is_stream_head disagrees with published_seq + 1');
  });
});

test('a fully published stream keeps a counter that would let B3 continue it', async () => {
  await withOutbox('document', async ({ db }) => {
    await db.execute(insertRowsSql({ prefix: 'F', topic: 't.a', partitionKey: 'DONE', count: 3 }));
    await backfill(db, ['--apply']);
    await db.execute(publishSql('^F-'));
    await backfill(db, ['--apply']);

    const [counter] = await rows(
      db,
      `SELECT "next_seq"::int AS n, "published_seq"::int AS p FROM "outbox_stream_sequence"`,
    );
    // Every sequenced row published: next position is 4, and published_seq is
    // the maximum — exactly the state B3's allocation would have left.
    assert.deepEqual([counter.n, counter.p], [4, 3]);
  });
});

// ---------------------------------------------------------------------------
// Restart safety
// ---------------------------------------------------------------------------

test('an interrupted run resumes without renumbering or double-writing', async () => {
  await withOutbox('document', async ({ db }) => {
    await db.execute(insertRowsSql({ prefix: 'A', topic: 't.a', partitionKey: 'K1', count: 7 }));
    await db.execute(insertRowsSql({ prefix: 'B', topic: 't.a', partitionKey: 'K2', count: 7 }));

    // One batch of four, then stop — the shape of a killed run.
    const partial = await backfill(db, ['--apply', '--batch-size', '4', '--max-batches', '1']);
    assert.equal(partial.result.truncated, true);
    assert.equal(partial.event('done').converged, false);
    assert.equal(partial.event('counters'), undefined, 'a truncated run must not finalise');

    const afterPartial = await rows(
      db,
      `SELECT "id", "stream_seq"::int AS s FROM "outbox_message"
        WHERE "stream_seq" IS NOT NULL ORDER BY "id"`,
    );
    assert.equal(afterPartial.length, 4);

    const resumed = await backfill(db, ['--apply', '--batch-size', '4']);
    assert.equal(resumed.event('verify').remaining, 0);
    assert.equal(resumed.event('done').converged, true);

    // Nothing assigned before the interruption moved.
    const afterResume = new Map(
      (
        await rows(db, `SELECT "id", "stream_seq"::int AS s FROM "outbox_message" ORDER BY "id"`)
      ).map((r) => [r.id, r.s]),
    );
    for (const row of afterPartial) {
      assert.equal(afterResume.get(row.id), row.s, `${row.id} was renumbered by the resume`);
    }

    const dense = await scalar(
      db,
      `SELECT count(*) FROM (
         SELECT "partition_key", min("stream_seq") AS lo, max("stream_seq") AS hi,
                count(*) AS n, count(DISTINCT "stream_seq") AS d
           FROM "outbox_message" GROUP BY "partition_key"
       ) t WHERE lo <> 1 OR hi <> n OR d <> n`,
    );
    assert.equal(dense, 0, 'a stream is not a dense 1..n after resuming');
  });
});

test('a second full run is a no-op', async () => {
  await withOutbox('document', async ({ db }) => {
    await db.execute(insertRowsSql({ prefix: 'A', topic: 't.a', partitionKey: 'K1', count: 9 }));
    await db.execute(insertRowsSql({ prefix: 'B', topic: 't.b', partitionKey: 'K1', count: 5 }));
    await db.execute(publishSql('^B-0000000[12]$'));

    await backfill(db, ['--apply', '--batch-size', '3']);
    const settled = await fingerprint(db);

    const again = await backfill(db, ['--apply', '--batch-size', '3']);
    assert.equal(again.result.batches.length, 0, 'the second run selected rows');
    assert.equal(again.event('counters').written, 0, 'the second run rewrote a counter');
    assert.equal(again.event('heads').changed, 0, 'the second run rewrote a head');
    assert.equal(await fingerprint(db), settled, 'the second run changed the database');
  });
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

test('a dry run reports the work and mutates nothing', async () => {
  await withOutbox('document', async ({ db }) => {
    await db.execute(insertRowsSql({ prefix: 'A', topic: 't.a', partitionKey: 'K1', count: 11 }));
    await db.execute(insertRowsSql({ prefix: 'B', topic: 't.a', partitionKey: 'K2', count: 4 }));
    await db.execute(publishSql('^B-00000001$'));

    const before = await fingerprint(db);
    const dry = await backfill(db, ['--batch-size', '5']);

    assert.deepEqual(
      {
        pending: dry.event('plan').pending_unsequenced,
        streams: dry.event('plan').streams_pending,
        batches: dry.event('plan').batchesRequired,
        mode: dry.event('plan').mode,
      },
      { pending: 14, streams: 2, batches: 3, mode: 'dry-run' },
    );
    assert.equal(dry.event('done').mutated, false);
    assert.equal(dry.event('batch'), undefined);
    assert.equal(await fingerprint(db), before, 'the dry run changed the database');

    const sequenced = await scalar(
      db,
      `SELECT count(*) FROM "outbox_message" WHERE "stream_seq" IS NOT NULL`,
    );
    assert.equal(sequenced, 0);
  });
});

// ---------------------------------------------------------------------------
// Fail closed
// ---------------------------------------------------------------------------

test('a missing B1 column is refused before anything is written', async () => {
  await withOutbox('document', async ({ db }) => {
    await db.execute(insertRowsSql({ prefix: 'A', topic: 't.a', partitionKey: 'K1', count: 3 }));
    await db.execute('DROP INDEX "ux_outbox_stream_seq"');
    await db.execute('ALTER TABLE "outbox_message" DROP COLUMN "stream_seq"');

    await assert.rejects(
      () => backfill(db, ['--apply']),
      (error) => {
        assert.ok(error instanceof B2RefusalError);
        assert.match(error.message, /B1 schema precondition failed for document/);
        assert.match(error.message, /Deploy the three ADR-051 B1 migrations/);
        return true;
      },
    );
  });
});

test('a B1 unique index that lost its partial predicate is refused', async () => {
  await withOutbox('document', async ({ db }) => {
    // The index still exists and still has the right name and columns. Only
    // the `WHERE stream_seq IS NOT NULL` predicate is gone — the exact shape
    // an `IF NOT EXISTS` migration steps straight over.
    await db.execute('DROP INDEX "ux_outbox_stream_seq"');
    await db.execute(
      'CREATE UNIQUE INDEX "ux_outbox_stream_seq" ON "outbox_message" ' +
        '("topic", "partition_key", "stream_seq")',
    );

    await assert.rejects(
      () => backfill(db, ['--apply']),
      (error) => {
        assert.match(error.message, /ux_outbox_stream_seq has the wrong definition/);
        return true;
      },
    );
  });
});

test('a missing counter table is refused', async () => {
  await withOutbox('document', async ({ db }) => {
    await db.execute('DROP TABLE "outbox_stream_sequence"');
    await assert.rejects(() => backfill(db, ['--apply']), /B1 schema precondition failed/);
  });
});

test('rows written during the backfill trip the ordering guard and nothing is assigned', async () => {
  await withOutbox('document', async ({ db }) => {
    await db.execute(insertRowsSql({ prefix: 'A', topic: 't.a', partitionKey: 'K1', count: 6 }));

    // A partial run sequences the first three (created_at offsets 1, 2, 3 ms).
    await backfill(db, ['--apply', '--batch-size', '3', '--max-batches', '1']);
    const sequencedBefore = await scalar(
      db,
      `SELECT count(*) FROM "outbox_message" WHERE "stream_seq" IS NOT NULL`,
    );
    assert.equal(sequencedBefore, 3);

    // A producer commits a row whose JavaScript `created_at` is earlier than
    // the row already holding the stream's highest sequence — ADR-051 § R4's
    // commit-order divergence, arriving mid-backfill. Appending it would place
    // sequence 4 before sequence 3 in (created_at, id) order.
    await db.execute(
      insertRowsSql({
        prefix: 'LATE',
        topic: 't.a',
        partitionKey: 'K1',
        count: 1,
        msOffsets: [2],
      }),
    );

    await assert.rejects(
      () => backfill(db, ['--apply', '--batch-size', '3']),
      (error) => {
        assert.ok(error instanceof B2RefusalError);
        assert.match(error.message, /sort before an already-sequenced row/);
        assert.match(error.message, /Quiesce the producers/);
        return true;
      },
    );

    // The batch rolled back whole: no partial assignment, and the three
    // sequences from the earlier run are untouched.
    assert.equal(
      await scalar(db, `SELECT count(*) FROM "outbox_message" WHERE "stream_seq" IS NOT NULL`),
      3,
      'the refused batch still assigned something',
    );
  });
});

test('a VACUUM failure stops the run and says so', async () => {
  await withOutbox('document', async ({ db }) => {
    await db.execute(insertRowsSql({ prefix: 'A', topic: 't.a', partitionKey: 'K1', count: 8 }));

    // Fault injection on the port's maintenance call only. Everything else —
    // the batch transaction, the SQL, the database — is real, so what is being
    // tested is the tool's reaction to a maintenance failure and not a
    // simulation of the backfill.
    const failing = {
      ...db,
      execute: (sql) => {
        if (sql === vacuumSql()) throw new Error('disk full');
        return db.execute(sql);
      },
    };

    await assert.rejects(
      () =>
        runServiceBackfill({
          service: 'document',
          db: failing,
          options: options(['--apply', '--batch-size', '3']),
          emit: () => {},
        }),
      (error) => {
        assert.match(error.message, /VACUUM \(ANALYZE\) failed after batch 1: disk full/);
        assert.match(error.message, /stopping rather than/);
        return true;
      },
    );

    // The first batch's assignment is committed — the run is resumable, which
    // is the reason the failure is reported rather than swallowed.
    assert.equal(
      await scalar(db, `SELECT count(*) FROM "outbox_message" WHERE "stream_seq" IS NOT NULL`),
      3,
    );
  });
});

// ---------------------------------------------------------------------------
// The CLI's exit status is the completion contract.
//
// These run the process, not the library. The library has always returned
// `truncated` honestly; what these pin down is that the CLI acts on it, so a
// bounded slice cannot be mistaken for a finished backfill by anything reading
// only the exit status.
// ---------------------------------------------------------------------------

test('the CLI exit status separates a dry run, a bounded slice and a converged apply', async () => {
  await withOutbox('document', async ({ db, url }) => {
    // 18 rows over two streams. At `--batch-size 4` that is five batches, so
    // `--max-batches 1` necessarily leaves work behind.
    await db.execute(insertRowsSql({ prefix: 'A', topic: 't.a', partitionKey: 'K1', count: 9 }));
    await db.execute(insertRowsSql({ prefix: 'B', topic: 't.a', partitionKey: 'K2', count: 9 }));
    const env = { DATABASE_URL_DOCUMENT: url };
    const untouched = await fingerprint(db);

    // --- a dry run: exit 0, and provably nothing written ---------------------
    const dry = runCli(['--service', 'document'], env);
    assert.equal(dry.status, 0, `a dry run exited ${dry.status}:\n${dry.stdout}${dry.stderr}`);
    assert.deepEqual(tally(dry), { ok: 1, incomplete: 0, refused: 0 });
    assert.equal(dry.of('incomplete').length, 0);
    assert.equal(dry.summary.mode, 'dry-run');
    assert.equal(await fingerprint(db), untouched, 'the dry run mutated the database');

    // --- a bounded slice: exit 1, `incomplete`, and no `refused` -------------
    const bounded = runCli(
      ['--service', 'document', '--apply', '--batch-size', '4', '--max-batches', '1'],
      env,
    );
    assert.equal(
      bounded.status,
      1,
      `a bounded partial backfill exited ${bounded.status} — it must not look finished:` +
        `\n${bounded.stdout}${bounded.stderr}`,
    );
    assert.equal(bounded.of('refused').length, 0, 'a bounded slice was reported as a failure');
    assert.equal(bounded.of('incomplete').length, 1);
    const [incomplete] = bounded.of('incomplete');
    assert.deepEqual(
      {
        service: incomplete.service,
        batches: incomplete.batches,
        truncated: incomplete.truncated,
        remaining: incomplete.remaining,
      },
      { service: 'document', batches: 1, truncated: true, remaining: 14 },
    );
    assert.match(incomplete.reason, /re-run this service without --max-batches/);
    assert.deepEqual(tally(bounded), { ok: 0, incomplete: 1, refused: 0 });

    // Resumability: the one batch is committed, and the counters and heads are
    // deliberately left unfinalised for the run that converges.
    assert.equal(
      await scalar(db, `SELECT count(*) FROM "outbox_message" WHERE "stream_seq" IS NOT NULL`),
      4,
    );
    assert.equal(await scalar(db, 'SELECT count(*) FROM "outbox_stream_sequence"'), 0);
    assert.equal(
      await scalar(db, `SELECT count(*) FROM "outbox_message" WHERE "is_stream_head"`),
      0,
    );
    const assigned = await rows(
      db,
      `SELECT "id", "stream_seq"::int AS s FROM "outbox_message"
        WHERE "stream_seq" IS NOT NULL ORDER BY "id"`,
    );

    // --- the unbounded resume: exit 0, converged, nothing renumbered ---------
    const resumed = runCli(['--service', 'document', '--apply', '--batch-size', '4'], env);
    assert.equal(
      resumed.status,
      0,
      `the resumed run exited ${resumed.status}:\n${resumed.stdout}${resumed.stderr}`,
    );
    assert.deepEqual(tally(resumed), { ok: 1, incomplete: 0, refused: 0 });
    assert.equal(resumed.of('incomplete').length, 0);
    assert.equal(resumed.of('refused').length, 0);
    assert.equal(resumed.events.find((e) => e.type === 'done').converged, true);
    assert.equal(resumed.events.find((e) => e.type === 'verify').remaining, 0);

    const after = new Map(
      (
        await rows(db, `SELECT "id", "stream_seq"::int AS s FROM "outbox_message" ORDER BY "id"`)
      ).map((row) => [row.id, row.s]),
    );
    for (const row of assigned) {
      assert.equal(after.get(row.id), row.s, `${row.id} was renumbered by the resume`);
    }
    assert.equal(await scalar(db, 'SELECT count(*) FROM "outbox_stream_sequence"'), 2);

    // Redaction holds on both of the writing runs.
    assert.doesNotMatch(
      `${bounded.stdout}${resumed.stdout}`,
      /postgresql:|rasta_service_dev_password|@localhost/,
    );
  });
});

test('an incomplete service does not stop the CLI attempting the next one', async () => {
  await withOutbox('document', async (documentScratch) => {
    await withOutbox('economic', async (economicScratch) => {
      // document cannot finish inside one batch; economic can.
      await documentScratch.db.execute(
        insertRowsSql({ prefix: 'A', topic: 't.a', partitionKey: 'K1', count: 9 }),
      );
      await economicScratch.db.execute(
        insertRowsSql({ prefix: 'E', topic: 't.a', partitionKey: 'K1', count: 3 }),
      );

      const run = runCli(
        [
          '--service',
          'document',
          '--service',
          'economic',
          '--apply',
          '--batch-size',
          '4',
          '--max-batches',
          '1',
        ],
        {
          DATABASE_URL_DOCUMENT: documentScratch.url,
          DATABASE_URL_ECONOMIC: economicScratch.url,
        },
      );

      assert.equal(run.status, 1, 'one incomplete service must make the whole run exit non-zero');
      assert.deepEqual(tally(run), { ok: 1, incomplete: 1, refused: 0 });
      assert.deepEqual(
        run.of('incomplete').map((event) => event.service),
        ['document'],
      );
      // economic was reached and converged — the loop did not stop at document.
      assert.equal(
        await scalar(economicScratch.db, 'SELECT count(*) FROM "outbox_stream_sequence"'),
        1,
      );
      assert.equal(
        await scalar(
          economicScratch.db,
          `SELECT count(*) FROM "outbox_message" WHERE "published_at" IS NULL AND "stream_seq" IS NULL`,
        ),
        0,
      );
    });
  });
});

test('a service whose connection cannot be resolved does not skip the services after it', async () => {
  await withOutbox('document', async ({ db, url }) => {
    await db.execute(insertRowsSql({ prefix: 'A', topic: 't.a', partitionKey: 'K1', count: 5 }));
    await db.execute(insertRowsSql({ prefix: 'B', topic: 't.a', partitionKey: 'K2', count: 4 }));

    // economic is named FIRST and its DATABASE_URL_ECONOMIC is removed
    // outright. Resolution happens per service inside the error boundary, so
    // the refusal belongs to economic alone and document still runs.
    const run = runCli(['--service', 'economic', '--service', 'document', '--apply'], {
      DATABASE_URL_ECONOMIC: undefined,
      DATABASE_URL_DOCUMENT: url,
    });

    assert.equal(
      run.status,
      1,
      `an unresolvable connection must make the run exit non-zero:\n${run.stdout}${run.stderr}`,
    );

    // Exactly one refusal, and it names only the service that caused it.
    assert.equal(run.of('refused').length, 1);
    const [refusal] = run.of('refused');
    assert.equal(refusal.service, 'economic');
    assert.match(refusal.reason, /DATABASE_URL_ECONOMIC is not set/);
    assert.match(refusal.reason, /never through a shared DATABASE_URL/);

    // Redaction: the variable is named, its value never is — and no stack
    // frame, payload or credential rides along on the event or on stdout.
    assert.equal(refusal.stack, undefined);
    assert.doesNotMatch(refusal.reason, /postgresql:|@localhost|rasta_service_dev_password/);
    assert.doesNotMatch(refusal.reason, /\n\s+at /);
    assert.doesNotMatch(run.stdout, /postgresql:|@localhost|rasta_service_dev_password/);
    assert.doesNotMatch(run.stdout, /"stack"/);

    // The aggregate summary is still emitted, and it is still the last line.
    assert.equal(run.events.at(-1).type, 'summary');
    assert.deepEqual(
      {
        services: run.summary.services,
        ok: run.summary.ok,
        incomplete: run.summary.incomplete,
        refused: run.summary.refused,
      },
      { services: 2, ok: 1, incomplete: 0, refused: 1 },
    );

    // document — named after the refusal — really ran, and converged.
    assert.equal(run.of('incomplete').length, 0);
    const done = run.events.find((event) => event.type === 'done' && event.service === 'document');
    assert.equal(done.converged, true);
    assert.equal(
      await scalar(
        db,
        `SELECT count(*) FROM "outbox_message"
          WHERE "published_at" IS NULL AND "stream_seq" IS NULL`,
      ),
      0,
      'the service named after a refused one was never processed',
    );
    assert.equal(
      await scalar(db, `SELECT count(*) FROM "outbox_message" WHERE "stream_seq" IS NOT NULL`),
      9,
    );

    // Counter and head state is the ordinary converged shape: one counter row
    // and exactly one head per stream, both derived from the rows.
    const counters = await rows(
      db,
      `SELECT "partition_key", "next_seq"::int AS n, "published_seq"::int AS p
         FROM "outbox_stream_sequence" ORDER BY "partition_key"`,
    );
    assert.deepEqual(
      counters.map((counter) => [counter.partition_key, counter.n, counter.p]),
      [
        ['K1', 6, 0],
        ['K2', 5, 0],
      ],
    );
    const heads = await rows(
      db,
      `SELECT "partition_key", "stream_seq"::int AS s
         FROM "outbox_message" WHERE "is_stream_head" ORDER BY "partition_key"`,
    );
    assert.deepEqual(
      heads.map((head) => [head.partition_key, head.s]),
      [
        ['K1', 1],
        ['K2', 1],
      ],
    );
  });
});

// ---------------------------------------------------------------------------
// Tenant and service isolation — through the CLI, so the resolution path that
// picks a database is the one under test.
// ---------------------------------------------------------------------------

test('a backfill of one service database cannot reach another', async () => {
  await withOutbox('document', async (documentScratch) => {
    await withOutbox('economic', async (economicScratch) => {
      // Identical data in both, including identical topics and partition keys —
      // so nothing but the connection distinguishes them.
      for (const { db } of [documentScratch, economicScratch]) {
        await db.execute(
          insertRowsSql({ prefix: 'T', topic: 't.shared', partitionKey: 'ORG-1', count: 5 }),
        );
        await db.execute(
          insertRowsSql({ prefix: 'U', topic: 't.shared', partitionKey: 'ORG-2', count: 5 }),
        );
      }
      const economicBefore = await fingerprint(economicScratch.db);

      const result = spawnSync(
        process.execPath,
        [CLI, '--service', 'document', '--apply', '--batch-size', '4'],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: {
            ...process.env,
            NODE_ENV: 'test',
            DATABASE_URL: '',
            DATABASE_URL_DOCUMENT: documentScratch.url,
            DATABASE_URL_ECONOMIC: economicScratch.url,
          },
        },
      );
      assert.equal(result.status, 0, `the CLI failed:\n${result.stdout}${result.stderr}`);

      const events = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const done = events.find((e) => e.type === 'done');
      assert.equal(done.converged, true);
      assert.deepEqual(
        {
          ok: events.at(-1).ok,
          incomplete: events.at(-1).incomplete,
          refused: events.at(-1).refused,
        },
        { ok: 1, incomplete: 0, refused: 0 },
      );

      // Redaction: nothing on stdout carries a credential or a URL.
      assert.doesNotMatch(result.stdout, /postgresql:|rasta_service_dev_password|@localhost/);

      assert.equal(
        await scalar(
          documentScratch.db,
          `SELECT count(*) FROM "outbox_message" WHERE "stream_seq" IS NOT NULL`,
        ),
        10,
      );
      assert.equal(
        await fingerprint(economicScratch.db),
        economicBefore,
        'backfilling document changed the economic database',
      );
      assert.equal(
        await scalar(economicScratch.db, 'SELECT count(*) FROM "outbox_stream_sequence"'),
        0,
        'the economic counter table was written by a document backfill',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Global preflight refusal — the other path.
//
// Target selection, option parsing and the environment check all happen in one
// `parseOptions` call before any service is iterated. A failure there is not a
// service's refusal: there is no valid service plan yet to attribute it to, so
// the event is unscoped and there is no aggregate to summarise. The header and
// the runbook used to claim the last line is always `summary`; it is not, and
// these tests hold both documents to what the process actually emits.
// ---------------------------------------------------------------------------

/** Every event type that only a validated service run can produce. */
const SERVICE_SCOPED_EVENTS = [
  'plan',
  'batch',
  'vacuum',
  'counters',
  'heads',
  'verify',
  'done',
  'incomplete',
];

test('a global preflight refusal emits one unscoped refused, no summary and no service event', async () => {
  await withOutbox('document', async ({ db, url }) => {
    // Real pending rows and a real, correctly resolvable database. Nothing may
    // touch them: each case must be refused before any service is opened.
    await db.execute(insertRowsSql({ prefix: 'A', topic: 't.a', partitionKey: 'K1', count: 4 }));
    const before = await fingerprint(db);

    const cases = [
      {
        name: 'no target',
        argv: ['--apply'],
        env: { DATABASE_URL_DOCUMENT: url },
        reason: /No target selected/,
      },
      {
        name: 'unknown service',
        argv: ['--service', 'supplier', '--apply'],
        env: { DATABASE_URL_DOCUMENT: url },
        reason: /Unknown service\(s\): supplier/,
      },
      {
        name: 'NODE_ENV=production',
        argv: ['--service', 'document', '--apply'],
        env: { NODE_ENV: 'production', DATABASE_URL_DOCUMENT: url },
        reason: /Refusing to run with NODE_ENV=production/,
      },
    ];

    for (const testCase of cases) {
      const run = runCli(testCase.argv, testCase.env);
      const where = `${testCase.name}:`;

      assert.equal(run.status, 1, `${where} exited ${run.status}\n${run.stdout}${run.stderr}`);

      // Exactly one event, and it is the refusal.
      assert.equal(run.events.length, 1, `${where} expected one event, got ${run.events.length}`);
      const [event] = run.events;
      assert.equal(event.type, 'refused', `${where} the one event is not a refusal`);
      assert.match(event.reason, testCase.reason);

      // Unscoped: no service was ever chosen, so none can be named.
      assert.equal(event.service, undefined, `${where} the preflight refusal named a service`);

      // No aggregate, and nothing a validated service run would have produced.
      assert.equal(run.of('summary').length, 0, `${where} emitted a summary`);
      for (const type of SERVICE_SCOPED_EVENTS) {
        assert.equal(run.of(type).length, 0, `${where} emitted a service-scoped "${type}"`);
      }

      // Redaction: the reason may name an environment variable or an option,
      // never a URL, a credential, a payload or a stack frame.
      assert.equal(event.stack, undefined, `${where} the event carried a stack`);
      assert.doesNotMatch(event.reason, /\n\s+at /);
      assert.doesNotMatch(run.stdout, /postgresql:|@localhost|rasta_service_dev_password/);
      assert.doesNotMatch(run.stdout, /"stack"|"payload"/);

      // The database it could have reached did not move.
      assert.equal(await fingerprint(db), before, `${where} the database changed`);
    }
  });
});

test('a plan run through the CLI exits 0, emits a summary and writes nothing', async () => {
  await withOutbox('document', async ({ db, url }) => {
    await db.execute(insertRowsSql({ prefix: 'A', topic: 't.a', partitionKey: 'K1', count: 3 }));
    const before = await fingerprint(db);

    // The counterpart to the test above: options validate, so the run takes the
    // service path and the summary *is* the last line.
    const plan = runCli(['--service', 'document'], { DATABASE_URL_DOCUMENT: url });
    assert.equal(plan.status, 0, `${plan.stdout}${plan.stderr}`);
    assert.equal(plan.summary.type, 'summary');
    assert.equal(plan.summary.mode, 'dry-run');
    assert.deepEqual(tally(plan), { ok: 1, incomplete: 0, refused: 0 });
    assert.equal(plan.events.find((event) => event.type === 'done').mutated, false);
    assert.equal(await fingerprint(db), before, 'a plan run mutated the database');
  });
});
