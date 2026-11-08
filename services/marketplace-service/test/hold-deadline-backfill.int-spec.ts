import { withUtcSession } from '@rasta/config';
import { OrderStatus, PrismaClient } from '../src/generated/prisma';
import {
  BackfillRefused,
  backfillLegacyHoldDeadlines,
  parseBackfillArgs,
} from '../src/ops/hold-deadline-backfill';
import { HOLD_FENCE } from '../src/temporal/economic-refusal';
import { asActor, cleanup, id, key, newPrisma, publishOffer, tenants, wire } from './helpers';

/** FU-234: the legacy hold-deadline backfill, on orders placed and driven as the service does. */
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const SINCE = ago(2 * HOUR);
const ASSIGNABLE = ['PENDING', 'CANCELLING', 'CANCELLED', 'FAILED'] as const;

describe('the legacy hold-deadline backfill (PostgreSQL)', () => {
  const prisma = newPrisma();
  const wiring = wire(prisma);
  const org = tenants();
  let owner: PrismaClient;
  const run = (over: Partial<Parameters<typeof backfillLegacyHoldDeadlines>[1]> = {}) =>
    backfillLegacyHoldDeadlines(prisma.client, {
      apply: true,
      economicRuleSince: SINCE,
      batchSize: 200,
      maxBatches: 100,
      ...over,
    });

  beforeAll(() => {
    const url = process.env.DATABASE_URL_MARKETPLACE_MIGRATOR;
    if (!url) throw new Error('DATABASE_URL_MARKETPLACE_MIGRATOR is required by this suite');
    owner = new PrismaClient({ datasources: { db: { url: withUtcSession(url) } } });
  });
  afterAll(async () => {
    await owner.$disconnect();
    await cleanup(prisma, [org.buyer, org.supplier]);
    await prisma.onModuleDestroy();
  });

  async function place() {
    const { offerId } = await publishOffer(wiring, org.supplier);
    const placed = await asActor({ organizationId: org.buyer }, () =>
      wiring.orders.place({ lines: [{ offerId, quantity: 1 }] }, key('backfill')),
    );
    return { id: placed.id, organizationId: org.buyer };
  }
  /** As the fence migration left an order placed before it: one send counted, no deadline. */
  async function legacy(status: OrderStatus, held = false) {
    const order = await place();
    await owner.order.update({
      where: { id: order.id },
      data: {
        holdSendClaims: 1,
        status,
        economicTransactionId: held ? id('TXN') : null,
        // What each status's own constraints ask of a row that reached it.
        ...{ failureReason: 'x', cancelledAt: new Date(), cancellationReason: 'x' },
        ...{ cancellationCause: 'BUYER', completedAt: new Date(), economicSettlementId: id('STL') },
        ...{ receiptConfirmedAt: new Date(), receiptConfirmedBy: 'USR-ITEST' },
      },
    });
    return order;
  }
  const row = (order: { id: string }) =>
    owner.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { holdNotAfter: true, holdSendClaims: true, holdSendsClosedAt: true, status: true },
    });
  const audit = (order: { id: string }) =>
    owner.orderHoldDeadlineBackfill.findMany({ where: { orderId: order.id } });

  it('a dry run reports the plan and writes nothing', async () => {
    const order = await legacy('PENDING');
    const report = await run({ apply: false });
    expect(report).toMatchObject({ mode: 'dry-run', assigned: [] });
    expect(report.plan.assignable).toBeGreaterThanOrEqual(1);
    expect(await row(order)).toMatchObject({ holdNotAfter: null, holdSendClaims: 1 });
    expect(await audit(order)).toEqual([]);
  });

  it('gives a legacy row in every state the order can be in without a hold a deadline, recorded', async () => {
    const orders = await Promise.all(ASSIGNABLE.map((status) => legacy(status)));
    // A saga from before protocol 10 on this build: it counted its send and fixed nothing.
    const counted = await place();
    await wiring.orders.claimHoldSend(counted, undefined);
    const before = Date.now();
    const report = await run();
    for (const order of [...orders, counted]) {
      const given = (await row(order)).holdNotAfter?.getTime() ?? 0;
      expect(given).toBeGreaterThanOrEqual(before + HOLD_FENCE.sendWindowMs - 60_000);
      expect(given).toBeLessThanOrEqual(Date.now() + HOLD_FENCE.sendWindowMs + 60_000);
      const [record] = await audit(order);
      expect(record).toMatchObject({ runId: report.runId, holdSendClaims: 1 });
      expect(record?.holdNotAfter.getTime()).toBe(given);
      expect(record?.economicRuleSince.toISOString()).toBe(SINCE);
      expect(report.assigned).toContainEqual(expect.objectContaining({ orderId: order.id }));
    }
    expect(report.assigned.find((a) => a.orderId === orders[0]?.id)?.status).toBe('PENDING');
    // The saga's next send carries it, and the row proves nothing before it and the margin.
    const claim = await wiring.orders.claimHoldSend(orders[0]!, ago(-HOUR));
    expect(claim).toMatchObject({
      holdNotAfter: (await row(orders[0]!)).holdNotAfter?.toISOString(),
      claims: 2,
    });
    expect(
      await wiring.orders.closeHoldSendsIfNoneCanLand(orders[0]!, HOLD_FENCE.clockMarginMs),
    ).toBe(false);
  });

  it('leaves alone a row with a deadline, with no send, with its sends closed, or with its hold', async () => {
    const fenced = await place();
    const deadline = ago(-5 * HOUR);
    await wiring.orders.claimHoldSend(fenced, deadline);
    const unsent = await place();
    const closed = await legacy('PENDING');
    await owner.order.update({ where: { id: closed.id }, data: { holdSendsClosedAt: new Date() } });
    // Held, in every status there is: the hold landed and is on the order.
    const held = await Promise.all(
      Object.values(OrderStatus).map((status) => legacy(status, true)),
    );
    const all = [fenced, unsent, closed, ...held];
    const before = await Promise.all(all.map(row));
    const report = await run();
    expect(await Promise.all(all.map(row))).toEqual(before);
    expect(before[0]?.holdNotAfter?.toISOString()).toBe(deadline);
    for (const order of all) expect(await audit(order)).toEqual([]);
    // Nor refused: each of them is classified, not guessed at.
    const refused = new Set(report.refused.map((r) => r.orderId));
    expect(all.filter((order) => refused.has(order.id))).toEqual([]);
    expect(report.plan.held).toBeGreaterThanOrEqual(1);
  });

  it('refuses, reports and never writes a row whose state cannot follow from the order’s life', async () => {
    // A count below zero: no writer of this service makes one. Copied from a placed order.
    const source = await place();
    const odd = { id: id('ORD'), organizationId: org.buyer };
    await owner.$executeRaw`INSERT INTO "order" SELECT (jsonb_populate_record(o, jsonb_build_object(
        'id', ${odd.id}::text, 'idempotency_key', ${key('odd')}::text, 'hold_send_claims', -1))).*
      FROM "order" o WHERE o.id = ${source.id}`;
    const report = await run();
    expect(report.refused).toContainEqual({
      orderId: odd.id,
      organizationId: org.buyer,
      status: 'PENDING',
    });
    expect(await row(odd)).toMatchObject({ holdNotAfter: null, holdSendClaims: -1 });
    expect(await audit(odd)).toEqual([]);
    expect(report.plan.refused).toBeGreaterThanOrEqual(1);
    expect(report.converged).toBe(false);
    await owner.order.update({ where: { id: odd.id }, data: { holdSendsClosedAt: new Date() } });
  });

  it('a rerun is a no-op', async () => {
    const order = await legacy('CANCELLED');
    await run();
    const first = await row(order);
    const again = await run();
    expect(again.assigned).toEqual([]);
    expect(await row(order)).toEqual(first);
    expect(await audit(order)).toHaveLength(1);
  });

  it('works in bounded batches and says what is left', async () => {
    const orders = await Promise.all([1, 2, 3].map(() => legacy('PENDING')));
    const sliced = await run({ batchSize: 1, maxBatches: 2 });
    expect(sliced.assigned).toHaveLength(2);
    expect(sliced.remaining).toBeGreaterThanOrEqual(1);
    expect(sliced.converged).toBe(false);
    await run();
    for (const order of orders) expect((await row(order)).holdNotAfter).not.toBeNull();
  });

  it.each([
    ['too recent for the margin', ago(HOUR / 2)],
    ['in the future', ago(-HOUR)],
  ])(
    'refuses the whole run when economic-service’s rule is %s, dry run too',
    async (_name, since) => {
      const order = await legacy('PENDING');
      for (const apply of [false, true]) {
        await expect(run({ apply, economicRuleSince: since })).rejects.toBeInstanceOf(
          BackfillRefused,
        );
      }
      expect(await row(order)).toMatchObject({ holdNotAfter: null });
      await run();
    },
  );

  it('an operator’s options are refused unless explicit and well formed', () => {
    const since = '2026-11-07T10:00:00+03:30';
    expect(parseBackfillArgs(['--economic-rule-since', since])).toMatchObject({
      apply: false,
      economicRuleSince: '2026-11-07T06:30:00.000Z',
    });
    for (const argv of [
      [],
      ['--apply'],
      ['--economic-rule-since', '2026-11-07T10:00:00'],
      ['--economic-rule-since', since, '--apply', '--dry-run'],
      ['--economic-rule-since', since, '--batch-size', '0'],
      ['--economic-rule-since', since, '--max-batches', '1e3'],
      ['--economic-rule-since', since, '--force'],
      ['--economic-rule-since', since, 'toString', '1'],
    ]) {
      expect(() => parseBackfillArgs(argv)).toThrow(BackfillRefused);
    }
  });
});
