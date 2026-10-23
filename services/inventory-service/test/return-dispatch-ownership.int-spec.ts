import type { PrismaClient } from '../src/generated/prisma';
import type { ApiHarness } from './api-helpers';
import { client, key, orgAdmin, registerRequestOf, startApi } from './api-helpers';
import {
  cleanup,
  newOrderLineId,
  newOrderReference,
  newOrganizationId,
  newProductId,
  newReturnRequestId,
  runtimeClient,
} from './helpers';

/**
 * A return shipment is checked against the return request as marketplace, its owner, records it,
 * and reserves the request's dispatch there before anything is written (A-13, ADR-061 § 4; Codex
 * r1 on #336, findings 1 and 2; Q-133 (5)).
 *
 * Marketplace is the stand-in of `marketplace-fake.ts`: the two internal routes on a real port,
 * answering as the real ones do and verifying this run's internal tokens — so each test also
 * proves which service asked, for which organization. Everything on inventory's side is real.
 */
describe('a return shipment and the return request it names', () => {
  let api: ApiHarness;
  let raw: PrismaClient;
  const organizations: string[] = [];

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  /** A supplier with a warehouse, its buyer, and a dispatch body agreeing with a fresh request. */
  async function setup() {
    const supplier = org();
    const buyer = org();
    const token = orgAdmin(supplier);
    const ops = client(api, token);
    const warehouseId = (await ops.createWarehouse()).body.id as string;
    const body = {
      returnRequestId: newReturnRequestId(),
      orderId: newOrderReference(),
      buyerOrganizationId: buyer,
      destinationWarehouseId: warehouseId,
      lines: [
        { orderLineId: newOrderLineId(), productId: newProductId(), quantity: 3 },
        { orderLineId: newOrderLineId(), productId: newProductId(), quantity: 2 },
      ],
    };
    return { supplier, buyer, token, ops, warehouseId, body };
  }

  const dispatch = (ops: ReturnType<typeof client>, body: object, k?: string) =>
    ops.post('/v1/return-shipments', body, k);

  /** What marketplace was asked about this request: method, path suffix and signed organization. */
  const asked = (returnRequestId: string) =>
    api.marketplace.calls
      .filter((call) => call.path.includes(returnRequestId))
      .map((call) => ({
        method: call.method,
        reserve: call.path.endsWith('/dispatch-reservation'),
        callerService: call.callerService,
        organizationId: call.organizationId,
      }));

  // Read past the tenant guard, as the database holds it.
  const shipmentsOf = (organizationId: string) =>
    raw.returnShipment.count({ where: { organizationId } });
  const outboxOf = (organizationId: string) =>
    raw.outboxMessage.count({ where: { organizationId, aggregateType: 'ReturnShipment' } });

  beforeAll(async () => {
    api = await startApi();
    raw = runtimeClient();
  });

  afterEach(() => {
    api.marketplace.mode = 'normal';
    api.marketplace.partialDispatchAllowed = false;
    api.marketplace.beforeReserve = null;
  });

  afterAll(async () => {
    await cleanup(organizations);
    await raw.$disconnect();
    await api.close();
  });

  // ---------------------------------------------------------------------------------------------
  // The attack of finding 1
  // ---------------------------------------------------------------------------------------------

  it('refuses an operator of a third organization naming another organization’s return — 404, nothing recorded, nothing reserved', async () => {
    // A buys from B and asked to return goods; B authorized. C has a warehouse of its own and
    // knows the return's id, order and buyer.
    const b = await setup();
    const request = registerRequestOf(api, b.token, b.body);
    const c = org();
    const attacker = client(api, orgAdmin(c));
    const cWarehouse = (await attacker.createWarehouse()).body.id as string;

    const refused = await dispatch(attacker, { ...b.body, destinationWarehouseId: cWarehouse });

    expect(refused.status).toBe(404);
    expect(refused.body.code).toBe('NOT_FOUND');
    // C learns nothing: the answer is the one an id that does not exist gets.
    expect(refused.body.message).toBe('ReturnRequest not found');
    expect(await shipmentsOf(c)).toBe(0);
    expect(await outboxOf(c)).toBe(0);
    // The buyer reads no shipment of C's under its return.
    const buyerView = await client(api, orgAdmin(b.buyer)).get(
      `/v1/return-shipments?side=sender&returnRequestId=${request.returnRequestId}`,
    );
    expect(buyerView.status).toBe(200);
    expect(buyerView.body.items).toEqual([]);
    // Marketplace was asked as C — the organization in the signature — and nothing was reserved.
    expect(asked(request.returnRequestId)).toEqual([
      { method: 'GET', reserve: false, callerService: 'inventory-service', organizationId: c },
    ]);
    expect(api.marketplace.requests.get(request.returnRequestId)?.dispatchReservedAt).toBeNull();

    // The real supplier still dispatches it.
    expect((await dispatch(b.ops, b.body)).status).toBe(201);
  });

  it('refuses a request marketplace does not have with 404, and records nothing', async () => {
    const s = await setup();

    const refused = await dispatch(s.ops, s.body);

    expect(refused.status).toBe(404);
    expect(refused.body.code).toBe('NOT_FOUND');
    expect(await shipmentsOf(s.supplier)).toBe(0);
    expect(asked(s.body.returnRequestId).map((call) => call.reserve)).toEqual([false]);
  });

  // ---------------------------------------------------------------------------------------------
  // The request's own facts
  // ---------------------------------------------------------------------------------------------

  it.each([
    ['another buyer', { buyerOrganizationId: newOrganizationId() }],
    ['another order', { orderId: newOrderReference() }],
  ])('refuses %s than the request’s with 422 RETURN_REQUEST_MISMATCH', async (_name, change) => {
    const s = await setup();
    registerRequestOf(api, s.token, s.body);

    const refused = await dispatch(s.ops, { ...s.body, ...change });

    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('BUSINESS_RULE_VIOLATION');
    expect(refused.body.details).toEqual([
      expect.objectContaining({ path: 'returnShipment', code: 'RETURN_REQUEST_MISMATCH' }),
    ]);
    expect(await shipmentsOf(s.supplier)).toBe(0);
    expect(asked(s.body.returnRequestId).map((call) => call.reserve)).toEqual([false]);
  });

  type Line = { orderLineId: string; productId: string; quantity: number };
  const lineChanges: [string, (lines: Line[]) => Line[]][] = [
    [
      'a line the request does not return',
      (lines) => [
        ...lines,
        { orderLineId: newOrderLineId(), productId: newProductId(), quantity: 1 },
      ],
    ],
    [
      'another product on a line',
      (lines) => lines.map((line, i) => (i === 0 ? { ...line, productId: newProductId() } : line)),
    ],
    [
      'more than was authorized',
      (lines) =>
        lines.map((line, i) => (i === 0 ? { ...line, quantity: line.quantity + 1 } : line)),
    ],
    ['fewer lines than were authorized', (lines) => lines.slice(0, 1)],
    [
      'fewer units than were authorized',
      (lines) =>
        lines.map((line, i) => (i === 0 ? { ...line, quantity: line.quantity - 1 } : line)),
    ],
  ];

  it.each(lineChanges)(
    'refuses %s with 422 RETURN_LINES_MISMATCH (no partial dispatch, Q-133 (8))',
    async (_name, change) => {
      const s = await setup();
      registerRequestOf(api, s.token, s.body);

      const refused = await dispatch(s.ops, { ...s.body, lines: change(s.body.lines) });

      expect(refused.status).toBe(422);
      expect(refused.body.details?.[0]?.code).toBe('RETURN_LINES_MISMATCH');
      expect(await shipmentsOf(s.supplier)).toBe(0);
      expect(asked(s.body.returnRequestId).map((call) => call.reserve)).toEqual([false]);
    },
  );

  it('accepts fewer lines or units where marketplace allows a partial dispatch — never more, nor another line', async () => {
    api.marketplace.partialDispatchAllowed = true;
    const s = await setup();
    registerRequestOf(api, s.token, s.body);
    const [first] = s.body.lines as [Line, Line];

    for (const lines of [
      [{ ...first, quantity: first.quantity + 1 }],
      [{ ...first, productId: newProductId() }],
      [{ orderLineId: newOrderLineId(), productId: newProductId(), quantity: 1 }],
    ]) {
      const refused = await dispatch(s.ops, { ...s.body, lines });
      expect(refused.status).toBe(422);
      expect(refused.body.details?.[0]?.code).toBe('RETURN_LINES_MISMATCH');
    }

    const partial = await dispatch(s.ops, { ...s.body, lines: [{ ...first, quantity: 1 }] });
    expect(partial.status).toBe(201);
    expect(partial.body.lines).toEqual([
      expect.objectContaining({ orderLineId: first.orderLineId, expectedQuantity: 1 }),
    ]);
  });

  it.each(['REQUESTED', 'REJECTED', 'CANCELLED', 'IN_TRANSIT', 'RESOLVED'])(
    'refuses a request that is %s with 422 RETURN_REQUEST_NOT_AUTHORIZED, and reserves nothing',
    async (status) => {
      const s = await setup();
      registerRequestOf(api, s.token, s.body, { status });

      const refused = await dispatch(s.ops, s.body);

      expect(refused.status).toBe(422);
      expect(refused.body.details?.[0]?.code).toBe('RETURN_REQUEST_NOT_AUTHORIZED');
      expect(await shipmentsOf(s.supplier)).toBe(0);
      expect(asked(s.body.returnRequestId).map((call) => call.reserve)).toEqual([false]);
    },
  );

  // ---------------------------------------------------------------------------------------------
  // The reservation (finding 2)
  // ---------------------------------------------------------------------------------------------

  it('reads, then reserves the dispatch, signed for the supplier — and only then records the shipment', async () => {
    const s = await setup();
    const request = registerRequestOf(api, s.token, s.body);

    const created = await dispatch(s.ops, s.body);

    expect(created.status).toBe(201);
    expect(asked(request.returnRequestId)).toEqual([
      {
        method: 'GET',
        reserve: false,
        callerService: 'inventory-service',
        organizationId: s.supplier,
      },
      {
        method: 'POST',
        reserve: true,
        callerService: 'inventory-service',
        organizationId: s.supplier,
      },
    ]);
    expect(api.marketplace.requests.get(request.returnRequestId)?.dispatchReservedAt).toEqual(
      expect.any(String),
    );
    expect(await outboxOf(s.supplier)).toBe(1);
  });

  it('records nothing when the buyer cancelled between the read and the reservation', async () => {
    const s = await setup();
    const request = registerRequestOf(api, s.token, s.body);
    // Marketplace serialises the two under the request's row lock; here the cancellation won.
    api.marketplace.beforeReserve = (id) => {
      const stored = api.marketplace.requests.get(id);
      if (stored) stored.status = 'CANCELLED';
    };

    const refused = await dispatch(s.ops, s.body);

    expect(refused.status).toBe(422);
    expect(refused.body.details?.[0]?.code).toBe('RETURN_REQUEST_NOT_AUTHORIZED');
    expect(await shipmentsOf(s.supplier)).toBe(0);
    expect(await outboxOf(s.supplier)).toBe(0);
    expect(asked(request.returnRequestId).map((call) => call.reserve)).toEqual([false, true]);
  });

  it('asks nothing of marketplace for what it refuses itself: a warehouse not its own, a second dispatch', async () => {
    const s = await setup();
    registerRequestOf(api, s.token, s.body);

    const noWarehouse = await dispatch(s.ops, {
      ...s.body,
      destinationWarehouseId: (await client(api, orgAdmin(org())).createWarehouse()).body.id,
    });
    expect(noWarehouse.status).toBe(404);
    expect(asked(s.body.returnRequestId)).toEqual([]);

    expect((await dispatch(s.ops, s.body)).status).toBe(201);
    const before = asked(s.body.returnRequestId).length;
    const again = await dispatch(s.ops, s.body);
    expect(again.status).toBe(409);
    expect(again.body.details?.[0]?.code).toBe('RETURN_ALREADY_DISPATCHED');
    expect(asked(s.body.returnRequestId)).toHaveLength(before);
  });

  // ---------------------------------------------------------------------------------------------
  // Fail closed
  // ---------------------------------------------------------------------------------------------

  it.each([
    ['answers 503', 'unavailable', 503, 'UPSTREAM_UNAVAILABLE'],
    [
      'answers 404 from no route of its own (a rolling deploy)',
      'route-missing',
      503,
      'UPSTREAM_UNAVAILABLE',
    ],
    ['refuses this service (403)', 'forbidden', 503, 'UPSTREAM_UNAVAILABLE'],
    ['does not answer in time', 'silent', 504, 'UPSTREAM_TIMEOUT'],
  ] as const)(
    'refuses the dispatch when marketplace %s — nothing recorded, and the same key works once it answers',
    async (_name, mode, status, code) => {
      const s = await setup();
      registerRequestOf(api, s.token, s.body);
      const k = key();
      api.marketplace.mode = mode;

      const refused = await dispatch(s.ops, s.body, k);

      expect(refused.status).toBe(status);
      expect(refused.body.code).toBe(code);
      expect(await shipmentsOf(s.supplier)).toBe(0);
      expect(await outboxOf(s.supplier)).toBe(0);

      api.marketplace.mode = 'normal';
      const retried = await dispatch(s.ops, s.body, k);
      expect(retried.status).toBe(201);
      expect(await shipmentsOf(s.supplier)).toBe(1);
    },
  );
});
