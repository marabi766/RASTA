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

    await expect(asSaga(() => wiring.orders.markSettling(order.id))).rejects.toThrow(
      expect.objectContaining({ code: 'BUSINESS_RULE_VIOLATION' }),
    );

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
      }),
    );
    const resolved = await asBuyer(() => wiring.orders.get(order.id));
    expect(resolved.status).toBe('RECEIPT_CONFIRMED');
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
