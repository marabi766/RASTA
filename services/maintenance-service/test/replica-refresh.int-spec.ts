import type { EventEnvelope } from '@rasta/contracts';
import { RastaError } from '@rasta/nest-common';
import { AssetSyncConsumer } from '../src/consumers/asset-sync.consumer';
import type { AssetSnapshot, AssetSnapshotSource } from '../src/consumers/replica-sources';
import { MaintenanceRepository } from '../src/maintenance/maintenance.repository';
import type { PrismaService } from '../src/prisma/prisma.service';
import { id, newPrisma, tenants } from './helpers';

/**
 * D-039 — a state event replayed on `<topic>.retry` never applies its payload:
 * the replica is refreshed from asset-service, so it ends equal to the
 * source's current state however late the replay arrives. Against PostgreSQL,
 * with asset-service replaced by a fake source of truth.
 */
describe('asset replica: a state event replayed on .retry refreshes from the source', () => {
  const org = tenants();
  const RETRY = Object.freeze({ topic: 'rasta.asset.v1.retry', partition: 0 });
  const ORIGINAL = Object.freeze({ topic: 'rasta.asset.v1', partition: 0 });

  let prisma: PrismaService;
  let repository: MaintenanceRepository;
  let consumer: AssetSyncConsumer;

  interface Truth {
    owner: string;
    previousOwners: string[];
    status: string;
    name: string;
    type: string;
    assetTag: string | null;
    reachable: boolean;
  }
  const truths = new Map<string, Truth>();
  const asked: string[] = [];

  const assetSource: AssetSnapshotSource = {
    async snapshot(organizationId, assetId): Promise<AssetSnapshot | null> {
      asked.push(organizationId);
      const t = truths.get(assetId);
      if (!t || !t.reachable) throw RastaError.upstreamUnavailable('asset-service');
      if (organizationId !== t.owner && !t.previousOwners.includes(organizationId)) return null;
      return {
        assetId,
        organizationId: t.owner,
        status: t.status,
        name: t.name,
        type: t.type,
        assetTag: t.assetTag,
        transferGeneration: t.previousOwners.length,
      };
    },
  };

  const event = (
    eventName: string,
    tenantId: string,
    payload: Record<string, unknown>,
  ): EventEnvelope => ({
    eventId: id('EVT'),
    eventName,
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    producer: 'asset-service',
    producerVersion: '0.1.0',
    aggregateType: 'Asset',
    aggregateId: String(payload.assetId),
    tenantId,
    correlationId: id('COR'),
    payload,
  });

  function truth(assetId: string, overrides: Partial<Truth>): void {
    truths.set(assetId, {
      owner: org.a,
      previousOwners: [],
      status: 'ACTIVE',
      name: 'لودر',
      type: 'LOADER',
      assetTag: 'TAG-1',
      reachable: true,
      ...overrides,
    });
  }

  const replica = (assetId: string) => repository.findAssetRef(assetId);
  const markers = (eventId: string) => prisma.client.processedEvent.count({ where: { eventId } });
  const fenceOwners = async (assetId: string) =>
    (
      await prisma.client.$queryRawUnsafe<{ organization_id: string }[]>(
        `SELECT organization_id FROM asset_transfer_fence WHERE asset_id = $1`,
        assetId,
      )
    ).map((row) => row.organization_id);
  const place = (assetId: string, organizationId: string) =>
    repository.transaction((tx) =>
      repository.placeTransferFence(tx, assetId, organizationId, id('TRF'), 3600),
    );

  const created: string[] = [];
  async function seed(
    assetId: string,
    organizationId: string,
    extra: Record<string, unknown> = {},
  ) {
    created.push(assetId);
    await consumer.handle(
      event('ASSET_CREATED', organizationId, {
        assetId,
        organizationId,
        status: 'ACTIVE',
        name: 'لودر',
        ...extra,
      }),
    );
  }

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    repository = new MaintenanceRepository(prisma);
    consumer = new AssetSyncConsumer(null, repository, assetSource);
  });

  afterAll(async () => {
    await prisma.client.$executeRawUnsafe(
      `DELETE FROM asset_ref WHERE organization_id = ANY($1::text[])`,
      [org.a, org.b],
    );
    await prisma.client.$executeRawUnsafe(
      `DELETE FROM asset_transfer_fence WHERE organization_id = ANY($1::text[])`,
      [org.a, org.b],
    );
    await prisma.onModuleDestroy();
  });

  beforeEach(() => {
    asked.length = 0;
  });

  it('transfer, then a new-owner event: the replayed transfer lands the replica on the source’s state and drops the old fence', async () => {
    const assetId = id('AST');
    await seed(assetId, org.a);
    await place(assetId, org.a);
    truth(assetId, { owner: org.b, previousOwners: [org.a], status: 'ACTIVE' });

    const replay = event('ASSET_TRANSFERRED', org.b, {
      assetId,
      fromOrganizationId: org.a,
      toOrganizationId: org.b,
      transferredAt: new Date().toISOString(),
    });
    await consumer.handle(replay, RETRY);

    expect(await replica(assetId)).toMatchObject({
      organizationId: org.b,
      status: 'ACTIVE',
      name: 'لودر',
      assetType: 'LOADER',
      assetTag: 'TAG-1',
    });
    expect(await fenceOwners(assetId)).toEqual([]);
    expect(await markers(replay.eventId)).toBe(1);

    // The new owner's next event, on the original topic, applies as ever.
    await consumer.handle(
      event('ASSET_STATUS_CHANGED', org.b, {
        assetId,
        organizationId: org.b,
        newStatus: 'OUT_OF_SERVICE',
      }),
      ORIGINAL,
    );
    expect((await replica(assetId))?.status).toBe('OUT_OF_SERVICE');
  });

  it('a delayed transfer after the new owner’s activation: the replica is already right and the old fence is dropped', async () => {
    const assetId = id('AST');
    created.push(assetId);
    await consumer.handle(event('ASSET_ACTIVATED', org.b, { assetId, organizationId: org.b }));
    await place(assetId, org.a);
    truth(assetId, { owner: org.b, previousOwners: [org.a], status: 'ACTIVE' });

    await consumer.handle(
      event('ASSET_TRANSFERRED', org.b, {
        assetId,
        fromOrganizationId: org.a,
        toOrganizationId: org.b,
        transferredAt: new Date().toISOString(),
      }),
      RETRY,
    );

    expect((await replica(assetId))?.organizationId).toBe(org.b);
    expect(await fenceOwners(assetId)).toEqual([]);
  });

  it('a pre-existing replica and an old activation replayed: a decommissioned machine stays decommissioned', async () => {
    const assetId = id('AST');
    await seed(assetId, org.a);
    truth(assetId, { owner: org.a, status: 'DECOMMISSIONED' });

    await consumer.handle(event('ASSET_ACTIVATED', org.a, { assetId }), RETRY);

    expect((await replica(assetId))?.status).toBe('DECOMMISSIONED');
  });

  it('a replayed ASSET_CREATED after a minimal replica: name, type and tag arrive from the source', async () => {
    const assetId = id('AST');
    created.push(assetId);
    await consumer.handle(event('ASSET_ACTIVATED', org.a, { assetId, organizationId: org.a }));
    expect((await replica(assetId))?.name).toBeNull();
    truth(assetId, { owner: org.a, name: 'گریدر ۱۲', type: 'GRADER', assetTag: 'G-12' });

    await consumer.handle(
      event('ASSET_CREATED', org.a, {
        assetId,
        organizationId: org.a,
        status: 'REGISTERED',
        name: 'قدیمی',
      }),
      RETRY,
    );

    expect(await replica(assetId)).toMatchObject({
      status: 'ACTIVE',
      name: 'گریدر ۱۲',
      assetType: 'GRADER',
      assetTag: 'G-12',
    });
  });

  it('an unreachable source: retried, then dead-lettered — the payload is never applied', async () => {
    const assetId = id('AST');
    await seed(assetId, org.a);
    truth(assetId, { owner: org.a, status: 'DECOMMISSIONED', reachable: false });
    const replay = event('ASSET_STATUS_CHANGED', org.a, {
      assetId,
      organizationId: org.a,
      newStatus: 'OUT_OF_SERVICE',
    });

    await expect(consumer.handle(replay, RETRY)).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
    await expect(
      new AssetSyncConsumer(null, repository).handle(replay, RETRY),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });

    expect((await replica(assetId))?.status).toBe('ACTIVE');
    expect(await markers(replay.eventId)).toBe(0);
  });

  it('a source that does not know the asset for the named organization: SOURCE_UNCONFIRMED, nothing applied', async () => {
    const assetId = id('AST');
    truth(assetId, { owner: org.b });

    await expect(
      consumer.handle(
        event('ASSET_CREATED', org.a, { assetId, organizationId: org.a, status: 'ACTIVE' }),
        RETRY,
      ),
    ).rejects.toMatchObject({ reason: 'SOURCE_UNCONFIRMED' });

    expect(await replica(assetId)).toBeNull();
  });

  it('leaves a delivery on the original topic exactly as before, without asking anyone', async () => {
    const assetId = id('AST');
    truth(assetId, { owner: org.a, status: 'DECOMMISSIONED' });

    await consumer.handle(
      event('ASSET_CREATED', org.a, { assetId, organizationId: org.a, status: 'ACTIVE' }),
      ORIGINAL,
    );

    expect(asked).toEqual([]);
    expect((await replica(assetId))?.status).toBe('ACTIVE');
  });
});
