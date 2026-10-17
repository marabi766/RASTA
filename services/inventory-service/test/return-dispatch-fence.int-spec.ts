import { createHash } from 'node:crypto';
import request from 'supertest';
import { ulid } from 'ulid';
import { PrismaClient } from '../src/generated/prisma';
import type { ApiHarness } from './api-helpers';
import { client, internalToken, orgAdmin, registerRequestOf, startApi } from './api-helpers';
import {
  cleanup,
  newOrderLineId,
  newOrderReference,
  newOrganizationId,
  newProductId,
  newReturnRequestId,
  ownerDatabaseUrl,
  runtimeClient,
} from './helpers';

/**
 * The dispatch fence (Codex r1 on #339, findings 2 and 3; PM ruling on Q-133 (9)(a)): what
 * marketplace, the owner of return requests, asks here before it cancels an AUTHORIZED return or
 * releases a dispatch reservation — and the guarantee that makes a release safe: once a
 * reservation is withdrawn here, no shipment carrying it is ever recorded, however late its
 * dispatch commits.
 *
 * Marketplace's side — the reconciliation and the conditional cancellation — is proved against its
 * own database in `api-return-reconciliation.int-spec.ts`; marketplace's reservation route is the
 * stand-in of `marketplace-fake.ts` here. Everything on inventory's side is real.
 */
describe('the dispatch fence: what marketplace asks before a cancellation or a release', () => {
  let api: ApiHarness;
  let raw: PrismaClient;
  let owner: PrismaClient;
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
      lines: [{ orderLineId: newOrderLineId(), productId: newProductId(), quantity: 3 }],
    };
    return { supplier, buyer, token, ops, warehouseId, body };
  }

  const newReservationId = () => `RDR_${ulid()}`;
  const http = () => request(api.app.getHttpServer());
  /** marketplace-service's token, signed for `organizationId` — or, with `null`, for none. */
  const asMarketplace = (organizationId: string | null) =>
    internalToken('marketplace-service', organizationId ?? undefined);
  const shipmentOf = (returnRequestId: string, token: string) =>
    http()
      .get(`/v1/internal/return-requests/${returnRequestId}/return-shipment`)
      .set('x-internal-token', token);
  const withdraw = (returnRequestId: string, reservationId: string, token: string) =>
    http()
      .post(`/v1/internal/return-requests/${returnRequestId}/dispatch-withdrawal`)
      .set('x-internal-token', token)
      .send({ reservationId });

  const withdrawalsOf = (organizationId: string) =>
    raw.returnDispatchWithdrawal.findMany({ where: { organizationId } });
  const shipmentsOf = (organizationId: string) =>
    raw.returnShipment.findMany({ where: { organizationId } });
  const outboxOf = (organizationId: string) =>
    raw.outboxMessage.count({ where: { organizationId, aggregateType: 'ReturnShipment' } });

  const hex = (seed: string) => createHash('sha256').update(seed).digest('hex');

  /**
   * A complete IN_TRANSIT shipment (row, line, tracking event) written past the service, in `tx`,
   * under `reservationId` — `null` writes it as one recorded before reservations existed, which
   * only the owner connection can, with the fence lifted for that one statement.
   */
  async function rawShipment(
    tx: Pick<PrismaClient, '$executeRawUnsafe'>,
    s: { supplier: string; buyer: string; warehouseId: string; returnRequestId: string },
    reservationId: string | null,
  ): Promise<string> {
    const id = `RSP_${ulid()}`;
    await tx.$executeRawUnsafe(
      `INSERT INTO return_shipment (id, organization_id, destination_warehouse_id,
         buyer_organization_id, return_request_id, order_id, line_count, status,
         command_key_hash, created_at, created_by, created_correlation_id, updated_at, version,
         dispatch_reservation_id)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 'IN_TRANSIT', $7, now(), 'USR-RAW', 'raw', now(), 1, $8)`,
      id,
      s.supplier,
      s.warehouseId,
      s.buyer,
      s.returnRequestId,
      newOrderReference(),
      hex(`shipment-${id}`),
      reservationId,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO return_shipment_line (id, organization_id, return_shipment_id, order_line_id,
         product_id, expected_quantity, created_at)
       VALUES ($1, $2, $3, $4, $5, 1, now())`,
      `RSL_${ulid()}`,
      s.supplier,
      id,
      newOrderLineId(),
      newProductId(),
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO return_tracking_event (id, organization_id, return_shipment_id, type,
         shipment_version, occurred_at, recorded_at, recorded_by, correlation_id, command_key_hash)
       VALUES ($1, $2, $3, 'IN_TRANSIT', 1, now(), now(), 'USR-RAW', 'raw', $4)`,
      `RTK_${ulid()}`,
      s.supplier,
      id,
      hex(`tracking-${id}`),
    );
    return id;
  }

  /**
   * A shipment recorded before reservations existed: no reservation id (pre-upgrade state). The
   * fence is lifted around one committed insert, as the database was before the migration — never
   * inside the insert's own transaction, whose deferred history check would keep it from being
   * restored there.
   */
  async function legacyShipment(s: Parameters<typeof rawShipment>[1]): Promise<string> {
    await owner.$executeRawUnsafe(
      'ALTER TABLE return_shipment DISABLE TRIGGER tg_return_shipment_dispatch_fence',
    );
    try {
      return await owner.$transaction((tx) => rawShipment(tx, s, null));
    } finally {
      await owner.$executeRawUnsafe(
        'ALTER TABLE return_shipment ENABLE TRIGGER tg_return_shipment_dispatch_fence',
      );
    }
  }

  beforeAll(async () => {
    api = await startApi();
    raw = runtimeClient();
    owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
  });

  afterEach(() => {
    api.marketplace.mode = 'normal';
    api.marketplace.afterReserve = null;
  });

  afterAll(async () => {
    await cleanup(organizations);
    await raw.$disconnect();
    await owner.$disconnect();
    await api.close();
  });

  // ---------------------------------------------------------------------------------------------
  // Who may ask
  // ---------------------------------------------------------------------------------------------

  it('answers marketplace-service’s token signed for an organization, and refuses every user, every other service and a token signed for none', async () => {
    const s = await setup();
    const reservationId = newReservationId();

    for (const call of [
      (t: string) => shipmentOf(s.body.returnRequestId, t),
      (t: string) => withdraw(s.body.returnRequestId, reservationId, t),
    ]) {
      expect((await call(await internalToken('fleet-service', s.supplier))).status).toBe(403);
      expect((await call(await asMarketplace(null))).status).toBe(403);
    }
    // A user token, whatever its roles, is not this caller.
    await http()
      .get(`/v1/internal/return-requests/${s.body.returnRequestId}/return-shipment`)
      .set('authorization', `Bearer ${s.token}`)
      .expect(403);
    await http()
      .post(`/v1/internal/return-requests/${s.body.returnRequestId}/dispatch-withdrawal`)
      .set('authorization', `Bearer ${s.token}`)
      .send({ reservationId })
      .expect(403);
    await http()
      .get(`/v1/internal/return-requests/${s.body.returnRequestId}/return-shipment`)
      .expect(401);
    expect(await withdrawalsOf(s.supplier)).toEqual([]);
  });

  // ---------------------------------------------------------------------------------------------
  // Is there a shipment? (asked before an AUTHORIZED return is cancelled)
  // ---------------------------------------------------------------------------------------------

  it('says there is no shipment, then names the one dispatched — and only in the books of the organization signed for', async () => {
    const s = await setup();
    const token = await asMarketplace(s.supplier);

    const before = await shipmentOf(s.body.returnRequestId, token).expect(200);
    expect(before.body).toEqual({ returnRequestId: s.body.returnRequestId, returnShipment: null });

    const dispatched = await s.ops.dispatchReturn(s.warehouseId, s.buyer, {
      returnRequestId: s.body.returnRequestId,
      orderId: s.body.orderId,
      lines: s.body.lines,
    });
    expect(dispatched.status).toBe(201);

    const after = await shipmentOf(s.body.returnRequestId, token).expect(200);
    expect(after.body).toEqual({
      returnRequestId: s.body.returnRequestId,
      returnShipment: { id: dispatched.body.id, status: 'IN_TRANSIT' },
    });
    // The buyer's books, or a stranger's, hold no shipment of it.
    for (const other of [s.buyer, org()]) {
      const elsewhere = await shipmentOf(s.body.returnRequestId, await asMarketplace(other));
      expect(elsewhere.body.returnShipment).toBeNull();
    }
    await shipmentOf('not-a-request', token).expect(400);
  });

  it('names a shipment recorded before reservations existed (pre-upgrade, no reservation id) — so marketplace refuses the cancellation', async () => {
    const s = await setup();
    const legacy = await legacyShipment({ ...s, returnRequestId: s.body.returnRequestId });
    const token = await asMarketplace(s.supplier);

    const answer = await shipmentOf(s.body.returnRequestId, token).expect(200);
    expect(answer.body.returnShipment).toEqual({ id: legacy, status: 'IN_TRANSIT' });

    // And a withdrawal of any reservation of that request is refused: the goods are on the road.
    const refused = await withdraw(s.body.returnRequestId, newReservationId(), token).expect(200);
    expect(refused.body).toMatchObject({
      outcome: 'DISPATCHED',
      withdrawnAt: null,
      returnShipment: { id: legacy, status: 'IN_TRANSIT' },
    });
    expect(await withdrawalsOf(s.supplier)).toEqual([]);
  });

  // ---------------------------------------------------------------------------------------------
  // Withdrawing a reservation (asked by a reconciliation)
  // ---------------------------------------------------------------------------------------------

  it('crash after reservation, then reconcile: withdraws the reservation exactly once, and the delayed dispatch carrying it is refused — 409, nothing recorded', async () => {
    const s = await setup();
    // A dispatch reserved R at marketplace, then died before its transaction committed.
    const reservationId = newReservationId();
    registerRequestOf(api, s.token, s.body, { dispatchReservationId: reservationId });
    const token = await asMarketplace(s.supplier);

    // Two reconciliations at once: one withdrawal, the same answer to both.
    const [first, second] = await Promise.all([
      withdraw(s.body.returnRequestId, reservationId, token),
      withdraw(s.body.returnRequestId, reservationId, token),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(first.body).toEqual({
      outcome: 'WITHDRAWN',
      returnRequestId: s.body.returnRequestId,
      reservationId,
      withdrawnAt: expect.any(String),
      returnShipment: null,
    });
    expect(second.body).toEqual(first.body);
    const again = await withdraw(s.body.returnRequestId, reservationId, token).expect(200);
    expect(again.body).toEqual(first.body);
    const rows = await withdrawalsOf(s.supplier);
    expect(rows).toEqual([
      expect.objectContaining({
        returnRequestId: s.body.returnRequestId,
        reservationId,
        withdrawnBy: 'marketplace-service',
      }),
    ]);

    // The dispatch is retried — marketplace still answers R, its reservation not yet released.
    const delayed = await s.ops.post('/v1/return-shipments', s.body);
    expect(delayed.status).toBe(409);
    expect(delayed.body.code).toBe('INVALID_STATE_TRANSITION');
    expect(delayed.body.details).toEqual([
      expect.objectContaining({ path: 'returnShipment', code: 'RETURN_DISPATCH_WITHDRAWN' }),
    ]);
    expect(await shipmentsOf(s.supplier)).toEqual([]);
    expect(await outboxOf(s.supplier)).toBe(0);

    // Marketplace releases R; the next dispatch takes a new reservation and is recorded under it.
    api.marketplace.release(s.body.returnRequestId);
    const recorded = await s.ops.post('/v1/return-shipments', s.body);
    expect(recorded.status).toBe(201);
    const [shipment] = await shipmentsOf(s.supplier);
    expect(shipment?.dispatchReservationId).toMatch(/^RDR_/);
    expect(shipment?.dispatchReservationId).not.toBe(reservationId);
  });

  it('refuses a dispatch whose reservation a reconciliation withdrew while the dispatch waited for marketplace’s answer', async () => {
    const s = await setup();
    const token = await asMarketplace(s.supplier);
    let answer: request.Response | undefined;
    // The reservation is taken; before the dispatch hears of it, the reconciliation runs.
    api.marketplace.afterReserve = async (held) => {
      answer = await withdraw(held.returnRequestId, held.dispatchReservationId as string, token);
    };

    const dispatched = await s.ops.dispatchReturn(s.warehouseId, s.buyer, {
      returnRequestId: s.body.returnRequestId,
      orderId: s.body.orderId,
      lines: s.body.lines,
    });

    expect(answer?.status).toBe(200);
    expect(answer?.body.outcome).toBe('WITHDRAWN');
    expect(dispatched.status).toBe(409);
    expect(dispatched.body.details?.[0]?.code).toBe('RETURN_DISPATCH_WITHDRAWN');
    expect(await shipmentsOf(s.supplier)).toEqual([]);
  });

  it('takes a reservation answer that names no reservation as no answer: 503, nothing recorded', async () => {
    const s = await setup();
    api.marketplace.afterReserve = async (held) => {
      held.dispatchReservationId = null;
    };

    const refused = await s.ops.dispatchReturn(s.warehouseId, s.buyer, {
      returnRequestId: s.body.returnRequestId,
      orderId: s.body.orderId,
      lines: s.body.lines,
    });

    expect(refused.status).toBe(503);
    expect(refused.body.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(await shipmentsOf(s.supplier)).toEqual([]);
  });

  it('answers DISPATCHED for a request with a shipment, whatever reservation is named, and withdraws nothing', async () => {
    const s = await setup();
    const dispatched = await s.ops.dispatchReturn(s.warehouseId, s.buyer, {
      returnRequestId: s.body.returnRequestId,
      orderId: s.body.orderId,
      lines: s.body.lines,
    });
    expect(dispatched.status).toBe(201);
    const held = api.marketplace.requests.get(s.body.returnRequestId);
    const token = await asMarketplace(s.supplier);

    for (const reservationId of [held?.dispatchReservationId as string, newReservationId()]) {
      const answer = await withdraw(s.body.returnRequestId, reservationId, token).expect(200);
      expect(answer.body).toEqual({
        outcome: 'DISPATCHED',
        returnRequestId: s.body.returnRequestId,
        reservationId,
        withdrawnAt: null,
        returnShipment: { id: dispatched.body.id, status: 'IN_TRANSIT' },
      });
    }
    expect(await withdrawalsOf(s.supplier)).toEqual([]);
  });

  it('refuses a reservation already withdrawn for another request, and a malformed one', async () => {
    const s = await setup();
    const token = await asMarketplace(s.supplier);
    const reservationId = newReservationId();
    await withdraw(s.body.returnRequestId, reservationId, token).expect(200);

    const other = await withdraw(newReturnRequestId(), reservationId, token).expect(422);
    expect(other.body.code).toBe('BUSINESS_RULE_VIOLATION');
    await withdraw(s.body.returnRequestId, 'RDR_short', token).expect(400);
    await http()
      .post(`/v1/internal/return-requests/${s.body.returnRequestId}/dispatch-withdrawal`)
      .set('x-internal-token', token)
      .send({ reservationId, extra: true })
      .expect(400);
    expect(await withdrawalsOf(s.supplier)).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------------------------
  // One lock for a shipment and a withdrawal, judged after the wait
  // ---------------------------------------------------------------------------------------------

  /**
   * Holds the request's dispatch lock in another transaction, which runs `write` once the competing
   * call is seen waiting for an advisory lock, then commits. Returns whether it was seen waiting.
   */
  async function whileLocked(
    supplier: string,
    returnRequestId: string,
    competing: () => Promise<request.Response>,
    write: (tx: Pick<PrismaClient, '$executeRawUnsafe'>) => Promise<void>,
  ): Promise<{ waited: boolean; response: request.Response }> {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (locked = resolve));
    const holder = raw.$transaction(
      async (tx) => {
        // The key `ReturnShipmentRepository.lockDispatch` and both triggers take.
        await tx.$executeRawUnsafe(
          `SELECT pg_advisory_xact_lock(hashtextextended('return-dispatch|' || $1 || '|' || $2, 0))`,
          supplier,
          returnRequestId,
        );
        locked();
        await gate;
        await write(tx);
      },
      { timeout: 30_000 },
    );
    await held;

    // `.then` sends it: a supertest request is not sent until something waits on it.
    const pending = competing().then((response) => response);
    const waiters = async () => {
      const [row] = await raw.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'
           AND datname = current_database()`;
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

  it('a dispatch waiting on a withdrawal of its reservation is refused once the withdrawal commits', async () => {
    const s = await setup();
    const reservationId = newReservationId();
    registerRequestOf(api, s.token, s.body, { dispatchReservationId: reservationId });

    const { waited, response } = await whileLocked(
      s.supplier,
      s.body.returnRequestId,
      () => s.ops.post('/v1/return-shipments', s.body),
      async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO return_dispatch_withdrawal (id, organization_id, return_request_id,
             reservation_id, withdrawn_at, withdrawn_by, correlation_id)
           VALUES ($1, $2, $3, $4, now(), 'marketplace-service', 'held')`,
          `RDW_${ulid()}`,
          s.supplier,
          s.body.returnRequestId,
          reservationId,
        );
      },
    );

    expect(waited).toBe(true);
    expect(response.status).toBe(409);
    expect(response.body.details?.[0]?.code).toBe('RETURN_DISPATCH_WITHDRAWN');
    expect(await shipmentsOf(s.supplier)).toEqual([]);
  });

  it('a withdrawal waiting on a shipment being recorded answers DISPATCHED once it commits, and withdraws nothing', async () => {
    const s = await setup();
    const token = await asMarketplace(s.supplier);
    const shipmentReservation = newReservationId();
    let shipmentId = '';

    const { waited, response } = await whileLocked(
      s.supplier,
      s.body.returnRequestId,
      () => withdraw(s.body.returnRequestId, newReservationId(), token),
      async (tx) => {
        shipmentId = await rawShipment(
          tx,
          { ...s, returnRequestId: s.body.returnRequestId },
          shipmentReservation,
        );
      },
    );

    expect(waited).toBe(true);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      outcome: 'DISPATCHED',
      returnShipment: { id: shipmentId, status: 'IN_TRANSIT' },
    });
    expect(await withdrawalsOf(s.supplier)).toEqual([]);
  });

  // ---------------------------------------------------------------------------------------------
  // The database says the same, whatever a write path forgets
  // ---------------------------------------------------------------------------------------------

  it('refuses in the database a shipment under a withdrawn or no reservation, a withdrawal beside a shipment, and any change to either', async () => {
    const s = await setup();
    const target = { ...s, returnRequestId: s.body.returnRequestId };
    const withdrawn = newReservationId();
    await withdraw(s.body.returnRequestId, withdrawn, await asMarketplace(s.supplier)).expect(200);

    await expect(raw.$transaction((tx) => rawShipment(tx, target, withdrawn))).rejects.toThrow(
      /ck_return_shipment_reservation_withdrawn/,
    );
    await expect(raw.$transaction((tx) => rawShipment(tx, target, null))).rejects.toThrow(
      /ck_return_shipment_reserved/,
    );
    await expect(
      raw.$executeRawUnsafe(
        `UPDATE return_dispatch_withdrawal SET withdrawn_by = 'someone' WHERE organization_id = $1`,
        s.supplier,
      ),
    ).rejects.toThrow(/ck_return_dispatch_withdrawal_append_only/);
    await expect(
      raw.$executeRawUnsafe(
        `DELETE FROM return_dispatch_withdrawal WHERE organization_id = $1`,
        s.supplier,
      ),
    ).rejects.toThrow(/ck_return_dispatch_withdrawal_append_only/);

    // A shipment under a live reservation is recorded; a withdrawal beside it is refused, and its
    // reservation never changes.
    const other = await setup();
    const otherTarget = { ...other, returnRequestId: other.body.returnRequestId };
    const shipmentId = await raw.$transaction((tx) =>
      rawShipment(tx, otherTarget, newReservationId()),
    );
    await expect(
      raw.$executeRawUnsafe(
        `INSERT INTO return_dispatch_withdrawal (id, organization_id, return_request_id,
           reservation_id, withdrawn_at, withdrawn_by, correlation_id)
         VALUES ($1, $2, $3, $4, now(), 'marketplace-service', 'raw')`,
        `RDW_${ulid()}`,
        other.supplier,
        other.body.returnRequestId,
        newReservationId(),
      ),
    ).rejects.toThrow(/ck_return_dispatch_withdrawal_without_shipment/);
    await expect(
      raw.$executeRawUnsafe(
        `UPDATE return_shipment SET dispatch_reservation_id = $2 WHERE id = $1`,
        shipmentId,
        newReservationId(),
      ),
    ).rejects.toThrow(/ck_return_shipment_reservation_immutable/);
  });
});
