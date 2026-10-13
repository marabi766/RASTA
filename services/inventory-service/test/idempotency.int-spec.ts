import type { PrismaClient } from '../src/generated/prisma';
import { PrismaClient as Owner } from '../src/generated/prisma';
import { IdempotencyStore, hashRequest } from '../src/shared/idempotency';
import { actor, client, key, orgAdmin, seedStock, startApi, type ApiHarness } from './api-helpers';
import {
  cleanup,
  expectReconciled,
  newOrganizationId,
  ownerDatabaseUrl,
  runtimeClient,
} from './helpers';

/**
 * Idempotent commands (docs/06 § 6.8; ADR-056 plan step 4): one key, one effect — the same
 * request replays the first answer and moves nothing again; another request under the key is
 * refused; concurrent duplicates make one effect; and a key whose record has expired still cannot
 * apply its command a second time (the `command_key_hash` backstop).
 */
describe('idempotent stock commands', () => {
  let api: ApiHarness;
  let raw: PrismaClient;
  const organizations: string[] = [];

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };
  const movementsOf = async (stockItemId: string) =>
    Number(
      (
        await raw.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM "stock_movement" WHERE "stock_item_id" = ${stockItemId}`
      )[0]?.n,
    );

  beforeAll(async () => {
    api = await startApi();
    raw = runtimeClient();
  });

  afterAll(async () => {
    await cleanup(organizations);
    await raw.$disconnect();
    await api.close();
  });

  it('replays the same request’s answer and moves nothing again', async () => {
    const a = org();
    const { stockItemId, warehouseId, productId } = await seedStock(api, a, 5);
    const owner = client(api, orgAdmin(a));
    const k = key();

    const first = await owner.receive(warehouseId, 3, productId, k);
    const again = await owner.receive(warehouseId, 3, productId, k);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect((await owner.stockItem(stockItemId)).body.onHandQuantity).toBe(8);
    expect(await movementsOf(stockItemId)).toBe(2);

    const reserveKey = key();
    const reserved = await owner.reserve([{ stockItemId, quantity: 2 }], {}, reserveKey);
    const replayed = await owner.reserve([{ stockItemId, quantity: 2 }], {}, reserveKey);
    expect(replayed.body).toEqual(reserved.body);
    expect((await owner.stockItem(stockItemId)).body.reservedQuantity).toBe(2);
  });

  it('refuses the same key with another request (409 IDEMPOTENCY_KEY_REUSED)', async () => {
    const a = org();
    const { stockItemId } = await seedStock(api, a, 5);
    const owner = client(api, orgAdmin(a));
    const k = key();
    expect((await owner.adjust(stockItemId, 1, k)).status).toBe(201);
    const other = await owner.adjust(stockItemId, 2, k);
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await owner.stockItem(stockItemId)).body.onHandQuantity).toBe(6);
  });

  it('makes one effect of ten concurrent duplicates', async () => {
    const a = org();
    const { stockItemId } = await seedStock(api, a, 20);
    const owner = client(api, orgAdmin(a));
    const k = key();

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => owner.reserve([{ stockItemId, quantity: 3 }], {}, k)),
    );
    const succeeded = responses.filter((response) => response.status === 201);
    // Each duplicate either waited for the first and replayed its answer, or was told to retry.
    for (const response of responses) expect([201, 409]).toContain(response.status);
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    const ids = new Set(succeeded.map((response) => response.body.reservations[0].id));
    expect(ids.size).toBe(1);
    expect((await owner.stockItem(stockItemId)).body.reservedQuantity).toBe(3);
    await expectReconciled(raw, [a]);
  });

  it('never applies a key twice, even after its record expired (the domain backstop)', async () => {
    const a = org();
    const { stockItemId } = await seedStock(api, a, 5);
    const owner = client(api, orgAdmin(a));
    const k = key();
    expect((await owner.adjust(stockItemId, 1, k)).status).toBe(201);

    // The 24-hour record is gone, as the upkeep timer removes it.
    const store = new Owner({ datasources: { db: { url: ownerDatabaseUrl() } } });
    try {
      await store.idempotencyKey.deleteMany({ where: { organizationId: a } });
    } finally {
      await store.$disconnect();
    }

    const late = await owner.adjust(stockItemId, 1, k);
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await owner.stockItem(stockItemId)).body.onHandQuantity).toBe(6);
    expect(await movementsOf(stockItemId)).toBe(2);
  });

  it('frees the key of a refused command, so the corrected retry runs', async () => {
    const a = org();
    const { stockItemId, warehouseId, productId } = await seedStock(api, a, 1);
    const owner = client(api, orgAdmin(a));
    const k = key();
    expect((await owner.reserve([{ stockItemId, quantity: 3 }], {}, k)).status).toBe(422);
    await owner.receive(warehouseId, 5, productId);
    expect((await owner.reserve([{ stockItemId, quantity: 3 }], {}, k)).status).toBe(201);
  });

  describe('a claim another request left behind', () => {
    const userId = 'USR-IDEM-HOLDER1';
    const asUser = (organizationId: string) =>
      client(api, actor(organizationId, ['ORGANIZATION_ADMIN'], { rastaUserId: userId }));

    async function plant(
      organizationId: string,
      endpoint: string,
      k: string,
      body: unknown,
      expiresAt: Date,
    ): Promise<void> {
      const store = new Owner({ datasources: { db: { url: ownerDatabaseUrl() } } });
      try {
        await store.idempotencyKey.create({
          data: {
            organizationId,
            endpoint,
            key: k,
            requestHash: hashRequest({ caller: userId, body }),
            claimToken: `planted-${key()}`,
            state: 'IN_PROGRESS',
            expiresAt,
          },
        });
      } finally {
        await store.$disconnect();
      }
    }

    it('is taken over once its lease has lapsed', async () => {
      const a = org();
      const { stockItemId } = await seedStock(api, a, 5);
      const k = key();
      const body = { stockItemId, quantityDelta: 2 };
      await plant(a, 'POST /v1/stock/adjustments', k, body, new Date(Date.now() - 1000));
      const taken = await asUser(a).adjust(stockItemId, 2, k);
      expect(taken.status).toBe(201);
      expect(taken.body.stockItem.onHandQuantity).toBe(7);
    });

    it('is waited for while live, then answered 409 CONFLICT with Retry-After', async () => {
      const a = org();
      const { stockItemId } = await seedStock(api, a, 5);
      const k = key();
      const body = { stockItemId, quantityDelta: 2 };
      await plant(a, 'POST /v1/stock/adjustments', k, body, new Date(Date.now() + 60_000));
      const waiting = await asUser(a).adjust(stockItemId, 2, k);
      expect(waiting.status).toBe(409);
      expect(waiting.body.code).toBe('CONFLICT');
      expect(waiting.headers['retry-after']).toBe('1');
      expect((await asUser(a).stockItem(stockItemId)).body.onHandQuantity).toBe(5);
    });
  });

  it('purges expired records by age alone', async () => {
    const a = org();
    const { stockItemId } = await seedStock(api, a, 1);
    await client(api, orgAdmin(a)).adjust(stockItemId, 1);
    const store = new Owner({ datasources: { db: { url: ownerDatabaseUrl() } } });
    try {
      await store.idempotencyKey.updateMany({
        where: { organizationId: a },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
    } finally {
      await store.$disconnect();
    }
    expect(await api.app.get(IdempotencyStore).purgeExpired()).toBeGreaterThanOrEqual(2);
    expect(await raw.idempotencyKey.count({ where: { organizationId: a } })).toBe(0);
  });

  it('keeps the same key of two organizations apart', async () => {
    const a = org();
    const b = org();
    const one = await seedStock(api, a, 1);
    const two = await seedStock(api, b, 1);
    const k = key();
    expect((await client(api, orgAdmin(a)).adjust(one.stockItemId, 1, k)).status).toBe(201);
    expect((await client(api, orgAdmin(b)).adjust(two.stockItemId, 1, k)).status).toBe(201);
  });

  it('stores no raw key in a domain table or an event (S-09)', async () => {
    const a = org();
    const { stockItemId } = await seedStock(api, a, 2);
    const k = `visible-${key()}`;
    await client(api, orgAdmin(a)).reserve([{ stockItemId, quantity: 1 }], {}, k);
    const leaks = await raw.$queryRaw<{ n: bigint }[]>`
      SELECT (SELECT count(*) FROM "stock_movement" m WHERE m::text LIKE ${`%${k}%`})
           + (SELECT count(*) FROM "stock_reservation" r WHERE r::text LIKE ${`%${k}%`})
           + (SELECT count(*) FROM "outbox_message" o WHERE o::text LIKE ${`%${k}%`}) AS n`;
    expect(Number(leaks[0]?.n)).toBe(0);
  });
});
