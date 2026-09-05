import { runUnscoped } from '@rasta/nest-common';
import { AssetRepository } from '../src/asset/asset.repository';
import { AssetService } from '../src/asset/asset.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, id, newPrisma, tenants } from './helpers';

/**
 * ADR-051 Phase B3 in this service, against a real database.
 *
 * The shared protocol suite (`pnpm test:outbox-b3`) proves the allocator. This
 * proves *asset* uses it: a real domain operation commits an outbox row whose
 * persisted `stream_seq`, envelope `streamSeq`, envelope `streamKey` and
 * `x-stream-seq` header all agree, keyed by the stream `routing.ts` chose.
 *
 * Asset is DETECT class under ADR-051 § D-1, so nothing blocks on a gap here —
 * a consumer only needs to be able to *see* one. That is exactly what an
 * allocated sequence gives it, and what it did not have before B3.
 */
describe('asset stream sequencing', () => {
  const org = tenants();
  let prisma: PrismaService;
  let assets: AssetService;

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    // Warm the connection and the query engine before the first transaction.
    // Prisma's interactive transactions time out at 5s, and under a loaded
    // full-suite run the first one was paying engine start-up inside that
    // budget — measuring cold start rather than anything about sequencing.
    await prisma.client.$queryRawUnsafe('SELECT 1');
    assets = new AssetService(new AssetRepository(prisma));
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  /** The four places a sequence appears must all carry the same value. */
  const assertConsistent = (row: {
    partitionKey: string;
    streamSeq: bigint | null;
    payload: unknown;
    headers: unknown;
  }): number => {
    const envelope = row.payload as { streamSeq?: number; streamKey?: string };
    const headers = row.headers as Record<string, string>;

    expect(row.streamSeq).not.toBeNull();
    const persisted = Number(row.streamSeq);
    expect(envelope.streamSeq).toBe(persisted);
    expect(envelope.streamKey).toBe(row.partitionKey);
    expect(headers['x-stream-seq']).toBe(String(persisted));
    return persisted;
  };

  const outboxFor = (aggregateId: string) =>
    runUnscoped('the outbox audit reads platform plumbing', () =>
      prisma.client.outboxMessage.findMany({
        where: { aggregateId },
        orderBy: { createdAt: 'asc' },
      }),
    );

  it('creates an asset and commits a sequenced row keyed by the asset', async () => {
    const created = await asActor({ organizationId: org.a, userId: `USR-B3-${id('X')}` }, () =>
      assets.create({
        name: 'بیل مکانیکی B3',
        type: 'EXCAVATOR',
        specifications: {},
      } as never),
    );

    const rows = await outboxFor(created.id);
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.topic).toBe('rasta.asset.v1');
      // Aggregate-scoped, now stated in `routing.ts` rather than left to the
      // `buildOutboxRow` default.
      expect(row.partitionKey).toBe(created.id);
      assertConsistent(row);
    }

    // Dense from 1: a brand-new machine is a brand-new stream.
    expect(rows.map((row) => Number(row.streamSeq))).toEqual(rows.map((_row, index) => index + 1));
  });

  it('continues the same asset stream on a second operation', async () => {
    const created = await asActor({ organizationId: org.a, userId: `USR-B3-${id('X')}` }, () =>
      assets.create({
        name: 'لودر B3',
        type: 'LOADER',
        specifications: {},
      } as never),
    );
    const first = (await outboxFor(created.id)).length;

    await asActor({ organizationId: org.a, userId: `USR-B3-${id('X')}` }, () =>
      assets.update(created.id, { name: 'لودر B3 — به‌روزشده' } as never),
    );

    const rows = await outboxFor(created.id);
    expect(rows.length).toBeGreaterThan(first);
    // One stream, continuing without a gap. If the update had been keyed
    // differently it would have started its own count at 1.
    expect(rows.map((row) => Number(row.streamSeq))).toEqual(rows.map((_row, index) => index + 1));
  });
});
