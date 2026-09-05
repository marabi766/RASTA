import { PrismaService } from '../src/prisma/prisma.service';
import { FleetRepository } from '../src/fleet/fleet.repository';
import { UsageService } from '../src/fleet/usage.service';
import { DriverService } from '../src/fleet/driver.service';
import { asActor, cleanup, id, newPrisma, tenants } from './helpers';

/**
 * ADR-051 Phase B3 in this service, against a real database.
 *
 * The shared protocol suite (`pnpm test:outbox-b3`) proves the allocator. This
 * proves *fleet* uses it: that a real domain operation commits an outbox row
 * whose persisted `stream_seq`, envelope `streamSeq`, envelope `streamKey` and
 * `x-stream-seq` header all agree, and that this service's own routing policy
 * decided the stream.
 *
 * Fleet is the service that needs its own evidence most. ADR-051 § R4 measured
 * that it holds **no domain lock on the `assetId` boundary**, so the counter
 * row taken inside the domain transaction is its only serialisation point —
 * and the routing policy that picks `assetId` for asset-scoped events and
 * `driverId` for driver-scoped ones was, until B3, spread across six call
 * sites.
 */
describe('fleet stream sequencing', () => {
  const org = tenants();
  let prisma: PrismaService;
  let repository: FleetRepository;
  let usage: UsageService;
  let drivers: DriverService;

  const driverId = id('DRV');
  const assetId = id('AST');
  const userId = `USR-B3-${id('X').slice(-8)}`;

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    repository = new FleetRepository(prisma);
    usage = new UsageService(repository);
    drivers = new DriverService(repository);
    await cleanup(prisma, [org.a, org.b]);

    await asActor({ organizationId: org.a }, async () => {
      await prisma.client.driver.create({
        data: { id: driverId, userId, createdBy: 'B3TEST', updatedBy: 'B3TEST' },
      });
      await prisma.client.assetRef.create({
        data: {
          id: assetId,
          organizationId: org.a,
          status: 'ACTIVE',
          syncedAt: new Date(),
          sourceEvent: 'B3TEST',
        },
      });
    });
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await prisma.onModuleDestroy();
  });

  /** Every outbox row this service wrote, newest last. */
  const outbox = async () =>
    asActor({ organizationId: org.a }, () =>
      prisma.client.outboxMessage.findMany({ orderBy: { createdAt: 'asc' } }),
    );

  /**
   * The assertion this file exists for: the four places a sequence appears all
   * carry the same value, and the key is the one the row is partitioned by.
   */
  const assertConsistent = (row: {
    partitionKey: string;
    streamSeq: bigint | null;
    payload: unknown;
    headers: unknown;
  }) => {
    const envelope = row.payload as { streamSeq?: number; streamKey?: string };
    const headers = row.headers as Record<string, string>;

    expect(row.streamSeq).not.toBeNull();
    const persisted = Number(row.streamSeq);

    expect(envelope.streamSeq).toBe(persisted);
    expect(envelope.streamKey).toBe(row.partitionKey);
    expect(headers['x-stream-seq']).toBe(String(persisted));
    return persisted;
  };

  it('records usage and commits a sequenced row keyed by the asset', async () => {
    await asActor({ organizationId: org.a, userId }, () =>
      usage.record({
        assetId,
        periodStart: '2026-08-27T06:00:00.000Z',
        periodEnd: '2026-08-27T14:00:00.000Z',
        hours: '7.50',
        source: 'MANUAL',
      } as never),
    );

    const rows = await outbox();
    const recorded = rows.filter((row) => row.eventName === 'USAGE_RECORDED');
    expect(recorded).toHaveLength(1);

    const [row] = recorded;
    expect(row.topic).toBe('rasta.fleet.v1');
    // Asset-scoped, from `routing.ts` and no longer from the call site.
    expect(row.partitionKey).toBe(assetId);
    expect(assertConsistent(row)).toBe(1);

    // And the counter the sequence came from is this service's own, at the
    // position B3's next allocation continues from.
    const counters = await asActor({ organizationId: org.a }, () =>
      prisma.client.$queryRawUnsafe<{ topic: string; partition_key: string; next_seq: bigint }[]>(
        `SELECT "topic", "partition_key", "next_seq"
           FROM "outbox_stream_sequence" WHERE "partition_key" = $1`,
        assetId,
      ),
    );
    expect(counters).toHaveLength(1);
    expect(counters[0].topic).toBe('rasta.fleet.v1');
    expect(Number(counters[0].next_seq)).toBe(2);
  });

  it('gives a driver-scoped event its own stream, keyed by the driver', async () => {
    await asActor({ organizationId: org.a, userId }, () =>
      drivers.changeStatus(driverId, { status: 'SUSPENDED', reason: 'B3 evidence' } as never),
    );

    const rows = await outbox();
    const changed = rows.filter((row) => row.eventName === 'DRIVER_STATUS_CHANGED');
    expect(changed).toHaveLength(1);

    const [row] = changed;
    // Driver-scoped: a different stream from the asset's, with its own count
    // starting at 1 — the two do not share a counter.
    expect(row.partitionKey).toBe(driverId);
    expect(assertConsistent(row)).toBe(1);
  });

  it('numbers consecutive events on one asset stream without a gap', async () => {
    for (const day of ['28', '29']) {
      await asActor({ organizationId: org.a, userId }, () =>
        usage.record({
          assetId,
          periodStart: `2026-08-${day}T06:00:00.000Z`,
          periodEnd: `2026-08-${day}T14:00:00.000Z`,
          hours: '4.00',
          source: 'MANUAL',
        } as never),
      );
    }

    const rows = await outbox();
    const onAsset = rows
      .filter((row) => row.partitionKey === assetId)
      .map((row) => Number(row.streamSeq));

    // Dense and strictly increasing from 1. A gap here would be
    // indistinguishable, to a consumer, from a lost event.
    expect(onAsset).toEqual([1, 2, 3]);
  });
});
