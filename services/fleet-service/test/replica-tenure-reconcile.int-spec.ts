import { ulid } from 'ulid';
import type { EventEnvelope } from '@rasta/contracts';
import { RastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import { PrismaService } from '../src/prisma/prisma.service';
import { FleetRepository } from '../src/fleet/fleet.repository';
import { AssignmentService } from '../src/fleet/assignment.service';
import { AssetSyncConsumer } from '../src/consumers/asset-sync.consumer';
import { CLEARANCE_CALLER, TransferClearanceService } from '../src/fleet/transfer-clearance';
import type { AssetSnapshot, AssetSnapshotSource } from '../src/consumers/replica-sources';
import type { TransferRecordSource } from '../src/fleet/transfer-record';
import { FakePolicySource } from './policy-source.fake';
import { asActor, cleanup, id, newPrisma, producerShaped, tenants } from './helpers';

/**
 * #240 r13, against PostgreSQL: two ways a replica could keep an earlier
 * tenure's insurance for a machine's owner.
 *
 * 1. A late ORIGINAL `ASSET_CREATED`. Replays move the replica C→A→B (generation
 *    2) and B insures the machine; then C's creation event, held back all along,
 *    arrives. Before r13 it was applied to the existing row: the owner became C,
 *    the generation and B's window stayed, C's queued activation passed the owner
 *    check and C's assignment was authorized on B's policy. Now an ASSET_CREATED
 *    initialises only an absent row; an existing one is reconciled from
 *    asset-service, which names B.
 *
 * 2. A row the generation migration left UNKNOWN (NULL), after an A→B→A the
 *    replica saw before the column existed: A's first-tenure window, recorded
 *    with no generation, is still there. Before r13 a same-owner refresh to
 *    generation 2 kept it — it only cleaned up from a KNOWN earlier generation —
 *    and A's assignment passed on it; the later transfers at or below 2 were then
 *    ignored as history and could not clear it either. Now an unknown generation
 *    is an uncertain tenure, and only windows verified under the snapshot's
 *    generation survive the refresh.
 */
describe('a replica never keeps an earlier tenure’s insurance (#240 r13)', () => {
  const org = tenants();
  const more = tenants();
  const A = org.a;
  const B = org.b;
  const C = more.a;
  const ALL = [A, B, C];
  const RETRY = Object.freeze({ topic: 'rasta.asset.v1.retry', partition: 0 });
  const ORIGINAL = Object.freeze({ topic: 'rasta.asset.v1', partition: 0 });
  const year = 365 * 86_400_000;

  let prisma: PrismaService;
  let repository: FleetRepository;
  let policies: FakePolicySource;
  let consumer: AssetSyncConsumer;
  let clearance: TransferClearanceService;
  /** Comprehensive cover is required, so one policy makes the machine dispatchable. */
  let comprehensive: AssignmentService;

  /** asset-service now: the owner, and the owners before it in order (A→B→A lists A then B). */
  const truths = new Map<string, { owner: string; previousOwners: string[] }>();
  const asked: string[] = [];

  const assetSource: AssetSnapshotSource = {
    async snapshot(organizationId, assetId): Promise<AssetSnapshot | null> {
      asked.push(`${organizationId}:${assetId}`);
      const t = truths.get(assetId);
      if (!t) throw RastaError.upstreamUnavailable('asset-service');
      if (organizationId !== t.owner && !t.previousOwners.includes(organizationId)) return null;
      return {
        assetId,
        organizationId: t.owner,
        status: 'ACTIVE',
        name: 'لودر',
        type: 'LOADER',
        assetTag: null,
        transferGeneration: t.previousOwners.length,
        viaTransfer: organizationId !== t.owner,
      };
    },
  };
  const transferRecords: TransferRecordSource = {
    async resolve(organizationId, assetId) {
      const t = truths.get(assetId);
      if (!t) throw RastaError.upstreamUnavailable('asset-service');
      return t.previousOwners.includes(organizationId) ? 'RECORDED' : 'NOT_RECORDED';
    },
  };

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    repository = new FleetRepository(prisma);
    policies = new FakePolicySource();
    consumer = new AssetSyncConsumer(
      null,
      repository,
      assetSource,
      undefined,
      transferRecords,
      policies,
    );
    clearance = new TransferClearanceService(repository);
    comprehensive = new AssignmentService(repository, {
      blockingCoverages: ['COMPREHENSIVE'],
      requiredCoverages: ['COMPREHENSIVE'],
    });
    await cleanup(prisma, ALL);
  });

  afterAll(async () => {
    await prisma.client.$executeRawUnsafe(
      `DELETE FROM asset_transfer_fence WHERE organization_id = ANY($1::text[])`,
      ALL,
    );
    await cleanup(prisma, ALL);
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
    payload: producerShaped(eventName, payload),
  });

  const transfer = (assetId: string, from: string, to: string, generation: number) =>
    event('ASSET_TRANSFERRED', to, {
      assetId,
      fromOrganizationId: from,
      toOrganizationId: to,
      transferredAt: new Date().toISOString(),
      reason: 'واگذاری',
      ownershipGeneration: generation,
      retainedCoverages: [],
    });

  /** A policy asset-service confirms for `owner` at `generation`, and its event. */
  function insured(assetId: string, owner: string, generation: number): EventEnvelope {
    const policyId = id('INS');
    const validFrom = new Date(Date.now() - 1000).toISOString();
    const validTo = new Date(Date.now() + year).toISOString();
    policies.set(policyId, {
      counts: true,
      organizationId: owner,
      coverage: 'COMPREHENSIVE',
      validFrom,
      validUntil: validTo,
      ownershipGeneration: generation,
    });
    return event('INSURANCE_RECORDED', owner, {
      assetId,
      organizationId: owner,
      policyId,
      insurerName: 'بیمه ایران',
      coverage: 'COMPREHENSIVE',
      validFrom,
      validTo,
      ownershipGeneration: generation,
    });
  }

  function asService<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
    const context: RequestContext = {
      correlationId: `itest-${ulid()}`,
      requestId: `itest-${ulid()}`,
      organizationId,
      roles: ['SERVICE'],
      organizationIds: [],
      authType: 'SERVICE',
      callerService: CLEARANCE_CALLER,
      startedAt: Date.now(),
    };
    return runWithContext(context, async () => fn());
  }

  const fenceFor = (organizationId: string, assetId: string) =>
    asService(organizationId, () =>
      clearance.clear(assetId, { fenceId: `TRF_${ulid()}`, ttlSeconds: 600 }),
    );

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

  const assign = async (organizationId: string, assetId: string) => {
    const driverId = await driver(organizationId);
    return asActor({ organizationId }, () => comprehensive.create({ driverId, assetId }));
  };

  const fenceOwners = async (assetId: string) =>
    (
      await prisma.client.$queryRawUnsafe<{ organization_id: string }[]>(
        `SELECT organization_id FROM asset_transfer_fence WHERE asset_id = $1`,
        assetId,
      )
    ).map((row) => row.organization_id);

  const markers = (eventId: string) => prisma.client.processedEvent.count({ where: { eventId } });

  /** Refused for want of insurance in force, not for any other reason. */
  const uninsured = {
    code: 'BUSINESS_RULE_VIOLATION',
    message: expect.stringContaining('withdrawn from dispatch'),
  };

  it('replays C→A→B, B insured at 2, then the late original ASSET_CREATED of C: reconciled, nothing moves; C’s activation and assignment are refused', async () => {
    const assetId = id('AST');
    // C registers the machine at asset-service; its ASSET_CREATED is held back.
    truths.set(assetId, { owner: C, previousOwners: [] });
    const lateCreation = event('ASSET_CREATED', C, {
      assetId,
      organizationId: C,
      name: 'نام هنگام ثبت',
      status: 'ACTIVE',
    });

    // C clears its transfer to A (a fence on a machine the replica has not seen
    // yet), and asset-service transfers C→A (generation 1).
    expect(await fenceFor(C, assetId)).toMatchObject({ clear: true });
    expect(await fenceOwners(assetId)).toEqual([C]);
    truths.set(assetId, { owner: A, previousOwners: [C] });

    // An operator replays the C→A transfer (.retry): the refresh creates the row
    // for A at generation 1 and lifts C's recorded fence.
    await consumer.handle(transfer(assetId, C, A, 1), RETRY);
    expect(await repository.findAssetRefUnscoped(assetId)).toMatchObject({
      organizationId: A,
      ownershipGeneration: 1,
    });
    expect(await fenceOwners(assetId)).toEqual([]);

    // A clears its transfer to B; asset-service transfers A→B (generation 2); a
    // second replay moves the replica to B and lifts A's fence.
    expect(await fenceFor(A, assetId)).toMatchObject({ clear: true });
    truths.set(assetId, { owner: B, previousOwners: [C, A] });
    await consumer.handle(transfer(assetId, A, B, 2), RETRY);
    expect(await repository.findAssetRefUnscoped(assetId)).toMatchObject({
      organizationId: B,
      ownershipGeneration: 2,
    });
    expect(await fenceOwners(assetId)).toEqual([]);

    // B insures the machine (generation 2): verified, applied.
    await consumer.handle(insured(assetId, B, 2));
    const before = await repository.findAssetRefUnscoped(assetId);
    expect(before!.insuranceCover).toMatchObject({ COMPREHENSIVE: [{ generation: 2 }] });

    // The late ORIGINAL ASSET_CREATED of C: asset-service is asked as C (C is a
    // previous owner, so it answers with the current one) and the row stays B's.
    const askedBefore = asked.length;
    await consumer.handle(lateCreation, ORIGINAL);
    expect(asked.slice(askedBefore)).toEqual([`${C}:${assetId}`]);
    expect(await markers(lateCreation.eventId)).toBe(1);
    const after = await repository.findAssetRefUnscoped(assetId);
    expect(after).toMatchObject({
      organizationId: B,
      ownershipGeneration: 2,
      status: 'ACTIVE',
      name: 'لودر',
      insuranceCover: before!.insuranceCover,
      insuranceRevision: before!.insuranceRevision,
    });
    expect(await fenceOwners(assetId)).toEqual([]);

    // C's queued activation is refused: the replica's owner is B.
    const activation = event('ASSET_ACTIVATED', C, { assetId, organizationId: C });
    await expect(consumer.handle(activation, ORIGINAL)).rejects.toThrow();
    expect(await markers(activation.eventId)).toBe(0);

    // C's assignment is refused (the machine is not C's); B's, on B's insurance, is not.
    await expect(assign(C, assetId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await assign(B, assetId)).assetId).toBe(assetId);
  });

  it('an ASSET_CREATED with asset-service unreachable is not applied to the existing row: retried, nothing written', async () => {
    const assetId = id('AST');
    truths.set(assetId, { owner: B, previousOwners: [C, A] });
    await consumer.handle(transfer(assetId, A, B, 2), RETRY);
    const before = await repository.findAssetRefUnscoped(assetId);
    truths.delete(assetId);

    const lateCreation = event('ASSET_CREATED', C, {
      assetId,
      organizationId: C,
      status: 'ACTIVE',
    });
    await expect(consumer.handle(lateCreation, ORIGINAL)).rejects.toThrow(
      /temporarily unavailable/,
    );
    expect(await markers(lateCreation.eventId)).toBe(0);
    expect(await repository.findAssetRefUnscoped(assetId)).toMatchObject({
      organizationId: B,
      ownershipGeneration: 2,
      insuranceRevision: before!.insuranceRevision,
    });
  });

  it('from migrated data (generation NULL, A→B→A seen before the column): A’s first-tenure window is not kept by a refresh, and A dispatches only on its current policy', async () => {
    const assetId = id('AST');
    // The replica as the generation migration left it: A's machine again after
    // A→B→A, generation unknown, nothing retained, and A's FIRST-tenure policy
    // still recorded (in force, no generation: written before windows had one).
    await consumer.handle(
      event('ASSET_CREATED', A, { assetId, organizationId: A, status: 'ACTIVE' }),
    );
    const legacy = {
      COMPREHENSIVE: [
        {
          policyId: id('INS'),
          validFrom: new Date(Date.now() - year).toISOString(),
          validTo: new Date(Date.now() + year).toISOString(),
        },
      ],
    };
    await prisma.client.$executeRawUnsafe(
      `UPDATE asset_ref
          SET ownership_generation = NULL, retained_coverages = ARRAY[]::text[],
              insurance_cover = $2::jsonb, status = 'ACTIVE'
        WHERE id = $1`,
      assetId,
      JSON.stringify(legacy),
    );
    const migrated = await repository.findAssetRefUnscoped(assetId);
    expect(migrated).toMatchObject({ organizationId: A, ownershipGeneration: null });
    truths.set(assetId, { owner: A, previousOwners: [A, B] });

    // A replayed state event of A refreshes the row: generation 2, and the
    // first-tenure window — which cannot be placed in the current tenure — goes.
    await consumer.handle(event('ASSET_ACTIVATED', A, { assetId }), RETRY);
    const refreshed = await repository.findAssetRefUnscoped(assetId);
    expect(refreshed).toMatchObject({
      organizationId: A,
      ownershipGeneration: 2,
      retainedCoverages: [],
    });
    expect(refreshed!.insuranceCover).toEqual({});
    expect(refreshed!.insuranceRevision).toBeGreaterThan(migrated!.insuranceRevision);
    await expect(assign(A, assetId)).rejects.toMatchObject(uninsured);

    // The transfers the replica missed arrive late: history (≤ 2), ignored.
    const lateOut = transfer(assetId, A, B, 1);
    const lateBack = transfer(assetId, B, A, 2);
    await consumer.handle(lateOut, ORIGINAL);
    await consumer.handle(lateBack, ORIGINAL);
    expect(await markers(lateOut.eventId)).toBe(1);
    expect(await markers(lateBack.eventId)).toBe(1);
    const afterLate = await repository.findAssetRefUnscoped(assetId);
    expect(afterLate).toMatchObject({ organizationId: A, ownershipGeneration: 2 });
    expect(afterLate!.insuranceCover).toEqual({});
    await expect(assign(A, assetId)).rejects.toMatchObject(uninsured);

    // A's current-tenure policy (generation 2), verified: dispatch passes.
    await consumer.handle(insured(assetId, A, 2));
    expect((await assign(A, assetId)).assetId).toBe(assetId);
  });

  it('from migrated data on a machine never transferred (generation 0): the refresh keeps its windows', async () => {
    const assetId = id('AST');
    await consumer.handle(
      event('ASSET_CREATED', A, { assetId, organizationId: A, status: 'ACTIVE' }),
    );
    const legacy = {
      COMPREHENSIVE: [
        {
          policyId: id('INS'),
          validFrom: new Date(Date.now() - year).toISOString(),
          validTo: new Date(Date.now() + year).toISOString(),
        },
      ],
    };
    await prisma.client.$executeRawUnsafe(
      `UPDATE asset_ref
          SET ownership_generation = NULL, insurance_cover = $2::jsonb, status = 'ACTIVE'
        WHERE id = $1`,
      assetId,
      JSON.stringify(legacy),
    );
    truths.set(assetId, { owner: A, previousOwners: [] });

    await consumer.handle(event('ASSET_ACTIVATED', A, { assetId }), RETRY);

    expect(await repository.findAssetRefUnscoped(assetId)).toMatchObject({
      organizationId: A,
      ownershipGeneration: 0,
      insuranceCover: legacy,
    });
    expect((await assign(A, assetId)).assetId).toBe(assetId);
  });
});
