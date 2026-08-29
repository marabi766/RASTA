import { test, expect, errorCode, idempotencyKey, type Actor } from '../../src/api';
import { ORG } from '../../src/env';
import { EconomicEventTap } from '../../src/events';
import { e2eConfig } from '../../src/env';

/**
 * Tenant isolation, forged headers, and the correlation chain.
 *
 * The security half of the marketplace critical path, asserted through the
 * gateway with real Keycloak tokens — so what is being tested is the whole
 * chain of defences (routing table, guard, `@Roles`, object-level check), not
 * one function.
 */

async function publishedOffer(tenantB: Actor): Promise<string> {
  const product = await tenantB.post('/v1/products', {
    body: {
      sku: `E2E-ISO-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`,
      name: 'تسمه پروانه',
      category: 'PARTS',
      kind: 'GOOD',
      unit: 'عدد',
    },
  });
  const offer = await tenantB.post('/v1/offers', {
    body: {
      productId: (product.body as { id: string }).id,
      unitPriceMinor: '200000',
      currency: 'IRR',
      availableQuantity: 10,
      leadTimeDays: 1,
      minimumQuantity: 1,
      publish: true,
    },
  });
  return (offer.body as { id: string }).id;
}

test.describe.serial('marketplace isolation', () => {
  let orderId: string;

  test('an order is visible to both its parties', async ({ tenantA, tenantB }) => {
    const offerId = await publishedOffer(tenantB);

    const placed = await tenantA.post('/v1/orders', {
      idempotencyKey: idempotencyKey('e2e-iso'),
      body: { lines: [{ offerId, quantity: 1 }] },
    });
    expect(placed.status).toBe(201);
    orderId = (placed.body as { id: string }).id;

    expect((await tenantA.get(`/v1/orders/${orderId}`)).status).toBe(200);
    // The supplier is not the tenant the row is scoped to, and can still read
    // it — the crossing is explicit and narrowed to the two named parties.
    expect((await tenantB.get(`/v1/orders/${orderId}`)).status).toBe(200);
  });

  test('a forged organization header does not select another tenant', async ({ tenantB }) => {
    // tenantB asking to act as tenantA. The signed `org_id` claim is the
    // authority, not the header (ADR-035), so this cannot become a read of
    // somebody else's orders.
    const response = await tenantB.get('/v1/orders?role=BUYER&limit=50', {
      organizationId: ORG.a,
    });

    if (response.status === 200) {
      const items = (response.body as { items: { buyerOrganizationId: string }[] }).items;
      // Whatever came back is B's own, never A's.
      expect(items.every((order) => order.buyerOrganizationId !== ORG.a)).toBe(true);
    } else {
      // Or it is refused outright, which is equally correct.
      expect([400, 403]).toContain(response.status);
    }
  });

  test('the oversight role reaches nothing in this service', async ({ auditor }) => {
    for (const path of ['/v1/orders', '/v1/products', '/v1/offers']) {
      const response = await auditor.get(path);
      expect(response.status).toBe(403);
      // An authorization decision, not a failed login.
      expect(['FORBIDDEN', 'INSUFFICIENT_ROLE']).toContain(errorCode(response.body));
    }
  });

  test('the buyer cannot record the supplier’s fulfilment', async ({ tenantA }) => {
    const response = await tenantA.post(`/v1/orders/${orderId}/fulfill`, {
      idempotencyKey: idempotencyKey('e2e-wrong-side'),
      body: {},
    });
    expect(response.status).toBe(403);
  });

  test('the supplier cannot confirm receipt of its own delivery', async ({ tenantB }) => {
    const response = await tenantB.post(`/v1/orders/${orderId}/confirm-receipt`, {
      idempotencyKey: idempotencyKey('e2e-self-receipt'),
      body: {},
    });
    expect(response.status).toBe(403);
  });

  test('a supplier cannot reprice another supplier’s offer', async ({ tenantA, tenantB }) => {
    const offerId = await publishedOffer(tenantB);

    const response = await tenantA.patch(`/v1/offers/${offerId}`, {
      body: { unitPriceMinor: '1' },
    });
    // 404, not 403: a refusal by name would confirm the offer exists under
    // that id for an organization that has no business knowing.
    expect(response.status).toBe(404);
  });
});

test.describe.serial('correlation across HTTP, the outbox and Kafka', () => {
  let tap: EconomicEventTap;

  test.beforeAll(async () => {
    const config = e2eConfig();
    // The same tap the economic scenarios use, pointed at this domain's topic.
    tap = await EconomicEventTap.start(config, config.marketplaceTopic);
  });

  test.afterAll(async () => {
    await tap?.stop();
  });

  test('an order carries its correlation id into every event it produces', async ({
    tenantA,
    tenantB,
  }) => {
    const correlationId = `e2e-mkt-${Date.now()}-${Math.trunc(Math.random() * 1e9)}`;
    const offerId = await publishedOffer(tenantB);

    const placed = await tenantA.post('/v1/orders', {
      correlationId,
      idempotencyKey: idempotencyKey('e2e-corr'),
      body: { lines: [{ offerId, quantity: 1 }] },
    });
    expect(placed.status).toBe(201);
    expect(placed.headers['x-correlation-id']).toBe(correlationId);
    const orderId = (placed.body as { id: string }).id;

    const events = await tap.awaitCorrelated(correlationId, ['ORDER_CREATED']);

    for (const event of events) {
      // Both the header a consumer filters on and the envelope it records once
      // it has deserialised. A break in either is a break in the chain.
      expect(event.correlationId).toBe(correlationId);
      expect(event.envelopeCorrelationId).toBe(correlationId);
      expect(event.tenantId).toBe(ORG.a);
    }

    const created = events.find((event) => event.eventName === 'ORDER_CREATED');
    expect(created).toBeDefined();
    expect(created!.payload.orderId).toBe(orderId);
    // ADR-036 applied to this domain: every order-lifecycle event is keyed by
    // the order, so a consumer rebuilding it sees the steps in sequence.
    expect(created!.key).toBe(orderId);

    // The price on the wire is the server's, and it is a string in minor units.
    const line = (created!.payload.lines as { unitPriceMinor: string }[])[0];
    expect(typeof line?.unitPriceMinor).toBe('string');
    expect(line?.unitPriceMinor).toBe('200000');
  });
});
