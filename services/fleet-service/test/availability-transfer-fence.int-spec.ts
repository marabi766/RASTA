import type { EventEnvelope } from '@rasta/contracts';
import { AssetSyncConsumer } from '../src/consumers/asset-sync.consumer';
import { AvailabilityService } from '../src/fleet/availability.service';
import { FleetRepository } from '../src/fleet/fleet.repository';
import type { PrismaService } from '../src/prisma/prisma.service';
import {
  LAPSE_RULES_ONLY,
  asActor,
  cleanup,
  id,
  newPrisma,
  producerShaped,
  tenants,
} from './helpers';

/**
 * The availability listing applies the same transfer fence as assignment
 * (ADR-062 § 3b, #240 r7): a machine whose owner was told "free to transfer"
 * must not be listed as available on a window while the transfer is pending —
 * an expired fence included, since expiry is not an answer.
 */
describe('availability under a pending transfer', () => {
  const org = tenants();
  let prisma: PrismaService;
  let repository: FleetRepository;
  let consumer: AssetSyncConsumer;
  let availability: AvailabilityService;

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    repository = new FleetRepository(prisma);
    consumer = new AssetSyncConsumer(null, repository);
    availability = new AvailabilityService(repository, LAPSE_RULES_ONLY);
    await cleanup(prisma, [org.a, org.b]);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await prisma.onModuleDestroy();
  });

  const created = (assetId: string): EventEnvelope => ({
    eventId: id('EVT'),
    eventName: 'ASSET_CREATED',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    producer: 'asset-service',
    producerVersion: '0.1.0',
    aggregateType: 'Asset',
    aggregateId: assetId,
    tenantId: org.a,
    correlationId: id('COR'),
    payload: producerShaped('ASSET_CREATED', {
      assetId,
      organizationId: org.a,
      status: 'ACTIVE',
    }),
  });

  const listed = async (assetId: string) => {
    const page = await asActor({ organizationId: org.a }, () =>
      availability.list({ limit: 100 } as never),
    );
    return page.items.find((item) => item.assetId === assetId)!;
  };

  const fenceOn = (assetId: string, ttlSeconds: number) =>
    prisma.client.$transaction(async (tx) => {
      await repository.lockAssetRef(tx as never, assetId);
      await repository.placeTransferFence(tx as never, assetId, org.a, id('TRF'), ttlSeconds);
    });

  it('lists a machine with a fence as unavailable, naming the transfer', async () => {
    const assetId = id('AST');
    await consumer.handle(created(assetId));
    expect(await listed(assetId)).toMatchObject({ available: true, blockers: [] });

    await fenceOn(assetId, 600);

    expect(await listed(assetId)).toMatchObject({
      available: false,
      blockers: [expect.objectContaining({ code: 'TRANSFER_IN_PROGRESS' })],
    });
  });

  it('an expired fence still blocks, as it does for assignment; it is available again once dropped', async () => {
    const assetId = id('AST');
    await consumer.handle(created(assetId));
    await fenceOn(assetId, 600);
    await prisma.client.$executeRawUnsafe(
      `UPDATE asset_transfer_fence SET expires_at = now() - interval '1 second' WHERE asset_id = $1`,
      assetId,
    );

    expect(await listed(assetId)).toMatchObject({ available: false });

    await prisma.client.$transaction(async (tx) => {
      await repository.dropTransferFences(tx as never, assetId, org.a);
    });
    expect(await listed(assetId)).toMatchObject({ available: true, blockers: [] });
  });
});
