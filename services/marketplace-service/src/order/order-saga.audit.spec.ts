import { createSystemContext, runWithContext } from '@rasta/nest-common';
import type { EventPublisher } from '../events/publisher';
import { MARKETPLACE_EVENTS, validateMarketplacePayload } from '../events/events';
import type { PrismaService } from '../prisma/prisma.service';
import type { MarketplaceEnv } from '../config/env';
import type { OrderStatus } from '../generated/prisma';
import type { LockedOrderRow, OrderRepository, SagaStep } from './order.repository';
import { OrderService, SAGA_CLOCK_SKEW_MS } from './order.service';

/**
 * The saga's internal transitions are audited (AGENTS.md S-06, global audit
 * L7-14): holding funds, failing to, starting a settlement attempt and
 * failing one. Each moved the order and published nothing; each now records
 * exactly one event in the transition's own transaction, under the buyer's
 * tenant — and none when the step changed nothing.
 *
 * That the event and the row commit together is proven against PostgreSQL in
 * `test/audit-records.int-spec.ts`.
 */

const BUYER = 'ORG-BUYER';

function order(overrides: Partial<LockedOrderRow> = {}): LockedOrderRow {
  return {
    id: 'ORD_1',
    organizationId: BUYER,
    supplierOrganizationId: 'ORG-SUPPLIER',
    status: 'PENDING',
    totalAmountMinor: 500000n,
    currency: 'IRR',
    economicTransactionId: null,
    correlationId: 'COR_1',
    cancellationCause: null,
    ...overrides,
  };
}

let steps = 0;
/** A step of its own, as each separately scheduled activity has (D-053). */
const sagaStep = (): SagaStep => ({
  key: `order-ORD_1/run-1/${++steps}`,
  scheduledAt: new Date('2026-10-15T10:00:00Z'),
});

function harness(
  row: LockedOrderRow,
  recorded: { result: unknown } | null = null,
  /** Whether the order's history holds the step's own row (D-053, old workers). */
  inHistory = false,
) {
  const enqueued: Array<{
    tx: unknown;
    eventName: string;
    organizationId: string;
    payload: unknown;
  }> = [];
  const tx = {
    order: { update: jest.fn(async () => undefined) },
    orderLine: { findMany: jest.fn(async () => []) },
  };
  const prisma = {
    transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;
  const repository = {
    lockOrder: jest.fn(async () => row),
    recordHistory: jest.fn(async () => undefined),
    restoreAvailability: jest.fn(async () => undefined),
    findSagaStep: jest.fn(async () => recorded),
    recordSagaStep: jest.fn(async () => undefined),
    hasSagaHistorySince: jest.fn(async () => inHistory),
  } as unknown as OrderRepository;
  const events = {
    enqueue: jest.fn(
      async (
        client: unknown,
        input: { eventName: string; organizationId: string; payload: unknown },
      ) => {
        validateMarketplacePayload(input.eventName as never, input.payload);
        enqueued.push({ tx: client, ...input });
      },
    ),
  } as unknown as EventPublisher;

  const service = new OrderService(prisma, repository, events, {} as MarketplaceEnv, {
    // The saga steps under test ask no hierarchy question.
    withinVersion: () => Promise.reject(new Error('not asked by the saga')),
  });
  const asSaga = <T>(fn: () => Promise<T>) =>
    runWithContext(
      createSystemContext({
        correlationId: 'COR_1',
        callerService: 'marketplace-service',
        organizationId: BUYER,
      }),
      fn,
    );

  return { tx, enqueued, service, asSaga, repository };
}

const parties = {
  orderId: 'ORD_1',
  buyerOrganizationId: BUYER,
  supplierOrganizationId: 'ORG-SUPPLIER',
  totalAmountMinor: '500000',
  currency: 'IRR',
};

describe('the saga’s transitions are audited', () => {
  it.each<
    [
      string,
      OrderStatus,
      (s: OrderService) => Promise<OrderStatus>,
      string,
      Record<string, unknown>,
    ]
  >([
    [
      'markFundsHeld',
      'PENDING',
      (s) => s.markFundsHeld('ORD_1', 'TXN_1', sagaStep()),
      MARKETPLACE_EVENTS.ORDER_FUNDS_HELD,
      { transactionId: 'TXN_1', status: 'FUNDS_HELD' },
    ],
    [
      'markFailed',
      'PENDING',
      (s) => s.markFailed('ORD_1', 'wallet empty', sagaStep()),
      MARKETPLACE_EVENTS.ORDER_FAILED,
      {},
    ],
    [
      'markSettling',
      'RECEIPT_CONFIRMED',
      (s) => s.markSettling('ORD_1', sagaStep()),
      MARKETPLACE_EVENTS.ORDER_SETTLEMENT_STARTED,
      {},
    ],
    [
      'markSettlementFailed',
      'SETTLING',
      (s) => s.markSettlementFailed('ORD_1', sagaStep()),
      MARKETPLACE_EVENTS.ORDER_SETTLEMENT_FAILED,
      {},
    ],
  ])(
    '%s records exactly one event, in its transaction, under the buyer',
    async (_step, from, step, eventName, extra) => {
      const h = harness(order({ status: from }));

      await h.asSaga(() => step(h.service));

      expect(h.enqueued).toEqual([
        {
          tx: h.tx,
          eventName,
          aggregateId: 'ORD_1',
          organizationId: BUYER,
          payload: expect.objectContaining({ ...parties, ...extra }),
        },
      ]);
    },
  );

  it('does not put the failure reason on ORDER_FAILED', async () => {
    const h = harness(order({ status: 'PENDING' }));

    await h.asSaga(() =>
      h.service.markFailed('ORD_1', 'connect ECONNREFUSED economic:3112', sagaStep()),
    );

    expect(JSON.stringify(h.enqueued[0].payload)).not.toContain('ECONNREFUSED');
  });

  it('records the hold on an order the buyer cancelled meanwhile, as CANCELLING', async () => {
    // The money is held either way, and that is the fact recorded.
    const h = harness(order({ status: 'CANCELLING' }));

    await expect(
      h.asSaga(() => h.service.markFundsHeld('ORD_1', 'TXN_1', sagaStep())),
    ).resolves.toBe('CANCELLING');

    expect(h.enqueued).toEqual([
      expect.objectContaining({
        eventName: MARKETPLACE_EVENTS.ORDER_FUNDS_HELD,
        payload: expect.objectContaining({ transactionId: 'TXN_1', status: 'CANCELLING' }),
      }),
    ]);
  });

  it('records nothing when a retry re-runs a hold already recorded on a cancelling order', async () => {
    const h = harness(order({ status: 'CANCELLING', economicTransactionId: 'TXN_1' }));

    await h.asSaga(() => h.service.markFundsHeld('ORD_1', 'TXN_1', sagaStep()));

    expect(h.enqueued).toEqual([]);
  });

  it.each<[string, OrderStatus, (s: OrderService) => Promise<OrderStatus>]>([
    ['a retried hold', 'FUNDS_HELD', (s) => s.markFundsHeld('ORD_1', 'TXN_1', sagaStep())],
    ['a retried failure', 'FAILED', (s) => s.markFailed('ORD_1', 'wallet empty', sagaStep())],
    [
      'a settlement that yields to a dispute',
      'DISPUTED',
      (s) => s.markSettling('ORD_1', sagaStep()),
    ],
  ])('records nothing for %s', async (_label, current, step) => {
    const h = harness(order({ status: current }));

    await h.asSaga(() => step(h.service));

    expect(h.enqueued).toEqual([]);
  });
});

describe('a retried saga step answers what its first attempt answered (D-053)', () => {
  it.each<[string, OrderStatus, (s: OrderService, step: SagaStep) => Promise<OrderStatus>]>([
    ['markFundsHeld', 'FUNDS_HELD', (s, step) => s.markFundsHeld('ORD_1', 'TXN_1', step)],
    ['markFailed', 'FAILED', (s, step) => s.markFailed('ORD_1', 'wallet empty', step)],
    ['markSettling', 'SETTLING', (s, step) => s.markSettling('ORD_1', step)],
    [
      'markSettlementFailed',
      'RECEIPT_CONFIRMED',
      (s, step) => s.markSettlementFailed('ORD_1', step),
    ],
    [
      'markCompleted',
      'COMPLETED',
      (s, step) =>
        s.markCompleted(
          'ORD_1',
          { settlementId: 'STL_1', commissionAmountMinor: '0', netAmountMinor: '500000' },
          step,
        ),
    ],
    ['markCancelled', 'CANCELLED', (s, step) => s.markCancelled('ORD_1', 'changed', step)],
  ])(
    '%s returns its record, wherever the order has moved since, and writes nothing',
    async (activity, recordedStatus, run) => {
      // An order no step of the saga may leave: only the record can answer.
      const h = harness(order({ status: 'DISPUTED' }), { result: { status: recordedStatus } });
      const step = sagaStep();

      await expect(h.asSaga(() => run(h.service, step))).resolves.toBe(recordedStatus);

      expect(h.repository.findSagaStep).toHaveBeenCalledWith(
        h.tx,
        expect.objectContaining({ id: 'ORD_1' }),
        step,
        activity,
      );
      expect(h.tx.order.update).not.toHaveBeenCalled();
      expect(h.repository.recordHistory).not.toHaveBeenCalled();
      expect(h.repository.recordSagaStep).not.toHaveBeenCalled();
      expect(h.enqueued).toEqual([]);
    },
  );

  it.each<[string, OrderStatus, OrderStatus]>([
    ['a move', 'PENDING', 'FUNDS_HELD'],
    ['a yield', 'CANCELLING', 'CANCELLING'],
    ['an order already there', 'FUNDS_HELD', 'FUNDS_HELD'],
  ])('records %s, in the step’s own transaction', async (_label, current, answered) => {
    const h = harness(order({ status: current }));
    const step = sagaStep();

    await expect(h.asSaga(() => h.service.markFundsHeld('ORD_1', 'TXN_1', step))).resolves.toBe(
      answered,
    );

    expect(h.repository.recordSagaStep).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({ id: 'ORD_1', organizationId: BUYER }),
      step,
      'markFundsHeld',
      { status: answered },
    );
  });

  it('records no step that was refused, so its retry is judged again', async () => {
    const h = harness(order({ status: 'CONFIRMED' }));

    await expect(h.asSaga(() => h.service.markSettling('ORD_1', sagaStep()))).rejects.toMatchObject(
      { code: 'BUSINESS_RULE_VIOLATION' },
    );
    expect(h.repository.recordSagaStep).not.toHaveBeenCalled();
  });

  it('recognises an unrecorded hold by its obligation once the order has moved on', async () => {
    // A retry whose first attempt ran before the record existed: the supplier
    // confirmed in between. economic_transaction_id is unique and written
    // only by this step, so the hold is this step's own.
    const h = harness(order({ status: 'CONFIRMED', economicTransactionId: 'TXN_1' }));

    await expect(
      h.asSaga(() => h.service.markFundsHeld('ORD_1', 'TXN_1', sagaStep())),
    ).resolves.toBe('CONFIRMED');
    expect(h.tx.order.update).not.toHaveBeenCalled();
    expect(h.enqueued).toEqual([]);
  });

  it('still refuses a hold of another obligation on an order that moved on', async () => {
    const h = harness(order({ status: 'CONFIRMED', economicTransactionId: 'TXN_1' }));

    await expect(
      h.asSaga(() => h.service.markFundsHeld('ORD_1', 'TXN_OTHER', sagaStep())),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
  });

  describe('a step applied before its record existed (old workers; Codex on #283, finding 3)', () => {
    // Each order is in a state its step would refuse, and the only evidence
    // is the history row the old worker wrote in the step's transaction.
    it.each<
      [
        string,
        OrderStatus,
        OrderStatus,
        { from: OrderStatus[]; reason: string | null },
        (s: OrderService, step: SagaStep) => Promise<OrderStatus>,
      ]
    >([
      [
        'markFundsHeld',
        'CONFIRMED',
        'FUNDS_HELD',
        { from: ['PENDING'], reason: null },
        (s, step) => s.markFundsHeld('ORD_1', 'TXN_1', step),
      ],
      [
        'markFailed',
        'CONFIRMED',
        'FAILED',
        { from: ['PENDING'], reason: 'wallet empty' },
        (s, step) => s.markFailed('ORD_1', 'wallet empty', step),
      ],
      [
        'markSettling',
        'CONFIRMED',
        'SETTLING',
        { from: ['RECEIPT_CONFIRMED'], reason: null },
        (s, step) => s.markSettling('ORD_1', step),
      ],
      [
        'markSettlementFailed',
        'DISPUTED',
        'RECEIPT_CONFIRMED',
        { from: ['SETTLING'], reason: null },
        (s, step) => s.markSettlementFailed('ORD_1', step),
      ],
      [
        'markCompleted',
        'DISPUTED',
        'COMPLETED',
        { from: ['SETTLING'], reason: null },
        (s, step) =>
          s.markCompleted(
            'ORD_1',
            { settlementId: 'STL_1', commissionAmountMinor: '0', netAmountMinor: '500000' },
            step,
          ),
      ],
      [
        'markCancelled',
        'DISPUTED',
        'CANCELLED',
        { from: ['CANCELLING'], reason: 'changed' },
        (s, step) => s.markCancelled('ORD_1', 'changed', step),
      ],
    ])(
      '%s answers from its own history row, records that answer and writes nothing else',
      async (activity, current, to, edge, run) => {
        const h = harness(order({ status: current }), null, true);
        const step = sagaStep();

        await expect(h.asSaga(() => run(h.service, step))).resolves.toBe(to);

        expect(h.repository.hasSagaHistorySince).toHaveBeenCalledWith(
          h.tx,
          expect.objectContaining({ id: 'ORD_1', organizationId: BUYER }),
          {
            kind: 'TRANSITION',
            from: edge.from,
            to,
            reason: edge.reason,
            // The activity's first scheduling, less the clock allowance.
            since: new Date(step.scheduledAt.getTime() - SAGA_CLOCK_SKEW_MS),
          },
        );
        expect(h.repository.recordSagaStep).toHaveBeenCalledWith(
          h.tx,
          expect.objectContaining({ id: 'ORD_1' }),
          step,
          activity,
          { status: to },
        );
        expect(h.tx.order.update).not.toHaveBeenCalled();
        expect(h.repository.recordHistory).not.toHaveBeenCalled();
        expect(h.enqueued).toEqual([]);
      },
    );

    it('still refuses when the history holds no row of the step since it was scheduled', async () => {
      const h = harness(order({ status: 'DISPUTED' }), null, false);

      await expect(
        h.asSaga(() => h.service.markSettlementFailed('ORD_1', sagaStep())),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
      expect(h.repository.recordSagaStep).not.toHaveBeenCalled();
    });

    it('still refuses a finished order as finished, whatever the history holds', async () => {
      // Only a later saga step finishes an order, and none runs while the saga
      // waits on this one.
      const h = harness(order({ status: 'COMPLETED' }), null, true);

      await expect(
        h.asSaga(() => h.service.markSettling('ORD_1', sagaStep())),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
      expect(h.repository.hasSagaHistorySince).not.toHaveBeenCalled();
    });

    it('does not look at the history for a step the order’s state already answers', async () => {
      const h = harness(order({ status: 'RECEIPT_CONFIRMED' }), null, true);

      await expect(h.asSaga(() => h.service.markSettling('ORD_1', sagaStep()))).resolves.toBe(
        'SETTLING',
      );
      expect(h.repository.hasSagaHistorySince).not.toHaveBeenCalled();
      expect(h.enqueued).toHaveLength(1);
    });

    it('counts a reminder once when its history row predates its record', async () => {
      const h = harness(order({ status: 'FUNDS_HELD' }), null, true);
      const step = sagaStep();

      await h.asSaga(() => h.service.recordReminder('ORD_1', step));

      expect(h.repository.hasSagaHistorySince).toHaveBeenCalledWith(h.tx, expect.anything(), {
        kind: 'REMINDER',
        since: new Date(step.scheduledAt.getTime() - SAGA_CLOCK_SKEW_MS),
      });
      expect(h.tx.order.update).not.toHaveBeenCalled();
      expect(h.repository.recordHistory).not.toHaveBeenCalled();
      expect(h.repository.recordSagaStep).toHaveBeenCalledWith(
        h.tx,
        expect.anything(),
        step,
        'recordReminder',
        undefined,
      );
    });
  });

  it('a settlement attempt yields to a dispute already resolved as a refund', async () => {
    // The step ran late: the dispute it would have yielded to has become
    // CANCELLING. The saga reads it and compensates.
    const h = harness(order({ status: 'CANCELLING' }));

    await expect(h.asSaga(() => h.service.markSettling('ORD_1', sagaStep()))).resolves.toBe(
      'CANCELLING',
    );
    expect(h.tx.order.update).not.toHaveBeenCalled();
    expect(h.enqueued).toEqual([]);
  });

  it('refuses a record that holds no order status rather than guessing one', async () => {
    const h = harness(order({ status: 'CONFIRMED' }), { result: null });

    await expect(h.asSaga(() => h.service.markSettling('ORD_1', sagaStep()))).rejects.toThrow(
      /holds no order status/,
    );
  });
});

describe('an economic-service step runs once per scheduled activity (D-053)', () => {
  const buyerOrder = { id: 'ORD_1', organizationId: BUYER };
  const settled = { settlementId: 'STL_1', commissionAmountMinor: '0', netAmountMinor: '500000' };

  it('calls once and records the answer under the step', async () => {
    const h = harness(order());
    const call = jest.fn(async () => settled);
    const step = sagaStep();

    await expect(h.service.onceForSaga(buyerOrder, step, 'settle', call)).resolves.toEqual(settled);

    expect(call).toHaveBeenCalledTimes(1);
    expect(h.repository.recordSagaStep).toHaveBeenCalledWith(
      undefined,
      buyerOrder,
      step,
      'settle',
      settled,
    );
  });

  it('answers a retry from the record, without calling economic-service', async () => {
    const h = harness(order(), { result: settled });
    const call = jest.fn(async () => ({ ...settled, settlementId: 'STL_SECOND' }));

    await expect(h.service.onceForSaga(buyerOrder, sagaStep(), 'settle', call)).resolves.toEqual(
      settled,
    );
    expect(call).not.toHaveBeenCalled();
    expect(h.repository.recordSagaStep).not.toHaveBeenCalled();
  });

  it('answers a retry of a step that returns nothing with nothing', async () => {
    const h = harness(order(), { result: null });
    const call = jest.fn(async () => undefined);

    await expect(
      h.service.onceForSaga(buyerOrder, sagaStep(), 'authoriseSettlement', call),
    ).resolves.toBeUndefined();
    expect(call).not.toHaveBeenCalled();
  });

  it('still returns an answer it could not record: the money moved', async () => {
    const h = harness(order());
    jest.mocked(h.repository.recordSagaStep).mockRejectedValueOnce(new Error('connection lost'));

    await expect(
      h.service.onceForSaga(buyerOrder, sagaStep(), 'settle', async () => settled),
    ).resolves.toEqual(settled);
  });

  it('records nothing when economic-service refuses, so the retry asks again', async () => {
    const h = harness(order());

    await expect(
      h.service.onceForSaga(buyerOrder, sagaStep(), 'settle', async () => {
        throw new Error('economic-service unavailable');
      }),
    ).rejects.toThrow('economic-service unavailable');
    expect(h.repository.recordSagaStep).not.toHaveBeenCalled();
  });
});
