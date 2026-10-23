/**
 * @jest-environment node
 */
import { fetchMovements, fetchShipment, fetchShipmentTracking, fetchShipments } from './inventory';
import type { WebSession } from './session';

/**
 * Reading the ledger and the shipments: what is kept (and what is not — a
 * user id never travels into a page), the query each read asks, and the
 * outcomes a degraded service or a stranger's id become.
 */

const SESSION: WebSession = {
  subject: 'USR_1',
  username: 'owner',
  organizationId: 'ORG_OWNER',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: 2_000_000_000,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf',
  issuedAt: 1_900_000_000,
};

beforeEach(() => {
  Object.assign(process.env, {
    API_GATEWAY_URL: 'http://gateway.test:3000',
    OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
    OIDC_CLIENT_ID: 'rasta-web',
    WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
    WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
  });
});

function answering(body: unknown, status = 200) {
  const urls: string[] = [];
  const impl = (async (url: RequestInfo | URL) => {
    urls.push(String(url));
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'x-correlation-id': 'corr-1' },
    });
  }) as typeof fetch;
  return { impl, urls };
}

function withFetch<T>(handler: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

const ULID = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
const WAREHOUSE_ID = `WHS_${ULID}`;
const SHIPMENT_ID = `SHP_${ULID}`;

const MOVEMENT = {
  id: 'MOV_1',
  stockItemId: `SKI_${ULID}`,
  warehouseId: WAREHOUSE_ID,
  type: 'ADJUSTMENT',
  onHandDelta: -5,
  reservedDelta: 0,
  onHandAfter: 115,
  reservedAfter: 20,
  itemVersion: 4,
  reservationId: null,
  sourceReference: `ADJ_${ULID}`,
  createdAt: '2026-09-20T08:00:00.000Z',
  createdBy: 'USR_SECRET_PERSON',
};

const SHIPMENT = {
  id: SHIPMENT_ID,
  organizationId: 'ORG_OWNER',
  originWarehouseId: WAREHOUSE_ID,
  consigneeOrganizationId: 'ORG_CONSIGNEE',
  orderReference: null,
  status: 'CREATED',
  legs: [{ sequence: 1, carrierName: 'باربری', carrierReference: null }],
  createdAt: '2026-09-19T08:00:00.000Z',
  dispatchedAt: null,
  deliveredAt: null,
  updatedAt: '2026-09-19T08:00:00.000Z',
  version: 1,
};

describe('the ledger', () => {
  it('asks for the warehouse’s movements, keeps the figures and reduces the actor to "by the service or not"', async () => {
    const { impl, urls } = answering({ items: [MOVEMENT], nextCursor: 'MOV_0', hasMore: true });
    const result = await withFetch(impl, () => fetchMovements(SESSION, WAREHOUSE_ID, 'c1'));
    expect(urls[0]).toBe(
      `http://gateway.test:3000/v1/stock/movements?limit=20&warehouseId=${WAREHOUSE_ID}&cursor=c1`,
    );
    expect(result).toMatchObject({
      kind: 'OK',
      data: {
        nextCursor: 'MOV_0',
        items: [{ type: 'ADJUSTMENT', onHandDelta: -5, onHandAfter: 115, bySystem: false }],
      },
    });
    expect(JSON.stringify(result)).not.toContain('USR_SECRET_PERSON');
    expect(JSON.stringify(result)).not.toContain('createdBy');
  });

  it('knows the service’s own movement (an expiry)', async () => {
    const { impl } = answering({
      items: [{ ...MOVEMENT, type: 'RELEASE', createdBy: 'inventory-service' }],
      nextCursor: null,
      hasMore: false,
    });
    const result = await withFetch(impl, () => fetchMovements(SESSION, WAREHOUSE_ID));
    expect(result).toMatchObject({ kind: 'OK', data: { items: [{ bySystem: true }] } });
  });

  it.each([
    ['a quantity past the stored range', { ...MOVEMENT, onHandAfter: 2_147_483_648 }],
    ['a fractional delta', { ...MOVEMENT, onHandDelta: 1.5 }],
    ['a malformed timestamp', { ...MOVEMENT, createdAt: 'yesterday' }],
    ['no actor', { ...MOVEMENT, createdBy: '' }],
  ])('is malformed with %s', async (_name, item) => {
    const { impl } = answering({ items: [item], nextCursor: null, hasMore: false });
    expect(await withFetch(impl, () => fetchMovements(SESSION, WAREHOUSE_ID))).toEqual({
      kind: 'MALFORMED',
      correlationId: expect.any(String),
    });
  });
});

describe('the shipments', () => {
  it('lists with the side the caller asks for, keeps the owner and the version', async () => {
    const { impl, urls } = answering({ items: [SHIPMENT], nextCursor: null, hasMore: false });
    const result = await withFetch(impl, () =>
      fetchShipments(SESSION, { side: 'origin', cursor: 'c2' }),
    );
    expect(urls[0]).toBe('http://gateway.test:3000/v1/shipments?limit=20&side=origin&cursor=c2');
    expect(result).toMatchObject({
      kind: 'OK',
      data: { items: [{ id: SHIPMENT_ID, organizationId: 'ORG_OWNER', version: 1 }] },
    });
  });

  it('asks for both sides when none is named', async () => {
    const { impl, urls } = answering({ items: [], nextCursor: null, hasMore: false });
    await withFetch(impl, () => fetchShipments(SESSION));
    expect(urls[0]).toBe('http://gateway.test:3000/v1/shipments?limit=20');
  });

  it('reads one shipment and its tracking', async () => {
    const shipment = answering(SHIPMENT);
    expect(await withFetch(shipment.impl, () => fetchShipment(SESSION, SHIPMENT_ID))).toMatchObject(
      { kind: 'OK', data: { status: 'CREATED', legs: [{ sequence: 1 }] } },
    );
    expect(shipment.urls[0]).toBe(`http://gateway.test:3000/v1/shipments/${SHIPMENT_ID}`);

    const tracking = answering({
      shipmentId: SHIPMENT_ID,
      status: 'DISPATCHED',
      originWarehouseId: WAREHOUSE_ID,
      consigneeOrganizationId: 'ORG_CONSIGNEE',
      events: [
        {
          id: 'T1',
          type: 'CREATED',
          occurredAt: '2026-09-19T08:00:00.000Z',
          recordedAt: '2026-09-19T08:00:01.000Z',
        },
        {
          id: 'T2',
          type: 'DISPATCHED',
          occurredAt: '2026-09-20T08:00:00.000Z',
          recordedAt: '2026-09-20T08:00:01.000Z',
        },
      ],
    });
    const read = await withFetch(tracking.impl, () => fetchShipmentTracking(SESSION, SHIPMENT_ID));
    expect(read).toMatchObject({
      kind: 'OK',
      data: { events: [{ type: 'CREATED' }, { type: 'DISPATCHED' }] },
    });
    expect(tracking.urls[0]).toBe(`http://gateway.test:3000/v1/shipments/${SHIPMENT_ID}/tracking`);
  });

  it('encodes an id in the path', async () => {
    const { impl, urls } = answering(SHIPMENT);
    await withFetch(impl, () => fetchShipment(SESSION, 'a/b'));
    expect(urls[0]).toBe('http://gateway.test:3000/v1/shipments/a%2Fb');
  });

  it('a stranger’s shipment is absent (404), a refusal is a refusal (403), an outage is an outage', async () => {
    expect(
      await withFetch(answering({ code: 'NOT_FOUND', message: 'x' }, 404).impl, () =>
        fetchShipment(SESSION, SHIPMENT_ID),
      ),
    ).toEqual({ kind: 'NOT_FOUND' });
    expect(
      await withFetch(answering({ code: 'FORBIDDEN', message: 'x' }, 403).impl, () =>
        fetchShipments(SESSION),
      ),
    ).toEqual({ kind: 'FORBIDDEN' });
    expect(
      await withFetch(answering({ code: 'SERVICE_UNAVAILABLE', message: 'x' }, 503).impl, () =>
        fetchShipmentTracking(SESSION, SHIPMENT_ID),
      ),
    ).toMatchObject({ kind: 'UNAVAILABLE', status: 503 });
  });

  it.each([
    ['a version of zero', { ...SHIPMENT, version: 0 }],
    ['no owner', { ...SHIPMENT, organizationId: '' }],
    ['a malformed timestamp', { ...SHIPMENT, dispatchedAt: 'soon' }],
  ])('is malformed with %s', async (_name, body) => {
    expect(
      await withFetch(answering(body).impl, () => fetchShipment(SESSION, SHIPMENT_ID)),
    ).toEqual({ kind: 'MALFORMED', correlationId: expect.any(String) });
  });
});
