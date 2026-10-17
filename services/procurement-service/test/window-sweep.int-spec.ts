import { eventEnvelopeSchema } from '@rasta/contracts';
import { registry } from '@rasta/observability';
import { demandIdsDigest } from '../src/events/events';
import { EventPublisher } from '../src/events/publisher';
import type { PrismaClient } from '../src/generated/prisma';
import { DemandRepository } from '../src/demand/demand.repository';
import { WindowSweepRepository } from '../src/demand/window-sweep.repository';
import { WindowSweepService } from '../src/demand/window-sweep.service';
import type { AggregationWindowSweeper } from '../src/demand/aggregation-window.sweeper';
import { actor, buyer, client, startApi, TestClock, type ApiHarness } from './api-helpers';
import { cleanup, newOrganizationId, newProductId, runtimeClient, seedOpenWindow } from './helpers';

/**
 * The end of a window on time (ADR-070 § 2, plan PR 2): `AggregationWindowSweeper` against the real
 * database, through the real application's repository, service and transition.
 *
 * Windows here are opened through the API with the service's clock pinned days in the past, so
 * their `closes_at` has passed on the database's own clock — the one the claim compares with —
 * and the sweep then reads the real clock after the lock. Nothing waits for a timer: each case
 * drives `runOnce()` itself. The claim spans tenants (it is the queue), so a sweep may also end a
 * due window another suite left behind; every assertion reads this suite's own organizations.
 */
const HOUR = 3_600_000;
const PAST = () => new Date(Date.now() - 3 * 24 * HOUR);

jest.setTimeout(120_000);

describe('the window sweeper', () => {
  let db: PrismaClient;
  const organizations: string[] = [];
  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };
  const harnesses: ApiHarness[] = [];

  beforeAll(() => {
    db = runtimeClient();
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await cleanup(organizations);
    for (const harness of harnesses) await harness.close();
    await db.$disconnect();
  });

  /** An API with the given window settings, its clock this suite's to pin. */
  async function api(
    settings: { hours?: number; min?: number; policy?: 'EXTEND' | 'REFER' | 'CLOSE' } = {},
    env: Record<string, string> = {},
  ) {
    const clock = new TestClock();
    const harness = await startApi(
      {
        PROCUREMENT_AGGREGATION_WINDOW_HOURS: String(settings.hours ?? 1),
        PROCUREMENT_AGGREGATION_MIN_QUANTITY: String(settings.min ?? 0),
        PROCUREMENT_AGGREGATION_SHORTFALL_POLICY: settings.policy ?? 'EXTEND',
        ...env,
      },
      { clock },
    );
    harnesses.push(harness);
    return { harness, clock };
  }

  /** A window of `quantities` demands opened `PAST()` (so already due), and the clock let go. */
  async function dueWindow(
    harness: ApiHarness,
    clock: TestClock,
    quantities: number[],
    organizationId = org(),
    productId = newProductId(),
  ) {
    const as = client(harness, buyer(organizationId));
    const opened = PAST();
    const demandIds: string[] = [];
    for (const [index, quantity] of quantities.entries()) {
      clock.set(new Date(opened.getTime() + index));
      const submitted = await as.submit({ productId, quantity });
      expect(submitted.status).toBe(201);
      demandIds.push(submitted.body.id as string);
    }
    clock.set(null);
    const aggregationId = (await as.demand(demandIds[0]!)).body.aggregationId as string;
    return { organizationId, productId, aggregationId, demandIds, as };
  }

  /** Sweeps until nothing more is claimed: every due window of the database ended. */
  async function sweepAll(sweeper: AggregationWindowSweeper) {
    for (let round = 0; round < 50; round += 1) {
      if ((await sweeper.runOnce()).claimed === 0) return;
    }
    throw new Error('the sweep did not settle in 50 rounds');
  }

  /** The window row as the runtime role reads it, sweeper bookkeeping included. */
  async function row(organizationId: string, id: string) {
    const found = await db.demandAggregation.findFirst({ where: { organizationId, id } });
    if (!found) throw new Error(`no aggregation ${id}`);
    return found;
  }

  /** The events of one window's stream, in stream order, with their payloads. */
  async function stream(organizationId: string, aggregationId: string) {
    const rows = await db.outboxMessage.findMany({
      where: { organizationId, partitionKey: aggregationId },
      orderBy: { streamSeq: 'asc' },
    });
    return rows.map((r) => {
      const envelope = eventEnvelopeSchema.parse(r.payload);
      return { name: envelope.eventName, payload: envelope.payload as Record<string, unknown> };
    });
  }

  const endEvents = async (organizationId: string, aggregationId: string) =>
    (await stream(organizationId, aggregationId)).filter((e) => e.name !== 'DEMAND_SUBMITTED');

  const demandStatuses = async (organizationId: string, aggregationId: string) =>
    (
      await db.$queryRaw<{ status: string; n: bigint }[]>`
        SELECT status, count(*) AS n FROM demand_request
         WHERE organization_id = ${organizationId} AND aggregation_id = ${aggregationId}
         GROUP BY status ORDER BY status`
    ).map((r) => [r.status, Number(r.n)]);

  describe('ends a window no demand arrives after, by its own snapshot', () => {
    it('READY when it holds a demand and reaches its threshold — once, with one event, and lets go of its claim', async () => {
      const { harness, clock } = await api({ min: 5 });
      const w = await dueWindow(harness, clock, [2, 3]);
      const before = await row(w.organizationId, w.aggregationId);

      await sweepAll(harness.sweeper());

      const after = await row(w.organizationId, w.aggregationId);
      expect(after).toMatchObject({
        status: 'READY',
        version: before.version + 1,
        totalQuantity: 5n,
        demandCount: 2,
        sweepFence: null,
        sweepLeaseUntil: null,
        sweepAttempts: 0,
        demandsToFollow: 0,
      });
      expect(after.closedAt!.getTime()).toBeGreaterThanOrEqual(before.closesAt.getTime());
      expect(await endEvents(w.organizationId, w.aggregationId)).toEqual([
        {
          name: 'DEMAND_AGGREGATED',
          payload: expect.objectContaining({
            aggregationId: w.aggregationId,
            organizationId: w.organizationId,
            demandCount: 2,
            demandIdsSha256: demandIdsDigest(w.demandIds),
            totalQuantity: 5,
            closedAt: after.closedAt!.toISOString(),
          }),
        },
      ]);
      // READY freezes the demands; it does not end them.
      expect(await demandStatuses(w.organizationId, w.aggregationId)).toEqual([['SUBMITTED', 2]]);

      // Swept again: nothing claimed for it, nothing written, still one event.
      await harness.sweeper().runOnce();
      expect((await row(w.organizationId, w.aggregationId)).version).toBe(after.version);
      expect(await endEvents(w.organizationId, w.aggregationId)).toHaveLength(1);
    });

    it('a threshold of zero: READY with any live demand; LAPSED (NO_LIVE_DEMAND) once the last one withdrew, whatever the policy', async () => {
      const { harness, clock } = await api({ min: 0, policy: 'EXTEND' });
      const held = await dueWindow(harness, clock, [1]);
      const emptied = await dueWindow(harness, clock, [4]);
      // The only demand of the second window withdraws while it is open (clock pinned inside it).
      const demand = (await emptied.as.demand(emptied.demandIds[0]!)).body;
      const opened = (await row(emptied.organizationId, emptied.aggregationId)).openedAt;
      clock.set(new Date(opened.getTime() + 60_000));
      expect((await emptied.as.withdraw(demand.id, demand.version)).status).toBe(200);
      clock.set(null);

      await sweepAll(harness.sweeper());

      expect((await row(held.organizationId, held.aggregationId)).status).toBe('READY');
      const lapsed = await row(emptied.organizationId, emptied.aggregationId);
      expect(lapsed).toMatchObject({ status: 'LAPSED', demandCount: 0, totalQuantity: 0n });
      expect(await endEvents(emptied.organizationId, emptied.aggregationId)).toEqual([
        { name: 'DEMAND_WITHDRAWN', payload: expect.anything() },
        {
          name: 'AGGREGATION_LAPSED',
          payload: expect.objectContaining({
            demandCount: 0,
            demandIdsSha256: demandIdsDigest([]),
            reasonCode: 'NO_LIVE_DEMAND',
          }),
        },
      ]);
      expect(await demandStatuses(emptied.organizationId, emptied.aggregationId)).toEqual([
        ['WITHDRAWN', 1],
      ]);
    });

    it('EXTEND short of the threshold: moves it on by whole lengths past now, counted, and it stays OPEN and joinable', async () => {
      const { harness, clock } = await api({ hours: 1, min: 100, policy: 'EXTEND' });
      const w = await dueWindow(harness, clock, [3]);
      const before = await row(w.organizationId, w.aggregationId);

      const sweptAt = Date.now();
      await sweepAll(harness.sweeper());

      const after = await row(w.organizationId, w.aggregationId);
      const windows = after.extensionCount;
      expect(after.status).toBe('OPEN');
      expect(windows).toBeGreaterThanOrEqual(71);
      expect(after.closesAt.getTime()).toBe(before.closesAt.getTime() + windows * HOUR);
      // The smallest whole number of lengths that reaches past the sweep's clock.
      expect(after.closesAt.getTime()).toBeGreaterThan(sweptAt);
      expect(after.closesAt.getTime() - HOUR).toBeLessThanOrEqual(Date.now());
      expect(await endEvents(w.organizationId, w.aggregationId)).toEqual([
        {
          name: 'AGGREGATION_WINDOW_EXTENDED',
          payload: expect.objectContaining({
            previousClosesAt: before.closesAt.toISOString(),
            closesAt: after.closesAt.toISOString(),
            windows,
            extensionCount: windows,
          }),
        },
      ]);
      // Not due any more: the next sweep leaves it alone; a demand joins it.
      await harness.sweeper().runOnce();
      expect((await row(w.organizationId, w.aggregationId)).version).toBe(after.version);
      const joined = await w.as.submit({ productId: w.productId, quantity: 1 });
      expect(joined.body.aggregationId).toBe(w.aggregationId);
    });

    it.each([
      ['REFER', 'REFERRED', 'AGGREGATION_REFERRED', undefined],
      ['CLOSE', 'LAPSED', 'AGGREGATION_LAPSED', 'SHORTFALL_CLOSED'],
    ] as const)(
      '%s short of the threshold: %s with its demands, and one %s',
      async (policy, ended, eventName, reasonCode) => {
        const { harness, clock } = await api({ min: 100, policy });
        const w = await dueWindow(harness, clock, [2, 2, 2]);

        await sweepAll(harness.sweeper());

        expect(await row(w.organizationId, w.aggregationId)).toMatchObject({
          status: ended,
          demandsToFollow: 0,
          totalQuantity: 6n,
          demandCount: 3,
        });
        expect(await demandStatuses(w.organizationId, w.aggregationId)).toEqual([[ended, 3]]);
        const events = await endEvents(w.organizationId, w.aggregationId);
        expect(events).toEqual([
          {
            name: eventName,
            payload: expect.objectContaining({
              demandCount: 3,
              demandIdsSha256: demandIdsDigest(w.demandIds),
              ...(reasonCode ? { reasonCode } : {}),
            }),
          },
        ]);
      },
    );
  });

  describe('safe under concurrency', () => {
    it('two sweepers at once end every window exactly once', async () => {
      const { harness, clock } = await api({ min: 0 });
      const windows = [];
      for (let i = 0; i < 6; i += 1) windows.push(await dueWindow(harness, clock, [1]));
      const first = harness.sweeper({ batchSize: 3 });
      const second = harness.sweeper({ batchSize: 3 });

      await Promise.all([first.runOnce(), second.runOnce(), first.runOnce(), second.runOnce()]);
      await sweepAll(first);

      for (const w of windows) {
        expect((await row(w.organizationId, w.aggregationId)).status).toBe('READY');
        expect((await endEvents(w.organizationId, w.aggregationId)).map((e) => e.name)).toEqual([
          'DEMAND_AGGREGATED',
        ]);
      }
    });

    it.each([
      ['READY', { min: 0, policy: 'EXTEND' as const }],
      ['EXTEND', { min: 100, policy: 'EXTEND' as const }],
      ['REFER', { min: 100, policy: 'REFER' as const }],
    ])(
      'a sweep and a late demand at once (%s): one end, one event, and the demand in the window that follows',
      async (_label, settings) => {
        const { harness, clock } = await api(settings);
        for (let round = 0; round < 4; round += 1) {
          const w = await dueWindow(harness, clock, [1, 1]);
          const [, late] = await Promise.all([
            harness.sweeper().runOnce(),
            w.as.submit({ productId: w.productId, quantity: 1 }),
          ]);
          expect(late.status).toBe(201);

          const events = await endEvents(w.organizationId, w.aggregationId);
          expect(events).toHaveLength(1);
          const following = await row(w.organizationId, late.body.aggregationId as string);
          expect(following.status).toBe('OPEN');
          if (settings.policy === 'EXTEND' && settings.min > 0) {
            // EXTEND keeps the row: the demand joined the window moved on, whoever moved it.
            expect(late.body.aggregationId).toBe(w.aggregationId);
          } else {
            expect(late.body.aggregationId).not.toBe(w.aggregationId);
          }
        }
      },
    );

    it('a demand that moves the window on after the claim: the claimed step finds it not due by the clock read after the lock, writes nothing and lets go', async () => {
      const { harness, clock } = await api({ min: 100, policy: 'EXTEND' });
      const w = await dueWindow(harness, clock, [1]);
      const fence = 'FENCE-CLAIMED-BEFORE-THE-DEMAND';
      expect(await harness.app.get(WindowSweepRepository).claimDue(500, 60, fence)).toContainEqual({
        id: w.aggregationId,
        organizationId: w.organizationId,
        fence,
      });

      // The demand ends it first (EXTEND: the same row, moved on past now) and joins it.
      const late = await w.as.submit({ productId: w.productId, quantity: 1 });
      expect(late.body.aggregationId).toBe(w.aggregationId);
      const extended = await row(w.organizationId, w.aggregationId);

      const step = await harness.app
        .get(WindowSweepService)
        .step({ organizationId: w.organizationId, aggregationId: w.aggregationId, fence }, 60);

      expect(step).toEqual({ result: 'NOT_DUE', demandsToFollow: 0 });
      expect(await row(w.organizationId, w.aggregationId)).toMatchObject({
        version: extended.version,
        extensionCount: extended.extensionCount,
        sweepFence: null,
      });
      expect((await endEvents(w.organizationId, w.aggregationId)).map((e) => e.name)).toEqual([
        'AGGREGATION_WINDOW_EXTENDED',
      ]);
    });

    it('a demand that ended the window after the claim: the claimed step is a no-op, never a second end', async () => {
      const { harness, clock } = await api({ min: 100, policy: 'REFER' });
      const w = await dueWindow(harness, clock, [1]);
      const fence = 'FENCE-CLAIMED-BEFORE-THE-END';
      await harness.app.get(WindowSweepRepository).claimDue(500, 60, fence);
      await w.as.submit({ productId: w.productId, quantity: 1 });

      const step = await harness.app
        .get(WindowSweepService)
        .step({ organizationId: w.organizationId, aggregationId: w.aggregationId, fence }, 60);

      expect(step).toEqual({ result: 'NOOP', demandsToFollow: 0 });
      expect((await endEvents(w.organizationId, w.aggregationId)).map((e) => e.name)).toEqual([
        'AGGREGATION_REFERRED',
      ]);
      expect((await row(w.organizationId, w.aggregationId)).sweepFence).toBeNull();
    });

    it('a sweeper that died holding the claim: nobody takes it before the lease ends, then one does; the dead one’s late step does nothing', async () => {
      const { harness, clock } = await api({ min: 0 });
      const w = await dueWindow(harness, clock, [1]);
      const sweeps = harness.app.get(WindowSweepRepository);
      const dead = 'FENCE-OF-A-DEAD-SWEEPER';

      const claimed = await sweeps.claimDue(500, 1, dead);
      expect(claimed).toContainEqual({
        id: w.aggregationId,
        organizationId: w.organizationId,
        fence: dead,
      });

      // Restarted elsewhere at once: the lease still holds.
      await harness.sweeper().runOnce();
      expect((await row(w.organizationId, w.aggregationId)).status).toBe('OPEN');

      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await sweepAll(harness.sweeper());
      expect((await row(w.organizationId, w.aggregationId)).status).toBe('READY');

      // The dead sweeper wakes up and steps with its old fence: fenced out, nothing written.
      const step = await harness.app
        .get(WindowSweepService)
        .step(
          { organizationId: w.organizationId, aggregationId: w.aggregationId, fence: dead },
          60,
        );
      expect(step).toEqual({ result: 'NOT_OWNER', demandsToFollow: 0 });
      expect(await endEvents(w.organizationId, w.aggregationId)).toHaveLength(1);
    });

    it('rolls the end back with its event: nothing changes, the failure is counted and backed off, and the next try ends it once', async () => {
      const { harness, clock } = await api({ min: 100, policy: 'REFER' });
      const w = await dueWindow(harness, clock, [1, 1]);
      const publisher = harness.app.get(EventPublisher);
      const enqueue = jest
        .spyOn(publisher, 'enqueue')
        .mockRejectedValueOnce(new Error('the outbox write failed'));

      const outcome = await harness.sweeper({ retryBackoffBaseSeconds: 1 }).runOnce();
      expect(outcome.failed).toBeGreaterThanOrEqual(1);
      enqueue.mockRestore();

      const failed = await row(w.organizationId, w.aggregationId);
      expect(failed).toMatchObject({
        status: 'OPEN',
        closedAt: null,
        demandsToFollow: 0,
        sweepAttempts: 1,
        sweepFence: null,
        sweepLeaseUntil: null,
      });
      expect(failed.sweepNextAttemptAt!.getTime()).toBeGreaterThan(Date.now() - 1_000);
      expect(await demandStatuses(w.organizationId, w.aggregationId)).toEqual([['SUBMITTED', 2]]);
      expect(await endEvents(w.organizationId, w.aggregationId)).toEqual([]);

      // In its backoff it is not claimed; after it, it ends once and its failures are forgotten.
      await harness.sweeper().runOnce();
      expect((await row(w.organizationId, w.aggregationId)).status).toBe('OPEN');
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await sweepAll(harness.sweeper());
      expect(await row(w.organizationId, w.aggregationId)).toMatchObject({
        status: 'REFERRED',
        sweepAttempts: 0,
        sweepNextAttemptAt: null,
      });
      expect((await endEvents(w.organizationId, w.aggregationId)).map((e) => e.name)).toEqual([
        'AGGREGATION_REFERRED',
      ]);
    });
  });

  describe('bounded, whatever the window holds', () => {
    const BATCH = 50;
    const DEMANDS = 230;

    it(`a window of ${DEMANDS} demands ended by a late demand: ${BATCH} follow in its transaction, the sweeper moves the rest ${BATCH} at a time, one event names all`, async () => {
      const { harness, clock } = await api(
        { hours: 1, min: 0 },
        { PROCUREMENT_WINDOW_FOLLOW_BATCH_SIZE: String(BATCH) },
      );
      const organizationId = org();
      const productId = newProductId();
      const seeded = await seedOpenWindow({
        organizationId,
        productId,
        demands: DEMANDS,
        policy: 'REFER',
        minQuantity: 2_147_483_647,
        openedAt: PAST(),
        hours: 1,
      });
      const moved = jest.spyOn(harness.app.get(DemandRepository), 'followWindow');
      const as = client(harness, buyer(organizationId));

      clock.set(null);
      const late = await as.submit({ productId, quantity: 1 });
      expect(late.status).toBe(201);
      expect(late.body.aggregationId).not.toBe(seeded.aggregationId);
      expect(await row(organizationId, seeded.aggregationId)).toMatchObject({
        status: 'REFERRED',
        demandsToFollow: DEMANDS - BATCH,
      });
      expect(await demandStatuses(organizationId, seeded.aggregationId)).toEqual([
        ['REFERRED', BATCH],
        ['SUBMITTED', DEMANDS - BATCH],
      ]);

      // A demand still waiting to follow is not withdrawable: its window has ended.
      const waiting = (await db.demandRequest.findFirst({
        where: { organizationId, aggregationId: seeded.aggregationId, status: 'SUBMITTED' },
      }))!;
      const refused = await as.withdraw(waiting.id, waiting.version);
      expect(refused.status).toBe(422);
      expect(refused.body.details).toEqual([
        expect.objectContaining({ code: 'AGGREGATION_WINDOW_ENDED' }),
      ]);

      await sweepAll(harness.sweeper());

      expect(await row(organizationId, seeded.aggregationId)).toMatchObject({
        status: 'REFERRED',
        demandsToFollow: 0,
        sweepFence: null,
      });
      expect(await demandStatuses(organizationId, seeded.aggregationId)).toEqual([
        ['REFERRED', DEMANDS],
      ]);
      // Every transaction moved at most one batch; all of them together, every demand once.
      const limits = moved.mock.calls
        .filter(([, window]) => window.id === seeded.aggregationId)
        .map(([, , , limit]) => limit);
      expect(Math.max(...limits)).toBe(BATCH);
      expect(limits.reduce((sum, n) => sum + n, 0)).toBe(DEMANDS);
      expect(limits.length).toBe(Math.ceil(DEMANDS / BATCH));
      moved.mockRestore();
      expect(await endEvents(organizationId, seeded.aggregationId)).toEqual([
        {
          name: 'AGGREGATION_REFERRED',
          payload: expect.objectContaining({
            demandCount: DEMANDS,
            demandIdsSha256: demandIdsDigest(seeded.demandIds),
          }),
        },
      ]);
    });

    it('stopping mid-window (D-052) starts no further batch and keeps the claim; after its lease, another sweeper finishes it', async () => {
      const { harness } = await api({}, { PROCUREMENT_WINDOW_FOLLOW_BATCH_SIZE: '20' });
      const organizationId = org();
      const seeded = await seedOpenWindow({
        organizationId,
        productId: newProductId(),
        demands: 100,
        policy: 'CLOSE',
        minQuantity: 2_147_483_647,
        openedAt: PAST(),
        hours: 1,
      });
      const service = harness.app.get(WindowSweepService);
      const step = service.step.bind(service);
      const stopping = harness.sweeper({ leaseSeconds: 1, batchSize: 500 });
      const spy = jest.spyOn(service, 'step').mockImplementation(async (target, lease) => {
        const done = await step(target, lease);
        if (target.aggregationId === seeded.aggregationId) void stopping.stop();
        return done;
      });

      await stopping.runOnce();
      spy.mockRestore();

      const held = await row(organizationId, seeded.aggregationId);
      expect(held).toMatchObject({ status: 'LAPSED', demandsToFollow: 80 });
      expect(held.sweepFence).not.toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await sweepAll(harness.sweeper());
      expect(await row(organizationId, seeded.aggregationId)).toMatchObject({
        demandsToFollow: 0,
        sweepFence: null,
      });
      expect(await demandStatuses(organizationId, seeded.aggregationId)).toEqual([['LAPSED', 100]]);
      expect((await endEvents(organizationId, seeded.aggregationId)).map((e) => e.name)).toEqual([
        'AGGREGATION_LAPSED',
      ]);
    });
  });

  describe('tenant isolation', () => {
    it('ends each window in its own organization only: the same product of another organization keeps its window', async () => {
      const { harness, clock } = await api({ hours: 24, min: 0 });
      const productId = newProductId();
      const a = await dueWindow(harness, clock, [1], org(), productId);
      // B's window of the same product opened now: 24 hours to go.
      const b = org();
      const asB = client(harness, buyer(b));
      const bWindow = (await asB.submit({ productId, quantity: 7 })).body.aggregationId as string;

      await sweepAll(harness.sweeper());

      expect((await row(a.organizationId, a.aggregationId)).status).toBe('READY');
      expect((await row(b, bWindow)).status).toBe('OPEN');
      const ended = await db.outboxMessage.findMany({
        where: { partitionKey: a.aggregationId, eventName: 'DEMAND_AGGREGATED' },
      });
      expect(ended.map((r) => r.organizationId)).toEqual([a.organizationId]);
      expect(await endEvents(b, bWindow)).toEqual([]);
    });

    it('a step names the window’s organization: under another one it finds nothing and writes nothing', async () => {
      const { harness, clock } = await api({ min: 0 });
      const w = await dueWindow(harness, clock, [1]);
      const sweeps = harness.app.get(WindowSweepRepository);
      const fence = 'FENCE-TENANT-CHECK';
      await sweeps.claimDue(500, 60, fence);

      const step = await harness.app
        .get(WindowSweepService)
        .step({ organizationId: org(), aggregationId: w.aggregationId, fence }, 60);

      expect(step).toEqual({ result: 'NOT_FOUND', demandsToFollow: 0 });
      expect((await row(w.organizationId, w.aggregationId)).status).toBe('OPEN');
      await harness.app
        .get(WindowSweepService)
        .step({ organizationId: w.organizationId, aggregationId: w.aggregationId, fence }, 60);
      expect((await row(w.organizationId, w.aggregationId)).status).toBe('READY');
    });

    it('nobody but the buyer’s issuer cancels: another organization’s administrator gets 404', async () => {
      const { harness, clock } = await api({ min: 0 });
      const w = await dueWindow(harness, clock, [1]);
      await sweepAll(harness.sweeper());
      const ready = await row(w.organizationId, w.aggregationId);

      const stranger = client(harness, actor(org(), ['ORGANIZATION_ADMIN']));
      expect((await stranger.cancel(w.aggregationId, ready.version)).status).toBe(404);
      expect((await row(w.organizationId, w.aggregationId)).status).toBe('READY');
    });
  });

  it('samples its backlog for the gauges, and counts what it ended by trigger', async () => {
    const { harness, clock } = await api({ hours: 1, min: 100, policy: 'EXTEND' });
    const w = await dueWindow(harness, clock, [1]);
    const sweeps = harness.app.get(WindowSweepRepository);

    const before = await sweeps.backlog();
    expect(before.due).toBeGreaterThanOrEqual(1);
    expect(before.oldestDueAgeSeconds).toBeGreaterThan(60 * 60);

    await sweepAll(harness.sweeper());

    const after = await sweeps.backlog();
    expect(after.due).toBe(0);
    expect(after.oldestDueAgeSeconds).toBe(0);
    expect(after.demandsToFollow).toBe(0);
    const extended = (await row(w.organizationId, w.aggregationId)).extensionCount;
    expect(after.maxExtensionCount).toBeGreaterThanOrEqual(extended);

    const metrics = await registry.metrics();
    expect(metrics).toMatch(
      /rasta_procurement_aggregation_windows_ended_total\{service="procurement-service",transition="extended",trigger="sweeper"\} [1-9]/,
    );
    expect(metrics).toMatch(
      /rasta_procurement_aggregation_extensions_total\{service="procurement-service"\} [1-9]/,
    );
  });
});
