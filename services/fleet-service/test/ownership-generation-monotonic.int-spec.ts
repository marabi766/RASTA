import { ulid } from 'ulid';
import type { EventEnvelope } from '@rasta/contracts';
import { RastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import { PrismaService } from '../src/prisma/prisma.service';
import { FleetRepository } from '../src/fleet/fleet.repository';
import { AssignmentService } from '../src/fleet/assignment.service';
import { AssetSyncConsumer, DEFAULT_PARKING } from '../src/consumers/asset-sync.consumer';
import { CLEARANCE_CALLER, TransferClearanceService } from '../src/fleet/transfer-clearance';
import type { AssetSnapshot, AssetSnapshotSource } from '../src/consumers/replica-sources';
import type { TransferRecordSource } from '../src/fleet/transfer-record';
import { FakePolicySource } from './policy-source.fake';
import { asActor, cleanup, databaseUrl, id, newPrisma, producerShaped, tenants } from './helpers';

/**
 * #240 r12, against PostgreSQL: the replica's ownership generation only rises.
 *
 * The sequence Codex reproduced in round 12. Operator replays (`--allow-stale`)
 * refresh the replica C→A→B while the ORIGINAL C→A transfer (generation 1) is
 * still on its way. B records its insurance under generation 2. The late
 * original must then change nothing: before r12 the refresh wrote the
 * generation as unknown, the late transfer handed the machine back to A and kept
 * B's generation-2 window (2 ≥ 1), A's queued activation made it ACTIVE with no
 * fence (the refreshes had lifted A's), and A's assignment passed on B's
 * insurance.
 *
 * Also the delivery budget's bounds under real pool contention: every
 * asset-sync transaction waits at most its configured start wait, and the reads
 * an INSURANCE_RECORDED makes before its transaction at most the same.
 */
describe('the ownership generation only rises (#240 r12)', () => {
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
  /** Only comprehensive cover is required, so B's one policy makes the machine dispatchable. */
  let comprehensive: AssignmentService;

  /** asset-service now: the owner, and the owners before it in order. */
  const truths = new Map<string, { owner: string; previousOwners: string[] }>();

  const assetSource: AssetSnapshotSource = {
    async snapshot(organizationId, assetId): Promise<AssetSnapshot | null> {
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

  it('stale replays C→A→B, B insured at 2, then the late original C→A (1): nothing changes, and A’s activation and assignment are refused', async () => {
    const assetId = id('AST');
    // C's machine, in service.
    await consumer.handle(
      event('ASSET_CREATED', C, { assetId, organizationId: C, status: 'ACTIVE' }),
    );

    // C clears the transfer to A (its fence), and asset-service transfers: the
    // original C→A event (generation 1) is published but not consumed yet.
    expect(
      await asService(C, () =>
        clearance.clear(assetId, { fenceId: `TRF_${ulid()}`, ttlSeconds: 600 }),
      ),
    ).toMatchObject({ clear: true });
    truths.set(assetId, { owner: A, previousOwners: [C] });
    const lateOriginal = transfer(assetId, C, A, 1);

    // An operator replays a dead-lettered A event with --allow-stale: the refresh
    // moves the replica to A at generation 1 and lifts C's recorded fence. Each
    // question to asset-service is bracketed by the consumer's heartbeat.
    const heartbeat = jest.fn();
    await consumer.handle(event('ASSET_ACTIVATED', A, { assetId }), { ...RETRY, heartbeat });
    expect(await repository.findAssetRefUnscoped(assetId)).toMatchObject({
      organizationId: A,
      ownershipGeneration: 1,
    });
    expect(await fenceOwners(assetId)).toEqual([]);
    // The snapshot, then whether C's transfer was recorded: two questions, four beats.
    expect(heartbeat).toHaveBeenCalledTimes(4);

    // A clears its own transfer to B; asset-service transfers (generation 2).
    expect(
      await asService(A, () =>
        clearance.clear(assetId, { fenceId: `TRF_${ulid()}`, ttlSeconds: 600 }),
      ),
    ).toMatchObject({ clear: true });
    truths.set(assetId, { owner: B, previousOwners: [C, A] });

    // A second stale replay (the A→B transfer, on .retry): B at generation 2,
    // A's recorded fence lifted.
    await consumer.handle(transfer(assetId, A, B, 2), RETRY);
    expect(await repository.findAssetRefUnscoped(assetId)).toMatchObject({
      organizationId: B,
      ownershipGeneration: 2,
    });
    expect(await fenceOwners(assetId)).toEqual([]);

    // B insures the machine at asset-service (generation 2); verified, applied.
    const policyId = id('INS');
    const validFrom = new Date(Date.now() - 1000).toISOString();
    const validTo = new Date(Date.now() + year).toISOString();
    policies.set(policyId, {
      counts: true,
      organizationId: B,
      coverage: 'COMPREHENSIVE',
      validFrom,
      validUntil: validTo,
      ownershipGeneration: 2,
    });
    await consumer.handle(
      event('INSURANCE_RECORDED', B, {
        assetId,
        organizationId: B,
        policyId,
        insurerName: 'بیمه ایران',
        coverage: 'COMPREHENSIVE',
        validFrom,
        validTo,
        ownershipGeneration: 2,
      }),
    );
    const before = await repository.findAssetRefUnscoped(assetId);
    expect(before!.insuranceCover).toMatchObject({
      COMPREHENSIVE: [{ policyId, generation: 2 }],
    });

    // The late ORIGINAL C→A (generation 1) arrives: history. Marked, nothing changed.
    await consumer.handle(lateOriginal, ORIGINAL);
    expect(await markers(lateOriginal.eventId)).toBe(1);
    const after = await repository.findAssetRefUnscoped(assetId);
    expect(after).toMatchObject({
      organizationId: B,
      ownershipGeneration: 2,
      status: 'ACTIVE',
      insuranceCover: before!.insuranceCover,
      insuranceRevision: before!.insuranceRevision,
    });

    // A's queued activation is refused: the replica's owner is B.
    const activation = event('ASSET_ACTIVATED', A, { assetId, organizationId: A });
    await expect(consumer.handle(activation, ORIGINAL)).rejects.toThrow();
    expect(await markers(activation.eventId)).toBe(0);

    // A's assignment is refused; B's, on B's insurance, is not.
    await expect(assign(A, assetId)).rejects.toThrow();
    expect((await assign(B, assetId)).assetId).toBe(assetId);
  });

  describe('every asset-sync transaction and read is bounded under pool contention', () => {
    /** A one-connection pool, its only connection held by an open transaction until released. */
    async function contended(maxWaitMs: number) {
      const tiny = new PrismaService(
        `${databaseUrl()}${databaseUrl().includes('?') ? '&' : '?'}connection_limit=1&pool_timeout=20`,
      );
      await tiny.onModuleInit();
      const tinyRepository = new FleetRepository(tiny);
      let release!: () => void;
      let held!: () => void;
      const holding = new Promise<void>((resolve) => (held = resolve));
      const holder = tiny.transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1`;
          held();
          await new Promise<void>((resolve) => (release = resolve));
        },
        { timeoutMs: 30_000, maxWaitMs: 5_000 },
      );
      await holding;
      const tinyConsumer = new AssetSyncConsumer(
        null,
        tinyRepository,
        assetSource,
        undefined,
        transferRecords,
        policies,
        DEFAULT_PARKING,
        14_200,
        maxWaitMs,
      );
      return {
        tinyConsumer,
        release: async () => {
          release();
          await holder;
        },
        close: () => tiny.onModuleDestroy(),
      };
    }

    async function machineOfA(): Promise<string> {
      const assetId = id('AST');
      await consumer.handle(
        event('ASSET_CREATED', A, { assetId, organizationId: A, status: 'ACTIVE' }),
      );
      return assetId;
    }

    it('a transaction that cannot start within the start wait fails that attempt in about that time, not Prisma’s 2 s', async () => {
      const assetId = await machineOfA();
      const pool = await contended(300);
      try {
        const started = Date.now();
        const outcome = await pool.tinyConsumer
          .handle(
            event('ASSET_UPDATED', A, { assetId, organizationId: A, changedFields: ['name'] }),
          )
          .then(
            () => 'applied',
            (error: unknown) => error,
          );
        const took = Date.now() - started;

        expect(outcome).toBeInstanceOf(Error);
        expect(String((outcome as Error).message)).toMatch(/transaction|maxWait|time/i);
        expect(took).toBeGreaterThanOrEqual(250);
        expect(took).toBeLessThan(1_500);
      } finally {
        await pool.release();
        await pool.close();
      }
    }, 30_000);

    it('the reads before an INSURANCE_RECORDED’s transaction fail in about the start wait too, and nothing is asked', async () => {
      const assetId = await machineOfA();
      const policyId = id('INS');
      const asked = policies.asked.length;
      const pool = await contended(300);
      try {
        const started = Date.now();
        await expect(
          pool.tinyConsumer.handle(
            event('INSURANCE_RECORDED', A, {
              assetId,
              organizationId: A,
              policyId,
              insurerName: 'بیمه ایران',
              coverage: 'COMPREHENSIVE',
              validFrom: new Date().toISOString(),
              validTo: new Date(Date.now() + year).toISOString(),
            }),
          ),
        ).rejects.toThrow(/took longer than 300 ms/);
        expect(Date.now() - started).toBeLessThan(1_500);
        expect(policies.asked).toHaveLength(asked);
      } finally {
        await pool.release();
        await pool.close();
      }
    }, 30_000);

    it('a connection freed within the start wait: the delivery waits for it and applies', async () => {
      const assetId = await machineOfA();
      const pool = await contended(5_000);
      try {
        const handled = pool.tinyConsumer.handle(
          event('ASSET_STATUS_CHANGED', A, {
            assetId,
            organizationId: A,
            newStatus: 'OUT_OF_SERVICE',
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
        await pool.release();
        await handled;
        expect((await repository.findAssetRefUnscoped(assetId))?.status).toBe('OUT_OF_SERVICE');
      } finally {
        await pool.close();
      }
    }, 30_000);
  });
});
