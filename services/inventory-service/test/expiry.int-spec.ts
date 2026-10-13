import { createSystemContext, runWithContext } from '@rasta/nest-common';
import { ulid } from 'ulid';
import type { PrismaClient } from '../src/generated/prisma';
import { ID_PREFIX, newId } from '../src/events/publisher';
import { ReservationExpiry } from '../src/reservation/expiry';
import { ReservationRepository } from '../src/reservation/reservation.repository';
import { ReservationSweeper } from '../src/reservation/reservation.sweeper';
import { transactionNow } from '../src/shared/clock';
import { commandKeyHash } from '../src/shared/command';
import { StockRepository, type StockItemRow } from '../src/stock/stock.repository';
import { actor, client, key, orgAdmin, seedStock, startApi, type ApiHarness } from './api-helpers';
import { cleanup, expectReconciled, newOrganizationId, runtimeClient } from './helpers';

/** INVENTORY_RESERVATION_EXPIRY_BATCH_SIZE for this suite: small, so a backlog is cheap to build. */
const BATCH = 10;

/** The envelope's actor of every expiry, on the command path and the sweeper's alike. */
const SERVICE_ACTOR = { type: 'SERVICE', id: 'inventory-service' };

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
  interface Envelope {
    eventName: string;
    correlationId: string;
    actor?: { type: string; id: string };
    payload: Record<string, unknown>;
  }
  const envelopes = async (organizationId: string, eventName?: string) =>
    (
      await raw.outboxMessage.findMany({
        where: { organizationId, ...(eventName === undefined ? {} : { eventName }) },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
    ).map((row) => row.payload as unknown as Envelope);
  const releasedEvents = async (organizationId: string) =>
    (await envelopes(organizationId, 'STOCK_RELEASED')).map((envelope) => envelope.payload);
  const activeCount = (stockItemId: string) =>
    raw.stockReservation.count({ where: { stockItemId, status: 'ACTIVE' } });

  /**
   * `count` reservations of one unit on a stock item, due within a second — written as the
   * service writes them (balance, reservation, RESERVE movement), in one transaction: a backlog
   * no sequence of API calls builds quickly. Returns their ids, oldest first.
   */
  async function plantDue(
    organizationId: string,
    stockItemId: string,
    count: number,
  ): Promise<string[]> {
    const stock = api.app.get(StockRepository);
    const ids: string[] = [];
    await runWithContext(createSystemContext({ correlationId: ulid(), organizationId }), () =>
      api.prisma.transaction(
        async (tx) => {
          const at = await transactionNow(tx);
          const expiresAt = new Date(at.getTime() + 1000);
          let item = (await stock.lock(tx, organizationId, stockItemId)) as StockItemRow;
          for (let i = 0; i < count; i += 1) {
            item = await stock.move(tx, item, { onHand: 0, reserved: 1 }, 'USR-BACKLOG', at);
            const keyHash = commandKeyHash('plant', ulid());
            const reservation = await reservations.insert(tx, {
              id: newId(ID_PREFIX.reservation),
              organizationId,
              warehouseId: item.warehouseId,
              stockItemId,
              holderOrganizationId: organizationId,
              orderReference: null,
              quantity: 1,
              expiresAt,
              commandKeyHash: keyHash,
              actor: 'USR-BACKLOG',
              correlationId: 'plant',
              at,
            });
            await stock.insertMovement(tx, {
              id: newId(ID_PREFIX.movement),
              item,
              type: 'RESERVE',
              onHandDelta: 0,
              reservedDelta: 1,
              reservationId: reservation.id,
              sourceReference: null,
              commandKeyHash: keyHash,
              correlationId: 'plant',
              actor: 'USR-BACKLOG',
              at,
            });
            ids.push(reservation.id);
          }
        },
        { timeoutMs: 120_000, maxWaitMs: 10_000 },
      ),
    );
    return ids;
  }

  beforeAll(async () => {
    api = await startApi({ INVENTORY_RESERVATION_EXPIRY_BATCH_SIZE: String(BATCH) });
    raw = runtimeClient();
    reservations = api.app.get(ReservationRepository);
    sweeper = new ReservationSweeper(reservations, api.app.get(ReservationExpiry), {
      intervalMs: 60_000,
      batchSize: 100,
    });
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
    // The audit actor is the service, as the payload says.
    expect((await envelopes(a, 'STOCK_RELEASED'))[0]?.actor).toEqual(SERVICE_ACTOR);

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

  it('records an expiry a person’s command made as the service’s act, in that command’s correlation', async () => {
    const a = org();
    const { stockItemId } = await seedStock(api, a, 5);
    const userId = 'USR-EXPIRY-CALLER1';
    const person = client(api, actor(a, ['ORGANIZATION_ADMIN'], { rastaUserId: userId }));
    await person.reserve([{ stockItemId, quantity: 2 }], { expiresAt: inASecond() });
    await pastDue();

    expect((await person.reserve([{ stockItemId, quantity: 1 }])).status).toBe(201);
    const [expired] = await envelopes(a, 'STOCK_RELEASED');
    const reserved = (await envelopes(a, 'STOCK_RESERVED')).at(-1);
    expect(expired?.payload).toMatchObject({ reason: 'EXPIRED', releasedBy: null });
    // Not the person whose command happened to lock the item: the service.
    expect(expired?.actor).toEqual(SERVICE_ACTOR);
    // The command's own event is still the person's, and both share its correlation.
    expect(reserved?.actor).toEqual({ type: 'USER', id: userId });
    expect(expired?.correlationId).toBe(reserved?.correlationId);
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

  /**
   * Codex round 1, finding 1: expiring every due reservation of an item in one transaction grew
   * with the backlog until it outlived its budget, rolled back, and was repeated — and rolled back
   * — by every later command on the item and every sweep. A batch, committed, never the backlog.
   */
  describe('a backlog larger than a batch', () => {
    it('is worked off in committed batches: one transaction expires a batch, and keeps it', async () => {
      const a = org();
      const backlog = 25 * BATCH;
      const { stockItemId } = await seedStock(api, a, backlog);
      await plantDue(a, stockItemId, backlog);
      await pastDue();

      const expiry = api.app.get(ReservationExpiry);
      const first = await expiry.expireBatch(a, stockItemId, ulid(), 'sweeper');
      expect(first).toMatchObject({ expired: BATCH, backlog: true });
      // Committed: what one batch did stays done, whatever the next one meets.
      expect(await activeCount(stockItemId)).toBe(backlog - BATCH);
      expect((await client(api, orgAdmin(a)).stockItem(stockItemId)).body.reservedQuantity).toBe(
        backlog - BATCH,
      );

      const outcome = await sweeper.runOnce();
      expect(outcome).toMatchObject({ failed: 0, backlogged: 0 });
      expect(outcome.expired).toBeGreaterThanOrEqual(backlog - BATCH);
      expect(await activeCount(stockItemId)).toBe(0);
      const released = await envelopes(a, 'STOCK_RELEASED');
      expect(released).toHaveLength(backlog);
      expect(released.every((envelope) => envelope.actor?.id === SERVICE_ACTOR.id)).toBe(true);
      await expectReconciled(raw, [a]);
    });

    it('lets through a command what is left cannot change — receipt, adjustment, reservation, release, issue', async () => {
      const a = org();
      const { stockItemId, warehouseId, productId } = await seedStock(api, a, 100);
      const owner = client(api, orgAdmin(a));
      const live = (await owner.reserve([{ stockItemId, quantity: 2 }])).body.reservations[0].id;
      const due = await plantDue(a, stockItemId, 6 * BATCH);
      await pastDue();

      expect((await owner.receive(warehouseId, 5, productId)).status).toBe(201);
      expect((await owner.adjust(stockItemId, -10)).status).toBe(201);
      expect((await owner.reserve([{ stockItemId, quantity: 20 }])).status).toBe(201);
      expect((await owner.release(live)).status).toBe(200);
      // Four commands, each one batch: the backlog is smaller, and not gone.
      expect(await activeCount(stockItemId)).toBe(6 * BATCH - 4 * BATCH + 1);

      // A due reservation past every batch so far is expired all the same.
      const last = due.at(-1) as string;
      const issued = await owner.issue(last);
      expect(issued.status).toBe(409);
      expect(issued.body.details).toEqual([
        expect.objectContaining({ code: 'RESERVATION_NOT_ACTIVE' }),
      ]);
      await expectReconciled(raw, [a]);
    });

    it('answers 409 CONFLICT with Retry-After where what is left could change a refusal, and leaves a batch done', async () => {
      const a = org();
      const { stockItemId } = await seedStock(api, a, 3 * BATCH);
      const owner = client(api, orgAdmin(a));
      await plantDue(a, stockItemId, 3 * BATCH);
      await pastDue();
      const k = key();

      // Each attempt expires a batch in its own transaction — rolled back with the 409 — and one
      // committed after it, so every retry finds the backlog a batch smaller.
      const first = await owner.reserve([{ stockItemId, quantity: 25 }], {}, k);
      expect(first.status).toBe(409);
      expect(first.body.code).toBe('CONFLICT');
      expect(first.headers['retry-after']).toBe('1');
      expect(await activeCount(stockItemId)).toBe(2 * BATCH);

      const second = await owner.reserve([{ stockItemId, quantity: 25 }], {}, k);
      expect(second.status).toBe(409);
      expect(await activeCount(stockItemId)).toBe(BATCH);

      const third = await owner.reserve([{ stockItemId, quantity: 25 }], {}, k);
      expect(third.status).toBe(201);
      expect((await owner.stockItem(stockItemId)).body).toMatchObject({
        onHandQuantity: 3 * BATCH,
        reservedQuantity: 25,
      });
      await expectReconciled(raw, [a]);
    });

    it('answers an adjustment below reserved 409 while a backlog could make room, 422 once none is left', async () => {
      const a = org();
      const { stockItemId } = await seedStock(api, a, 3 * BATCH);
      const owner = client(api, orgAdmin(a));
      await plantDue(a, stockItemId, 2 * BATCH + 1);
      await pastDue();

      const contended = await owner.adjust(stockItemId, -(3 * BATCH));
      expect(contended.status).toBe(409);
      expect(contended.headers['retry-after']).toBe('1');
      expect(await activeCount(stockItemId)).toBe(BATCH + 1);

      // One due reservation is left past this one's batch, and the adjustment fits with it counted.
      const fits = await owner.adjust(stockItemId, -(3 * BATCH - 1));
      expect(fits.status).toBe(201);
      expect(await activeCount(stockItemId)).toBe(1);
      // No backlog past the batch: the refusal is sure, and a 422.
      const refused = await owner.adjust(stockItemId, -2);
      expect(refused.status).toBe(422);
      expect(refused.body.details).toEqual([
        expect.objectContaining({ code: 'ON_HAND_WOULD_BE_NEGATIVE' }),
      ]);
      await expectReconciled(raw, [a]);
    });

    /**
     * Codex round 2, finding 1: a refusal no expiry could reverse was a 409 while a backlog was
     * left, retried batch after batch only to end in the 422 it was from the start.
     */
    it('refuses at once, 422, what no expiry could make fit — beyond on hand, below zero — and expires nothing for it', async () => {
      const a = org();
      const { stockItemId } = await seedStock(api, a, 5 * BATCH);
      const owner = client(api, orgAdmin(a));
      await plantDue(a, stockItemId, 5 * BATCH);
      await pastDue();

      const reserve = await owner.reserve([{ stockItemId, quantity: 5 * BATCH + 1 }]);
      expect(reserve.status).toBe(422);
      expect(reserve.headers['retry-after']).toBeUndefined();
      expect(reserve.body.details).toEqual([
        expect.objectContaining({ code: 'INSUFFICIENT_AVAILABLE_STOCK' }),
      ]);
      const adjust = await owner.adjust(stockItemId, -(5 * BATCH + 1));
      expect(adjust.status).toBe(422);
      expect(adjust.headers['retry-after']).toBeUndefined();
      expect(adjust.body.details).toEqual([
        expect.objectContaining({ code: 'ON_HAND_WOULD_BE_NEGATIVE' }),
      ]);
      // Neither waited on the backlog, and neither left a batch of it done.
      expect(await activeCount(stockItemId)).toBe(5 * BATCH);
      expect(await releasedEvents(a)).toHaveLength(0);
      await expectReconciled(raw, [a]);
    });

    it('tells what live reservations hold from what the backlog does: 422 when only the live ones are in the way, 409 when the backlog is', async () => {
      const a = org();
      const { stockItemId, warehouseId } = await seedStock(api, a, 5 * BATCH);
      const other = await seedStock(api, a, BATCH, { warehouseId });
      const owner = client(api, orgAdmin(a));
      // Live: no expiresAt. Due: three batches, so a command's batch always leaves a backlog.
      expect((await owner.reserve([{ stockItemId, quantity: 2 * BATCH }])).status).toBe(201);
      expect((await owner.reserve([{ stockItemId: other.stockItemId, quantity: 5 }])).status).toBe(
        201,
      );
      await plantDue(a, stockItemId, 3 * BATCH);
      await pastDue();
      const live = 2 * BATCH;
      const onHand = 5 * BATCH;

      // Short by one even with every due reservation expired: the live ones hold it.
      const reserve = await owner.reserve([{ stockItemId, quantity: onHand - live + 1 }]);
      expect(reserve.status).toBe(422);
      expect(reserve.body.details).toEqual([
        expect.objectContaining({ code: 'INSUFFICIENT_AVAILABLE_STOCK' }),
      ]);
      const adjust = await owner.adjust(stockItemId, -(onHand - live + 1));
      expect(adjust.status).toBe(422);
      expect(adjust.body.details).toEqual([
        expect.objectContaining({ code: 'ON_HAND_WOULD_BE_NEGATIVE' }),
      ]);
      // One line the backlog could make room for, one nothing could: the reservation is final.
      const mixed = await owner.reserve([
        { stockItemId, quantity: onHand - live },
        { stockItemId: other.stockItemId, quantity: BATCH - 5 + 1 },
      ]);
      expect(mixed.status).toBe(422);
      expect(mixed.body.details).toEqual([
        expect.objectContaining({ code: 'INSUFFICIENT_AVAILABLE_STOCK' }),
      ]);
      expect(mixed.headers['retry-after']).toBeUndefined();
      // The final refusals left the backlog as it was.
      expect(await activeCount(stockItemId)).toBe(1 + 3 * BATCH);

      // Only the backlog in the way: not sure yet, 409 with Retry-After, and a batch left done.
      const contended = await owner.reserve([{ stockItemId, quantity: onHand - live }]);
      expect(contended.status).toBe(409);
      expect(contended.body.code).toBe('CONFLICT');
      expect(contended.headers['retry-after']).toBe('1');
      expect(await activeCount(stockItemId)).toBe(1 + 2 * BATCH);
      const adjustContended = await owner.adjust(stockItemId, -(onHand - live));
      expect(adjustContended.status).toBe(409);
      expect(adjustContended.headers['retry-after']).toBe('1');
      expect(await activeCount(stockItemId)).toBe(1 + BATCH);

      // The backlog gone, the same reservation fits.
      expect((await owner.reserve([{ stockItemId, quantity: onHand - live }])).status).toBe(201);
      await expectReconciled(raw, [a]);
    });
  });
});
