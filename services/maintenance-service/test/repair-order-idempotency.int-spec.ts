import { MaintenanceRepository } from '../src/maintenance/maintenance.repository';
import { RequestService } from '../src/maintenance/request.service';
import { RepairOrderService } from '../src/maintenance/repair-order.service';
import { UnverifiedWorkshopDirectory } from '../src/maintenance/workshop.directory';
import {
  REPAIR_ORDER_ENDPOINTS,
  RepairOrderController,
} from '../src/maintenance/repair-order.controller';
import { IdempotencyStore } from '../src/maintenance/idempotency';
import { MAX_AMOUNT_MINOR } from '../src/maintenance/dto';
import type {
  MaintenanceCostView,
  RecordCostDto,
  RecordLabourDto,
  RecordPartDto,
  RepairOrderView,
} from '../src/maintenance/dto';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, cleanup, id, newPrisma, seedAsset, tenants } from './helpers';

/**
 * Idempotency-Key on the six repair-order writes (docs/06 § 6.8), against real
 * PostgreSQL. The controller is driven directly with the real service and
 * store, so every claim is about what the database holds: how many cost rows
 * exist, what the order's total says, how many events were written.
 *
 * Money is the reason. A cost form submitted twice with its one submission id
 * must be one cost line and one event, however the two posts interleave.
 */
describe('repair-order writes under an Idempotency-Key', () => {
  let prisma: PrismaService;
  let requests: RequestService;
  let repairOrders: RepairOrderService;
  let store: IdempotencyStore;
  let controller: RepairOrderController;

  const org = tenants();
  const workshop = 'ORG-ITEST-WORKSHOP';
  const manager = { organizationId: org.a, userId: 'USR-ITEST-MANAGER' };

  beforeAll(async () => {
    prisma = newPrisma();
    const repository = new MaintenanceRepository(prisma);
    requests = new RequestService(repository);
    repairOrders = new RepairOrderService(repository, new UnverifiedWorkshopDirectory());
    store = new IdempotencyStore(prisma, { MAINTENANCE_IDEMPOTENCY_TTL_HOURS: 24 });
    controller = new RepairOrderController(repairOrders, store);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await prisma.onModuleDestroy();
  });

  /** A referred repair order, left OPEN unless `start` — an OPEN order already takes cost. */
  async function order(start = false): Promise<{ requestId: string; orderId: string }> {
    const assetId = id('AST-ITEST');
    await seedAsset(prisma, assetId, org.a);
    const request = await asActor(manager, () =>
      requests.create({ assetId, type: 'CORRECTIVE', severity: 'HIGH', title: 'تعمیر' }),
    );
    const referred = await asActor(manager, () =>
      repairOrders.assign(request.id, { workshopOrganizationId: workshop }),
    );
    if (start) await asActor(manager, () => repairOrders.start(referred.id, {}));
    return { requestId: request.id, orderId: referred.id };
  }

  const part = (over: Partial<RecordPartDto> = {}): RecordPartDto => ({
    partName: 'فیلتر روغن',
    quantity: '2',
    unit: 'عدد',
    unitCostMinor: '250000',
    source: 'WORKSHOP_SUPPLIED',
    ...over,
  });
  const labour = (over: Partial<RecordLabourDto> = {}): RecordLabourDto => ({
    description: 'تعویض فیلتر',
    hours: '1.5',
    hourlyRateMinor: '800000',
    ...over,
  });
  const charge = (over: Partial<RecordCostDto> = {}): RecordCostDto => ({
    category: 'SERVICE',
    amountMinor: '500000',
    currency: 'IRR',
    description: 'ایاب و ذهاب',
    ...over,
  });

  const as = (user: { organizationId: string; userId: string }) => user;
  const costRows = (orderId: string) =>
    prisma.client.$queryRawUnsafe<{ id: string; amount_minor: string }[]>(
      'SELECT id, amount_minor::text FROM maintenance_cost WHERE repair_order_id = $1 ORDER BY recorded_at',
      orderId,
    );
  const totals = async (orderId: string) =>
    (
      await prisma.client.$queryRawUnsafe<{ total: string; request_total: string }[]>(
        `SELECT o.total_cost_minor::text AS total, r.total_cost_minor::text AS request_total
         FROM repair_order o JOIN maintenance_request r ON r.id = o.maintenance_request_id
         WHERE o.id = $1`,
        orderId,
      )
    )[0];
  const eventCount = (aggregateId: string, eventName: string) =>
    prisma.client.outboxMessage.count({ where: { aggregateId, eventName } });
  const keyRows = (endpoint: string, key: string) =>
    prisma.client.$queryRawUnsafe<{ state: string }[]>(
      'SELECT state FROM idempotency_key WHERE organization_id = $1 AND endpoint = $2 AND key = $3',
      org.a,
      endpoint,
      key,
    );

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  /** A gate a test opens by hand, and a signal that something reached it. */
  function gate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    let reach!: () => void;
    const reached = new Promise<void>((resolve) => (reach = resolve));
    return { open, opened, reach, reached };
  }

  describe('a retry with the same key, body, order and user', () => {
    it('records a cost once: one line, one event, the order total moved once, the same answer both times', async () => {
      const { orderId } = await order();
      const key = id('KEY');

      const first = await asActor(manager, () => controller.recordCost(orderId, charge(), key));
      const retry = await asActor(manager, () => controller.recordCost(orderId, charge(), key));

      expect(retry).toEqual(first);
      expect(await costRows(orderId)).toHaveLength(1);
      expect(await eventCount(orderId, 'REPAIR_COST_RECORDED')).toBe(1);
      expect((await totals(orderId)).total).toBe('500000');
      expect(await keyRows(REPAIR_ORDER_ENDPOINTS.costs, key)).toEqual([{ state: 'COMPLETED' }]);
    });

    it('records a part once: one part, its one cost line, one event', async () => {
      const { orderId } = await order();
      const key = id('KEY');

      const first = await asActor(manager, () => controller.recordPart(orderId, part(), key));
      const retry = await asActor(manager, () => controller.recordPart(orderId, part(), key));

      expect(retry).toEqual(first);
      expect(await costRows(orderId)).toHaveLength(1);
      expect(await eventCount(orderId, 'REPAIR_PART_RECORDED')).toBe(1);
      expect((await totals(orderId)).total).toBe('500000');
    });

    it('records labour once', async () => {
      const { orderId } = await order();
      const key = id('KEY');

      const first = await asActor(manager, () => controller.recordLabour(orderId, labour(), key));
      const retry = await asActor(manager, () => controller.recordLabour(orderId, labour(), key));

      expect(retry).toEqual(first);
      expect(await costRows(orderId)).toHaveLength(1);
      expect(await eventCount(orderId, 'REPAIR_LABOUR_RECORDED')).toBe(1);
      expect((await totals(orderId)).total).toBe('1200000');
    });

    it('starts once, and a retry is the original answer, not "already started"', async () => {
      const { requestId, orderId } = await order();
      const key = id('KEY');

      const first = await asActor(manager, () => controller.start(orderId, {}, key));
      const retry = await asActor(manager, () => controller.start(orderId, {}, key));

      expect(retry).toEqual(first);
      expect((first as RepairOrderView).status).toBe('IN_PROGRESS');
      expect(await eventCount(requestId, 'MAINTENANCE_STARTED')).toBe(1);
    });

    it('completes once, and a retry is the original answer, not "already completed"', async () => {
      const { requestId, orderId } = await order(true);
      await asActor(manager, () => controller.recordCost(orderId, charge(), id('KEY')));
      const key = id('KEY');
      const dto = { workPerformed: 'انجام شد', expectedTotalCostMinor: '500000' };

      const first = await asActor(manager, () => controller.complete(orderId, dto, key));
      const retry = await asActor(manager, () => controller.complete(orderId, dto, key));

      expect(retry).toEqual(first);
      expect((first as RepairOrderView).status).toBe('COMPLETED');
      expect(await eventCount(orderId, 'REPAIR_COMPLETED')).toBe(1);
      expect(await eventCount(requestId, 'MAINTENANCE_COMPLETED')).toBe(1);
    });

    it('withdraws once, and a retry is the original answer', async () => {
      const { orderId } = await order();
      const key = id('KEY');
      const dto = { reason: 'تعمیرگاه نپذیرفت' };

      const first = await asActor(manager, () => controller.cancel(orderId, dto, key));
      const retry = await asActor(manager, () => controller.cancel(orderId, dto, key));

      expect(retry).toEqual(first);
      expect((first as RepairOrderView).status).toBe('CANCELLED');
      expect(await eventCount(orderId, 'REPAIR_CANCELLED')).toBe(1);
    });
  });

  describe('a concurrent duplicate', () => {
    it('is answered with the first request’s own response while that one is still working: one line, one event', async () => {
      const { orderId } = await order();
      const key = id('KEY');
      const dto = charge();
      const a = gate();

      // A has claimed and holds its transaction's first statement open.
      const first = asActor(manager, () =>
        store.execute<MaintenanceCostView>(
          REPAIR_ORDER_ENDPOINTS.costs,
          key,
          { repairOrderId: orderId, ...dto },
          201,
          async (fence) =>
            repairOrders.recordCost(orderId, dto, {
              hold: async (tx) => {
                await fence.hold(tx);
                a.reach();
                await a.opened;
              },
              complete: fence.complete,
            }),
        ),
      );
      await a.reached;

      // B, the same post, arrives now. It must neither run the work nor give up.
      const duplicate = asActor(manager, () => controller.recordCost(orderId, dto, key));
      const settled = await Promise.race([
        duplicate.then(() => 'answered'),
        sleep(600).then(() => 'waiting'),
      ]);
      expect(settled).toBe('waiting');
      expect(await costRows(orderId)).toEqual([]);

      a.open();
      const original = (await first).result;
      expect(await duplicate).toEqual(original);
      expect(await costRows(orderId)).toHaveLength(1);
      expect(await eventCount(orderId, 'REPAIR_COST_RECORDED')).toBe(1);
    });

    it('cannot re-take a claim that expires under a running write: its removal waits on the lock, then replays', async () => {
      const { orderId } = await order();
      const key = id('KEY');
      const dto = charge();
      const a = gate();
      const LIFETIME_MS = 1_500;

      // A's claim is about to expire as A's transaction takes it.
      const first = asActor(manager, () =>
        store.execute<MaintenanceCostView>(
          REPAIR_ORDER_ENDPOINTS.costs,
          key,
          { repairOrderId: orderId, ...dto },
          201,
          async (fence) => {
            await prisma.client.$executeRawUnsafe(
              `UPDATE idempotency_key SET expires_at = now() + make_interval(secs => $3) WHERE organization_id = $1 AND key = $2`,
              org.a,
              key,
              LIFETIME_MS / 1000,
            );
            return repairOrders.recordCost(orderId, dto, {
              hold: async (tx) => {
                await fence.hold(tx);
                a.reach();
                await a.opened;
              },
              complete: fence.complete,
            });
          },
        ),
      );
      await a.reached;
      await sleep(LIFETIME_MS + 200);

      // The claim has expired while A holds it. The duplicate's removal of the
      // expired row must wait for A's lock — a blocked session we can see.
      const duplicate = asActor(manager, () => controller.recordCost(orderId, dto, key));
      const deadline = Date.now() + 5_000;
      for (;;) {
        const [{ waiting }] = await prisma.client.$queryRawUnsafe<{ waiting: number }[]>(
          `SELECT count(*)::int AS waiting FROM pg_stat_activity
           WHERE wait_event_type = 'Lock' AND query ILIKE 'DELETE FROM%idempotency_key%'`,
        );
        if (waiting > 0) break;
        if (Date.now() > deadline) throw new Error('the duplicate never waited on the held claim');
        await sleep(25);
      }
      expect(await costRows(orderId)).toEqual([]);

      // Released, A commits with a fresh lifetime, and the duplicate replays it.
      a.open();
      const original = (await first).result;
      expect(await duplicate).toEqual(original);
      expect(await costRows(orderId)).toHaveLength(1);
      expect(await eventCount(orderId, 'REPAIR_COST_RECORDED')).toBe(1);
      expect((await totals(orderId)).total).toBe('500000');
    });

    it('still lets two different keys record two lines at once: the order lock serialises them and neither is lost', async () => {
      const { orderId } = await order();

      await Promise.all([
        asActor(manager, () =>
          controller.recordCost(orderId, charge({ amountMinor: '100' }), id('KEY')),
        ),
        asActor(manager, () =>
          controller.recordCost(orderId, charge({ amountMinor: '200' }), id('KEY')),
        ),
      ]);

      expect(await costRows(orderId)).toHaveLength(2);
      expect((await totals(orderId)).total).toBe('300');
    });
  });

  describe('a key that is not the same request', () => {
    it('is refused with a different body, a different order or a different user, and writes nothing more', async () => {
      const { orderId } = await order();
      const other = (await order()).orderId;
      const key = id('KEY');
      await asActor(manager, () => controller.recordCost(orderId, charge(), key));

      await expect(
        asActor(manager, () =>
          controller.recordCost(orderId, charge({ amountMinor: '600000' }), key),
        ),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      await expect(
        asActor(manager, () => controller.recordCost(other, charge(), key)),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      await expect(
        asActor(as({ ...manager, userId: 'USR-ITEST-SOMEONE-ELSE' }), () =>
          controller.recordCost(orderId, charge(), key),
        ),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });

      expect(await costRows(orderId)).toHaveLength(1);
      expect(await costRows(other)).toEqual([]);
      expect((await totals(orderId)).total).toBe('500000');
    });

    it('is two requests on two endpoints: the same key may start an order and record its cost', async () => {
      const { orderId } = await order();
      const key = id('KEY');

      await asActor(manager, () => controller.start(orderId, {}, key));
      await asActor(manager, () => controller.recordCost(orderId, charge(), key));

      expect(await costRows(orderId)).toHaveLength(1);
    });

    it('is the organization’s own: the same key in another organization is not a replay, and cannot reach this order', async () => {
      const { orderId } = await order();
      const key = id('KEY');
      await asActor(manager, () => controller.recordCost(orderId, charge(), key));

      // Authorization comes first: another tenant is answered as for an order that does not exist.
      await expect(
        asActor({ organizationId: org.b, userId: 'USR-ITEST-OTHER-TENANT' }, () =>
          controller.recordCost(orderId, charge(), key),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await costRows(orderId)).toHaveLength(1);
    });
  });

  describe('when the write cannot be done', () => {
    it('releases the key, so a corrected retry with the same key can run', async () => {
      const { orderId } = await order(true);
      await asActor(manager, () =>
        controller.complete(orderId, { workPerformed: 'انجام شد' }, id('KEY')),
      );
      const key = id('KEY');

      // A completed order takes no more cost.
      await expect(
        asActor(manager, () => controller.recordCost(orderId, charge(), key)),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
      expect(await keyRows(REPAIR_ORDER_ENDPOINTS.costs, key)).toEqual([]);
      expect(await costRows(orderId)).toEqual([]);
    });

    it('leaves nothing half-done when storing the response fails: no line, no event, totals unmoved, the key free', async () => {
      const { orderId } = await order();
      const key = id('KEY');

      const failing = jest
        .spyOn(store, 'storeResponse')
        .mockRejectedValueOnce(new Error('response store failed (injected)'));
      try {
        await expect(
          asActor(manager, () => controller.recordCost(orderId, charge(), key)),
        ).rejects.toThrow('response store failed (injected)');
      } finally {
        failing.mockRestore();
      }
      expect(await costRows(orderId)).toEqual([]);
      expect(await eventCount(orderId, 'REPAIR_COST_RECORDED')).toBe(0);
      expect((await totals(orderId)).total).toBe('0');
      expect(await keyRows(REPAIR_ORDER_ENDPOINTS.costs, key)).toEqual([]);

      // The retry is the first request that commits — once, with its event.
      await asActor(manager, () => controller.recordCost(orderId, charge(), key));
      await asActor(manager, () => controller.recordCost(orderId, charge(), key));
      expect(await costRows(orderId)).toHaveLength(1);
      expect(await eventCount(orderId, 'REPAIR_COST_RECORDED')).toBe(1);
    });
  });

  describe('with no key', () => {
    it('does what it always did: two posts are two lines', async () => {
      const { orderId } = await order();

      await asActor(manager, () => controller.recordCost(orderId, charge(), undefined));
      await asActor(manager, () => controller.recordCost(orderId, charge(), undefined));

      expect(await costRows(orderId)).toHaveLength(2);
      expect((await totals(orderId)).total).toBe('1000000');
    });

    it('refuses a key that is present but too short, rather than ignoring it', async () => {
      const { orderId } = await order();
      await expect(
        asActor(manager, () => controller.recordCost(orderId, charge(), 'short')),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(await costRows(orderId)).toEqual([]);
    });
  });

  // ---- The ledger's bound (round 2 on #187): no amount, no line and no total
  // the BIGINT columns cannot hold reaches them.

  describe('the largest amount the ledger can hold', () => {
    const MAX = MAX_AMOUNT_MINOR.toString();

    it('accepts a cost of exactly the bound, and refuses the next unit of it without recording it', async () => {
      const { orderId } = await order();
      await asActor(manager, () =>
        controller.recordCost(orderId, charge({ amountMinor: MAX }), id('KEY')),
      );
      expect(await totals(orderId)).toEqual({ total: MAX, request_total: MAX });

      await expect(
        asActor(manager, () =>
          controller.recordCost(orderId, charge({ amountMinor: '1' }), id('KEY')),
        ),
      ).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
        internalContext: expect.objectContaining({ rule: 'COST_TOTAL_TOO_LARGE' }),
      });

      // Refused whole: the line is not there, the totals did not move, no event was written.
      expect(await costRows(orderId)).toHaveLength(1);
      expect(await totals(orderId)).toEqual({ total: MAX, request_total: MAX });
      expect(await eventCount(orderId, 'REPAIR_COST_RECORDED')).toBe(1);
    });

    it('refuses an amount past the bound at the service, as a refusal and never a database error', async () => {
      const { orderId } = await order();
      const past = (MAX_AMOUNT_MINOR + 1n).toString();

      const calls: (() => Promise<unknown>)[] = [
        () => controller.recordCost(orderId, charge({ amountMinor: past }), undefined),
        () =>
          controller.recordPart(orderId, part({ unitCostMinor: past, quantity: '1' }), undefined),
        () =>
          controller.recordLabour(
            orderId,
            labour({ hourlyRateMinor: past, hours: '1' }),
            undefined,
          ),
      ];
      for (const call of calls) {
        await expect(asActor(manager, call)).rejects.toMatchObject({
          code: 'BUSINESS_RULE_VIOLATION',
          internalContext: expect.objectContaining({ rule: 'AMOUNT_TOO_LARGE' }),
        });
      }
      expect(await costRows(orderId)).toEqual([]);
    });

    it('refuses a line whose total overflows although quantity and price each fit', async () => {
      const { orderId } = await order();
      // 2 × 2^62 = 2^63, one past the bound.
      const half = (2n ** 62n).toString();

      await expect(
        asActor(manager, () =>
          controller.recordPart(orderId, part({ quantity: '2', unitCostMinor: half }), undefined),
        ),
      ).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
        internalContext: expect.objectContaining({ rule: 'LINE_TOTAL_TOO_LARGE' }),
      });
      await expect(
        asActor(manager, () =>
          controller.recordLabour(
            orderId,
            labour({ hours: '2', hourlyRateMinor: half }),
            undefined,
          ),
        ),
      ).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
        internalContext: expect.objectContaining({ rule: 'LINE_TOTAL_TOO_LARGE' }),
      });
      expect(await costRows(orderId)).toEqual([]);
      expect((await totals(orderId)).total).toBe('0');

      // …and the largest line that does fit goes in.
      await asActor(manager, () =>
        controller.recordPart(orderId, part({ quantity: '1', unitCostMinor: MAX }), undefined),
      );
      expect((await totals(orderId)).total).toBe(MAX);
    });

    it('refuses the request’s total across referrals: a withdrawn order’s cost still counts', async () => {
      const first = await order();
      await asActor(manager, () =>
        controller.recordCost(first.orderId, charge({ amountMinor: MAX }), undefined),
      );
      await asActor(manager, () =>
        controller.cancel(first.orderId, { reason: 'تعمیرگاه نپذیرفت' }, undefined),
      );
      // The request stays open and is referred again; the first order's cost is kept.
      const second = await asActor(manager, () =>
        repairOrders.assign(first.requestId, { workshopOrganizationId: workshop }),
      );

      // 1 on the new order is fine for it, but the request would hold MAX + 1.
      await expect(
        asActor(manager, () =>
          controller.recordCost(second.id, charge({ amountMinor: '1' }), undefined),
        ),
      ).rejects.toMatchObject({
        internalContext: expect.objectContaining({ rule: 'COST_TOTAL_TOO_LARGE' }),
      });
      expect(await costRows(second.id)).toEqual([]);
      expect((await totals(first.orderId)).request_total).toBe(MAX);
    });
  });
});
