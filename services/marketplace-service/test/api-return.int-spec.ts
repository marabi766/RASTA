import request from 'supertest';
import type { Server } from 'node:http';
import { runUnscoped } from '@rasta/nest-common';
import {
  apiKey,
  apiTenant,
  auditor,
  buyer,
  platformAdmin,
  startApi,
  supplier,
  type ApiHarness,
} from './api-helpers';
import { asActor, cleanup, key, outboxFor, wire } from './helpers';

/**
 * The return-request HTTP surface and its database (RUN-005, ADR-048), every path including the
 * refusals: success, invalid input (400), no token (401), wrong role or party (403), another
 * tenant (404), and the lifecycle's own refusals (422).
 *
 * What these prove that the unit tests cannot: the trigger refuses a move the code forgot, one key
 * files one request, two concurrent decisions leave one event, and a stranger learns nothing.
 */
describe('return request API', () => {
  let harness: ApiHarness;
  let http: Server;

  const buyerOrg = apiTenant('RET-BUY');
  const supplierOrg = apiTenant('RET-SUP');
  const strangerOrg = apiTenant('RET-OTH');

  beforeAll(async () => {
    // The window is a business fact nobody has decided (Q-132): the service refuses without one,
    // so the suite opts in the way a deployment would.
    process.env.MARKETPLACE_RETURN_WINDOW_DAYS = '30';
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    delete process.env.MARKETPLACE_RETURN_WINDOW_DAYS;
    await cleanup(harness.prisma, [buyerOrg, supplierOrg, strangerOrg]);
    await harness.close();
  });

  const as = (token: string) => ({ authorization: `Bearer ${token}` });

  async function publishOffer(): Promise<string> {
    const product = await request(http)
      .post('/v1/products')
      .set('idempotency-key', apiKey('catalogue'))
      .set(as(supplier(supplierOrg)))
      .send({
        sku: `RET-SKU-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`,
        name: 'قطعه یدکی آزمایشی',
        category: 'PARTS',
        kind: 'GOOD',
        unit: 'عدد',
      })
      .expect(201);
    const offer = await request(http)
      .post('/v1/offers')
      .set('idempotency-key', apiKey('catalogue'))
      .set(as(supplier(supplierOrg)))
      .send({
        productId: product.body.id,
        unitPriceMinor: '250000',
        currency: 'IRR',
        availableQuantity: 50,
        leadTimeDays: 3,
        minimumQuantity: 1,
        publish: true,
      })
      .expect(201);
    return offer.body.id as string;
  }

  /** An order of `quantity` units, driven to COMPLETED the way the saga would. */
  async function completedOrder(
    quantity = 3,
    completedDaysAgo = 1,
  ): Promise<{ orderId: string; lineId: string }> {
    const offerId = await publishOffer();
    const order = await request(http)
      .post('/v1/orders')
      .set(as(buyer(buyerOrg)))
      .set('idempotency-key', apiKey('ret-order'))
      .send({ lines: [{ offerId, quantity }] })
      .expect(201);
    const orderId = order.body.id as string;
    await runUnscoped('the suite completes the order the saga would', () =>
      harness.prisma.client.$executeRawUnsafe(
        `UPDATE "order"
            SET status='COMPLETED',
                economic_transaction_id=$2,
                economic_settlement_id=$3,
                receipt_confirmed_at=now() - ($4 || ' days')::interval,
                receipt_confirmed_by='USR-APITEST',
                completed_at=now() - ($4 || ' days')::interval
          WHERE id=$1`,
        orderId,
        `TXN_APITEST_${orderId}`,
        `STL_APITEST_${orderId}`,
        String(completedDaysAgo),
      ),
    );
    return { orderId, lineId: order.body.lines[0].id as string };
  }

  const ask = (
    orderId: string,
    lineId: string,
    quantity = 1,
    token = buyer(buyerOrg),
    idempotencyKey = apiKey('ret-ask'),
  ) =>
    request(http)
      .post(`/v1/orders/${orderId}/returns`)
      .set(as(token))
      .set('idempotency-key', idempotencyKey)
      .send({
        reason: 'قطعه با مشخصات سفارش مطابقت ندارد',
        lines: [{ orderLineId: lineId, quantity }],
      });

  const decide = (
    id: string,
    command: 'authorize' | 'reject' | 'cancel',
    token: string,
    idempotencyKey = apiKey(`ret-${command}`),
  ) => {
    const call =
      command === 'cancel'
        ? request(http).post(`/v1/returns/${id}/cancellation`)
        : request(http)
            .post(`/v1/returns/${id}/decisions`)
            .send({ decision: command === 'authorize' ? 'AUTHORIZE' : 'REJECT' });
    return call.set(as(token)).set('idempotency-key', idempotencyKey);
  };

  const eventsOf = async (org: string, returnId: string) =>
    (await outboxFor(harness.prisma, org)).filter((event) => event.aggregateId === returnId);

  // -------------------------------------------------------------------------
  // Asking
  // -------------------------------------------------------------------------

  describe('POST /v1/returns', () => {
    it('files a REQUESTED return for a completed order and publishes it once', async () => {
      const { orderId, lineId } = await completedOrder();

      const response = await ask(orderId, lineId, 2).expect(201);

      expect(response.body).toMatchObject({
        orderId,
        status: 'REQUESTED',
        version: 1,
        buyerOrganizationId: buyerOrg,
        supplierOrganizationId: supplierOrg,
        lines: [{ orderLineId: lineId, quantity: 2 }],
        authorizedAt: null,
      });
      const events = await eventsOf(buyerOrg, response.body.id);
      expect(events.map((event) => event.eventName)).toEqual(['RETURN_REQUESTED']);
      // The buyer's free text is the supplier's to read, never an event's.
      expect(JSON.stringify(events[0]?.payload)).not.toContain('مطابقت');
    });

    it('answers a retry of the same key with the same request and files nothing twice', async () => {
      const { orderId, lineId } = await completedOrder();
      const idempotencyKey = apiKey('ret-retry');

      const first = await ask(orderId, lineId, 1, buyer(buyerOrg), idempotencyKey).expect(201);
      const second = await ask(orderId, lineId, 1, buyer(buyerOrg), idempotencyKey).expect(201);

      expect(second.body.id).toBe(first.body.id);
      const listed = await request(http)
        .get('/v1/returns')
        .query({ orderId })
        .set(as(buyer(buyerOrg)))
        .expect(200);
      expect(listed.body.items).toHaveLength(1);
      expect(await eventsOf(buyerOrg, first.body.id)).toHaveLength(1);
    });

    it('refuses the same key with another body with 409', async () => {
      const { orderId, lineId } = await completedOrder();
      const idempotencyKey = apiKey('ret-reuse');
      await ask(orderId, lineId, 1, buyer(buyerOrg), idempotencyKey).expect(201);

      const response = await ask(orderId, lineId, 2, buyer(buyerOrg), idempotencyKey).expect(409);

      expect(response.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('never lets requests take more than the order sold, in total', async () => {
      const { orderId, lineId } = await completedOrder(3);
      await ask(orderId, lineId, 2).expect(201);

      const response = await ask(orderId, lineId, 2).expect(422);
      expect(response.body.code).toBe('BUSINESS_RULE_VIOLATION');

      await ask(orderId, lineId, 1).expect(201);
    });

    it('lets two concurrent requests take the last unit only once', async () => {
      const { orderId, lineId } = await completedOrder(1);

      const results = await Promise.all([ask(orderId, lineId, 1), ask(orderId, lineId, 1)]);

      expect(results.map((result) => result.status).sort()).toEqual([201, 422]);
    });

    it('refuses an order that is not COMPLETED with 422', async () => {
      const offerId = await publishOffer();
      const order = await request(http)
        .post('/v1/orders')
        .set(as(buyer(buyerOrg)))
        .set('idempotency-key', apiKey('ret-pending'))
        .send({ lines: [{ offerId, quantity: 1 }] })
        .expect(201);

      await ask(order.body.id, order.body.lines[0].id).expect(422);
    });

    it('refuses once the window has elapsed, counted from completion', async () => {
      const { orderId, lineId } = await completedOrder(1, 31);

      const response = await ask(orderId, lineId).expect(422);

      expect(response.body.message).toMatch(/30-day return window/);
    });

    it('is closed while no window is configured (Q-132): no number is invented', async () => {
      const { orderId, lineId } = await completedOrder(1);
      const wiring = wire(harness.prisma, { MARKETPLACE_RETURN_WINDOW_DAYS: undefined });

      await expect(
        asActor({ organizationId: buyerOrg, roles: ['PROCUREMENT_USER'] }, () =>
          wiring.returns.request(
            orderId,
            {
              reason: 'قطعه با مشخصات سفارش مطابقت ندارد',
              lines: [{ orderLineId: lineId, quantity: 1 }],
            },
            key('ret-closed'),
          ),
        ),
      ).rejects.toThrow(/no return window is configured/);
    });

    it('refuses a body naming a status, a price or a refund with 400', async () => {
      const { orderId, lineId } = await completedOrder();

      for (const extra of [
        { status: 'AUTHORIZED' },
        { refundAmountMinor: '1' },
        { orderId: 'ORD_01JBQ0000000000000000000AB' },
      ]) {
        const response = await request(http)
          .post(`/v1/orders/${orderId}/returns`)
          .set(as(buyer(buyerOrg)))
          .set('idempotency-key', apiKey('ret-extra'))
          .send({
            reason: 'قطعه با مشخصات سفارش مطابقت ندارد',
            lines: [{ orderLineId: lineId, quantity: 1 }],
            ...extra,
          })
          .expect(400);
        expect(response.body.code).toBe('VALIDATION_FAILED');
      }
    });

    it('refuses a line that is not of the order with 400', async () => {
      const { orderId } = await completedOrder();
      const other = await completedOrder();

      await ask(orderId, other.lineId).expect(400);
    });

    it('refuses a request with no Idempotency-Key with 400', async () => {
      const { orderId, lineId } = await completedOrder();

      await request(http)
        .post(`/v1/orders/${orderId}/returns`)
        .set(as(buyer(buyerOrg)))
        .send({
          reason: 'قطعه با مشخصات سفارش مطابقت ندارد',
          lines: [{ orderLineId: lineId, quantity: 1 }],
        })
        .expect(400);
    });

    it('refuses no token with 401', async () => {
      await request(http)
        .post('/v1/orders/ORD_01JBQ0000000000000000000AB/returns')
        .set('idempotency-key', apiKey('x'))
        .send({})
        .expect(401);
      await request(http).get('/v1/returns').expect(401);
    });

    it('answers the supplier 403, a stranger 404, an auditor 403', async () => {
      const { orderId, lineId } = await completedOrder();

      await ask(orderId, lineId, 1, supplier(supplierOrg)).expect(403);
      await ask(orderId, lineId, 1, buyer(strangerOrg)).expect(404);
      await ask(orderId, lineId, 1, auditor(buyerOrg)).expect(403);
    });
  });

  // -------------------------------------------------------------------------
  // Deciding and withdrawing
  // -------------------------------------------------------------------------

  describe('the lifecycle', () => {
    async function requested() {
      const { orderId, lineId } = await completedOrder();
      const response = await ask(orderId, lineId, 1).expect(201);
      return response.body.id as string;
    }

    it('REQUESTED → AUTHORIZED by the supplier, with its event and its history', async () => {
      const id = await requested();

      const response = await decide(id, 'authorize', supplier(supplierOrg)).expect(200);

      expect(response.body).toMatchObject({ status: 'AUTHORIZED', version: 2 });
      expect(response.body.authorizedAt).not.toBeNull();
      expect((await eventsOf(buyerOrg, id)).map((event) => event.eventName)).toEqual([
        'RETURN_REQUESTED',
        'RETURN_AUTHORIZED',
      ]);
      const history = await runUnscoped('the suite reads the history', () =>
        harness.prisma.client.returnStatusHistory.findMany({
          where: { returnRequestId: id },
          orderBy: { version: 'asc' },
        }),
      );
      expect(history.map((row) => [row.fromStatus, row.toStatus, row.version])).toEqual([
        [null, 'REQUESTED', 1],
        ['REQUESTED', 'AUTHORIZED', 2],
      ]);
      expect(history.every((row) => row.actorId && row.correlationId)).toBe(true);
    });

    it('replays an authorize under its own key and does nothing a second time', async () => {
      const id = await requested();
      const idempotencyKey = apiKey('ret-auth-replay');

      await decide(id, 'authorize', supplier(supplierOrg), idempotencyKey).expect(200);
      const replay = await decide(id, 'authorize', supplier(supplierOrg), idempotencyKey).expect(
        200,
      );

      expect(replay.body.status).toBe('AUTHORIZED');
      expect(await eventsOf(buyerOrg, id)).toHaveLength(2);
    });

    it('refuses the same key reused on another return with 409', async () => {
      const first = await requested();
      const second = await requested();
      const idempotencyKey = apiKey('ret-key-reuse');
      await decide(first, 'authorize', supplier(supplierOrg), idempotencyKey).expect(200);

      await decide(second, 'authorize', supplier(supplierOrg), idempotencyKey).expect(409);
    });

    it('refuses the same key for the other decision with 409, never the first answer', async () => {
      const id = await requested();
      const idempotencyKey = apiKey('ret-other-decision');
      await decide(id, 'authorize', supplier(supplierOrg), idempotencyKey).expect(200);

      await decide(id, 'reject', supplier(supplierOrg), idempotencyKey).expect(409);
    });

    it('lets two concurrent decisions through once: one 200, one 422, one event', async () => {
      const id = await requested();

      const results = await Promise.all([
        decide(id, 'authorize', supplier(supplierOrg)),
        decide(id, 'reject', supplier(supplierOrg)),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual([200, 422]);
      expect(await eventsOf(buyerOrg, id)).toHaveLength(2);
    });

    it('REJECTED is final: nothing reopens it', async () => {
      const id = await requested();
      await decide(id, 'reject', supplier(supplierOrg)).expect(200);

      await decide(id, 'authorize', supplier(supplierOrg)).expect(422);
      await decide(id, 'cancel', buyer(buyerOrg)).expect(422);
    });

    it('an AUTHORIZED return cannot be rejected, but the buyer may withdraw it (version 3)', async () => {
      const id = await requested();
      await decide(id, 'authorize', supplier(supplierOrg)).expect(200);

      await decide(id, 'reject', supplier(supplierOrg)).expect(422);
      const cancelled = await decide(id, 'cancel', buyer(buyerOrg)).expect(200);

      expect(cancelled.body).toMatchObject({
        status: 'CANCELLED',
        version: 3,
        cancelledFrom: 'AUTHORIZED',
      });
      await decide(id, 'cancel', buyer(buyerOrg)).expect(422);
    });

    it('a cancelled quantity is free to be asked for again', async () => {
      const { orderId, lineId } = await completedOrder(1);
      const first = await ask(orderId, lineId, 1).expect(201);
      await ask(orderId, lineId, 1).expect(422);
      await decide(first.body.id, 'cancel', buyer(buyerOrg)).expect(200);

      await ask(orderId, lineId, 1).expect(201);
    });

    it('has no refund route: a return status is not a refund (ADR-048 § 3)', async () => {
      const id = await requested();
      await decide(id, 'authorize', supplier(supplierOrg)).expect(200);

      await request(http)
        .post(`/v1/returns/${id}/refund`)
        .set(as(platformAdmin()))
        .set('idempotency-key', apiKey('ret-refund'))
        .expect(404);
    });
  });

  // -------------------------------------------------------------------------
  // BOLA
  // -------------------------------------------------------------------------

  describe('object-level authorization', () => {
    it('hides a return from a stranger on read, list and every command (404, never 403)', async () => {
      const { orderId, lineId } = await completedOrder();
      const id = (await ask(orderId, lineId).expect(201)).body.id as string;
      const stranger = buyer(strangerOrg);

      await request(http).get(`/v1/returns/${id}`).set(as(stranger)).expect(404);
      await decide(id, 'cancel', stranger).expect(404);
      await decide(id, 'authorize', supplier(strangerOrg)).expect(404);
      await decide(id, 'reject', supplier(strangerOrg)).expect(404);

      for (const role of ['BUYER', 'SUPPLIER']) {
        const listed = await request(http)
          .get('/v1/returns')
          .query({ role, orderId })
          .set(as(stranger))
          .expect(200);
        expect(listed.body.items).toEqual([]);
      }
    });

    it('answers a party on the wrong side 403: the buyer cannot decide, the supplier cannot withdraw', async () => {
      const { orderId, lineId } = await completedOrder();
      const id = (await ask(orderId, lineId).expect(201)).body.id as string;

      await decide(id, 'authorize', buyer(buyerOrg)).expect(403);
      await decide(id, 'reject', buyer(buyerOrg)).expect(403);
      await decide(id, 'cancel', supplier(supplierOrg)).expect(403);

      const unchanged = await request(http)
        .get(`/v1/returns/${id}`)
        .set(as(buyer(buyerOrg)))
        .expect(200);
      expect(unchanged.body.status).toBe('REQUESTED');
    });

    it('lets each party read it and the supplier list its own', async () => {
      const { orderId, lineId } = await completedOrder();
      const id = (await ask(orderId, lineId).expect(201)).body.id as string;

      await request(http)
        .get(`/v1/returns/${id}`)
        .set(as(buyer(buyerOrg)))
        .expect(200);
      await request(http)
        .get(`/v1/returns/${id}`)
        .set(as(supplier(supplierOrg)))
        .expect(200);
      const listed = await request(http)
        .get('/v1/returns')
        .query({ role: 'SUPPLIER', orderId })
        .set(as(supplier(supplierOrg)))
        .expect(200);
      expect(listed.body.items.map((item: { id: string }) => item.id)).toEqual([id]);
    });

    it('re-authorizes a replay: a stranger holding the key learns nothing', async () => {
      const { orderId, lineId } = await completedOrder();
      const id = (await ask(orderId, lineId).expect(201)).body.id as string;
      const idempotencyKey = apiKey('ret-stolen');
      await decide(id, 'authorize', supplier(supplierOrg), idempotencyKey).expect(200);

      const replay = await decide(id, 'authorize', supplier(strangerOrg), idempotencyKey);
      expect([403, 404, 409]).toContain(replay.status);
      // Not the stored response: nothing of the request but the id the caller itself sent.
      expect(replay.body.status).toBeUndefined();
      expect(replay.body.buyerOrganizationId).toBeUndefined();
      expect(JSON.stringify(replay.body)).not.toContain(buyerOrg);
    });
  });

  // -------------------------------------------------------------------------
  // The database says the same thing
  // -------------------------------------------------------------------------

  describe('the database keeps the lifecycle', () => {
    async function rejectedReturn() {
      const { orderId, lineId } = await completedOrder();
      const id = (await ask(orderId, lineId).expect(201)).body.id as string;
      await decide(id, 'reject', supplier(supplierOrg)).expect(200);
      return id;
    }

    it('refuses to reopen a REJECTED request even for a write path that forgot the state machine', async () => {
      const id = await rejectedReturn();

      await expect(
        runUnscoped('the suite attempts the forbidden move', () =>
          harness.prisma.client.$executeRawUnsafe(
            `UPDATE return_request
                SET status='AUTHORIZED', version=3, authorized_at=now(), authorized_by='X', rejected_at=NULL, rejected_by=NULL
              WHERE id=$1`,
            id,
          ),
        ),
      ).rejects.toThrow(/ck_return_request|check/i);
    });

    it('refuses to delete a request, a line or a history row', async () => {
      const id = await rejectedReturn();

      for (const table of ['return_status_history', 'return_line', 'return_request']) {
        const column = table === 'return_request' ? 'id' : 'return_request_id';
        await expect(
          runUnscoped('the suite attempts the forbidden delete', () =>
            harness.prisma.client.$executeRawUnsafe(`DELETE FROM ${table} WHERE ${column}=$1`, id),
          ),
        ).rejects.toThrow();
      }
    });

    it('refuses a skipped step: a status without its history row never commits', async () => {
      const id = await rejectedReturn();
      // Move a REQUESTED request without writing the history the trigger demands at commit.
      const { orderId, lineId } = await completedOrder();
      const open = (await ask(orderId, lineId).expect(201)).body.id as string;

      await expect(
        runUnscoped('the suite skips the history row', () =>
          harness.prisma.client.$executeRawUnsafe(
            `UPDATE return_request
                SET status='AUTHORIZED', version=2, authorized_at=now(), authorized_by='X', updated_at=now()
              WHERE id=$1`,
            open,
          ),
        ),
      ).rejects.toThrow(/ck_return_request_tracked|history/i);
      expect(id).toBeTruthy();
    });
  });
});
