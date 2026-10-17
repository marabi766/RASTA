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
import type { InventoryFakeMode } from './inventory-fake';

/**
 * A cancellation is conditional, and a dispatch reservation is released only by reconciliation
 * with inventory (Codex r1 on #339; PM ruling on Q-133 (9)(a), (9)(e) unchanged):
 *
 * 1. the buyer's cancellation names the status it saw; the supplier authorizing between the
 *    portal's read and the POST makes it a 409 with nothing written;
 * 2. an AUTHORIZED return is cancelled only once inventory, the owner of the goods, says it holds
 *    no shipment of it — a shipment recorded before reservations existed included — and an
 *    inventory that cannot be asked refuses the cancellation;
 * 3. a reservation whose dispatch failed is released, once, only when inventory has withdrawn it.
 *
 * inventory is the stand-in of `inventory-fake.ts` (real port, real internal tokens); its own side
 * — the fence that refuses a delayed dispatch — is `return-dispatch-fence.int-spec.ts` there.
 */
describe('return request: conditional cancellation and reconciliation of a dispatch reservation', () => {
  let harness: ApiHarness;
  let http: Server;
  let asInventory: string;

  const buyerOrg = apiTenant('RRC-BUY');
  const supplierOrg = apiTenant('RRC-SUP');
  const strangerOrg = apiTenant('RRC-OTH');

  beforeAll(async () => {
    process.env.MARKETPLACE_RETURN_WINDOW_DAYS = '30';
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
    asInventory = await internalToken('inventory-service', { organizationId: supplierOrg });
  });

  afterEach(() => {
    harness.inventory.mode = 'normal';
    harness.inventory.shipments.clear();
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
        sku: `RRC-SKU-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`,
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
      .set('idempotency-key', apiKey('rrc-order'))
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
      .set('idempotency-key', apiKey('rrc-ask'))
      .send({
        reason: 'قطعه با مشخصات سفارش مطابقت ندارد',
        lines: [{ orderLineId: lineId, quantity }],
      });

  const authorize = (returnId: string) =>
    request(http)
      .post(`/v1/returns/${returnId}/decisions`)
      .set(as(supplier(supplierOrg)))
      .set('idempotency-key', apiKey('rrc-auth'))
      .send({ decision: 'AUTHORIZE' });

  /** A return of all 3 units of a fresh order, REQUESTED or (by default) AUTHORIZED. */
  async function aReturn(authorized = true) {
    const { orderId, lineId } = await completedOrder();
    const asked = await ask(orderId, lineId, 3).expect(201);
    const returnId = asked.body.id as string;
    if (authorized) await authorize(returnId).expect(200);
    return { orderId, lineId, returnId };
  }

  const cancel = (
    returnId: string,
    body: object,
    idempotencyKey = apiKey('rrc-cancel'),
    token = buyer(buyerOrg),
  ) =>
    request(http)
      .post(`/v1/returns/${returnId}/cancellation`)
      .set(as(token))
      .set('idempotency-key', idempotencyKey)
      .send(body);
  const reconcile = (
    returnId: string,
    token = buyer(buyerOrg),
    idempotencyKey = apiKey('rrc-rec'),
  ) =>
    request(http)
      .post(`/v1/returns/${returnId}/dispatch-reconciliation`)
      .set(as(token))
      .set('idempotency-key', idempotencyKey);
  const reserve = (returnId: string) =>
    request(http)
      .post(`/v1/internal/returns/${returnId}/dispatch-reservation`)
      .set('x-internal-token', asInventory);

  /** What inventory was asked about this request: method, route and signed organization. */
  const askedInventory = (returnId: string) =>
    harness.inventory.calls
      .filter((call) => call.path.includes(returnId))
      .map((call) => ({
        method: call.method,
        route: call.path.split('/').pop(),
        callerService: call.callerService,
        organizationId: call.organizationId,
        body: call.body,
      }));

  /** The request's row and its history and release counts, past the tenant guard. */
  const stored = async (returnId: string) => {
    const [row] = await runUnscoped(
      'the suite reads the stored request',
      () =>
        harness.prisma.client.$queryRaw<
          {
            status: string;
            version: number;
            dispatch_reservation_id: string | null;
            dispatch_reserved_at: Date | null;
            history: number;
            releases: number;
          }[]
        >`SELECT r.status, r.version, r.dispatch_reservation_id, r.dispatch_reserved_at,
               (SELECT count(*)::int FROM return_status_history h WHERE h.return_request_id = r.id) AS history,
               (SELECT count(*)::int FROM return_dispatch_release d WHERE d.return_request_id = r.id) AS releases
          FROM return_request r WHERE r.id = ${returnId}`,
    );
    return row;
  };
  const releasesOf = (returnId: string) =>
    runUnscoped('the suite reads the release records', () =>
      harness.prisma.client.returnDispatchRelease.findMany({
        where: { returnRequestId: returnId },
      }),
    );
  const eventsOf = async (returnId: string) =>
    (await outboxFor(harness.prisma, buyerOrg)).filter((event) => event.aggregateId === returnId);

  // -------------------------------------------------------------------------
  // 1. The cancellation is conditional (Codex r1 on #339, finding 1)
  // -------------------------------------------------------------------------

  describe('a cancellation names the status the buyer saw', () => {
    it('authorized between the portal’s read and the POST: 409 OPTIMISTIC_LOCK_FAILED, nothing written', async () => {
      const { returnId } = await aReturn(false);

      // The portal reads REQUESTED and offers cancellation…
      const read = await request(http)
        .get(`/v1/returns/${returnId}`)
        .set(as(buyer(buyerOrg)))
        .expect(200);
      expect(read.body.status).toBe('REQUESTED');
      // …the supplier authorizes…
      await authorize(returnId).expect(200);
      const eventsBefore = (await eventsOf(returnId)).length;
      // …and the buyer's POST, conditional on what was read, arrives.
      const refused = await cancel(returnId, { expectedStatus: read.body.status }).expect(409);

      expect(refused.body.code).toBe('OPTIMISTIC_LOCK_FAILED');
      expect(await stored(returnId)).toMatchObject({
        status: 'AUTHORIZED',
        version: 2,
        history: 2,
      });
      expect(await eventsOf(returnId)).toHaveLength(eventsBefore);
    });

    it('authorized while the cancellation waits on the request’s row: judged after the wait, 409', async () => {
      const { returnId } = await aReturn(false);

      const { waited, response } = await whileHeld(
        returnId,
        () => cancel(returnId, { expectedStatus: 'REQUESTED' }),
        async (tx) => {
          // What `ReturnService.decide` writes for an authorization.
          await tx.$executeRawUnsafe(
            `UPDATE return_request SET status='AUTHORIZED', version=2, authorized_at=now(),
                    authorized_by='USR-HELD', updated_at=now() WHERE id=$1`,
            returnId,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO return_status_history
               (id, organization_id, return_request_id, from_status, to_status, version,
                actor_id, correlation_id, command_key_hash, occurred_at)
             VALUES ($1, $2, $3, 'REQUESTED', 'AUTHORIZED', 2, 'USR-HELD', 'held', $4, now())`,
            id('RSH'),
            buyerOrg,
            returnId,
            createHash('sha256').update(`held-auth-${returnId}`).digest('hex'),
          );
        },
      );

      expect(waited).toBe(true);
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('OPTIMISTIC_LOCK_FAILED');
      expect(await stored(returnId)).toMatchObject({ status: 'AUTHORIZED', version: 2 });
    });

    it('refuses any other mismatch too: a REQUESTED return the caller believes AUTHORIZED is 409, nothing written', async () => {
      // The race above is refused twice over (this check, and an AUTHORIZED request never
      // confirmed with inventory); this case only the expected status refuses.
      const { returnId } = await aReturn(false);

      const refused = await cancel(returnId, { expectedStatus: 'AUTHORIZED' }).expect(409);

      expect(refused.body.code).toBe('OPTIMISTIC_LOCK_FAILED');
      expect(await stored(returnId)).toMatchObject({ status: 'REQUESTED', version: 1, history: 1 });
    });

    it('cancels a REQUESTED return seen as REQUESTED, without asking inventory', async () => {
      const { returnId } = await aReturn(false);

      const cancelled = await cancel(returnId, { expectedStatus: 'REQUESTED' }).expect(200);

      expect(cancelled.body).toMatchObject({ status: 'CANCELLED', cancelledFrom: 'REQUESTED' });
      expect(askedInventory(returnId)).toEqual([]);
    });

    it.each([
      ['no body', undefined],
      ['no expected status', {}],
      ['a status nobody cancels from', { expectedStatus: 'CANCELLED' }],
      ['an unknown field', { expectedStatus: 'REQUESTED', reason: 'x' }],
    ])('refuses %s with 400 and writes nothing', async (_name, body) => {
      const { returnId } = await aReturn(false);

      const refused = await cancel(returnId, body ?? {}).expect(400);

      expect(refused.body.code).toBe('VALIDATION_FAILED');
      expect(await stored(returnId)).toMatchObject({ status: 'REQUESTED', history: 1 });
    });

    it('fingerprints the expected status with the key: a replay answers as first, another status is IDEMPOTENCY_KEY_REUSED', async () => {
      const { returnId } = await aReturn(false);
      const key = apiKey('rrc-same');

      const first = await cancel(returnId, { expectedStatus: 'REQUESTED' }, key).expect(200);
      const replay = await cancel(returnId, { expectedStatus: 'REQUESTED' }, key).expect(200);
      const reused = await cancel(returnId, { expectedStatus: 'AUTHORIZED' }, key).expect(409);

      expect(replay.body).toEqual(first.body);
      expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await stored(returnId)).toMatchObject({ status: 'CANCELLED', history: 2 });
    });
  });

  // -------------------------------------------------------------------------
  // 2. An AUTHORIZED return is cancelled on inventory's word (Codex r1 on #339, finding 3)
  // -------------------------------------------------------------------------

  describe('cancelling an AUTHORIZED return asks inventory first', () => {
    it('asks inventory, signed for the supplier, and cancels on its definite "no shipment"', async () => {
      const { returnId } = await aReturn();

      await cancel(returnId, { expectedStatus: 'AUTHORIZED' }).expect(200);

      expect(askedInventory(returnId)).toEqual([
        {
          method: 'GET',
          route: 'return-shipment',
          callerService: 'marketplace-service',
          organizationId: supplierOrg,
          body: null,
        },
      ]);
      expect(await stored(returnId)).toMatchObject({ status: 'CANCELLED', version: 3 });
    });

    it('refuses with 422 RETURN_DISPATCHED a return whose shipment inventory recorded before reservations existed (pre-upgrade IN_TRANSIT) — nothing written, its units stay taken', async () => {
      const { orderId, lineId, returnId } = await aReturn();
      // Dispatched before this change: no reservation here, and the mirror never told us.
      harness.inventory.shipments.set(returnId, {
        id: id('RSP'),
        status: 'IN_TRANSIT',
        organizationId: supplierOrg,
      });
      expect((await stored(returnId))?.dispatch_reserved_at).toBeNull();

      const refused = await cancel(returnId, { expectedStatus: 'AUTHORIZED' }).expect(422);

      expect(refused.body.code).toBe('BUSINESS_RULE_VIOLATION');
      expect(refused.body.details).toEqual([
        expect.objectContaining({ path: 'returnRequest', code: 'RETURN_DISPATCHED' }),
      ]);
      expect(await stored(returnId)).toMatchObject({
        status: 'AUTHORIZED',
        version: 2,
        history: 2,
      });
      await ask(orderId, lineId, 1).expect(422);
    });

    it.each<[string, InventoryFakeMode, number, string]>([
      ['unavailable (5xx)', 'unavailable', 503, 'UPSTREAM_UNAVAILABLE'],
      ['a route it does not have (rolling deploy)', 'route-missing', 503, 'UPSTREAM_UNAVAILABLE'],
      ['refusing this service', 'forbidden', 503, 'UPSTREAM_UNAVAILABLE'],
      ['answering what is not the contract', 'malformed', 503, 'UPSTREAM_UNAVAILABLE'],
      ['silent past the deadline', 'silent', 504, 'UPSTREAM_TIMEOUT'],
    ])(
      'refuses when inventory is %s: %i, nothing written (fail closed)',
      async (_n, mode, status, code) => {
        const { returnId } = await aReturn();
        harness.inventory.mode = mode;

        const refused = await cancel(returnId, { expectedStatus: 'AUTHORIZED' }).expect(status);

        expect(refused.body.code).toBe(code);
        expect(await stored(returnId)).toMatchObject({
          status: 'AUTHORIZED',
          version: 2,
          history: 2,
        });
      },
    );

    it('asks nothing for a stranger: 404 before inventory hears of the request', async () => {
      const { returnId } = await aReturn();

      await cancel(
        returnId,
        { expectedStatus: 'AUTHORIZED' },
        apiKey('x'),
        buyer(strangerOrg),
      ).expect(404);

      expect(askedInventory(returnId)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Reconciliation releases a reservation, once, on inventory's withdrawal (finding 2)
  // -------------------------------------------------------------------------

  describe('POST /v1/returns/{id}/dispatch-reconciliation', () => {
    it('crash after reservation, then reconcile: inventory withdraws it, the release is recorded once, and the buyer may cancel', async () => {
      const { returnId } = await aReturn();
      // inventory reserved, then its transaction never committed: no shipment anywhere.
      const reserved = await reserve(returnId).expect(200);
      const reservationId = reserved.body.dispatchReservationId as string;
      const blocked = await cancel(returnId, { expectedStatus: 'AUTHORIZED' }).expect(422);
      expect(blocked.body.details?.[0]?.code).toBe('RETURN_DISPATCH_RESERVED');

      const released = await reconcile(returnId).expect(200);

      expect(released.body).toMatchObject({ status: 'AUTHORIZED', version: 2 });
      expect(released.body.dispatchReservedAt).toBeNull();
      expect(askedInventory(returnId).slice(-1)).toEqual([
        {
          method: 'POST',
          route: 'dispatch-withdrawal',
          callerService: 'marketplace-service',
          organizationId: supplierOrg,
          body: { reservationId },
        },
      ]);
      const [release, ...more] = await releasesOf(returnId);
      expect(more).toEqual([]);
      expect(release).toMatchObject({
        organizationId: buyerOrg,
        reservationId,
        reservedBy: 'inventory-service',
        releasedBy: expect.any(String),
        withdrawnAt: new Date(harness.inventory.withdrawals.get(reservationId)!.withdrawnAt),
      });
      expect(await stored(returnId)).toMatchObject({
        dispatch_reservation_id: null,
        dispatch_reserved_at: null,
        history: 2,
        releases: 1,
      });

      // Exactly once: nothing is reserved any more.
      const again = await reconcile(returnId).expect(422);
      expect(again.body.details?.[0]?.code).toBe('RETURN_DISPATCH_NOT_RESERVED');
      expect((await stored(returnId))?.releases).toBe(1);

      // The buyer may now cancel — inventory is asked again, and holds nothing.
      await cancel(returnId, { expectedStatus: 'AUTHORIZED' }).expect(200);
      expect(await stored(returnId)).toMatchObject({ status: 'CANCELLED', releases: 1 });
    });

    it('two reconciliations at once release once: the second finds nothing reserved', async () => {
      const { returnId } = await aReturn();
      await reserve(returnId).expect(200);

      const results = await Promise.all([reconcile(returnId), reconcile(returnId)]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
      expect((await stored(returnId))?.releases).toBe(1);
    });

    it('a reconciliation waiting on a release in progress is judged after the wait: 422, no second record', async () => {
      const { returnId } = await aReturn();
      const reserved = await reserve(returnId).expect(200);
      const reservationId = reserved.body.dispatchReservationId as string;

      const { waited, response } = await whileHeld(
        returnId,
        () => reconcile(returnId),
        async (tx) => {
          // What `ReturnRepository.releaseDispatch` writes.
          await tx.$executeRawUnsafe(
            `INSERT INTO return_dispatch_release
               (id, organization_id, return_request_id, reservation_id, reserved_at, reserved_by,
                reserved_correlation_id, withdrawn_at, released_at, released_by,
                released_correlation_id, command_key_hash)
             SELECT $1, organization_id, id, dispatch_reservation_id, dispatch_reserved_at,
                    dispatch_reserved_by, dispatch_reserved_correlation_id, now(), now(),
                    'USR-HELD', 'held', $3
               FROM return_request WHERE id = $2`,
            id('RDL'),
            returnId,
            createHash('sha256').update(`held-release-${returnId}`).digest('hex'),
          );
          await tx.$executeRawUnsafe(
            `UPDATE return_request SET dispatch_reservation_id=NULL, dispatch_reserved_at=NULL,
                    dispatch_reserved_by=NULL, dispatch_reserved_correlation_id=NULL,
                    updated_at=now() WHERE id=$1`,
            returnId,
          );
        },
      );

      expect(waited).toBe(true);
      expect(response.status).toBe(422);
      expect(response.body.details?.[0]?.code).toBe('RETURN_DISPATCH_NOT_RESERVED');
      expect(await releasesOf(returnId)).toEqual([
        expect.objectContaining({ reservationId, releasedBy: 'USR-HELD' }),
      ]);
    });

    it('a cancellation that saw a reservation, released while it waited on the row, was never checked with inventory: 409, nothing written', async () => {
      const { returnId } = await aReturn();
      await reserve(returnId).expect(200);

      const { waited, response } = await whileHeld(
        returnId,
        () => cancel(returnId, { expectedStatus: 'AUTHORIZED' }),
        async (tx) => {
          await tx.$executeRawUnsafe(
            `INSERT INTO return_dispatch_release
               (id, organization_id, return_request_id, reservation_id, reserved_at, reserved_by,
                reserved_correlation_id, withdrawn_at, released_at, released_by,
                released_correlation_id, command_key_hash)
             SELECT $1, organization_id, id, dispatch_reservation_id, dispatch_reserved_at,
                    dispatch_reserved_by, dispatch_reserved_correlation_id, now(), now(),
                    'USR-HELD', 'held', $3
               FROM return_request WHERE id = $2`,
            id('RDL'),
            returnId,
            createHash('sha256').update(`held-release-cancel-${returnId}`).digest('hex'),
          );
          await tx.$executeRawUnsafe(
            `UPDATE return_request SET dispatch_reservation_id=NULL, dispatch_reserved_at=NULL,
                    dispatch_reserved_by=NULL, dispatch_reserved_correlation_id=NULL,
                    updated_at=now() WHERE id=$1`,
            returnId,
          );
        },
      );

      expect(waited).toBe(true);
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('OPTIMISTIC_LOCK_FAILED');
      expect(await stored(returnId)).toMatchObject({ status: 'AUTHORIZED', version: 2 });
      // Inventory was never asked about goods: it saw a reservation, so it did not ask.
      expect(askedInventory(returnId)).toEqual([]);
    });

    it('keeps the reservation when inventory holds a shipment: 422 RETURN_DISPATCHED, nothing written', async () => {
      const { returnId } = await aReturn();
      await reserve(returnId).expect(200);
      harness.inventory.shipments.set(returnId, {
        id: id('RSP'),
        status: 'IN_TRANSIT',
        organizationId: supplierOrg,
      });

      const refused = await reconcile(returnId).expect(422);

      expect(refused.body.details?.[0]?.code).toBe('RETURN_DISPATCHED');
      const row = await stored(returnId);
      expect(row?.dispatch_reserved_at).not.toBeNull();
      expect(row?.releases).toBe(0);
      await cancel(returnId, { expectedStatus: 'AUTHORIZED' }).expect(422);
    });

    it.each<[InventoryFakeMode, number]>([
      ['unavailable', 503],
      ['route-missing', 503],
      ['malformed', 503],
      ['silent', 504],
    ])('releases nothing when inventory is %s: %i (fail closed)', async (mode, status) => {
      const { returnId } = await aReturn();
      await reserve(returnId).expect(200);
      harness.inventory.mode = mode;

      await reconcile(returnId).expect(status);

      const row = await stored(returnId);
      expect(row?.dispatch_reserved_at).not.toBeNull();
      expect(row?.releases).toBe(0);
    });

    it('is either party’s to ask: the supplier releases too, and its next dispatch takes a fresh reservation', async () => {
      const { returnId } = await aReturn();
      const first = (await reserve(returnId).expect(200)).body.dispatchReservationId as string;

      await reconcile(returnId, supplier(supplierOrg)).expect(200);
      const second = (await reserve(returnId).expect(200)).body.dispatchReservationId as string;

      expect(second).toMatch(/^RDR_/);
      expect(second).not.toBe(first);
    });

    it('answers a stranger 404, a party with nothing reserved 422 — and asks inventory nothing', async () => {
      const { returnId: requested } = await aReturn(false);
      const { returnId: authorized } = await aReturn();
      await reserve(authorized).expect(200);

      await reconcile(authorized, buyer(strangerOrg)).expect(404);
      await reconcile(authorized, supplier(strangerOrg)).expect(404);
      const refused = await reconcile(requested).expect(422);
      expect(refused.body.details?.[0]?.code).toBe('RETURN_DISPATCH_NOT_RESERVED');
      await request(http)
        .post(`/v1/returns/${authorized}/dispatch-reconciliation`)
        .set(as(buyer(buyerOrg)))
        .expect(400);
      expect(askedInventory(authorized)).toEqual([]);
      expect(askedInventory(requested)).toEqual([]);
    });

    it('replays a retried reconciliation with its key, and records one release', async () => {
      const { returnId } = await aReturn();
      await reserve(returnId).expect(200);
      const key = apiKey('rrc-rec-same');

      const first = await reconcile(returnId, buyer(buyerOrg), key).expect(200);
      const replay = await reconcile(returnId, buyer(buyerOrg), key).expect(200);

      expect(replay.body).toEqual(first.body);
      expect((await stored(returnId))?.releases).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // The database says the same
  // -------------------------------------------------------------------------

  describe('the database releases a reservation only beside its record', () => {
    const raw = (sql: string, ...values: unknown[]) =>
      runUnscoped('the suite writes past the service', () =>
        harness.prisma.client.$executeRawUnsafe(sql, ...values),
      );
    const releaseRow = (returnId: string, reservationExpr: string) =>
      raw(
        `INSERT INTO return_dispatch_release
           (id, organization_id, return_request_id, reservation_id, reserved_at, reserved_by,
            reserved_correlation_id, withdrawn_at, released_at, released_by,
            released_correlation_id, command_key_hash)
         SELECT $1, organization_id, id, ${reservationExpr}, dispatch_reserved_at,
                dispatch_reserved_by, dispatch_reserved_correlation_id, now(), now(), 'USR-RAW',
                'raw', $3
           FROM return_request WHERE id = $2`,
        id('RDL'),
        returnId,
        createHash('sha256').update(`raw-${returnId}-${Math.random()}`).digest('hex'),
      );

    it('refuses a record of a reservation the request does not hold, a reused reservation id, and any change to a record', async () => {
      const { returnId } = await aReturn();
      const reserved = await reserve(returnId).expect(200);
      const reservationId = reserved.body.dispatchReservationId as string;

      await expect(releaseRow(returnId, `'RDR_01JABCDEFGHJKMNPQRSTVWXYZ0'`)).rejects.toThrow(
        /ck_return_dispatch_release_of_held_reservation/,
      );

      await reconcile(returnId).expect(200);
      // The released id is never reserved again.
      await expect(
        raw(
          `UPDATE return_request SET dispatch_reservation_id=$2, dispatch_reserved_at=now(),
                  dispatch_reserved_by='inventory-service', dispatch_reserved_correlation_id='raw'
            WHERE id=$1`,
          returnId,
          reservationId,
        ),
      ).rejects.toThrow(/ck_return_request_reservation_fresh/);
      await expect(
        raw(
          `UPDATE return_dispatch_release SET released_by='someone' WHERE return_request_id=$1`,
          returnId,
        ),
      ).rejects.toThrow(/ck_return_dispatch_release_append_only/);
      await expect(
        raw(`DELETE FROM return_dispatch_release WHERE return_request_id=$1`, returnId),
      ).rejects.toThrow(/ck_return_dispatch_release_append_only/);
    });
  });

  // -------------------------------------------------------------------------
  // One row lock, judged after the wait
  // -------------------------------------------------------------------------

  /**
   * Holds the request's row in another transaction, which runs `write` once the competing command
   * is seen waiting for that row, then commits. Returns whether it was seen waiting.
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
});
