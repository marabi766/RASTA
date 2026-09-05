import { cleanup, newPrisma, outboxFor, publishOffer, tenants, wire } from './helpers';
import type { Wiring } from './helpers';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * ADR-051 Phase B3 in this service, against a real database.
 *
 * The shared protocol suite (`pnpm test:outbox-b3`) proves the allocator. This
 * proves *marketplace* uses it: a real domain operation commits an outbox row
 * whose persisted `stream_seq`, envelope `streamSeq`, envelope `streamKey` and
 * `x-stream-seq` header all agree, keyed by the stream `routing.ts` chose.
 *
 * `rasta.marketplace.v1 + orderId` is a STRICT stream under ADR-051 § B4, and
 * this service is where ADR-036's split between *aggregate identity* and
 * *partition ordering* is sharpest — `REVIEW_SUBMITTED` is about a Review but
 * is ordered by the order. B3 allocates against the ordering key, not the
 * aggregate, and that is what this file pins.
 */
describe('marketplace stream sequencing', () => {
  const org = tenants();
  let prisma: PrismaService;
  let wiring: Wiring;

  beforeAll(async () => {
    prisma = newPrisma();
    wiring = wire(prisma);
    await cleanup(prisma, [org.buyer, org.supplier, org.other]);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.buyer, org.supplier, org.other]);
    await prisma.onModuleDestroy();
  });

  /**
   * The four places a sequence appears must all carry the same value, and the
   * key must be the one the row is partitioned by.
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

  it('publishes an offer and commits a sequenced row keyed by the offer', async () => {
    const { offerId } = await publishOffer(wiring, org.supplier);

    const rows = (await outboxFor(prisma, org.supplier)).filter(
      (row) => row.eventName === 'OFFER_PUBLISHED',
    );
    expect(rows).toHaveLength(1);

    const [row] = rows;
    expect(row.topic).toBe('rasta.marketplace.v1');
    expect(row.partitionKey).toBe(offerId);
    expect(assertConsistent(row)).toBe(1);
  });

  it('gives a second offer its own stream, starting at 1', async () => {
    const { offerId } = await publishOffer(wiring, org.supplier, { name: 'قطعه دوم' });

    const rows = (await outboxFor(prisma, org.supplier)).filter(
      (row) => row.eventName === 'OFFER_PUBLISHED' && row.partitionKey === offerId,
    );
    expect(rows).toHaveLength(1);
    // A different offer is a different stream: it counts from 1, it does not
    // continue the first offer's count.
    expect(assertConsistent(rows[0])).toBe(1);
  });
});
