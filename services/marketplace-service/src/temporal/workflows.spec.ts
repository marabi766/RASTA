import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/activity';
import { orderSaga, type OrderSagaInput, type SagaStatus } from './workflows';
import type { OrderActivities } from './activities';

/**
 * `OrderSagaWorkflow`, against Temporal's own test environment.
 *
 * Not a mock: `TestWorkflowEnvironment` runs a real Temporal server with a
 * **time-skipping** clock, so a seven-day wait completes in milliseconds while
 * the workflow still executes the code path it would in production. That is
 * what makes it possible to test a saga whose real duration is a week.
 *
 * The properties asserted here are the ones a unit test of the state machine
 * cannot reach: what the saga *calls*, in what order, and what it does **not**
 * call when a window expires.
 */

jest.setTimeout(120_000);

const INPUT: OrderSagaInput = {
  orderId: 'ORD_TEST',
  fulfillmentWindowDays: 7,
  receiptWindowDays: 3,
  reminderIntervalDays: 3,
};

/** Records every activity call, so the test can assert on the sequence. */
function recordingActivities(overrides: Partial<OrderActivities> = {}) {
  const calls: string[] = [];
  const record =
    <T>(name: string, result: T) =>
    async () => {
      calls.push(name);
      return result;
    };

  const activities: OrderActivities = {
    createObligation: record('createObligation', { transactionId: 'TXN_1' }),
    markFundsHeld: record('markFundsHeld', undefined),
    markFailed: record('markFailed', undefined),
    authoriseSettlement: record('authoriseSettlement', undefined),
    markSettling: record('markSettling', undefined),
    settle: record('settle', {
      settlementId: 'STL_1',
      commissionAmountMinor: '12500',
      netAmountMinor: '487500',
    }),
    markSettlementFailed: record('markSettlementFailed', undefined),
    markCompleted: record('markCompleted', undefined),
    compensate: record('compensate', undefined),
    markCancelled: record('markCancelled', undefined),
    disputeObligation: record('disputeObligation', undefined),
    resolveObligationDispute: record('resolveObligationDispute', undefined),
    recordReminder: record('recordReminder', undefined),
    ...overrides,
  } as OrderActivities;

  return { calls, activities };
}

describe('the order saga', () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  });

  afterAll(async () => {
    await env?.teardown();
  });

  async function run(
    activities: OrderActivities,
    drive: (handle: {
      signal: (name: string, ...args: unknown[]) => Promise<void>;
      query: () => Promise<SagaStatus>;
    }) => Promise<void>,
    input: OrderSagaInput = INPUT,
  ): Promise<string> {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'test-order',
      workflowsPath: require.resolve('./workflows'),
      activities,
    });

    return worker.runUntil(async () => {
      const handle = await env.client.workflow.start(orderSaga, {
        taskQueue: 'test-order',
        workflowId: `test-${input.orderId}-${Math.trunc(performance.now() * 1000)}`,
        args: [input],
      });

      await drive({
        signal: (name, ...args) => handle.signal(name, ...args),
        query: () => handle.query<SagaStatus, []>('status'),
      });

      return handle.result();
    });
  }

  it('holds funds, waits for both parties, then settles', async () => {
    const { calls, activities } = recordingActivities();

    const result = await run(activities, async ({ signal }) => {
      await signal('orderConfirmed');
      await signal('orderFulfilled');
      await signal('receiptConfirmed');
    });

    expect(result).toBe('COMPLETED');
    // The order matters as much as the membership: authorising before
    // confirming receipt, or settling before authorising, would each be a
    // financial defect.
    expect(calls).toEqual([
      'createObligation',
      'markFundsHeld',
      'authoriseSettlement',
      'markSettling',
      'settle',
      'markCompleted',
    ]);
  });

  it('records reminders when a window expires and still does not settle', async () => {
    // ADR-043 / Q-11, the invariant this whole file exists for. The workflow
    // is left waiting past both windows and must not confirm anything.
    const { calls, activities } = recordingActivities();

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'test-order',
      workflowsPath: require.resolve('./workflows'),
      activities,
    });

    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(orderSaga, {
        taskQueue: 'test-order',
        workflowId: `test-overdue-${Math.trunc(performance.now() * 1000)}`,
        args: [INPUT],
      });

      // Skip well past the fulfilment window and several reminder intervals.
      await env.sleep('20 days');
      const status = await handle.query<SagaStatus, []>('status');

      expect(status.remindersRecorded).toBeGreaterThan(0);
      expect(calls).toContain('recordReminder');

      // Nothing that moves money has been called.
      expect(calls).not.toContain('authoriseSettlement');
      expect(calls).not.toContain('settle');
      expect(calls).not.toContain('markCompleted');
      expect(calls).not.toContain('compensate');
      // And the order has not been closed either — it is still waiting.
      expect(calls).not.toContain('markCancelled');

      await handle.terminate('test finished');
    });
  });

  it('never confirms receipt on its own, however long it waits', async () => {
    const { calls, activities } = recordingActivities();

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'test-order',
      workflowsPath: require.resolve('./workflows'),
      activities,
    });

    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(orderSaga, {
        taskQueue: 'test-order',
        workflowId: `test-no-autoconfirm-${Math.trunc(performance.now() * 1000)}`,
        args: [INPUT],
      });

      await handle.signal('orderConfirmed');
      await handle.signal('orderFulfilled');
      // Past the receipt window many times over.
      await env.sleep('90 days');

      const status = await handle.query<SagaStatus, []>('status');
      expect(status.phase).toBe('AWAITING_RECEIPT_CONFIRMATION');
      expect(calls).not.toContain('settle');

      await handle.terminate('test finished');
    });
  });

  it('compensates when the buyer cancels, and only then reports it cancelled', async () => {
    const { calls, activities } = recordingActivities();

    const result = await run(activities, async ({ signal }) => {
      await signal('orderConfirmed');
      await signal('orderCancelled', 'no longer needed');
    });

    expect(result).toBe('CANCELLED');
    // The refund precedes the closure, so an order is never reported cancelled
    // before the money has actually come back.
    expect(calls.indexOf('compensate')).toBeLessThan(calls.indexOf('markCancelled'));
    expect(calls).not.toContain('settle');
  });

  it('stops at a dispute and settles nothing until it is resolved', async () => {
    const { calls, activities } = recordingActivities();

    const result = await run(activities, async ({ signal }) => {
      await signal('orderConfirmed');
      await signal('orderFulfilled');
      await signal('orderDisputed', 'the delivered goods do not match the offer');
      // Nothing else happens until an operator decides.
      await signal('disputeResolved', 'SETTLE');
    });

    expect(result).toBe('COMPLETED');
    // economic-service is told before anything waits, so a direct settlement
    // command there is refused too (ADR-040 § 5).
    expect(calls.indexOf('disputeObligation')).toBeGreaterThan(-1);
    expect(calls.indexOf('disputeObligation')).toBeLessThan(calls.indexOf('settle'));
    // And the resolution is mirrored back, or economic-service would still
    // refuse to settle a transaction it believes is disputed.
    expect(calls.indexOf('resolveObligationDispute')).toBeLessThan(calls.indexOf('settle'));
  });

  it('refunds when a dispute is resolved against the supplier', async () => {
    const { calls, activities } = recordingActivities();

    const result = await run(activities, async ({ signal }) => {
      await signal('orderConfirmed');
      await signal('orderFulfilled');
      await signal('orderDisputed', 'the goods never arrived');
      await signal('disputeResolved', 'REFUND');
    });

    expect(result).toBe('CANCELLED');
    expect(calls).toContain('disputeObligation');
    expect(calls).toContain('compensate');
    expect(calls).not.toContain('settle');
  });

  it('fails the order without compensating when the hold cannot be placed', async () => {
    // Nothing moved, so there is nothing to compensate — and calling refund on
    // a transaction that was never created would fail for a second reason.
    const { calls, activities } = recordingActivities({
      createObligation: async () => {
        throw ApplicationFailure.nonRetryable('Insufficient balance', 'INSUFFICIENT_BALANCE');
      },
    });

    const result = await run(activities, async () => undefined);

    expect(result).toBe('FAILED');
    expect(calls).toContain('markFailed');
    expect(calls).not.toContain('compensate');
    expect(calls).not.toContain('markFundsHeld');
  });

  it('retries a failed settlement and gives up without compensating', async () => {
    // `docs/08` § 8.4: after receipt confirmation there is no automatic
    // financial compensation. Five attempts, then a human.
    let attempts = 0;
    const { calls, activities } = recordingActivities({
      settle: async () => {
        attempts += 1;
        throw ApplicationFailure.nonRetryable('The ledger is unavailable', 'UPSTREAM_UNAVAILABLE');
      },
    });

    await expect(
      run(activities, async ({ signal }) => {
        await signal('orderConfirmed');
        await signal('orderFulfilled');
        await signal('receiptConfirmed');
      }),
    ).rejects.toThrow();

    expect(attempts).toBe(5);
    expect(calls.filter((c) => c === 'markSettlementFailed')).toHaveLength(5);
    // The money stays held. Undoing a payment the platform is not sure failed
    // is a larger risk than the failure itself.
    expect(calls).not.toContain('compensate');
    expect(calls).not.toContain('markCancelled');
  });

  it('reports the saga steps that are deferred rather than hiding them', async () => {
    // `docs/08` § 8.4 step 3 is `inventory.reserveStock`. Deleting it would
    // mean somebody has to rediscover it was ever required (ADR-041 § 2).
    const { activities } = recordingActivities();

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'test-order',
      workflowsPath: require.resolve('./workflows'),
      activities,
    });

    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(orderSaga, {
        taskQueue: 'test-order',
        workflowId: `test-deferred-${Math.trunc(performance.now() * 1000)}`,
        args: [INPUT],
      });

      const status = await handle.query<SagaStatus, []>('status');
      expect(status.deferredSteps).toContain('RESERVE_STOCK');
      expect(status.deferredSteps).toContain('NOTIFY_SUPPLIER');

      await handle.terminate('test finished');
    });
  });
});
