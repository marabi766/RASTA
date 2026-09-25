import type { EventEnvelope } from '@rasta/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { FleetRepository } from '../src/fleet/fleet.repository';
import { AssignmentService } from '../src/fleet/assignment.service';
import { AssetSyncConsumer } from '../src/consumers/asset-sync.consumer';
import { asActor, cleanup, id, newPrisma, tenants } from './helpers';

/**
 * L3-02, end to end against PostgreSQL: the audit's own proof. An insurance
 * lapse followed by an unrelated repair must still refuse an assignment; only
 * a recorded policy of the same coverage, in force, lets the machine go.
 *
 * Real database rather than the unit harness because the per-coverage set and
 * the policy windows live in a `TEXT[]` and a `JSONB` column, and the
 * projection builds on the row it reads back under a lock — none of which a
 * mock can show round-tripping.
 */
describe('dispatch blocks (L3-02)', () => {
  const org = tenants();
  let prisma: PrismaService;
  let repository: FleetRepository;
  let consumer: AssetSyncConsumer;
  let assignments: AssignmentService;

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    repository = new FleetRepository(prisma);
    consumer = new AssetSyncConsumer(null, repository);
    assignments = new AssignmentService(repository);
    await cleanup(prisma, [org.a, org.b]);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await prisma.onModuleDestroy();
  });

  const event = (eventName: string, payload: Record<string, unknown>): EventEnvelope => ({
    eventId: id('EVT'),
    eventName,
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    producer: eventName.startsWith('MAINTENANCE') ? 'maintenance-service' : 'asset-service',
    producerVersion: '0.1.0',
    aggregateType: 'Asset',
    aggregateId: String(payload.assetId),
    tenantId: org.a,
    correlationId: id('COR'),
    payload: { organizationId: org.a, ...payload },
  });

  /** A machine in service and a driver free to take it. */
  async function fleet(): Promise<{ assetId: string; driverId: string }> {
    const assetId = id('AST');
    const driverId = id('DRV');
    await consumer.handle(event('ASSET_CREATED', { assetId, status: 'ACTIVE', name: 'گریدر' }));
    await asActor({ organizationId: org.a }, () =>
      prisma.client.driver.create({
        data: {
          organizationId: org.a,
          id: driverId,
          userId: `USR-${driverId}`,
          createdBy: 'ITEST',
          updatedBy: 'ITEST',
        },
      }),
    );
    return { assetId, driverId };
  }

  const assign = (organizationId: string, assetId: string, driverId: string) =>
    asActor({ organizationId }, () => assignments.create({ driverId, assetId }));

  const lapse = (assetId: string, coverage = 'THIRD_PARTY') =>
    consumer.handle(
      event('INSURANCE_EXPIRED', {
        assetId,
        policyId: id('INS'),
        coverage,
        validTo: new Date(Date.now() - 86_400_000).toISOString(),
      }),
    );

  const recordPolicy = (
    assetId: string,
    validFrom: Date,
    validTo: Date,
    coverage = 'THIRD_PARTY',
  ) =>
    consumer.handle(
      event('INSURANCE_RECORDED', {
        assetId,
        policyId: id('INS'),
        insurerName: 'بیمه ایران',
        coverage,
        validFrom: validFrom.toISOString(),
        validTo: validTo.toISOString(),
      }),
    );

  const year = 365 * 86_400_000;

  it('keeps refusing after a lapse and an unrelated repair, until a same-coverage renewal', async () => {
    const { assetId, driverId } = await fleet();
    await lapse(assetId);
    await consumer.handle(event('MAINTENANCE_COMPLETED', { assetId, requestId: id('MNT') }));

    await expect(assign(org.a, assetId, driverId)).rejects.toMatchObject({
      code: 'BUSINESS_RULE_VIOLATION',
      message: expect.stringContaining('withdrawn from dispatch'),
    });

    // Another coverage does not answer a third-party lapse.
    await recordPolicy(
      assetId,
      new Date(Date.now() - 1000),
      new Date(Date.now() + year),
      'PASSENGER_ACCIDENT',
    );
    await expect(assign(org.a, assetId, driverId)).rejects.toMatchObject({
      code: 'BUSINESS_RULE_VIOLATION',
    });

    await recordPolicy(assetId, new Date(Date.now() - 1000), new Date(Date.now() + year));
    const created = await assign(org.a, assetId, driverId);
    expect(created.assetId).toBe(assetId);

    const row = await repository.findAssetRef(assetId);
    expect(row!.insuranceLapsedCoverages).toEqual([]);
  });

  it('does not block a machine whose renewal was recorded before the old policy lapsed', async () => {
    const { assetId, driverId } = await fleet();
    await recordPolicy(assetId, new Date(Date.now() - 1000), new Date(Date.now() + year));
    await lapse(assetId);

    const created = await assign(org.a, assetId, driverId);
    expect(created.assetId).toBe(assetId);
  });

  it('keeps refusing while a future-dated renewal has not yet started', async () => {
    const { assetId, driverId } = await fleet();
    await lapse(assetId);
    await recordPolicy(assetId, new Date(Date.now() + 7 * 86_400_000), new Date(Date.now() + year));

    await expect(assign(org.a, assetId, driverId)).rejects.toMatchObject({
      code: 'BUSINESS_RULE_VIOLATION',
    });
  });

  it('keeps both causes when an inspection fails on a machine whose insurance lapsed', async () => {
    const { assetId } = await fleet();
    await lapse(assetId);
    await consumer.handle(event('INSPECTION_FAILED', { assetId, inspectionId: id('INP') }));

    const row = await repository.findAssetRef(assetId);
    expect(row!.inspectionBlockedReason).not.toBeNull();
    expect(row!.insuranceLapsedCoverages).toEqual(['THIRD_PARTY']);
  });

  it("does not let another tenant assign, or even find, a tenant's machine", async () => {
    const { assetId } = await fleet();
    const outsider = id('DRV');
    await asActor({ organizationId: org.b }, () =>
      prisma.client.driver.create({
        data: {
          organizationId: org.b,
          id: outsider,
          userId: `USR-${outsider}`,
          createdBy: 'ITEST',
          updatedBy: 'ITEST',
        },
      }),
    );

    await expect(assign(org.b, assetId, outsider)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
