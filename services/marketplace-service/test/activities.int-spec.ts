import { ApplicationFailure } from '@temporalio/activity';
import { RastaError, getContext, runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { createActivities, type OrderActivities } from '../src/temporal/activities';
import type { EconomicClient } from '../src/economic/economic.client';
import type { PrismaService } from '../src/prisma/prisma.service';
import {
  asActor,
  cleanup,
  key,
  newPrisma,
  publishOffer,
  tenants,
  wire,
  type Wiring,
} from './helpers';

/**
 * The saga's activities, against the real domain and the real database.
 *
 * `workflows.spec.ts` runs the workflow with recorded activities, because what
 * it asserts is the *sequence* of calls. That leaves the activities themselves
 * — the layer that decides which tenant a saga step acts for, whether a retry
 * repeats a financial call, and whether a refusal is worth retrying at all —
 * with no test at all. Those three decisions are where a saga silently does
 * the wrong thing, so they are asserted here rather than assumed.
 *
 * ## What is real and what is not
 *
 * The `OrderService`, the repository, the state machine, the constraints and
 * the outbox are the real ones, running against PostgreSQL. The **only** stub
 * is `EconomicClient`, which is an HTTP client to a service in another
 * process: there is nothing of this service's logic inside it to test here,
 * and its own request shaping, retries and error mapping are covered by
 * `economic.client.spec.ts`. Stubbing it is also what makes the failure cases
 * reachable — a real economic-service does not fail on demand.
 */
describe('order saga activities (real database)', () => {
  jest.setTimeout(60_000);

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

  // -------------------------------------------------------------------------
  // A stub that records what it was asked, so the tenant on each call can be
  // asserted rather than taken on trust.
  // -------------------------------------------------------------------------

  interface Recorded {
    method: string;
    input: Record<string, unknown>;
    /** The organization the *ambient context* named at the moment of the call. */
    contextOrganizationId: string | undefined;
    contextCorrelationId: string;
  }

  function stubEconomic(overrides: Partial<Record<string, () => Promise<unknown>>> = {}) {
    const calls: Recorded[] = [];

    const method =
      (name: string, result: unknown) =>
      async (input: Record<string, unknown>): Promise<unknown> => {
        const context = getContext();
        calls.push({
          method: name,
          input,
          contextOrganizationId: context.organizationId,
          contextCorrelationId: context.correlationId,
        });
        const override = overrides[name];
        if (override) return override();
        return result;
      };

    const economic = {
      createObligation: method('createObligation', { id: `TXN_${ulid().slice(-8)}` }),
      authoriseSettlement: method('authoriseSettlement', undefined),
      settle: method('settle', {
        settlementId: `STL_${ulid().slice(-8)}`,
        commissionAmountMinor: '12500',
        netAmountMinor: '487500',
      }),
      refund: method('refund', undefined),
      cancel: method('cancel', undefined),
      dispute: method('dispute', undefined),
      resolveDispute: method('resolveDispute', undefined),
      // JUSTIFIED-ANY: only the seven methods the activities call are needed,
      // and naming the class would drag its HTTP internals into a suite about
      // the activities. The client's own behaviour has its own spec.
    } as any as EconomicClient;

    return { calls, economic };
  }

  function activitiesWith(economic: EconomicClient): OrderActivities {
    return createActivities({ orders: wiring.orders, economic });
  }

  /** A real PENDING order, placed through the real service by a real buyer. */
  async function placeOrder(): Promise<{ orderId: string; correlationId: string }> {
    const { offerId } = await publishOffer(wiring, org.supplier, { unitPriceMinor: '500000' });

    const order = await asActor(
      { organizationId: org.buyer, roles: ['PROCUREMENT_USER'], userId: 'USR-ACT-BUYER' },
      () => wiring.orders.place({ lines: [{ offerId, quantity: 1 }] }, key('ACT')),
    );

    const row = await runUnscoped('the suite reads the order it just placed', () =>
      prisma.client.order.findUniqueOrThrow({ where: { id: order.id } }),
    );

    return { orderId: order.id, correlationId: row.correlationId };
  }

  // -------------------------------------------------------------------------

  describe('the tenant a saga step acts for', () => {
    it('adopts the buyer organization from the order row, not from the caller', async () => {
      // The activity is invoked by a Temporal worker, which has no request and
      // no tenant behind it. If it acted for nobody the domain would refuse;
      // if it acted for a tenant a workflow argument named, a workflow could
      // choose its own tenant. It reads the organization off the order.
      const { orderId } = await placeOrder();
      const { calls, economic } = stubEconomic();

      await activitiesWith(economic).createObligation(orderId);

      expect(calls).toHaveLength(1);
      expect(calls[0].contextOrganizationId).toBe(org.buyer);
      expect(calls[0].input.buyerOrganizationId).toBe(org.buyer);
      expect(calls[0].input.supplierOrganizationId).toBe(org.supplier);
    });

    it("carries the order's own correlation id rather than minting a fresh one", async () => {
      // A saga step and the HTTP request that started the order share one
      // identifier through the logs, the outbox and Kafka. A new id per
      // activity would break the trail at exactly the point an operator needs
      // it — the money moving.
      const { orderId, correlationId } = await placeOrder();
      const { calls, economic } = stubEconomic();

      await activitiesWith(economic).createObligation(orderId);

      expect(calls[0].contextCorrelationId).toBe(correlationId);
      expect(calls[0].input.correlationId).toBe(correlationId);
    });

    it('reports an order that does not exist rather than acting for no tenant', async () => {
      const { economic } = stubEconomic();
      await expect(activitiesWith(economic).createObligation('ORD_NOT_REAL')).rejects.toThrow(
        RastaError,
      );
    });
  });

  describe('createObligation', () => {
    it('creates the obligation once and reports its transaction', async () => {
      const { orderId } = await placeOrder();
      const { calls, economic } = stubEconomic();

      const held = await activitiesWith(economic).createObligation(orderId);

      expect(held.transactionId).toMatch(/^TXN_/);
      expect(calls.map((c) => c.method)).toEqual(['createObligation']);
      expect(calls[0].input.totalAmountMinor).toBe(500000n);
      expect(calls[0].input.currency).toBe('IRR');
    });

    it('does not create a second obligation when the order already carries one', async () => {
      // The retry that matters: the call succeeded, the worker died before the
      // result was recorded, and Temporal runs the activity again. A second
      // obligation would hold the buyer's funds twice for one order.
      const { orderId } = await placeOrder();
      const first = stubEconomic();
      const acts = activitiesWith(first.economic);

      const held = await acts.createObligation(orderId);
      await acts.markFundsHeld(orderId, held.transactionId);

      const second = stubEconomic();
      const replay = await activitiesWith(second.economic).createObligation(orderId);

      expect(replay.transactionId).toBe(held.transactionId);
      expect(second.calls).toHaveLength(0);
    });
  });

  describe('how a failure from economic-service is classified', () => {
    /**
     * The classification decides whether Temporal retries. Getting it wrong in
     * one direction retries a refusal that will never change its answer — the
     * order sits PENDING for the whole retry policy before failing. In the
     * other direction it gives up on an outage that would have healed.
     */
    async function failWith(error: unknown): Promise<unknown> {
      const { orderId } = await placeOrder();
      const { economic } = stubEconomic({
        createObligation: () => Promise.reject(error),
      });
      return activitiesWith(economic)
        .createObligation(orderId)
        .then(
          () => {
            throw new Error('the activity was expected to fail');
          },
          (caught: unknown) => caught,
        );
    }

    it('marks a business-rule refusal non-retryable, under its platform code', async () => {
      const caught = (await failWith(
        RastaError.businessRule('The buyer wallet is closed'),
      )) as ApplicationFailure;

      expect(caught).toBeInstanceOf(ApplicationFailure);
      expect(caught.nonRetryable).toBe(true);
      // The `type` is what the workflow's `nonRetryableErrorTypes` matches on,
      // so it must be the platform code and not the class name.
      expect(caught.type).toBe('BUSINESS_RULE_VIOLATION');
    });

    it('marks an insufficient balance non-retryable', async () => {
      const caught = (await failWith(
        RastaError.insufficientBalance('WAL_1', '500000', '10'),
      )) as ApplicationFailure;

      expect(caught.nonRetryable).toBe(true);
      expect(caught.type).toBe('INSUFFICIENT_BALANCE');
    });

    it('marks an upstream outage retryable', async () => {
      // economic-service being down is the case retrying exists for.
      const caught = (await failWith(
        RastaError.upstreamUnavailable('economic-service'),
      )) as ApplicationFailure;

      expect(caught).toBeInstanceOf(ApplicationFailure);
      expect(caught.nonRetryable).toBe(false);
      expect(caught.type).toBe('UPSTREAM_UNAVAILABLE');
    });

    it('marks a timeout retryable', async () => {
      const caught = (await failWith(
        RastaError.upstreamTimeout('economic-service', 5000),
      )) as ApplicationFailure;

      expect(caught.nonRetryable).toBe(false);
    });

    it('passes a plain error through, so its stack survives', async () => {
      // Not a platform error: a socket reset, a JSON parse failure. Wrapping it
      // in an ApplicationFailure would classify something the code does not
      // understand, and Temporal's default policy already retries it.
      const raw = new TypeError('fetch failed');
      const caught = await failWith(raw);

      expect(caught).toBe(raw);
      expect(caught).not.toBeInstanceOf(ApplicationFailure);
    });

    it('turns a thrown non-error into one, rather than crashing the handler', async () => {
      // A `catch` binds `unknown`, and a library that rejects with a string is
      // not hypothetical. Reaching for `.code` on it here would replace the
      // upstream failure with a TypeError from inside the error handler.
      const caught = (await failWith('economic said no')) as Error;

      expect(caught).toBeInstanceOf(Error);
      expect(caught.message).toBe('The financial service call failed');
    });
  });

  describe('the state transitions a saga drives', () => {
    it('walks an order from held funds to completed', async () => {
      const { orderId } = await placeOrder();
      const { calls, economic } = stubEconomic();
      const acts = activitiesWith(economic);

      const held = await acts.createObligation(orderId);
      await acts.markFundsHeld(orderId, held.transactionId);

      await asActor(
        { organizationId: org.supplier, roles: ['SUPPLIER'], userId: 'USR-ACT-SUP' },
        async () => {
          await wiring.orders.confirm(orderId);
          await wiring.orders.fulfill(orderId, {});
        },
      );
      await asActor(
        { organizationId: org.buyer, roles: ['PROCUREMENT_USER'], userId: 'USR-ACT-BUYER' },
        () => wiring.orders.confirmReceipt(orderId, {}),
      );

      await acts.authoriseSettlement(orderId, held.transactionId);
      await acts.markSettling(orderId);
      const settled = await acts.settle(orderId, held.transactionId);
      await acts.markCompleted(orderId, settled);

      const row = await runUnscoped('the suite reads the order it drove', () =>
        prisma.client.order.findUniqueOrThrow({ where: { id: orderId } }),
      );
      expect(row.status).toBe('COMPLETED');
      expect(row.economicSettlementId).toMatch(/^STL_/);
      // The commission is deliberately *not* a column here. This service does
      // not know a rate and must not appear to (ADR-040), so the figures reach
      // the outside only as economic-service reported them, on the event.
      const completed = await runUnscoped('the suite reads the completion event', () =>
        prisma.client.outboxMessage.findFirstOrThrow({
          where: { aggregateId: orderId, eventName: 'ORDER_COMPLETED' },
        }),
      );
      const payload = (completed.payload as { payload: Record<string, unknown> }).payload;
      expect(payload.commissionAmountMinor).toBe('12500');
      expect(payload.netAmountMinor).toBe('487500');
      expect(calls.map((c) => c.method)).toEqual([
        'createObligation',
        'authoriseSettlement',
        'settle',
      ]);
      // Every economic call acted for the buyer, none for whoever happened to
      // be ambient when the activity ran.
      expect(new Set(calls.map((c) => c.contextOrganizationId))).toEqual(new Set([org.buyer]));
    });

    it('fails an order whose obligation could not be created', async () => {
      const { orderId } = await placeOrder();
      const { economic } = stubEconomic();

      await activitiesWith(economic).markFailed(orderId, 'INSUFFICIENT_BALANCE');

      const row = await runUnscoped('the suite reads the failed order', () =>
        prisma.client.order.findUniqueOrThrow({ where: { id: orderId } }),
      );
      expect(row.status).toBe('FAILED');
    });

    it('returns the held funds and cancels, in the order the saga does it', async () => {
      const { orderId } = await placeOrder();
      const { calls, economic } = stubEconomic();
      const acts = activitiesWith(economic);

      const held = await acts.createObligation(orderId);
      await acts.markFundsHeld(orderId, held.transactionId);

      await asActor(
        { organizationId: org.buyer, roles: ['PROCUREMENT_USER'], userId: 'USR-ACT-BUYER' },
        () => wiring.orders.cancel(orderId, { reason: 'no longer needed' }),
      );

      await acts.compensate(orderId, held.transactionId, 'no longer needed');
      await acts.markCancelled(orderId, 'no longer needed');

      const row = await runUnscoped('the suite reads the cancelled order', () =>
        prisma.client.order.findUniqueOrThrow({ where: { id: orderId } }),
      );
      expect(row.status).toBe('CANCELLED');
      // The refund carries the transaction the hold created, so economic can
      // release the exact funds this order reserved.
      const refund = calls.find((c) => c.method === 'refund');
      expect(refund?.input.transactionId).toBe(held.transactionId);
      expect(refund?.input.reason).toBe('no longer needed');
    });

    it('tells economic-service about a dispute and about its resolution', async () => {
      // Both sides have to know: with only marketplace informed, a settlement
      // command sent straight to economic-service would still succeed.
      const { orderId } = await placeOrder();
      const { calls, economic } = stubEconomic();
      const acts = activitiesWith(economic);

      const held = await acts.createObligation(orderId);
      await acts.markFundsHeld(orderId, held.transactionId);
      await asActor(
        { organizationId: org.supplier, roles: ['SUPPLIER'], userId: 'USR-ACT-SUP' },
        async () => {
          await wiring.orders.confirm(orderId);
          await wiring.orders.fulfill(orderId, {});
        },
      );
      await asActor(
        { organizationId: org.buyer, roles: ['PROCUREMENT_USER'], userId: 'USR-ACT-BUYER' },
        () => wiring.orders.raiseDispute(orderId, { reason: 'the part does not fit' }),
      );

      await acts.disputeObligation(orderId, held.transactionId, 'the part does not fit');
      await acts.resolveObligationDispute(orderId, held.transactionId, 'RELEASE_TO_SUPPLIER');

      expect(calls.map((c) => c.method)).toEqual(['createObligation', 'dispute', 'resolveDispute']);
      expect(calls[1].input.reason).toBe('the part does not fit');
      expect(calls[2].input.resolution).toBe('RELEASE_TO_SUPPLIER');
    });

    it('records a settlement that will not complete, without moving money', async () => {
      const { orderId } = await placeOrder();
      const { calls, economic } = stubEconomic();
      const acts = activitiesWith(economic);

      const held = await acts.createObligation(orderId);
      await acts.markFundsHeld(orderId, held.transactionId);
      await asActor(
        { organizationId: org.supplier, roles: ['SUPPLIER'], userId: 'USR-ACT-SUP' },
        async () => {
          await wiring.orders.confirm(orderId);
          await wiring.orders.fulfill(orderId, {});
        },
      );
      await asActor(
        { organizationId: org.buyer, roles: ['PROCUREMENT_USER'], userId: 'USR-ACT-BUYER' },
        () => wiring.orders.confirmReceipt(orderId, {}),
      );
      await acts.markSettling(orderId);

      await acts.markSettlementFailed(orderId);

      const row = await runUnscoped('the suite reads the stalled order', () =>
        prisma.client.order.findUniqueOrThrow({ where: { id: orderId } }),
      );
      // The buyer has the goods and the money is still held. `docs/08` § 8.4
      // forbids automatic compensation after receipt, so the saga's last act
      // is to put the order back where an operator can retry it — RECEIPT
      // _CONFIRMED, the state settlement is attempted from — rather than to
      // roll anything back. There is deliberately no terminal "settlement
      // failed" status: that would read as finished, and the money is not.
      expect(row.status).toBe('RECEIPT_CONFIRMED');
      // The only assertion that really matters here: nothing was refunded.
      // Returning the funds after the buyer has the goods would hand them both.
      expect(calls.some((c) => c.method === 'refund')).toBe(false);
    });

    it('records an elapsed window without moving money or notifying anyone', async () => {
      // ADR-043: the reminder is a history row and a counter. There is no
      // notification-service to call, and pretending to send one would claim a
      // capability the platform does not have.
      const { orderId } = await placeOrder();
      const { calls, economic } = stubEconomic();
      const acts = activitiesWith(economic);

      const held = await acts.createObligation(orderId);
      await acts.markFundsHeld(orderId, held.transactionId);

      await acts.recordReminder(orderId);

      const row = await runUnscoped('the suite reads the reminded order', () =>
        prisma.client.order.findUniqueOrThrow({ where: { id: orderId } }),
      );
      expect(row.status).toBe('FUNDS_HELD');
      expect(calls.map((c) => c.method)).toEqual(['createObligation']);
    });
  });
});
