import { Test } from '@nestjs/testing';
import {
  Module,
  VersioningType,
  type INestApplication,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import request from 'supertest';
import { AllExceptionsFilter, runWithContext } from '@rasta/nest-common';
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
const LEASE_SECONDS = 120;

describe('repair-order writes under an Idempotency-Key', () => {
  let prisma: PrismaService;
  let requests: RequestService;
  let repairOrders: RepairOrderService;
  let store: IdempotencyStore;
  let controller: RepairOrderController;
  let http: INestApplication;

  const org = tenants();
  const workshop = 'ORG-ITEST-WORKSHOP';
  const manager = { organizationId: org.a, userId: 'USR-ITEST-MANAGER' };

  beforeAll(async () => {
    prisma = newPrisma();
    const repository = new MaintenanceRepository(prisma);
    requests = new RequestService(repository);
    repairOrders = new RepairOrderService(repository, new UnverifiedWorkshopDirectory());
    store = new IdempotencyStore(prisma, {
      MAINTENANCE_IDEMPOTENCY_TTL_HOURS: 24,
      MAINTENANCE_IDEMPOTENCY_CLAIM_LEASE_SECONDS: LEASE_SECONDS,
    });
    controller = new RepairOrderController(repairOrders, store);

    // The same controller, service and store behind a real HTTP stack, with the
    // caller's context established the way production does it: by a Nest
    // middleware, which runs after the body has been read (as
    // `RequestContextMiddleware` does) — a context set before the body parser
    // would be lost when the parser's stream events call `next`.
    const withCaller = (_req: unknown, _res: unknown, next: () => void) => {
      runWithContext(
        {
          correlationId: id('itest-C'),
          requestId: id('itest-R'),
          organizationId: manager.organizationId,
          userId: manager.userId,
          roles: ['FLEET_MANAGER'],
          organizationIds: [],
          authType: 'USER',
          startedAt: Date.now(),
        },
        () => next(),
      );
    };
    @Module({
      controllers: [RepairOrderController],
      providers: [
        { provide: RepairOrderService, useValue: repairOrders },
        { provide: IdempotencyStore, useValue: store },
      ],
    })
    class HttpModule implements NestModule {
      configure(consumer: MiddlewareConsumer): void {
        consumer.apply(withCaller).forRoutes('*');
      }
    }
    const moduleRef = await Test.createTestingModule({ imports: [HttpModule] }).compile();
    http = moduleRef.createNestApplication();
    http.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    http.useGlobalFilters(
      new AllExceptionsFilter({
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
      } as never),
    );
    await http.init();
  });

  afterAll(async () => {
    await http?.close();
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

  describe('with no key, or one that cannot be used', () => {
    it('is refused at the service, as 400 with the code "required", and writes nothing: two identical direct calls are no longer two lines', async () => {
      const { orderId } = await order();

      for (const key of [undefined, '', '   ']) {
        await expect(
          asActor(manager, () => controller.recordCost(orderId, charge(), key)),
        ).rejects.toMatchObject({
          code: 'VALIDATION_FAILED',
          details: expect.arrayContaining([
            expect.objectContaining({ path: 'Idempotency-Key', code: 'required' }),
          ]),
        });
      }

      expect(await costRows(orderId)).toEqual([]);
      expect(await eventCount(orderId, 'REPAIR_COST_RECORDED')).toBe(0);
      expect((await totals(orderId)).total).toBe('0');
    });

    it('is refused for every one of the six writes', async () => {
      const { orderId } = await order(true);
      const calls: (() => Promise<unknown>)[] = [
        () => controller.start(orderId, {}, undefined),
        () => controller.complete(orderId, { workPerformed: 'انجام شد' }, undefined),
        () => controller.cancel(orderId, { reason: 'تعمیرگاه نپذیرفت' }, undefined),
        () => controller.recordPart(orderId, part(), undefined),
        () => controller.recordLabour(orderId, labour(), undefined),
        () => controller.recordCost(orderId, charge(), undefined),
      ];
      for (const call of calls) {
        await expect(asActor(manager, call)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      }
      // Nothing moved: the order is still in progress, with no line.
      expect(await costRows(orderId)).toEqual([]);
      expect((await totals(orderId)).total).toBe('0');
      expect(await eventCount(orderId, 'REPAIR_COMPLETED')).toBe(0);
      expect(await eventCount(orderId, 'REPAIR_CANCELLED')).toBe(0);
    });

    it('is refused over HTTP too — through the real controller, pipes and filter — and writes nothing', async () => {
      const { orderId } = await order();
      const post = (key?: string) => {
        const call = request(http.getHttpServer()).post(`/v1/repair-orders/${orderId}/costs`);
        return (key === undefined ? call : call.set('Idempotency-Key', key)).send(charge());
      };

      const refused = await post();
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('VALIDATION_FAILED');
      expect(refused.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'Idempotency-Key', code: 'required' }),
        ]),
      );
      expect((await post('short')).status).toBe(400);
      expect(await costRows(orderId)).toEqual([]);
      expect(await eventCount(orderId, 'REPAIR_COST_RECORDED')).toBe(0);

      // With a key the same body is recorded once, however often it is posted.
      const key = id('KEY');
      const first = await post(key);
      const second = await post(key);
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body).toEqual(first.body);
      expect(await costRows(orderId)).toHaveLength(1);
      expect(await eventCount(orderId, 'REPAIR_COST_RECORDED')).toBe(1);
    });

    it('is refused for a key outside its bounds, even with a body that would otherwise be recorded', async () => {
      const { orderId } = await order();
      for (const key of ['short', 'x'.repeat(256)]) {
        await expect(
          asActor(manager, () => controller.recordCost(orderId, charge(), key)),
        ).rejects.toMatchObject({
          code: 'VALIDATION_FAILED',
          details: expect.arrayContaining([expect.objectContaining({ code: 'invalid' })]),
        });
      }
      expect(await costRows(orderId)).toEqual([]);
    });
  });

  // ---- A claim whose process died (round 3 on #187): an in-flight claim is a
  // lease, so a crashed write is retried after the lease, not after a day.

  describe('a claim left behind by a process that died', () => {
    const secondsLeft = async (endpoint: string, key: string) =>
      (
        await prisma.client.$queryRawUnsafe<{ secs: number }[]>(
          `SELECT extract(epoch FROM (expires_at - now()))::float AS secs
           FROM idempotency_key WHERE organization_id = $1 AND endpoint = $2 AND key = $3`,
          org.a,
          endpoint,
          key,
        )
      )[0]?.secs;
    const tokenOf = async (endpoint: string, key: string) =>
      (
        await prisma.client.$queryRawUnsafe<{ claim_token: string }[]>(
          'SELECT claim_token FROM idempotency_key WHERE organization_id = $1 AND endpoint = $2 AND key = $3',
          org.a,
          endpoint,
          key,
        )
      )[0]?.claim_token;
    /** The lease elapsing, without waiting for it. */
    const lapse = (endpoint: string, key: string) =>
      prisma.client.$executeRawUnsafe(
        `UPDATE idempotency_key SET expires_at = now() - interval '1 second'
         WHERE organization_id = $1 AND endpoint = $2 AND key = $3`,
        org.a,
        endpoint,
        key,
      );

    it('holds a claim for the lease only, and a stored response for the response’s lifetime', async () => {
      const { orderId } = await order();
      const key = id('KEY');
      const dto = charge();

      // The claim is taken and the process dies: nothing completes it.
      await asActor(manager, () =>
        store.claim(REPAIR_ORDER_ENDPOINTS.costs, key, { repairOrderId: orderId, ...dto }),
      );
      const claimed = (await secondsLeft(REPAIR_ORDER_ENDPOINTS.costs, key)) ?? 0;
      expect(claimed).toBeGreaterThan(LEASE_SECONDS - 30);
      expect(claimed).toBeLessThanOrEqual(LEASE_SECONDS);

      // A completed response is kept for the hours it is configured for.
      const done = id('KEY');
      await asActor(manager, () => controller.recordCost(orderId, charge(), done));
      expect((await secondsLeft(REPAIR_ORDER_ENDPOINTS.costs, done)) ?? 0).toBeGreaterThan(
        23 * 3_600,
      );
    });

    it('answers a retry inside the lease with a retryable 409, writing nothing', async () => {
      const { orderId } = await order();
      const key = id('KEY');
      const dto = charge();
      await asActor(manager, () =>
        store.claim(REPAIR_ORDER_ENDPOINTS.costs, key, { repairOrderId: orderId, ...dto }),
      );

      await expect(
        asActor(manager, () => controller.recordCost(orderId, dto, key)),
      ).rejects.toMatchObject({ code: 'CONFLICT', retryAfterSeconds: 1 });
      expect(await costRows(orderId)).toEqual([]);
    }, 20_000);

    it('lets a retry take the claim over once the lease has lapsed, under a new fencing token: one line, one event', async () => {
      const { orderId } = await order();
      const key = id('KEY');
      const dto = charge();
      await asActor(manager, () =>
        store.claim(REPAIR_ORDER_ENDPOINTS.costs, key, { repairOrderId: orderId, ...dto }),
      );
      const deadHolder = await tokenOf(REPAIR_ORDER_ENDPOINTS.costs, key);
      await lapse(REPAIR_ORDER_ENDPOINTS.costs, key);

      const recorded = await asActor(manager, () => controller.recordCost(orderId, dto, key));

      expect(await costRows(orderId)).toHaveLength(1);
      expect(await eventCount(orderId, 'REPAIR_COST_RECORDED')).toBe(1);
      expect((await totals(orderId)).total).toBe('500000');
      expect(await keyRows(REPAIR_ORDER_ENDPOINTS.costs, key)).toEqual([{ state: 'COMPLETED' }]);
      const successor = await tokenOf(REPAIR_ORDER_ENDPOINTS.costs, key);
      expect(successor).toBeTruthy();
      expect(successor).not.toBe(deadHolder);
      // And a further retry is now the replay.
      expect(await asActor(manager, () => controller.recordCost(orderId, dto, key))).toEqual(
        recorded,
      );
      expect(await costRows(orderId)).toHaveLength(1);
    });

    it('refuses the dead holder’s late completion by its token, deterministically: it commits nothing beside the successor’s write', async () => {
      const { orderId } = await order();
      const key = id('KEY');
      const dto = charge();
      const body = { repairOrderId: orderId, ...dto };
      const holder = gate();

      // The holder claims and stalls before its transaction — alive, but slow
      // past its lease, which is all a crashed-and-resumed process looks like.
      const late = asActor(manager, () =>
        store.execute<MaintenanceCostView>(
          REPAIR_ORDER_ENDPOINTS.costs,
          key,
          body,
          201,
          async (fence) => {
            holder.reach();
            await holder.opened;
            return repairOrders.recordCost(orderId, dto, fence);
          },
        ),
      ).then(
        (outcome) => ({ outcome }),
        (error: unknown) => ({ error }),
      );
      await holder.reached;
      const holderToken = await tokenOf(REPAIR_ORDER_ENDPOINTS.costs, key);

      // Its lease lapses and a retry takes over and records the line.
      await lapse(REPAIR_ORDER_ENDPOINTS.costs, key);
      const retried = await asActor(manager, () => controller.recordCost(orderId, dto, key));
      expect(await tokenOf(REPAIR_ORDER_ENDPOINTS.costs, key)).not.toBe(holderToken);

      // The holder wakes: both its check on the claim and its response are
      // matched on a token it no longer has.
      holder.open();
      expect(await late).toEqual({ error: expect.objectContaining({ code: 'CONFLICT' }) });

      expect(await costRows(orderId)).toHaveLength(1);
      expect(await eventCount(orderId, 'REPAIR_COST_RECORDED')).toBe(1);
      expect((await totals(orderId)).total).toBe('500000');
      expect(await keyRows(REPAIR_ORDER_ENDPOINTS.costs, key)).toEqual([{ state: 'COMPLETED' }]);
      expect(await asActor(manager, () => controller.recordCost(orderId, dto, key))).toEqual(
        retried,
      );
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
        () => controller.recordCost(orderId, charge({ amountMinor: past }), id('KEY')),
        () =>
          controller.recordPart(orderId, part({ unitCostMinor: past, quantity: '1' }), id('KEY')),
        () =>
          controller.recordLabour(
            orderId,
            labour({ hourlyRateMinor: past, hours: '1' }),
            id('KEY'),
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
          controller.recordPart(orderId, part({ quantity: '2', unitCostMinor: half }), id('KEY')),
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
            id('KEY'),
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
        controller.recordPart(orderId, part({ quantity: '1', unitCostMinor: MAX }), id('KEY')),
      );
      expect((await totals(orderId)).total).toBe(MAX);
    });

    it('refuses the request’s total across referrals: a withdrawn order’s cost still counts', async () => {
      const first = await order();
      await asActor(manager, () =>
        controller.recordCost(first.orderId, charge({ amountMinor: MAX }), id('KEY')),
      );
      await asActor(manager, () =>
        controller.cancel(first.orderId, { reason: 'تعمیرگاه نپذیرفت' }, id('KEY')),
      );
      // The request stays open and is referred again; the first order's cost is kept.
      const second = await asActor(manager, () =>
        repairOrders.assign(first.requestId, { workshopOrganizationId: workshop }),
      );

      // 1 on the new order is fine for it, but the request would hold MAX + 1.
      await expect(
        asActor(manager, () =>
          controller.recordCost(second.id, charge({ amountMinor: '1' }), id('KEY')),
        ),
      ).rejects.toMatchObject({
        internalContext: expect.objectContaining({ rule: 'COST_TOTAL_TOO_LARGE' }),
      });
      expect(await costRows(second.id)).toEqual([]);
      expect((await totals(first.orderId)).request_total).toBe(MAX);
    });
  });
});
