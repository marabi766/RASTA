import type { EventEnvelope } from '@rasta/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { FleetRepository } from '../src/fleet/fleet.repository';
import { AssignmentService } from '../src/fleet/assignment.service';
import { AssetSyncConsumer } from '../src/consumers/asset-sync.consumer';
import { asActor, cleanup, id, newPrisma, tenants } from './helpers';

/**
 * ASSET_TRANSFERRED ends the assignments still open on the machine (the
 * follow-up found in #108), against PostgreSQL.
 *
 * asset-service refuses to transfer an ASSIGNED machine, but it learns of an
 * assignment only when it consumes ASSET_ASSIGNED. An assignment made here in
 * that window used to survive the transfer: the old owner's driver stayed in
 * charge of the new owner's machine, and the new owner could never assign it,
 * because the one-active-per-asset index spans tenants.
 *
 * The races are made deterministic the way dispatch-blocks.int-spec does it:
 * a transaction holds the asset's lock, the contenders queue behind it, the
 * test waits until PostgreSQL reports them blocked, and only then releases.
 */
describe('a transfer ends the assignments still open on the machine', () => {
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

  const transfer = (assetId: string, from = org.a, to = org.b) =>
    event('ASSET_TRANSFERRED', from, {
      assetId,
      fromOrganizationId: from,
      toOrganizationId: to,
      reason: 'واگذاری',
      referenceNo: null,
      transferredAt: new Date().toISOString(),
    });

  async function machine(organizationId: string): Promise<string> {
    const assetId = id('AST');
    await consumer.handle(
      event('ASSET_CREATED', organizationId, {
        assetId,
        organizationId,
        status: 'ACTIVE',
        name: 'لودر',
      }),
    );
    return assetId;
  }

  async function driver(organizationId: string): Promise<string> {
    const driverId = id('DRV');
    await asActor({ organizationId }, () =>
      prisma.client.driver.create({
        data: {
          organizationId,
          id: driverId,
          userId: `USR-${driverId}`,
          createdBy: 'ITEST',
          updatedBy: 'ITEST',
        },
      }),
    );
    return driverId;
  }

  const assign = (organizationId: string, assetId: string, driverId: string) =>
    asActor({ organizationId }, () => assignments.create({ driverId, assetId }));

  /** Rows read past the tenant guard, so the test sees what is really there. */
  const assignmentRow = (assignmentId: string) =>
    prisma.client
      .$queryRawUnsafe<
        {
          organization_id: string;
          ended_at: Date | null;
          ended_by: string | null;
          end_reason: string | null;
          end_notes: string | null;
        }[]
      >(
        `SELECT organization_id, ended_at, ended_by, end_reason::text AS end_reason, end_notes
       FROM assignment WHERE id = $1`,
        assignmentId,
      )
      .then((rows) => rows[0]!);

  const releases = (assignmentId: string) =>
    prisma.client.outboxMessage.findMany({
      where: { aggregateId: assignmentId, eventName: 'ASSIGNMENT_ENDED' },
    });

  const activeOn = async (assetId: string) =>
    (
      await prisma.client.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM assignment WHERE asset_id = $1 AND ended_at IS NULL`,
        assetId,
      )
    )[0]!.n;

  it('ends it as the system, publishes the release under the old owner, and frees the machine for the new one', async () => {
    const assetId = await machine(org.a);
    const held = await assign(org.a, assetId, await driver(org.a));
    const move = transfer(assetId);

    await consumer.handle(move);

    const row = await assignmentRow(held.id);
    expect(row).toMatchObject({
      // The row stays with the organization that held it.
      organization_id: org.a,
      ended_by: 'SYSTEM',
      end_reason: 'ASSET_UNAVAILABLE',
      end_notes: expect.stringContaining('منتقل شد'),
    });
    expect(row.ended_at).not.toBeNull();

    const published = await releases(held.id);
    expect(published).toHaveLength(1);
    expect(published[0]!.organizationId).toBe(org.a);
    expect(published[0]!.payload).toMatchObject({
      tenantId: org.a,
      causationId: move.eventId,
      correlationId: move.correlationId,
      actor: { type: 'SERVICE', id: 'fleet-service' },
      payload: {
        assignmentId: held.id,
        assetId,
        organizationId: org.a,
        reason: 'ASSET_UNAVAILABLE',
        endedAt: row.ended_at!.toISOString(),
      },
    });

    // The new owner re-commissions it and can then assign it. Before this
    // change the old assignment held the cross-tenant index and this failed
    // with ASSET_ALREADY_ASSIGNED, naming an assignment B cannot see.
    await consumer.handle(event('ASSET_ACTIVATED', org.b, { assetId }));
    await expect(assign(org.b, assetId, await driver(org.b))).resolves.toMatchObject({
      assetId,
      organizationId: org.b,
    });
  });

  it('does nothing more on a redelivery', async () => {
    const assetId = await machine(org.a);
    const held = await assign(org.a, assetId, await driver(org.a));
    const move = transfer(assetId);

    await consumer.handle(move);
    const first = await assignmentRow(held.id);
    await consumer.handle(move);

    expect(await releases(held.id)).toHaveLength(1);
    expect((await assignmentRow(held.id)).ended_at).toEqual(first.ended_at);
  });

  describe('tenant isolation', () => {
    it("ends only this machine's assignment, in either tenant, and shows it to the new owner nowhere", async () => {
      const moved = await machine(org.a);
      const heldHere = await assign(org.a, moved, await driver(org.a));
      // Same tenant, other machine; other tenant, other machine.
      const otherInA = await assign(org.a, await machine(org.a), await driver(org.a));
      const otherInB = await assign(org.b, await machine(org.b), await driver(org.b));

      await consumer.handle(transfer(moved));

      expect((await assignmentRow(heldHere.id)).ended_at).not.toBeNull();
      expect((await assignmentRow(otherInA.id)).ended_at).toBeNull();
      expect((await assignmentRow(otherInB.id)).ended_at).toBeNull();
      expect(await releases(otherInA.id)).toHaveLength(0);
      expect(await releases(otherInB.id)).toHaveLength(0);

      // Nothing about the old owner's assignment reaches the new owner: not
      // the row through its API, and not an event under its tenant.
      const seenByB = await asActor({ organizationId: org.b }, () =>
        assignments.list({ assetId: moved, limit: 50 }),
      );
      expect(seenByB.items).toHaveLength(0);
      await expect(
        asActor({ organizationId: org.b }, () => assignments.get(heldHere.id)),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const underB = await prisma.client.outboxMessage.findMany({
        where: { organizationId: org.b, aggregateId: heldHere.id },
      });
      expect(underB).toHaveLength(0);

      // The old owner still sees its own history, ended.
      const seenByA = await asActor({ organizationId: org.a }, () => assignments.get(heldHere.id));
      expect(seenByA).toMatchObject({ active: false, endReason: 'ASSET_UNAVAILABLE' });
    });
  });

  describe("the previous owner's delayed insurance events (docs/24 Q-66)", () => {
    // The policy follows the vehicle (project owner's decision, 2026-09-25):
    // after the transfer, the inherited policy's events decide the new
    // owner's dispatch exactly as they decided the old owner's. Insurance and
    // asset events travel on different topics; here the transfer is consumed
    // first and the old owner's insurance events after it.
    const insurance = (eventName: string, assetId: string, owner: string, fields: object) =>
      event(eventName, owner, { assetId, organizationId: owner, ...fields });
    const year = 365 * 86_400_000;

    it("blocks and then clears the new owner's dispatch", async () => {
      const assetId = await machine(org.a);
      await consumer.handle(transfer(assetId));
      await consumer.handle(event('ASSET_ACTIVATED', org.b, { assetId }));
      const driverB = await driver(org.b);

      // The inherited policy lapses: the new owner cannot dispatch.
      await consumer.handle(
        insurance('INSURANCE_EXPIRED', assetId, org.a, { coverage: 'THIRD_PARTY' }),
      );
      expect(await repository.findAssetRef(assetId)).toMatchObject({
        organizationId: org.b,
        insuranceLapsedCoverages: ['THIRD_PARTY'],
      });
      await expect(assign(org.b, assetId, driverB)).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
        message: expect.stringContaining('withdrawn from dispatch'),
      });

      // Its renewal, recorded by the previous owner before the transfer and
      // consumed after it, answers the lapse for the new owner.
      await consumer.handle(
        insurance('INSURANCE_RECORDED', assetId, org.a, {
          policyId: id('INS'),
          coverage: 'THIRD_PARTY',
          validFrom: new Date(Date.now() - 1000).toISOString(),
          validTo: new Date(Date.now() + year).toISOString(),
        }),
      );
      await expect(assign(org.b, assetId, driverB)).resolves.toMatchObject({
        assetId,
        organizationId: org.b,
      });
    });

    it('keeps a lapse recorded before the transfer', async () => {
      const assetId = await machine(org.a);
      await consumer.handle(
        insurance('INSURANCE_EXPIRED', assetId, org.a, { coverage: 'THIRD_PARTY' }),
      );
      await consumer.handle(transfer(assetId));
      await consumer.handle(event('ASSET_ACTIVATED', org.b, { assetId }));

      await expect(assign(org.b, assetId, await driver(org.b))).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
      });
    });
  });

  describe('races', () => {
    /** Holds the asset's lock, as every writer takes it, until released. */
    async function holdAssetLock(assetId: string) {
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));

      const done = prisma.client.$transaction(
        async (tx) => {
          await repository.lockAssetRef(tx as never, assetId);
          locked();
          await released;
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

    it('publishes one release when a person ends the assignment while the transfer waits', async () => {
      const assetId = await machine(org.a);
      const held = await assign(org.a, assetId, await driver(org.a));

      const release = await holdAssetLock(assetId);
      const handled = consumer.handle(transfer(assetId));
      await waitForBlocked(1);
      // Ending takes no asset lock; it lands while the transfer is queued.
      await asActor({ organizationId: org.a }, () =>
        assignments.end(held.id, { reason: 'COMPLETED' }),
      );
      await release();
      await handled;

      const published = await releases(held.id);
      expect(published).toHaveLength(1);
      expect((published[0]!.payload as { payload: { reason: string } }).payload.reason).toBe(
        'COMPLETED',
      );
      expect((await assignmentRow(held.id)).end_reason).toBe('COMPLETED');
    });

    it('leaves no assignment open when one is attempted while the transfer holds the lock', async () => {
      // The transfer queues first and the attempt second. Whichever the lock
      // grants first, nothing may be left running: an attempt after the
      // transfer finds the machine gone, and one before it is ended by it.
      const assetId = await machine(org.a);
      const driverId = await driver(org.a);

      const release = await holdAssetLock(assetId);
      const handled = consumer.handle(transfer(assetId));
      await waitForBlocked(1);
      const attempt = assign(org.a, assetId, driverId).then(
        () => 'ASSIGNED',
        (error: { code?: string }) => error.code ?? 'ERROR',
      );
      await waitForBlocked(2);
      await release();
      await handled;

      expect(['ASSIGNED', 'NOT_FOUND']).toContain(await attempt);
      expect(await activeOn(assetId)).toBe(0);
    });
  });
});
