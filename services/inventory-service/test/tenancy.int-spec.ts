import request from 'supertest';
import {
  actor,
  client,
  key,
  orgAdmin,
  seedShipment,
  seedStock,
  startApi,
  type ApiHarness,
} from './api-helpers';
import { cleanup, newOrganizationId, newProductId } from './helpers';

/**
 * Tenant isolation and authorization — ADR-056 § 5's mandatory negative tests, verbatim, and the
 * positive owner path (plan step 7). Every crossing of the boundary is `404`, never `403`, and
 * never a hint the row exists; `403` only where the resource does not exist yet (negative 5).
 *
 * Negative 3 (a shipment) arrived with shipments (PR 2), with the consignee's side: it reads, never
 * moves. Negative 4 (two holders on one item) waits for cross-organization holders (Q-104). In PR 1
 * the holder is the owner, so "another organization's reservation on the same stock item" cannot be
 * made — and any other organization's reservation is 404, which is what negative 2 asserts.
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

  it('negative 3 — organization D, neither consignee nor owner of the origin warehouse, cannot track a shipment: 404', async () => {
    const a = org();
    const consignee = org();
    const d = org();
    const { shipmentId } = await seedShipment(api, a, consignee);
    const intruder = client(api, orgAdmin(d));

    const tracked = await intruder.tracking(shipmentId);
    expect(tracked.status).toBe(404);
    expect(tracked.body.code).toBe('NOT_FOUND');
    expect((await intruder.shipment(shipmentId)).status).toBe(404);
    expect((await intruder.get('/v1/shipments')).body.items).toEqual([]);
    for (const attempt of [
      await intruder.dispatch(shipmentId),
      await intruder.deliver(shipmentId),
    ]) {
      expect([attempt.status, attempt.body.code]).toEqual([404, 'NOT_FOUND']);
    }
    // The shipment is exactly as it was.
    expect((await client(api, orgAdmin(a)).shipment(shipmentId)).body).toMatchObject({
      status: 'CREATED',
      version: 1,
    });
  });

  it('the consignee tracks the shipment sent to it, and the owner too (ADR-056 § 5)', async () => {
    const a = org();
    const consignee = org();
    const { shipmentId } = await seedShipment(api, a, consignee);
    await client(api, orgAdmin(a)).dispatch(shipmentId);

    for (const reader of [a, consignee]) {
      const tracked = await client(api, orgAdmin(reader)).tracking(shipmentId);
      expect([reader, tracked.status, tracked.body.status]).toEqual([reader, 200, 'DISPATCHED']);
      expect(tracked.body.events.map((event: { type: string }) => event.type)).toEqual([
        'CREATED',
        'DISPATCHED',
      ]);
      expect((await client(api, orgAdmin(reader)).shipment(shipmentId)).status).toBe(200);
    }
    const asConsignee = client(api, orgAdmin(consignee));
    expect(
      (await asConsignee.get('/v1/shipments?side=consignee')).body.items.map(
        (s: { id: string }) => s.id,
      ),
    ).toEqual([shipmentId]);
    expect((await asConsignee.get('/v1/shipments?side=origin')).body.items).toEqual([]);
  });

  it('the consignee reads but never moves the shipment: 403, and nothing changes', async () => {
    const a = org();
    const consignee = org();
    const { shipmentId } = await seedShipment(api, a, consignee);
    const receiver = client(api, orgAdmin(consignee));

    for (const attempt of [
      await receiver.dispatch(shipmentId),
      await receiver.deliver(shipmentId),
    ]) {
      expect([attempt.status, attempt.body.code]).toEqual([403, 'FORBIDDEN']);
    }
    await client(api, orgAdmin(a)).dispatch(shipmentId);
    const late = await receiver.deliver(shipmentId);
    expect([late.status, late.body.code]).toEqual([403, 'FORBIDDEN']);
    expect((await receiver.shipment(shipmentId)).body).toMatchObject({
      status: 'DISPATCHED',
      version: 2,
    });
  });

  it('a member of both a shipment’s organizations sees each side only while acting for it', async () => {
    const a = org();
    const consignee = org();
    const other = org();
    const { shipmentId } = await seedShipment(api, a, consignee);
    const both = actor(other, ['ORGANIZATION_ADMIN'], { memberships: [consignee] });
    const as = (organizationId?: string) => {
      const call = request(api.app.getHttpServer())
        .get(`/v1/shipments/${shipmentId}/tracking`)
        .set('authorization', `Bearer ${both}`);
      return organizationId === undefined ? call : call.set('x-organization-id', organizationId);
    };
    expect((await as()).status).toBe(404);
    expect((await as(consignee)).status).toBe(200);
    expect((await as(a)).status).toBe(403);
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

describe('a shipment’s consignee side is opened by its own roles (Q-113)', () => {
  let api: ApiHarness;
  const organizations: string[] = [];

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  beforeAll(async () => {
    api = await startApi({ INVENTORY_CONSIGNEE_READER_ROLES: 'PROCUREMENT_USER' });
  });

  afterAll(async () => {
    await cleanup(organizations);
    await api.close();
  });

  it('tracks as the configured consignee role, and finds nothing as a role that opens no consignee side', async () => {
    const a = org();
    const consignee = org();
    const { shipmentId } = await seedShipment(api, a, consignee);

    const buyer = client(api, actor(consignee, ['PROCUREMENT_USER']));
    expect((await buyer.tracking(shipmentId)).status).toBe(200);
    // The owner side is not opened by this role: the buyer's own organization owns no shipments.
    expect((await buyer.get('/v1/shipments?side=origin')).body.items).toEqual([]);

    // ORGANIZATION_ADMIN still reads its own (owner) side, but no longer the consignee side.
    const admin = client(api, orgAdmin(consignee));
    expect((await admin.tracking(shipmentId)).status).toBe(404);
    expect((await admin.dispatch(shipmentId)).status).toBe(404);
    // A role that opens neither side is refused at the door.
    const supplier = client(api, actor(consignee, ['SUPPLIER']));
    expect((await supplier.tracking(shipmentId)).body.code).toBe('INSUFFICIENT_ROLE');
  });
});
