import { ulid } from 'ulid';
import type { EventEnvelope } from '@rasta/contracts';
import { RastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import { PrismaService } from '../src/prisma/prisma.service';
import { FleetRepository } from '../src/fleet/fleet.repository';
import { AssignmentService } from '../src/fleet/assignment.service';
import { AssetSyncConsumer } from '../src/consumers/asset-sync.consumer';
import {
  CLEARANCE_CALLER,
  CLEARANCE_HANDLER_MAX_MS,
  TransferClearanceService,
} from '../src/fleet/transfer-clearance';
import type { TransferRecordSource } from '../src/fleet/transfer-record';
import {
  asActor,
  cleanup,
  id,
  newPrisma,
  tenants,
  producerShaped,
  LAPSE_RULES_ONLY,
} from './helpers';

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
    assignments = new AssignmentService(repository, LAPSE_RULES_ONLY);
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
    payload: producerShaped(eventName, payload),
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
        new AssignmentService(repository, LAPSE_RULES_ONLY, records).create({ driverId, assetId }),
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

  // -------------------------------------------------------------------------
  // Review #127 round 2
  // -------------------------------------------------------------------------

  describe('round 2', () => {
    type Answer = 'RECORDED' | 'NOT_RECORDED' | 'UNREACHABLE';

    function source(answer: Answer, gate?: Promise<void>) {
      const asked: unknown[][] = [];
      const records: TransferRecordSource & { asked: unknown[][] } = {
        asked,
        resolve: async (...args) => {
          asked.push(args);
          await gate;
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

    const refusal = (promise: Promise<unknown>) =>
      promise.then(
        () => 'OK',
        (error: { code?: string; internalContext?: { rule?: string } }) =>
          error.internalContext?.rule ?? error.code ?? 'ERROR',
      );

    describe('tenant isolation of the fence resolution (#1)', () => {
      it.each(['RECORDED', 'NOT_RECORDED', 'UNREACHABLE'] as const)(
        'answers another organization’s assignment with the same 404, and leaves the fence alone, when the source would say %s',
        async (answer) => {
          const assetId = await machine(org.a);
          const fenceId = await expiredFence(assetId);
          const records = source(answer);
          const driverId = await driver(org.b);

          const outcome = await refusal(
            asActor({ organizationId: org.b }, () =>
              new AssignmentService(repository, LAPSE_RULES_ONLY, records).create({
                driverId,
                assetId,
              }),
            ),
          );

          expect(outcome).toBe('NOT_FOUND');
          expect(records.asked).toEqual([]);
          expect((await fenceRow(assetId))!.fence_id).toBe(fenceId);
        },
      );

      it.each(['RECORDED', 'NOT_RECORDED', 'UNREACHABLE'] as const)(
        'answers another organization’s clearance with the same 404, and leaves the fence alone, when the source would say %s',
        async (answer) => {
          const assetId = await machine(org.a);
          const fenceId = await expiredFence(assetId);
          const records = source(answer);

          const outcome = await refusal(
            asService(CLEARANCE_CALLER, org.b, () =>
              new TransferClearanceService(repository, records).clear(assetId, {
                fenceId: fence(),
                ttlSeconds: 600,
              }),
            ),
          );

          expect(outcome).toBe('NOT_FOUND');
          expect(records.asked).toEqual([]);
          expect((await fenceRow(assetId))!.fence_id).toBe(fenceId);
        },
      );
    });

    describe('a release that overtakes its clearance (#2)', () => {
      it('leaves a tombstone, so a clearance that reaches the lock later fences nothing', async () => {
        const assetId = await machine(org.a);
        const fenceId = fence();

        await asService(CLEARANCE_CALLER, org.a, () => clearance.release(assetId, fenceId));

        await expect(ask(org.a, assetId, fenceId)).rejects.toMatchObject({
          code: 'INVALID_STATE_TRANSITION',
        });
        expect(await fenceRow(assetId)).toBeUndefined();
        // Another transfer is not affected.
        await expect(ask(org.a, assetId)).resolves.toMatchObject({ clear: true });
      });

      it('holds when the clearance is paused before its lock, resolving an older fence, while the release completes', async () => {
        const assetId = await machine(org.a);
        await expiredFence(assetId);
        const next = fence();
        let open!: () => void;
        const gate = new Promise<void>((resolve) => (open = resolve));
        const records = source('NOT_RECORDED', gate);

        const answer = refusal(
          asService(CLEARANCE_CALLER, org.a, () =>
            new TransferClearanceService(repository, records).clear(assetId, {
              fenceId: next,
              ttlSeconds: 600,
            }),
          ),
        );
        // The clearance is inside the source question, before any lock.
        for (let attempt = 0; attempt < 200 && records.asked.length === 0; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(records.asked).toHaveLength(1);

        // asset-service gave up and released; the release finds no fence yet.
        await asService(CLEARANCE_CALLER, org.a, () => clearance.release(assetId, next));
        open();

        expect(await answer).toBe('INVALID_STATE_TRANSITION');
        expect(await fenceRow(assetId)).toBeUndefined();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Review #127 round 3
  // -------------------------------------------------------------------------

  describe('round 3', () => {
    const settle = (promise: Promise<unknown>) =>
      promise.then(
        () => 'OK',
        (error: { code?: string }) => error.code ?? 'ERROR',
      );

    const tombstones = async (assetId: string) =>
      (
        await prisma.client.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM asset_transfer_release WHERE asset_id = $1`,
          assetId,
        )
      )[0]!.n;

    const tombstone = (assetId: string, fenceId: string, expired: boolean) =>
      prisma.client.$executeRawUnsafe(
        `INSERT INTO asset_transfer_release (asset_id, fence_id, organization_id, released_at, expires_at)
         VALUES ($1, $2, $3, now() - interval '2 hours',
                 now() + (CASE WHEN $4 THEN interval '-1 hour' ELSE interval '1 hour' END))`,
        assetId,
        fenceId,
        org.a,
        expired,
      );

    describe('tombstones expire (#1)', () => {
      it('purges expired tombstones of any machine on a release, and keeps live ones', async () => {
        const stale = [await machine(org.a), await machine(org.a)];
        for (const assetId of stale) await tombstone(assetId, fence(), true);
        const live = await machine(org.a);
        await tombstone(live, fence(), false);

        const other = await machine(org.a);
        await asService(CLEARANCE_CALLER, org.a, () => clearance.release(other, fence()));

        for (const assetId of stale) expect(await tombstones(assetId)).toBe(0);
        expect(await tombstones(live)).toBe(1);
      });

      it('no longer withdraws a transfer whose tombstone has expired', async () => {
        const assetId = await machine(org.a);
        const fenceId = fence();
        await tombstone(assetId, fenceId, true);

        await expect(ask(org.a, assetId, fenceId)).resolves.toMatchObject({ clear: true });
      });
    });

    describe('a clearance cannot outlive its tombstone (#2)', () => {
      it(`places no fence once ${CLEARANCE_HANDLER_MAX_MS} ms have passed since it arrived, tombstone or not`, async () => {
        const assetId = await machine(org.a);
        // An older expired fence of this organization makes the clearance
        // stop at its source question, before the lock.
        await ask(org.a, assetId);
        await prisma.client.$executeRawUnsafe(
          `UPDATE asset_transfer_fence SET expires_at = now() - interval '1 second' WHERE asset_id = $1`,
          assetId,
        );
        let now = 0;
        let open!: () => void;
        const gate = new Promise<void>((resolve) => (open = resolve));
        const asked: unknown[] = [];
        const records: TransferRecordSource = {
          resolve: async (...args) => {
            asked.push(args);
            await gate;
            return 'NOT_RECORDED';
          },
        };
        const next = fence();

        const answer = settle(
          asService(CLEARANCE_CALLER, org.a, () =>
            new TransferClearanceService(repository, records, () => now).clear(assetId, {
              fenceId: next,
              ttlSeconds: 600,
            }),
          ),
        );
        for (let attempt = 0; attempt < 200 && asked.length === 0; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        // Held past the bound; asset-service's release, and its tombstone,
        // are long gone — none is written here.
        now = CLEARANCE_HANDLER_MAX_MS + 1;
        open();

        expect(await answer).toBe('INVALID_STATE_TRANSITION');
        expect(await fenceRow(assetId)).toBeUndefined();
        expect(await tombstones(assetId)).toBe(0);
      });

      it('fences normally within the bound', async () => {
        const assetId = await machine(org.a);
        const now = 0;
        await expect(
          asService(CLEARANCE_CALLER, org.a, () =>
            new TransferClearanceService(repository, undefined, () => now).clear(assetId, {
              fenceId: fence(),
              ttlSeconds: 600,
            }),
          ),
        ).resolves.toMatchObject({ clear: true });
      });
    });
  });
  describe('round 4: the purge runs after the commit, and never waits (#2)', () => {
    const tombstones = async (assetId: string) =>
      (
        await prisma.client.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM asset_transfer_release WHERE asset_id = $1`,
          assetId,
        )
      )[0]!.n;

    const expiredTombstone = (assetId: string) =>
      prisma.client.$executeRawUnsafe(
        `INSERT INTO asset_transfer_release (asset_id, fence_id, organization_id, released_at, expires_at)
         VALUES ($1, $2, $3, now() - interval '2 hours', now() - interval '1 hour')`,
        assetId,
        fence(),
        org.a,
      );

    /** Another session holds a row lock on this machine's tombstone until released. */
    async function lockTombstone(assetId: string) {
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      const done = prisma.client.$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe(
            `SELECT 1 FROM asset_transfer_release WHERE asset_id = $1 FOR UPDATE`,
            assetId,
          );
          locked();
          await released;
        },
        { timeout: 60_000 },
      );
      await isLocked;
      return async () => {
        release();
        await done;
      };
    }

    const promptly = <T>(promise: Promise<T>, what: string) =>
      Promise.race([
        promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`${what} waited on another machine's row`)), 5_000),
        ),
      ]);

    it('a release completes promptly and records its tombstone while another machine’s expired tombstone is locked; the purge skips only that row', async () => {
      const held = await machine(org.a);
      const stale = await machine(org.a);
      await expiredTombstone(held);
      await expiredTombstone(stale);
      const unlock = await lockTombstone(held);
      try {
        const assetId = await machine(org.a);
        await promptly(
          asService(CLEARANCE_CALLER, org.a, () => clearance.release(assetId, fence())),
          'the release',
        );

        expect(await tombstones(assetId)).toBe(1);
        expect(await tombstones(held)).toBe(1); // locked elsewhere: skipped, not waited for
        expect(await tombstones(stale)).toBe(0);
      } finally {
        await unlock();
      }
    });

    it('a clearance completes promptly while another machine’s expired tombstone is locked', async () => {
      const held = await machine(org.a);
      await expiredTombstone(held);
      const unlock = await lockTombstone(held);
      try {
        const assetId = await machine(org.a);
        await expect(promptly(ask(org.a, assetId), 'the clearance')).resolves.toMatchObject({
          clear: true,
        });
        expect(await fenceRow(assetId)).toMatchObject({ live: true });
      } finally {
        await unlock();
      }
    });

    it('a failing purge never fails the release, and the release has already committed', async () => {
      const failing = Object.assign(Object.create(repository) as FleetRepository, {
        purgeExpiredReleases: async () => {
          throw new Error('purge unavailable');
        },
      });
      const assetId = await machine(org.a);
      const fenceId = fence();
      await ask(org.a, assetId, fenceId);

      await asService(CLEARANCE_CALLER, org.a, () =>
        new TransferClearanceService(failing).release(assetId, fenceId),
      );

      expect(await fenceRow(assetId)).toBeUndefined();
      expect(await tombstones(assetId)).toBe(1);
    });
  });
});
