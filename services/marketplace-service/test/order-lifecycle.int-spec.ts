import { ulid } from 'ulid';
import { runUnscoped } from '@rasta/nest-common';
import {
  asActor,
  cleanup,
  key,
  newPrisma,
  outboxFor,
  publishOffer,
  tenants,
  wire,
  type Wiring,
} from './helpers';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * The order lifecycle against a real PostgreSQL.
 *
 * What a unit test cannot reach: the row locks, the CHECK constraints, the
 * partial unique index, and the fact that a state change and its event share
 * one transaction. Every assertion here is about something that exists in the
 * database rather than in TypeScript.
 */
describe('order lifecycle (real database)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  const org = tenants();

  beforeAll(() => {
    prisma = newPrisma();
    wiring = wire(prisma);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.buyer, org.supplier, org.other]);
    await prisma.onModuleDestroy();
  });

  const asBuyer = <T>(fn: () => Promise<T>, organizationId = org.buyer) =>
    asActor({ organizationId, roles: ['PROCUREMENT_USER'], userId: 'USR-BUYER' }, fn);

  const asSupplier = <T>(fn: () => Promise<T>, organizationId = org.supplier) =>
    asActor({ organizationId, roles: ['SUPPLIER'], userId: 'USR-SUPPLIER' }, fn);

  /**
   * The context a Temporal activity establishes before calling the domain.
   *
   * The saga-driven transitions are only ever reached from an activity, which
   * adopts the buyer's organization from the order row (ADR-039). Calling them
   * bare would test a path production does not have.
   */
  const asSaga = <T>(fn: () => Promise<T>) =>
    asActor(
      {
        organizationId: org.buyer,
        authType: 'SERVICE',
        callerService: 'marketplace-service',
        roles: ['SERVICE'],
      },
      fn,
    );

  async function placeOrder(offerId: string, quantity = 2) {
    return asBuyer(() => wiring.orders.place({ lines: [{ offerId, quantity }] }, key('ord')));
  }

  // -------------------------------------------------------------------------

  it('prices from the offer and writes the order, its lines and its event together', async () => {
    const { offerId } = await publishOffer(wiring, org.supplier, { unitPriceMinor: '250000' });
    const order = await placeOrder(offerId, 2);

    expect(order.status).toBe('PENDING');
    expect(order.totalAmountMinor).toBe('500000');
    expect(order.lines[0]?.unitPriceMinor).toBe('250000');
    // The offer version the line agreed to, so the price stays explicable
    // after the offer has been repriced.
    expect(order.lines[0]?.offerVersion).toBe(1);

    const rows = await outboxFor(prisma, org.buyer);
    const created = rows.find(
      (row) =>
        row.eventName === 'ORDER_CREATED' &&
        (row.payload as { payload?: { orderId?: string } })?.payload?.orderId === order.id,
    );

    expect(created).toBeDefined();
    // ADR-036 applied here: every order-lifecycle event keyed by the order.
    expect(created?.partitionKey).toBe(order.id);
    expect(created?.aggregateType).toBe('Order');
  });

  it('reduces what the offer has available, under the constraint', async () => {
    const { offerId } = await publishOffer(wiring, org.supplier, { availableQuantity: 5 });
    await placeOrder(offerId, 3);

    const offer = await runUnscoped('the suite reads the supplier offer it just bought', () =>
      prisma.client.offer.findUnique({ where: { id: offerId } }),
    );
    expect(offer?.availableQuantity).toBe(2);
  });

  it('records every transition in history, with the actor who caused it', async () => {
    const { offerId } = await publishOffer(wiring, org.supplier);
    const order = await placeOrder(offerId, 1);

    await asSaga(() => wiring.orders.markFundsHeld(order.id, `TXN_${ulid()}`));
    await asSupplier(() => wiring.orders.confirm(order.id));

    const history = await runUnscoped('the suite reads the history it produced', () =>
      prisma.client.orderStatusHistory.findMany({
        where: { orderId: order.id },
        orderBy: { occurredAt: 'asc' },
      }),
    );

    expect(history.map((row) => row.toStatus)).toEqual(['FUNDS_HELD', 'CONFIRMED']);
    // S-06: who, what, when. Without it, "why was this order cancelled" has no
    // answer but a guess.
    expect(history.every((row) => row.actorId.length > 0)).toBe(true);
    expect(history.every((row) => row.kind === 'TRANSITION')).toBe(true);
  });

  it('carries an order from placement to completion', async () => {
    const { offerId } = await publishOffer(wiring, org.supplier, { unitPriceMinor: '100000' });
    const order = await placeOrder(offerId, 3);
    const transactionId = `TXN_${ulid()}`;

    await asSaga(() => wiring.orders.markFundsHeld(order.id, transactionId));
    await asSupplier(() => wiring.orders.confirm(order.id));
    await asSupplier(() => wiring.orders.fulfill(order.id, { trackingReference: 'WB-1' }));
    await asBuyer(() => wiring.orders.confirmReceipt(order.id, {}));
    await asSaga(() => wiring.orders.markSettling(order.id));
    await asSaga(() =>
      wiring.orders.markCompleted(order.id, {
        settlementId: `STL_${ulid()}`,
        commissionAmountMinor: '7500',
        netAmountMinor: '292500',
      }),
    );

    const final = await asBuyer(() => wiring.orders.get(order.id));
    expect(final.status).toBe('COMPLETED');
    expect(final.economicTransactionId).toBe(transactionId);
    expect(final.economicSettlementId).toBeTruthy();
    expect(final.receiptConfirmedAt).toBeTruthy();

    const rows = await outboxFor(prisma, org.buyer);
    const forThisOrder = rows.filter(
      (row) => (row.payload as { payload?: { orderId?: string } })?.payload?.orderId === order.id,
    );

    expect(new Set(forThisOrder.map((row) => row.eventName))).toEqual(
      new Set([
        'ORDER_CREATED',
        'ORDER_CONFIRMED',
        'ORDER_FULFILLED',
        'ORDER_RECEIPT_CONFIRMED',
        'ORDER_COMPLETED',
      ]),
    );
    // The whole lifecycle on one partition, which is what lets a consumer
    // rebuild the order in the sequence it happened.
    expect(new Set(forThisOrder.map((row) => row.partitionKey))).toEqual(new Set([order.id]));
  });

  it('refuses to complete an order nobody confirmed receipt of', async () => {
    // Two independent defences: the state machine has no such edge, and the
    // database refuses the row through `ck_order_settled_after_receipt`.
    const { offerId } = await publishOffer(wiring, org.supplier);
    const order = await placeOrder(offerId, 1);

    await asSaga(() => wiring.orders.markFundsHeld(order.id, `TXN_${ulid()}`));
    await asSupplier(() => wiring.orders.confirm(order.id));
    await asSupplier(() => wiring.orders.fulfill(order.id, {}));

    await expect(asSaga(() => wiring.orders.markSettling(order.id))).rejects.toThrow(
      expect.objectContaining({ code: 'BUSINESS_RULE_VIOLATION' }),
    );

    // And the database says the same thing about a direct write.
    await expect(
      runUnscoped('the suite attempts the write the state machine refuses', () =>
        prisma.client.$executeRawUnsafe(
          `UPDATE "order" SET status = 'COMPLETED', completed_at = now(),
             economic_settlement_id = 'STL_FORCED' WHERE id = $1`,
          order.id,
        ),
      ),
    ).rejects.toThrow(/ck_order_settled_after_receipt/);
  });

  it('refuses a second settlement on a completed order', async () => {
    const { offerId } = await publishOffer(wiring, org.supplier);
    const order = await placeOrder(offerId, 1);

    await asSaga(() => wiring.orders.markFundsHeld(order.id, `TXN_${ulid()}`));
    await asSupplier(() => wiring.orders.confirm(order.id));
    await asSupplier(() => wiring.orders.fulfill(order.id, {}));
    await asBuyer(() => wiring.orders.confirmReceipt(order.id, {}));
    await asSaga(() => wiring.orders.markSettling(order.id));
    await asSaga(() =>
      wiring.orders.markCompleted(order.id, {
        settlementId: `STL_${ulid()}`,
        commissionAmountMinor: '0',
        netAmountMinor: '250000',
      }),
    );

    // A terminal order has no outgoing edge, so a replayed command cannot
    // produce a second financial effect.
    await expect(asSaga(() => wiring.orders.markSettling(order.id))).rejects.toThrow(
      /already COMPLETED/,
    );
  });

  it('stops settlement once a dispute is raised', async () => {
    const { offerId } = await publishOffer(wiring, org.supplier);
    const order = await placeOrder(offerId, 1);

    await asSaga(() => wiring.orders.markFundsHeld(order.id, `TXN_${ulid()}`));
    await asSupplier(() => wiring.orders.confirm(order.id));
    await asSupplier(() => wiring.orders.fulfill(order.id, {}));
    await asBuyer(() => wiring.orders.confirmReceipt(order.id, {}));

    await asBuyer(() =>
      wiring.orders.raiseDispute(order.id, {
        reason: 'the delivered part does not match the offer specification',
      }),
    );

    // The saga's step yields to the dispute: it moves nothing and reports what
    // it found, so the saga waits on the dispute instead of counting a failed
    // settlement attempt — which is what used to erase it.
    await expect(asSaga(() => wiring.orders.markSettling(order.id))).resolves.toBe('DISPUTED');

    const disputed = await asBuyer(() => wiring.orders.get(order.id));
    expect(disputed.status).toBe('DISPUTED');
  });

  it('does not let the buyer walk out of their own dispute', async () => {
    // The transition table permits DISPUTED → RECEIPT_CONFIRMED, because that
    // is how an operator resolves a dispute in the supplier's favour. Without a
    // per-command restriction on the source state, the buyer's own
    // `ConfirmReceipt` travels the same edge — and the party who raised the
    // dispute releases the money by withdrawing nothing.
    //
    // Found by the end-to-end suite, which asserted the refusal and got a 200.
    const { offerId } = await publishOffer(wiring, org.supplier);
    const order = await placeOrder(offerId, 1);

    await asSaga(() => wiring.orders.markFundsHeld(order.id, `TXN_${ulid()}`));
    await asSupplier(() => wiring.orders.confirm(order.id));
    await asSupplier(() => wiring.orders.fulfill(order.id, {}));
    await asBuyer(() =>
      wiring.orders.raiseDispute(order.id, { reason: 'the delivered goods are the wrong part' }),
    );

    await expect(asBuyer(() => wiring.orders.confirmReceipt(order.id, {}))).rejects.toThrow(
      expect.objectContaining({ code: 'BUSINESS_RULE_VIOLATION' }),
    );

    const stillDisputed = await asBuyer(() => wiring.orders.get(order.id));
    expect(stillDisputed.status).toBe('DISPUTED');
    expect(stillDisputed.receiptConfirmedAt).toBeNull();

    // And an operator can still resolve it, which is what that edge is for.
    await asActor({ organizationId: org.other, roles: ['UNION_ADMIN'], userId: 'USR-OPS' }, () =>
      wiring.orders.resolveDispute(order.id, {
        outcome: 'SETTLE',
        resolution: 'the supplier provided evidence of correct delivery',
        responsibility: 'BUYER',
      }),
    );
    const resolved = await asBuyer(() => wiring.orders.get(order.id));
    expect(resolved.status).toBe('RECEIPT_CONFIRMED');

    // ADR-052 § 1-b: the resolve endpoint publishes nothing today. Selected by
    // this order's own id, never by "the last row" — a shared outbox table can
    // hold other runs' rows too (the parallel-agent lesson).
    const rows = await outboxFor(prisma, org.buyer);
    const resolvedEvent = rows.find(
      (row) =>
        row.eventName === 'ORDER_DISPUTE_RESOLVED' &&
        (row.payload as { payload?: { orderId?: string } })?.payload?.orderId === order.id,
    );
    expect(resolvedEvent).toBeDefined();
    expect(resolvedEvent?.partitionKey).toBe(order.id);
    const payload = (resolvedEvent?.payload as { payload: Record<string, unknown> }).payload;
    expect(payload.outcome).toBe('SETTLE');
    // The operator's own choice, not inferred from the free-text resolution
    // ("the supplier provided evidence...") which would suggest the opposite.
    expect(payload.responsibility).toBe('BUYER');
  });

  it('refuses a responsibility outside the closed enum, even called directly', async () => {
    // The HTTP layer's zodPipe would refuse this before it reaches the
    // service; this proves the same value is refused when a caller (a future
    // internal RPC, a test) skips that layer and calls the service directly.
    const { offerId } = await publishOffer(wiring, org.supplier);
    const order = await placeOrder(offerId, 1);
    await asSaga(() => wiring.orders.markFundsHeld(order.id, `TXN_${ulid()}`));
    await asBuyer(() =>
      wiring.orders.raiseDispute(order.id, { reason: 'the part delivered was the wrong one' }),
    );

    await expect(
      asActor({ organizationId: org.other, roles: ['UNION_ADMIN'], userId: 'USR-OPS' }, () =>
        wiring.orders.resolveDispute(order.id, {
          outcome: 'SETTLE',
          resolution: 'a resolution with a responsibility nobody defined',
          // @ts-expect-error — exactly the out-of-enum value this test refuses
          responsibility: 'WEATHER',
        }),
      ),
    ).rejects.toThrow();
  });

  it('propagates the dispute’s own responsibility onto the cancellation it causes', async () => {
    // ADR-052 § 1-c: a REFUND resolution moves the order to CANCELLING and,
    // once the saga's compensation finishes, to CANCELLED. The cause on that
    // eventual ORDER_CANCELLED must be the dispute's own structured
    // responsibility — never re-decided, never parsed from either free-text
    // field.
    const { offerId } = await publishOffer(wiring, org.supplier, { availableQuantity: 5 });
    const order = await placeOrder(offerId, 1);
    await asSaga(() => wiring.orders.markFundsHeld(order.id, `TXN_${ulid()}`));
    await asBuyer(() =>
      wiring.orders.raiseDispute(order.id, { reason: 'the goods never left the warehouse' }),
    );

    await asActor({ organizationId: org.other, roles: ['UNION_ADMIN'], userId: 'USR-OPS' }, () =>
      wiring.orders.resolveDispute(order.id, {
        outcome: 'REFUND',
        resolution: 'the supplier never shipped the goods',
        responsibility: 'SUPPLIER',
      }),
    );

    const cancelling = await asBuyer(() => wiring.orders.get(order.id));
    expect(cancelling.status).toBe('CANCELLING');

    await asSaga(() =>
      wiring.orders.markCancelled(order.id, 'the supplier never shipped the goods'),
    );

    const closed = await asBuyer(() => wiring.orders.get(order.id));
    expect(closed.status).toBe('CANCELLED');

    const rows = await outboxFor(prisma, org.buyer);
    const cancelledEvent = rows.find(
      (row) =>
        row.eventName === 'ORDER_CANCELLED' &&
        (row.payload as { payload?: { orderId?: string } })?.payload?.orderId === order.id,
    );
    const payload = (cancelledEvent?.payload as { payload: Record<string, unknown> }).payload;
    expect(payload.cancellationCause).toBe('SUPPLIER');
  });

  it('refuses to resolve a dispute on an order that has none', async () => {
    const { offerId } = await publishOffer(wiring, org.supplier);
    const order = await placeOrder(offerId, 1);
    await asSaga(() => wiring.orders.markFundsHeld(order.id, `TXN_${ulid()}`));

    await expect(
      asActor({ organizationId: org.other, roles: ['UNION_ADMIN'], userId: 'USR-OPS' }, () =>
        wiring.orders.resolveDispute(order.id, {
          outcome: 'REFUND',
          resolution: 'resolving something that was never disputed',
          responsibility: 'SUPPLIER',
        }),
      ),
    ).rejects.toThrow(expect.objectContaining({ code: 'BUSINESS_RULE_VIOLATION' }));
  });

  it('allows one open dispute per order and no more', async () => {
    const { offerId } = await publishOffer(wiring, org.supplier);
    const order = await placeOrder(offerId, 1);

    await asSaga(() => wiring.orders.markFundsHeld(order.id, `TXN_${ulid()}`));
    await asBuyer(() =>
      wiring.orders.raiseDispute(order.id, { reason: 'the goods never arrived at all' }),
    );

    // Refused by the state machine — and by the partial unique index if a
    // future path ever got past it.
    await expect(
      asBuyer(() =>
        wiring.orders.raiseDispute(order.id, { reason: 'a second complaint about the same order' }),
      ),
    ).rejects.toThrow();

    await expect(
      runUnscoped('the suite attempts a second open dispute directly', () =>
        prisma.client.$executeRawUnsafe(
          `INSERT INTO order_dispute (id, organization_id, order_id, reason, status, raised_at, raised_by)
           VALUES ($1, $2, $3, 'a second open dispute', 'OPEN', now(), 'USR-ITEST')`,
          `DSP_${ulid()}`,
          org.buyer,
          order.id,
        ),
      ),
    ).rejects.toThrow(/Key \(order_id\)=.* already exists/);
  });

  it('cancels an order the saga never funded', async () => {
    // `PENDING → CANCELLING` is legal (ADR-038): a buyer may cancel before the
    // saga has created the obligation, and at that moment there is no
    // transaction to name.
    //
    // `ck_order_held_has_transaction` refused exactly that until the
    // `cancel_before_hold` migration: its exempt list held PENDING and FAILED
    // but not the two cancellation states, so the write failed with a driver
    // error the caller saw as a 500. Every earlier test cancelled *after*
    // FUNDS_HELD, so none of them reached it.
    const { offerId } = await publishOffer(wiring, org.supplier, { availableQuantity: 6 });
    const order = await placeOrder(offerId, 2);
    expect(order.status).toBe('PENDING');
    expect(order.economicTransactionId).toBeNull();

    await asBuyer(() => wiring.orders.cancel(order.id, { reason: 'changed our minds' }));
    await asSaga(() => wiring.orders.markCancelled(order.id, 'changed our minds'));

    const closed = await asBuyer(() => wiring.orders.get(order.id));
    expect(closed.status).toBe('CANCELLED');
    // Still no transaction, and the row is legal without one.
    expect(closed.economicTransactionId).toBeNull();

    // And what it reserved went back.
    const offer = await runUnscoped('the suite reads the offer the cancellation released', () =>
      prisma.client.offer.findUnique({ where: { id: offerId } }),
    );
    expect(offer?.availableQuantity).toBe(6);

    // ADR-052 § 1-c: a direct self-service cancellation is never the
    // supplier's fault, fixed by which command this is — not read from
    // "changed our minds", which names no party at all.
    const rows = await outboxFor(prisma, org.buyer);
    const cancelledEvent = rows.find(
      (row) =>
        row.eventName === 'ORDER_CANCELLED' &&
        (row.payload as { payload?: { orderId?: string } })?.payload?.orderId === order.id,
    );
    const payload = (cancelledEvent?.payload as { payload: Record<string, unknown> }).payload;
    expect(payload.cancellationCause).toBe('BUYER');
  });

  it('still requires a transaction id once money is held', async () => {
    // The widened constraint must not have become vacuous: a held order with no
    // obligation behind it is the thing it exists to prevent.
    const { offerId } = await publishOffer(wiring, org.supplier);
    const order = await placeOrder(offerId, 1);

    await expect(
      runUnscoped('the suite attempts a held order with no obligation', () =>
        prisma.client.$executeRawUnsafe(
          `UPDATE "order" SET status='FUNDS_HELD' WHERE id = $1`,
          order.id,
        ),
      ),
    ).rejects.toThrow(/ck_order_held_has_transaction/);
  });

  it('refuses a CANCELLED order with no cancellation cause, at the database', async () => {
    // ADR-052 § 4 rule 14: never silently absent. `ck_order_cancelled_has_
    // cause` is the database's own copy of that rule, independent of every
    // application-level check above.
    const { offerId } = await publishOffer(wiring, org.supplier);
    const order = await placeOrder(offerId, 1);

    await expect(
      runUnscoped('the suite attempts a cancellation with no cause', () =>
        prisma.client.$executeRawUnsafe(
          `UPDATE "order" SET status='CANCELLED', cancelled_at=now(),
             cancellation_reason='forced by the suite' WHERE id = $1`,
          order.id,
        ),
      ),
    ).rejects.toThrow(/ck_order_cancelled_has_cause/);
  });

  it('computes the promised delivery date from the slowest offer, not the average', async () => {
    // ADR-052 § 1-a. Two lines with different lead times: the promise is the
    // slower one, because a supplier committing both has committed to the
    // slower one arriving.
    const fast = await publishOffer(wiring, org.supplier, {
      leadTimeDays: 2,
      name: 'قطعه سریع',
    });
    const slow = await publishOffer(wiring, org.supplier, {
      leadTimeDays: 9,
      name: 'قطعه دیر',
    });

    const order = await asBuyer(() =>
      wiring.orders.place(
        {
          lines: [
            { offerId: fast.offerId, quantity: 1 },
            { offerId: slow.offerId, quantity: 1 },
          ],
        },
        key('ord-lead'),
      ),
    );

    const row = await runUnscoped('the suite reads the promise the service computed', () =>
      prisma.client.order.findUniqueOrThrow({ where: { id: order.id } }),
    );
    expect(row.promisedDeliveryAt).not.toBeNull();

    const rows = await outboxFor(prisma, org.buyer);
    const created = rows.find(
      (r) =>
        r.eventName === 'ORDER_CREATED' &&
        (r.payload as { payload?: { orderId?: string } })?.payload?.orderId === order.id,
    );
    const payload = (created?.payload as { payload: Record<string, unknown> }).payload;
    expect(payload.promisedDeliveryAt).toBe(row.promisedDeliveryAt!.toISOString());

    const promisedDays = Math.round(
      (row.promisedDeliveryAt!.getTime() - row.createdAt.getTime()) / (24 * 60 * 60 * 1000),
    );
    expect(promisedDays).toBe(9);
  });

  it('returns availability when an order is cancelled', async () => {
    const { offerId } = await publishOffer(wiring, org.supplier, { availableQuantity: 4 });
    const order = await placeOrder(offerId, 3);

    await asSaga(() => wiring.orders.markFundsHeld(order.id, `TXN_${ulid()}`));
    await asBuyer(() => wiring.orders.cancel(order.id, { reason: 'no longer needed' }));
    await asSaga(() => wiring.orders.markCancelled(order.id, 'no longer needed'));

    const offer = await runUnscoped('the suite reads the offer the cancelled order released', () =>
      prisma.client.offer.findUnique({ where: { id: offerId } }),
    );
    expect(offer?.availableQuantity).toBe(4);

    const final = await asBuyer(() => wiring.orders.get(order.id));
    expect(final.status).toBe('CANCELLED');
    expect(final.cancellationReason).toBe('no longer needed');
  });

  it('records a reminder without changing state or moving money', async () => {
    // ADR-043 / Q-11. The row is written with kind REMINDER and equal
    // from/to statuses, which the database enforces — recording it as a
    // transition would claim something happened that did not.
    const { offerId } = await publishOffer(wiring, org.supplier);
    const order = await placeOrder(offerId, 1);

    await asSaga(() => wiring.orders.markFundsHeld(order.id, `TXN_${ulid()}`));
    await asSupplier(() => wiring.orders.confirm(order.id));
    await asSupplier(() => wiring.orders.fulfill(order.id, {}));

    await asSaga(() => wiring.orders.recordReminder(order.id));
    await asSaga(() => wiring.orders.recordReminder(order.id));

    const after = await asBuyer(() => wiring.orders.get(order.id));
    expect(after.status).toBe('AWAITING_RECEIPT_CONFIRMATION');
    expect(after.reminderCount).toBe(2);
    expect(after.receiptConfirmedAt).toBeNull();

    const reminders = await runUnscoped('the suite reads the reminders it recorded', () =>
      prisma.client.orderStatusHistory.findMany({
        where: { orderId: order.id, kind: 'REMINDER' },
      }),
    );
    expect(reminders).toHaveLength(2);
    expect(reminders.every((row) => row.fromStatus === row.toStatus)).toBe(true);
  });

  it('permits a review only after completion, and only one', async () => {
    const { offerId } = await publishOffer(wiring, org.supplier);
    const order = await placeOrder(offerId, 1);

    await expect(
      asBuyer(() => wiring.orders.submitReview(order.id, { rating: 5 })),
    ).rejects.toThrow(/completed order/);

    await asSaga(() => wiring.orders.markFundsHeld(order.id, `TXN_${ulid()}`));
    await asSupplier(() => wiring.orders.confirm(order.id));
    await asSupplier(() => wiring.orders.fulfill(order.id, {}));
    await asBuyer(() => wiring.orders.confirmReceipt(order.id, {}));
    await asSaga(() => wiring.orders.markSettling(order.id));
    await asSaga(() =>
      wiring.orders.markCompleted(order.id, {
        settlementId: `STL_${ulid()}`,
        commissionAmountMinor: '0',
        netAmountMinor: '250000',
      }),
    );

    const review = await asBuyer(() => wiring.orders.submitReview(order.id, { rating: 4 }));
    expect(review.rating).toBe(4);

    await expect(
      asBuyer(() => wiring.orders.submitReview(order.id, { rating: 1 })),
    ).rejects.toThrow();
  });

  it('refuses an order an organization places with itself', async () => {
    const { offerId } = await publishOffer(wiring, org.buyer);
    await expect(placeOrder(offerId, 1)).rejects.toThrow(/order from itself/);
  });
});
