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

  // ---------------------------------------------------------------------------
  // Review round 1 on #103. The races are made deterministic: a transaction
  // holds the asset's lock while the contenders queue behind it, the test
  // waits until PostgreSQL reports them blocked, and only then releases.
  // ---------------------------------------------------------------------------

  describe('ordering and races (PR #103 review round 1)', () => {
    /** Holds the asset's lock, as every writer takes it, until released. */
    async function holdAssetLock(assetId: string, whileHeld?: (tx: never) => Promise<void>) {
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));

      const done = prisma.client.$transaction(
        async (tx) => {
          await repository.lockAssetRef(tx as never, assetId);
          locked();
          await released;
          await whileHeld?.(tx as never);
        },
        { timeout: 30_000 },
      );

      await isLocked;
      return async () => {
        release();
        await done;
      };
    }

    async function waitForBlocked(n: number) {
      for (let attempt = 0; attempt < 400; attempt++) {
        const rows = await prisma.client.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        if (rows[0]!.n >= n) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`fewer than ${n} sessions ever blocked`);
    }

    it('keeps both lapses when two insurance events are the first sighting of a machine (#1)', async () => {
      // `FOR UPDATE` on a row that does not exist locks nothing. The asset's
      // advisory lock exists either way, so the second event builds on the
      // first one's row instead of on "no row".
      const assetId = id('AST');
      const release = await holdAssetLock(assetId);
      const both = Promise.all([lapse(assetId, 'THIRD_PARTY'), lapse(assetId, 'COMPREHENSIVE')]);
      await waitForBlocked(2);
      await release();
      await both;

      const row = await repository.findAssetRef(assetId);
      expect([...row!.insuranceLapsedCoverages].sort()).toEqual(['COMPREHENSIVE', 'THIRD_PARTY']);
    });

    it('leaves a newer inspection failure in force when an older repair completion arrives late (#2)', async () => {
      const { assetId, driverId } = await fleet();
      const at = (iso: string, envelope: EventEnvelope): EventEnvelope => ({
        ...envelope,
        occurredAt: iso,
      });

      // Repair completed at 10:00, inspection failed at 11:00; the failure is
      // consumed first.
      await consumer.handle(
        at(
          '2026-09-01T11:00:00.000Z',
          event('INSPECTION_FAILED', { assetId, inspectionId: id('INP') }),
        ),
      );
      await consumer.handle(
        at(
          '2026-09-01T10:00:00.000Z',
          event('MAINTENANCE_COMPLETED', { assetId, requestId: id('MNT') }),
        ),
      );

      await expect(assign(org.a, assetId, driverId)).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
        message: expect.stringContaining('withdrawn from dispatch'),
      });

      // A repair completed after the failure does clear it.
      await consumer.handle(
        at(
          '2026-09-01T12:00:00.000Z',
          event('MAINTENANCE_COMPLETED', { assetId, requestId: id('MNT') }),
        ),
      );
      await expect(assign(org.a, assetId, driverId)).resolves.toMatchObject({ assetId });
    });

    it('refuses an assignment when a dispatch block commits between its check and its insert (#3)', async () => {
      const { assetId, driverId } = await fleet();

      // The assignment passes its early checks, then waits for the lock. The
      // block lands while it waits.
      const release = await holdAssetLock(assetId, async (tx) => {
        await (tx as unknown as PrismaService['client']).$executeRawUnsafe(
          `UPDATE asset_ref SET inspection_blocked_reason = 'The most recent technical inspection failed',
                                inspection_blocked_at = now()
           WHERE id = $1`,
          assetId,
        );
      });
      const attempt = assign(org.a, assetId, driverId);
      await waitForBlocked(1);
      await release();

      await expect(attempt).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
        message: expect.stringContaining('withdrawn from dispatch'),
      });
      const active = await prisma.client.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM assignment WHERE asset_id = $1 AND ended_at IS NULL`,
        assetId,
      );
      expect(active[0]!.n).toBe(0);
    });
  });
});
