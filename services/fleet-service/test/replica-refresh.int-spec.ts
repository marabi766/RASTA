import type { EventEnvelope } from '@rasta/contracts';
import { RastaError } from '@rasta/nest-common';
import { PrismaService } from '../src/prisma/prisma.service';
import { FleetRepository } from '../src/fleet/fleet.repository';
import { AssignmentService } from '../src/fleet/assignment.service';
import { AssetSyncConsumer } from '../src/consumers/asset-sync.consumer';
import type {
  AssetSnapshot,
  AssetSnapshotSource,
  MaintenanceStateSource,
} from '../src/consumers/replica-sources';
import type { TransferRecordSource } from '../src/fleet/transfer-record';
import { asActor, cleanup, id, newPrisma, tenants } from './helpers';

/**
 * D-039 — a state event replayed on `<topic>.retry` never applies its payload:
 * the replica is refreshed from the service that owns the state, so it ends
 * equal to the source's current state however late the replay arrives.
 * Against PostgreSQL, with the two owners replaced by a fake source of truth.
 */
describe('asset replica: a state event replayed on .retry refreshes from the source', () => {
  const org = tenants();
  const RETRY = Object.freeze({ topic: 'rasta.asset.v1.retry', partition: 0 });
  const MAINTENANCE_RETRY = Object.freeze({ topic: 'rasta.maintenance.v1.retry', partition: 0 });
  const ORIGINAL = Object.freeze({ topic: 'rasta.asset.v1', partition: 0 });

  let prisma: PrismaService;
  let repository: FleetRepository;
  let assignments: AssignmentService;

  /** What asset-service and maintenance-service say now. */
  interface Truth {
    owner: string;
    previousOwners: string[];
    status: string;
    name: string;
    type: string;
    assetTag: string | null;
    inMaintenance: boolean;
    reachable: boolean;
    known: boolean;
  }
  const truths = new Map<string, Truth>();
  const asked: string[] = [];

  const assetSource: AssetSnapshotSource = {
    async snapshot(organizationId, assetId): Promise<AssetSnapshot | null> {
      asked.push(`asset:${organizationId}`);
      const t = truths.get(assetId);
      if (!t || !t.reachable) throw RastaError.upstreamUnavailable('asset-service');
      if (!t.known) return null;
      // The current owner, or a previous owner followed to the current one.
      if (organizationId !== t.owner && !t.previousOwners.includes(organizationId)) return null;
      return {
        assetId,
        organizationId: t.owner,
        status: t.status,
        name: t.name,
        type: t.type,
        assetTag: t.assetTag,
        transferGeneration: t.previousOwners.length,
        viaTransfer: organizationId !== t.owner,
      };
    },
  };
  /**
   * asset-service's record of transfers, as the fence check asks it: a fence is
   * RECORDED when its organization is a previous owner of the machine.
   */
  const transferRecords: TransferRecordSource = {
    async resolve(organizationId, assetId) {
      const t = truths.get(assetId);
      if (!t || !t.reachable) throw RastaError.upstreamUnavailable('asset-service');
      return t.previousOwners.includes(organizationId) ? 'RECORDED' : 'NOT_RECORDED';
    },
  };

  /** Holds the next source call in flight until released, to interleave a newer delivery. */
  let gate: { entered: Promise<void>; release: () => void } | undefined;
  function holdSource(): NonNullable<typeof gate> {
    let release!: () => void;
    let entered!: () => void;
    gate = {
      entered: new Promise<void>((resolve) => (entered = resolve)),
      release: () => release(),
    };
    const released = new Promise<void>((resolve) => (release = resolve));
    const original = assetSource.snapshot.bind(assetSource);
    assetSource.snapshot = async (organizationId, assetId) => {
      assetSource.snapshot = original;
      entered();
      await released;
      return original(organizationId, assetId);
    };
    return gate;
  }

  async function waitForBlocked(n: number): Promise<void> {
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
  const maintenanceSource: MaintenanceStateSource = {
    async inMaintenance(_organizationId, assetId) {
      const t = truths.get(assetId);
      if (!t || !t.reachable) throw RastaError.upstreamUnavailable('maintenance-service');
      return t.inMaintenance;
    },
  };

  let consumer: AssetSyncConsumer;

  const event = (
    eventName: string,
    tenantId: string,
    payload: Record<string, unknown>,
    producer = 'asset-service',
  ): EventEnvelope => ({
    eventId: id('EVT'),
    eventName,
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    producer,
    producerVersion: '0.1.0',
    aggregateType: 'Asset',
    aggregateId: String(payload.assetId),
    tenantId,
    correlationId: id('COR'),
    payload,
  });

  function truth(assetId: string, overrides: Partial<Truth>): Truth {
    const t: Truth = {
      owner: org.a,
      previousOwners: [],
      status: 'ACTIVE',
      name: 'لودر',
      type: 'LOADER',
      assetTag: 'TAG-1',
      inMaintenance: false,
      reachable: true,
      known: true,
      ...overrides,
    };
    truths.set(assetId, t);
    return t;
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

  const activeOn = async (assetId: string) =>
    (
      await prisma.client.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM assignment WHERE asset_id = $1 AND ended_at IS NULL`,
        assetId,
      )
    )[0]!.n;

  const fenceOwners = async (assetId: string) =>
    (
      await prisma.client.$queryRawUnsafe<{ organization_id: string }[]>(
        `SELECT organization_id FROM asset_transfer_fence WHERE asset_id = $1`,
        assetId,
      )
    ).map((row) => row.organization_id);

  const place = (assetId: string, organizationId: string) =>
    // As the clearance does: the per-asset lock first, then the fence.
    repository.transaction(async (tx) => {
      await repository.lockAssetRef(tx, assetId);
      return repository.placeTransferFence(tx, assetId, organizationId, id('TRF'), 3600);
    });

  const replica = (assetId: string) => repository.findAssetRef(assetId);

  const markers = (eventId: string) => prisma.client.processedEvent.count({ where: { eventId } });

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    repository = new FleetRepository(prisma);
    assignments = new AssignmentService(repository);
    consumer = new AssetSyncConsumer(
      null,
      repository,
      assetSource,
      maintenanceSource,
      transferRecords,
    );
    await cleanup(prisma, [org.a, org.b]);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await prisma.client.$executeRawUnsafe(
      `DELETE FROM asset_transfer_fence WHERE organization_id = ANY($1::text[])`,
      [org.a, org.b],
    );
    await prisma.onModuleDestroy();
  });

  beforeEach(() => {
    asked.length = 0;
  });

  it('transfer, then a new-owner event: the replayed transfer lands the replica on the source’s state, ends the old owner’s assignment and drops its fence', async () => {
    const assetId = id('AST');
    // The replica still names A, with A's assignment open and A's fence up.
    await consumer.handle(
      event('ASSET_CREATED', org.a, {
        assetId,
        organizationId: org.a,
        status: 'ACTIVE',
        name: 'لودر',
      }),
    );
    await asActor({ organizationId: org.a }, async () =>
      assignments.create({ driverId: await driver(org.a), assetId }),
    );
    await place(assetId, org.a);
    // The source: transferred to B, then activated by B.
    truth(assetId, { owner: org.b, previousOwners: [org.a], status: 'ACTIVE' });

    const replay = event('ASSET_TRANSFERRED', org.b, {
      assetId,
      fromOrganizationId: org.a,
      toOrganizationId: org.b,
      transferredAt: new Date().toISOString(),
    });
    await consumer.handle(replay, RETRY);

    const row = await replica(assetId);
    expect(row).toMatchObject({
      organizationId: org.b,
      // The payload says REGISTERED; the source says ACTIVE.
      status: 'ACTIVE',
      name: 'لودر',
      assetType: 'LOADER',
      assetTag: 'TAG-1',
    });
    expect(await activeOn(assetId)).toBe(0);
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

  it('a delayed transfer after the new owner’s activation: no owner change, so the new owner’s assignment stays — and the old fence is dropped', async () => {
    const assetId = id('AST');
    // The new owner's ASSET_ACTIVATED created a minimal replica at B.
    await consumer.handle(event('ASSET_ACTIVATED', org.b, { assetId, organizationId: org.b }));
    await asActor({ organizationId: org.b }, async () =>
      assignments.create({ driverId: await driver(org.b), assetId }),
    );
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
    expect(await activeOn(assetId)).toBe(1);
    expect(await fenceOwners(assetId)).toEqual([]);
  });

  it('a pre-existing replica and an old activation replayed: a decommissioned machine stays decommissioned', async () => {
    const assetId = id('AST');
    await consumer.handle(
      event('ASSET_CREATED', org.a, { assetId, organizationId: org.a, status: 'ACTIVE' }),
    );
    truth(assetId, { owner: org.a, status: 'DECOMMISSIONED' });

    await consumer.handle(event('ASSET_ACTIVATED', org.a, { assetId }), RETRY);

    expect((await replica(assetId))?.status).toBe('DECOMMISSIONED');
  });

  it('a replayed ASSET_CREATED after a minimal replica: name, type and tag arrive from the source', async () => {
    const assetId = id('AST');
    await consumer.handle(event('ASSET_ACTIVATED', org.a, { assetId, organizationId: org.a }));
    expect((await replica(assetId))?.name).toBeNull();
    truth(assetId, {
      owner: org.a,
      status: 'ACTIVE',
      name: 'گریدر ۱۲',
      type: 'GRADER',
      assetTag: 'G-12',
    });

    await consumer.handle(
      event('ASSET_CREATED', org.a, {
        assetId,
        organizationId: org.a,
        status: 'REGISTERED',
        name: 'نام قدیمی',
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

  it('a first sighting on a replay creates the replica from the source, not the payload', async () => {
    const assetId = id('AST');
    truth(assetId, { owner: org.a, status: 'IN_MAINTENANCE', name: 'بیل مکانیکی' });

    await consumer.handle(
      event('ASSET_CREATED', org.a, { assetId, organizationId: org.a, status: 'REGISTERED' }),
      RETRY,
    );

    expect(await replica(assetId)).toMatchObject({
      organizationId: org.a,
      status: 'IN_MAINTENANCE',
      name: 'بیل مکانیکی',
    });
  });

  it('a replayed MAINTENANCE_STARTED / MAINTENANCE_COMPLETED sets in-maintenance from maintenance-service', async () => {
    const assetId = id('AST');
    await consumer.handle(
      event('ASSET_CREATED', org.a, { assetId, organizationId: org.a, status: 'ACTIVE' }),
    );

    // The repair started and finished since: the failed STARTED replays as false.
    truth(assetId, { owner: org.a, inMaintenance: false });
    await consumer.handle(
      event('MAINTENANCE_STARTED', org.a, { assetId }, 'maintenance-service'),
      MAINTENANCE_RETRY,
    );
    expect((await replica(assetId))?.inMaintenance).toBe(false);

    // A new repair began; the failed COMPLETED of the old one must not clear it.
    truths.get(assetId)!.inMaintenance = true;
    await consumer.handle(
      event('MAINTENANCE_COMPLETED', org.a, { assetId }, 'maintenance-service'),
      MAINTENANCE_RETRY,
    );
    expect((await replica(assetId))?.inMaintenance).toBe(true);
  });

  it('an unreachable source: retried, then dead-lettered — the payload is never applied', async () => {
    const assetId = id('AST');
    await consumer.handle(
      event('ASSET_CREATED', org.a, { assetId, organizationId: org.a, status: 'ACTIVE' }),
    );
    truth(assetId, { owner: org.a, status: 'DECOMMISSIONED', reachable: false });
    const replay = event('ASSET_STATUS_CHANGED', org.a, {
      assetId,
      organizationId: org.a,
      newStatus: 'OUT_OF_SERVICE',
    });

    await expect(consumer.handle(replay, RETRY)).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });

    expect((await replica(assetId))?.status).toBe('ACTIVE');
    expect(await markers(replay.eventId)).toBe(0);

    // A consumer built without its peers refuses a replay the same way.
    const unwired = new AssetSyncConsumer(null, repository);
    await expect(unwired.handle(replay, RETRY)).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
    expect((await replica(assetId))?.status).toBe('ACTIVE');
  });

  it('a source that does not know the asset for the named organization: SOURCE_UNCONFIRMED, nothing applied', async () => {
    const assetId = id('AST');
    truth(assetId, { owner: org.b, known: true });

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

  it('a replayed safety event keeps its own rule: it is applied, not refreshed', async () => {
    const assetId = id('AST');
    await consumer.handle(
      event('ASSET_CREATED', org.a, { assetId, organizationId: org.a, status: 'ACTIVE' }),
    );

    await consumer.handle(event('INSPECTION_FAILED', org.a, { assetId }), RETRY);

    expect(asked).toEqual([]);
    expect((await replica(assetId))?.inspectionBlockedReason).not.toBeNull();
  });

  describe('read and write under the asset’s lock (interleavings)', () => {
    it('H1: a newer original-topic event that arrives while the source call is in flight waits, and is applied after — never overwritten by the older snapshot', async () => {
      const assetId = id('AST');
      await consumer.handle(
        event('ASSET_CREATED', org.a, { assetId, organizationId: org.a, status: 'ACTIVE' }),
      );
      // The source, at the moment the retry reads it, says ACTIVE.
      truth(assetId, { owner: org.a, status: 'ACTIVE' });
      const held = holdSource();

      const retry = consumer.handle(
        event('ASSET_ACTIVATED', org.a, { assetId, organizationId: org.a }),
        RETRY,
      );
      await held.entered; // the retry holds the lock and is waiting on the source
      const newer = consumer.handle(
        event('ASSET_STATUS_CHANGED', org.a, {
          assetId,
          organizationId: org.a,
          newStatus: 'OUT_OF_SERVICE',
        }),
        ORIGINAL,
      );
      await waitForBlocked(1); // the newer delivery is queued behind the lock
      expect((await replica(assetId))?.status).toBe('ACTIVE');
      held.release();
      await Promise.all([retry, newer]);

      // The newer event was applied last: the older snapshot did not overwrite it.
      expect((await replica(assetId))?.status).toBe('OUT_OF_SERVICE');
    });

    it('H2: a fence B places while the retry reads owner A waits for the retry, and survives it', async () => {
      const assetId = id('AST');
      await consumer.handle(
        event('ASSET_CREATED', org.a, { assetId, organizationId: org.a, status: 'ACTIVE' }),
      );
      truth(assetId, { owner: org.a, status: 'ACTIVE' });
      const held = holdSource();

      const retry = consumer.handle(
        event('ASSET_ACTIVATED', org.a, { assetId, organizationId: org.a }),
        RETRY,
      );
      await held.entered;
      const placing = place(assetId, org.b);
      await waitForBlocked(1);
      held.release();
      await Promise.all([retry, placing]);

      expect(await fenceOwners(assetId)).toEqual([org.b]);
    });

    it('H2: never deletes the current owner’s fence, nor a fence whose transfer is not recorded', async () => {
      const assetId = id('AST');
      await consumer.handle(
        event('ASSET_CREATED', org.a, { assetId, organizationId: org.a, status: 'ACTIVE' }),
      );
      // A owns the machine and holds the fence of a transfer still committing.
      await place(assetId, org.a);
      truth(assetId, { owner: org.a, previousOwners: [] });
      await consumer.handle(event('ASSET_ACTIVATED', org.a, { assetId }), RETRY);
      expect(await fenceOwners(assetId)).toEqual([org.a]);

      // B's fence with A as the owner: B made no recorded transfer, so it stays.
      const other = id('AST');
      await consumer.handle(
        event('ASSET_CREATED', org.a, { assetId: other, organizationId: org.a, status: 'ACTIVE' }),
      );
      await place(other, org.b);
      truth(other, { owner: org.a, previousOwners: [] });
      await consumer.handle(event('ASSET_ACTIVATED', org.a, { assetId: other }), RETRY);
      expect(await fenceOwners(other)).toEqual([org.b]);
    });
  });

  describe('the source is asked as the event’s tenant (H4)', () => {
    async function blockedMachine(): Promise<string> {
      const assetId = id('AST');
      // B owns it, has an inspection block and a machine in the workshop.
      await consumer.handle(
        event('ASSET_CREATED', org.b, { assetId, organizationId: org.b, status: 'ACTIVE' }),
      );
      await consumer.handle(event('INSPECTION_FAILED', org.b, { assetId }));
      return assetId;
    }

    it('a replay for a tenant that never owned the machine is SOURCE_UNCONFIRMED: no marker, B’s block untouched', async () => {
      const assetId = await blockedMachine();
      truth(assetId, { owner: org.b, previousOwners: [], inMaintenance: false });
      const replay = event('MAINTENANCE_COMPLETED', org.a, { assetId }, 'maintenance-service');
      const before = await replica(assetId);

      await expect(consumer.handle(replay, MAINTENANCE_RETRY)).rejects.toMatchObject({
        reason: 'SOURCE_UNCONFIRMED',
      });

      expect(await markers(replay.eventId)).toBe(0);
      const after = await replica(assetId);
      expect(after?.inspectionBlockedReason).toBe(before?.inspectionBlockedReason);
      expect(after?.inspectionBlockedAt).toEqual(before?.inspectionBlockedAt);
      expect(after?.inMaintenance).toBe(before?.inMaintenance);
    });

    it('a replay for a previous owner is good for the owner change only: B’s inspection block and flag are untouched', async () => {
      const assetId = await blockedMachine();
      truth(assetId, { owner: org.b, previousOwners: [org.a], inMaintenance: true });
      const before = await replica(assetId);

      await consumer.handle(
        event('MAINTENANCE_COMPLETED', org.a, { assetId }, 'maintenance-service'),
        MAINTENANCE_RETRY,
      );

      const after = await replica(assetId);
      expect(after?.organizationId).toBe(org.b);
      expect(after?.inspectionBlockedReason).toBe(before?.inspectionBlockedReason);
      expect(after?.inspectionBlockedAt).toEqual(before?.inspectionBlockedAt);
      // Not refreshed from maintenance-service either: the tenant no longer owns the machine.
      expect(after?.inMaintenance).toBe(before?.inMaintenance);
    });
  });
});
