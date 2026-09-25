import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/activity';
import { WorkflowFailedError, type WorkflowHandle } from '@temporalio/client';
import { orderSaga, type OrderSagaInput, type SagaStatus } from './workflows';
import type { OrderActivities, SagaOrderView } from './activities';

/**
 * `OrderSagaWorkflow`, against Temporal's own test environment.
 *
 * Not a mock: `TestWorkflowEnvironment` runs a real Temporal server with a
 * **time-skipping** clock, so a seven-day wait completes in milliseconds while
 * the workflow still executes the code path it would in production. That is
 * what makes it possible to test a saga whose real duration is a week.
 *
 * ## The order is a small in-memory stand-in
 *
 * The saga decides on what the order row says (ADR-039), so these tests need
 * an order that the parties change and the saga reads. {@link FakeOrder} is
 * that row. Its party commands apply the same source states as
 * `OrderService`, and its saga steps apply the same `from` and `yieldTo`
 * rules as `systemTransition`. Those rules are asserted against the real
 * database in `test/activities.int-spec.ts`. What this file asserts is the
 * workflow: what it calls, in what order, and what it does not call, on
 * every interleaving that once went wrong.
 *
 * A party command here is what the HTTP layer does: commit, then signal.
 * {@link Party.silently} commits without the signal, which is how a lost
 * signal is reproduced.
 */

jest.setTimeout(120_000);

const INPUT: OrderSagaInput = {
  orderId: 'ORD_TEST',
  fulfillmentWindowDays: 7,
  receiptWindowDays: 3,
  reminderIntervalDays: 3,
  recheckIntervalHours: 24,
};

type Status = SagaOrderView['status'];

const TRANSACTION = 'TXN_1';

class FakeOrder {
  status: Status = 'PENDING';
  economicTransactionId: string | null = null;
  cancellationReason: string | null = null;
  dispute: { reason: string; resolution: string | null } | null = null;
  /** Every status the order passed through, for asserting on history. */
  readonly history: Status[] = ['PENDING'];

  view(): SagaOrderView {
    return {
      status: this.status,
      economicTransactionId: this.economicTransactionId,
      cancellationReason: this.cancellationReason,
      dispute: this.dispute ? { ...this.dispute } : null,
    };
  }

  move(from: readonly Status[], to: Status): void {
    if (!from.includes(this.status)) {
      throw ApplicationFailure.nonRetryable(
        `cannot move ${this.status} to ${to}`,
        'BUSINESS_RULE_VIOLATION',
      );
    }
    this.status = to;
    this.history.push(to);
  }

  /** `systemTransition`: idempotent at `to`, yields to `yieldTo`, else `from`. */
  step(to: Status, from: readonly Status[], yieldTo: readonly Status[] = []): Status {
    if (this.status === to || yieldTo.includes(this.status)) return this.status;
    this.move(from, to);
    return to;
  }

  // ---- The parties' commands, with OrderService's source states -----------
  confirm(): void {
    this.move(['FUNDS_HELD'], 'CONFIRMED');
  }
  fulfil(): void {
    this.move(['CONFIRMED'], 'AWAITING_RECEIPT_CONFIRMATION');
  }
  confirmReceipt(): void {
    this.move(['AWAITING_RECEIPT_CONFIRMATION'], 'RECEIPT_CONFIRMED');
  }
  raiseDispute(reason: string): void {
    this.move(
      ['FUNDS_HELD', 'CONFIRMED', 'AWAITING_RECEIPT_CONFIRMATION', 'RECEIPT_CONFIRMED'],
      'DISPUTED',
    );
    this.dispute = { reason, resolution: null };
  }
  resolveDispute(outcome: 'SETTLE' | 'REFUND', resolution: string): void {
    this.move(['DISPUTED'], outcome === 'SETTLE' ? 'RECEIPT_CONFIRMED' : 'CANCELLING');
    if (this.dispute) this.dispute.resolution = resolution;
    if (outcome === 'REFUND') this.cancellationReason = resolution;
  }
  cancel(reason: string): void {
    this.move(
      ['PENDING', 'FUNDS_HELD', 'CONFIRMED', 'AWAITING_RECEIPT_CONFIRMATION'],
      'CANCELLING',
    );
    this.cancellationReason = reason;
  }
}

/** Records every activity call, so the test can assert on the sequence. */
function recordingActivities(order: FakeOrder, overrides: Partial<OrderActivities> = {}) {
  const calls: string[] = [];
  const recorded =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R | Promise<R>) =>
    async (...args: A): Promise<R> => {
      calls.push(name);
      return fn(...args);
    };

  const activities: OrderActivities = {
    readOrder: recorded('readOrder', () => order.view()),
    createObligation: recorded('createObligation', () => ({ transactionId: TRANSACTION })),
    findObligation: recorded('findObligation', () => null),
    markFundsHeld: recorded('markFundsHeld', (_id: string, transactionId: string) => {
      order.economicTransactionId = transactionId;
      return order.step('FUNDS_HELD', ['PENDING'], ['CANCELLING']);
    }),
    markFailed: recorded('markFailed', () => order.step('FAILED', ['PENDING'], ['CANCELLING'])),
    authoriseSettlement: recorded('authoriseSettlement', () => undefined),
    markSettling: recorded('markSettling', () =>
      order.step('SETTLING', ['RECEIPT_CONFIRMED'], ['DISPUTED']),
    ),
    settle: recorded('settle', () => ({
      settlementId: 'STL_1',
      commissionAmountMinor: '12500',
      netAmountMinor: '487500',
    })),
    markSettlementFailed: recorded('markSettlementFailed', () =>
      order.step('RECEIPT_CONFIRMED', ['SETTLING']),
    ),
    markCompleted: recorded('markCompleted', () => order.step('COMPLETED', ['SETTLING'])),
    compensate: recorded('compensate', () => undefined),
    markCancelled: recorded('markCancelled', () => order.step('CANCELLED', ['CANCELLING'])),
    disputeObligation: recorded('disputeObligation', () => undefined),
    resolveObligationDispute: recorded('resolveObligationDispute', () => undefined),
    recordReminder: recorded('recordReminder', () => undefined),
    ...overrides,
  } as OrderActivities;

  /** The calls that act on the world. Reads are how the saga looks, not what it does. */
  const effects = (): string[] => calls.filter((c) => c !== 'readOrder');

  return { calls, effects, activities };
}

/** A party acting on the order the way the HTTP layer does: commit, then signal. */
class Party {
  constructor(
    private readonly order: FakeOrder,
    private readonly handle: WorkflowHandle,
  ) {}

  async confirm(): Promise<void> {
    this.order.confirm();
    await this.handle.signal('orderConfirmed');
  }
  async fulfil(): Promise<void> {
    this.order.fulfil();
    await this.handle.signal('orderFulfilled');
  }
  async confirmReceipt(): Promise<void> {
    this.order.confirmReceipt();
    await this.handle.signal('receiptConfirmed');
  }
  async dispute(reason: string): Promise<void> {
    this.order.raiseDispute(reason);
    await this.handle.signal('orderDisputed', reason);
  }
  async resolve(outcome: 'SETTLE' | 'REFUND', resolution: string): Promise<void> {
    this.order.resolveDispute(outcome, resolution);
    await this.handle.signal('disputeResolved', outcome);
  }
  async cancel(reason: string): Promise<void> {
    this.order.cancel(reason);
    await this.handle.signal('orderCancelled', reason);
  }

  /** The command commits, and its signal is lost. */
  silently(command: (order: FakeOrder) => void): void {
    command(this.order);
  }
}

/** Polls, in real time, until the saga has moved the order where a test needs it. */
/**
 * How long one drive, or one wait for a result, may take before the test gives
 * up — well inside jest's 120 s, so that a stuck saga is terminated and its
 * worker shut down by `run()` itself. When jest's own timeout fired first, the
 * worker was still running: the next test failed with "Cannot close
 * connection while Workers hold a reference", and every test after it too.
 */
const STEP_DEADLINE_MS = 45_000;

/** `promise`, or a rejection naming `what` once `ms` have passed. */
async function within<T>(ms: number, promise: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms waiting for ${what}`)), ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** `until`, for a condition only a query can answer. */
async function eventually(predicate: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe('the order saga', () => {
  let env: TestWorkflowEnvironment;
  let queues = 0;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  });

  afterAll(async () => {
    await env?.teardown();
  });

  /**
   * Starts the saga for `order`, lets `drive` act as the parties, and returns
   * the saga's result. With `keepRunning`, the saga is terminated after
   * `drive` instead of awaited — for the waits that never end on their own.
   */
  async function run(
    order: FakeOrder,
    activities: OrderActivities,
    drive: (ctx: {
      party: Party;
      handle: WorkflowHandle;
      held: () => Promise<void>;
    }) => Promise<void>,
    options: { keepRunning?: boolean } = {},
  ): Promise<string | undefined> {
    // A queue per test. A workflow a test terminates can leave activity tasks
    // behind, and on a shared queue the next test's worker inherited them.
    const taskQueue = `test-order-${(queues += 1)}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve('./workflows'),
      activities,
    });

    return worker.runUntil(async () => {
      const handle = await env.client.workflow.start(orderSaga, {
        taskQueue,
        workflowId: `test-${INPUT.orderId}-${Math.trunc(performance.now() * 1000)}`,
        args: [INPUT],
      });

      let finished = false;
      try {
        await within(
          STEP_DEADLINE_MS,
          drive({
            party: new Party(order, handle),
            handle,
            held: () => until(() => order.status !== 'PENDING', 'the hold to be recorded'),
          }),
          'the test to drive the saga',
        );
        if (options.keepRunning) return undefined;
        const result = await within(STEP_DEADLINE_MS, handle.result(), 'the saga to finish');
        finished = true;
        return result;
      } catch (error) {
        // A saga that ended by failing is finished too; terminating it would
        // only replace its own error with "already completed".
        if (error instanceof WorkflowFailedError) finished = true;
        throw error;
      } finally {
        // Whatever happened above, the saga is stopped before the worker is,
        // so `runUntil` returns and the next test starts from nothing.
        if (!finished) await handle.terminate('test finished').catch(() => undefined);
      }
    });
  }

  // -------------------------------------------------------------------------
  // The paths that always worked, and still must
  // -------------------------------------------------------------------------

  it('holds funds, waits for both parties, then settles', async () => {
    const order = new FakeOrder();
    const { effects, activities } = recordingActivities(order);

    const result = await run(order, activities, async ({ party, held }) => {
      await held();
      await party.confirm();
      await party.fulfil();
      await party.confirmReceipt();
    });

    expect(result).toBe('COMPLETED');
    // The order matters as much as the membership: authorising before
    // confirming receipt, or settling before authorising, would each be a
    // financial defect.
    expect(effects()).toEqual([
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
    const order = new FakeOrder();
    const { calls, activities } = recordingActivities(order);

    await run(
      order,
      activities,
      async ({ handle, held }) => {
        await held();
        // Skip well past the fulfilment window and several reminder intervals.
        await env.sleep('20 days');
        const status = await handle.query<SagaStatus, []>('status');
        expect(status.remindersRecorded).toBeGreaterThan(0);
      },
      { keepRunning: true },
    );

    expect(calls).toContain('recordReminder');
    // Nothing that moves money has been called.
    expect(calls).not.toContain('authoriseSettlement');
    expect(calls).not.toContain('settle');
    expect(calls).not.toContain('markCompleted');
    expect(calls).not.toContain('compensate');
    // And the order has not been closed either — it is still waiting.
    expect(calls).not.toContain('markCancelled');
    expect(order.status).toBe('FUNDS_HELD');
  });

  it('never confirms receipt on its own, however long it waits', async () => {
    const order = new FakeOrder();
    const { calls, activities } = recordingActivities(order);

    await run(
      order,
      activities,
      async ({ party, handle, held }) => {
        await held();
        await party.confirm();
        await party.fulfil();
        // Past the receipt window many times over.
        await env.sleep('90 days');
        const status = await handle.query<SagaStatus, []>('status');
        expect(status.phase).toBe('AWAITING_RECEIPT_CONFIRMATION');
      },
      { keepRunning: true },
    );

    expect(calls).not.toContain('settle');
    expect(order.status).toBe('AWAITING_RECEIPT_CONFIRMATION');
  });

  it('compensates when the buyer cancels, and only then reports it cancelled', async () => {
    const order = new FakeOrder();
    const { calls, activities } = recordingActivities(order);

    const result = await run(order, activities, async ({ party, held }) => {
      await held();
      await party.confirm();
      await party.cancel('no longer needed');
    });

    expect(result).toBe('CANCELLED');
    // The refund precedes the closure, so an order is never reported cancelled
    // before the money has actually come back.
    expect(calls.indexOf('compensate')).toBeLessThan(calls.indexOf('markCancelled'));
    expect(calls).not.toContain('settle');
  });

  it('stops at a dispute and settles nothing until it is resolved', async () => {
    const order = new FakeOrder();
    const { calls, activities } = recordingActivities(order);

    const result = await run(order, activities, async ({ party, held }) => {
      await held();
      await party.confirm();
      await party.fulfil();
      await party.dispute('the delivered goods do not match the offer');
      await until(() => calls.includes('disputeObligation'), 'the dispute to be mirrored');
      // Nothing else happens until an operator decides.
      await env.sleep('30 days');
      expect(calls).not.toContain('settle');
      await party.resolve('SETTLE', 'the supplier evidenced correct delivery');
    });

    expect(result).toBe('COMPLETED');
    // economic-service is told before anything waits, so a direct settlement
    // command there is refused too (ADR-040 § 5).
    expect(calls.indexOf('disputeObligation')).toBeLessThan(calls.indexOf('settle'));
    // And the resolution is mirrored back, or economic-service would still
    // refuse to settle a transaction it believes is disputed.
    expect(calls.indexOf('resolveObligationDispute')).toBeLessThan(calls.indexOf('settle'));
  });

  it('refunds when a dispute is resolved against the supplier', async () => {
    const order = new FakeOrder();
    const { calls, activities } = recordingActivities(order);

    const result = await run(order, activities, async ({ party, held }) => {
      await held();
      await party.confirm();
      await party.fulfil();
      await party.dispute('the goods never arrived');
      // A dispute resolved before the saga saw it is never mirrored: the saga
      // reads CANCELLING and refunds a transaction economic-service still holds.
      // Waiting here tests the path where it was mirrored first.
      await until(() => calls.includes('disputeObligation'), 'the dispute to be mirrored');
      await party.resolve('REFUND', 'the goods were never delivered to the buyer');
    });

    expect(result).toBe('CANCELLED');
    expect(calls).toContain('disputeObligation');
    expect(calls).toContain('compensate');
    expect(calls).not.toContain('settle');
  });

  it('fails the order without compensating when the hold is refused', async () => {
    // Nothing moved, so there is nothing to compensate — and calling refund on
    // a transaction that was never created would fail for a second reason.
    const order = new FakeOrder();
    const { calls, activities } = recordingActivities(order, {
      createObligation: async () => {
        throw ApplicationFailure.nonRetryable('Insufficient balance', 'INSUFFICIENT_BALANCE');
      },
    });

    const result = await run(order, activities, async () => undefined);

    expect(result).toBe('FAILED');
    expect(order.status).toBe('FAILED');
    expect(calls).not.toContain('compensate');
    expect(calls).not.toContain('markFundsHeld');
    // Even a refusal is checked: only economic-service can say nothing is held.
    expect(calls.indexOf('findObligation')).toBeLessThan(calls.indexOf('markFailed'));
  });

  it('retries a failed settlement and gives up without compensating', async () => {
    // `docs/08` § 8.4: after receipt confirmation there is no automatic
    // financial compensation. Five attempts, then a human.
    let attempts = 0;
    const order = new FakeOrder();
    const { calls, activities } = recordingActivities(order, {
      settle: async () => {
        attempts += 1;
        throw ApplicationFailure.nonRetryable('The ledger is unavailable', 'UPSTREAM_UNAVAILABLE');
      },
    });

    await expect(
      run(order, activities, async ({ party, held }) => {
        await held();
        await party.confirm();
        await party.fulfil();
        await party.confirmReceipt();
      }),
    ).rejects.toThrow();

    expect(attempts).toBe(5);
    expect(calls.filter((c) => c === 'markSettlementFailed')).toHaveLength(5);
    // The money stays held. Undoing a payment the platform is not sure failed
    // is a larger risk than the failure itself.
    expect(calls).not.toContain('compensate');
    expect(calls).not.toContain('markCancelled');
    expect(order.status).toBe('RECEIPT_CONFIRMED');
  });

  it('reports the saga steps that are deferred rather than hiding them', async () => {
    // `docs/08` § 8.4 step 3 is `inventory.reserveStock`. Deleting it would
    // mean somebody has to rediscover it was ever required (ADR-041 § 2).
    const order = new FakeOrder();
    const { activities } = recordingActivities(order);

    await run(
      order,
      activities,
      async ({ handle, held }) => {
        await held();
        const status = await handle.query<SagaStatus, []>('status');
        expect(status.deferredSteps).toContain('RESERVE_STOCK');
        expect(status.deferredSteps).toContain('NOTIFY_SUPPLIER');
      },
      { keepRunning: true },
    );
  });

  // -------------------------------------------------------------------------
  // Finding 1 — the hold and its local record shared one catch
  // -------------------------------------------------------------------------

  describe('when the hold does not answer cleanly', () => {
    it('carries on with a hold that committed although its reply was lost', async () => {
      // The call failed, but economic-service had committed the hold. Treated
      // as "nothing moved", the order was marked FAILED and its availability
      // restored while the buyer's money stayed held with nothing to release it.
      const order = new FakeOrder();
      const { calls, activities } = recordingActivities(order, {
        createObligation: async () => {
          throw ApplicationFailure.nonRetryable('economic-service timed out', 'UPSTREAM_TIMEOUT');
        },
        findObligation: async () => ({ transactionId: 'TXN_LOST_REPLY' }),
      });

      const result = await run(order, activities, async ({ party, held }) => {
        await held();
        await party.confirm();
        await party.fulfil();
        await party.confirmReceipt();
      });

      expect(result).toBe('COMPLETED');
      expect(calls).not.toContain('markFailed');
      expect(order.economicTransactionId).toBe('TXN_LOST_REPLY');
      expect(order.history).not.toContain('FAILED');
    });

    it('refunds a hold that landed on an order the buyer cancelled meanwhile', async () => {
      // The hold committed; before its record did, the buyer cancelled. The
      // local write used to refuse, the "nothing moved" branch then tried
      // CANCELLING -> FAILED and refused too, and the order stuck in
      // CANCELLING with the funds held.
      const order = new FakeOrder();
      const { calls, activities } = recordingActivities(order, {
        createObligation: async () => {
          order.cancel('ordered against the wrong asset');
          return { transactionId: TRANSACTION };
        },
      });

      const result = await run(order, activities, async () => undefined);

      expect(result).toBe('CANCELLED');
      expect(calls).toContain('compensate');
      expect(calls.indexOf('compensate')).toBeLessThan(calls.indexOf('markCancelled'));
      expect(calls).not.toContain('markFailed');
      expect(order.economicTransactionId).toBe(TRANSACTION);
    });

    it('closes as cancelled, with nothing to refund, when the buyer cancelled and the hold was refused', async () => {
      const order = new FakeOrder();
      const { calls, activities } = recordingActivities(order, {
        createObligation: async () => {
          order.cancel('found a cheaper supplier');
          throw ApplicationFailure.nonRetryable('Insufficient balance', 'INSUFFICIENT_BALANCE');
        },
      });

      const result = await run(order, activities, async () => undefined);

      expect(result).toBe('CANCELLED');
      expect(order.status).toBe('CANCELLED');
      expect(calls).not.toContain('compensate');
      expect(order.history).not.toContain('FAILED');
    });
  });

  // -------------------------------------------------------------------------
  // Finding 2 — a dispute that committed after the saga last looked
  // -------------------------------------------------------------------------

  it('keeps a dispute raised between confirming receipt and settling', async () => {
    // markSettling used to be refused (DISPUTED -> SETTLING is illegal), the
    // refusal counted as a failed attempt, and markSettlementFailed then walked
    // DISPUTED -> RECEIPT_CONFIRMED: the dispute erased with nobody deciding.
    const order = new FakeOrder();
    let disputedBeforeSettling = false;
    const { calls, activities } = recordingActivities(order, {
      markSettling: async () => {
        calls.push('markSettling');
        if (!disputedBeforeSettling) {
          disputedBeforeSettling = true;
          order.raiseDispute('the parts arrived damaged');
        }
        return order.step('SETTLING', ['RECEIPT_CONFIRMED'], ['DISPUTED']);
      },
    });

    await run(
      order,
      activities,
      async ({ party, handle, held }) => {
        await held();
        await party.confirm();
        await party.fulfil();
        await party.confirmReceipt();
        // No simulated time is needed. The defect acted before the dispute
        // was mirrored — markSettling refused, then markSettlementFailed
        // walked the order out of DISPUTED — so once disputeObligation has
        // run, whatever the saga was going to do about the refusal it has
        // done. Waiting days on top of that only exercised the test server.
        await until(() => calls.includes('disputeObligation'), 'the dispute to be mirrored');
        await eventually(
          async () => (await handle.query<SagaStatus, []>('status')).phase === 'DISPUTED',
          'the saga to wait on the dispute',
        );
      },
      { keepRunning: true },
    );

    expect(order.status).toBe('DISPUTED');
    expect(calls).not.toContain('markSettlementFailed');
    expect(calls).not.toContain('settle');
    // The only exit from DISPUTED is an operator's, and none was taken.
    expect(order.history.slice(order.history.indexOf('DISPUTED'))).toEqual(['DISPUTED']);
  });

  // -------------------------------------------------------------------------
  // Finding 3 — settlement and its local record shared one catch
  // -------------------------------------------------------------------------

  it('records a settlement that succeeded even when recording it failed at first', async () => {
    // settle() succeeded and markCompleted() failed: the shared catch recorded
    // a failed settlement and reported "funds remain held". Now the record is
    // retried until it lands, and the money is never touched again.
    const order = new FakeOrder();
    let completionAttempts = 0;
    const { calls, activities } = recordingActivities(order, {
      markCompleted: async () => {
        calls.push('markCompleted');
        completionAttempts += 1;
        if (completionAttempts === 1) throw new Error('connection reset by the database');
        return order.step('COMPLETED', ['SETTLING']);
      },
    });

    const result = await run(order, activities, async ({ party, held }) => {
      await held();
      await party.confirm();
      await party.fulfil();
      await party.confirmReceipt();
    });

    expect(result).toBe('COMPLETED');
    expect(completionAttempts).toBe(2);
    expect(calls.filter((c) => c === 'settle')).toHaveLength(1);
    expect(calls).not.toContain('markSettlementFailed');
    expect(order.status).toBe('COMPLETED');
  });

  // -------------------------------------------------------------------------
  // Finding 4 and layer (c) — the order decides, not the signal
  // -------------------------------------------------------------------------

  describe('the order row decides, not the signal', () => {
    it('recovers commands whose signals were lost, from its own re-reads', async () => {
      // Temporal was unreachable after each commit, so no signal arrived.
      // Waiting only on signals, the saga would have waited for ever.
      const order = new FakeOrder();
      const { effects, activities } = recordingActivities(order);

      const result = await run(order, activities, async ({ party, held }) => {
        await held();
        party.silently((o) => o.confirm());
        party.silently((o) => o.fulfil());
        party.silently((o) => o.confirmReceipt());
      });

      expect(result).toBe('COMPLETED');
      expect(effects()).toEqual([
        'createObligation',
        'markFundsHeld',
        'authoriseSettlement',
        'markSettling',
        'settle',
        'markCompleted',
      ]);
    });

    it('does nothing on a signal the order does not bear out', async () => {
      // A stray `receiptConfirmed` — a replay aimed at the wrong order once
      // delivered exactly this — must not start settlement, and a stray
      // `orderCancelled` must not refund anything.
      const order = new FakeOrder();
      let readsDone = 0;
      const { calls, activities } = recordingActivities(order, {
        // Counted on completion, not on call: what matters is that the saga
        // has the fresh read in hand, and a query sent after this is answered
        // only once the workflow has processed it.
        readOrder: async () => {
          calls.push('readOrder');
          const view = order.view();
          readsDone += 1;
          return view;
        },
      });

      await run(
        order,
        activities,
        async ({ handle, held }) => {
          await held();
          await eventually(
            async () =>
              (await handle.query<SagaStatus, []>('status')).phase === 'AWAITING_CONFIRMATION',
            'the saga to wait for the supplier',
          );
          const readsBefore = readsDone;

          await handle.signal('receiptConfirmed');
          await handle.signal('orderCancelled', 'not what the buyer said');
          await handle.signal('disputeResolved', 'REFUND');

          // The signals woke the saga and it read the order again — that read
          // is the whole of what a signal may cause. No simulated time: the
          // question is what the saga did on waking, not what it did later.
          await until(
            () => readsDone > readsBefore,
            'the saga to re-read the order after the signals',
          );
          await eventually(
            async () =>
              (await handle.query<SagaStatus, []>('status')).phase === 'AWAITING_CONFIRMATION',
            'the saga to go back to waiting',
          );
        },
        { keepRunning: true },
      );

      expect(order.status).toBe('FUNDS_HELD');
      for (const effect of ['authoriseSettlement', 'settle', 'compensate', 'markCancelled']) {
        expect(calls).not.toContain(effect);
      }
    });

    it('passes on the reasons the order records, not the ones a signal carries', async () => {
      const order = new FakeOrder();
      const received: string[] = [];
      const { activities } = recordingActivities(order, {
        compensate: async (_orderId: string, _transactionId: string, reason: string) => {
          received.push(reason);
        },
      });

      const result = await run(order, activities, async ({ handle, held }) => {
        await held();
        order.cancel('the recorded reason');
        await handle.signal('orderCancelled', 'a reason nobody recorded');
      });

      expect(result).toBe('CANCELLED');
      expect(received).toEqual(['the recorded reason']);
    });
  });
});
