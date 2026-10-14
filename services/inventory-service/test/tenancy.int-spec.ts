import request from 'supertest';
import { actor, client, key, orgAdmin, seedStock, startApi, type ApiHarness } from './api-helpers';
import { cleanup, newOrganizationId, newProductId } from './helpers';

/**
 * Tenant isolation and authorization — ADR-056 § 5's mandatory negative tests, verbatim, and the
 * positive owner path (plan step 7). Every crossing of the boundary is `404`, never `403`, and
 * never a hint the row exists; `403` only where the resource does not exist yet (negative 5).
 *
 * Negative 3 (a shipment) lands with shipments in PR 2; negative 4 (two holders on one item) with
 * cross-organization holders (Q-104). In PR 1 the holder is the owner, so "another organization's
 * reservation on the same stock item" cannot be made — and any other organization's reservation
 * is 404, which is what negative 2 asserts.
 */
describe('tenant isolation (ADR-056 § 5)', () => {
  let api: ApiHarness;
  const organizations: string[] = [];

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  beforeAll(async () => {
    api = await startApi();
  });

  afterAll(async () => {
    await cleanup(organizations);
    await api.close();
  });

  it('negative 1 — organization B can neither list nor change the stock of A’s warehouse: 404', async () => {
    const a = org();
    const b = org();
    const { warehouseId, stockItemId, productId } = await seedStock(api, a, 5);
    const intruder = client(api, orgAdmin(b));

    expect((await intruder.get(`/v1/warehouses/${warehouseId}`)).status).toBe(404);
    expect((await intruder.stockItem(stockItemId)).status).toBe(404);
    expect((await intruder.get(`/v1/stock?warehouseId=${warehouseId}`)).body.items).toEqual([]);
    expect(
      (await intruder.get(`/v1/stock/movements?stockItemId=${stockItemId}`)).body.items,
    ).toEqual([]);
    expect((await intruder.get('/v1/warehouses')).body.items).toEqual([]);

    for (const attempt of [
      await intruder.receive(warehouseId, 1, productId),
      await intruder.adjust(stockItemId, -5),
      await intruder.reserve([{ stockItemId, quantity: 1 }]),
    ]) {
      expect(attempt.status).toBe(404);
      expect(attempt.body.code).toBe('NOT_FOUND');
    }
    // A's stock is exactly as it was.
    expect((await client(api, orgAdmin(a)).stockItem(stockItemId)).body).toMatchObject({
      onHandQuantity: 5,
      reservedQuantity: 0,
      version: 1,
    });
  });

  it('negative 2 — organization C, neither holder nor owner, can neither read, release nor issue a reservation: 404', async () => {
    const a = org();
    const c = org();
    const { stockItemId } = await seedStock(api, a, 5);
    const reservation = (await client(api, orgAdmin(a)).reserve([{ stockItemId, quantity: 2 }]))
      .body.reservations[0].id as string;
    const intruder = client(api, orgAdmin(c));

    expect((await intruder.get(`/v1/stock/reservations/${reservation}`)).status).toBe(404);
    expect((await intruder.get('/v1/stock/reservations')).body.items).toEqual([]);
    expect((await intruder.release(reservation)).status).toBe(404);
    expect((await intruder.issue(reservation)).status).toBe(404);
    expect(
      (await client(api, orgAdmin(a)).get(`/v1/stock/reservations/${reservation}`)).body.status,
    ).toBe('ACTIVE');
  });

  it('negative 5 — a valid role without membership in the owner cannot create a warehouse for it: 403', async () => {
    const a = org();
    const b = org();
    // B's administrator acting for A, of which it is not a member: the platform refuses the tenant.
    const asA = await request(api.app.getHttpServer())
      .post('/v1/warehouses')
      .set('authorization', `Bearer ${orgAdmin(b)}`)
      .set('x-organization-id', a)
      .set('idempotency-key', key())
      .send({ name: 'Not mine' });
    expect(asA.status).toBe(403);
    expect(asA.body.code).toBe('TENANT_MISMATCH');

    // B's administrator naming A in the body: refused, never a warehouse for A or for B.
    const named = await client(api, orgAdmin(b)).createWarehouse({
      name: 'Not mine',
      organizationId: a,
    });
    expect(named.status).toBe(403);
    expect(named.body.code).toBe('FORBIDDEN');
    expect((await client(api, orgAdmin(a)).get('/v1/warehouses')).body.items).toEqual([]);
    expect((await client(api, orgAdmin(b)).get('/v1/warehouses')).body.items).toEqual([]);
  });

  it('a member of both organizations sees each one’s stock only while acting for it', async () => {
    const a = org();
    const b = org();
    const { stockItemId } = await seedStock(api, a, 5);
    const both = actor(b, ['ORGANIZATION_ADMIN'], { memberships: [a] });

    const asB = await request(api.app.getHttpServer())
      .get(`/v1/stock/${stockItemId}`)
      .set('authorization', `Bearer ${both}`);
    expect(asB.status).toBe(404);
    const asA = await request(api.app.getHttpServer())
      .get(`/v1/stock/${stockItemId}`)
      .set('authorization', `Bearer ${both}`)
      .set('x-organization-id', a);
    expect(asA.status).toBe(200);
  });

  it('the positive path — the owner’s operator reads and moves its own stock', async () => {
    const a = org();
    const owner = client(api, orgAdmin(a));
    const { stockItemId, warehouseId } = await seedStock(api, a, 5);
    expect((await owner.get(`/v1/warehouses/${warehouseId}`)).status).toBe(200);
    expect((await owner.receive(warehouseId, 1, newProductId())).status).toBe(201);
    const reservation = await owner.reserve([{ stockItemId, quantity: 2 }]);
    expect(reservation.status).toBe(201);
    expect((await owner.issue(reservation.body.reservations[0].id)).status).toBe(200);
  });
});
