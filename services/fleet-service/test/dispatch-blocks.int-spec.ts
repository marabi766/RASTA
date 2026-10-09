import type { EventEnvelope } from '@rasta/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { FleetRepository } from '../src/fleet/fleet.repository';
import { AssignmentService } from '../src/fleet/assignment.service';
import { AssetSyncConsumer } from '../src/consumers/asset-sync.consumer';
import { FakePolicySource, echoing } from './policy-source.fake';
import {
  LAPSE_RULES_ONLY,
  asActor,
  cleanup,
  id,
  newPrisma,
  tenants,
  producerShaped,
} from './helpers';

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
  /** A third owner, for a machine that changes hands twice. */
  const orgC = org.b.replace('-B-', '-C-');
  let prisma: PrismaService;
  let repository: FleetRepository;
  let consumer: AssetSyncConsumer;
  let policies: FakePolicySource;
  let assignments: AssignmentService;
  /** The fail-closed default: every coverage must be in force (docs/24 Q-101). */
  let strict: AssignmentService;

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    repository = new FleetRepository(prisma);
    // asset-service confirms each policy as its event states it, unless a test says otherwise.
    policies = new FakePolicySource();
    consumer = echoing(
      new AssetSyncConsumer(null, repository, undefined, undefined, undefined, policies),
      policies,
    );
    assignments = new AssignmentService(repository, LAPSE_RULES_ONLY);
    strict = new AssignmentService(repository);
    await cleanup(prisma, [org.a, org.b, orgC]);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b, orgC]);
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
    payload: producerShaped(eventName, { organizationId: org.a, ...payload }),
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

    const row = await repository.findAssetRefUnscoped(assetId);
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

    const row = await repository.findAssetRefUnscoped(assetId);
    expect(row!.inspectionBlockedReason).not.toBeNull();
    expect(row!.insuranceLapsedCoverages).toEqual(['THIRD_PARTY']);
  });

  describe('a policy that ran out before the expiry sweep (INSURANCE_EXPIRED not received)', () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    /** A policy recorded valid for a moment, then left to run out with no lapse event. */
    async function insuredBriefly(): Promise<{ assetId: string; driverId: string }> {
      const ids = await fleet();
      await recordPolicy(ids.assetId, new Date(Date.now() - 60_000), new Date(Date.now() + 1500));
      return ids;
    }

    it('assigns while the policy is in force, refuses once valid_until has passed, allows after a renewal', async () => {
      const { assetId, driverId } = await insuredBriefly();
      expect((await repository.findAssetRefUnscoped(assetId))!.insuranceLapsedCoverages).toEqual(
        [],
      );

      await sleep(1700);
      expect((await repository.findAssetRefUnscoped(assetId))!.insuranceLapsedCoverages).toEqual(
        [],
      );
      await expect(assign(org.a, assetId, driverId)).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
        message: expect.stringContaining('withdrawn from dispatch'),
        internalContext: expect.objectContaining({
          rule: 'ASSET_DISPATCH_BLOCKED',
          detail: expect.stringContaining('insurance policy has expired (THIRD_PARTY)'),
        }),
      });

      await recordPolicy(assetId, new Date(Date.now() - 1000), new Date(Date.now() + year));
      expect((await assign(org.a, assetId, driverId)).assetId).toBe(assetId);
    });

    it('keeps the ended window through a gap-spanning renewal that has not started', async () => {
      const { assetId, driverId } = await insuredBriefly();
      await sleep(1700);
      await recordPolicy(assetId, new Date(Date.now() + 86_400_000), new Date(Date.now() + year));

      await expect(assign(org.a, assetId, driverId)).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
      });
    });

    it("is per machine and per tenant: another machine and another tenant's caller are unaffected", async () => {
      const expired = await insuredBriefly();
      const insured = await fleet();
      await recordPolicy(insured.assetId, new Date(Date.now() - 1000), new Date(Date.now() + year));
      await sleep(1700);

      await expect(assign(org.a, expired.assetId, expired.driverId)).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
      });
      expect((await assign(org.a, insured.assetId, insured.driverId)).assetId).toBe(
        insured.assetId,
      );

      // Another tenant is told the machine does not exist, not that it is uninsured.
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
      await expect(assign(org.b, expired.assetId, outsider)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
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

  describe('required coverages and the re-projection (docs/24 Q-101)', () => {
    const COVERAGES = ['THIRD_PARTY', 'COMPREHENSIVE', 'PASSENGER_ACCIDENT', 'LIABILITY'];
    const refused = {
      code: 'BUSINESS_RULE_VIOLATION',
      message: expect.stringContaining('withdrawn from dispatch'),
    };

    /**
     * The `INSURANCE_RECORDED` asset-service's `insurance:reproject` writes to
     * its outbox, as the relay publishes it: the envelope's id is the
     * deterministic one, so a redelivery is the same event.
     */
    const reprojected = (assetId: string, coverage: string, validFrom: Date, validTo: Date) =>
      ({
        ...event('INSURANCE_RECORDED', {
          assetId,
          policyId: `INS_${coverage}_${assetId}`,
          insurerName: 'بیمه ایران',
          coverage,
          validFrom: validFrom.toISOString(),
          validTo: validTo.toISOString(),
        }),
        eventId: `EVT-REPROJECT-${coverage}-${assetId}`,
      }) as EventEnvelope;

    /** A legacy row: the replica exists and holds no window at all. */
    async function legacy() {
      const machine = await fleet();
      const row = await repository.findAssetRefUnscoped(machine.assetId);
      expect(row!.insuranceCover).toEqual({});
      return machine;
    }

    it('refuses a legacy machine with no recorded window, however clean the rest', async () => {
      const { assetId, driverId } = await legacy();
      await expect(assign(org.a, assetId, driverId)).resolves.toMatchObject({ assetId });
      await expect(
        asActor({ organizationId: org.a }, () => strict.create({ driverId, assetId })),
      ).rejects.toMatchObject(refused);
    });

    it('refuses a machine whose only window starts next week, and one covered only in part', async () => {
      const { assetId, driverId } = await legacy();
      const week = 7 * 86_400_000;
      await recordPolicy(assetId, new Date(Date.now() + week), new Date(Date.now() + week + year));
      const create = () =>
        asActor({ organizationId: org.a }, () => strict.create({ driverId, assetId }));
      await expect(create()).rejects.toMatchObject(refused);

      for (const coverage of COVERAGES.slice(1)) {
        await recordPolicy(
          assetId,
          new Date(Date.now() - 1000),
          new Date(Date.now() + year),
          coverage,
        );
      }
      // THIRD_PARTY still has only the upcoming window.
      await expect(create()).rejects.toMatchObject(refused);
    });

    it('applies the command’s events: an insured machine is dispatched, an uninsured one still refused, a rerun is a no-op', async () => {
      const insured = await legacy();
      const uninsured = await legacy();
      const from = new Date(Date.now() - 1000);
      const to = new Date(Date.now() + year);
      const strictAssign = (m: { assetId: string; driverId: string }) =>
        asActor({ organizationId: org.a }, () => strict.create(m));

      const envelopes = COVERAGES.map((coverage) =>
        reprojected(insured.assetId, coverage, from, to),
      );
      for (const envelope of envelopes) await consumer.handle(envelope);
      // The command ran again: the same ids come back and change nothing.
      const before = await repository.findAssetRefUnscoped(insured.assetId);
      for (const envelope of envelopes) await consumer.handle(envelope);
      const after = await repository.findAssetRefUnscoped(insured.assetId);
      expect(after!.insuranceCover).toEqual(before!.insuranceCover);
      expect(after!.syncedAt).toEqual(before!.syncedAt);

      await expect(strictAssign(insured)).resolves.toMatchObject({ assetId: insured.assetId });
      await expect(strictAssign(uninsured)).rejects.toMatchObject(refused);
    });
  });

  describe('insurance across a transfer (#240 round 2, docs/24 Q-66 + Q-101)', () => {
    const COVERAGES = ['THIRD_PARTY', 'COMPREHENSIVE', 'PASSENGER_ACCIDENT', 'LIABILITY'];
    const refused = {
      code: 'BUSINESS_RULE_VIOLATION',
      message: expect.stringContaining('withdrawn from dispatch'),
    };

    /** An event as the given tenant's asset-service stream carries it. */
    const eventFor = (
      tenantId: string,
      eventName: string,
      payload: Record<string, unknown>,
    ): EventEnvelope => ({
      ...event(eventName, { ...payload, organizationId: tenantId }),
      tenantId,
    });

    /** org.a's machine, fully insured under generation 1 by its first owner. */
    async function insuredByFirstOwner(): Promise<string> {
      const { assetId } = await fleet();
      for (const coverage of COVERAGES) {
        await consumer.handle(
          event('INSURANCE_RECORDED', {
            assetId,
            policyId: id('INS'),
            insurerName: 'بیمه ایران',
            coverage,
            validFrom: new Date(Date.now() - 1000).toISOString(),
            validTo: new Date(Date.now() + year).toISOString(),
            ownershipGeneration: 1,
          }),
        );
      }
      return assetId;
    }

    /** Moves the machine to org.b and commissions it there. */
    async function transferTo(assetId: string, extra: Record<string, unknown>) {
      await consumer.handle(
        eventFor(org.b, 'ASSET_TRANSFERRED', {
          assetId,
          fromOrganizationId: org.a,
          toOrganizationId: org.b,
          transferredAt: new Date().toISOString(),
          reason: 'واگذاری',
          ...extra,
        }),
      );
      await consumer.handle(eventFor(org.b, 'ASSET_ACTIVATED', { assetId }));
    }

    async function newOwnerDriver(): Promise<string> {
      const driverId = id('DRV');
      await asActor({ organizationId: org.b }, () =>
        prisma.client.driver.create({
          data: {
            organizationId: org.b,
            id: driverId,
            userId: `USR-${driverId}`,
            createdBy: 'ITEST',
            updatedBy: 'ITEST',
          },
        }),
      );
      return driverId;
    }

    const dispatchForNewOwner = (assetId: string, driverId: string) =>
      asActor({ organizationId: org.b }, () => strict.create({ driverId, assetId }));

    it('refuses the new owner a coverage that does not follow the vehicle, until it records its own', async () => {
      const assetId = await insuredByFirstOwner();
      const driverId = await newOwnerDriver();
      await transferTo(assetId, {
        ownershipGeneration: 2,
        retainedCoverages: ['THIRD_PARTY', 'LIABILITY'],
      });

      const row = await repository.findAssetRefUnscoped(assetId);
      expect(Object.keys(row!.insuranceCover as object).sort()).toEqual([
        'LIABILITY',
        'THIRD_PARTY',
      ]);
      expect(row!.ownershipGeneration).toBe(2);
      expect(row!.retainedCoverages).toEqual(['THIRD_PARTY', 'LIABILITY']);
      await expect(dispatchForNewOwner(assetId, driverId)).rejects.toMatchObject(refused);

      for (const coverage of ['COMPREHENSIVE', 'PASSENGER_ACCIDENT']) {
        await consumer.handle(
          eventFor(org.b, 'INSURANCE_RECORDED', {
            assetId,
            policyId: id('INS'),
            insurerName: 'بیمه ایران',
            coverage,
            validFrom: new Date(Date.now() - 1000).toISOString(),
            validTo: new Date(Date.now() + year).toISOString(),
            ownershipGeneration: 2,
          }),
        );
      }
      await expect(dispatchForNewOwner(assetId, driverId)).resolves.toMatchObject({ assetId });
    });

    it('keeps every window of a coverage that follows the vehicle', async () => {
      const assetId = await insuredByFirstOwner();
      const driverId = await newOwnerDriver();
      await transferTo(assetId, { ownershipGeneration: 2, retainedCoverages: COVERAGES });

      await expect(dispatchForNewOwner(assetId, driverId)).resolves.toMatchObject({ assetId });
    });

    it('drops every window when the transfer event carries no retainedCoverages (an older event)', async () => {
      const assetId = await insuredByFirstOwner();
      const driverId = await newOwnerDriver();
      await transferTo(assetId, {});

      const row = await repository.findAssetRefUnscoped(assetId);
      expect(row!.insuranceCover).toEqual({});
      await expect(dispatchForNewOwner(assetId, driverId)).rejects.toMatchObject(refused);
    });

    it('after a legacy transfer (no generation) ignores the previous owner’s delayed event, and takes the current owner’s re-projected one', async () => {
      const assetId = await insuredByFirstOwner();
      const driverId = await newOwnerDriver();
      await transferTo(assetId, {});
      expect((await repository.findAssetRefUnscoped(assetId))!.ownershipGeneration).toBeNull();

      // Recorded by the first owner, consumed after the transfer: whatever it
      // says about its generation, it is not the replica's owner's.
      for (const generation of [undefined, 1, 5]) {
        for (const coverage of COVERAGES) {
          await consumer.handle(
            event('INSURANCE_RECORDED', {
              assetId,
              policyId: id('INS'),
              insurerName: 'بیمه ایران',
              coverage,
              validFrom: new Date(Date.now() - 1000).toISOString(),
              validTo: new Date(Date.now() + year).toISOString(),
              ...(generation === undefined ? {} : { ownershipGeneration: generation }),
            }),
          );
        }
      }
      expect((await repository.findAssetRefUnscoped(assetId))!.insuranceCover).toEqual({});
      await expect(dispatchForNewOwner(assetId, driverId)).rejects.toMatchObject(refused);

      // asset-service's re-projection says it again under the current owner.
      for (const coverage of COVERAGES) {
        await consumer.handle(
          eventFor(org.b, 'INSURANCE_RECORDED', {
            assetId,
            policyId: id('INS'),
            insurerName: 'بیمه ایران',
            coverage,
            validFrom: new Date(Date.now() - 1000).toISOString(),
            validTo: new Date(Date.now() + year).toISOString(),
            ownershipGeneration: 2,
          }),
        );
      }
      await expect(dispatchForNewOwner(assetId, driverId)).resolves.toMatchObject({ assetId });
    });

    it('a transfer that states no generation makes it unknown, so the departing owner’s delayed event at the old generation is ignored (#240 r5)', async () => {
      const assetId = id('AST');
      await consumer.handle(event('ASSET_CREATED', { assetId, status: 'ACTIVE', name: 'گریدر' }));
      const driverC = id('DRV');
      await asActor({ organizationId: orgC }, () =>
        prisma.client.driver.create({
          data: {
            organizationId: orgC,
            id: driverC,
            userId: `USR-${driverC}`,
            createdBy: 'ITEST',
            updatedBy: 'ITEST',
          },
        }),
      );
      // A → B states generation 1; B → C (an older producer's event) states none.
      await transferTo(assetId, { ownershipGeneration: 1, retainedCoverages: [] });
      expect((await repository.findAssetRefUnscoped(assetId))!.ownershipGeneration).toBe(1);
      await consumer.handle(
        eventFor(orgC, 'ASSET_TRANSFERRED', {
          assetId,
          fromOrganizationId: org.b,
          toOrganizationId: orgC,
          transferredAt: new Date().toISOString(),
          reason: 'واگذاری',
        }),
      );
      await consumer.handle(eventFor(orgC, 'ASSET_ACTIVATED', { assetId }));
      const afterSecond = await repository.findAssetRefUnscoped(assetId);
      expect(afterSecond!.organizationId).toBe(orgC);
      expect(afterSecond!.ownershipGeneration).toBeNull();

      // B's policy, recorded at generation 1 and consumed after both transfers.
      await consumer.handle(
        eventFor(org.b, 'INSURANCE_RECORDED', {
          assetId,
          policyId: id('INS'),
          insurerName: 'بیمه ایران',
          coverage: 'THIRD_PARTY',
          validFrom: new Date(Date.now() - 1000).toISOString(),
          validTo: new Date(Date.now() + year).toISOString(),
          ownershipGeneration: 1,
        }),
      );

      expect((await repository.findAssetRefUnscoped(assetId))!.insuranceCover).toEqual({});
      await expect(
        asActor({ organizationId: orgC }, () => strict.create({ driverId: driverC, assetId })),
      ).rejects.toMatchObject(refused);
    });

    it('ignores a late INSURANCE_RECORDED of the previous owner after the transfer', async () => {
      const { assetId } = await fleet();
      const driverId = await newOwnerDriver();
      await transferTo(assetId, { ownershipGeneration: 2, retainedCoverages: [] });

      for (const coverage of COVERAGES) {
        // Recorded by the first owner (generation 1), consumed after the transfer.
        await consumer.handle(
          event('INSURANCE_RECORDED', {
            assetId,
            policyId: id('INS'),
            insurerName: 'بیمه ایران',
            coverage,
            validFrom: new Date(Date.now() - 1000).toISOString(),
            validTo: new Date(Date.now() + year).toISOString(),
            ownershipGeneration: 1,
          }),
        );
      }

      const row = await repository.findAssetRefUnscoped(assetId);
      expect(row!.insuranceCover).toEqual({});
      expect(row!.organizationId).toBe(org.b);
      await expect(dispatchForNewOwner(assetId, driverId)).rejects.toMatchObject(refused);
    });
  });

  /**
   * #240 round 6 (ADR-061 § 4): an `INSURANCE_RECORDED` is applied only as
   * asset-service confirms it now. The routes that used to slip a stale policy
   * past the owner and generation checks — a dead-letter replay after the
   * following list was narrowed, a delayed first-tenure event after A→B→A with
   * no generation — now meet the source, which says no.
   */
  describe('verified at its source (#240 round 6)', () => {
    const refused = {
      code: 'BUSINESS_RULE_VIOLATION',
      message: expect.stringContaining('withdrawn from dispatch'),
    };
    const day = 86_400_000;
    /** Dispatch needs COMPREHENSIVE in force and nothing else. */
    let comprehensive: AssignmentService;

    beforeAll(() => {
      comprehensive = new AssignmentService(repository, {
        blockingCoverages: ['COMPREHENSIVE'],
        requiredCoverages: ['COMPREHENSIVE'],
      });
    });

    const dispatch = (assetId: string, driverId: string) =>
      asActor({ organizationId: org.a }, () => comprehensive.create({ driverId, assetId }));

    const policyEvent = (assetId: string, policyId: string, generation?: number): EventEnvelope =>
      event('INSURANCE_RECORDED', {
        assetId,
        policyId,
        insurerName: 'بیمه ایران',
        coverage: 'COMPREHENSIVE',
        validFrom: new Date(Date.now() - day).toISOString(),
        validTo: new Date(Date.now() + 100 * day).toISOString(),
        ...(generation === undefined ? {} : { ownershipGeneration: generation }),
      });

    const confirmed = (validUntil: Date, ownershipGeneration: number) => ({
      counts: true as const,
      organizationId: org.a,
      coverage: 'COMPREHENSIVE',
      validFrom: new Date(Date.now() - day).toISOString(),
      validUntil: validUntil.toISOString(),
      ownershipGeneration,
    });

    it('DLQ replay after narrowing: the source says no, so the event is ignored and dispatch stays refused', async () => {
      const { assetId, driverId } = await fleet();
      const policyId = id('INS');
      policies.deny(policyId, 'NOT_FOLLOWING_VEHICLE');
      const replayed = policyEvent(assetId, policyId, 1);

      // The event passes every cheap check — the owner is its tenant — and is
      // acknowledged, not applied.
      await consumer.handle(replayed);
      await consumer.handle(replayed, { topic: 'rasta.insurance.v1.retry' } as never);

      const row = await repository.findAssetRefUnscoped(assetId);
      expect(row!.insuranceCover).toEqual({});
      expect(policies.asked).toContainEqual({ organizationId: org.a, assetId, policyId });
      await expect(dispatch(assetId, driverId)).rejects.toMatchObject(refused);
    });

    it('A→B→A with no generation: a delayed first-tenure event of A is not applied; one the source confirms is, with its window', async () => {
      const { assetId, driverId } = await fleet();
      const transfer = (from: string, to: string) =>
        consumer.handle({
          ...event('ASSET_TRANSFERRED', {
            assetId,
            fromOrganizationId: from,
            toOrganizationId: to,
            transferredAt: new Date().toISOString(),
            reason: 'واگذاری',
          }),
          tenantId: to,
          payload: {
            assetId,
            organizationId: to,
            fromOrganizationId: from,
            toOrganizationId: to,
            transferredAt: new Date().toISOString(),
            reason: 'واگذاری',
          },
        });
      await transfer(org.a, org.b);
      await transfer(org.b, org.a);
      await consumer.handle(event('ASSET_ACTIVATED', { assetId }));
      expect((await repository.findAssetRefUnscoped(assetId))!.ownershipGeneration).toBeNull();

      const stale = id('INS');
      policies.deny(stale);
      await consumer.handle(policyEvent(assetId, stale, 1));
      expect((await repository.findAssetRefUnscoped(assetId))!.insuranceCover).toEqual({});
      await expect(dispatch(assetId, driverId)).rejects.toMatchObject(refused);

      // A policy of the current tenure: stored with the source's window (not the
      // event's, which ran 100 days).
      const current = id('INS');
      const until = new Date(Date.now() + 30 * day);
      policies.set(current, confirmed(until, 2));
      await consumer.handle(policyEvent(assetId, current, 2));
      const row = await repository.findAssetRefUnscoped(assetId);
      expect(row!.insuranceCover).toEqual({
        COMPREHENSIVE: [
          expect.objectContaining({
            policyId: current,
            validTo: until.toISOString(),
            generation: 2,
          }),
        ],
      });
      await expect(dispatch(assetId, driverId)).resolves.toMatchObject({ assetId });
    });

    it('asset-service down: the event fails and leaves no marker, nothing is applied; once it is up, the same event applies', async () => {
      const { assetId, driverId } = await fleet();
      const policyId = id('INS');
      const event1 = policyEvent(assetId, policyId, 0);
      policies.set(policyId, confirmed(new Date(Date.now() + 50 * day), 0));

      policies.unreachable();
      await expect(consumer.handle(event1)).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
      expect((await repository.findAssetRefUnscoped(assetId))!.insuranceCover).toEqual({});
      await expect(dispatch(assetId, driverId)).rejects.toMatchObject(refused);

      policies.unreachable(false);
      await consumer.handle(event1);
      await expect(dispatch(assetId, driverId)).resolves.toMatchObject({ assetId });
    });
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

      const row = await repository.findAssetRefUnscoped(assetId);
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

    it('refuses an assignment whose transaction began while the policy was in force but locked after it ended (#2)', async () => {
      const { assetId, driverId } = await fleet();
      const validTo = new Date(Date.now() + 2_500);
      await recordPolicy(assetId, new Date(Date.now() - 1000), validTo);

      // The assignment starts in time — it passes the early checks and opens
      // its transaction — then queues behind the lock across `validTo`. A
      // check against the transaction's start (`now()`) would still call the
      // policy in force; the clock is read after the lock is won.
      const release = await holdAssetLock(assetId);
      const attempt = assign(org.a, assetId, driverId);
      attempt.catch(() => undefined);
      await waitForBlocked(1);
      while (Date.now() < validTo.getTime() + 200) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
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

    it('reads the replica by organization on the request path, and unscoped only by name', async () => {
      const { assetId } = await fleet();

      expect(await repository.findAssetRef(org.a, assetId)).toMatchObject({ id: assetId });
      expect(await repository.findAssetRef(org.b, assetId)).toBeNull();
      expect(await repository.findAssetRefs(org.b, [assetId])).toEqual([]);
      expect(await repository.findAssetRefs(org.a, [assetId])).toHaveLength(1);
      expect(await repository.findAssetRefUnscoped(assetId)).toMatchObject({
        organizationId: org.a,
      });
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
      // The refusal can settle before release() returns (it awaits the holder's
      // commit), so observe it now; otherwise Node reports an unhandled
      // rejection and Jest fails the test with the expected error.
      attempt.catch(() => undefined);
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
