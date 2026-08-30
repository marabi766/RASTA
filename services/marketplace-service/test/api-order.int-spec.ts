import request from 'supertest';
import type { Server } from 'node:http';
import { runUnscoped } from '@rasta/nest-common';
import {
  apiKey,
  apiTenant,
  auditor,
  buyer,
  internalToken,
  platformAdmin,
  startApi,
  supplier,
  type ApiHarness,
} from './api-helpers';
import { cleanup } from './helpers';

/**
 * The order HTTP surface, every path including the refusals.
 *
 * `docs/14` § 14.5: "پوشش الزامی به‌ازای هر Endpoint: مسیر موفق · ورودی نامعتبر
 * (۴۰۰) · بدون توکن (۴۰۱) · نقش نادرست (۴۰۳) · مستأجر دیگر (۴۰۴)". Each of
 * those is a row below, against a real database and the real state machine.
 *
 * The status a refusal carries is asserted every time, because in this domain
 * the difference is information: a stranger gets 404 so the attempt cannot
 * confirm the order exists, and a party on the wrong side of it gets 403
 * because they can already see it.
 */
describe('order API', () => {
  let harness: ApiHarness;
  let http: Server;

  const buyerOrg = apiTenant('ORD-BUY');
  const supplierOrg = apiTenant('ORD-SUP');
  const strangerOrg = apiTenant('ORD-OTH');

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [buyerOrg, supplierOrg, strangerOrg]);
    await harness.close();
  });

  /** A published offer from the supplier, ready to be ordered. */
  async function publishOffer(
    options: { price?: string; quantity?: number; minimum?: number } = {},
  ): Promise<string> {
    const product = await request(http)
      .post('/v1/products')
      .set('authorization', `Bearer ${supplier(supplierOrg)}`)
      .send({
        sku: `API-SKU-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`,
        name: 'قطعه یدکی آزمایشی',
        category: 'PARTS',
        kind: 'GOOD',
        unit: 'عدد',
      })
      .expect(201);

    const offer = await request(http)
      .post('/v1/offers')
      .set('authorization', `Bearer ${supplier(supplierOrg)}`)
      .send({
        productId: product.body.id,
        unitPriceMinor: options.price ?? '250000',
        currency: 'IRR',
        availableQuantity: options.quantity ?? 20,
        leadTimeDays: 3,
        minimumQuantity: options.minimum ?? 1,
        publish: true,
      })
      .expect(201);

    return offer.body.id as string;
  }

  async function placeOrder(offerId: string, quantity = 1) {
    return request(http)
      .post('/v1/orders')
      .set('authorization', `Bearer ${buyer(buyerOrg)}`)
      .set('idempotency-key', apiKey('api-order'))
      .send({ lines: [{ offerId, quantity }] })
      .expect(201);
  }

  // -------------------------------------------------------------------------
  // Placement
  // -------------------------------------------------------------------------

  describe('POST /v1/orders', () => {
    it('places an order priced from the server-side offer', async () => {
      const offerId = await publishOffer({ price: '250000' });

      const response = await request(http)
        .post('/v1/orders')
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .set('idempotency-key', apiKey('api-place'))
        .send({ lines: [{ offerId, quantity: 2 }] })
        .expect(201);

      expect(response.body.status).toBe('PENDING');
      expect(response.body.totalAmountMinor).toBe('500000');
      expect(response.body.buyerOrganizationId).toBe(buyerOrg);
      expect(response.body.supplierOrganizationId).toBe(supplierOrg);
      // ADR-041: the check did not run, so this is not `false`.
      expect(response.body.supplierQualification).toBe('UNAVAILABLE');
    });

    it('refuses a body naming its own price with 400', async () => {
      const offerId = await publishOffer();

      const response = await request(http)
        .post('/v1/orders')
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .set('idempotency-key', apiKey('api-price'))
        .send({ lines: [{ offerId, quantity: 1, unitPriceMinor: '1' }] })
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_FAILED');
    });

    it('refuses a request with no Idempotency-Key with 400', async () => {
      const offerId = await publishOffer();

      const response = await request(http)
        .post('/v1/orders')
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .send({ lines: [{ offerId, quantity: 1 }] })
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_FAILED');
    });

    it('refuses a key shorter than the minimum with 400', async () => {
      const offerId = await publishOffer();

      await request(http)
        .post('/v1/orders')
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .set('idempotency-key', 'short')
        .send({ lines: [{ offerId, quantity: 1 }] })
        .expect(400);
    });

    it('refuses an unauthenticated request with 401', async () => {
      const offerId = await publishOffer();

      await request(http)
        .post('/v1/orders')
        .set('idempotency-key', apiKey('api-anon'))
        .send({ lines: [{ offerId, quantity: 1 }] })
        .expect(401);
    });

    it('refuses a role that cannot commit the organization with 403', async () => {
      const offerId = await publishOffer();

      await request(http)
        .post('/v1/orders')
        .set('authorization', `Bearer ${supplier(buyerOrg)}`)
        .set('idempotency-key', apiKey('api-wrongrole'))
        .send({ lines: [{ offerId, quantity: 1 }] })
        .expect(403);
    });

    it('refuses the oversight role with 403', async () => {
      const offerId = await publishOffer();

      await request(http)
        .post('/v1/orders')
        .set('authorization', `Bearer ${auditor(buyerOrg)}`)
        .set('idempotency-key', apiKey('api-auditor'))
        .send({ lines: [{ offerId, quantity: 1 }] })
        .expect(403);
    });

    it('reports 404 for an offer that is not published', async () => {
      await request(http)
        .post('/v1/orders')
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .set('idempotency-key', apiKey('api-missing'))
        .send({ lines: [{ offerId: 'OFR_DOES_NOT_EXIST', quantity: 1 }] })
        .expect(404);
    });

    it('refuses more than the offer has with 422', async () => {
      const offerId = await publishOffer({ quantity: 2 });

      const response = await request(http)
        .post('/v1/orders')
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .set('idempotency-key', apiKey('api-toomany'))
        .send({ lines: [{ offerId, quantity: 9 }] })
        .expect(422);

      expect(response.body.code).toBe('BUSINESS_RULE_VIOLATION');
    });

    it('replays the original response for the same key and body', async () => {
      const offerId = await publishOffer({ quantity: 10 });
      const key = apiKey('api-replay');
      const body = { lines: [{ offerId, quantity: 2 }] };

      const first = await request(http)
        .post('/v1/orders')
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .set('idempotency-key', key)
        .send(body)
        .expect(201);

      const replay = await request(http)
        .post('/v1/orders')
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .set('idempotency-key', key)
        .send(body)
        .expect(201);

      expect(replay.body.id).toBe(first.body.id);

      // And the availability moved once, not twice.
      const offer = await runUnscoped('the suite verifies the replay took nothing', () =>
        harness.prisma.client.offer.findUnique({ where: { id: offerId } }),
      );
      expect(offer?.availableQuantity).toBe(8);
    });

    it('refuses the same key with a different body with 409', async () => {
      const first = await publishOffer();
      const second = await publishOffer();
      const key = apiKey('api-reuse');

      await request(http)
        .post('/v1/orders')
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .set('idempotency-key', key)
        .send({ lines: [{ offerId: first, quantity: 1 }] })
        .expect(201);

      const conflict = await request(http)
        .post('/v1/orders')
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .set('idempotency-key', key)
        .send({ lines: [{ offerId: second, quantity: 1 }] })
        .expect(409);

      expect(conflict.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });
  });

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  describe('GET /v1/orders', () => {
    it('shows an order to both its parties', async () => {
      const offerId = await publishOffer();
      const order = await placeOrder(offerId);

      await request(http)
        .get(`/v1/orders/${order.body.id}`)
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .expect(200);

      await request(http)
        .get(`/v1/orders/${order.body.id}`)
        .set('authorization', `Bearer ${supplier(supplierOrg)}`)
        .expect(200);
    });

    it('reports 404 to a third organization, revealing nothing', async () => {
      const offerId = await publishOffer();
      const order = await placeOrder(offerId);

      const response = await request(http)
        .get(`/v1/orders/${order.body.id}`)
        .set('authorization', `Bearer ${buyer(strangerOrg)}`)
        .expect(404);

      // Neither party is named in the refusal.
      const serialised = JSON.stringify(response.body);
      expect(serialised).not.toContain(buyerOrg);
      expect(serialised).not.toContain(supplierOrg);
    });

    it('reports 404 for an order that does not exist', async () => {
      await request(http)
        .get('/v1/orders/ORD_NOT_A_REAL_ORDER')
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .expect(404);
    });

    it('lists the caller’s own orders on each side', async () => {
      const offerId = await publishOffer();
      const order = await placeOrder(offerId);

      const asBuyer = await request(http)
        .get('/v1/orders?role=BUYER&limit=50')
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .expect(200);
      expect(asBuyer.body.items.map((o: { id: string }) => o.id)).toContain(order.body.id);

      const asSupplier = await request(http)
        .get('/v1/orders?role=SUPPLIER&limit=50')
        .set('authorization', `Bearer ${supplier(supplierOrg)}`)
        .expect(200);
      expect(asSupplier.body.items.map((o: { id: string }) => o.id)).toContain(order.body.id);

      const asStranger = await request(http)
        .get('/v1/orders?role=BUYER&limit=50')
        .set('authorization', `Bearer ${buyer(strangerOrg)}`)
        .expect(200);
      expect(asStranger.body.items.map((o: { id: string }) => o.id)).not.toContain(order.body.id);
    });

    it('filters by status', async () => {
      const response = await request(http)
        .get('/v1/orders?status=PENDING&limit=5')
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .expect(200);

      expect(response.body.items.every((o: { status: string }) => o.status === 'PENDING')).toBe(
        true,
      );
    });

    it('refuses an unknown status with 400', async () => {
      await request(http)
        .get('/v1/orders?status=NOT_A_STATUS')
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .expect(400);
    });

    it('refuses a page size beyond the cap with 400', async () => {
      await request(http)
        .get('/v1/orders?limit=5000')
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .expect(400);
    });

    it('returns a cursor when the page is full', async () => {
      // Two orders and a page of one, so the cursor branch is reached rather
      // than the "fewer results than asked for" one.
      const offerId = await publishOffer({ quantity: 10 });
      await placeOrder(offerId);
      await placeOrder(offerId);

      const page = await request(http)
        .get('/v1/orders?role=BUYER&limit=1')
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .expect(200);

      expect(page.body.items).toHaveLength(1);
      expect(page.body.nextCursor).toBeTruthy();

      const next = await request(http)
        .get(`/v1/orders?role=BUYER&limit=1&cursor=${page.body.nextCursor}`)
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .expect(200);

      expect(next.body.items[0]?.id).not.toBe(page.body.items[0]?.id);
    });

    it('refuses the oversight role with 403', async () => {
      await request(http)
        .get('/v1/orders')
        .set('authorization', `Bearer ${auditor(buyerOrg)}`)
        .expect(403);
    });
  });

  // -------------------------------------------------------------------------
  // The supplier's half
  // -------------------------------------------------------------------------

  describe('supplier commands', () => {
    it('confirms and fulfils, answering 200 rather than 201', async () => {
      // These change an existing order rather than creating anything, and the
      // status recorded for an idempotent replay is 200 — Nest's POST default
      // would make a retry answer differently from the original call.
      const offerId = await publishOffer();
      const order = await placeOrder(offerId);

      await request(http)
        .post(`/v1/orders/${order.body.id}/confirm`)
        .set('authorization', `Bearer ${supplier(supplierOrg)}`)
        .set('idempotency-key', apiKey('api-confirm'))
        .send({})
        .expect(422); // PENDING → CONFIRMED is not a legal transition

      // Funds must be held first, which the saga does. Drive it directly.
      await runUnscoped('the suite advances the order the saga would', () =>
        harness.prisma.client.$executeRawUnsafe(
          `UPDATE "order" SET status='FUNDS_HELD', economic_transaction_id=$2 WHERE id=$1`,
          order.body.id,
          `TXN_APITEST_${order.body.id}`,
        ),
      );

      const confirmed = await request(http)
        .post(`/v1/orders/${order.body.id}/confirm`)
        .set('authorization', `Bearer ${supplier(supplierOrg)}`)
        .set('idempotency-key', apiKey('api-confirm-2'))
        .send({})
        .expect(200);
      expect(confirmed.body.status).toBe('CONFIRMED');

      const fulfilled = await request(http)
        .post(`/v1/orders/${order.body.id}/fulfill`)
        .set('authorization', `Bearer ${supplier(supplierOrg)}`)
        .set('idempotency-key', apiKey('api-fulfill'))
        .send({ trackingReference: 'WB-API-1' })
        .expect(200);
      expect(fulfilled.body.status).toBe('AWAITING_RECEIPT_CONFIRMATION');
    });

    it('refuses the buyer the supplier’s commands with 403', async () => {
      const offerId = await publishOffer();
      const order = await placeOrder(offerId);

      await request(http)
        .post(`/v1/orders/${order.body.id}/fulfill`)
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .set('idempotency-key', apiKey('api-buyer-fulfill'))
        .send({})
        .expect(403);
    });

    it('reports 404 to a third organization attempting a supplier command', async () => {
      const offerId = await publishOffer();
      const order = await placeOrder(offerId);

      await request(http)
        .post(`/v1/orders/${order.body.id}/confirm`)
        .set('authorization', `Bearer ${supplier(strangerOrg)}`)
        .set('idempotency-key', apiKey('api-stranger-confirm'))
        .send({})
        .expect(403);
    });

    it('refuses a tracking reference longer than the schema allows with 400', async () => {
      const offerId = await publishOffer();
      const order = await placeOrder(offerId);

      await request(http)
        .post(`/v1/orders/${order.body.id}/fulfill`)
        .set('authorization', `Bearer ${supplier(supplierOrg)}`)
        .set('idempotency-key', apiKey('api-long-ref'))
        .send({ trackingReference: 'x'.repeat(200) })
        .expect(400);
    });
  });

  // -------------------------------------------------------------------------
  // The buyer's half
  // -------------------------------------------------------------------------

  describe('buyer commands', () => {
    /** An order the supplier has delivered, awaiting the buyer. */
    async function deliveredOrder() {
      const offerId = await publishOffer();
      const order = await placeOrder(offerId);

      await runUnscoped('the suite advances the order the saga would', () =>
        harness.prisma.client.$executeRawUnsafe(
          `UPDATE "order" SET status='FUNDS_HELD', economic_transaction_id=$2 WHERE id=$1`,
          order.body.id,
          `TXN_APITEST_${order.body.id}`,
        ),
      );
      await request(http)
        .post(`/v1/orders/${order.body.id}/confirm`)
        .set('authorization', `Bearer ${supplier(supplierOrg)}`)
        .set('idempotency-key', apiKey('api-c'))
        .send({})
        .expect(200);
      await request(http)
        .post(`/v1/orders/${order.body.id}/fulfill`)
        .set('authorization', `Bearer ${supplier(supplierOrg)}`)
        .set('idempotency-key', apiKey('api-f'))
        .send({})
        .expect(200);

      return order.body.id as string;
    }

    it('confirms receipt, which only the buying organization may do', async () => {
      const orderId = await deliveredOrder();

      // The supplier would be confirming their own delivery.
      await request(http)
        .post(`/v1/orders/${orderId}/confirm-receipt`)
        .set('authorization', `Bearer ${supplier(supplierOrg)}`)
        .set('idempotency-key', apiKey('api-sup-receipt'))
        .send({})
        .expect(403);

      // A platform operator was not there to witness it.
      await request(http)
        .post(`/v1/orders/${orderId}/confirm-receipt`)
        .set('authorization', `Bearer ${platformAdmin()}`)
        .set('idempotency-key', apiKey('api-ops-receipt'))
        .send({})
        .expect(403);

      const confirmed = await request(http)
        .post(`/v1/orders/${orderId}/confirm-receipt`)
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .set('idempotency-key', apiKey('api-receipt'))
        .send({})
        .expect(200);

      expect(confirmed.body.status).toBe('RECEIPT_CONFIRMED');
      expect(confirmed.body.receiptConfirmedAt).toBeTruthy();
    });

    it('raises a dispute and refuses a one-word reason with 400', async () => {
      const orderId = await deliveredOrder();

      await request(http)
        .post(`/v1/orders/${orderId}/disputes`)
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .set('idempotency-key', apiKey('api-short-reason'))
        .send({ reason: 'bad' })
        .expect(400);

      const disputed = await request(http)
        .post(`/v1/orders/${orderId}/disputes`)
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .set('idempotency-key', apiKey('api-dispute'))
        .send({ reason: 'the delivered part does not match the published offer' })
        .expect(200);

      expect(disputed.body.status).toBe('DISPUTED');
    });

    it('does not let the buyer walk out of their own dispute', async () => {
      // The transition table permits DISPUTED → RECEIPT_CONFIRMED because that
      // is how an operator resolves a dispute; the buyer's own command must not
      // travel the same edge.
      const orderId = await deliveredOrder();

      await request(http)
        .post(`/v1/orders/${orderId}/disputes`)
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .set('idempotency-key', apiKey('api-d2'))
        .send({ reason: 'the goods arrived damaged beyond use' })
        .expect(200);

      const escape = await request(http)
        .post(`/v1/orders/${orderId}/confirm-receipt`)
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .set('idempotency-key', apiKey('api-escape'))
        .send({})
        .expect(422);

      expect(escape.body.code).toBe('BUSINESS_RULE_VIOLATION');
    });

    it('cancels, reporting CANCELLING until the refund has happened', async () => {
      const offerId = await publishOffer();
      const order = await placeOrder(offerId);

      const cancelled = await request(http)
        .post(`/v1/orders/${order.body.id}/cancel`)
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .set('idempotency-key', apiKey('api-cancel'))
        .send({ reason: 'no longer needed' })
        .expect(200);

      expect(cancelled.body.status).toBe('CANCELLING');
    });

    it('refuses a cancellation reason that is too short with 400', async () => {
      const offerId = await publishOffer();
      const order = await placeOrder(offerId);

      await request(http)
        .post(`/v1/orders/${order.body.id}/cancel`)
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .set('idempotency-key', apiKey('api-short-cancel'))
        .send({ reason: 'x' })
        .expect(400);
    });
  });

  // -------------------------------------------------------------------------
  // Dispute resolution
  // -------------------------------------------------------------------------

  describe('POST /v1/orders/:id/disputes/resolve', () => {
    async function disputedOrder() {
      const offerId = await publishOffer();
      const order = await placeOrder(offerId);

      await runUnscoped('the suite advances the order the saga would', () =>
        harness.prisma.client.$executeRawUnsafe(
          `UPDATE "order" SET status='FUNDS_HELD', economic_transaction_id=$2 WHERE id=$1`,
          order.body.id,
          `TXN_APITEST_${order.body.id}`,
        ),
      );
      await request(http)
        .post(`/v1/orders/${order.body.id}/disputes`)
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .set('idempotency-key', apiKey('api-raise'))
        .send({ reason: 'the supplier has not delivered anything at all' })
        .expect(200);

      return order.body.id as string;
    }

    it('refuses either party with 403', async () => {
      const orderId = await disputedOrder();

      await request(http)
        .post(`/v1/orders/${orderId}/disputes/resolve`)
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .set('idempotency-key', apiKey('api-self-resolve'))
        .send({ outcome: 'SETTLE', resolution: 'I decided in my own favour here' })
        .expect(403);

      await request(http)
        .post(`/v1/orders/${orderId}/disputes/resolve`)
        .set('authorization', `Bearer ${supplier(supplierOrg)}`)
        .set('idempotency-key', apiKey('api-sup-resolve'))
        .send({ outcome: 'SETTLE', resolution: 'the supplier decides for themselves' })
        .expect(403);
    });

    it('resolves in the supplier’s favour, returning the order to the settlement path', async () => {
      const orderId = await disputedOrder();

      const resolved = await request(http)
        .post(`/v1/orders/${orderId}/disputes/resolve`)
        .set('authorization', `Bearer ${platformAdmin()}`)
        .set('idempotency-key', apiKey('api-resolve-settle'))
        .send({ outcome: 'SETTLE', resolution: 'the supplier evidenced correct delivery' })
        .expect(200);

      expect(resolved.body.status).toBe('RECEIPT_CONFIRMED');
    });

    it('resolves in the buyer’s favour, moving the order to compensation', async () => {
      const orderId = await disputedOrder();

      const resolved = await request(http)
        .post(`/v1/orders/${orderId}/disputes/resolve`)
        .set('authorization', `Bearer ${platformAdmin()}`)
        .set('idempotency-key', apiKey('api-resolve-refund'))
        .send({ outcome: 'REFUND', resolution: 'the goods were never delivered to the buyer' })
        .expect(200);

      expect(resolved.body.status).toBe('CANCELLING');
      expect(resolved.body.cancellationReason).toContain('never delivered');
    });

    it('refuses an outcome the platform does not have with 400', async () => {
      const orderId = await disputedOrder();

      await request(http)
        .post(`/v1/orders/${orderId}/disputes/resolve`)
        .set('authorization', `Bearer ${platformAdmin()}`)
        .set('idempotency-key', apiKey('api-bad-outcome'))
        .send({ outcome: 'SPLIT_THE_DIFFERENCE', resolution: 'a compromise nobody defined' })
        .expect(400);
    });

    it('refuses to resolve an order that has no dispute with 422', async () => {
      const offerId = await publishOffer();
      const order = await placeOrder(offerId);

      await request(http)
        .post(`/v1/orders/${order.body.id}/disputes/resolve`)
        .set('authorization', `Bearer ${platformAdmin()}`)
        .set('idempotency-key', apiKey('api-nothing-to-resolve'))
        .send({ outcome: 'SETTLE', resolution: 'resolving something never disputed' })
        .expect(422);
    });
  });

  // -------------------------------------------------------------------------
  // Reviews
  // -------------------------------------------------------------------------

  describe('POST /v1/orders/:id/reviews', () => {
    it('refuses a review before the order completed with 422', async () => {
      const offerId = await publishOffer();
      const order = await placeOrder(offerId);

      const response = await request(http)
        .post(`/v1/orders/${order.body.id}/reviews`)
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .set('idempotency-key', apiKey('api-early-review'))
        .send({ rating: 5 })
        .expect(422);

      expect(response.body.code).toBe('BUSINESS_RULE_VIOLATION');
    });

    it('refuses a rating outside one to five with 400', async () => {
      const offerId = await publishOffer();
      const order = await placeOrder(offerId);

      await request(http)
        .post(`/v1/orders/${order.body.id}/reviews`)
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .set('idempotency-key', apiKey('api-bad-rating'))
        .send({ rating: 9 })
        .expect(400);
    });

    it('accepts one review on a completed order and refuses a second', async () => {
      const offerId = await publishOffer();
      const order = await placeOrder(offerId);

      // Drive the order to COMPLETED the way the saga would, satisfying every
      // CHECK the table carries.
      await runUnscoped('the suite completes the order the saga would', () =>
        harness.prisma.client.$executeRawUnsafe(
          `UPDATE "order"
             SET status='COMPLETED',
                 economic_transaction_id=$2,
                 economic_settlement_id=$3,
                 receipt_confirmed_at=now(),
                 receipt_confirmed_by='USR-APITEST',
                 completed_at=now()
           WHERE id=$1`,
          order.body.id,
          `TXN_APITEST_${order.body.id}`,
          `STL_APITEST_${order.body.id}`,
        ),
      );

      const review = await request(http)
        .post(`/v1/orders/${order.body.id}/reviews`)
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .set('idempotency-key', apiKey('api-review'))
        .send({ rating: 4, comment: 'تحویل به‌موقع' })
        .expect(201);

      expect(review.body.rating).toBe(4);

      const second = await request(http)
        .post(`/v1/orders/${order.body.id}/reviews`)
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .set('idempotency-key', apiKey('api-review-2'))
        .send({ rating: 1 });

      expect(second.status).toBeGreaterThanOrEqual(400);
    });
  });

  // -------------------------------------------------------------------------
  // Service-to-service
  // -------------------------------------------------------------------------

  describe('internal callers', () => {
    it('refuses a service token on a route with no @AllowService', async () => {
      // Nothing on this controller is open to services: an order is placed by
      // a person, and the saga reaches the domain in-process rather than over
      // HTTP.
      const token = await internalToken('economic-service', { organizationId: buyerOrg });

      await request(http).get('/v1/orders').set('x-internal-token', token).expect(403);
    });

    it('refuses a token minted for another service with 401', async () => {
      const token = await internalToken('economic-service', {
        organizationId: buyerOrg,
        targetService: 'notification-service',
      });

      await request(http).get('/v1/orders').set('x-internal-token', token).expect(401);
    });

    it('refuses an expired token with 401', async () => {
      const token = await internalToken('economic-service', {
        organizationId: buyerOrg,
        ttlSeconds: -120,
      });

      await request(http).get('/v1/orders').set('x-internal-token', token).expect(401);
    });

    it('refuses a malformed token with 401', async () => {
      await request(http).get('/v1/orders').set('x-internal-token', 'not-a-token').expect(401);
    });
  });
});
