import { createHash } from 'node:crypto';
import request from 'supertest';
import type { Server } from 'node:http';
import { runUnscoped } from '@rasta/nest-common';
import {
  apiKey,
  apiTenant,
  buyer,
  internalToken,
  startApi,
  supplier,
  type ApiHarness,
} from './api-helpers';
import { cleanup, id, outboxFor } from './helpers';

/**
 * The return request's internal routes, for the service that records its goods, and the boundary
 * they set: once inventory has reserved a dispatch, the buyer cannot cancel (Codex r1 on #336,
 * findings 1 and 2; ADR-061 § 4; Q-133 (5)).
 *
 * What these prove that the unit tests cannot: who may ask (only inventory-service's token, signed
 * for the supplier), that every other organization learns nothing, that the reservation and a
 * cancellation meet on the request's row lock — each waits for the other and is judged by what it
 * finds after the wait — and that the database refuses what the code would.
 */
describe('return request: internal dispatch routes and the cancellation boundary', () => {
  let harness: ApiHarness;
  let http: Server;
  /** inventory-service's token, signed for the supplier: the one caller these routes answer. */
  let asInventory: string;

  const buyerOrg = apiTenant('RDS-BUY');
  const supplierOrg = apiTenant('RDS-SUP');
  const strangerOrg = apiTenant('RDS-OTH');

  beforeAll(async () => {
    process.env.MARKETPLACE_RETURN_WINDOW_DAYS = '30';
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
    asInventory = await internalToken('inventory-service', { organizationId: supplierOrg });
  });

  afterAll(async () => {
    delete process.env.MARKETPLACE_RETURN_WINDOW_DAYS;
    await cleanup(harness.prisma, [buyerOrg, supplierOrg, strangerOrg]);
    await harness.close();
  });

  const as = (token: string) => ({ authorization: `Bearer ${token}` });

  async function completedOrder(quantity = 3): Promise<{ orderId: string; lineId: string }> {
    const product = await request(http)
      .post('/v1/products')
      .set('idempotency-key', apiKey('catalogue'))
      .set(as(supplier(supplierOrg)))
      .send({
        sku: `RDS-SKU-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`,
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
    const order = await request(http)
      .post('/v1/orders')
      .set(as(buyer(buyerOrg)))
      .set('idempotency-key', apiKey('rds-order'))
      .send({ lines: [{ offerId: offer.body.id, quantity }] })
      .expect(201);
    const orderId = order.body.id as string;
    await runUnscoped('the suite completes the order the saga would', () =>
      harness.prisma.client.$executeRawUnsafe(
        `UPDATE "order"
            SET status='COMPLETED',
                economic_transaction_id=$2,
                economic_settlement_id=$3,
                receipt_confirmed_at=now() - interval '1 day',
                receipt_confirmed_by='USR-APITEST',
                completed_at=now() - interval '1 day'
          WHERE id=$1`,
        orderId,
        `TXN_APITEST_${orderId}`,
        `STL_APITEST_${orderId}`,
      ),
    );
    return { orderId, lineId: order.body.lines[0].id as string };
  }

  const ask = (orderId: string, lineId: string, quantity: number) =>
    request(http)
      .post(`/v1/orders/${orderId}/returns`)
      .set(as(buyer(buyerOrg)))
      .set('idempotency-key', apiKey('rds-ask'))
      .send({
        reason: 'قطعه با مشخصات سفارش مطابقت ندارد',
        lines: [{ orderLineId: lineId, quantity }],
      });

  /** A return of `quantity` of a fresh 3-unit order, REQUESTED or (by default) AUTHORIZED. */
  async function aReturn(authorized = true, quantity = 3) {
    const { orderId, lineId } = await completedOrder();
    const asked = await ask(orderId, lineId, quantity).expect(201);
    const returnId = asked.body.id as string;
    if (authorized) {
      await request(http)
        .post(`/v1/returns/${returnId}/decisions`)
        .set(as(supplier(supplierOrg)))
        .set('idempotency-key', apiKey('rds-auth'))
        .send({ decision: 'AUTHORIZE' })
        .expect(200);
    }
    return { orderId, lineId, returnId };
  }

  const cancel = (returnId: string, expectedStatus: 'REQUESTED' | 'AUTHORIZED' = 'AUTHORIZED') =>
    request(http)
      .post(`/v1/returns/${returnId}/cancellation`)
      .set(as(buyer(buyerOrg)))
      .set('idempotency-key', apiKey('rds-cancel'))
      .send({ expectedStatus });

  /** inventory-service's token, signed for `organizationId` — or, with `null`, for none. */
  const inventoryFor = (organizationId: string | null) =>
    internalToken('inventory-service', organizationId === null ? {} : { organizationId });

  const readInternal = (returnId: string, token = asInventory) =>
    request(http).get(`/v1/internal/returns/${returnId}`).set('x-internal-token', token);
  const reserve = (returnId: string, token = asInventory) =>
    request(http)
      .post(`/v1/internal/returns/${returnId}/dispatch-reservation`)
      .set('x-internal-token', token);

  /** The request's row as the database holds it, past the tenant guard. */
  const stored = async (returnId: string) => {
    const [row] = await runUnscoped(
      'the suite reads the stored request',
      () =>
        harness.prisma.client.$queryRaw<
          {
            status: string;
            version: number;
            dispatch_reserved_at: Date | null;
            dispatch_reserved_by: string | null;
            history: number;
          }[]
        >`SELECT r.status, r.version, r.dispatch_reserved_at, r.dispatch_reserved_by,
               (SELECT count(*)::int FROM return_status_history h WHERE h.return_request_id = r.id) AS history
          FROM return_request r WHERE r.id = ${returnId}`,
    );
    return row;
  };

  // -------------------------------------------------------------------------
  // GET /v1/internal/returns/{id}
  // -------------------------------------------------------------------------

  describe('GET /v1/internal/returns/{id}', () => {
    it('states the request to inventory-service signed for its supplier — ids, status and lines, never the reason', async () => {
      const { orderId, lineId, returnId } = await aReturn(true, 2);

      const response = await readInternal(returnId).expect(200);

      expect(response.body).toEqual({
        returnRequestId: returnId,
        orderId,
        buyerOrganizationId: buyerOrg,
        supplierOrganizationId: supplierOrg,
        status: 'AUTHORIZED',
        lines: [{ orderLineId: lineId, productId: expect.any(String), quantity: 2 }],
        dispatchReservationId: null,
        dispatchReservedAt: null,
        partialDispatchAllowed: false,
      });
      expect(JSON.stringify(response.body)).not.toContain('مطابقت');
    });

    it('answers 404 for a request of any other supplier — its buyer included — exactly as for one that does not exist', async () => {
      const { returnId } = await aReturn();

      for (const token of [await inventoryFor(buyerOrg), await inventoryFor(strangerOrg)]) {
        const refused = await readInternal(returnId, token).expect(404);
        expect(refused.body).toMatchObject({
          code: 'NOT_FOUND',
          message: 'ReturnRequest not found',
        });
      }
      const missing = await readInternal(id('RET'), asInventory).expect(404);
      expect(missing.body).toMatchObject({ code: 'NOT_FOUND', message: 'ReturnRequest not found' });
    });

    it('refuses with 403 every user token, every other service, and a token signed for no organization', async () => {
      const { returnId } = await aReturn();

      await request(http)
        .get(`/v1/internal/returns/${returnId}`)
        .set(as(supplier(supplierOrg)))
        .expect(403);
      await readInternal(
        returnId,
        await internalToken('economic-service', { organizationId: supplierOrg }),
      ).expect(403);
      await readInternal(returnId, await inventoryFor(null)).expect(403);
      await request(http).get(`/v1/internal/returns/${returnId}`).expect(401);
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/internal/returns/{id}/dispatch-reservation
  // -------------------------------------------------------------------------

  describe('POST /v1/internal/returns/{id}/dispatch-reservation', () => {
    it('reserves an AUTHORIZED request once — no status, version, history or event moves — and says so to both parties', async () => {
      const { returnId } = await aReturn();
      const eventsBefore = (await outboxFor(harness.prisma, buyerOrg)).length;

      const first = await reserve(returnId).expect(200);
      const again = await reserve(returnId).expect(200);

      expect(first.body).toMatchObject({ returnRequestId: returnId, status: 'AUTHORIZED' });
      expect(first.body.dispatchReservedAt).toEqual(expect.any(String));
      expect(first.body.dispatchReservationId).toMatch(/^RDR_[0-9A-HJKMNP-TV-Z]{26}$/);
      // Idempotent: the reservation stands as first written, under the same id.
      expect(again.body.dispatchReservedAt).toBe(first.body.dispatchReservedAt);
      expect(again.body.dispatchReservationId).toBe(first.body.dispatchReservationId);
      expect(await stored(returnId)).toEqual({
        status: 'AUTHORIZED',
        version: 2,
        dispatch_reserved_at: new Date(first.body.dispatchReservedAt),
        dispatch_reserved_by: 'inventory-service',
        history: 2,
      });
      expect((await outboxFor(harness.prisma, buyerOrg)).length).toBe(eventsBefore);
      for (const token of [buyer(buyerOrg), supplier(supplierOrg)]) {
        const view = await request(http).get(`/v1/returns/${returnId}`).set(as(token)).expect(200);
        expect(view.body.dispatchReservedAt).toBe(first.body.dispatchReservedAt);
      }
    });

    const inStatus: Record<'REQUESTED' | 'REJECTED' | 'CANCELLED', () => Promise<string>> = {
      REQUESTED: async () => (await aReturn(false)).returnId,
      REJECTED: async () => {
        const { returnId } = await aReturn(false);
        await request(http)
          .post(`/v1/returns/${returnId}/decisions`)
          .set(as(supplier(supplierOrg)))
          .set('idempotency-key', apiKey('rds-reject'))
          .send({ decision: 'REJECT' })
          .expect(200);
        return returnId;
      },
      CANCELLED: async () => {
        const { returnId } = await aReturn(true);
        await cancel(returnId).expect(200);
        return returnId;
      },
    };

    it.each(['REQUESTED', 'REJECTED', 'CANCELLED'] as const)(
      'refuses a %s request with 422 and writes nothing',
      async (status) => {
        const returnId = await inStatus[status]();

        const refused = await reserve(returnId).expect(422);

        expect(refused.body.code).toBe('BUSINESS_RULE_VIOLATION');
        expect(await stored(returnId)).toMatchObject({ status, dispatch_reserved_at: null });
      },
    );

    it('answers 404 to a token signed for the buyer or a stranger, and reserves nothing', async () => {
      const { returnId } = await aReturn();

      await reserve(returnId, await inventoryFor(buyerOrg)).expect(404);
      await reserve(returnId, await inventoryFor(strangerOrg)).expect(404);
      await reserve(
        returnId,
        await internalToken('economic-service', { organizationId: supplierOrg }),
      ).expect(403);

      expect((await stored(returnId))?.dispatch_reserved_at).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // The boundary: no cancellation once the dispatch is reserved
  // -------------------------------------------------------------------------

  describe('cancellation after the dispatch is reserved (Q-133 (5))', () => {
    it('refuses it with 422 RETURN_DISPATCH_RESERVED while the request still reads AUTHORIZED — and its units stay taken', async () => {
      const { orderId, lineId, returnId } = await aReturn(true, 3);
      await reserve(returnId).expect(200);

      const refused = await cancel(returnId).expect(422);

      expect(refused.body.code).toBe('BUSINESS_RULE_VIOLATION');
      expect(refused.body.details).toEqual([
        expect.objectContaining({ path: 'returnRequest', code: 'RETURN_DISPATCH_RESERVED' }),
      ]);
      expect(await stored(returnId)).toMatchObject({
        status: 'AUTHORIZED',
        version: 2,
        history: 2,
      });
      // The three units are on their way back: none may be asked for again.
      const second = await ask(orderId, lineId, 1).expect(422);
      expect(second.body.code).toBe('BUSINESS_RULE_VIOLATION');
    });

    it('control: an AUTHORIZED request nobody reserved is still cancelled by its buyer, once inventory says it holds no shipment', async () => {
      const { returnId } = await aReturn();

      await cancel(returnId).expect(200);

      expect(await stored(returnId)).toMatchObject({ status: 'CANCELLED', version: 3 });
      expect(
        harness.inventory.calls.filter((call) => call.path.includes(returnId)).map((c) => c.method),
      ).toEqual(['GET']);
    });

    it('is refused by the database too: a reserved request is not cancelled, and a reservation is not undone or moved', async () => {
      const { returnId } = await aReturn();
      await reserve(returnId).expect(200);
      const raw = (sql: string) =>
        runUnscoped('the suite writes past the service', () =>
          harness.prisma.client.$executeRawUnsafe(sql, returnId),
        );

      await expect(
        raw(`UPDATE return_request SET status='CANCELLED', version=3, cancelled_at=now(),
                    cancelled_by='USR-RAW', cancelled_from='AUTHORIZED' WHERE id=$1`),
      ).rejects.toThrow(/ck_return_request_cancel_after_dispatch/);
      // Undone only beside its reconciliation record (Q-133 (9)(a)) — never by a bare write.
      await expect(
        raw(`UPDATE return_request SET dispatch_reservation_id=NULL, dispatch_reserved_at=NULL,
                    dispatch_reserved_by=NULL, dispatch_reserved_correlation_id=NULL WHERE id=$1`),
      ).rejects.toThrow(/ck_return_request_release_reconciled/);
      await expect(
        raw(`UPDATE return_request SET dispatch_reserved_by='someone-else' WHERE id=$1`),
      ).rejects.toThrow(/ck_return_request_terms_immutable/);
      await expect(
        raw(`UPDATE return_request SET dispatch_reservation_id='RDR_01JABCDEFGHJKMNPQRSTVWXYZ0'
              WHERE id=$1`),
      ).rejects.toThrow(/ck_return_request_terms_immutable/);
    });

    it('is refused by the database for a request that is not AUTHORIZED, and alongside a move', async () => {
      const { returnId: requested } = await aReturn(false);
      const raw = (sql: string, target: string) =>
        runUnscoped('the suite writes past the service', () =>
          harness.prisma.client.$executeRawUnsafe(sql, target),
        );
      const reservation = `dispatch_reservation_id='RDR_01JABCDEFGHJKMNPQRSTVWXYZ0',
                           dispatch_reserved_at=now(), dispatch_reserved_by='inventory-service',
                           dispatch_reserved_correlation_id='raw'`;

      await expect(
        raw(`UPDATE return_request SET ${reservation} WHERE id=$1`, requested),
      ).rejects.toThrow(/ck_return_request_transition/);
      await expect(
        raw(
          `UPDATE return_request SET ${reservation}, status='AUTHORIZED', version=2,
                  authorized_at=now(), authorized_by='USR-RAW' WHERE id=$1`,
          requested,
        ),
      ).rejects.toThrow(/ck_return_request_reservation_alone/);
      expect((await stored(requested))?.dispatch_reserved_at).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Dispatch against cancellation: one row lock, judged after the wait
  // -------------------------------------------------------------------------

  describe('a reservation and a cancellation at the same time', () => {
    /**
     * Holds the request's row in another transaction, which runs `write` once the competing
     * command is seen waiting for that row, then commits. Returns whether it was seen waiting.
     */
    async function whileHeld(
      returnId: string,
      competing: () => Promise<request.Response>,
      write: (tx: {
        $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number>;
      }) => Promise<void>,
    ): Promise<{ waited: boolean; response: request.Response }> {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (locked = resolve));
      const holder = runUnscoped('a competing transaction holding the request row', () =>
        harness.prisma.client.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM "return_request" WHERE id = ${returnId} FOR UPDATE`;
            locked();
            await gate;
            await write(tx);
          },
          { timeout: 30_000 },
        ),
      );
      await held;

      // `.then` sends it: a supertest request is not sent until something waits on it.
      const pending = competing().then((response) => response);
      // `ReturnRepository.lockRequest`'s read, waiting on the held row.
      const waiters = async () => {
        const [row] = await runUnscoped(
          'the suite reads lock waits',
          () =>
            harness.prisma.client.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE wait_event_type = 'Lock'
               AND query LIKE '%dispatch_reserved_correlation_id, updated_at%'`,
        );
        return row?.n ?? 0;
      };
      let waited = false;
      try {
        for (let elapsed = 0; elapsed <= 10_000 && !waited; elapsed += 20) {
          waited = (await waiters()) > 0;
          if (!waited) await new Promise((settle) => setTimeout(settle, 20));
        }
      } finally {
        release();
        await holder;
      }
      return { waited, response: await pending };
    }

    it('a reservation waiting on a cancellation is refused once the cancellation commits', async () => {
      const { returnId } = await aReturn();

      const { waited, response } = await whileHeld(
        returnId,
        () => reserve(returnId),
        async (tx) => {
          // What `ReturnService.decide` writes for a cancellation from AUTHORIZED.
          await tx.$executeRawUnsafe(
            `UPDATE return_request SET status='CANCELLED', version=3, cancelled_at=now(),
                    cancelled_by='USR-HELD', cancelled_from='AUTHORIZED', updated_at=now()
              WHERE id=$1`,
            returnId,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO return_status_history
               (id, organization_id, return_request_id, from_status, to_status, version,
                actor_id, correlation_id, command_key_hash, occurred_at)
             VALUES ($1, $2, $3, 'AUTHORIZED', 'CANCELLED', 3, 'USR-HELD', 'held', $4, now())`,
            id('RSH'),
            buyerOrg,
            returnId,
            createHash('sha256').update(`held-${returnId}`).digest('hex'),
          );
        },
      );

      expect(waited).toBe(true);
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('BUSINESS_RULE_VIOLATION');
      expect(await stored(returnId)).toMatchObject({
        status: 'CANCELLED',
        dispatch_reserved_at: null,
      });
    });

    it('a cancellation waiting on a reservation is refused once the reservation commits', async () => {
      const { returnId } = await aReturn();

      const { waited, response } = await whileHeld(
        returnId,
        () => cancel(returnId),
        async (tx) => {
          // What `ReturnRepository.reserveDispatch` writes.
          await tx.$executeRawUnsafe(
            `UPDATE return_request SET dispatch_reservation_id='RDR_01JABCDEFGHJKMNPQRSTVWXYZ1',
                    dispatch_reserved_at=now(),
                    dispatch_reserved_by='inventory-service',
                    dispatch_reserved_correlation_id='held', updated_at=now()
              WHERE id=$1`,
            returnId,
          );
        },
      );

      expect(waited).toBe(true);
      expect(response.status).toBe(422);
      expect(response.body.details?.[0]?.code).toBe('RETURN_DISPATCH_RESERVED');
      expect(await stored(returnId)).toMatchObject({ status: 'AUTHORIZED', version: 2 });
    });
  });
});
