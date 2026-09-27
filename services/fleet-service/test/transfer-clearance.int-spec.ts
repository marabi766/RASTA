import { ulid } from 'ulid';
import type { EventEnvelope } from '@rasta/contracts';
import { RastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import { PrismaService } from '../src/prisma/prisma.service';
import { FleetRepository } from '../src/fleet/fleet.repository';
import { AssignmentService } from '../src/fleet/assignment.service';
import { AssetSyncConsumer } from '../src/consumers/asset-sync.consumer';
import { CLEARANCE_CALLER, TransferClearanceService } from '../src/fleet/transfer-clearance';
import type { TransferRecordSource } from '../src/fleet/transfer-record';
import { asActor, cleanup, id, newPrisma, tenants } from './helpers';

/**
 * The transfer clearance and its fence (ADR-062, docs/23 D-033), against
 * PostgreSQL.
 *
 * asset-service asks here before it commits a transfer. The answer has to be
 * this service's own, only for the organization signed into the token, and it
 * has to stay true until the transfer lands: an assignment either committed
 * before the clearance and is counted, or comes after and meets the fence.
 * The race is made deterministic the way transfer-ends-assignment.int-spec
 * does it: a transaction holds the asset's lock while both contenders queue.
 */
describe('transfer clearance', () => {
  const org = tenants();
  let prisma: PrismaService;
  let repository: FleetRepository;
  let clearance: TransferClearanceService;
  let consumer: AssetSyncConsumer;
  let assignments: AssignmentService;

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    repository = new FleetRepository(prisma);
    clearance = new TransferClearanceService(repository);
    consumer = new AssetSyncConsumer(null, repository);
    assignments = new AssignmentService(repository);
    await cleanup(prisma, [org.a, org.b]);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await prisma.onModuleDestroy();
  });

  function asService<T>(
    callerService: string,
    organizationId: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const context: RequestContext = {
      correlationId: `itest-${ulid()}`,
      requestId: `itest-${ulid()}`,
      organizationId,
      roles: ['SERVICE'],
      organizationIds: [],
      authType: 'SERVICE',
      callerService,
      startedAt: Date.now(),
    };
    return runWithContext(context, async () => fn());
  }

  const fence = () => `TRF_${ulid()}`;

  const ask = (organizationId: string, assetId: string, fenceId = fence(), ttlSeconds = 600) =>
    asService(CLEARANCE_CALLER, organizationId, () =>
      clearance.clear(assetId, { fenceId, ttlSeconds }),
    );

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

  async function machine(organizationId: string): Promise<string> {
    const assetId = id('AST');
    await consumer.handle(
      event('ASSET_CREATED', organizationId, { assetId, organizationId, status: 'ACTIVE' }),
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

  const assign = async (organizationId: string, assetId: string) => {
    const driverId = await driver(organizationId);
    return asActor({ organizationId }, () => assignments.create({ driverId, assetId }));
  };

  const fenceRow = async (assetId: string) =>
    (
      await prisma.client.$queryRawUnsafe<
        { organization_id: string; fence_id: string; live: boolean }[]
      >(
        `SELECT organization_id, fence_id, expires_at > now() AS live
         FROM asset_transfer_fence WHERE asset_id = $1`,
        assetId,
      )
    )[0];

  const activeOn = async (assetId: string) =>
    (
      await prisma.client.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM assignment WHERE asset_id = $1 AND ended_at IS NULL`,
        assetId,
      )
    )[0]!.n;

  afterEach(async () => {
    await prisma.client.$executeRawUnsafe(
      `DELETE FROM asset_transfer_fence WHERE organization_id = ANY($1::text[])`,
      [org.a, org.b],
    );
  });

  it('clears a free machine, fences it, and the fence refuses a new assignment', async () => {
    const assetId = await machine(org.a);
    const fenceId = fence();

    const answer = await ask(org.a, assetId, fenceId);

    expect(answer).toMatchObject({ assetId, fenceId, clear: true, openAssignments: 0 });
    expect(new Date(answer.fencedUntil!).getTime()).toBeGreaterThan(Date.now());
    expect(await fenceRow(assetId)).toMatchObject({ organization_id: org.a, fence_id: fenceId });
    await expect(assign(org.a, assetId)).rejects.toMatchObject({
      code: 'BUSINESS_RULE_VIOLATION',
      internalContext: expect.objectContaining({ rule: 'ASSET_TRANSFER_IN_PROGRESS' }),
    });
    expect(await activeOn(assetId)).toBe(0);
  });

  it('reports an open assignment the asset service may not know about, and fences nothing', async () => {
    const assetId = await machine(org.a);
    await assign(org.a, assetId);

    const answer = await ask(org.a, assetId);

    expect(answer).toMatchObject({ clear: false, fencedUntil: null, openAssignments: 1 });
    expect(await fenceRow(assetId)).toBeUndefined();
  });

  it('answers only yes or no and counts: no assignment, driver or date', async () => {
    const assetId = await machine(org.a);
    await assign(org.a, assetId);

    const answer = await ask(org.a, assetId);

    expect(Object.keys(answer).sort()).toEqual(
      ['assetId', 'clear', 'fenceId', 'fencedUntil', 'openAssignments'].sort(),
    );
  });

  it('refuses a second transfer’s fence while one is live, and renews the same one', async () => {
    const assetId = await machine(org.a);
    const first = fence();
    await ask(org.a, assetId, first);

    await expect(ask(org.a, assetId)).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    await expect(ask(org.a, assetId, first)).resolves.toMatchObject({ clear: true });
    expect((await fenceRow(assetId))!.fence_id).toBe(first);
  });

  describe('an expired fence whose ASSET_TRANSFERRED has not arrived (review #127 #2)', () => {
    type Answer = 'RECORDED' | 'NOT_RECORDED' | 'UNREACHABLE';

    function source(answer: Answer) {
      const asked: unknown[][] = [];
      const records: TransferRecordSource & { asked: unknown[][] } = {
        asked,
        resolve: async (...args) => {
          asked.push(args);
          if (answer === 'UNREACHABLE') throw RastaError.upstreamUnavailable('asset-service');
          return answer;
        },
      };
      return records;
    }

    async function expiredFence(assetId: string): Promise<string> {
      const fenceId = fence();
      await ask(org.a, assetId, fenceId);
      await prisma.client.$executeRawUnsafe(
        `UPDATE asset_transfer_fence SET expires_at = now() - interval '1 second' WHERE asset_id = $1`,
        assetId,
      );
      return fenceId;
    }

    const assignWith = async (records: TransferRecordSource, assetId: string) => {
      const driverId = await driver(org.a);
      return asActor({ organizationId: org.a }, () =>
        new AssignmentService(repository, undefined, records).create({ driverId, assetId }),
      ).then(
        () => 'OK',
        (error: { code?: string; internalContext?: { rule?: string } }) =>
          error.internalContext?.rule ?? error.code ?? 'ERROR',
      );
    };

    it('refuses the assignment when the transfer was recorded, and keeps the fence', async () => {
      const assetId = await machine(org.a);
      const fenceId = await expiredFence(assetId);
      const records = source('RECORDED');

      expect(await assignWith(records, assetId)).toBe('ASSET_OWNER_CHANGED');
      expect(records.asked).toEqual([[org.a, assetId, fenceId]]);
      expect((await fenceRow(assetId))!.fence_id).toBe(fenceId);
    });

    it('lifts the fence and assigns when the transfer was not recorded', async () => {
      const assetId = await machine(org.a);
      await expiredFence(assetId);

      expect(await assignWith(source('NOT_RECORDED'), assetId)).toBe('OK');
      expect(await fenceRow(assetId)).toBeUndefined();
    });

    it('refuses, retryably, and keeps the fence when asset-service gives no answer', async () => {
      const assetId = await machine(org.a);
      const fenceId = await expiredFence(assetId);

      expect(await assignWith(source('UNREACHABLE'), assetId)).toBe('UPSTREAM_UNAVAILABLE');
      // And a service built without asset-service never lifts it by time.
      await expect(assign(org.a, assetId)).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
      });
      expect((await fenceRow(assetId))!.fence_id).toBe(fenceId);
    });

    it('lets a new clearance take its place only once its transfer is known not recorded', async () => {
      const assetId = await machine(org.a);
      const stale = await expiredFence(assetId);
      const next = fence();
      const clearWith = (records: TransferRecordSource) =>
        asService(CLEARANCE_CALLER, org.a, () =>
          new TransferClearanceService(repository, records).clear(assetId, {
            fenceId: next,
            ttlSeconds: 600,
          }),
        );

      await expect(clearWith(source('RECORDED'))).rejects.toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
      });
      await expect(ask(org.a, assetId, next)).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
      });
      expect((await fenceRow(assetId))!.fence_id).toBe(stale);

      await expect(clearWith(source('NOT_RECORDED'))).resolves.toMatchObject({
        clear: true,
        fenceId: next,
      });
      expect((await fenceRow(assetId))!.fence_id).toBe(next);
    });
  });

  it('a release that arrives while its clearance is still writing waits for the fence and removes it (review #127 #4)', async () => {
    const assetId = await machine(org.a);
    const fenceId = fence();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    let written!: () => void;
    const isWritten = new Promise<void>((resolve) => (written = resolve));

    const clearing = prisma.client.$transaction(
      async (tx) => {
        await repository.lockAssetRef(tx as never, assetId);
        await repository.placeTransferFence(tx as never, assetId, org.a, fenceId, 600);
        written();
        await finished;
      },
      { timeout: 30_000 },
    );
    await isWritten;

    const released = asService(CLEARANCE_CALLER, org.a, () => clearance.release(assetId, fenceId));
    for (let attempt = 0; attempt < 400; attempt++) {
      const rows = await prisma.client.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if (rows[0]!.n >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    finish();
    await clearing;
    await released;

    expect(await fenceRow(assetId)).toBeUndefined();
  });

  it('releases a fence for a transfer that did not happen, and only its own', async () => {
    const assetId = await machine(org.a);
    const fenceId = fence();
    await ask(org.a, assetId, fenceId);

    // Another organization, or another fence id, lifts nothing.
    await asService(CLEARANCE_CALLER, org.b, () => clearance.release(assetId, fenceId));
    await asService(CLEARANCE_CALLER, org.a, () => clearance.release(assetId, fence()));
    expect(await fenceRow(assetId)).toBeDefined();

    await asService(CLEARANCE_CALLER, org.a, () => clearance.release(assetId, fenceId));
    expect(await fenceRow(assetId)).toBeUndefined();
    await expect(assign(org.a, assetId)).resolves.toMatchObject({ assetId });
  });

  it('lifts the previous owner’s fence when the transfer lands, so the new owner can assign', async () => {
    const assetId = await machine(org.a);
    await ask(org.a, assetId);

    await consumer.handle(
      event('ASSET_TRANSFERRED', org.b, {
        assetId,
        fromOrganizationId: org.a,
        toOrganizationId: org.b,
        reason: 'واگذاری',
        referenceNo: null,
        transferredAt: new Date().toISOString(),
      }),
    );

    expect(await fenceRow(assetId)).toBeUndefined();
    // The previous owner is refused by the replica now, not by the fence.
    await expect(assign(org.a, assetId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // REGISTERED after a transfer: the new owner must re-commission first.
    await consumer.handle(
      event('ASSET_STATUS_CHANGED', org.b, { assetId, newStatus: 'ACTIVE', organizationId: org.b }),
    );
    await expect(assign(org.b, assetId)).resolves.toMatchObject({ assetId });
  });

  describe('tenant isolation', () => {
    it('does not answer about a machine the replica places in another organization', async () => {
      const assetId = await machine(org.a);
      await assign(org.a, assetId);

      await expect(ask(org.b, assetId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await fenceRow(assetId)).toBeUndefined();
    });

    it('counts only the signed organization’s work on a machine it does not have yet', async () => {
      // A replica that has not seen the machine: no row, nothing to compare.
      const unseen = id('AST');
      const answer = await ask(org.b, unseen);
      expect(answer).toMatchObject({ clear: true, openAssignments: 0 });
      expect((await fenceRow(unseen))!.organization_id).toBe(org.b);
    });

    it('refuses every other service, every user, and a token with no organization', async () => {
      const assetId = await machine(org.a);
      const dto = { fenceId: fence(), ttlSeconds: 600 };

      await expect(
        asService('economic-service', org.a, () => clearance.clear(assetId, dto)),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        asActor({ organizationId: org.a, roles: ['ORGANIZATION_ADMIN', 'SYSTEM_ADMIN'] }, () =>
          clearance.clear(assetId, dto),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        asService(CLEARANCE_CALLER, undefined, () => clearance.clear(assetId, dto)),
      ).rejects.toMatchObject({ code: 'SERVICE_TENANT_CONTEXT_INVALID' });
      await expect(
        asActor({ organizationId: org.a }, () => clearance.release(assetId, dto.fenceId)),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await fenceRow(assetId)).toBeUndefined();
    });
  });

  describe('the race the fence closes', () => {
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

    it.each([
      ['the assignment queues first', 'assignment'],
      ['the clearance queues first', 'clearance'],
    ])('never answers clear while an assignment slips in: %s', async (_label, first) => {
      const assetId = await machine(org.a);
      const driverId = await driver(org.a);

      const release = await holdAssetLock(assetId);
      const attempt = () =>
        asActor({ organizationId: org.a }, () => assignments.create({ driverId, assetId })).then(
          () => 'ASSIGNED',
          (error: { code?: string }) => error.code ?? 'ERROR',
        );
      const question = () => ask(org.a, assetId);

      let assigned: Promise<string>;
      let answered: ReturnType<typeof question>;
      if (first === 'assignment') {
        assigned = attempt();
        await waitForBlocked(1);
        answered = question();
      } else {
        answered = question();
        await waitForBlocked(1);
        assigned = attempt();
      }
      await waitForBlocked(2);
      await release();

      const [outcome, answer] = await Promise.all([assigned, answered]);
      if (answer.clear) {
        // The fence won: the assignment was refused and nothing is running.
        expect(outcome).toBe('BUSINESS_RULE_VIOLATION');
        expect(await activeOn(assetId)).toBe(0);
      } else {
        // The assignment won: it is counted, and nothing was fenced.
        expect(outcome).toBe('ASSIGNED');
        expect(answer.openAssignments).toBe(1);
        expect(await fenceRow(assetId)).toBeUndefined();
      }
      // Whichever the lock granted first, the queue order decided it.
      expect(answer.clear).toBe(first === 'clearance');
    });
  });
});
