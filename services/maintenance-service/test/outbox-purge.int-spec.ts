import { withUtcSession } from '@rasta/config';
import {
  allocateStreamSeqSql,
  OutboxPurgeScheduler,
  OutboxRelay,
  type OutboxPurgeSchedulerOptions,
  type OutboxRow,
} from '@rasta/nest-common';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import { PrismaService } from '../src/prisma/prisma.service';
import { databaseUrl } from './helpers';

/**
 * D-052 in maintenance-service, against a real PostgreSQL: the scheduled purge
 * deletes published rows past the retention and nothing else, stays bounded,
 * never waits on another session, and leaves the relay and `stream_seq` as
 * they were.
 *
 * It runs in its own schema. The purge and the relay both work across the
 * whole table by design — neither filters by tenant — so against the shared
 * `public` schema "exactly these rows were deleted" or "the relay published
 * exactly these" would be claims about what every other suite left behind,
 * and the relay would publish their rows. The tables are created with
 * `LIKE public.… INCLUDING ALL`, so they carry this service's real columns,
 * CHECK constraints and indexes — the B-tree on `created_at` the purge walks — rather than a hand-copied
 * approximation.
 */
const SCHEMA = 'outbox_purge_test';
const RETENTION_HOURS = 168;
const TOPIC = 'rasta.purge-test.v1';

/** The owner of the database: the runtime role may create nothing (D-045). */
function ownerUrl(): string {
  const url = process.env.DATABASE_URL_MAINTENANCE_MIGRATOR;
  if (!url) {
    throw new Error(
      'DATABASE_URL_MAINTENANCE_MIGRATOR is not set. The isolated schema is created as the owner, never the ' +
        'runtime role; see .env.migrator.example (docs/23 D-045).',
    );
  }
  return withUtcSession(url);
}

function schemaUrl(): string {
  const url = new URL(databaseUrl());
  url.searchParams.set('schema', SCHEMA);
  return url.toString();
}

const runtimeRole = () => decodeURIComponent(new URL(databaseUrl()).username);

interface Seed {
  /** Hours before the database's now(). */
  createdHoursAgo: number;
  /** `null` = unpublished. */
  publishedHoursAgo: number | null;
  /** A live claim (unpublished rows only, per `ck_outbox_published_is_clean`). */
  claimed?: boolean;
  lastError?: string;
  partitionKey?: string;
  streamSeq?: number;
}

describe('maintenance-service outbox purge (D-052)', () => {
  let runtime: PrismaService;
  let holder: PrismaService;
  let store: PrismaOutboxStore;

  const purge = (overrides: Partial<OutboxPurgeSchedulerOptions> = {}) =>
    new OutboxPurgeScheduler({
      store,
      service: 'maintenance-service-purge-itest',
      enabled: true,
      retentionHours: RETENTION_HOURS,
      intervalMs: 60_000,
      batchSize: 1000,
      maxBatchesPerRun: 10,
      statementTimeoutMs: 5000,
      maxWaitMs: 2000,
      ...overrides,
    });

  /** Times come from the database clock, as the purge's own cutoff does. */
  const seed = async (id: string, row: Seed): Promise<string> => {
    await runtime.client.$executeRawUnsafe(
      `INSERT INTO outbox_message
         (id, aggregate_type, aggregate_id, event_name, event_version, topic, partition_key,
          payload, headers, organization_id, correlation_id, created_at, published_at,
          attempts, last_error, claim_token, claim_owner, claim_expires_at, claim_count, stream_seq)
       VALUES ($1, 'PurgeProbe', $1, 'PURGE_PROBE', 1, $2, $3, '{}'::jsonb, '{}'::jsonb,
               'ORG-PURGE', $1,
               now() - make_interval(hours => $4::int),
               CASE WHEN $5::int IS NULL THEN NULL ELSE now() - make_interval(hours => $5::int) END,
               0, $6,
               CASE WHEN $7 THEN 'tok-' || $1 END,
               CASE WHEN $7 THEN 'itest' END,
               CASE WHEN $7 THEN now() + interval '10 minutes' END,
               CASE WHEN $7 THEN 1 ELSE 0 END,
               $8)`,
      id,
      TOPIC,
      row.partitionKey ?? id,
      row.createdHoursAgo,
      row.publishedHoursAgo,
      row.lastError ?? null,
      row.claimed ?? false,
      row.streamSeq ?? null,
    );
    return id;
  };

  const ids = async (): Promise<string[]> =>
    (
      await runtime.client.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM outbox_message ORDER BY id`,
      )
    ).map((row) => row.id);

  /** Holds `sql` inside an open transaction on the second connection until released. */
  const hold = async (sql: string, ...values: unknown[]) => {
    let letGo!: () => void;
    const gate = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    let ready!: () => void;
    const held = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const tx = holder.client.$transaction(
      async (client) => {
        await client.$queryRawUnsafe(sql, ...values);
        ready();
        await gate;
      },
      { timeout: 60_000, maxWait: 60_000 },
    );
    tx.catch(() => undefined);
    // A holding statement that fails must fail the test, not leave it waiting.
    await Promise.race([held, tx.then(() => Promise.reject(new Error('hold ended early')))]);
    return () => {
      letGo();
      return tx;
    };
  };

  beforeAll(async () => {
    const owner = new PrismaService(ownerUrl());
    try {
      await owner.client.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await owner.client.$executeRawUnsafe(`CREATE SCHEMA "${SCHEMA}"`);
      await owner.client.$executeRawUnsafe(
        `CREATE TABLE "${SCHEMA}".outbox_message (LIKE public.outbox_message INCLUDING ALL)`,
      );
      await owner.client.$executeRawUnsafe(
        `CREATE TABLE "${SCHEMA}".outbox_stream_sequence
           (LIKE public.outbox_stream_sequence INCLUDING ALL)`,
      );
      await owner.client.$executeRawUnsafe(
        `GRANT USAGE ON SCHEMA "${SCHEMA}" TO "${runtimeRole()}"`,
      );
      await owner.client.$executeRawUnsafe(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${SCHEMA}"
           TO "${runtimeRole()}"`,
      );
    } finally {
      await owner.onModuleDestroy();
    }
    runtime = new PrismaService(schemaUrl());
    holder = new PrismaService(schemaUrl());
    await runtime.onModuleInit();
    await holder.onModuleInit();
    store = new PrismaOutboxStore(runtime);
  });

  beforeEach(async () => {
    await runtime.client.$executeRawUnsafe(`DELETE FROM outbox_message`);
    await runtime.client.$executeRawUnsafe(`DELETE FROM outbox_stream_sequence`);
  });

  afterAll(async () => {
    await runtime?.onModuleDestroy();
    await holder?.onModuleDestroy();
    const owner = new PrismaService(ownerUrl());
    try {
      await owner.client.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    } finally {
      await owner.onModuleDestroy();
    }
  });

  it('deletes published rows past the retention and keeps every other row', async () => {
    await seed('A_OLD_PUBLISHED_1', { createdHoursAgo: 200, publishedHoursAgo: 199 });
    await seed('A_OLD_PUBLISHED_2', { createdHoursAgo: 400, publishedHoursAgo: 399 });
    // Published inside the window.
    await seed('B_YOUNG_PUBLISHED', { createdHoursAgo: 2, publishedHoursAgo: 1 });
    // Created long ago but published recently: the retention counts from publication.
    await seed('C_LATE_PUBLISHED', { createdHoursAgo: 400, publishedHoursAgo: 1 });
    // Never delivered, however old.
    await seed('D_OLD_UNPUBLISHED', { createdHoursAgo: 400, publishedHoursAgo: null });
    await seed('E_OLD_CLAIMED', { createdHoursAgo: 400, publishedHoursAgo: null, claimed: true });
    // outbox-stuck.md cause C: marked published by hand, never delivered, kept.
    await seed('F_MANUALLY_SKIPPED', {
      createdHoursAgo: 400,
      publishedHoursAgo: 399,
      lastError: 'MANUALLY SKIPPED — incident 42',
    });
    // An ordinary earlier failure does not protect a row that was then published.
    await seed('G_OLD_PUBLISHED_AFTER_RETRY', {
      createdHoursAgo: 300,
      publishedHoursAgo: 299,
      lastError: 'KafkaJSError: timeout',
    });

    const run = await purge().runOnce();

    expect(run).toMatchObject({ outcome: 'completed', deleted: 3, batches: 1 });
    expect(await ids()).toEqual([
      'B_YOUNG_PUBLISHED',
      'C_LATE_PUBLISHED',
      'D_OLD_UNPUBLISHED',
      'E_OLD_CLAIMED',
      'F_MANUALLY_SKIPPED',
    ]);
  });

  it('stays bounded: batch size and batches per run cap a run, and the next one continues', async () => {
    for (let i = 0; i < 25; i++) {
      await seed(`OLD_${String(i).padStart(2, '0')}`, {
        createdHoursAgo: 200,
        publishedHoursAgo: 199,
      });
    }
    const scheduler = purge({ batchSize: 10, maxBatchesPerRun: 2 });

    expect(await scheduler.runOnce()).toMatchObject({
      outcome: 'truncated',
      deleted: 20,
      batches: 2,
    });
    expect(await ids()).toHaveLength(5);
    expect(await scheduler.runOnce()).toMatchObject({
      outcome: 'completed',
      deleted: 5,
      batches: 1,
    });
    expect(await ids()).toHaveLength(0);
  });

  it('ends as `busy` at once while another replica holds the purge lock', async () => {
    await seed('OLD', { createdHoursAgo: 200, publishedHoursAgo: 199 });
    const release = await hold(
      // `::text` because Prisma cannot read a `void` column.
      `SELECT pg_advisory_xact_lock(hashtext('rasta.outbox_purge'), hashtext(current_schema()))::text`,
    );
    try {
      expect(await purge().runOnce()).toMatchObject({ outcome: 'busy', deleted: 0 });
      expect(await ids()).toEqual(['OLD']);
    } finally {
      await release();
    }
    expect(await purge().runOnce()).toMatchObject({ outcome: 'completed', deleted: 1 });
  });

  it('skips a row another session has locked instead of waiting for it', async () => {
    await seed('OLD_FREE', { createdHoursAgo: 200, publishedHoursAgo: 199 });
    await seed('OLD_LOCKED', { createdHoursAgo: 200, publishedHoursAgo: 199 });
    const release = await hold(
      `SELECT id FROM outbox_message WHERE id = $1 FOR UPDATE`,
      'OLD_LOCKED',
    );
    try {
      // A short statement timeout: had the purge waited on the lock, this run
      // would fail instead of completing.
      expect(await purge({ statementTimeoutMs: 1000 }).runOnce()).toMatchObject({
        outcome: 'completed',
        deleted: 1,
      });
      expect(await ids()).toEqual(['OLD_LOCKED']);
    } finally {
      await release();
    }
  });

  // Codex r1 on #247: the wait for a connection was given the transaction's
  // own timeout (statement + 5 s) and was in no shutdown budget. Now it is
  // OUTBOX_PURGE_MAX_WAIT_MS on its own, and stop() is bounded by the sum.
  it('gives up on a busy pool after maxWaitMs, and stop() returns within the batch bound', async () => {
    await seed('OLD', { createdHoursAgo: 200, publishedHoursAgo: 199 });
    const single = new URL(schemaUrl());
    single.searchParams.set('connection_limit', '1');
    const starved = new PrismaService(single.toString());
    await starved.onModuleInit();
    // The pool's one connection, held in an open transaction.
    let letGo!: () => void;
    const gate = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    let ready!: () => void;
    const held = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const holding = starved.client.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe('SELECT 1');
        ready();
        await gate;
      },
      { timeout: 60_000, maxWait: 60_000 },
    );
    try {
      await held;
      const scheduler = purge({
        store: new PrismaOutboxStore(starved),
        maxWaitMs: 300,
        statementTimeoutMs: 5000,
        initialDelayMs: 0,
      });
      // Before r1 this waited statement + 5 s = 10 s for the connection.
      const startedAt = Date.now();
      const run = await scheduler.runOnce();
      expect(run).toMatchObject({ outcome: 'failed', deleted: 0, batches: 0 });
      expect(Date.now() - startedAt).toBeLessThan(3000);

      // Shutdown with a batch stuck waiting for that connection.
      scheduler.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const stopAt = Date.now();
      await scheduler.stop();
      expect(Date.now() - stopAt).toBeLessThan(scheduler.stopBoundMs);
      expect(await ids()).toEqual(['OLD']);
    } finally {
      letGo();
      await holding;
      await starved.onModuleDestroy();
    }
    // The pool free again, the same row goes.
    expect(await purge().runOnce()).toMatchObject({ outcome: 'completed', deleted: 1 });
  });

  it('leaves the relay and the stream sequence exactly as they were', async () => {
    const published: OutboxRow[] = [];
    const relay = new OutboxRelay({
      store,
      publisher: {
        publish: async (rows) => {
          published.push(...rows);
        },
      },
      batchSize: 100,
      leaseSeconds: 60,
    });
    const KEY = 'STREAM-1';
    const write = (id: string) =>
      runtime.client.$transaction(async (tx) => {
        const streamSeq = await allocateStreamSeqSql(tx, TOPIC, KEY);
        await tx.$executeRawUnsafe(
          `INSERT INTO outbox_message
             (id, aggregate_type, aggregate_id, event_name, event_version, topic, partition_key,
              payload, headers, organization_id, correlation_id, stream_seq)
           VALUES ($1, 'PurgeProbe', $1, 'PURGE_PROBE', 1, $2, $3, '{}'::jsonb, '{}'::jsonb,
                   'ORG-PURGE', $1, $4)`,
          id,
          TOPIC,
          KEY,
          streamSeq,
        );
        return streamSeq;
      });

    // Three events on one stream, relayed as in production.
    expect([await write('S1'), await write('S2'), await write('S3')]).toEqual([1, 2, 3]);
    expect(await relay.tick()).toBe(3);
    expect(published.map((row) => row.streamSeq)).toEqual([1, 2, 3]);

    // Their publication falls past the retention, and the purge removes them all.
    await runtime.client.$executeRawUnsafe(
      `UPDATE outbox_message
          SET created_at = now() - make_interval(hours => 400),
              published_at = now() - make_interval(hours => 399)`,
    );
    expect(await purge().runOnce()).toMatchObject({ outcome: 'completed', deleted: 3 });
    expect(await ids()).toEqual([]);

    // The counter is the stream's memory, not the rows: untouched.
    const counter = await runtime.client.$queryRawUnsafe<{ next_seq: bigint }[]>(
      `SELECT next_seq FROM outbox_stream_sequence WHERE topic = $1 AND partition_key = $2`,
      TOPIC,
      KEY,
    );
    expect(counter.map((row) => Number(row.next_seq))).toEqual([4]);

    // The next event continues at 4 — no number reused, no gap for a consumer
    // to mistake for a lost event — and the relay publishes it as before.
    expect(await write('S4')).toBe(4);
    expect(await relay.tick()).toBe(1);
    expect(published.map((row) => row.streamSeq)).toEqual([1, 2, 3, 4]);
    const [row] = await runtime.client.$queryRawUnsafe<{ published_at: Date | null }[]>(
      `SELECT published_at FROM outbox_message WHERE id = 'S4'`,
    );
    expect(row?.published_at).not.toBeNull();
    await relay.stop();
  });
});
