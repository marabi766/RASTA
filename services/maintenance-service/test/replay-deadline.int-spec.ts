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
import { CREATE_REQUEST_ENDPOINT, RequestController } from '../src/maintenance/request.controller';
import { IdempotencyStore, idempotentRequest } from '../src/maintenance/idempotency';
import type { CreateRequestDto } from '../src/maintenance/dto';
import type { ExtendedPrismaClient, PrismaService } from '../src/prisma/prisma.service';
import { asActor, cleanup, id, newPrisma, seedAsset, tenants } from './helpers';

/**
 * The replay fence (FU-171, PM decision D-133; #844's pattern with PR-844 r1 F1 and F2 closed), against
 * real PostgreSQL behind a real HTTP stack: every keyed command reads `Idempotency-Replay-Deadline`
 * through the one store, and a request past it — or asking for more than the retention can keep — is
 * refused before anything is executed. A cost line is the probe: nothing but the key's record stands
 * between a delayed retry and a second charge on the bill.
 */
const DEADLINE = 'idempotency-replay-deadline';
/** B with the default skew: 2 · 30 s + 7 s. */
const BUDGET_MS = 67_000;
/** The default retention (MAINTENANCE_IDEMPOTENCY_TTL_HOURS = 24). */
const TTL_MS = 24 * 3_600_000;
const ENV = {
  MAINTENANCE_IDEMPOTENCY_TTL_HOURS: 24,
  MAINTENANCE_IDEMPOTENCY_CLAIM_LEASE_SECONDS: 120,
  MAINTENANCE_CLOCK_SKEW_SECONDS: 30,
};
const CHARGE = {
  category: 'SERVICE',
  amountMinor: '500000',
  currency: 'IRR',
  description: 'ایاب و ذهاب',
};
const USER = 'USR-ITEST-REPLAY';

const waitUntilPast = async (instantMs: number) => {
  while (Date.now() <= instantMs) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(5, instantMs - Date.now() + 5)));
  }
};

const gate = () => {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
};

describe('Idempotency-Replay-Deadline', () => {
  let prisma: PrismaService;
  let requests: RequestService;
  let repairOrders: RepairOrderService;
  let store: IdempotencyStore;
  let http: INestApplication;
  const org = tenants();
  /** Whom the HTTP stack's middleware acts for. */
  let callerOrganization = org.a;
  const actor = () => ({ organizationId: org.a, userId: USER });

  /** A store on the real database, whose database clock the test sets. */
  class ClockedStore extends IdempotencyStore {
    constructor(private readonly reading: (db: ExtendedPrismaClient) => Promise<Date>) {
      super(prisma, ENV);
    }
    protected override readDatabaseClock(db: ExtendedPrismaClient): Promise<Date> {
      return this.reading(db);
    }
  }

  beforeAll(async () => {
    prisma = newPrisma();
    const repository = new MaintenanceRepository(prisma);
    requests = new RequestService(repository);
    repairOrders = new RepairOrderService(repository, new UnverifiedWorkshopDirectory());
    store = new IdempotencyStore(prisma, ENV);

    const withCaller = (_req: unknown, _res: unknown, next: () => void) => {
      runWithContext(
        {
          correlationId: id('itest-C'),
          requestId: id('itest-R'),
          organizationId: callerOrganization,
          userId: USER,
          roles: ['FLEET_MANAGER'],
          organizationIds: [],
          authType: 'USER',
          startedAt: Date.now(),
        },
        () => next(),
      );
    };
    @Module({
      controllers: [RepairOrderController, RequestController],
      providers: [
        { provide: RequestService, useValue: requests },
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

  afterEach(() => {
    callerOrganization = org.a;
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await http?.close();
    await cleanup(prisma, [org.a, org.b]);
    await prisma.stop();
  });

  const machine = async () => {
    const assetId = id('AST');
    await seedAsset(prisma, assetId, org.a);
    return assetId;
  };
  const breakdown = (assetId: string): CreateRequestDto => ({
    assetId,
    type: 'CORRECTIVE',
    severity: 'HIGH',
    title: 'نشتی روغن',
  });
  const anOrder = async () => {
    const created = await asActor(actor(), async () => requests.create(breakdown(await machine())));
    const referred = await asActor(actor(), () =>
      repairOrders.assign(created.id, { workshopOrganizationId: 'ORG-ITEST-WORKSHOP' }),
    );
    return referred.id;
  };
  const post = (path: string, body: object, key?: string, deadline?: number | string) => {
    let call = request(http.getHttpServer()).post(path);
    if (key !== undefined) call = call.set('Idempotency-Key', key);
    if (deadline !== undefined) call = call.set(DEADLINE, String(deadline));
    return call.send(body);
  };
  const costsPath = (orderId: string) => `/v1/repair-orders/${orderId}/costs`;
  const costCount = async (orderId: string) =>
    (
      await prisma.client.$queryRawUnsafe<{ n: number }[]>(
        'SELECT count(*)::int AS n FROM maintenance_cost WHERE repair_order_id = $1',
        orderId,
      )
    )[0]!.n;
  const orderTotal = async (orderId: string) =>
    (
      await prisma.client.$queryRawUnsafe<{ total: string }[]>(
        'SELECT total_cost_minor::text AS total FROM repair_order WHERE id = $1',
        orderId,
      )
    )[0]!.total;
  const costEvents = (orderId: string) =>
    prisma.client.outboxMessage.count({
      where: { aggregateId: orderId, eventName: 'REPAIR_COST_RECORDED' },
    });
  const keyRow = async (key: string) =>
    (
      await prisma.client.$queryRawUnsafe<
        { claim_token: string; expires_at: Date; organization_id: string }[]
      >('SELECT claim_token, expires_at, organization_id FROM idempotency_key WHERE key = $1', key)
    )[0];
  /** The retention elapses: the stored response is reclaimable, as a purge or a takeover finds it. */
  const expire = (key: string) =>
    prisma.client.$executeRawUnsafe(
      `UPDATE idempotency_key SET expires_at = now() - interval '1 second' WHERE key = $1`,
      key,
    );
  const refusal = { status: 409, code: 'REPLAY_WINDOW_CLOSED' };
  const answer = (response: request.Response) => ({
    status: response.status,
    code: response.body.code as unknown,
  });
  const costHeaders = (key: string, deadlineMs: number) => ({
    'idempotency-key': key,
    [DEADLINE]: String(deadlineMs),
  });
  /** A completed response under `key`, whose hash is this actor's for `body`. */
  const completed = (tx: ExtendedPrismaClient, key: string, body: object) =>
    tx.idempotencyKey.create({
      data: {
        organizationId: org.a,
        endpoint: REPAIR_ORDER_ENDPOINTS.costs,
        key,
        requestHash: store.hash(body),
        claimToken: id('TOKEN'),
        state: 'COMPLETED',
        responseStatus: 201,
        responseBody: { id: 'COST_stored' },
        expiresAt: new Date(Date.now() + TTL_MS),
      },
    });

  it('delayed-retry probe: a retry past the retention is refused, never a second cost line', async () => {
    const orderId = await anOrder();
    const key = id('KEY');
    const deadline = Date.now() + 1_500;

    const first = await post(costsPath(orderId), CHARGE, key, deadline);
    expect(first.status).toBe(201);
    const stored = await keyRow(key);
    // Kept at least B past the deadline, whatever the retention.
    expect(stored!.expires_at.getTime()).toBeGreaterThanOrEqual(deadline + BUDGET_MS);
    const total = await orderTotal(orderId);

    await expire(key);
    await waitUntilPast(deadline);

    // The same request, same key, same deadline — delayed before admission.
    const retry = await post(costsPath(orderId), CHARGE, key, deadline);
    expect({ ...answer(retry), costs: await costCount(orderId) }).toEqual({ ...refusal, costs: 1 });
    expect(await orderTotal(orderId)).toBe(total);
    expect(await costEvents(orderId)).toBe(1);
    // Nothing was written by the refused attempt: the old row is untouched.
    expect((await keyRow(key))!.claim_token).toBe(stored!.claim_token);

    // The record gone altogether is no way in either.
    await store.purgeExpired();
    expect(await keyRow(key)).toBeUndefined();
    const afterPurge = await post(costsPath(orderId), CHARGE, key, deadline);
    expect({ ...answer(afterPurge), costs: await costCount(orderId) }).toEqual({
      ...refusal,
      costs: 1,
    });
    expect(await keyRow(key)).toBeUndefined();
  });

  it('D-133: no header, no fence — an expired key is still reusable, for now', async () => {
    const orderId = await anOrder();
    const key = id('KEY');
    expect((await post(costsPath(orderId), CHARGE, key)).status).toBe(201);
    await expire(key);
    expect((await post(costsPath(orderId), CHARGE, key)).status).toBe(201);
    expect(await costCount(orderId)).toBe(2);
  });

  it('admits on the database clock inside the insert’s transaction: past it rolls the claim back; equality is admitted', async () => {
    const orderId = await anOrder();
    const deadline = Date.now() + 60_000;
    const body = { repairOrderId: orderId, ...CHARGE };
    const work = jest.fn();

    // This replica's clock passes the check; the database clock read after the insert does not (a
    // request suspended between the two). The reading must run on the connection holding the insert.
    const lateKey = id('KEY');
    const late = await asActor(actor(), () =>
      new ClockedStore(async (db) => {
        expect(await db.idempotencyKey.count({ where: { key: lateKey } })).toBe(1);
        return new Date(deadline + 1);
      }).execute(
        REPAIR_ORDER_ENDPOINTS.costs,
        idempotentRequest(costHeaders(lateKey, deadline)),
        body,
        201,
        work,
      ),
    ).catch((error: unknown) => error);
    expect(late).toMatchObject({ code: 'REPLAY_WINDOW_CLOSED' });
    expect(work).not.toHaveBeenCalled();
    expect(await keyRow(lateKey)).toBeUndefined();

    // A clock that cannot be read admits nothing: never a fallback to this replica's.
    const unreadableKey = id('KEY');
    await expect(
      asActor(actor(), () =>
        new ClockedStore(async () => new Date(Number.NaN)).execute(
          REPAIR_ORDER_ENDPOINTS.costs,
          idempotentRequest(costHeaders(unreadableKey, deadline)),
          body,
          201,
          work,
        ),
      ),
    ).rejects.toMatchObject({ code: 'REPLAY_WINDOW_CLOSED' });
    expect(work).not.toHaveBeenCalled();
    expect(await keyRow(unreadableKey)).toBeUndefined();

    const onTimeKey = id('KEY');
    const onTime = await asActor(actor(), () =>
      new ClockedStore(async () => new Date(deadline)).claim(
        REPAIR_ORDER_ENDPOINTS.costs,
        onTimeKey,
        body,
        deadline,
      ),
    );
    expect(onTime.kind).toBe('PROCEED');
    expect(await keyRow(onTimeKey)).toBeDefined();
  });

  it('replay, insert wait: a duplicate whose insert waited past its deadline is refused, not answered', async () => {
    const key = id('KEY');
    const body = { repairOrderId: 'RPO-unread', ...CHARGE };
    const release = gate();
    const inserted = gate();
    // An uncommitted row under the same key: the duplicate's insert waits on it for real.
    const holder = asActor(actor(), () =>
      prisma.transaction(
        async (tx) => {
          await completed(tx, key, body);
          inserted.open();
          await release.opened;
        },
        { timeoutMs: 20_000 },
      ),
    );
    await inserted.opened;

    const deadline = Date.now() + 400;
    const work = jest.fn();
    const duplicate = asActor(actor(), () =>
      store.execute(
        REPAIR_ORDER_ENDPOINTS.costs,
        idempotentRequest(costHeaders(key, deadline)),
        body,
        201,
        work,
      ),
    ).catch((error: unknown) => error);
    await waitUntilPast(deadline + 50);
    release.open();
    await holder;

    expect(await duplicate).toMatchObject({ code: 'REPLAY_WINDOW_CLOSED' });
    expect(work).not.toHaveBeenCalled();
  });

  it('replay, read wait: a stored response read past its deadline is refused, the row untouched', async () => {
    const key = id('KEY');
    const body = { repairOrderId: 'RPO-unread', ...CHARGE };
    await asActor(actor(), () =>
      prisma.transaction((tx) => completed(tx, key, body).then(() => undefined)),
    );
    const before = await keyRow(key);

    const deadline = Date.now() + 400;
    // The insert loses at once on this replica's good clock; the read of the row is what stalls.
    const realRows = prisma.client.idempotencyKey;
    const slowClient = new Proxy(prisma.client, {
      get: (target, property) =>
        property === 'idempotencyKey'
          ? {
              findFirst: async (args: Parameters<typeof realRows.findFirst>[0]) => {
                const row = await realRows.findFirst(args);
                await waitUntilPast(deadline + 50);
                return row;
              },
            }
          : Reflect.get(target, property),
    });
    const slowPrisma = {
      client: slowClient,
      transaction: prisma.transaction.bind(prisma),
    } as unknown as PrismaService;

    const work = jest.fn();
    const late = await asActor(actor(), () =>
      new IdempotencyStore(slowPrisma, ENV).execute(
        REPAIR_ORDER_ENDPOINTS.costs,
        idempotentRequest(costHeaders(key, deadline)),
        body,
        201,
        work,
      ),
    ).catch((error: unknown) => error);

    expect(late).toMatchObject({ code: 'REPLAY_WINDOW_CLOSED' });
    expect(work).not.toHaveBeenCalled();
    expect((await keyRow(key))!.claim_token).toBe(before!.claim_token);
  });

  it('past the database clock a late request learns nothing of the row and removes nothing', async () => {
    const deadline = Date.now() + 60_000;
    const body = { repairOrderId: 'RPO-unread', ...CHARGE };
    const late = new ClockedStore(async () => new Date(deadline + 1));
    const attempt = (key: string, sent: object) =>
      asActor(actor(), () =>
        late.execute(
          REPAIR_ORDER_ENDPOINTS.costs,
          idempotentRequest(costHeaders(key, deadline)),
          sent,
          201,
          jest.fn(),
        ),
      ).catch((error: unknown) => error);

    // Another request under the key: not IDEMPOTENCY_KEY_REUSED, which would disclose the key is taken.
    const taken = id('KEY');
    await asActor(actor(), () =>
      prisma.transaction((tx) => completed(tx, taken, body).then(() => undefined)),
    );
    expect(await attempt(taken, { ...body, description: 'another request' })).toMatchObject({
      code: 'REPLAY_WINDOW_CLOSED',
    });

    // A row past its expiry: the refused attempt does not remove it.
    const lapsed = id('KEY');
    await asActor(actor(), () =>
      prisma.transaction((tx) => completed(tx, lapsed, body).then(() => undefined)),
    );
    await expire(lapsed);
    expect(await attempt(lapsed, body)).toMatchObject({ code: 'REPLAY_WINDOW_CLOSED' });
    expect(await keyRow(lapsed)).toBeDefined();
  });

  it('a duplicate polling a holder past its deadline is refused, and the holder still completes', async () => {
    const key = id('KEY');
    const body = { repairOrderId: 'RPO-unread', ...CHARGE };
    const release = gate();
    const locked = gate();
    const holder = asActor(actor(), () =>
      store.execute<{ id: string }>(
        REPAIR_ORDER_ENDPOINTS.costs,
        idempotentRequest({ 'idempotency-key': key }),
        body,
        201,
        (fence) =>
          prisma.transaction(
            async (tx) => {
              await fence.hold(tx);
              locked.open();
              await release.opened;
              return fence.complete(tx, { id: 'COST_first' });
            },
            { timeoutMs: 20_000 },
          ),
      ),
    );
    await locked.opened;

    const deadline = Date.now() + 300;
    const duplicate = asActor(actor(), () =>
      store.execute(
        REPAIR_ORDER_ENDPOINTS.costs,
        idempotentRequest(costHeaders(key, deadline)),
        body,
        201,
        jest.fn(),
      ),
    ).catch((error: unknown) => error);
    await waitUntilPast(deadline + 200);
    release.open();

    expect(await duplicate).toMatchObject({ code: 'REPLAY_WINDOW_CLOSED' });
    expect(await holder).toEqual({ result: { id: 'COST_first' }, executed: true });
  });

  it('a stored response is replayed before its deadline, and not past it', async () => {
    const orderId = await anOrder();
    const key = id('KEY');
    const deadline = Date.now() + 1_500;
    const first = await post(costsPath(orderId), CHARGE, key, deadline);
    expect(first.status).toBe(201);

    const again = await post(costsPath(orderId), CHARGE, key, deadline);
    expect({ status: again.status, id: again.body.id }).toEqual({ status: 201, id: first.body.id });

    await waitUntilPast(deadline);
    expect(answer(await post(costsPath(orderId), CHARGE, key, deadline))).toEqual(refusal);
    expect(await costCount(orderId)).toBe(1);
  });

  it('refuses a deadline later than the retention less B with 400 beyond_retention, nothing read or written; accepts one inside it', async () => {
    const orderId = await anOrder();
    const access = jest.spyOn(repairOrders, 'assertAccessible');
    const refusedKey = id('KEY');

    const tooLate = await post(
      costsPath(orderId),
      CHARGE,
      refusedKey,
      Date.now() + TTL_MS - BUDGET_MS + 60_000,
    );
    expect(tooLate.status).toBe(400);
    expect(tooLate.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: 'Idempotency-Replay-Deadline', code: 'beyond_retention' }],
    });
    expect(access).not.toHaveBeenCalled();
    expect(await keyRow(refusedKey)).toBeUndefined();
    expect(await costCount(orderId)).toBe(0);

    const inside = Date.now() + TTL_MS - BUDGET_MS - 60_000;
    const acceptedKey = id('KEY');
    expect((await post(costsPath(orderId), CHARGE, acceptedKey, inside)).status).toBe(201);
    expect((await keyRow(acceptedKey))!.expires_at.getTime()).toBeGreaterThanOrEqual(
      inside + BUDGET_MS,
    );
  });

  it('keeps a response B past its deadline even when a slower replica completed it', async () => {
    const key = id('KEY');
    // The latest deadline admitted here…
    const deadline = Date.now() + TTL_MS - BUDGET_MS - 1_000;
    await asActor(actor(), () =>
      store.execute<{ id: string }>(
        REPAIR_ORDER_ENDPOINTS.costs,
        idempotentRequest(costHeaders(key, deadline)),
        { repairOrderId: 'RPO-unread', ...CHARGE },
        201,
        (fence) =>
          prisma.transaction(async (tx) => {
            await fence.hold(tx);
            // …completed on a clock 2·skew behind: completion + TTL alone would end before H + B.
            const slower = Date.now() - 60_000;
            const clock = jest.spyOn(Date, 'now').mockReturnValue(slower);
            try {
              return await fence.complete(tx, { id: 'COST_first' });
            } finally {
              clock.mockRestore();
            }
          }),
      ),
    );
    expect((await keyRow(key))!.expires_at.getTime()).toBeGreaterThanOrEqual(deadline + BUDGET_MS);
  });

  it.each([['01700000000000'], ['1.5e12'], ['-1'], ['1, 2'], ['9007199254740993']])(
    'refuses the malformed deadline %s with 400 invalid before any claim',
    async (value) => {
      const orderId = await anOrder();
      const key = id('KEY');
      const response = await post(costsPath(orderId), CHARGE, key, value);
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        details: [{ path: 'Idempotency-Replay-Deadline', code: 'invalid' }],
      });
      expect(await keyRow(key)).toBeUndefined();
    },
  );

  it('the optional key: a deadline with no key is refused, never ignored; neither header is the old path', async () => {
    const assetId = await machine();
    const body = breakdown(assetId);

    const refused = await post('/v1/maintenance-requests', body, undefined, Date.now() + 60_000);
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({
      details: [{ path: 'Idempotency-Key', code: 'required' }],
    });
    const past = await post('/v1/maintenance-requests', body, undefined, Date.now() - 1);
    expect(past.status).toBe(400);
    const malformed = await post('/v1/maintenance-requests', body, undefined, 'soon');
    expect(malformed.body).toMatchObject({
      details: [{ path: 'Idempotency-Replay-Deadline', code: 'invalid' }],
    });
    expect(
      await asActor(actor(), async () =>
        prisma.client.maintenanceRequest.count({ where: { assetId } }),
      ),
    ).toBe(0);

    expect((await post('/v1/maintenance-requests', body)).status).toBe(201);
  });

  it('the optional key: creating a request under a deadline replays, and past it refuses', async () => {
    const assetId = await machine();
    const body = breakdown(assetId);
    const key = id('KEY');
    const deadline = Date.now() + 1_500;
    const first = await post('/v1/maintenance-requests', body, key, deadline);
    expect(first.status).toBe(201);
    const again = await post('/v1/maintenance-requests', body, key, deadline);
    expect(again.body.id).toBe(first.body.id);
    await waitUntilPast(deadline);
    expect(answer(await post('/v1/maintenance-requests', body, key, deadline))).toEqual(refusal);
  });

  it('keeps organizations apart: another organization’s closed deadline touches nothing here', async () => {
    const orderId = await anOrder();
    const key = id('KEY');
    expect((await post(costsPath(orderId), CHARGE, key, Date.now() + 60_000)).status).toBe(201);

    callerOrganization = org.b;
    expect(answer(await post(costsPath(orderId), CHARGE, key, Date.now() - 1))).toEqual(refusal);
    expect((await keyRow(key))!.organization_id).toBe(org.a);
    expect(await costCount(orderId)).toBe(1);

    // And inside its deadline the same key is another organization's own request.
    callerOrganization = org.a;
    const shared = id('KEY');
    const deadline = Date.now() + 60_000;
    const ours = await post(
      '/v1/maintenance-requests',
      breakdown(await machine()),
      shared,
      deadline,
    );
    expect(ours.status).toBe(201);
    callerOrganization = org.b;
    const theirAsset = id('AST');
    await seedAsset(prisma, theirAsset, org.b);
    const theirs = await post('/v1/maintenance-requests', breakdown(theirAsset), shared, deadline);
    expect(theirs.status).toBe(201);
    expect(theirs.body.id).not.toBe(ours.body.id);
  });

  it('is enforced by every keyed command, before the order is read and with no claim', async () => {
    const access = jest.spyOn(repairOrders, 'assertAccessible');
    const orderPath = (verb: string) => `/v1/repair-orders/RPO-does-not-exist/${verb}`;
    const commands: Record<string, [string, object]> = {
      [CREATE_REQUEST_ENDPOINT]: ['/v1/maintenance-requests', breakdown(id('AST'))],
      [REPAIR_ORDER_ENDPOINTS.start]: [orderPath('start'), {}],
      [REPAIR_ORDER_ENDPOINTS.complete]: [orderPath('complete'), { workPerformed: 'تعویض فیلتر' }],
      [REPAIR_ORDER_ENDPOINTS.cancel]: [orderPath('cancel'), { reason: 'کارگاه نپذیرفت' }],
      [REPAIR_ORDER_ENDPOINTS.parts]: [
        orderPath('parts'),
        { partName: 'فیلتر', quantity: '2', unit: 'عدد', unitCostMinor: '250000' },
      ],
      [REPAIR_ORDER_ENDPOINTS.labour]: [
        orderPath('labour'),
        { description: 'تعویض', hours: '1.5', hourlyRateMinor: '800000' },
      ],
      [REPAIR_ORDER_ENDPOINTS.costs]: [orderPath('costs'), CHARGE],
    };
    // The list is the endpoints the store files keys under: a new one cannot stay out of this test.
    expect(Object.keys(commands).sort()).toEqual(
      [CREATE_REQUEST_ENDPOINT, ...Object.values(REPAIR_ORDER_ENDPOINTS)].sort(),
    );

    for (const [command, [path, body]] of Object.entries(commands)) {
      const key = id('KEY');
      const response = await post(path, body, key, Date.now() - 1);
      expect({ command, ...answer(response) }).toEqual({ command, ...refusal });
      expect(await keyRow(key)).toBeUndefined();
    }
    expect(access).not.toHaveBeenCalled();
  });
});
