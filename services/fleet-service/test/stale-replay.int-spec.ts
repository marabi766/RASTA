import type { EventEnvelope } from '@rasta/contracts';
import { registry } from '@rasta/observability';
import { AssetSyncConsumer } from '../src/consumers/asset-sync.consumer';
import { FleetRepository } from '../src/fleet/fleet.repository';
import type { PrismaService } from '../src/prisma/prisma.service';
import { id, newPrisma, tenants } from './helpers';

/**
 * D-039 — a record replayed from `<topic>.retry` after a newer event was applied
 * must not set the replica back. `<topic>` and `<topic>.retry` are separate
 * streams, so the same key does not order across them; the consumer keeps the
 * position of the last state-setting event per producer.
 *
 * Database only: the handler is driven directly, as the consumer would.
 */
describe('asset replica: an older event replayed after a newer one (D-039)', () => {
  const org = tenants();
  let prisma: PrismaService;
  let repository: FleetRepository;
  let sync: AssetSyncConsumer;
  const assets: string[] = [];
  const eventIds: string[] = [];

  function event(
    eventName: string,
    assetId: string,
    seq: number | undefined,
    producer: string,
    payload: Record<string, unknown> = {},
    tenantId: string = org.a,
  ): EventEnvelope {
    const eventId = id('EVT');
    eventIds.push(eventId);
    return {
      eventId,
      eventName,
      eventVersion: 1,
      // The clock is deliberately not the order: the sequence is.
      occurredAt: '2026-09-29T10:00:00.000Z',
      producer,
      producerVersion: '0.1.0',
      aggregateType: 'Asset',
      aggregateId: assetId,
      tenantId,
      correlationId: id('COR'),
      ...(seq === undefined ? {} : { streamSeq: seq, streamKey: assetId }),
      payload: { assetId, organizationId: tenantId, ...payload },
    } as EventEnvelope;
  }

  async function fresh(): Promise<string> {
    const assetId = id('AST');
    assets.push(assetId);
    await sync.handle(
      event('ASSET_CREATED', assetId, 1, 'asset-service', { status: 'REGISTERED' }),
    );
    return assetId;
  }

  async function staleCount(eventName: string): Promise<number> {
    const metric = await registry.getSingleMetric('rasta_fleet_stale_state_events_total')?.get();
    return (
      (metric?.values as { labels: Record<string, string>; value: number }[] | undefined)?.find(
        (sample) => sample.labels.event === eventName,
      )?.value ?? 0
    );
  }

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    repository = new FleetRepository(prisma);
    sync = new AssetSyncConsumer(null, repository);
  });

  afterAll(async () => {
    await prisma.client.$executeRawUnsafe(
      `DELETE FROM asset_ref WHERE id = ANY($1::text[])`,
      assets,
    );
    await prisma.client.$executeRawUnsafe(
      `DELETE FROM processed_event WHERE event_id = ANY($1::text[])`,
      eventIds,
    );
    await prisma.onModuleDestroy();
  });

  it('does not reactivate a decommissioned machine when ASSET_ACTIVATED is replayed', async () => {
    const assetId = await fresh();
    const activated = event('ASSET_ACTIVATED', assetId, 5, 'asset-service');
    const decommissioned = event('ASSET_DECOMMISSIONED', assetId, 6, 'asset-service');
    const before = await staleCount('ASSET_ACTIVATED');

    // ACTIVATED failed and was dead-lettered; DECOMMISSIONED was applied.
    await sync.handle(decommissioned);
    expect((await repository.findAssetRef(assetId))?.status).toBe('DECOMMISSIONED');

    // The replay arrives on `.retry`, afterwards.
    await sync.handle(activated);

    expect((await repository.findAssetRef(assetId))?.status).toBe('DECOMMISSIONED');
    expect(await staleCount('ASSET_ACTIVATED')).toBe(before + 1);
    expect(
      await prisma.client.processedEvent.count({ where: { eventId: activated.eventId } }),
    ).toBe(1);
  });

  it('does not put a machine back into maintenance when MAINTENANCE_STARTED is replayed', async () => {
    const assetId = await fresh();
    const started = event('MAINTENANCE_STARTED', assetId, 3, 'maintenance-service');
    const completed = event('MAINTENANCE_COMPLETED', assetId, 4, 'maintenance-service');

    await sync.handle(completed);
    await sync.handle(started);

    expect((await repository.findAssetRef(assetId))?.inMaintenance).toBe(false);
  });

  it('does not clear in-maintenance when an older MAINTENANCE_COMPLETED is replayed', async () => {
    const assetId = await fresh();
    const completed = event('MAINTENANCE_COMPLETED', assetId, 3, 'maintenance-service');
    const started = event('MAINTENANCE_STARTED', assetId, 4, 'maintenance-service');

    await sync.handle(started);
    await sync.handle(completed);

    expect((await repository.findAssetRef(assetId))?.inMaintenance).toBe(true);
  });

  it('does not move the machine back to its previous owner when an older transfer is replayed', async () => {
    const assetId = await fresh();
    const toB = event(
      'ASSET_TRANSFERRED',
      assetId,
      2,
      'asset-service',
      { fromOrganizationId: org.a, toOrganizationId: org.b, transferredAt: '2026-09-29T09:00:00Z' },
      org.b,
    );
    const backToA = event(
      'ASSET_TRANSFERRED',
      assetId,
      3,
      'asset-service',
      { fromOrganizationId: org.b, toOrganizationId: org.a, transferredAt: '2026-09-29T09:30:00Z' },
      org.a,
    );

    await sync.handle(backToA);
    await sync.handle(toB);

    const row = await repository.findAssetRef(assetId);
    expect(row?.organizationId).toBe(org.a);
    expect(row?.status).toBe('REGISTERED');
  });

  it('still applies a safety event older than the state event that followed it', async () => {
    const assetId = await fresh();
    const failed = event('INSPECTION_FAILED', assetId, 5, 'asset-service');
    const changed = event('ASSET_STATUS_CHANGED', assetId, 6, 'asset-service', {
      newStatus: 'ACTIVE',
    });

    await sync.handle(changed);
    await sync.handle(failed);

    const row = await repository.findAssetRef(assetId);
    expect(row?.inspectionBlockedReason).not.toBeNull();
    expect(row?.status).toBe('ACTIVE');
  });

  it('applies an event at an equal position under another id, and ignores a redelivery', async () => {
    const assetId = await fresh();
    const first = event('ASSET_STATUS_CHANGED', assetId, 5, 'asset-service', {
      newStatus: 'OUT_OF_SERVICE',
    });
    const twin = event('ASSET_STATUS_CHANGED', assetId, 5, 'asset-service', {
      newStatus: 'ACTIVE',
    });

    await sync.handle(first);
    await sync.handle(twin);
    expect((await repository.findAssetRef(assetId))?.status).toBe('ACTIVE');

    await sync.handle(first);
    expect((await repository.findAssetRef(assetId))?.status).toBe('ACTIVE');
  });

  it('orders unsequenced events by occurredAt, then by event id', async () => {
    const assetId = await fresh();
    // Only the clock orders these; the older one arrives last.
    const newer = {
      ...event('ASSET_STATUS_CHANGED', assetId, undefined, 'asset-service', {
        newStatus: 'OUT_OF_SERVICE',
      }),
      occurredAt: '2026-09-29T12:00:00.000Z',
    };
    const older = {
      ...event('ASSET_STATUS_CHANGED', assetId, undefined, 'asset-service', {
        newStatus: 'ACTIVE',
      }),
      occurredAt: '2026-09-29T11:00:00.000Z',
    };

    await sync.handle(newer);
    await sync.handle(older);

    expect((await repository.findAssetRef(assetId))?.status).toBe('OUT_OF_SERVICE');
  });
});
