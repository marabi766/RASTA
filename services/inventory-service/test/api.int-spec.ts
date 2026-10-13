import request from 'supertest';
import {
  actor,
  bearer,
  client,
  internalToken,
  key,
  orgAdmin,
  seedStock,
  startApi,
  type ApiHarness,
} from './api-helpers';
import {
  cleanup,
  expectReconciled,
  newOrderReference,
  newOrganizationId,
  newProductId,
  runtimeClient,
} from './helpers';
import type { PrismaClient } from '../src/generated/prisma';

/**
 * The HTTP surface end to end, as the owner's people use it (ADR-056 § 3): a warehouse, a
 * receipt, a reservation, its release or issue, an adjustment and the ledger — with each closed
 * refusal answered where the documents say.
 */
describe('the inventory API (real application, real PostgreSQL)', () => {
  let api: ApiHarness;
  let raw: PrismaClient;
  const organizations: string[] = [];

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
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

  it('creates a warehouse owned by the organization the request acts for', async () => {
    const a = org();
    const owner = client(api, orgAdmin(a));

    const created = await owner.createWarehouse({
      name: '  Yazd central  ',
      location: { latitude: 31.8974, longitude: 54.3569 },
    });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      organizationId: a,
      name: 'Yazd central',
      location: { latitude: 31.8974, longitude: 54.3569 },
      status: 'ACTIVE',
      version: 1,
    });
    expect(created.body.id).toMatch(/^WHS_[0-9A-Z]{26}$/);

    const read = await owner.get(`/v1/warehouses/${created.body.id}`);
    expect(read.status).toBe(200);
    expect(read.body).toEqual(created.body);

    const listed = await owner.get('/v1/warehouses');
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ items: [created.body], nextCursor: null, hasMore: false });
  });

  it('receives stock, reserves it, releases and issues, adjusts — and the balance is the ledger', async () => {
    const a = org();
    const owner = client(api, orgAdmin(a));
    const warehouse = (await owner.createWarehouse()).body.id as string;
    const productId = newProductId();

    const received = await owner.receive(warehouse, 10, productId);
    expect(received.status).toBe(201);
    expect(received.body.stockItem).toMatchObject({
      organizationId: a,
      warehouseId: warehouse,
      productId,
      onHandQuantity: 10,
      reservedQuantity: 0,
      availableQuantity: 10,
      version: 1,
    });
    expect(received.body.movement).toMatchObject({
      type: 'RECEIPT',
      onHandDelta: 10,
      reservedDelta: 0,
      onHandAfter: 10,
      reservedAfter: 0,
      itemVersion: 1,
      reservationId: null,
    });
    const item = received.body.stockItem.id as string;

    // A second receipt of the same product lands on the same stock item.
    const again = await owner.receive(warehouse, 5, productId);
    expect(again.body.stockItem).toMatchObject({ id: item, onHandQuantity: 15, version: 2 });

    const order = newOrderReference();
    const reserved = await owner.reserve([{ stockItemId: item, quantity: 4 }], {
      orderReference: order,
    });
    expect(reserved.status).toBe(201);
    const [first] = reserved.body.reservations;
    expect(first).toMatchObject({
      stockItemId: item,
      warehouseId: warehouse,
      holderOrganizationId: a,
      orderReference: order,
      quantity: 4,
      status: 'ACTIVE',
      expiresAt: null,
      endedAt: null,
    });
    expect((await owner.stockItem(item)).body).toMatchObject({
      onHandQuantity: 15,
      reservedQuantity: 4,
      availableQuantity: 11,
    });

    const released = await owner.release(first.id);
    expect(released.status).toBe(200);
    expect(released.body).toMatchObject({ id: first.id, status: 'RELEASED', version: 2 });
    expect(released.body.endedAt).not.toBeNull();
    expect((await owner.stockItem(item)).body).toMatchObject({
      onHandQuantity: 15,
      reservedQuantity: 0,
    });

    const second = (await owner.reserve([{ stockItemId: item, quantity: 6 }])).body.reservations[0];
    const issued = await owner.issue(second.id);
    expect(issued.status).toBe(200);
    expect(issued.body).toMatchObject({ status: 'CONSUMED' });
    expect((await owner.stockItem(item)).body).toMatchObject({
      onHandQuantity: 9,
      reservedQuantity: 0,
      availableQuantity: 9,
    });

    const adjusted = await owner.adjust(item, -2);
    expect(adjusted.status).toBe(201);
    expect(adjusted.body.movement).toMatchObject({ type: 'ADJUSTMENT', onHandDelta: -2 });
    expect(adjusted.body.stockItem).toMatchObject({ onHandQuantity: 7, version: 7 });

    // The ledger, newest first: one movement per position, no gap.
    const ledger = await owner.get(`/v1/stock/movements?stockItemId=${item}`);
    expect(ledger.status).toBe(200);
    expect(
      ledger.body.items.map((m: { type: string; itemVersion: number }) => [m.type, m.itemVersion]),
    ).toEqual([
      ['ADJUSTMENT', 7],
      ['ISSUE', 6],
      ['RESERVE', 5],
      ['RELEASE', 4],
      ['RESERVE', 3],
      ['RECEIPT', 2],
      ['RECEIPT', 1],
    ]);
    expect(await expectReconciled(raw, [a])).toBe(1);
  });

  it('pages lists newest first with an opaque cursor', async () => {
    const a = org();
    const owner = client(api, orgAdmin(a));
    const warehouse = (await owner.createWarehouse()).body.id as string;
    for (let i = 0; i < 3; i += 1) await owner.receive(warehouse, 1);

    const page1 = await owner.get(`/v1/stock?warehouseId=${warehouse}&limit=2`);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.hasMore).toBe(true);
    const page2 = await owner.get(
      `/v1/stock?warehouseId=${warehouse}&limit=2&cursor=${page1.body.nextCursor}`,
    );
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it('filters each list by what it names, and pages every one', async () => {
    const a = org();
    const owner = client(api, orgAdmin(a));
    const first = await seedStock(api, a, 5);
    const second = await seedStock(api, a, 5, { warehouseId: first.warehouseId });
    const elsewhere = await seedStock(api, a, 5);
    const kept = (await owner.reserve([{ stockItemId: first.stockItemId, quantity: 1 }])).body
      .reservations[0].id as string;
    const ended = (await owner.reserve([{ stockItemId: second.stockItemId, quantity: 1 }])).body
      .reservations[0].id as string;
    await owner.release(ended);

    const ids = (response: { body: { items: { id: string }[] } }) =>
      response.body.items.map((row) => row.id).sort();

    expect(ids(await owner.get(`/v1/stock?productId=${second.productId}`))).toEqual([
      second.stockItemId,
    ]);
    expect(ids(await owner.get(`/v1/stock?warehouseId=${first.warehouseId}`))).toEqual(
      [first.stockItemId, second.stockItemId].sort(),
    );
    expect(
      (await owner.get(`/v1/stock/movements?warehouseId=${elsewhere.warehouseId}`)).body.items,
    ).toHaveLength(1);
    expect(ids(await owner.get('/v1/stock/reservations?status=ACTIVE'))).toEqual([kept]);
    expect(ids(await owner.get('/v1/stock/reservations?status=RELEASED'))).toEqual([ended]);
    expect(
      ids(await owner.get(`/v1/stock/reservations?stockItemId=${second.stockItemId}`)),
    ).toEqual([ended]);

    const page = await owner.get('/v1/stock/reservations?limit=1');
    expect(page.body.hasMore).toBe(true);
    const rest = await owner.get(`/v1/stock/reservations?limit=1&cursor=${page.body.nextCursor}`);
    expect(rest.body).toMatchObject({ hasMore: false, nextCursor: null });
    const movements = await owner.get('/v1/stock/movements?limit=2');
    const more = await owner.get(
      `/v1/stock/movements?limit=50&cursor=${movements.body.nextCursor}`,
    );
    // Three receipts, two reservations and a release.
    expect(movements.body.items.length + more.body.items.length).toBe(6);

    await owner.createWarehouse();
    const warehouses = await owner.get('/v1/warehouses?limit=1');
    const next = await owner.get(`/v1/warehouses?limit=5&cursor=${warehouses.body.nextCursor}`);
    expect(warehouses.body.items.length + next.body.items.length).toBe(3);
  });

  describe('refusals', () => {
    it('requires an Idempotency-Key on every command (400), and does nothing without one', async () => {
      const a = org();
      const { stockItemId, warehouseId } = await seedStock(api, a, 3);
      const token = orgAdmin(a);
      for (const [path, body] of [
        ['/v1/warehouses', { name: 'x' }],
        ['/v1/stock/receipts', { warehouseId, productId: newProductId(), quantity: 1 }],
        ['/v1/stock/adjustments', { stockItemId, quantityDelta: 1 }],
        ['/v1/stock/reservations', { lines: [{ stockItemId, quantity: 1 }] }],
      ] as const) {
        const response = await request(api.app.getHttpServer())
          .post(path)
          .set('authorization', `Bearer ${token}`)
          .send(body);
        expect([path, response.status, response.body.code]).toEqual([
          path,
          400,
          'VALIDATION_FAILED',
        ]);
      }
      expect((await client(api, token).stockItem(stockItemId)).body).toMatchObject({
        onHandQuantity: 3,
        version: 1,
      });
    });

    it('refuses a reservation beyond available stock, all or nothing (422 INSUFFICIENT_AVAILABLE_STOCK)', async () => {
      const a = org();
      const owner = client(api, orgAdmin(a));
      const first = await seedStock(api, a, 5);
      const second = await seedStock(api, a, 1, { warehouseId: first.warehouseId });

      const refused = await owner.reserve([
        { stockItemId: first.stockItemId, quantity: 5 },
        { stockItemId: second.stockItemId, quantity: 2 },
      ]);
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
        details: [{ path: 'reservation', code: 'INSUFFICIENT_AVAILABLE_STOCK' }],
      });
      // Nothing of the first line was reserved either.
      expect((await owner.stockItem(first.stockItemId)).body.reservedQuantity).toBe(0);
    });

    it('refuses lines of two warehouses (422 LINES_SPAN_WAREHOUSES)', async () => {
      const a = org();
      const one = await seedStock(api, a, 2);
      const other = await seedStock(api, a, 2);
      const refused = await client(api, orgAdmin(a)).reserve([
        { stockItemId: one.stockItemId, quantity: 1 },
        { stockItemId: other.stockItemId, quantity: 1 },
      ]);
      expect(refused.status).toBe(422);
      expect(refused.body.details).toEqual([
        expect.objectContaining({ code: 'LINES_SPAN_WAREHOUSES' }),
      ]);
    });

    it('refuses a holder other than the owner in this version (422 HOLDER_NOT_OWNER, Q-104)', async () => {
      const a = org();
      const { stockItemId } = await seedStock(api, a, 2);
      const refused = await client(api, orgAdmin(a)).reserve([{ stockItemId, quantity: 1 }], {
        holderOrganizationId: newOrganizationId(),
      });
      expect(refused.status).toBe(422);
      expect(refused.body.details).toEqual([expect.objectContaining({ code: 'HOLDER_NOT_OWNER' })]);
      // Naming the owner itself is accepted.
      const accepted = await client(api, orgAdmin(a)).reserve([{ stockItemId, quantity: 1 }], {
        holderOrganizationId: a,
      });
      expect(accepted.status).toBe(201);
    });

    it('refuses an expiry in the past or past the longest allowed (422 EXPIRY_OUT_OF_RANGE, Q-102)', async () => {
      const a = org();
      const { stockItemId } = await seedStock(api, a, 2);
      const owner = client(api, orgAdmin(a));
      for (const expiresAt of [
        new Date(Date.now() - 60_000).toISOString(),
        new Date(Date.now() + 8 * 24 * 3600 * 1000).toISOString(),
      ]) {
        const refused = await owner.reserve([{ stockItemId, quantity: 1 }], { expiresAt });
        expect(refused.status).toBe(422);
        expect(refused.body.details).toEqual([
          expect.objectContaining({ code: 'EXPIRY_OUT_OF_RANGE' }),
        ]);
      }
      const accepted = await owner.reserve([{ stockItemId, quantity: 1 }], {
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      });
      expect(accepted.status).toBe(201);
      expect(accepted.body.reservations[0].expiresAt).not.toBeNull();
    });

    it('refuses an adjustment below what is reserved (422 ON_HAND_WOULD_BE_NEGATIVE)', async () => {
      const a = org();
      const { stockItemId } = await seedStock(api, a, 5);
      const owner = client(api, orgAdmin(a));
      await owner.reserve([{ stockItemId, quantity: 3 }]);
      const refused = await owner.adjust(stockItemId, -3);
      expect(refused.status).toBe(422);
      expect(refused.body.details).toEqual([
        expect.objectContaining({ path: 'stock', code: 'ON_HAND_WOULD_BE_NEGATIVE' }),
      ]);
      expect((await owner.adjust(stockItemId, -2)).status).toBe(201);
    });

    it('refuses a balance past the largest quantity stored (422 QUANTITY_OUT_OF_RANGE)', async () => {
      const a = org();
      const { stockItemId, warehouseId, productId } = await seedStock(api, a, 2_147_483_000);
      const owner = client(api, orgAdmin(a));
      const refused = await owner.receive(warehouseId, 1000, productId);
      expect(refused.status).toBe(422);
      expect(refused.body.details).toEqual([
        expect.objectContaining({ code: 'QUANTITY_OUT_OF_RANGE' }),
      ]);
      expect((await owner.adjust(stockItemId, 1000)).status).toBe(422);
    });

    it('refuses to end a reservation twice (409 INVALID_STATE_TRANSITION, RESERVATION_NOT_ACTIVE)', async () => {
      const a = org();
      const { stockItemId } = await seedStock(api, a, 2);
      const owner = client(api, orgAdmin(a));
      const reservation = (await owner.reserve([{ stockItemId, quantity: 1 }])).body
        .reservations[0];
      expect((await owner.issue(reservation.id)).status).toBe(200);
      for (const again of [
        await owner.issue(reservation.id),
        await owner.release(reservation.id),
      ]) {
        expect(again.status).toBe(409);
        expect(again.body).toMatchObject({
          code: 'INVALID_STATE_TRANSITION',
          details: [{ path: 'reservation', code: 'RESERVATION_NOT_ACTIVE' }],
        });
      }
    });

    it('refuses a stale expectedVersion (409 OPTIMISTIC_LOCK_FAILED)', async () => {
      const a = org();
      const { stockItemId } = await seedStock(api, a, 2);
      const owner = client(api, orgAdmin(a));
      const reservation = (await owner.reserve([{ stockItemId, quantity: 1 }])).body
        .reservations[0];
      const stale = await owner.post(`/v1/stock/reservations/${reservation.id}/release`, {
        expectedVersion: 7,
      });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('OPTIMISTIC_LOCK_FAILED');
      const current = await owner.post(`/v1/stock/reservations/${reservation.id}/release`, {
        expectedVersion: 1,
      });
      expect(current.status).toBe(200);
    });

    it('refuses malformed bodies: unknown fields, a zero delta, duplicate lines, a bad product id', async () => {
      const a = org();
      const { stockItemId, warehouseId } = await seedStock(api, a, 2);
      const owner = client(api, orgAdmin(a));
      for (const [path, body] of [
        ['/v1/warehouses', { name: 'x', colour: 'red' }],
        ['/v1/stock/adjustments', { stockItemId, quantityDelta: 0 }],
        ['/v1/stock/receipts', { warehouseId, productId: 'SKU-123', quantity: 1 }],
        ['/v1/stock/receipts', { warehouseId, productId: newProductId(), quantity: 1.5 }],
        [
          '/v1/stock/reservations',
          {
            lines: [
              { stockItemId, quantity: 1 },
              { stockItemId, quantity: 1 },
            ],
          },
        ],
        ['/v1/stock/reservations', { lines: [] }],
      ] as const) {
        const response = await owner.post(path, body);
        expect([path, response.status]).toEqual([path, 400]);
      }
    });

    it('requires an operator role for a command and a reader role for a read (403)', async () => {
      const a = org();
      const { stockItemId } = await seedStock(api, a, 2);
      const stranger = client(api, actor(a, ['SUPPLIER']));
      expect((await stranger.stockItem(stockItemId)).status).toBe(403);
      expect((await stranger.adjust(stockItemId, 1)).status).toBe(403);
      for (const role of ['AUDITOR', 'SYSTEM_ADMIN']) {
        const refused = client(api, actor(a, ['ORGANIZATION_ADMIN', role]));
        expect([role, (await refused.stockItem(stockItemId)).status]).toEqual([role, 403]);
      }
    });

    it('refuses a tenantless caller on every command with the policy’s 403 — before any key is claimed', async () => {
      const a = org();
      const { stockItemId, warehouseId } = await seedStock(api, a, 2);
      const reservationId = `SRV_${'0'.repeat(26)}`;
      const commands = [
        ['/v1/warehouses', { name: 'Tenantless warehouse' }],
        ['/v1/stock/receipts', { warehouseId, productId: newProductId(), quantity: 1 }],
        ['/v1/stock/adjustments', { stockItemId, quantityDelta: 1 }],
        ['/v1/stock/reservations', { lines: [{ stockItemId, quantity: 1 }] }],
        [`/v1/stock/reservations/${reservationId}/release`, {}],
        [`/v1/stock/reservations/${reservationId}/issue`, {}],
        [
          '/v1/shipments',
          {
            originWarehouseId: warehouseId,
            consigneeOrganizationId: a,
            legs: [{ carrierName: 'X' }],
          },
        ],
        [`/v1/shipments/SHP_${'0'.repeat(26)}/dispatch`, {}],
        [`/v1/shipments/SHP_${'0'.repeat(26)}/deliver`, {}],
      ] as const;
      // The platform administrator without an active organization, and a person acting for none.
      for (const roles of [['SYSTEM_ADMIN'], ['ORGANIZATION_ADMIN']]) {
        const tenantless = client(
          api,
          bearer({ sub: `sub-${key()}`, rastaUserId: 'USR-APITEST-NOORG01', roles }),
        );
        for (const [path, body] of commands) {
          const k = key();
          const response = await tenantless.post(path, body, k);
          expect([roles[0], path, response.status, response.body.code]).toEqual([
            roles[0],
            path,
            403,
            'FORBIDDEN',
          ]);
          expect(await raw.idempotencyKey.count({ where: { key: k } })).toBe(0);
        }
      }
      expect((await client(api, orgAdmin(a)).stockItem(stockItemId)).body.onHandQuantity).toBe(2);
    });

    it('refuses a service token: nothing calls inventory service to service in PR 1', async () => {
      const a = org();
      const { stockItemId } = await seedStock(api, a, 2);
      const token = await internalToken('marketplace-service', a);
      const read = await request(api.app.getHttpServer())
        .get(`/v1/stock/${stockItemId}`)
        .set('x-internal-token', token);
      expect(read.status).toBe(403);
      const write = await request(api.app.getHttpServer())
        .post('/v1/stock/adjustments')
        .set('x-internal-token', token)
        .set('idempotency-key', key())
        .send({ stockItemId, quantityDelta: 1 });
      expect(write.status).toBe(403);
    });

    it('answers 404 for an id that does not exist', async () => {
      const owner = client(api, orgAdmin(org()));
      expect((await owner.stockItem(`SKI_${'0'.repeat(26)}`)).status).toBe(404);
      expect((await owner.get(`/v1/warehouses/WHS_${'0'.repeat(26)}`)).status).toBe(404);
      expect((await owner.get(`/v1/stock/reservations/SRV_${'0'.repeat(26)}`)).status).toBe(404);
      expect((await owner.release(`SRV_${'0'.repeat(26)}`, key())).status).toBe(404);
    });
  });
});
