import { eventEnvelopeSchema } from '@rasta/contracts';
import { PrismaClient } from '../src/generated/prisma';
import { buyer, client, startApi, TestClock, type ApiHarness } from './api-helpers';
import { cleanup, databaseUrl, newOrganizationId, newProductId } from './helpers';

/**
 * The window of an aggregation, deterministically (ADR-070 § 2 and Compliance): no sleep, the
 * database clock pinned where the service reads it — after the aggregation's row lock.
 *
 * - A demand at `closesAt − 1 ms` joins; at `closesAt` exactly it does not: it ends the window
 *   (READY, EXTEND, REFER or CLOSE by the window's own snapshot, or LAPSED with nothing left) and
 *   joins the window that follows, in one transaction with every event.
 * - A demand that waits on the window's lock past its end sees that it did: the clock is read
 *   after the lock.
 * - Two first demands at once make one window; many make one window with the exact total.
 * - Withdrawing is refused once the window has ended, by the clock even while the status is OPEN.
 */
const HOUR = 3_600_000;
const T0 = new Date('2031-03-01T08:00:00.000Z');

describe('the window of an aggregation', () => {
  const organizations: string[] = [];
  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };
  const harnesses: ApiHarness[] = [];

  /** An API whose clock this suite pins, with the given window settings. */
  async function api(settings: {
    hours?: number;
    min?: number;
    policy?: 'EXTEND' | 'REFER' | 'CLOSE';
  }) {
    const clock = new TestClock();
    const harness = await startApi(
      {
        PROCUREMENT_AGGREGATION_WINDOW_HOURS: String(settings.hours ?? 24),
        PROCUREMENT_AGGREGATION_MIN_QUANTITY: String(settings.min ?? 0),
        PROCUREMENT_AGGREGATION_SHORTFALL_POLICY: settings.policy ?? 'EXTEND',
      },
      { clock },
    );
    harnesses.push(harness);
    return { harness, clock };
  }

  /** The events of one window's stream (its partition key), in stream order (ADR-051 B3). */
  const streamOf = async (harness: ApiHarness, organizationId: string, aggregationId: string) =>
    (
      await harness.prisma.client.outboxMessage.findMany({
        where: { organizationId, partitionKey: aggregationId },
        orderBy: { streamSeq: 'asc' },
      })
    ).map((row) => eventEnvelopeSchema.parse(row.payload).eventName);

  const lastEvent = async (harness: ApiHarness, organizationId: string, eventName: string) => {
    const rows = await harness.prisma.client.outboxMessage.findMany({
      where: { organizationId, eventName },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    return eventEnvelopeSchema.parse(rows[0]?.payload).payload as Record<string, unknown>;
  };

  afterAll(async () => {
    await cleanup(organizations);
    for (const harness of harnesses) await harness.close();
  });

  it('a demand at closesAt − 1 ms joins; at closesAt it ends the window READY and opens the next', async () => {
    const { harness, clock } = await api({ hours: 24, min: 0 });
    const a = org();
    const as = client(harness, buyer(a));
    const productId = newProductId();

    clock.set(T0);
    const first = await as.submit({ productId, quantity: 2 });
    const window = first.body.aggregationId as string;

    clock.set(new Date(T0.getTime() + 24 * HOUR - 1));
    const last = await as.submit({ productId, quantity: 3 });
    expect(last.body.aggregationId).toBe(window);

    clock.set(new Date(T0.getTime() + 24 * HOUR));
    const late = await as.submit({ productId, quantity: 5 });
    expect(late.status).toBe(201);
    expect(late.body.aggregationId).not.toBe(window);

    const ended = await as.aggregation(window);
    expect(ended.body).toMatchObject({
      status: 'READY',
      totalQuantity: '5',
      demandCount: 2,
      closedAt: new Date(T0.getTime() + 24 * HOUR).toISOString(),
    });
    const next = await as.aggregation(late.body.aggregationId);
    expect(next.body).toMatchObject({
      status: 'OPEN',
      totalQuantity: '5',
      demandCount: 1,
      openedAt: new Date(T0.getTime() + 24 * HOUR).toISOString(),
      closesAt: new Date(T0.getTime() + 48 * HOUR).toISOString(),
    });
    // The demands of the window it ended stay SUBMITTED: READY freezes them, it does not end them.
    expect((await as.demand(first.body.id)).body.status).toBe('SUBMITTED');

    expect(await streamOf(harness, a, window)).toEqual([
      'DEMAND_SUBMITTED',
      'DEMAND_SUBMITTED',
      'DEMAND_AGGREGATED',
    ]);
    expect(await streamOf(harness, a, late.body.aggregationId)).toEqual(['DEMAND_SUBMITTED']);
    expect(await lastEvent(harness, a, 'DEMAND_AGGREGATED')).toMatchObject({
      aggregationId: window,
      demandIds: [first.body.id, last.body.id].sort(),
      totalQuantity: '5',
      settingVersion: null,
    });
    expect(await lastEvent(harness, a, 'DEMAND_SUBMITTED')).toMatchObject({
      demandId: late.body.id,
      aggregationOpened: true,
    });
  });

  it('EXTEND moves a short window on by its own length, as many times as it is late, and the demand joins it', async () => {
    const { harness, clock } = await api({ hours: 10, min: 100, policy: 'EXTEND' });
    const a = org();
    const as = client(harness, buyer(a));
    const productId = newProductId();

    clock.set(T0);
    const first = await as.submit({ productId, quantity: 1 });
    // 25 hours later: the window ended 15 hours ago — two more lengths reach past now.
    clock.set(new Date(T0.getTime() + 25 * HOUR));
    const late = await as.submit({ productId, quantity: 1 });

    expect(late.body.aggregationId).toBe(first.body.aggregationId);
    const window = await as.aggregation(first.body.aggregationId);
    expect(window.body).toMatchObject({
      status: 'OPEN',
      totalQuantity: '2',
      demandCount: 2,
      extensionCount: 2,
      closesAt: new Date(T0.getTime() + 30 * HOUR).toISOString(),
    });
    expect(await lastEvent(harness, a, 'AGGREGATION_WINDOW_EXTENDED')).toMatchObject({
      previousClosesAt: new Date(T0.getTime() + 10 * HOUR).toISOString(),
      closesAt: new Date(T0.getTime() + 30 * HOUR).toISOString(),
      windows: 2,
      extensionCount: 2,
      totalQuantity: '1',
    });
  });

  it('REFER ends a short window and its demands REFERRED — a fact only — and the late demand opens a new one', async () => {
    const { harness, clock } = await api({ hours: 10, min: 100, policy: 'REFER' });
    const a = org();
    const as = client(harness, buyer(a));
    const productId = newProductId();

    clock.set(T0);
    const first = await as.submit({ productId, quantity: 4 });
    clock.set(new Date(T0.getTime() + 10 * HOUR));
    const late = await as.submit({ productId, quantity: 1 });

    expect(late.body.aggregationId).not.toBe(first.body.aggregationId);
    expect((await as.aggregation(first.body.aggregationId)).body).toMatchObject({
      status: 'REFERRED',
      totalQuantity: '4',
    });
    expect((await as.demand(first.body.id)).body).toMatchObject({ status: 'REFERRED', version: 2 });
    expect(await lastEvent(harness, a, 'AGGREGATION_REFERRED')).toMatchObject({
      demandIds: [first.body.id],
      totalQuantity: '4',
    });
  });

  it('CLOSE ends a short window and its demands LAPSED', async () => {
    const { harness, clock } = await api({ hours: 10, min: 100, policy: 'CLOSE' });
    const a = org();
    const as = client(harness, buyer(a));
    const productId = newProductId();

    clock.set(T0);
    const first = await as.submit({ productId, quantity: 4 });
    clock.set(new Date(T0.getTime() + 11 * HOUR));
    await as.submit({ productId, quantity: 1 });

    expect((await as.aggregation(first.body.aggregationId)).body.status).toBe('LAPSED');
    expect((await as.demand(first.body.id)).body.status).toBe('LAPSED');
    expect(await lastEvent(harness, a, 'AGGREGATION_LAPSED')).toMatchObject({
      demandIds: [first.body.id],
      reasonCode: 'SHORTFALL_CLOSED',
    });
  });

  it('a window left with no live demand lapses at its end, whatever the policy', async () => {
    const { harness, clock } = await api({ hours: 10, min: 0, policy: 'EXTEND' });
    const a = org();
    const as = client(harness, buyer(a));
    const productId = newProductId();

    clock.set(T0);
    const only = await as.submit({ productId, quantity: 4 });
    clock.set(new Date(T0.getTime() + HOUR));
    expect((await as.withdraw(only.body.id, 1)).status).toBe(200);
    // Still OPEN with nothing in it: a demand within the window would still join it.
    expect((await as.aggregation(only.body.aggregationId)).body).toMatchObject({
      status: 'OPEN',
      demandCount: 0,
    });

    clock.set(new Date(T0.getTime() + 10 * HOUR));
    const late = await as.submit({ productId, quantity: 1 });
    expect(late.body.aggregationId).not.toBe(only.body.aggregationId);
    expect((await as.aggregation(only.body.aggregationId)).body).toMatchObject({
      status: 'LAPSED',
      totalQuantity: '0',
    });
    expect((await as.demand(only.body.id)).body.status).toBe('WITHDRAWN');
    expect(await lastEvent(harness, a, 'AGGREGATION_LAPSED')).toMatchObject({
      demandIds: [],
      reasonCode: 'NO_LIVE_DEMAND',
    });
  });

  it('refuses a withdrawal at closesAt, while the status still says OPEN (422 AGGREGATION_WINDOW_ENDED)', async () => {
    const { harness, clock } = await api({ hours: 10 });
    const a = org();
    const as = client(harness, buyer(a));

    clock.set(T0);
    const demand = await as.submit({ quantity: 4 });
    clock.set(new Date(T0.getTime() + 10 * HOUR - 1));
    const before = await as.submit({ productId: demand.body.productId, quantity: 1 });
    expect((await as.withdraw(before.body.id, 1)).status).toBe(200);

    clock.set(new Date(T0.getTime() + 10 * HOUR));
    const refused = await as.withdraw(demand.body.id, 1);
    expect(refused.status).toBe(422);
    expect(refused.body.details).toEqual([
      expect.objectContaining({ path: 'withdrawal', code: 'AGGREGATION_WINDOW_ENDED' }),
    ]);
    expect((await as.aggregation(demand.body.aggregationId)).body.status).toBe('OPEN');
    expect((await as.demand(demand.body.id)).body.status).toBe('SUBMITTED');
  });

  it('a demand that waits on the window’s lock past its end does not join it: the clock is read after the lock', async () => {
    const { harness, clock } = await api({ hours: 10, min: 0 });
    const a = org();
    const as = client(harness, buyer(a));
    const productId = newProductId();

    clock.set(T0);
    const first = await as.submit({ productId, quantity: 2 });
    clock.set(new Date(T0.getTime() + 10 * HOUR - 1));

    const holder = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: (pid: number) => void;
    const lockHeld = new Promise<number>((resolve) => (locked = resolve));
    const hold = holder.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        await tx.$queryRaw`SELECT 1 FROM demand_aggregation
          WHERE organization_id = ${a} AND id = ${first.body.aggregationId} FOR UPDATE`;
        locked(row!.pid);
        await released;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    try {
      const holderPid = await lockHeld;
      const waiting = as.submit({ productId, quantity: 3 }).then((response) => response);
      // Until the request is parked on the holder's lock, by the catalogue — then time passes.
      for (let attempt = 0; ; attempt += 1) {
        const [row] = await holder.$queryRaw<{ blocked: bigint }[]>`
          SELECT count(*) AS blocked FROM pg_stat_activity
           WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))`;
        if (Number(row?.blocked ?? 0) > 0) break;
        if (attempt > 500) throw new Error('the request never waited on the window lock');
        await new Promise((resolve) => setImmediate(resolve));
      }
      clock.set(new Date(T0.getTime() + 10 * HOUR));
      release();
      await hold;

      const late = await waiting;
      expect(late.status).toBe(201);
      expect(late.body.aggregationId).not.toBe(first.body.aggregationId);
      expect((await as.aggregation(first.body.aggregationId)).body).toMatchObject({
        status: 'READY',
        totalQuantity: '2',
      });
    } finally {
      release();
      await hold.catch(() => undefined);
      await holder.$disconnect();
    }
  });

  it('two first demands at once make one window, and twenty make one window with the exact total', async () => {
    const { harness, clock } = await api({ hours: 24 });
    clock.set(T0);
    const a = org();
    const as = client(harness, buyer(a));

    const pairProduct = newProductId();
    const pair = await Promise.all([
      as.submit({ productId: pairProduct, quantity: 1 }),
      as.submit({ productId: pairProduct, quantity: 2 }),
    ]);
    expect(pair.map((r) => r.status)).toEqual([201, 201]);
    expect(pair[0]!.body.aggregationId).toBe(pair[1]!.body.aggregationId);

    const crowdProduct = newProductId();
    const crowd = await Promise.all(
      Array.from({ length: 20 }, (_, i) => as.submit({ productId: crowdProduct, quantity: i + 1 })),
    );
    expect(crowd.map((r) => r.status)).toEqual(Array.from({ length: 20 }, () => 201));
    const windows = new Set(crowd.map((r) => r.body.aggregationId as string));
    expect(windows.size).toBe(1);
    const [window] = [...windows];
    expect((await as.aggregation(window!)).body).toMatchObject({
      status: 'OPEN',
      totalQuantity: String((20 * 21) / 2),
      demandCount: 20,
    });
    const open = await as.aggregations('?status=OPEN');
    expect(
      open.body.items.filter((agg: { productId: string }) => agg.productId === crowdProduct),
    ).toHaveLength(1);
  });
});
