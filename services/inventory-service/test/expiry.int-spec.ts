import type { PrismaClient } from '../src/generated/prisma';
import { ReservationExpiry } from '../src/reservation/expiry';
import { ReservationRepository } from '../src/reservation/reservation.repository';
import { ReservationSweeper } from '../src/reservation/reservation.sweeper';
import { StockRepository } from '../src/stock/stock.repository';
import { client, orgAdmin, seedStock, startApi, type ApiHarness } from './api-helpers';
import { cleanup, expectReconciled, newOrganizationId, runtimeClient } from './helpers';

/**
 * Reservation expiry (Q-102; ADR-056 plan step 5 asked for the choice): a real transition — an
 * EXPIRED reservation, a RELEASE movement by the service and `STOCK_RELEASED { reason: EXPIRED }`
 * — made by any command that locks the item, or by the sweeper. Never derived on read.
 */
describe('reservation expiry', () => {
  let api: ApiHarness;
  let raw: PrismaClient;
  let sweeper: ReservationSweeper;
  let reservations: ReservationRepository;
  const organizations: string[] = [];

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };
  const inASecond = () => new Date(Date.now() + 1000).toISOString();
  const pastDue = () => new Promise((resolve) => setTimeout(resolve, 1300));
  const releasedEvents = async (organizationId: string) =>
    (
      await raw.outboxMessage.findMany({
        where: { organizationId, eventName: 'STOCK_RELEASED' },
        orderBy: { createdAt: 'asc' },
      })
    ).map((row) => (row.payload as { payload: Record<string, unknown> }).payload);

  beforeAll(async () => {
    api = await startApi();
    raw = runtimeClient();
    reservations = api.app.get(ReservationRepository);
    sweeper = new ReservationSweeper(
      api.prisma,
      reservations,
      api.app.get(StockRepository),
      api.app.get(ReservationExpiry),
      { intervalMs: 60_000, batchSize: 100, lockTimeoutMs: 1000 },
    );
  });

  afterAll(async () => {
    await sweeper.stop();
    await cleanup(organizations);
    await raw.$disconnect();
    await api.close();
  });

  it('the sweeper releases a due reservation nobody touches: EXPIRED, a RELEASE movement, STOCK_RELEASED', async () => {
    const a = org();
    const { stockItemId } = await seedStock(api, a, 5);
    const owner = client(api, orgAdmin(a));
    const id = (await owner.reserve([{ stockItemId, quantity: 2 }], { expiresAt: inASecond() }))
      .body.reservations[0].id as string;
    await pastDue();

    // Still held until something expires it: never derived on read.
    expect((await owner.stockItem(stockItemId)).body.reservedQuantity).toBe(2);
    expect(await reservations.overdueCount()).toBeGreaterThanOrEqual(1);

    const outcome = await sweeper.runOnce();
    expect(outcome.expired).toBeGreaterThanOrEqual(1);
    expect(outcome.failed).toBe(0);

    expect((await owner.get(`/v1/stock/reservations/${id}`)).body).toMatchObject({
      status: 'EXPIRED',
      endedBy: 'inventory-service',
      version: 2,
    });
    expect((await owner.stockItem(stockItemId)).body).toMatchObject({
      onHandQuantity: 5,
      reservedQuantity: 0,
      version: 3,
    });
    const [movement] = (await owner.get(`/v1/stock/movements?stockItemId=${stockItemId}`)).body
      .items;
    expect(movement).toMatchObject({
      type: 'RELEASE',
      reservedDelta: -2,
      reservationId: id,
      createdBy: 'inventory-service',
    });
    expect(await releasedEvents(a)).toEqual([
      expect.objectContaining({
        reservationId: id,
        reason: 'EXPIRED',
        releasedBy: null,
        quantity: 2,
        reservedAfter: 0,
        itemVersion: 3,
      }),
    ]);

    // A second sweep finds nothing left of this owner's.
    await sweeper.runOnce();
    expect(await releasedEvents(a)).toHaveLength(1);
    await expectReconciled(raw, [a]);
  });

  it('a command expires the item’s due reservations first, so it never refuses for stock nobody holds', async () => {
    const a = org();
    const { stockItemId } = await seedStock(api, a, 5);
    const owner = client(api, orgAdmin(a));
    await owner.reserve([{ stockItemId, quantity: 5 }], { expiresAt: inASecond() });
    expect((await owner.reserve([{ stockItemId, quantity: 1 }])).status).toBe(422);
    await pastDue();

    const all = await owner.reserve([{ stockItemId, quantity: 5 }]);
    expect(all.status).toBe(201);
    expect((await owner.stockItem(stockItemId)).body).toMatchObject({
      reservedQuantity: 5,
      availableQuantity: 0,
    });
    expect(await releasedEvents(a)).toEqual([expect.objectContaining({ reason: 'EXPIRED' })]);
    await expectReconciled(raw, [a]);
  });

  it('releasing or issuing a reservation past its time is refused: it expired first (409 RESERVATION_NOT_ACTIVE)', async () => {
    const a = org();
    const { stockItemId } = await seedStock(api, a, 5);
    const owner = client(api, orgAdmin(a));
    const id = (await owner.reserve([{ stockItemId, quantity: 2 }], { expiresAt: inASecond() }))
      .body.reservations[0].id as string;
    await pastDue();

    const issued = await owner.issue(id);
    expect(issued.status).toBe(409);
    expect(issued.body.details).toEqual([
      expect.objectContaining({ code: 'RESERVATION_NOT_ACTIVE' }),
    ]);
    // The refusal rolled the expiry back with it; the sweeper makes it for good.
    await sweeper.runOnce();
    expect((await owner.get(`/v1/stock/reservations/${id}`)).body.status).toBe('EXPIRED');
    expect((await owner.stockItem(stockItemId)).body.onHandQuantity).toBe(5);
    await expectReconciled(raw, [a]);
  });

  it('the sweeper skips a stock item another transaction holds rather than wait for it', async () => {
    const a = org();
    const { stockItemId } = await seedStock(api, a, 5);
    const owner = client(api, orgAdmin(a));
    await owner.reserve([{ stockItemId, quantity: 1 }], { expiresAt: inASecond() });
    await pastDue();

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = raw.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "stock_item" WHERE "id" = ${stockItemId} FOR UPDATE`;
        await held;
      },
      { timeout: 20_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const startedAt = Date.now();
    const outcome = await sweeper.runOnce();
    release();
    await holder;

    expect(outcome.skipped).toBeGreaterThanOrEqual(1);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect((await owner.stockItem(stockItemId)).body.reservedQuantity).toBe(1);
    await sweeper.runOnce();
    expect((await owner.stockItem(stockItemId)).body.reservedQuantity).toBe(0);
  });

  it('a reservation without expiresAt never expires (no default lifetime, Q-102)', async () => {
    const a = org();
    const { stockItemId } = await seedStock(api, a, 5);
    const owner = client(api, orgAdmin(a));
    const id = (await owner.reserve([{ stockItemId, quantity: 1 }])).body.reservations[0].id;
    await sweeper.runOnce();
    expect((await owner.get(`/v1/stock/reservations/${id}`)).body).toMatchObject({
      status: 'ACTIVE',
      expiresAt: null,
    });
  });
});
