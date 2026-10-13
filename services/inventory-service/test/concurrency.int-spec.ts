import { ulid } from 'ulid';
import type { PrismaClient } from '../src/generated/prisma';
import { StockRepository } from '../src/stock/stock.repository';
import { client, orgAdmin, seedStock, startApi, type ApiHarness } from './api-helpers';
import {
  cleanup,
  expectReconciled,
  newOrganizationId,
  newProductId,
  reconcile,
  runtimeClient,
} from './helpers';

/**
 * Concurrency on real PostgreSQL — the acceptance evidence for "reservation with locking; stock
 * movement" (`docs/17` § 17.2, ADR-056 § 3 and plan steps 4 and 5). Every number here is exact,
 * never "roughly right":
 *
 *   - N parallel reservations on M available units → exactly M succeed, N − M are refused, and
 *     available never goes below zero;
 *   - parallel receipts → the exact sum, no lost update, one stock item;
 *   - multi-line reservations in opposite line orders, again and again → zero deadlocks;
 *   - a mixed storm of every command and expiry → every balance equals the sum of its ledger and
 *     reserved equals the sum of its ACTIVE reservations;
 *   - a command behind a held stock item waits at most INVENTORY_LOCK_TIMEOUT_MS.
 *
 * Through the real HTTP application, so the claim, the transaction, the locks and the error
 * mapping are the ones a client meets.
 */
describe('concurrency (ADR-056 § 3)', () => {
  let api: ApiHarness;
  let raw: PrismaClient;
  const organizations: string[] = [];

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  const deadlocks = async (): Promise<number> => {
    const rows = await raw.$queryRaw<{ deadlocks: bigint }[]>`
      SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`;
    return Number(rows[0]?.deadlocks ?? 0);
  };

  beforeAll(async () => {
    api = await startApi();
    raw = runtimeClient();
  });

  afterAll(async () => {
    await cleanup(organizations);
    await raw.$disconnect();
    await api.close();
  });

  it('N = 50 parallel 1-unit reservations on M = 10 available: exactly 10 succeed, 40 are refused, available never negative', async () => {
    const a = org();
    const { stockItemId } = await seedStock(api, a, 10);
    const owner = client(api, orgAdmin(a));

    let sampling = true;
    const seen: number[] = [];
    const sampler = (async () => {
      while (sampling) {
        const rows = await raw.$queryRaw<{ available: number }[]>`
          SELECT "available_quantity" AS available FROM "stock_item" WHERE "id" = ${stockItemId}`;
        seen.push(rows[0]?.available ?? Number.NaN);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();

    let responses: Awaited<ReturnType<typeof owner.reserve>>[];
    try {
      responses = await Promise.all(
        Array.from({ length: 50 }, () => owner.reserve([{ stockItemId, quantity: 1 }])),
      );
    } finally {
      sampling = false;
      await sampler;
    }

    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(10);
    expect(statuses.filter((status) => status === 422)).toHaveLength(40);
    for (const refused of responses.filter((response) => response.status === 422)) {
      expect(refused.body.details).toEqual([
        expect.objectContaining({ code: 'INSUFFICIENT_AVAILABLE_STOCK' }),
      ]);
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((available) => available >= 0)).toBe(true);

    const item = (await owner.stockItem(stockItemId)).body;
    expect(item).toMatchObject({ onHandQuantity: 10, reservedQuantity: 10, availableQuantity: 0 });
    expect(item.version).toBe(11);
    await expectReconciled(raw, [a]);
  });

  it('20 parallel receipts of one product, the first creating its stock item: the exact sum, one item, twenty positions', async () => {
    const a = org();
    const owner = client(api, orgAdmin(a));
    const warehouseId = (await owner.createWarehouse()).body.id as string;
    const productId = newProductId();

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, index) => owner.receive(warehouseId, index + 1, productId)),
    );

    expect(responses.map((response) => response.status)).toEqual(Array(20).fill(201));
    const ids = new Set(responses.map((response) => response.body.stockItem.id as string));
    expect(ids.size).toBe(1);
    const [stockItemId] = [...ids] as [string];
    const item = (await owner.stockItem(stockItemId)).body;
    expect(item).toMatchObject({ onHandQuantity: 210, reservedQuantity: 0, version: 20 });
    // Every receipt reported the balance it left, each a different position.
    expect(
      responses
        .map((response) => response.body.movement.itemVersion as number)
        .sort((x, y) => x - y),
    ).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    await expectReconciled(raw, [a]);
  });

  it('moves a stock item for a command whose transaction began before the item existed (found by CI)', async () => {
    // The race behind it: two first receipts of one product begin in one order, the later one
    // creates the stock item, and the earlier one — waiting on it — moves it with an instant
    // older than its creation. Reproduced exactly: a movement at an instant before `created_at`.
    const a = org();
    const { stockItemId } = await seedStock(api, a, 5);
    const stock = api.app.get(StockRepository);
    const [{ createdAt }] = await raw.$queryRaw<{ createdAt: Date }[]>`
      SELECT "created_at" AS "createdAt" FROM "stock_item" WHERE "id" = ${stockItemId}`;
    const before = new Date(createdAt.getTime() - 5_000);

    await api.prisma.transaction(async (tx) => {
      const item = await stock.lock(tx, a, stockItemId);
      const moved = await stock.move(tx, item!, { onHand: 1, reserved: 0 }, 'USR-TEST', before);
      expect(moved.updatedAt.getTime()).toBeGreaterThanOrEqual(createdAt.getTime());
      await stock.insertMovement(tx, {
        id: `SMV_${ulid()}`,
        item: moved,
        type: 'RECEIPT',
        onHandDelta: 1,
        reservedDelta: 0,
        reservationId: null,
        sourceReference: null,
        commandKeyHash: 'b'.repeat(64),
        correlationId: 'corr-early',
        actor: 'USR-TEST',
        at: before,
      });
    });
    expect((await client(api, orgAdmin(a)).stockItem(stockItemId)).body.onHandQuantity).toBe(6);
    await expectReconciled(raw, [a]);
  });

  it('two-line reservations in opposite line orders, 200 times over: every one succeeds and PostgreSQL records no deadlock', async () => {
    const a = org();
    const first = await seedStock(api, a, 1000);
    const second = await seedStock(api, a, 1000, { warehouseId: first.warehouseId });
    const owner = client(api, orgAdmin(a));
    const before = await deadlocks();

    const statuses: number[] = [];
    for (let round = 0; round < 200; round += 1) {
      const pair = await Promise.all([
        owner.reserve([
          { stockItemId: first.stockItemId, quantity: 1 },
          { stockItemId: second.stockItemId, quantity: 2 },
        ]),
        owner.reserve([
          { stockItemId: second.stockItemId, quantity: 1 },
          { stockItemId: first.stockItemId, quantity: 2 },
        ]),
      ]);
      statuses.push(...pair.map((response) => response.status));
    }

    expect(statuses.filter((status) => status !== 201)).toEqual([]);
    expect(await deadlocks()).toBe(before);
    for (const id of [first.stockItemId, second.stockItemId]) {
      expect((await owner.stockItem(id)).body).toMatchObject({
        onHandQuantity: 1000,
        reservedQuantity: 600,
        availableQuantity: 400,
      });
    }
    await expectReconciled(raw, [a]);
  });

  it('a mixed storm of receipts, adjustments, reservations, releases, issues and expiries reconciles: every balance is its ledger', async () => {
    const a = org();
    const owner = client(api, orgAdmin(a));
    const warehouseId = (await owner.createWarehouse()).body.id as string;
    const items: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      items.push((await seedStock(api, a, 40, { warehouseId })).stockItemId);
    }
    const pick = (n: number) => items[n % items.length] as string;
    const soon = () => new Date(Date.now() + 1500).toISOString();

    // Wave 1: reservations (some expiring), receipts and adjustments, all at once.
    const wave1 = await Promise.all(
      Array.from({ length: 60 }, (_, n) => {
        switch (n % 5) {
          case 0:
            return owner.reserve([{ stockItemId: pick(n), quantity: 3 }]);
          case 1:
            return owner.reserve([{ stockItemId: pick(n), quantity: 2 }], { expiresAt: soon() });
          case 2:
            return owner.reserve([
              { stockItemId: pick(n), quantity: 1 },
              { stockItemId: pick(n + 1), quantity: 1 },
            ]);
          case 3:
            return owner.post('/v1/stock/receipts', {
              warehouseId,
              productId: newProductId(),
              quantity: 5,
            });
          default:
            return owner.adjust(pick(n), n % 2 === 0 ? 4 : -1);
        }
      }),
    );
    // Each answer is a success or a closed refusal — never a 500, never a deadlock.
    for (const response of wave1) {
      expect([201, 422]).toContain(response.status);
    }
    const reservations = wave1
      .filter((response) => response.status === 201 && response.body.reservations)
      .flatMap((response) => response.body.reservations as { id: string }[]);
    expect(reservations.length).toBeGreaterThan(10);

    // Wave 2: release half, issue the rest, while the short ones expire and more stock arrives.
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const wave2 = await Promise.all([
      ...reservations.map((reservation, n) =>
        n % 2 === 0 ? owner.release(reservation.id) : owner.issue(reservation.id),
      ),
      ...items.map((item) => owner.adjust(item, 3)),
    ]);
    for (const response of wave2) {
      // An expired reservation's end is refused as not ACTIVE; anything else succeeds.
      expect([200, 201, 409]).toContain(response.status);
      if (response.status === 409) {
        expect(response.body.details).toEqual([
          expect.objectContaining({ code: 'RESERVATION_NOT_ACTIVE' }),
        ]);
      }
    }
    const expired = await raw.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "stock_reservation"
       WHERE "organization_id" = ${a} AND "status" = 'EXPIRED'`;
    expect(Number(expired[0]?.n)).toBeGreaterThan(0);

    const reconciled = await expectReconciled(raw, [a]);
    expect(reconciled).toBeGreaterThanOrEqual(items.length);
    for (const row of await reconcile(raw, [a])) {
      expect(row.onHand).toBeGreaterThanOrEqual(row.reserved);
    }
  });

  describe('a command behind a stock item another transaction holds', () => {
    let quick: ApiHarness;

    beforeAll(async () => {
      quick = await startApi({ INVENTORY_LOCK_TIMEOUT_MS: '300' });
    });

    afterAll(async () => {
      await quick.close();
    });

    it('waits at most INVENTORY_LOCK_TIMEOUT_MS, then answers 409 CONFLICT with Retry-After, and the retry succeeds', async () => {
      const a = org();
      const { stockItemId } = await seedStock(api, a, 5);
      const owner = client(quick, orgAdmin(a));

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
      const refused = await owner.reserve([{ stockItemId, quantity: 1 }], {}, 'contended-key-1');
      const waited = Date.now() - startedAt;
      release();
      await holder;

      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('CONFLICT');
      expect(refused.headers['retry-after']).toBe('1');
      expect(waited).toBeLessThan(5_000);

      // Nothing was claimed for good: the same key, retried, now reserves.
      const retried = await owner.reserve([{ stockItemId, quantity: 1 }], {}, 'contended-key-1');
      expect(retried.status).toBe(201);
      await expectReconciled(raw, [a]);
    });
  });
});
