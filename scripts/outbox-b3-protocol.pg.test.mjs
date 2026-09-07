// -----------------------------------------------------------------------------
// ADR-051 Phase B3 — the allocation protocol, against real PostgreSQL.
//
// These prove the four properties B3 claims and nothing more. They run the
// shipped `allocateStreamSeqSql` and the shipped `buildOutboxRow`; the schema
// is built from the shipped migration files by the B2 fixture, on a throwaway
// schema that is created and dropped per test.
//
// No `sleep`, no retry loop, no planner switch, and nothing about transaction
// locking is mocked. The concurrency tests use two real connections and prove
// blocking by observation — a promise that has not settled while its
// competitor has — rather than by waiting a fixed time and hoping.
//
//   pnpm test:outbox-b3      (needs `pnpm infra:up` and a repo-root .env)
//
// What B3 does NOT do, and what these tests therefore do not assert: no head
// flag is advanced, no claim query changes, no consumer enforces anything.
// Delivery stays at-least-once and D-027 stays open.
// -----------------------------------------------------------------------------
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { prismaPort } from './outbox-b2-prisma-port.mjs';
import {
  createOutboxSchema,
  deployOutboxSchema,
  dropOutboxSchema,
  urlWithSchema,
} from './outbox-b2-fixture.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(REPO_ROOT, 'package.json'));

/**
 * The shipped implementation, loaded from the built package.
 *
 * Not a copy of the SQL and not a re-implementation: a test that restated the
 * upsert would keep passing while the shipped statement drifted.
 */
const { allocateStreamSeqSql, buildOutboxRow } = require(
  join(REPO_ROOT, 'packages', 'nest-common', 'dist', 'index.js'),
);
const { EVENT_HEADERS } = require(join(REPO_ROOT, 'packages', 'contracts', 'dist', 'index.js'));

function baseUrl(service) {
  const key = `DATABASE_URL_${service.toUpperCase()}`;
  const url = process.env[key];
  if (!url) {
    throw new Error(
      `${key} is not set. These tests run against a real PostgreSQL: start it with ` +
        '`pnpm infra:up`, copy .env.example to .env, and run `pnpm test:outbox-b3`.',
    );
  }
  return url;
}

const admins = new Map();

before(() => {
  for (const service of ['fleet', 'maintenance', 'supplier']) {
    admins.set(service, prismaPort(service, baseUrl(service)));
  }
});

after(async () => {
  await Promise.all([...admins.values()].map((port) => port.close()));
});

let counter = 0;
const nextSchema = () => `b3_test_${process.pid}_${(counter += 1)}`;

/** A throwaway schema carrying the real B1 outbox schema. */
async function withOutbox(service, fn) {
  const admin = admins.get(service);
  const schema = nextSchema();
  await createOutboxSchema(admin, schema);
  const url = urlWithSchema(baseUrl(service), schema);
  const db = rawClient(service, url);
  try {
    await deployOutboxSchema(db);
    return await fn({ db, url, schema, service });
  } finally {
    await db.close();
    await dropOutboxSchema(admin, schema);
  }
}

const scalar = async (db, sql) => {
  const [row] = await db.query(sql);
  return Number(Object.values(row)[0]);
};
const rows = (db, sql) => db.query(sql);

/**
 * A raw Prisma client for one service database.
 *
 * The B2 port narrows its transaction client to `{ query }`, which is all the
 * backfill needs. `allocateStreamSeqSql` takes an `OutboxSqlClient` — it calls
 * `$queryRawUnsafe` — and the whole point of these tests is to run the shipped
 * allocator against a *real* interactive transaction, so the transaction client
 * is handed over unwrapped.
 *
 * `timeout` is raised well above Prisma's 5-second default: two of these tests
 * deliberately hold a transaction open while proving a second one is blocked.
 */
function rawClient(service, url) {
  const serviceDir = join(REPO_ROOT, 'services', `${service}-service`);
  const { PrismaClient } = require(join(serviceDir, 'src', 'generated', 'prisma'));
  const client = new PrismaClient({ datasources: { db: { url } } });
  return {
    query: (sql, params = []) =>
      params.length > 0 ? client.$queryRawUnsafe(sql, ...params) : client.$queryRawUnsafe(sql),
    execute: (sql) => client.$executeRawUnsafe(sql),
    // The raw methods too, so this wrapper itself satisfies `OutboxSqlClient`
    // and `produce()` works identically whether it is handed the client (an
    // implicit single-statement transaction) or a real interactive one.
    $queryRawUnsafe: (sql, ...values) => client.$queryRawUnsafe(sql, ...values),
    $executeRawUnsafe: (sql, ...values) => client.$executeRawUnsafe(sql, ...values),
    /** The callback receives the real transaction client, not a narrowed one. */
    transaction: (fn) => client.$transaction(fn, { timeout: 30_000, maxWait: 30_000 }),
    close: () => client.$disconnect(),
  };
}

/**
 * Waits until `read()` returns a defined value, or fails with a reason.
 *
 * Bounded on purpose: an earlier draft spun forever when the transaction it was
 * waiting on threw, which turns a test failure into a hang. This yields to the
 * event loop rather than sleeping, so it still decides nothing by duration.
 */
async function waitFor(read, describe) {
  // Bounded by wall clock rather than by a turn count: a cold Prisma client
  // connecting and opening a transaction outruns any reasonable number of
  // `setImmediate` turns, and an earlier turn-based bound failed on exactly
  // that. This still decides nothing by duration — it only refuses to hang
  // forever when the thing being waited on has already failed.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise(setImmediate);
  }
  throw new Error(`timed out waiting for ${describe}`);
}

const FLEET_TOPIC = 'rasta.fleet.v1';
const MAINTENANCE_TOPIC = 'rasta.maintenance.v1';
/**
 * supplier-service, added when it landed.
 *
 * Included deliberately rather than by extending a loop: this service folds
 * ADR-050 and ADR-051 B1 into one initial migration, so its outbox reaches the
 * B1 shape by a different route from the eight that were migrated into it. That
 * makes it the one service where "the allocator behaves identically" is worth
 * asserting rather than assuming, and the shared fixture — which builds the
 * outbox DDL from the definitions the platform agreed, not from this service's
 * files — is what makes the comparison meaningful.
 */
const SUPPLIER_TOPIC = 'rasta.supplier.v1';

/**
 * Writes one outbox row the way a producer does: allocate against the resolved
 * stream, then build, then insert — all on the supplied transaction client.
 */
async function produce(tx, { topic, partitionKey, eventName, aggregateId, occurredAt }) {
  const streamSeq = await allocateStreamSeqSql(tx, topic, partitionKey);
  const row = buildOutboxRow(
    {
      aggregateType: 'Probe',
      aggregateId,
      eventName,
      topic,
      partitionKey,
      streamSeq,
      streamKey: partitionKey,
      payload: { probe: aggregateId },
      organizationId: 'ORG-B3',
      ...(occurredAt ? { occurredAt } : {}),
    },
    { producer: 'b3-protocol-test', producerVersion: '0.0.0' },
  );

  await tx.$executeRawUnsafe(
    `INSERT INTO "outbox_message" (
       "id","aggregate_type","aggregate_id","event_name","event_version",
       "topic","partition_key","payload","headers","organization_id",
       "correlation_id","created_at","attempts","stream_seq"
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,0,$13)`,
    row.id,
    row.aggregateType,
    row.aggregateId,
    row.eventName,
    row.eventVersion,
    row.topic,
    row.partitionKey,
    JSON.stringify(row.payload),
    JSON.stringify(row.headers),
    row.organizationId,
    row.correlationId,
    row.createdAt,
    row.streamSeq,
  );
  return row;
}

// ---------------------------------------------------------------------------
// 1. Twelve events on one stream, including identical timestamps
// ---------------------------------------------------------------------------

test('twelve events on one stream get strictly increasing sequences that agree row for row', async () => {
  await withOutbox('fleet', async ({ db }) => {
    // Start from a non-empty counter, the way B2 leaves a backfilled stream:
    // next_seq = max(stream_seq) + 1. The first allocation must continue from
    // there, not restart at 1.
    await db.execute(
      `INSERT INTO "outbox_stream_sequence" ("topic","partition_key","next_seq","published_seq")
       VALUES ('${FLEET_TOPIC}', 'ASSET-1', 41, 0)`,
    );

    // One identical millisecond for all twelve — ADR-051 § 5 test 1. The
    // sequence must be decided by the counter, not by a timestamp that cannot
    // separate them.
    const sameInstant = new Date('2026-02-01T00:00:00.000Z');
    const produced = [];
    for (let i = 0; i < 12; i += 1) {
      produced.push(
        await produce(db, {
          topic: FLEET_TOPIC,
          partitionKey: 'ASSET-1',
          eventName: 'USAGE_RECORDED',
          aggregateId: `USG-${String(i).padStart(3, '0')}`,
          occurredAt: sameInstant,
        }),
      );
    }

    assert.equal(
      await scalar(db, `SELECT count(DISTINCT "created_at") FROM "outbox_message"`),
      1,
      'the fixture did not actually share one timestamp',
    );

    // Strictly increasing, unique, dense, and starting from the existing
    // next_seq rather than from 1.
    assert.deepEqual(
      produced.map((row) => row.streamSeq),
      Array.from({ length: 12 }, (_, i) => 41 + i),
    );

    // The database column, the envelope's two fields and the header agree,
    // row for row. Read back from PostgreSQL, not from the objects in memory.
    const stored = await rows(
      db,
      `SELECT "id", "stream_seq"::int AS db_seq,
              ("payload"->>'streamSeq')::int AS envelope_seq,
              "payload"->>'streamKey'        AS envelope_key,
              "headers"->>'${EVENT_HEADERS.streamSeq}' AS header_seq,
              "partition_key"
         FROM "outbox_message" ORDER BY "stream_seq"`,
    );
    assert.equal(stored.length, 12);
    for (const [i, row] of stored.entries()) {
      const expected = 41 + i;
      assert.deepEqual(
        {
          db: row.db_seq,
          envelope: row.envelope_seq,
          key: row.envelope_key,
          header: row.header_seq,
        },
        {
          db: expected,
          envelope: expected,
          key: 'ASSET-1',
          header: String(expected),
        },
        `row ${row.id} disagrees with itself`,
      );
      assert.equal(row.envelope_key, row.partition_key, 'streamKey is not the partition key');
    }

    // The counter is left exactly where B3's next allocation continues.
    const [seq] = await rows(
      db,
      `SELECT "next_seq"::int AS n, "published_seq"::int AS p FROM "outbox_stream_sequence"`,
    );
    assert.deepEqual([seq.n, seq.p], [53, 0], 'published_seq must not move — that is B4');
  });
});

// ---------------------------------------------------------------------------
// 2. Two concurrent transactions serialize on the counter row
// ---------------------------------------------------------------------------

test('a second transaction on one stream blocks on the counter row until the first resolves', async () => {
  await withOutbox('fleet', async ({ url }) => {
    // Two independent connections: one transaction each, genuinely concurrent.
    const a = rawClient('fleet', url);
    const b = rawClient('fleet', url);
    try {
      // Connect both before the race, so the "is B still blocked?" observation
      // is about the row lock and not about connection setup.
      await Promise.all([a.query('SELECT 1'), b.query('SELECT 1')]);

      let firstAllocated;
      let secondAllocated;
      let secondSettled = false;

      // Transaction A opens, allocates, and is held open by an unresolved
      // promise the test controls. No sleep decides anything.
      let releaseA;
      const aHeld = new Promise((resolve) => {
        releaseA = resolve;
      });
      const aDone = a.transaction(async (tx) => {
        firstAllocated = await allocateStreamSeqSql(tx, FLEET_TOPIC, 'ASSET-HOT');
        await aHeld;
        return firstAllocated;
      });

      // Wait for A to actually hold the lock, by observing the allocation
      // rather than by waiting a duration. If A fails instead, surface that.
      aDone.catch(() => {});
      await waitFor(
        () => firstAllocated,
        'the first transaction to allocate and hold the counter row lock',
      );
      assert.equal(firstAllocated, 1, 'a fresh stream must start at 1');

      // Transaction B now asks for the same stream. It must not settle.
      const bDone = b
        .transaction(async (tx) => allocateStreamSeqSql(tx, FLEET_TOPIC, 'ASSET-HOT'))
        .then((value) => {
          secondAllocated = value;
          secondSettled = true;
          return value;
        });

      // Give the event loop every chance to settle B. If the lock were not
      // held, B would have completed within these turns.
      for (let i = 0; i < 200; i += 1) await new Promise(setImmediate);
      assert.equal(
        secondSettled,
        false,
        'the second transaction was not blocked — the counter row lock is not the serialisation point',
      );
      assert.equal(secondAllocated, undefined);

      // Release A. Only now may B proceed, and it must get the next number.
      releaseA();
      assert.equal(await aDone, 1);
      assert.equal(await bDone, 2, 'the committed sequences must follow lock order');
    } finally {
      await a.close();
      await b.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Rollback consumes no sequence and leaves no row
// ---------------------------------------------------------------------------

test('a rolled-back domain transaction consumes no sequence and writes no row', async () => {
  await withOutbox('fleet', async ({ db }) => {
    // One committed event first, so the rollback is tested against a live
    // counter rather than an empty one.
    await db.transaction((tx) =>
      produce(tx, {
        topic: FLEET_TOPIC,
        partitionKey: 'ASSET-2',
        eventName: 'USAGE_RECORDED',
        aggregateId: 'USG-1',
      }),
    );
    assert.equal(await scalar(db, `SELECT "next_seq"::int FROM "outbox_stream_sequence"`), 2);

    // Allocate, write the row, then fail the transaction the way a domain
    // rule violation would.
    await assert.rejects(
      db.transaction(async (tx) => {
        const allocated = await allocateStreamSeqSql(tx, FLEET_TOPIC, 'ASSET-2');
        assert.equal(allocated, 2, 'the doomed transaction did allocate');
        await produce(tx, {
          topic: FLEET_TOPIC,
          partitionKey: 'ASSET-2',
          eventName: 'USAGE_RECORDED',
          aggregateId: 'USG-DOOMED',
        });
        throw new Error('domain rule violated');
      }),
      /domain rule violated/,
    );

    // Nothing survived: no row, and the counter is back where it was.
    assert.equal(await scalar(db, `SELECT count(*) FROM "outbox_message"`), 1);
    assert.equal(
      await scalar(db, `SELECT count(*) FROM "outbox_message" WHERE "aggregate_id" = 'USG-DOOMED'`),
      0,
    );
    assert.equal(
      await scalar(db, `SELECT "next_seq"::int FROM "outbox_stream_sequence"`),
      2,
      'the rollback burned a sequence — a BIGSERIAL would, a counter row must not',
    );

    // The next committed event receives the number the rollback gave back, so
    // a consumer sees no gap. This is the property `nextval()` cannot offer.
    const next = await db.transaction((tx) =>
      produce(tx, {
        topic: FLEET_TOPIC,
        partitionKey: 'ASSET-2',
        eventName: 'USAGE_RECORDED',
        aggregateId: 'USG-2',
      }),
    );
    assert.equal(next.streamSeq, 2, 'the rolled-back number was not reused');
    const seqs = await rows(
      db,
      `SELECT "stream_seq"::int AS s FROM "outbox_message" ORDER BY "stream_seq"`,
    );
    assert.deepEqual(
      seqs.map((r) => r.s),
      [1, 2],
      'the stream has a gap',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Counters are independent per key and per topic
// ---------------------------------------------------------------------------

test('different partition keys and different topics have independent counters', async () => {
  await withOutbox('fleet', async ({ db }) => {
    // Same topic, two keys.
    for (let i = 0; i < 3; i += 1) {
      await produce(db, {
        topic: FLEET_TOPIC,
        partitionKey: 'ASSET-A',
        eventName: 'USAGE_RECORDED',
        aggregateId: `A-${i}`,
      });
    }
    const b1 = await produce(db, {
      topic: FLEET_TOPIC,
      partitionKey: 'ASSET-B',
      eventName: 'USAGE_RECORDED',
      aggregateId: 'B-0',
    });
    assert.equal(b1.streamSeq, 1, 'a second key must start its own count at 1');

    // Same key, a different topic in the same database. The stream is the
    // pair, so this is a different stream with its own counter.
    const other = await produce(db, {
      topic: 'rasta.other.v1',
      partitionKey: 'ASSET-A',
      eventName: 'USAGE_RECORDED',
      aggregateId: 'O-0',
    });
    assert.equal(other.streamSeq, 1, 'the topic is part of the stream identity');

    const counters = await rows(
      db,
      `SELECT "topic", "partition_key", "next_seq"::int AS n
         FROM "outbox_stream_sequence" ORDER BY "topic", "partition_key"`,
    );
    assert.deepEqual(
      counters.map((c) => [c.topic, c.partition_key, c.n]),
      [
        [FLEET_TOPIC, 'ASSET-A', 4],
        [FLEET_TOPIC, 'ASSET-B', 2],
        ['rasta.other.v1', 'ASSET-A', 2],
      ],
    );
  });
});

test('the same assetId in fleet and maintenance shares no sequence — the negative test', async () => {
  // Deliberately a negative test. Q-36 made both topics STRICT, and someone
  // will eventually read that as "so they are ordered against each other".
  // They are not: two databases, two counter tables, no shared lock and no
  // shared transaction (ADR-051 § C-7, plan § B4). This test exists so that
  // conclusion cannot be drawn quietly later.
  await withOutbox('fleet', async (fleet) => {
    await withOutbox('maintenance', async (maintenance) => {
      const ASSET = 'ASSET-SHARED';

      const f1 = await produce(fleet.db, {
        topic: FLEET_TOPIC,
        partitionKey: ASSET,
        eventName: 'USAGE_RECORDED',
        aggregateId: 'F-1',
      });
      const m1 = await produce(maintenance.db, {
        topic: MAINTENANCE_TOPIC,
        partitionKey: ASSET,
        eventName: 'BREAKDOWN_REPORTED',
        aggregateId: 'M-1',
      });
      const f2 = await produce(fleet.db, {
        topic: FLEET_TOPIC,
        partitionKey: ASSET,
        eventName: 'USAGE_RECORDED',
        aggregateId: 'F-2',
      });

      // Both streams count from 1 independently. Interleaving the writes did
      // not make one continue the other.
      assert.deepEqual([f1.streamSeq, f2.streamSeq], [1, 2]);
      assert.equal(m1.streamSeq, 1);

      // Neither database can even see the other's counter: one row each, in
      // its own service's database, under its own topic.
      for (const [scratch, topic] of [
        [fleet, FLEET_TOPIC],
        [maintenance, MAINTENANCE_TOPIC],
      ]) {
        const counters = await rows(
          scratch.db,
          `SELECT "topic", "partition_key" FROM "outbox_stream_sequence"`,
        );
        assert.deepEqual(
          counters.map((c) => [c.topic, c.partition_key]),
          [[topic, ASSET]],
          `${scratch.service} sees a counter that is not its own`,
        );
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Tenant isolation
// ---------------------------------------------------------------------------

test('allocation stays inside the owning service database and keeps tenant metadata', async () => {
  await withOutbox('fleet', async (fleet) => {
    await withOutbox('maintenance', async (maintenance) => {
      // Identical topic and key in both databases: nothing but the connection
      // distinguishes them.
      const before = await scalar(maintenance.db, `SELECT count(*) FROM "outbox_stream_sequence"`);
      for (let i = 0; i < 4; i += 1) {
        await produce(fleet.db, {
          topic: FLEET_TOPIC,
          partitionKey: 'ORG-1-ASSET',
          eventName: 'USAGE_RECORDED',
          aggregateId: `T-${i}`,
        });
      }

      assert.equal(
        await scalar(maintenance.db, `SELECT count(*) FROM "outbox_stream_sequence"`),
        before,
        'allocating in fleet wrote a counter row in maintenance',
      );
      assert.equal(
        await scalar(maintenance.db, `SELECT count(*) FROM "outbox_message"`),
        0,
        'allocating in fleet wrote an outbox row in maintenance',
      );

      // The tenant metadata the envelope already carried is unchanged: B3 adds
      // a counter and a key, and touches nothing about scoping.
      const stored = await rows(
        fleet.db,
        `SELECT "organization_id", "payload"->>'tenantId' AS tenant,
                "headers"->>'x-tenant-id' AS header_tenant
           FROM "outbox_message"`,
      );
      assert.equal(stored.length, 4);
      for (const row of stored) {
        assert.deepEqual(
          [row.organization_id, row.tenant, row.header_tenant],
          ['ORG-B3', 'ORG-B3', 'ORG-B3'],
        );
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Mixed-version behaviour
// ---------------------------------------------------------------------------

test('an old envelope with no stream fields still parses and still stores', async () => {
  await withOutbox('fleet', async ({ db }) => {
    // Exactly what a producer that has not been migrated writes: no
    // streamSeq, no streamKey, no allocation, no counter row.
    const legacy = buildOutboxRow(
      {
        aggregateType: 'Probe',
        aggregateId: 'LEGACY-1',
        eventName: 'USAGE_RECORDED',
        topic: FLEET_TOPIC,
        partitionKey: 'ASSET-OLD',
        payload: { probe: 'legacy' },
        organizationId: 'ORG-B3',
      },
      { producer: 'b3-protocol-test', producerVersion: '0.0.0' },
    );
    assert.equal(legacy.streamSeq, null);
    assert.equal(legacy.headers[EVENT_HEADERS.streamSeq], undefined);

    await db.$executeRawUnsafe(
      `INSERT INTO "outbox_message" (
         "id","aggregate_type","aggregate_id","event_name","event_version",
         "topic","partition_key","payload","headers","organization_id",
         "correlation_id","created_at","attempts","stream_seq"
       ) VALUES ($1,'Probe',$2,'USAGE_RECORDED',1,$3,$4,$5::jsonb,$6::jsonb,'ORG-B3',$7,now(),0,NULL)`,
      legacy.id,
      legacy.aggregateId,
      legacy.topic,
      legacy.partitionKey,
      JSON.stringify(legacy.payload),
      JSON.stringify(legacy.headers),
      legacy.correlationId,
    );

    // A sequenced event on the same stream afterwards, the way a staged
    // rollout produces both shapes side by side.
    const migrated = await produce(db, {
      topic: FLEET_TOPIC,
      partitionKey: 'ASSET-OLD',
      eventName: 'USAGE_RECORDED',
      aggregateId: 'NEW-1',
    });
    assert.equal(migrated.streamSeq, 1);

    // Both rows coexist. The old one keeps a NULL sequence and no header; the
    // partial unique index tolerates it, which is exactly why B1 made it
    // partial.
    const stored = await rows(
      db,
      `SELECT "aggregate_id", "stream_seq"::int AS s,
              "payload" ? 'streamSeq'                  AS has_env_seq,
              "headers" ? '${EVENT_HEADERS.streamSeq}' AS has_header
         FROM "outbox_message" ORDER BY "aggregate_id"`,
    );
    assert.deepEqual(
      stored.map((r) => [r.aggregate_id, r.s, r.has_env_seq, r.has_header]),
      [
        ['LEGACY-1', null, false, false],
        ['NEW-1', 1, true, true],
      ],
    );

    // The relay's claim query is unchanged and selects both, in the same
    // ADR-050 order, with no reference to the sequence. B3 changes what a row
    // carries, not which rows are chosen.
    const claimable = await rows(
      db,
      `SELECT "aggregate_id" FROM "outbox_message"
        WHERE "published_at" IS NULL ORDER BY "created_at", "id"`,
    );
    assert.equal(claimable.length, 2, 'a legacy row stopped being claimable');
  });
});

// ---------------------------------------------------------------------------
// 7. Each producer serializes on the counter row for one stream key
// ---------------------------------------------------------------------------

for (const [service, topic] of [
  ['fleet', FLEET_TOPIC],
  ['maintenance', MAINTENANCE_TOPIC],
  ['supplier', SUPPLIER_TOPIC],
]) {
  test(`${service}: two concurrent transactions on one stream key serialize on the counter row`, async () => {
    // ADR-051 § R4 measured that neither fleet nor maintenance holds a lock on
    // the assetId boundary — maintenance locks `repair_order`, and fleet has no
    // explicit asset lock at all. So the counter row is the *only*
    // serialisation point they have, and each needs its own evidence rather
    // than inheriting the shared helper's.
    //
    // supplier is here for the same reason and one more: its decisions are
    // guarded by a conditional `updateMany`, which serialises the *domain* row
    // but says nothing about the order two events reach one stream in. The
    // counter row is what does that, here as everywhere else.
    await withOutbox(service, async ({ url }) => {
      const a = rawClient(service, url);
      const b = rawClient(service, url);
      try {
        await Promise.all([a.query('SELECT 1'), b.query('SELECT 1')]);

        let firstAllocated;
        let secondSettled = false;
        let releaseA;
        const aHeld = new Promise((resolve) => {
          releaseA = resolve;
        });

        const aDone = a.transaction(async (tx) => {
          firstAllocated = await allocateStreamSeqSql(tx, topic, 'ASSET-CONTENDED');
          await aHeld;
          return firstAllocated;
        });
        aDone.catch(() => {});
        await waitFor(() => firstAllocated, `${service} to allocate and hold the lock`);

        const bDone = b
          .transaction(async (tx) => allocateStreamSeqSql(tx, topic, 'ASSET-CONTENDED'))
          .then((value) => {
            secondSettled = true;
            return value;
          });

        for (let i = 0; i < 200; i += 1) await new Promise(setImmediate);
        assert.equal(
          secondSettled,
          false,
          `${service} did not serialize on the counter row — it has no other lock on this boundary`,
        );

        releaseA();
        assert.equal(await aDone, 1);
        assert.equal(await bDone, 2);
      } finally {
        await a.close();
        await b.close();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 8. supplier-service: its own database, its own counter, keyed by supplierId
// ---------------------------------------------------------------------------

test('supplier: every event on one supplier is one dense stream keyed by supplierId', async () => {
  // The four events this service produces all key on `supplierId` (ADR-036),
  // which is deliberately not the aggregate: a qualification decision is about
  // a qualification, and a suspension about a suspension, but a consumer
  // rebuilding one supplier's standing needs them in one order.
  await withOutbox('supplier', async ({ db }) => {
    const SUPPLIER = 'SUP-STREAM-01';
    const names = [
      ['SUPPLIER_REGISTERED', 'SUP-STREAM-01'],
      ['SUPPLIER_QUALIFIED', 'QLF-1'],
      ['SUPPLIER_SUSPENDED', 'SSP-1'],
      ['SUPPLIER_REJECTED', 'QLF-2'],
    ];

    const produced = [];
    for (const [eventName, aggregateId] of names) {
      produced.push(
        await produce(db, {
          topic: SUPPLIER_TOPIC,
          partitionKey: SUPPLIER,
          eventName,
          aggregateId,
        }),
      );
    }

    // Dense and strictly increasing from 1. A gap is indistinguishable, to a
    // consumer, from a lost event.
    assert.deepEqual(
      produced.map((row) => row.streamSeq),
      [1, 2, 3, 4],
    );

    // Four different aggregates, one stream — the property that would be lost
    // if the key were the aggregate id.
    assert.equal(new Set(produced.map((row) => row.aggregateId)).size, 4);
    assert.equal(new Set(produced.map((row) => row.partitionKey)).size, 1);

    const persisted = await rows(
      db,
      `SELECT "stream_seq", "partition_key", "payload"->>'streamKey' AS envelope_key,
              "payload"->>'streamSeq' AS envelope_seq,
              "headers"->>'${EVENT_HEADERS.streamSeq}' AS header_seq
         FROM "outbox_message" ORDER BY "stream_seq"`,
    );
    for (const [index, row] of persisted.entries()) {
      const expected = index + 1;
      assert.equal(Number(row.stream_seq), expected);
      assert.equal(Number(row.envelope_seq), expected);
      assert.equal(row.header_seq, String(expected));
      assert.equal(row.envelope_key, SUPPLIER);
      assert.equal(row.partition_key, SUPPLIER);
    }

    // `published_seq` is untouched: advancing a head is B4, which is not merged.
    const publishedSeq = await scalar(
      db,
      `SELECT "published_seq" FROM "outbox_stream_sequence"
        WHERE "topic" = '${SUPPLIER_TOPIC}' AND "partition_key" = '${SUPPLIER}'`,
    );
    assert.equal(publishedSeq, 0);
  });
});

test('supplier and fleet share no sequence for the same identifier — the negative test', async () => {
  // The same shape as the fleet/maintenance negative test, and here for the
  // same reason: supplier-service is a new topic, and nobody should later infer
  // that an identifier appearing in two topics implies an order between them.
  // Two databases, two counter tables, no shared lock, no shared transaction
  // (ADR-051 § C-7).
  await withOutbox('supplier', async (supplier) => {
    await withOutbox('fleet', async (fleet) => {
      const SHARED = 'ID-SHARED-ACROSS-TOPICS';

      const first = await produce(supplier.db, {
        topic: SUPPLIER_TOPIC,
        partitionKey: SHARED,
        eventName: 'SUPPLIER_REGISTERED',
        aggregateId: SHARED,
      });
      const second = await produce(fleet.db, {
        topic: FLEET_TOPIC,
        partitionKey: SHARED,
        eventName: 'USAGE_RECORDED',
        aggregateId: SHARED,
      });

      // Both are 1. Not "the second continued the first" — they are unrelated
      // streams that happen to share a key, and each counted from the start.
      assert.equal(first.streamSeq, 1);
      assert.equal(second.streamSeq, 1);

      // And neither database has heard of the other's topic.
      assert.equal(
        await scalar(
          supplier.db,
          `SELECT count(*) FROM "outbox_stream_sequence" WHERE "topic" = '${FLEET_TOPIC}'`,
        ),
        0,
      );
      assert.equal(
        await scalar(
          fleet.db,
          `SELECT count(*) FROM "outbox_stream_sequence" WHERE "topic" = '${SUPPLIER_TOPIC}'`,
        ),
        0,
      );
    });
  });
});
