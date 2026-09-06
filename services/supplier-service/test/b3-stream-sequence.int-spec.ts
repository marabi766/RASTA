import { runUnscoped } from '@rasta/nest-common';
import {
  asOperator,
  asSupplier,
  cleanup,
  newOrganizationId,
  outboxFor,
  wire,
  type Wiring,
} from './helpers';

/**
 * ADR-051 Phase B3 in this service, against a real database.
 *
 * **NOT RUN.** Written in a phase whose verification boundary excludes shared
 * infrastructure: no `docker compose`, no `pnpm infra:*`, no migration against
 * `rasta_supplier`. Every assertion below is prepared and unexecuted, and the
 * phase report says so rather than implying otherwise. Running it is an
 * Integration Handoff item and the first run should be treated as a first run.
 *
 * ## What this file is for, and what it is not
 *
 * The shared protocol suite (`pnpm test:outbox-b3`) proves the *allocator*: the
 * upsert, the row lock, allocation order equalling commit order, a rollback
 * returning the number. None of that is re-asserted here — this proves
 * *supplier* uses it, through a real domain operation, with the key
 * `routing.ts` chose and nothing invented in between.
 *
 * The distinction that makes this service worth its own file is the one
 * `routing.ts` documents: `SUPPLIER_QUALIFIED` is *about* a `Qualification`,
 * `SUPPLIER_SUSPENDED` is *about* a `Suspension`, and both are *ordered by* the
 * `supplierId`, which is neither aggregate's id. B3 allocates against the
 * ordering key, never the aggregate (ADR-051 § C-7). If it allocated against
 * the aggregate, a supplier's approval and its later suspension would each be
 * "sequence 1" of two different streams, and the consumer that hides an offer
 * on suspension could apply them in either order — which is precisely the
 * failure the key exists to prevent.
 *
 * ## What is deliberately absent
 *
 * Nothing here asserts a delivery, a consumer, head-of-line claiming (B4), gap
 * detection (B5) or `published_seq` advancing. `published_seq` is asserted to
 * stay at 0 exactly because B4 is not merged, and a value other than 0 would
 * mean something wrote it that should not have.
 */
describe('supplier stream sequencing', () => {
  let w: Wiring;
  const organizations: string[] = [];

  beforeAll(async () => {
    w = wire();
    await w.prisma.onModuleInit();
    // Warm the connection and the query engine before the first transaction.
    // Prisma's interactive transactions time out at 5s, and under a loaded
    // full-suite run the first one pays engine start-up inside that budget —
    // measuring cold start rather than anything about sequencing.
    await runUnscoped('warm-up touches no model', () =>
      w.prisma.client.$queryRawUnsafe('SELECT 1'),
    );
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.prisma.onModuleDestroy();
  });

  function organization(): string {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  }

  /**
   * The places a sequence appears must all carry the same value, and the key
   * must be the one the row is partitioned by.
   *
   * A consumer reading the header, one reading the envelope and an operator
   * reading the table must not be able to form three different pictures of the
   * same stream.
   */
  function assertConsistent(row: {
    partitionKey: string;
    streamSeq: bigint | null;
    payload: unknown;
    headers: unknown;
  }): number {
    const envelope = row.payload as { streamSeq?: number; streamKey?: string };
    const headers = row.headers as Record<string, string>;

    expect(row.streamSeq).not.toBeNull();
    const persisted = Number(row.streamSeq);
    expect(envelope.streamSeq).toBe(persisted);
    expect(envelope.streamKey).toBe(row.partitionKey);
    expect(headers['x-stream-seq']).toBe(String(persisted));
    return persisted;
  }

  /** The counter row a stream allocates from, read directly. */
  function counterFor(supplierId: string) {
    return runUnscoped('B3 verification reads the counter table', () =>
      w.prisma.client.outboxStreamSequence.findUnique({
        where: { topic_partitionKey: { topic: 'rasta.supplier.v1', partitionKey: supplierId } },
      }),
    );
  }

  it('gives the first event on a supplier stream sequence 1', async () => {
    const org = organization();

    const supplier = await asSupplier(org, () =>
      w.suppliers.register({ displayName: 'اولین تأمین‌کننده', capabilities: ['GOODS_SUPPLY'] }),
    );

    const rows = await outboxFor(w.prisma, org);
    expect(rows).toHaveLength(1);

    const [row] = rows;
    expect(row.eventName).toBe('SUPPLIER_REGISTERED');
    expect(row.topic).toBe('rasta.supplier.v1');
    expect(row.partitionKey).toBe(supplier.id);
    // A brand-new supplier is a brand-new stream, and a brand-new stream starts
    // at 1 — not at 0, and not at whatever another stream happened to reach.
    expect(assertConsistent(row)).toBe(1);
  });

  it('continues the same supplier stream across the whole lifecycle', async () => {
    const org = organization();

    const supplier = await asSupplier(org, () =>
      w.suppliers.register({ displayName: 'کارگاه نمونه', capabilities: ['WORKSHOP_SERVICE'] }),
    );
    const submitted = await asSupplier(org, () =>
      w.qualifications.submit(supplier.id, { capability: 'WORKSHOP_SERVICE', evidence: [] }),
    );
    await asOperator(() => w.qualifications.approve(supplier.id, submitted.id, {}));
    await asOperator(() =>
      w.suspensions.suspend(supplier.id, { reason: 'یک دلیل ثبت‌شده برای تعلیق' }),
    );

    const rows = await outboxFor(w.prisma, org);
    expect(rows.map((row) => row.eventName)).toEqual([
      'SUPPLIER_REGISTERED',
      'SUPPLIER_QUALIFIED',
      'SUPPLIER_SUSPENDED',
    ]);

    // One stream. Every event about this supplier is on one key, and the
    // sequence is dense from 1 with no gap and no restart — even though the
    // three events are about three *different* aggregates.
    for (const row of rows) {
      expect(row.partitionKey).toBe(supplier.id);
      assertConsistent(row);
    }
    expect(rows.map((row) => Number(row.streamSeq))).toEqual([1, 2, 3]);

    // The qualification is about a Qualification and the suspension about a
    // Suspension; neither aggregate id is the stream. B3 allocated against the
    // ordering key (ADR-051 § C-7), which is the point of this file.
    const qualified = rows[1];
    expect(qualified.aggregateType).toBe('Qualification');
    expect(qualified.aggregateId).toBe(submitted.id);
    expect(qualified.aggregateId).not.toBe(qualified.partitionKey);
  });

  it('starts a second supplier at 1, independent of the first', async () => {
    const first = organization();
    const second = organization();

    // Take the first supplier's stream past 1, so a shared counter would show.
    const supplierA = await asSupplier(first, () =>
      w.suppliers.register({ displayName: 'تأمین‌کننده الف', capabilities: ['GOODS_SUPPLY'] }),
    );
    await asOperator(() =>
      w.suspensions.suspend(supplierA.id, { reason: 'یک دلیل ثبت‌شده برای تعلیق' }),
    );
    expect((await outboxFor(w.prisma, first)).map((row) => Number(row.streamSeq))).toEqual([1, 2]);

    const supplierB = await asSupplier(second, () =>
      w.suppliers.register({ displayName: 'تأمین‌کننده ب', capabilities: ['CONTRACTING'] }),
    );

    const rowsB = await outboxFor(w.prisma, second);
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0].partitionKey).toBe(supplierB.id);
    // A different supplier is a different stream. It counts from 1; it does not
    // continue anybody else's count, and it does not skip ahead of it — which a
    // counter keyed by topic alone, rather than by `(topic, partition_key)`,
    // would have made impossible.
    expect(assertConsistent(rowsB[0])).toBe(1);
    expect((await counterFor(supplierA.id))?.nextSeq).toBe(3n);
    expect((await counterFor(supplierB.id))?.nextSeq).toBe(2n);
  });

  it('leaves published_seq at zero — advancing it is B4, which is not merged', async () => {
    const org = organization();

    const supplier = await asSupplier(org, () =>
      w.suppliers.register({ displayName: 'شمارنده', capabilities: ['GOODS_SUPPLY'] }),
    );

    const counter = await counterFor(supplier.id);

    expect(counter).not.toBeNull();
    // One number handed out, so the counter points at the next one.
    expect(counter?.nextSeq).toBe(2n);
    // Nothing in the producer path touches this column, and nothing should
    // until B4 advances it inside the acknowledgement transaction.
    expect(counter?.publishedSeq).toBe(0n);
  });

  it('consumes no number when the transaction rolls back', async () => {
    // The property a BIGSERIAL does not have. `nextval()` is not transactional:
    // a rolled-back transaction burns the number permanently and leaves a hole
    // a consumer cannot tell from a lost event. The counter is an ordinary row,
    // so it rolls back too and the next event receives the same number.
    const org = organization();

    const supplier = await asSupplier(org, () =>
      w.suppliers.register({ displayName: 'بازگشتی', capabilities: ['GOODS_SUPPLY'] }),
    );
    expect((await counterFor(supplier.id))?.nextSeq).toBe(2n);

    const boom = new Error('a domain failure after the event was enqueued');
    await expect(
      asSupplier(org, () =>
        w.prisma.transaction(async (tx) => {
          await w.events.enqueue(tx, {
            eventName: 'SUPPLIER_REGISTERED',
            aggregateId: supplier.id,
            organizationId: org,
            payload: {
              supplierId: supplier.id,
              organizationId: org,
              displayName: 'بازگشتی',
              capabilities: ['GOODS_SUPPLY'],
              registeredBy: 'USR_ROLLBACK',
              registeredAt: new Date().toISOString(),
            },
          });
          throw boom;
        }),
      ),
    ).rejects.toThrow(boom);

    // The number was allocated and given back: the counter is where it was.
    expect((await counterFor(supplier.id))?.nextSeq).toBe(2n);
    // And no row survived the rollback, so the stream has no gap either.
    expect(await outboxFor(w.prisma, org)).toHaveLength(1);

    // The next real event takes the number the rolled-back one had held.
    await asOperator(() =>
      w.suspensions.suspend(supplier.id, { reason: 'یک دلیل ثبت‌شده برای تعلیق' }),
    );
    const rows = await outboxFor(w.prisma, org);
    expect(rows.map((row) => Number(row.streamSeq))).toEqual([1, 2]);
  });
});
