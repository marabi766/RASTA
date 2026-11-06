import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import { ERROR_STATUS } from '@rasta/contracts';
import { RastaError } from '@rasta/nest-common';
import { ApplicationFailure } from '@temporalio/activity';
import {
  ActivityFailure,
  CancelledFailure,
  TimeoutFailure,
  WorkflowFailedError,
  type WorkflowHandle,
} from '@temporalio/client';
import {
  orderSaga,
  outcomeUnknown,
  PROVEN_REFUSALS,
  releaseBackoffMs,
  retryDisputeRelease,
  type OrderSagaInput,
  type SagaStatus,
} from './workflows';
import { createActivities, type OrderActivities, type SagaOrderView } from './activities';
import { OWNER_STATE_IS_FINAL, REFUSED_ON_FIRST_ATTEMPT } from './economic-refusal';
import type { EconomicClient } from '../economic/economic.client';
import type { OrderService } from '../order/order.service';

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

/**
 * For a test that sleeps through simulated days to watch a window or a
 * dispute: a recheck interval longer than the sleep, so the only timers that
 * fire are the ones the test is about. At the default 24 hours, every
 * simulated day also ran a re-read activity, and a sleep of weeks became
 * dozens of round trips on a slow CI runner — enough to hit jest's timeout.
 */
const NO_RECHECK = { recheckIntervalHours: 24 * 365 };

class FakeOrder {
  status: Status = 'PENDING';
  economicTransactionId: string | null = null;
  cancellationReason: string | null = null;
  dispute: { id: string; reason: string; resolution: string | null; raisedFrom: Status } | null =
    null;
  /** Every dispute the order has had, oldest first, with where it found the order. */
  private readonly disputes: {
    id: string;
    reason: string;
    resolution: string | null;
    raisedFrom: Status;
  }[] = [];
  /** Every status the order passed through, for asserting on history. */
  readonly history: Status[] = ['PENDING'];

  view(mirroredDisputeId?: string): SagaOrderView {
    const mirrored = this.disputes.find((d) => d.id === mirroredDisputeId);
    return {
      status: this.status,
      economicTransactionId: this.economicTransactionId,
      cancellationReason: this.cancellationReason,
      // The OPEN dispute, as `sagaView` reads it (#625 r1 R2): none once decided.
      dispute:
        this.dispute && this.status === 'DISPUTED'
          ? {
              id: this.dispute.id,
              reason: this.dispute.reason,
              resolution: this.dispute.resolution,
            }
          : null,
      ...(mirroredDisputeId === undefined
        ? {}
        : {
            mirroredDispute: mirrored ? { id: mirrored.id, resolution: mirrored.resolution } : null,
          }),
    };
  }

  /** Files a dispute, recording where it found the order (`trg_order_dispute_origin`). */
  private file(reason: string, raisedFrom: Status): string {
    const filed = { id: `DSP_${this.disputes.length + 1}`, reason, resolution: null, raisedFrom };
    this.dispute = filed;
    this.disputes.push(filed);
    return filed.id;
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
    const raisedFrom = this.status;
    this.move(
      ['FUNDS_HELD', 'CONFIRMED', 'AWAITING_RECEIPT_CONFIRMATION', 'RECEIPT_CONFIRMED'],
      'DISPUTED',
    );
    this.file(reason, raisedFrom);
  }
  /**
   * `markObligationDisputed`: the saga files economic-service's dispute, and
   * names it, beside economic-service's identity of it — nulls when it filed
   * none.
   */
  fileObligationDispute(
    reason: string,
    economicDisputeId: string | null = null,
  ): { status: Status; disputeId: string | null; economicDisputeId: string | null } {
    const before = this.status;
    const status = this.step('DISPUTED', ['RECEIPT_CONFIRMED'], ['CANCELLING']);
    const filed = before !== 'DISPUTED' && status === 'DISPUTED';
    return filed
      ? { status, disputeId: this.file(reason, before), economicDisputeId }
      : { status, disputeId: null, economicDisputeId: null };
  }
  /**
   * `OrderService.resolveDispute` (D-083): SETTLE resumes the order where its
   * dispute found it — RECEIPT_CONFIRMED only for one raised from there.
   */
  resolveDispute(outcome: 'SETTLE' | 'REFUND', resolution: string): void {
    const open = this.dispute;
    if (!open) throw new Error('no dispute to resolve');
    this.move(['DISPUTED'], outcome === 'SETTLE' ? open.raisedFrom : 'CANCELLING');
    open.resolution = resolution;
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
  const rounds: number[] = [];
  const failures: string[] = [];
  const recorded =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R | Promise<R>) =>
    async (...args: A): Promise<R> => {
      calls.push(name);
      return fn(...args);
    };

  const activities: OrderActivities = {
    readOrder: recorded('readOrder', (_id: string, mirroredDisputeId?: string) =>
      order.view(mirroredDisputeId),
    ),
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
    markObligationDisputed: recorded(
      'markObligationDisputed',
      (_id: string, reason: string, economicDisputeId?: string | null) =>
        order.fileObligationDispute(reason, economicDisputeId ?? null),
    ),
    markCompleted: recorded('markCompleted', () => order.step('COMPLETED', ['SETTLING'])),
    compensate: recorded('compensate', () => undefined),
    markCancelled: recorded('markCancelled', () => order.step('CANCELLED', ['CANCELLING'])),
    disputeObligation: recorded('disputeObligation', () => undefined),
    resolveObligationDispute: recorded('resolveObligationDispute', () => undefined),
    recordReminder: recorded('recordReminder', () => undefined),
    noteReleaseUnconfirmed: recorded(
      'noteReleaseUnconfirmed',
      (_id: string, round: number, failure: string) => {
        rounds.push(round);
        failures.push(failure);
      },
    ),
    noteEconomicCallUnconfirmed: recorded(
      'noteEconomicCallUnconfirmed',
      (_id: string, _operation: string, round: number, failure: string) => {
        rounds.push(round);
        failures.push(failure);
      },
    ),
    ...overrides,
  } as OrderActivities;

  /** The calls that act on the world. Reads are how the saga looks, not what it does. */
  const effects = (): string[] => calls.filter((c) => c !== 'readOrder');

  return { calls, rounds, failures, effects, activities };
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

/** The send's own refusal on its first attempt, as the activity marks it: nothing moved. */
const provenRefusal = (): Error =>
  ApplicationFailure.create({
    message: 'Insufficient balance',
    type: 'INSUFFICIENT_BALANCE',
    nonRetryable: true,
    details: [REFUSED_ON_FIRST_ATTEMPT],
  });

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

/**
 * The saga has nothing in flight: the last thing it did was arm a timer, or
 * finish a task with no command. Time is skipped and a signal landed only from
 * here (the test server refuses a task cancelling a timer that fired while it
 * ran, and a terminated activity stalls its clock).
 */
async function atRest(handle: WorkflowHandle): Promise<void> {
  await eventually(async () => {
    const last = (await handle.fetchHistory()).events?.at(-1);
    return Boolean(
      last?.timerStartedEventAttributes ??
      last?.timerCanceledEventAttributes ??
      last?.workflowTaskCompletedEventAttributes,
    );
  }, 'the saga to come to rest');
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

  /**
   * A time-skipping server. CI points TEMPORAL_TEST_SERVER_DIR at a cached
   * directory. The time-skipping server is a ~300 MB download, and fetching it
   * on every run was what made this hook exceed its timeout on a slow network:
   * the whole file failed before a single saga ran. Locally it falls back to
   * the system temp dir.
   */
  const timeSkippingServer = (): Promise<TestWorkflowEnvironment> => {
    const downloadDir = process.env.TEMPORAL_TEST_SERVER_DIR;
    return TestWorkflowEnvironment.createTimeSkipping(
      downloadDir
        ? { server: { executable: { type: 'cached-download', downloadDir, ttl: '30 days' } } }
        : undefined,
    );
  };

  beforeAll(async () => {
    env = await timeSkippingServer();
  }, 300_000);

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
    options: { keepRunning?: boolean; input?: Partial<OrderSagaInput> } = {},
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
        args: [{ ...INPUT, ...options.input }],
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
      { keepRunning: true, input: NO_RECHECK },
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
      { keepRunning: true, input: NO_RECHECK },
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

    const result = await run(
      order,
      activities,
      async ({ party, held }) => {
        await held();
        await party.confirm();
        await party.fulfil();
        await party.dispute('the delivered goods do not match the offer');
        await until(() => calls.includes('disputeObligation'), 'the dispute to be mirrored');
        // Nothing else happens until an operator decides.
        await env.sleep('30 days');
        expect(calls).not.toContain('settle');
        await party.resolve('SETTLE', 'the supplier evidenced correct delivery');
        // Raised before receipt: SETTLE resumes the wait for it (D-083), and
        // nothing is authorised until the buyer confirms.
        await until(
          () => calls.includes('resolveObligationDispute'),
          'the decision to be mirrored',
        );
        expect(order.status).toBe('AWAITING_RECEIPT_CONFIRMATION');
        expect(calls).not.toContain('authoriseSettlement');
        await party.confirmReceipt();
      },
      { input: NO_RECHECK },
    );

    expect(result).toBe('COMPLETED');
    // economic-service is told before anything waits, so a direct settlement
    // command there is refused too (ADR-040 § 5).
    expect(calls.indexOf('disputeObligation')).toBeLessThan(calls.indexOf('settle'));
    // And the resolution is mirrored back, or economic-service would still
    // refuse to settle a transaction it believes is disputed.
    expect(calls.indexOf('resolveObligationDispute')).toBeLessThan(calls.indexOf('settle'));
  });

  describe('an obligation disputed in economic-service after the saga authorised it (D-053; Codex on #287 round 4, finding 2)', () => {
    const OBJECTION = 'the payer counted two pallets short on arrival';

    /**
     * economic-service's side: DISPUTED by someone there until the saga
     * mirrors a resolution, and refusing authorisation and settlement while
     * it is. Every dispute it holds has an identity of its own (`current`),
     * and a resolution that names one is refused once it holds another, as
     * its row-locked check does. `resolved` is every resolution applied, as
     * dispute id and words; `named` is the identity each resolution sent.
     */
    function disputedThere(order: FakeOrder) {
      const economic = {
        disputed: true,
        reason: OBJECTION,
        current: 'TXD_1',
        opened: 1,
        resolved: [] as [string, string][],
        named: [] as (string | undefined)[],
      };
      /** A dispute raised there: a new identity, with its own words. */
      const open = (reason: string): string => {
        economic.opened += 1;
        economic.current = `TXD_${economic.opened}`;
        economic.reason = reason;
        economic.disputed = true;
        return economic.current;
      };
      const recording = recordingActivities(order);
      const { activities, calls } = recording;
      const disputedAnswer = () => ({
        disputed: true as const,
        reason: economic.reason,
        economicDisputeId: economic.current,
      });
      activities.authoriseSettlement = async () => {
        calls.push('authoriseSettlement');
        return economic.disputed ? disputedAnswer() : undefined;
      };
      activities.settle = async () => {
        calls.push('settle');
        if (economic.disputed) return disputedAnswer();
        return { settlementId: 'STL_1', commissionAmountMinor: '12500', netAmountMinor: '487500' };
      };
      activities.resolveObligationDispute = async (
        _o: string,
        _t: string,
        disputeId: string,
        resolution: string,
        economicDisputeId?: string,
      ) => {
        calls.push('resolveObligationDispute');
        economic.named.push(economicDisputeId);
        if (economicDisputeId !== undefined && economicDisputeId !== economic.current) {
          throw ApplicationFailure.retryable(
            'The transaction no longer holds the dispute this decision is about',
            'INVALID_STATE_TRANSITION',
          );
        }
        economic.resolved.push([disputeId, resolution]);
        economic.disputed = false;
      };
      activities.disputeObligation = async (_o: string, _t: string, _d: string, reason: string) => {
        calls.push('disputeObligation');
        return open(reason);
      };
      return { ...recording, economic, open };
    }

    /** What the saga runs once it filed economic-service's dispute, before it reads the order. */
    function afterFiling(activities: OrderActivities, then: () => void): void {
      const file = activities.markObligationDisputed;
      activities.markObligationDisputed = async (...args) => {
        const taken = await file(...args);
        then();
        return taken;
      };
    }

    it('authorisation answers the dispute: the order takes it, waits, and settles on SETTLE', async () => {
      // The activity's answer when its retry, past the TTL, finds its own
      // authorisation DISPUTED. It used to fail its three attempts, and the
      // workflow ended before any dispute handling with the funds held.
      const order = new FakeOrder();
      const { calls, effects, activities, economic } = disputedThere(order);

      const result = await run(
        order,
        activities,
        async ({ party, handle, held }) => {
          await held();
          await party.confirm();
          await party.fulfil();
          await party.confirmReceipt();
          await eventually(
            async () => (await handle.query<SagaStatus, []>('status')).phase === 'DISPUTED',
            'the saga to wait on the dispute',
          );
          expect(order.status).toBe('DISPUTED');
          expect(order.dispute).toMatchObject({ id: 'DSP_1', reason: OBJECTION });
          // Nothing settles while it waits for an operator.
          await env.sleep('30 days');
          expect(calls).not.toContain('settle');
          await party.resolve('SETTLE', 'the supplier showed a signed delivery note');
        },
        { input: NO_RECHECK },
      );

      expect(result).toBe('COMPLETED');
      // Not mirrored as a dispute: economic-service is where it came from.
      expect(effects()).toEqual([
        'createObligation',
        'markFundsHeld',
        'authoriseSettlement',
        'markObligationDisputed',
        'resolveObligationDispute',
        'authoriseSettlement',
        'markSettling',
        'settle',
        'markCompleted',
      ]);
      expect(economic.resolved).toEqual([['DSP_1', 'the supplier showed a signed delivery note']]);
      // Named: that dispute, as economic-service identified it.
      expect(economic.named).toEqual(['TXD_1']);
    });

    it('settlement answers the dispute: that attempt ends, the order takes it, REFUND refunds', async () => {
      const order = new FakeOrder();
      const { calls, effects, activities, economic } = disputedThere(order);
      // Authorised; disputed there only afterwards.
      economic.disputed = false;
      activities.markSettling = async () => {
        calls.push('markSettling');
        economic.disputed = true;
        return order.step('SETTLING', ['RECEIPT_CONFIRMED'], ['DISPUTED']);
      };

      const result = await run(
        order,
        activities,
        async ({ party, handle, held }) => {
          await held();
          await party.confirm();
          await party.fulfil();
          await party.confirmReceipt();
          await eventually(
            async () => (await handle.query<SagaStatus, []>('status')).phase === 'DISPUTED',
            'the saga to wait on the dispute',
          );
          await party.resolve('REFUND', 'the supplier could not show a delivery');
        },
        { input: NO_RECHECK },
      );

      expect(result).toBe('CANCELLED');
      expect(effects()).toEqual([
        'createObligation',
        'markFundsHeld',
        'authoriseSettlement',
        'markSettling',
        'settle',
        'markSettlementFailed',
        'markObligationDisputed',
        'resolveObligationDispute',
        'compensate',
        'markCancelled',
      ]);
      // One settlement call: the dispute was not retried as a failed attempt.
      expect(calls.filter((c) => c === 'settle')).toHaveLength(1);
      expect(economic.resolved).toEqual([['DSP_1', 'the supplier could not show a delivery']]);
      expect(economic.named).toEqual(['TXD_1']);
    });

    describe('an operator decides it before the saga reads the order again (Codex on #318 round 1, finding 1)', () => {
      it('SETTLE: the decision is mirrored, and no second dispute is filed', async () => {
        // The saga never saw the order DISPUTED. It used to read
        // RECEIPT_CONFIRMED with nothing mirrored, find economic-service still
        // DISPUTED, and file a second dispute over the same objection: the
        // funds stayed held for a decision already taken.
        const order = new FakeOrder();
        const { calls, effects, activities, economic } = disputedThere(order);
        afterFiling(activities, () =>
          order.resolveDispute('SETTLE', 'the supplier showed a signed delivery note'),
        );

        const result = await run(order, activities, async ({ party, held }) => {
          await held();
          await party.confirm();
          await party.fulfil();
          await party.confirmReceipt();
          await until(
            () =>
              calls.includes('markCompleted') ||
              calls.filter((c) => c === 'markObligationDisputed').length > 1,
            'the saga to settle, or to file the dispute again',
          );
          expect(calls.filter((c) => c === 'markObligationDisputed')).toHaveLength(1);
        });

        expect(result).toBe('COMPLETED');
        expect(effects()).toEqual([
          'createObligation',
          'markFundsHeld',
          'authoriseSettlement',
          'markObligationDisputed',
          'resolveObligationDispute',
          'authoriseSettlement',
          'markSettling',
          'settle',
          'markCompleted',
        ]);
        // That dispute, with that decision's words.
        expect(economic.resolved).toEqual([
          ['DSP_1', 'the supplier showed a signed delivery note'],
        ]);
        expect(economic.named).toEqual(['TXD_1']);
        expect(order.history.filter((s) => s === 'DISPUTED')).toHaveLength(1);
      });

      it('REFUND: the decision is mirrored, then the funds are refunded', async () => {
        const order = new FakeOrder();
        const { effects, activities, economic } = disputedThere(order);
        afterFiling(activities, () =>
          order.resolveDispute('REFUND', 'the supplier could not show a delivery'),
        );

        const result = await run(order, activities, async ({ party, held }) => {
          await held();
          await party.confirm();
          await party.fulfil();
          await party.confirmReceipt();
        });

        expect(result).toBe('CANCELLED');
        expect(effects()).toEqual([
          'createObligation',
          'markFundsHeld',
          'authoriseSettlement',
          'markObligationDisputed',
          'resolveObligationDispute',
          'compensate',
          'markCancelled',
        ]);
        expect(economic.resolved).toEqual([['DSP_1', 'the supplier could not show a delivery']]);
        expect(economic.named).toEqual(['TXD_1']);
      });

      it('decided, then disputed again by a party: the decision is mirrored before the next dispute', async () => {
        // economic-service still holds the first dispute when the saga reads
        // the second. Mirrored straight away, the second was refused as
        // "already disputed" with different words, and the saga failed.
        const order = new FakeOrder();
        const mirrored: string[] = [];
        const { calls, effects, activities, economic, open } = disputedThere(order);
        activities.disputeObligation = async (
          _o: string,
          _t: string,
          disputeId: string,
          reason: string,
        ) => {
          calls.push('disputeObligation');
          // economic-service refuses a second dispute while it holds one.
          expect(economic.disputed).toBe(false);
          mirrored.push(disputeId);
          return open(reason);
        };
        afterFiling(activities, () => {
          order.resolveDispute('SETTLE', 'the supplier showed a signed delivery note');
          order.raiseDispute('the delivery note is for another order');
        });

        const result = await run(order, activities, async ({ party, held }) => {
          await held();
          await party.confirm();
          await party.fulfil();
          await party.confirmReceipt();
          await until(() => mirrored.length === 1, 'the second dispute to be mirrored');
          await party.resolve('SETTLE', 'the note names this order after all');
        });

        expect(result).toBe('COMPLETED');
        expect(mirrored).toEqual(['DSP_2']);
        expect(economic.resolved).toEqual([
          ['DSP_1', 'the supplier showed a signed delivery note'],
          ['DSP_2', 'the note names this order after all'],
        ]);
        // Each decision names its own dispute: the imported one, then the one
        // the saga filed, as economic-service identified each.
        expect(economic.named).toEqual(['TXD_1', 'TXD_2']);
        expect(effects()).toEqual([
          'createObligation',
          'markFundsHeld',
          'authoriseSettlement',
          'markObligationDisputed',
          'resolveObligationDispute',
          'disputeObligation',
          'resolveObligationDispute',
          'authoriseSettlement',
          'markSettling',
          'settle',
          'markCompleted',
        ]);
      });
    });

    it('resolved there and replaced before the order took it: the decision about the stale dispute settles nothing (Codex on #318 round 2, N1)', async () => {
      // Authorisation read dispute A. Before the step that files it ran, A was
      // resolved in economic-service and B raised there, on other grounds.
      // The order took A's words, its operator decided A — and the
      // resolution, naming nothing, cleared B: settlement went ahead on a
      // decision nobody took about B. Named, economic-service refuses it, and
      // the saga waits with the funds held and the alert on (FU-080).
      const order = new FakeOrder();
      const { calls, activities, economic, open } = disputedThere(order);
      const file = activities.markObligationDisputed;
      activities.markObligationDisputed = async (...args) => {
        open('the invoice names another supplier');
        return file(...args);
      };
      afterFiling(activities, () =>
        order.resolveDispute('SETTLE', 'the supplier showed a signed delivery note'),
      );

      await run(
        order,
        activities,
        async ({ party, held, handle }) => {
          await held();
          await party.confirm();
          await party.fulfil();
          await party.confirmReceipt();
          await eventually(
            async () =>
              (await handle.query<SagaStatus, []>('status')).phase === 'RELEASE_UNCONFIRMED',
            'the refusal to hold the saga',
          );
          await until(() => calls.includes('noteReleaseUnconfirmed'), 'the refusal reported');
          await atRest(handle);
        },
        { keepRunning: true },
      );

      // The order took A, by A's identity; every attempt named it.
      expect(order.dispute).toMatchObject({ id: 'DSP_1', reason: OBJECTION });
      expect(new Set(economic.named)).toEqual(new Set(['TXD_1']));
      // B stands, and nothing moved.
      expect(economic).toMatchObject({
        disputed: true,
        current: 'TXD_2',
        reason: 'the invoice names another supplier',
        resolved: [],
      });
      expect(calls).not.toContain('markSettling');
      expect(calls).not.toContain('settle');
      expect(calls).not.toContain('compensate');
      expect(calls.filter((c) => c === 'authoriseSettlement')).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // FU-080 — the saga does not end with a release unconfirmed
  // -------------------------------------------------------------------------

  describe('a release economic-service has not confirmed (FU-080)', () => {
    // A server of its own, as for D-083: these cases skip time too.
    let shared: TestWorkflowEnvironment;
    beforeAll(async () => {
      shared = env;
      env = await timeSkippingServer();
    }, 300_000);
    afterAll(async () => {
      await env?.teardown();
      env = shared;
    });

    /** Every release fails, as `failure` says, until `economic.recovered`. */
    function unconfirmed(
      order: FakeOrder,
      failure = (): Error =>
        ApplicationFailure.retryable('economic-service is down', 'UPSTREAM_UNAVAILABLE'),
    ) {
      const economic = { recovered: false, sent: [] as unknown[][] };
      const recording = recordingActivities(order);
      recording.activities.resolveObligationDispute = async (...args: unknown[]) => {
        recording.calls.push('resolveObligationDispute');
        economic.sent.push(args);
        if (!economic.recovered) throw failure();
      };
      /** The calls that are neither the release nor its report. */
      const others = () =>
        recording
          .effects()
          .filter((c) => c !== 'resolveObligationDispute' && c !== 'noteReleaseUnconfirmed');
      return { ...recording, economic, others };
    }
    const refused = (): Error =>
      ApplicationFailure.nonRetryable('no longer that dispute', 'BUSINESS_RULE_VIOLATION');
    const HELD_PATH = ['createObligation', 'markFundsHeld', 'disputeObligation'];
    const SETTLED = ['authoriseSettlement', 'markSettling', 'settle', 'markCompleted'];

    /** The saga is in its release wait, at rest on the backoff timer. */
    const inReleaseWait = async (handle: WorkflowHandle, rounds: () => number): Promise<void> => {
      await eventually(
        async () => (await handle.query<SagaStatus, []>('status')).phase === 'RELEASE_UNCONFIRMED',
        'the release wait',
      );
      await until(() => rounds() > 0, 'the round to be reported');
      await atRest(handle);
    };
    const patchIds = async (handle: WorkflowHandle): Promise<string[]> =>
      ((await handle.fetchHistory()).events ?? [])
        .flatMap((e) => e.markerRecordedEventAttributes?.details?.['patch-data']?.payloads ?? [])
        .map(
          (p) => (JSON.parse(Buffer.from(p.data as Uint8Array).toString()) as { id: string }).id,
        );

    it('exhausted attempts: it stays, settles nothing past the receipt, and goes on once confirmed', async () => {
      const order = new FakeOrder();
      const { calls, rounds, activities, economic, others } = unconfirmed(order);
      let replay: WorkflowHandle | undefined;

      const result = await run(
        order,
        activities,
        async ({ party, held, handle }) => {
          replay = handle;
          await held();
          await party.dispute('the parts do not match the offer');
          await until(() => calls.includes('disputeObligation'), 'the dispute to be mirrored');
          await party.resolve('SETTLE', 'the supplier showed the parts match the offer');
          await inReleaseWait(handle, () => rounds.length);
          // The activity's own three attempts, then the round is reported.
          expect(economic.sent).toHaveLength(3);
          expect(rounds).toEqual([1]);

          // The order goes on, up to the buyer's receipt: the saga moves nothing.
          await party.confirm();
          await party.fulfil();
          await party.confirmReceipt();
          await atRest(handle);
          await env.sleep('3 hours');
          expect(rounds.length).toBeGreaterThanOrEqual(4);
          expect(rounds).toEqual(rounds.map((_, i) => i + 1));
          expect(others()).toEqual(HELD_PATH);
          expect(order.status).toBe('RECEIPT_CONFIRMED');
          economic.recovered = true;
        },
        { input: NO_RECHECK },
      );

      expect(result).toBe('COMPLETED');
      expect(others()).toEqual([...HELD_PATH, ...SETTLED]);
      expect(calls.lastIndexOf('resolveObligationDispute')).toBeLessThan(
        calls.indexOf('authoriseSettlement'),
      );
      // Same dispute, same words, so the same idempotency key on every call.
      expect(new Set(economic.sent.map((args) => JSON.stringify(args))).size).toBe(1);
      expect(economic.sent[0]?.[2]).toBe('DSP_1');
      // Its marker is in the history, and the history replays.
      const handle = replay as WorkflowHandle;
      expect(await patchIds(handle)).toContain('dispute-release-durable-wait-v1');
      await Worker.runReplayHistory(
        { workflowsPath: require.resolve('./workflows') },
        await handle.fetchHistory(),
        handle.workflowId,
      );
    });

    it('a refusal waits too, and the operator signal tries again at once; the saga carries on where it was', async () => {
      const order = new FakeOrder();
      const { calls, rounds, failures, activities, economic, others } = unconfirmed(order, refused);

      const result = await run(
        order,
        activities,
        async ({ party, held, handle }) => {
          await held();
          await party.dispute('the supplier has not answered');
          await until(() => calls.includes('disputeObligation'), 'the dispute to be mirrored');
          await party.resolve('SETTLE', 'the supplier has answered since');
          await inReleaseWait(handle, () => rounds.length);
          expect(economic.sent).toHaveLength(1);

          // No time is skipped here, and the backoff is a minute.
          await handle.signal(retryDisputeRelease);
          await until(() => economic.sent.length === 2, 'the signal to try again');
          await until(() => rounds.length === 2, 'the second round to be reported');
          await atRest(handle);

          economic.recovered = true;
          await handle.signal(retryDisputeRelease);
          await eventually(
            async () =>
              (await handle.query<SagaStatus, []>('status')).phase === 'AWAITING_CONFIRMATION',
            'the saga to wait where the order is',
          );
          expect(economic.sent).toHaveLength(3);
          expect(others()).toEqual(HELD_PATH);
          await atRest(handle);
          await party.cancel('the buyer changed their mind');
        },
        { input: NO_RECHECK },
      );

      expect(result).toBe('CANCELLED');
      expect(calls.filter((c) => c === 'resolveObligationDispute')).toHaveLength(3);
      // What tells an operator a refusal from an outage, every round.
      expect(failures).toEqual(rounds.map(() => 'BUSINESS_RULE_VIOLATION: no longer that dispute'));
    });

    it('a signal during a call wakes the next wait: it may be about a fix the call did not see', async () => {
      const order = new FakeOrder();
      let refusals = 0;
      const { calls, rounds, failures, activities, economic } = unconfirmed(order, () => {
        refusals += 1;
        return ApplicationFailure.nonRetryable(`refusal ${refusals}`, 'BUSINESS_RULE_VIOLATION');
      });
      const release = activities.resolveObligationDispute;
      let finish: (() => void) | undefined;
      activities.resolveObligationDispute = async (...args) => {
        // Only the call the first signal asks for is held.
        if (rounds.length === 1 && !finish) {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        }
        return release(...args);
      };

      const result = await run(
        order,
        activities,
        async ({ party, held, handle }) => {
          await held();
          await party.dispute('the supplier has not answered');
          await until(() => calls.includes('disputeObligation'), 'the dispute to be mirrored');
          await party.resolve('SETTLE', 'the supplier has answered since');
          await inReleaseWait(handle, () => rounds.length);

          await handle.signal(retryDisputeRelease);
          await until(() => finish !== undefined, 'the call to be in flight');
          await handle.signal(retryDisputeRelease);
          await atRest(handle);
          (finish as () => void)();

          // No time is skipped, and the backoff is now two minutes: only the
          // second signal can bring this call.
          await until(() => economic.sent.length === 3, 'the kept signal to try again');
          await until(() => rounds.length === 3, 'that round to be reported');
          await atRest(handle);
          economic.recovered = true;
          await handle.signal(retryDisputeRelease);
          await eventually(
            async () =>
              (await handle.query<SagaStatus, []>('status')).phase === 'AWAITING_CONFIRMATION',
            'the saga to wait where the order is',
          );
          await atRest(handle);
          await party.cancel('the buyer changed their mind');
        },
        { input: NO_RECHECK },
      );

      expect(result).toBe('CANCELLED');
      // Each round reports its own failure, not the first one's.
      expect(failures).toEqual([1, 2, 3].map((n) => `BUSINESS_RULE_VIOLATION: refusal ${n}`));
    });

    it('at RECEIPT_CONFIRMED: it reads the order again, and a dispute raised during the wait stops the settlement', async () => {
      const order = new FakeOrder();
      const { calls, rounds, activities, economic, others } = unconfirmed(order, refused);
      const settling = activities.markSettling;
      let raised = false;
      activities.markSettling = async (...args) => {
        if (!raised) {
          raised = true;
          order.raiseDispute('one of the parts was damaged in the box');
        }
        return settling(...args);
      };

      const result = await run(
        order,
        activities,
        async ({ party, held, handle }) => {
          await held();
          await party.confirm();
          await party.fulfil();
          await party.confirmReceipt();
          await until(() => calls.includes('disputeObligation'), 'the dispute to be mirrored');
          await party.resolve('SETTLE', 'the damage happened after delivery');
          await inReleaseWait(handle, () => rounds.length);
          expect(order.status).toBe('RECEIPT_CONFIRMED');
          const before = others().length;

          await party.dispute('the replacement is damaged too');
          economic.recovered = true;
          await handle.signal(retryDisputeRelease);
          await until(() => others().length > before, 'the saga to go on');
          // The second dispute reaches economic-service, not an authorisation.
          expect(others().at(-1)).toBe('disputeObligation');
          expect(others().filter((c) => c === 'authoriseSettlement')).toHaveLength(1);
          await atRest(handle);
          await party.resolve('SETTLE', 'the replacement is fine');
        },
        { input: NO_RECHECK },
      );

      expect(result).toBe('COMPLETED');
      expect(calls.filter((c) => c === 'settle')).toHaveLength(1);
    });

    it('at CANCELLING: nothing is refunded before the release is confirmed', async () => {
      const order = new FakeOrder();
      const { calls, rounds, activities, economic, others } = unconfirmed(order, refused);

      const result = await run(order, activities, async ({ party, held, handle }) => {
        await held();
        await party.dispute('the goods never arrived');
        await until(() => calls.includes('disputeObligation'), 'the dispute to be mirrored');
        await party.resolve('REFUND', 'the goods were never delivered');
        await inReleaseWait(handle, () => rounds.length);
        expect(others()).toEqual(HELD_PATH);
        economic.recovered = true;
      });

      expect(result).toBe('CANCELLED');
      expect(others()).toEqual([...HELD_PATH, 'compensate', 'markCancelled']);
      expect(economic.sent[0]?.[3]).toBe('the goods were never delivered');
    });

    it('at DISPUTED: the next dispute is filed only after the last one is released', async () => {
      const order = new FakeOrder();
      const { calls, rounds, activities, economic, others } = unconfirmed(order, refused);

      const result = await run(
        order,
        activities,
        async ({ party, held, handle }) => {
          await held();
          await party.dispute('the first objection');
          await until(() => calls.includes('disputeObligation'), 'the dispute to be mirrored');
          await atRest(handle);
          party.silently((o) => {
            o.resolveDispute('SETTLE', 'the first objection failed');
            o.raiseDispute('the second objection');
          });
          await handle.signal('disputeResolved', 'SETTLE');
          await inReleaseWait(handle, () => rounds.length);
          expect(others()).toEqual(HELD_PATH);

          economic.recovered = true;
          await handle.signal(retryDisputeRelease);
          await until(
            () => others().filter((c) => c === 'disputeObligation').length === 2,
            'the second dispute to be mirrored',
          );
          await atRest(handle);
          await party.resolve('REFUND', 'the second objection stands');
        },
        { input: NO_RECHECK },
      );

      expect(result).toBe('CANCELLED');
      expect(economic.sent[0]?.[2]).toBe('DSP_1');
      expect(economic.sent.at(-1)?.[2]).toBe('DSP_2');
    });

    it('at DISPUTED: a next dispute decided during the wait is not filed from the old read', async () => {
      const order = new FakeOrder();
      const { calls, rounds, activities, economic, others } = unconfirmed(order, refused);

      const result = await run(order, activities, async ({ party, held, handle }) => {
        await held();
        await party.dispute('the first objection');
        await until(() => calls.includes('disputeObligation'), 'the dispute to be mirrored');
        await atRest(handle);
        party.silently((o) => {
          o.resolveDispute('SETTLE', 'the first objection failed');
          o.raiseDispute('the second objection');
        });
        await handle.signal('disputeResolved', 'SETTLE');
        await inReleaseWait(handle, () => rounds.length);

        await party.resolve('REFUND', 'the second objection stands');
        await atRest(handle);
        economic.recovered = true;
        await handle.signal(retryDisputeRelease);
      });

      expect(result).toBe('CANCELLED');
      expect(others()).toEqual([...HELD_PATH, 'compensate', 'markCancelled']);
    });

    it('a release confirmed first time records no marker', async () => {
      const order = new FakeOrder();
      const { calls, activities } = recordingActivities(order);
      let ids: string[] = [];

      await run(order, activities, async ({ party, held, handle }) => {
        await held();
        await party.dispute('the parts do not match');
        await until(() => calls.includes('disputeObligation'), 'the dispute to be mirrored');
        await party.resolve('SETTLE', 'they match');
        await until(() => calls.includes('resolveObligationDispute'), 'the release');
        await party.cancel('changed their mind');
        await until(() => calls.includes('markCancelled'), 'the saga to end');
        ids = await patchIds(handle);
      });

      expect(ids).toContain('dispute-settle-resumes-order');
      expect(ids).not.toContain('dispute-release-durable-wait-v1');
    });

    it('a cancelled saga does not enter the wait, and records no marker', async () => {
      const order = new FakeOrder();
      const { calls, activities } = recordingActivities(order);
      let finish = (): void => undefined;
      activities.resolveObligationDispute = () => {
        calls.push('resolveObligationDispute');
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      };
      let ids: string[] = [];

      await expect(
        run(order, activities, async ({ party, held, handle }) => {
          await held();
          await party.dispute('the parts do not match');
          await until(() => calls.includes('disputeObligation'), 'the dispute to be mirrored');
          await party.resolve('SETTLE', 'they match');
          await until(() => calls.includes('resolveObligationDispute'), 'the release in flight');
          await handle.cancel();
          await handle.result().catch(() => undefined);
          finish();
          ids = await patchIds(handle);
          expect(calls).not.toContain('noteReleaseUnconfirmed');
          await handle.result();
        }),
      ).rejects.toBeInstanceOf(WorkflowFailedError);

      expect(ids).not.toContain('dispute-release-durable-wait-v1');
    });

    it('backs off from a minute to an hour at most, however long it lasts', () => {
      expect([-5, 0, 1, 2, 3, 6, 7, 8, 1000, 100000].map(releaseBackoffMs)).toEqual(
        [1, 1, 1, 2, 4, 32, 60, 60, 60, 60].map((minutes) => minutes * 60_000),
      );
    });
  });

  describe('an authorisation whose outcome is unknown (FU-103)', () => {
    let shared: TestWorkflowEnvironment;
    beforeAll(async () => {
      shared = env;
      env = await timeSkippingServer();
    }, 300_000);
    afterAll(async () => {
      await env?.teardown();
      env = shared;
    });

    const MARKER = 'economic-call-durable-wait-v1';
    const down = (): Error =>
      ApplicationFailure.retryable('economic-service is down', 'UPSTREAM_UNAVAILABLE');
    // As the activity marks the send's own refusal, nothing before it.
    const refused = (): Error =>
      ApplicationFailure.create({
        message: 'not in this state',
        type: 'INVALID_STATE_TRANSITION',
        nonRetryable: true,
        details: [REFUSED_ON_FIRST_ATTEMPT],
      });

    function failing(order: FakeOrder, failure = down) {
      const economic = { recovered: false, failure, sent: [] as unknown[][] };
      const recording = recordingActivities(order);
      recording.activities.authoriseSettlement = async (...args: unknown[]) => {
        recording.calls.push('authoriseSettlement');
        economic.sent.push(args);
        if (!economic.recovered) throw economic.failure();
        return undefined;
      };
      return { ...recording, economic };
    }
    const patchIds = async (handle: WorkflowHandle): Promise<string[]> =>
      ((await handle.fetchHistory()).events ?? [])
        .flatMap((e) => e.markerRecordedEventAttributes?.details?.['patch-data']?.payloads ?? [])
        .map(
          (p) => (JSON.parse(Buffer.from(p.data as Uint8Array).toString()) as { id: string }).id,
        );
    const phaseIs = (handle: WorkflowHandle, phase: string): Promise<void> =>
      eventually(async () => (await handle.query<SagaStatus, []>('status')).phase === phase, phase);
    /** The receipt is confirmed and the saga at rest in the wait, a round reported. */
    const toWait = async (
      { party, held, handle }: { party: Party; held: () => Promise<void>; handle: WorkflowHandle },
      rounds: () => number,
    ): Promise<void> => {
      await held();
      await party.confirm();
      await party.fulfil();
      await party.confirmReceipt();
      await phaseIs(handle, 'AUTHORISATION_UNCONFIRMED');
      await until(() => rounds() > 0, 'the round to be reported');
      await atRest(handle);
    };

    it('exhausted: the saga stays, settles nothing, and goes on once confirmed', async () => {
      const order = new FakeOrder();
      const { calls, rounds, activities, economic } = failing(order);
      let seen: WorkflowHandle | undefined;

      const result = await run(
        order,
        activities,
        async (ctx) => {
          seen = ctx.handle;
          await toWait(ctx, () => rounds.length);
          // The activity's own three attempts, then the round is reported.
          expect(economic.sent.length).toBeGreaterThanOrEqual(3);
          await env.sleep('3 hours');
          expect(rounds.length).toBeGreaterThanOrEqual(4);
          expect(rounds).toEqual(rounds.map((_, i) => i + 1));
          expect(calls).not.toContain('markSettling');
          await atRest(ctx.handle);
          economic.recovered = true;
          await ctx.handle.signal(retryDisputeRelease);
        },
        { input: NO_RECHECK },
      );

      expect(result).toBe('COMPLETED');
      // The same words, so the same idempotency key, on every round.
      expect(new Set(economic.sent.map((args) => JSON.stringify(args.slice(0, 2)))).size).toBe(1);
      const handle = seen as WorkflowHandle;
      expect(await patchIds(handle)).toContain(MARKER);
      await Worker.runReplayHistory(
        { workflowsPath: require.resolve('./workflows') },
        await handle.fetchHistory(),
        handle.workflowId,
      );
    });

    it('proven refused: the saga ends as it always did, unreported and unmarked', async () => {
      const order = new FakeOrder();
      const { calls, activities } = failing(order, refused);
      let seen: WorkflowHandle | undefined;

      await expect(
        run(order, activities, async ({ party, held, handle }) => {
          seen = handle;
          await held();
          await party.confirm();
          await party.fulfil();
          await party.confirmReceipt();
        }),
      ).rejects.toBeInstanceOf(WorkflowFailedError);

      expect(calls).not.toContain('noteEconomicCallUnconfirmed');
      expect(calls).not.toContain('markSettling');
      expect(await patchIds(seen as WorkflowHandle)).not.toContain(MARKER);
    });

    it('a mark on a later round is not proof: only the obligation ends the wait', async () => {
      const order = new FakeOrder();
      const { calls, rounds, activities, economic } = failing(order);

      await expect(
        run(order, activities, async (ctx) => {
          await toWait(ctx, () => rounds.length);
          economic.failure = refused;
          const reported = rounds.length;
          await ctx.handle.signal(retryDisputeRelease);
          await until(() => rounds.length > reported, 'the next round');
          await atRest(ctx.handle);
          expect(calls).not.toContain('markSettling');
          economic.failure = () =>
            ApplicationFailure.create({
              message: 'refunded there',
              type: 'OBLIGATION_ALREADY_FINAL',
              nonRetryable: true,
              details: [OWNER_STATE_IS_FINAL],
            });
          await ctx.handle.signal(retryDisputeRelease);
          await ctx.handle.result().catch(() => undefined);
          // Queried while the worker is still there to answer.
          expect((await ctx.handle.query<SagaStatus, []>('status')).phase).toBe('SETTLING');
        }),
      ).rejects.toBeInstanceOf(WorkflowFailedError);

      expect(calls).not.toContain('markSettling');
    });

    it.each([
      ['a code proving only that the key was used', 'IDEMPOTENCY_KEY_REUSED', false],
      ['a request still in flight', 'CONFLICT', true],
      ['a code nobody listed', 'SOMETHING_NEW', false],
    ])('%s waits, retryable or not', async (_name, code, retryable) => {
      const order = new FakeOrder();
      const failure = (): Error =>
        retryable
          ? ApplicationFailure.retryable('answered', code as string)
          : ApplicationFailure.nonRetryable('answered', code as string);
      const { calls, rounds, activities } = failing(order, failure);
      await run(order, activities, (ctx) => toWait(ctx, () => rounds.length), {
        keepRunning: true,
      });
      expect(calls).not.toContain('markSettling');
    });

    it('a dispute raised during the wait wakes it and stops the sending; nothing follows until economic-service answers', async () => {
      const order = new FakeOrder();
      const { calls, rounds, activities, economic } = failing(order);
      activities.findObligation = async () => {
        calls.push('findObligation');
        if (!economic.recovered) throw down();
        return { transactionId: TRANSACTION };
      };

      const result = await run(
        order,
        activities,
        async (ctx) => {
          await toWait(ctx, () => rounds.length);
          await atRest(ctx.handle);
          // Its own signal is what wakes the wait, an hour before the backoff would.
          await ctx.party.dispute('it arrived broken');
          await until(() => calls.includes('findObligation'), 'economic-service to be asked');
          await atRest(ctx.handle);
          await env.sleep('2 hours');
          // By order, not by count: a slow run can fit a round in before the dispute.
          expect(calls.lastIndexOf('authoriseSettlement')).toBeLessThan(
            calls.indexOf('findObligation'),
          );
          expect(calls).not.toContain('disputeObligation');
          await atRest(ctx.handle);
          economic.recovered = true;
          await ctx.handle.signal(retryDisputeRelease);
          await phaseIs(ctx.handle, 'DISPUTED');
          await atRest(ctx.handle);
          await ctx.party.resolve('SETTLE', 'the supplier replaced it');
        },
        { input: NO_RECHECK },
      );

      expect(result).toBe('COMPLETED');
      expect(calls.filter((c) => c === 'settle')).toHaveLength(1);
    });

    it('decided REFUND during the wait: nothing is refunded until economic-service answers', async () => {
      const order = new FakeOrder();
      const { calls, rounds, activities, economic } = failing(order);
      activities.findObligation = async () => {
        calls.push('findObligation');
        if (!economic.recovered) throw down();
        return { transactionId: TRANSACTION };
      };

      const result = await run(
        order,
        activities,
        async (ctx) => {
          await toWait(ctx, () => rounds.length);
          await atRest(ctx.handle);
          ctx.party.silently((o) => o.raiseDispute('it arrived broken'));
          ctx.party.silently((o) => o.resolveDispute('REFUND', 'the supplier agreed'));
          await ctx.handle.signal(retryDisputeRelease);
          await until(() => calls.includes('findObligation'), 'economic-service to be asked');
          await atRest(ctx.handle);
          expect(calls).not.toContain('compensate');
          economic.recovered = true;
          await ctx.handle.signal(retryDisputeRelease);
        },
        { input: NO_RECHECK },
      );

      expect(result).toBe('CANCELLED');
      expect(calls.lastIndexOf('findObligation')).toBeLessThan(calls.indexOf('compensate'));
    });

    it('a failed read of the order in a round says nothing of the call: the saga stays', async () => {
      const order = new FakeOrder();
      const { calls, rounds, activities, economic } = failing(order);
      const { readOrder } = activities;
      let unreadable = false;
      activities.readOrder = (...args) => {
        if (unreadable) throw ApplicationFailure.nonRetryable('gone', 'NOT_FOUND');
        return readOrder(...args);
      };

      const result = await run(
        order,
        activities,
        async (ctx) => {
          await toWait(ctx, () => rounds.length);
          unreadable = true;
          const reported = rounds.length;
          await ctx.handle.signal(retryDisputeRelease);
          await until(() => rounds.length > reported, 'the next round');
          await atRest(ctx.handle);
          expect(calls).not.toContain('markSettling');
          unreadable = false;
          economic.recovered = true;
          await ctx.handle.signal(retryDisputeRelease);
        },
        { input: NO_RECHECK },
      );

      expect(result).toBe('COMPLETED');
    });

    it('answered first time records no marker', async () => {
      const order = new FakeOrder();
      const { activities } = recordingActivities(order);
      let seen: WorkflowHandle | undefined;
      await run(order, activities, async ({ party, held, handle }) => {
        seen = handle;
        await held();
        await party.confirm();
        await party.fulfil();
        await party.confirmReceipt();
      });
      expect(await patchIds(seen as WorkflowHandle)).not.toContain(MARKER);
    });

    it('every platform code is decided: only a closed list of 4xx proves a refusal', () => {
      // Each 4xx not on the list is here for a reason (`PROVEN_REFUSALS`). A new
      // code fails this until somebody decides which it is.
      const notProof = [
        'UNAUTHENTICATED',
        'TOKEN_EXPIRED',
        'TOKEN_INVALID',
        'CONFLICT',
        'IDEMPOTENCY_KEY_REUSED',
        'REPLAY_WINDOW_CLOSED',
        'OPTIMISTIC_LOCK_FAILED',
        'RATE_LIMIT_EXCEEDED',
      ];
      for (const [code, status] of Object.entries(ERROR_STATUS)) {
        const proof = status < 500 && !notProof.includes(code);
        expect([code, PROVEN_REFUSALS.has(code)]).toEqual([code, proof]);
      }
    });

    it('a failure with no code is unknown; a stop is not an outcome', () => {
      const failed = (cause: Error): ActivityFailure =>
        new ActivityFailure('failed', 'authorise', '1', 'TIMEOUT' as never, 'worker', cause);
      const coded = (type: string): Error => ApplicationFailure.create({ message: 'x', type });

      const marked = (type: string, mark: string): Error =>
        ApplicationFailure.create({ message: 'x', type, details: [mark] });
      const known = (cause: Error, inDoubt = false): boolean =>
        outcomeUnknown(failed(cause), inDoubt);

      expect(known(new TimeoutFailure('late', undefined, 'START_TO_CLOSE' as never))).toBe(true);
      expect(known(new Error('reset'))).toBe(true);
      expect(known(coded('UPSTREAM_TIMEOUT'))).toBe(true);
      // A listed code alone is not proof: it may be a later attempt's, or a read's.
      expect(known(coded('NOT_FOUND'))).toBe(true);
      expect(known(marked('NOT_FOUND', REFUSED_ON_FIRST_ATTEMPT))).toBe(false);
      expect(known(marked('NOT_FOUND', REFUSED_ON_FIRST_ATTEMPT), true)).toBe(true);
      expect(known(marked('CONFLICT', REFUSED_ON_FIRST_ATTEMPT))).toBe(true);
      expect(known(marked('NOT_FOUND', 'SOMETHING_ELSE'))).toBe(true);
      expect(known(marked('ANY', OWNER_STATE_IS_FINAL), true)).toBe(false);
      expect(known(new CancelledFailure('cancelled'), true)).toBe(false);
      expect(outcomeUnknown(coded('SAGA_INCONSISTENT'), true)).toBe(false);
    });

    /**
     * #770 round 1 F2: the real activity over a fake economic-service, so what
     * reaches the workflow is what a worker really sends, on real attempts.
     */
    describe('a later code does not clear an earlier attempt (real activity)', () => {
      const LISTED = [
        'FORBIDDEN',
        'NOT_FOUND',
        'VALIDATION_FAILED',
        'SERVICE_TENANT_CONTEXT_INVALID',
      ];
      const refuse = (code: string): Error => new RastaError(code as never, 'answered');
      const lost = (): Error => RastaError.upstreamUnavailable('economic-service');

      function overRealActivity(order: FakeOrder) {
        const owner = {
          status: 'HELD',
          posts: 0,
          post: (): void => {
            owner.status = 'PENDING_SETTLEMENT';
          },
          get: (): void => undefined,
          /** The first POST commits and its answer is lost; the rest answer `then`. */
          losesFirstAnswer(then: () => never): void {
            owner.post = () => {
              if (owner.posts > 1) then();
              owner.status = 'PENDING_SETTLEMENT';
              throw lost();
            };
          },
        };
        const real = createActivities({
          orders: {
            describe: async () => ({
              id: INPUT.orderId,
              buyerOrganizationId: 'ORG',
              correlationId: 'COR',
              receiptConfirmed: true,
            }),
            onceForSaga: (_o: unknown, _s: unknown, _a: unknown, call: () => unknown) => call(),
          } as unknown as OrderService,
          economic: {
            authoriseSettlement: async () => {
              owner.posts += 1;
              owner.post();
            },
            readObligation: async () => {
              owner.get();
              return { status: owner.status };
            },
          } as unknown as EconomicClient,
        });
        const recording = recordingActivities(order);
        recording.activities.authoriseSettlement = real.authoriseSettlement;
        return { ...recording, owner };
      }
      const reachReceipt = async ({ party, held }: { party: Party; held: () => Promise<void> }) => {
        await held();
        await party.confirm();
        await party.fulfil();
        await party.confirmReceipt();
      };

      it.each(LISTED)('%s on a retry, the read answers: the effect is the answer', async (code) => {
        const order = new FakeOrder();
        const { calls, activities, owner } = overRealActivity(order);
        owner.losesFirstAnswer(() => {
          throw refuse(code);
        });

        const result = await run(order, activities, reachReceipt);

        expect(result).toBe('COMPLETED');
        expect(owner.posts).toBe(2);
        expect(calls).not.toContain('noteEconomicCallUnconfirmed');
      });

      it.each(LISTED)('%s on a retry, the obligation still HELD: the saga stays', async (code) => {
        const order = new FakeOrder();
        const { calls, rounds, activities, owner } = overRealActivity(order);
        // Lost before it committed, which nothing here can tell from lost after.
        owner.post = () => {
          throw owner.posts === 1 ? lost() : refuse(code);
        };

        const result = await run(
          order,
          activities,
          async (ctx) => {
            await toWait(ctx, () => rounds.length);
            expect(owner.status).toBe('HELD');
            expect(calls).not.toContain('markSettling');
            owner.post = () => {
              owner.status = 'PENDING_SETTLEMENT';
            };
            await ctx.handle.signal(retryDisputeRelease);
          },
          { input: NO_RECHECK },
        );

        expect(result).toBe('COMPLETED');
      });

      it.each(LISTED)('%s on retries, the read refused too: the saga stays', async (code) => {
        const order = new FakeOrder();
        const { calls, rounds, activities, owner } = overRealActivity(order);
        owner.losesFirstAnswer(() => {
          throw refuse(code);
        });
        owner.get = () => {
          throw refuse(code);
        };

        const result = await run(
          order,
          activities,
          async (ctx) => {
            await toWait(ctx, () => rounds.length);
            expect(owner.status).toBe('PENDING_SETTLEMENT');
            expect(calls).not.toContain('markSettling');
            owner.get = () => undefined;
            await ctx.handle.signal(retryDisputeRelease);
          },
          { input: NO_RECHECK },
        );

        expect(result).toBe('COMPLETED');
        expect(calls.filter((c) => c === 'settle')).toHaveLength(1);
      });

      it.each(LISTED)('%s in a later round, the read refused too: the saga stays', async (code) => {
        const order = new FakeOrder();
        const { calls, rounds, activities, owner } = overRealActivity(order);
        owner.losesFirstAnswer(() => {
          throw lost();
        });
        // Down too, or the retry would read the effect and never reach the wait.
        owner.get = () => {
          throw lost();
        };

        const result = await run(
          order,
          activities,
          async (ctx) => {
            await toWait(ctx, () => rounds.length);
            owner.post = () => {
              throw refuse(code);
            };
            owner.get = () => {
              throw refuse(code);
            };
            const reported = rounds.length;
            await ctx.handle.signal(retryDisputeRelease);
            await until(() => rounds.length > reported, 'the next round');
            await atRest(ctx.handle);
            expect(calls).not.toContain('markSettling');
            owner.get = () => undefined;
            await ctx.handle.signal(retryDisputeRelease);
          },
          { input: NO_RECHECK },
        );

        expect(result).toBe('COMPLETED');
      });

      it.each(LISTED)(
        '%s in a later round, the obligation HELD: the saga stays, until a terminal status proves it',
        async (code) => {
          const order = new FakeOrder();
          const { calls, rounds, activities, owner } = overRealActivity(order);
          owner.post = () => {
            throw lost();
          };
          await run(
            order,
            activities,
            async (ctx) => {
              await toWait(ctx, () => rounds.length);
              owner.post = () => {
                throw refuse(code);
              };
              const reported = rounds.length;
              await ctx.handle.signal(retryDisputeRelease);
              await until(() => rounds.length > reported, 'the next round');
              await atRest(ctx.handle);
              expect(calls).not.toContain('markSettling');
              owner.status = 'REFUNDED';
              await ctx.handle.signal(retryDisputeRelease);
              // The owner's answer, and the order cannot follow it: for a person (#796 r1 F3).
              await phaseIs(ctx.handle, 'OBLIGATION_RECONCILIATION');
              await atRest(ctx.handle);
            },
            { input: NO_RECHECK, keepRunning: true },
          );

          expect(calls).not.toContain('markSettling');
        },
      );

      it.each([...LISTED, 'INVALID_STATE_TRANSITION'])(
        '%s on the first attempt, nothing before it: a proof, and not retried',
        async (code) => {
          const order = new FakeOrder();
          const { calls, activities, owner } = overRealActivity(order);
          owner.status = 'DISPUTED';
          owner.post = () => {
            throw refuse(code);
          };

          await expect(run(order, activities, reachReceipt)).rejects.toBeInstanceOf(
            WorkflowFailedError,
          );

          expect(owner.posts).toBe(1);
          expect(calls).not.toContain('noteEconomicCallUnconfirmed');
        },
      );

      it('the reconciliation read refused FORBIDDEN is a read, not a refusal of the write', async () => {
        const order = new FakeOrder();
        const { calls, rounds, failures, activities, owner } = overRealActivity(order);
        owner.post = () => {
          throw refuse('INVALID_STATE_TRANSITION');
        };
        owner.get = () => {
          throw refuse('FORBIDDEN');
        };

        const result = await run(
          order,
          activities,
          async (ctx) => {
            await toWait(ctx, () => rounds.length);
            expect(failures[0]).toContain('RECONCILIATION_READ_FAILED');
            expect(calls).not.toContain('markSettling');
            owner.status = 'PENDING_SETTLEMENT';
            owner.get = () => undefined;
            await ctx.handle.signal(retryDisputeRelease);
          },
          { input: NO_RECHECK },
        );

        expect(result).toBe('COMPLETED');
      });

      it('left the wait for a dispute and came back: still in doubt, so a code does not end it', async () => {
        const order = new FakeOrder();
        const { calls, rounds, activities, owner } = overRealActivity(order);
        owner.losesFirstAnswer(() => {
          throw lost();
        });
        // Down too, or the retry would read the effect and never reach the wait.
        owner.get = () => {
          throw lost();
        };

        const result = await run(
          order,
          activities,
          async (ctx) => {
            await toWait(ctx, () => rounds.length);
            await ctx.party.dispute('it arrived broken');
            await phaseIs(ctx.handle, 'DISPUTED');
            await atRest(ctx.handle);
            owner.post = () => {
              throw refuse('FORBIDDEN');
            };
            owner.get = () => {
              throw refuse('FORBIDDEN');
            };
            const reported = rounds.length;
            await ctx.party.resolve('SETTLE', 'the supplier replaced it');
            await until(() => rounds.length > reported, 'the wait to take it back');
            await atRest(ctx.handle);
            expect(calls).not.toContain('markSettling');
            owner.get = () => undefined;
            await ctx.handle.signal(retryDisputeRelease);
          },
          { input: NO_RECHECK },
        );

        expect(result).toBe('COMPLETED');
      });
    });

    describe('the filing and the refund (FU-117)', () => {
      const SIBLING_MARKER = 'economic-sibling-call-durable-wait-v1';
      const toldFinal = (): Error =>
        ApplicationFailure.create({
          message: 'The obligation is SETTLED',
          type: 'OBLIGATION_ALREADY_FINAL',
          nonRetryable: true,
          details: [OWNER_STATE_IS_FINAL],
        });
      const unlisted = (code: string) => (): Error => ApplicationFailure.nonRetryable('no', code);

      /** One economic call failing with whatever `economic.failure` says until `recovered`. */
      function failingOn(
        order: FakeOrder,
        operation: 'createObligation' | 'disputeObligation' | 'compensate',
        failure: () => Error = down,
      ) {
        const economic = { recovered: false, failure, sent: [] as unknown[][] };
        const recording = recordingActivities(order);
        (recording.activities as unknown as Record<string, unknown>)[operation] = async (
          ...args: unknown[]
        ) => {
          recording.calls.push(operation);
          economic.sent.push(args);
          if (!economic.recovered) throw economic.failure();
          if (operation === 'createObligation') return { transactionId: TRANSACTION };
          return operation === 'disputeObligation' ? 'E' : undefined;
        };
        return { ...recording, economic };
      }
      const toCancelled = async (ctx: { party: Party; held: () => Promise<void> }) => {
        await ctx.held();
        await ctx.party.cancel('changed their mind');
      };
      const toDisputed = async (ctx: { party: Party; held: () => Promise<void> }) => {
        await ctx.held();
        await ctx.party.dispute('it arrived broken');
      };
      const SITES = [
        ['compensate', toCancelled, 'COMPENSATION_UNCONFIRMED', 'markCancelled'],
        ['disputeObligation', toDisputed, 'DISPUTE_UNCONFIRMED', 'resolveObligationDispute'],
      ] as const;

      describe.each(SITES)('%s', (operation, reach, phase, after) => {
        it('exhausted: the saga stays, moves nothing, and goes on once answered', async () => {
          const order = new FakeOrder();
          const { calls, rounds, activities, economic } = failingOn(order, operation);
          let seen: WorkflowHandle | undefined;
          const outcome = await run(
            order,
            activities,
            async (ctx) => {
              seen = ctx.handle;
              await reach(ctx);
              await phaseIs(ctx.handle, phase);
              await until(() => rounds.length > 0, 'a round');
              await atRest(ctx.handle);
              await env.sleep('3 hours');
              expect(rounds.length).toBeGreaterThanOrEqual(3);
              expect(calls).not.toContain(after);
              expect((await ctx.handle.query<SagaStatus, []>('status')).phase).toBe(phase);
              await atRest(ctx.handle);
              economic.recovered = true;
              await ctx.handle.signal(retryDisputeRelease);
              if (operation === 'disputeObligation') {
                await phaseIs(ctx.handle, 'DISPUTED');
                await atRest(ctx.handle);
                await ctx.party.resolve('REFUND', 'the supplier agreed');
              }
            },
            { input: NO_RECHECK },
          );
          expect(outcome).toBe('CANCELLED');
          expect(calls).toContain(after);
          // The same words, so the same idempotency key, on every round.
          const sameWords = economic.sent.map((args) =>
            JSON.stringify(args.filter((arg) => typeof arg !== 'boolean')),
          );
          expect(new Set(sameWords).size).toBe(1);
          // In doubt from the second scheduling on, never before it.
          expect(economic.sent[0]?.at(-2)).toBe(false);
          expect(economic.sent.at(-1)?.at(-2)).toBe(true);
          const handle = seen as WorkflowHandle;
          const ids = await patchIds(handle);
          expect(ids).toContain(SIBLING_MARKER);
          expect(ids).not.toContain(MARKER);
          await Worker.runReplayHistory(
            { workflowsPath: require.resolve('./workflows') },
            await handle.fetchHistory(),
            handle.workflowId,
          );
        });

        it('a refusal marked as its first attempt ends the saga, with no wait', async () => {
          const order = new FakeOrder();
          const { calls, rounds, activities } = failingOn(order, operation, refused);
          await expect(run(order, activities, reach)).rejects.toMatchObject({
            cause: { cause: { type: 'INVALID_STATE_TRANSITION' } },
          });
          expect(rounds).toEqual([]);
          expect(calls).not.toContain(after);
        });

        it.each(['IDEMPOTENCY_KEY_REUSED', 'SOMETHING_NEW'])('%s waits', async (code) => {
          const order = new FakeOrder();
          const { calls, rounds, activities } = failingOn(order, operation, unlisted(code));
          await run(
            order,
            activities,
            async (ctx) => {
              await reach(ctx);
              await phaseIs(ctx.handle, phase);
              await until(() => rounds.length > 0, 'a round');
              await atRest(ctx.handle);
            },
            { keepRunning: true },
          );
          expect(calls).not.toContain(after);
        });

        it('in doubt, a marked refusal does not end it; the owner’s final state does', async () => {
          const order = new FakeOrder();
          const { calls, rounds, activities, economic } = failingOn(order, operation);
          await expect(
            run(order, activities, async (ctx) => {
              await reach(ctx);
              await phaseIs(ctx.handle, phase);
              await until(() => rounds.length > 0, 'a round');
              await atRest(ctx.handle);
              economic.failure = refused;
              await ctx.handle.signal(retryDisputeRelease);
              await until(() => rounds.length > 1, 'a refused round to stay');
              expect((await ctx.handle.query<SagaStatus, []>('status')).phase).toBe(phase);
              await atRest(ctx.handle);
              economic.failure = toldFinal;
              await ctx.handle.signal(retryDisputeRelease);
            }),
          ).rejects.toMatchObject({ cause: { cause: { type: 'OBLIGATION_ALREADY_FINAL' } } });
          expect(calls).not.toContain(after);
        });

        it('with an authorisation in doubt, a first attempt’s refusal does not end it', async () => {
          const order = new FakeOrder();
          const { rounds, activities, economic } = failingOn(order, operation, refused);
          // The authorisation goes unconfirmed, then the order moves.
          activities.authoriseSettlement = async () => {
            throw down();
          };
          activities.findObligation = async () => ({ transactionId: TRANSACTION });
          await run(
            order,
            activities,
            async (ctx) => {
              await toWait(ctx, () => rounds.length);
              const before = rounds.length;
              await atRest(ctx.handle);
              ctx.party.silently((o) => o.raiseDispute('it arrived broken'));
              if (operation === 'compensate') {
                ctx.party.silently((o) => o.resolveDispute('REFUND', 'the supplier agreed'));
              }
              await ctx.handle.signal(retryDisputeRelease);
              await phaseIs(ctx.handle, phase);
              await until(() => rounds.length > before, 'a round of it');
              await atRest(ctx.handle);
              expect(economic.sent.length).toBeGreaterThan(0);
              expect(economic.sent[0]?.at(-2)).toBe(true);
            },
            { keepRunning: true, input: NO_RECHECK },
          );
        });
      });

      it('a saga protocol 4 left in the wait of an authorisation waits at the refund after the deploy', async () => {
        const order = new FakeOrder();
        const { rounds, activities, economic } = failingOn(order, 'compensate');
        activities.authoriseSettlement = async () => {
          throw down();
        };
        activities.findObligation = async () => ({ transactionId: TRANSACTION });
        const taskQueue = `protocol-4-${(queues += 1)}`;
        const handle = await env.client.workflow.start(orderSaga, {
          taskQueue,
          workflowId: taskQueue,
          args: [{ ...INPUT, ...NO_RECHECK }],
        });
        const party = new Party(order, handle);
        const before = await Worker.create({
          connection: env.nativeConnection,
          taskQueue,
          workflowsPath: require.resolve('./workflows'),
          activities,
          maxCachedWorkflows: 0,
          // What protocol 4 writes: every marker but this one.
          patchActivationCallback: ({ patchId }) => patchId !== SIBLING_MARKER,
        });
        await before.runUntil(async () => {
          await toWait(
            {
              party,
              handle,
              held: () => until(() => order.status !== 'PENDING', 'the hold'),
            },
            () => rounds.length,
          );
        });
        expect(await patchIds(handle)).toContain(MARKER);
        expect(await patchIds(handle)).not.toContain(SIBLING_MARKER);

        const after = await Worker.create({
          connection: env.nativeConnection,
          taskQueue,
          workflowsPath: require.resolve('./workflows'),
          activities,
        });
        const outcome = await after.runUntil(async () => {
          party.silently((o) => o.raiseDispute('it arrived broken'));
          party.silently((o) => o.resolveDispute('REFUND', 'the supplier agreed'));
          await handle.signal(retryDisputeRelease);
          await phaseIs(handle, 'COMPENSATION_UNCONFIRMED');
          await atRest(handle);
          economic.recovered = true;
          await handle.signal(retryDisputeRelease);
          return within(STEP_DEADLINE_MS, handle.result(), 'the saga to finish');
        });
        expect(outcome).toBe('CANCELLED');
        expect(await patchIds(handle)).toContain(SIBLING_MARKER);
        await Worker.runReplayHistory(
          { workflowsPath: require.resolve('./workflows') },
          await handle.fetchHistory(),
          handle.workflowId,
        );
      });

      it('a filing sent on while the order moved: mirrored and released before the refund', async () => {
        const order = new FakeOrder();
        const { calls, rounds, activities, economic } = failingOn(order, 'disputeObligation');
        const refunded: unknown[][] = [];
        const released: unknown[][] = [];
        activities.compensate = async (...args: unknown[]) => {
          calls.push('compensate');
          refunded.push(args);
        };
        activities.resolveObligationDispute = async (...args: unknown[]) => {
          calls.push('resolveObligationDispute');
          released.push(args);
        };
        const outcome = await run(
          order,
          activities,
          async (ctx) => {
            await toDisputed(ctx);
            await until(() => rounds.length > 0, 'a round');
            await atRest(ctx.handle);
            await ctx.party.resolve('REFUND', 'the supplier agreed');
            await atRest(ctx.handle);
            expect(calls).not.toContain('compensate');
            economic.recovered = true;
            await ctx.handle.signal(retryDisputeRelease);
          },
          { input: NO_RECHECK },
        );
        expect(outcome).toBe('CANCELLED');
        const release = calls.indexOf('resolveObligationDispute');
        expect(calls.lastIndexOf('disputeObligation')).toBeLessThan(release);
        expect(release).toBeLessThan(calls.indexOf('compensate'));
        // What the filing answered is what the release names.
        expect(released[0]?.[4]).toBe('E');
        // Answered, the filing's doubt is gone: the refund goes as a first send.
        expect(refunded[0]?.[3]).toBe(false);
      });

      describe('the hold', () => {
        const HOLD_MARKER = 'economic-hold-call-durable-wait-v1';
        /** The answer lost, nothing found: what used to record FAILED. */
        function holdLost(order: FakeOrder, failure: () => Error = down) {
          const lost = failingOn(order, 'createObligation', failure);
          const owner = { committed: false, lookups: 0 };
          lost.activities.findObligation = async () => {
            owner.lookups += 1;
            return owner.committed ? { transactionId: 'TXN_LATE' } : null;
          };
          return { ...lost, owner };
        }
        const inHoldWait = async (handle: WorkflowHandle, rounds: () => number): Promise<void> => {
          await phaseIs(handle, 'HOLD_UNCONFIRMED');
          await until(() => rounds() > 0, 'a round');
          await atRest(handle);
        };
        const replay = async (handle: WorkflowHandle): Promise<void> =>
          Worker.runReplayHistory(
            { workflowsPath: require.resolve('./workflows') },
            await handle.fetchHistory(),
            handle.workflowId,
          );

        it('a request that commits after the empty lookup: never FAILED, and the late hold is adopted', async () => {
          const order = new FakeOrder();
          const { calls, rounds, activities, owner } = holdLost(order);
          let seen: WorkflowHandle | undefined;
          await run(
            order,
            activities,
            async (ctx) => {
              seen = ctx.handle;
              await inHoldWait(ctx.handle, () => rounds.length);
              expect(owner.lookups).toBeGreaterThan(0);
              expect(calls).not.toContain('markFailed');
              expect(order.status).toBe('PENDING');
              owner.committed = true; // The first request lands now.
              await ctx.handle.signal(retryDisputeRelease);
              await ctx.held();
              await atRest(ctx.handle);
            },
            { keepRunning: true, input: NO_RECHECK },
          );
          expect(calls).not.toContain('markFailed');
          expect(order.economicTransactionId).toBe('TXN_LATE');
          expect(order.status).toBe('FUNDS_HELD');
          const handle = seen as WorkflowHandle;
          expect(await patchIds(handle)).toContain(HOLD_MARKER);
          expect(await patchIds(handle)).not.toContain('economic-sibling-call-durable-wait-v1');
          await replay(handle);
        });

        it('economic-service recovers: the same key is answered and the order goes on', async () => {
          const order = new FakeOrder();
          const { rounds, activities, economic } = holdLost(order);
          await run(
            order,
            activities,
            async (ctx) => {
              await inHoldWait(ctx.handle, () => rounds.length);
              economic.recovered = true;
              await ctx.handle.signal(retryDisputeRelease);
              await ctx.held();
              await atRest(ctx.handle);
            },
            { keepRunning: true, input: NO_RECHECK },
          );
          expect(order.economicTransactionId).toBe(TRANSACTION);
          expect(new Set(economic.sent.map((args) => JSON.stringify(args))).size).toBe(1);
        });

        it('cancelled during the wait: sent on as the fence, then refunded and cancelled', async () => {
          const order = new FakeOrder();
          const { calls, rounds, activities, economic } = holdLost(order);
          const outcome = await run(
            order,
            activities,
            async (ctx) => {
              await inHoldWait(ctx.handle, () => rounds.length);
              await ctx.party.cancel('changed their mind');
              await atRest(ctx.handle);
              expect(calls).not.toContain('markCancelled');
              economic.recovered = true;
              await ctx.handle.signal(retryDisputeRelease);
            },
            { input: NO_RECHECK },
          );
          expect(outcome).toBe('CANCELLED');
          expect(calls.indexOf('compensate')).toBeLessThan(calls.indexOf('markCancelled'));
          expect(calls).not.toContain('markFailed');
        });

        it('a later attempt’s refusal with an empty lookup does not fail the order', async () => {
          const order = new FakeOrder();
          let sends = 0;
          const { calls, rounds, activities } = holdLost(order);
          activities.createObligation = async () => {
            sends += 1;
            if (sends === 1) throw down();
            throw ApplicationFailure.nonRetryable('Insufficient balance', 'INSUFFICIENT_BALANCE');
          };
          await run(
            order,
            activities,
            async (ctx) => {
              await inHoldWait(ctx.handle, () => rounds.length);
            },
            { keepRunning: true, input: NO_RECHECK },
          );
          expect(sends).toBe(2);
          expect(calls).not.toContain('markFailed');
          expect(order.status).toBe('PENDING');
        });

        it('in doubt, a marked refusal and an empty lookup do not fail the order', async () => {
          const order = new FakeOrder();
          const { calls, rounds, activities, economic } = holdLost(order);
          await run(
            order,
            activities,
            async (ctx) => {
              await inHoldWait(ctx.handle, () => rounds.length);
              economic.failure = () =>
                ApplicationFailure.create({
                  message: 'Insufficient balance',
                  type: 'INSUFFICIENT_BALANCE',
                  nonRetryable: true,
                  details: [REFUSED_ON_FIRST_ATTEMPT],
                });
              await ctx.handle.signal(retryDisputeRelease);
              await until(() => rounds.length > 1, 'a refused round to stay');
              await atRest(ctx.handle);
            },
            { keepRunning: true, input: NO_RECHECK },
          );
          expect(calls).not.toContain('markFailed');
          expect(order.status).toBe('PENDING');
        });

        it('a lookup that cannot finish, with the hold unanswered, waits too', async () => {
          const order = new FakeOrder();
          const { calls, rounds, activities, economic } = holdLost(order);
          activities.findObligation = async () => {
            if (economic.recovered) return null;
            throw ApplicationFailure.nonRetryable('more pages', 'OBLIGATION_LOOKUP_INCOMPLETE');
          };
          await run(
            order,
            activities,
            async (ctx) => {
              await inHoldWait(ctx.handle, () => rounds.length);
              economic.recovered = true;
              await ctx.handle.signal(retryDisputeRelease);
              await ctx.held();
              await atRest(ctx.handle);
            },
            { keepRunning: true, input: NO_RECHECK },
          );
          expect(calls).not.toContain('markFailed');
        });

        it('economic-service wholly down: rounds are counted though the lookup cannot answer', async () => {
          const order = new FakeOrder();
          const { calls, rounds, activities, economic } = holdLost(order);
          activities.findObligation = async () => {
            if (!economic.recovered) throw down();
            return null;
          };
          await run(
            order,
            activities,
            async (ctx) => {
              await inHoldWait(ctx.handle, () => rounds.length);
              // A marked refusal in a round proves nothing, so its lookup counts too.
              const reported = rounds.length;
              economic.failure = provenRefusal;
              await ctx.handle.signal(retryDisputeRelease);
              await until(() => rounds.length > reported, 'the refused round to be counted');
              await atRest(ctx.handle);
              economic.recovered = true;
              await ctx.handle.signal(retryDisputeRelease);
              await ctx.held();
              await atRest(ctx.handle);
            },
            { keepRunning: true, input: NO_RECHECK },
          );
          expect(calls).not.toContain('markFailed');
          expect(order.economicTransactionId).toBe(TRANSACTION);
        });

        it('a proven refusal keeps its proof through a lookup that fails for a while', async () => {
          const order = new FakeOrder();
          const { calls, rounds, activities } = holdLost(order, provenRefusal);
          let lookups = 0;
          activities.findObligation = async () => {
            // More attempts than a call in doubt is given.
            if ((lookups += 1) <= 4) throw down();
            return null;
          };
          let seen: WorkflowHandle | undefined;
          const outcome = await run(order, activities, async (ctx) => {
            seen = ctx.handle;
          });
          expect(outcome).toBe('FAILED');
          expect(lookups).toBe(5);
          expect(rounds).toEqual([]);
          expect(calls).toContain('markFailed');
          // No wait, no marker: the gate asks nothing of this history.
          expect(await patchIds(seen as WorkflowHandle)).not.toContain(HOLD_MARKER);
        });

        it('an obligation not adopted found in a round stops the saga, deciding nothing', async () => {
          const order = new FakeOrder();
          const { calls, rounds, activities, owner } = holdLost(order);
          activities.findObligation = async () =>
            owner.committed
              ? ({ mismatch: true, transactionIds: ['TXN_OTHER'], differ: ['payee'] } as never)
              : null;
          await expect(
            run(order, activities, async (ctx) => {
              await inHoldWait(ctx.handle, () => rounds.length);
              owner.committed = true;
              await ctx.handle.signal(retryDisputeRelease);
              // The status query names why it stopped, not the phase before the wait.
              await phaseIs(ctx.handle, 'OBLIGATION_MISMATCH');
            }),
          ).rejects.toMatchObject({ cause: { type: 'OBLIGATION_TERMS_MISMATCH' } });
          expect(calls).not.toContain('markFailed');
          expect(calls).not.toContain('markFundsHeld');
        });

        it('a saga protocol 5 started, its hold unanswered at the deploy, waits on this build', async () => {
          const order = new FakeOrder();
          const { calls, rounds, activities, economic } = holdLost(order);
          const taskQueue = `protocol-5-${(queues += 1)}`;
          const handle = await env.client.workflow.start(orderSaga, {
            taskQueue,
            workflowId: taskQueue,
            args: [{ ...INPUT, ...NO_RECHECK }],
          });
          const before = await Worker.create({
            connection: env.nativeConnection,
            taskQueue,
            workflowsPath: require.resolve('./workflows'),
            activities,
            maxCachedWorkflows: 0,
            // What protocol 5 writes: every marker but this one.
            patchActivationCallback: ({ patchId }) => patchId !== HOLD_MARKER,
          });
          await before.runUntil(until(() => economic.sent.length > 0, 'the first attempt'));
          expect(await patchIds(handle)).not.toContain(HOLD_MARKER);

          const after = await Worker.create({
            connection: env.nativeConnection,
            taskQueue,
            workflowsPath: require.resolve('./workflows'),
            activities,
          });
          await after.runUntil(async () => {
            await inHoldWait(handle, () => rounds.length);
            expect(calls).not.toContain('markFailed');
            economic.recovered = true;
            await handle.signal(retryDisputeRelease);
            await until(() => order.status === 'FUNDS_HELD', 'the hold');
            await atRest(handle);
          });
          expect(await patchIds(handle)).toContain(HOLD_MARKER);
          await replay(handle);
          await handle.terminate();
        });

        it('a saga past protocol 5’s decision keeps it on this build', async () => {
          const order = new FakeOrder();
          const { calls, activities } = holdLost(order);
          const taskQueue = `protocol-5-${(queues += 1)}`;
          const handle = await env.client.workflow.start(orderSaga, {
            taskQueue,
            workflowId: taskQueue,
            args: [{ ...INPUT, ...NO_RECHECK }],
          });
          const recordFailed = activities.markFailed;
          let tried = false;
          activities.markFailed = async (...args) => {
            if (!tried) {
              tried = true;
              throw down(); // Decided, and not yet recorded, when the deploy comes.
            }
            return recordFailed(...args);
          };
          const before = await Worker.create({
            connection: env.nativeConnection,
            taskQueue,
            workflowsPath: require.resolve('./workflows'),
            activities,
            maxCachedWorkflows: 0,
            patchActivationCallback: ({ patchId }) => patchId !== HOLD_MARKER,
          });
          await before.runUntil(until(() => tried, 'protocol 5 to decide'));
          const after = await Worker.create({
            connection: env.nativeConnection,
            taskQueue,
            workflowsPath: require.resolve('./workflows'),
            activities,
          });
          const outcome = await after.runUntil(
            within(STEP_DEADLINE_MS, handle.result(), 'the saga to finish'),
          );
          expect(outcome).toBe('FAILED');
          expect(calls).toContain('markFailed');
          expect(await patchIds(handle)).not.toContain(HOLD_MARKER);
          await replay(handle);
        });

        it('a build that withholds the marker still ends as protocol 5 did, and that replays', async () => {
          const order = new FakeOrder();
          const { calls, activities } = holdLost(order);
          const taskQueue = `protocol-5-${(queues += 1)}`;
          const handle = await env.client.workflow.start(orderSaga, {
            taskQueue,
            workflowId: taskQueue,
            args: [{ ...INPUT, ...NO_RECHECK }],
          });
          const before = await Worker.create({
            connection: env.nativeConnection,
            taskQueue,
            workflowsPath: require.resolve('./workflows'),
            activities,
            patchActivationCallback: ({ patchId }) => patchId !== HOLD_MARKER,
          });
          const outcome = await before.runUntil(
            within(STEP_DEADLINE_MS, handle.result(), 'the saga to finish'),
          );
          expect(outcome).toBe('FAILED');
          expect(calls).toContain('markFailed');
          expect(await patchIds(handle)).not.toContain(HOLD_MARKER);
          await replay(handle);
        });
      });
    });
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
        throw provenRefusal();
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

    // Review of #334 round 1, F1: the buyer's administrator recorded
    // ORDER/<order id> first, 1 rial to an accomplice; the saga's creation got
    // 409, its recovery adopted that row, and the saga settled it.
    it('stops, adopting nothing, when the obligation found names the order on other terms', async () => {
      const order = new FakeOrder();
      const { calls, activities } = recordingActivities(order, {
        createObligation: async () => {
          throw ApplicationFailure.nonRetryable(
            'An obligation for this source is already recorded for this organization',
            'CONFLICT',
          );
        },
        findObligation: async () => ({
          mismatch: true,
          transactionIds: ['TXN_PRE_RECORDED'],
          differ: ['payee', 'amount'],
        }),
      });

      await expect(run(order, activities, async () => undefined)).rejects.toMatchObject({
        cause: { type: 'OBLIGATION_TERMS_MISMATCH' },
      });

      // Nothing adopted, nothing decided: the funds stay where they are.
      expect(order.status).toBe('PENDING');
      expect(order.economicTransactionId).toBeNull();
      for (const step of [
        'markFundsHeld',
        'markFailed',
        'authoriseSettlement',
        'settle',
        'compensate',
        'markCancelled',
      ]) {
        expect(calls).not.toContain(step);
      }
    });

    it('refunds nothing it did not record, and stays, when a cancelled order’s lookup finds other terms', async () => {
      const order = new FakeOrder();
      let lookups = 0;
      const { calls, activities } = recordingActivities(order, {
        createObligation: async () => {
          order.cancel('found a cheaper supplier');
          throw provenRefusal();
        },
        // Nothing yet when the hold is checked; a row by the time the
        // cancellation asks again.
        findObligation: async () =>
          (lookups += 1) === 1
            ? null
            : { mismatch: true, transactionIds: ['TXN_PRE_RECORDED'], differ: ['amount'] },
      });

      await run(
        order,
        activities,
        (ctx) =>
          eventually(
            async () =>
              (await ctx.handle.query<SagaStatus, []>('status')).phase === 'OBLIGATION_MISMATCH',
            'the saga to stay for the mismatch',
          ),
        { keepRunning: true },
      );
      expect(lookups).toBeGreaterThanOrEqual(2);
      expect(calls).not.toContain('compensate');
      expect(calls).not.toContain('markCancelled');
    });

    // Review of #334 round 2, F1: the hold committed, its answer was lost, and
    // the obligation — on exactly the order's terms — was moved on before the
    // saga looked. Recording it as held published ORDER_FUNDS_HELD for money
    // back with the buyer.
    it.each<[string, string]>([
      ['REFUNDED', 'RETURNED'],
      ['CANCELLED', 'NEVER_HELD'],
      ['CREATED', 'NEVER_HELD'],
      ['FAILED', 'NEVER_HELD'],
      ['SETTLED', 'PAID_OUT'],
      ['PENDING_SETTLEMENT', 'UNPROVEN'],
      ['DISPUTED', 'UNPROVEN'],
    ])(
      'stops, recording nothing, when the order’s own obligation is %s (funds %s)',
      async (obligationStatus, funds) => {
        const order = new FakeOrder();
        const { calls, activities } = recordingActivities(order, {
          createObligation: async () => {
            throw ApplicationFailure.retryable('economic-service timed out', 'UPSTREAM_TIMEOUT');
          },
          findObligation: async () => ({
            notHeld: true,
            transactionId: 'TXN_OWN',
            status: obligationStatus,
            funds: funds as never,
          }),
        });

        const failure = await run(order, activities, async () => undefined).catch(
          (error: unknown) => error,
        );

        expect(failure).toMatchObject({ cause: { type: 'OBLIGATION_NOT_HELD' } });
        const cause = (failure as { cause: ApplicationFailure }).cause;
        expect(cause.message).toContain(obligationStatus);
        expect(cause.message).toContain(funds);
        expect(cause.details).toEqual([
          { transactionId: 'TXN_OWN', status: obligationStatus, funds },
        ]);

        expect(order.status).toBe('PENDING');
        expect(order.economicTransactionId).toBeNull();
        for (const step of [
          'markFundsHeld',
          'markFailed',
          'authoriseSettlement',
          'settle',
          'compensate',
          'markCancelled',
        ]) {
          expect(calls).not.toContain(step);
        }
      },
    );

    it('closes as cancelled, refunding nothing, when a cancelled order’s lookup finds its obligation refunded', async () => {
      const order = new FakeOrder();
      let lookups = 0;
      const { calls, activities } = recordingActivities(order, {
        createObligation: async () => {
          order.cancel('found a cheaper supplier');
          throw provenRefusal();
        },
        findObligation: async () =>
          (lookups += 1) === 1
            ? null
            : { notHeld: true, transactionId: 'TXN_OWN', status: 'REFUNDED', funds: 'RETURNED' },
      });

      await expect(run(order, activities, async () => undefined)).resolves.toBe('CANCELLED');
      expect(lookups).toBe(2);
      expect(calls).not.toContain('compensate');
      expect(calls).toContain('markCancelled');
    });

    it('closes as cancelled, with nothing to refund, when the buyer cancelled and the hold was refused', async () => {
      const order = new FakeOrder();
      const { calls, activities } = recordingActivities(order, {
        createObligation: async () => {
          order.cancel('found a cheaper supplier');
          throw provenRefusal();
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

  it('mirrors a second dispute on the same order under its own key', async () => {
    // RECEIPT_CONFIRMED -> DISPUTED is legal after an operator settles the
    // first dispute back. The second must reach economic-service as a dispute,
    // not replay the first one's stored response.
    const order = new FakeOrder();
    const mirrored: string[] = [];
    const resolved: string[] = [];
    let raisedSecond = false;
    const { calls, activities } = recordingActivities(order, {
      disputeObligation: async (_o: string, _t: string, disputeId: string) => {
        calls.push('disputeObligation');
        mirrored.push(disputeId);
        return null;
      },
      resolveObligationDispute: async (_o: string, _t: string, disputeId: string) => {
        calls.push('resolveObligationDispute');
        resolved.push(disputeId);
      },
      markSettling: async () => {
        calls.push('markSettling');
        if (mirrored.length === 1 && !raisedSecond) {
          raisedSecond = true;
          order.raiseDispute('the replacement parts are damaged too');
        }
        return order.step('SETTLING', ['RECEIPT_CONFIRMED'], ['DISPUTED']);
      },
    });

    const result = await run(order, activities, async ({ party, held }) => {
      await held();
      await party.confirm();
      await party.fulfil();
      await party.dispute('the parts arrived damaged');
      await until(() => mirrored.length === 1, 'the first dispute to be mirrored');
      await party.resolve('SETTLE', 'the supplier replaced the damaged parts');
      // Raised before receipt: back to waiting for it (D-083).
      await until(() => resolved.length === 1, 'the first decision to be mirrored');
      await party.confirmReceipt();
      await until(() => mirrored.length === 2, 'the second dispute to be mirrored');
      await party.resolve('SETTLE', 'the supplier evidenced undamaged delivery');
    });

    expect(result).toBe('COMPLETED');
    expect(mirrored).toEqual(['DSP_1', 'DSP_2']);
    expect(resolved).toEqual(['DSP_1', 'DSP_2']);
  });

  // -------------------------------------------------------------------------
  // D-083 — a dispute settled before receipt resumes the order
  // -------------------------------------------------------------------------

  describe('a dispute an operator settles before receipt resumes the order where it was (D-083, marketplace audit F1)', () => {
    // A server of its own, and every case here finishes its saga rather than
    // terminating it. These cases skip time with `env.sleep`; after a case
    // that terminates a saga with an activity in flight (two earlier ones do),
    // the time-skipping server stopped skipping and `env.sleep` never returned
    // — in CI and locally alike, while the same cases passed on a fresh
    // server. What the earlier cases leave behind is theirs; these do not
    // depend on it, and leave nothing for each other.
    let shared: TestWorkflowEnvironment;
    beforeAll(async () => {
      shared = env;
      env = await timeSkippingServer();
    }, 300_000);
    afterAll(async () => {
      await env?.teardown();
      env = shared;
    });

    type Origin = 'FUNDS_HELD' | 'CONFIRMED' | 'AWAITING_RECEIPT_CONFIRMATION';
    const ORIGINS: Origin[] = ['FUNDS_HELD', 'CONFIRMED', 'AWAITING_RECEIPT_CONFIRMATION'];
    /** What the parties do to bring a held order to `origin`. */
    const REACH: Record<Origin, (party: Party) => Promise<void>> = {
      FUNDS_HELD: async () => undefined,
      CONFIRMED: (party) => party.confirm(),
      AWAITING_RECEIPT_CONFIRMATION: async (party) => {
        await party.confirm();
        await party.fulfil();
      },
    };
    /** What is left for them from `origin`: the real path, nothing skipped. */
    const REST: Record<Origin, (party: Party) => Promise<void>> = {
      FUNDS_HELD: async (party) => {
        await party.confirm();
        await party.fulfil();
        await party.confirmReceipt();
      },
      CONFIRMED: async (party) => {
        await party.fulfil();
        await party.confirmReceipt();
      },
      AWAITING_RECEIPT_CONFIRMATION: (party) => party.confirmReceipt(),
    };
    const PHASE: Record<Origin, string> = {
      FUNDS_HELD: 'AWAITING_CONFIRMATION',
      CONFIRMED: 'AWAITING_FULFILMENT',
      AWAITING_RECEIPT_CONFIRMATION: 'AWAITING_RECEIPT_CONFIRMATION',
    };
    const PATH: Record<Origin, Status[]> = {
      FUNDS_HELD: ['PENDING', 'FUNDS_HELD', 'DISPUTED', 'FUNDS_HELD', 'CONFIRMED'],
      CONFIRMED: ['PENDING', 'FUNDS_HELD', 'CONFIRMED', 'DISPUTED', 'CONFIRMED'],
      AWAITING_RECEIPT_CONFIRMATION: [
        'PENDING',
        'FUNDS_HELD',
        'CONFIRMED',
        'AWAITING_RECEIPT_CONFIRMATION',
        'DISPUTED',
      ],
    };
    const SETTLED_PATH: Status[] = [
      'AWAITING_RECEIPT_CONFIRMATION',
      'RECEIPT_CONFIRMED',
      'SETTLING',
      'COMPLETED',
    ];

    it.each(ORIGINS)(
      'raised at %s: back there, waiting as before; nothing authorised until the buyer confirms receipt',
      async (origin) => {
        const order = new FakeOrder();
        const { calls, effects, activities } = recordingActivities(order);

        const result = await run(
          order,
          activities,
          async ({ party, held, handle }) => {
            await held();
            await REACH[origin](party);
            await party.dispute('the parts do not match the offer');
            await until(() => calls.includes('disputeObligation'), 'the dispute to be mirrored');
            await party.resolve('SETTLE', 'the supplier showed the parts match the offer');
            await until(
              () => calls.includes('resolveObligationDispute'),
              'the decision to be mirrored',
            );
            // Where the dispute found it — not RECEIPT_CONFIRMED.
            expect(order.status).toBe(origin);
            await eventually(
              async () => (await handle.query<SagaStatus, []>('status')).phase === PHASE[origin],
              'the saga to wait where the order is',
            );
            // Time passes, as for any order waiting there: nothing is authorised.
            await env.sleep('2 days');
            expect(calls).not.toContain('authoriseSettlement');
            expect(calls).not.toContain('settle');
            await REST[origin](party);
          },
          { input: NO_RECHECK },
        );

        expect(result).toBe('COMPLETED');
        // The economic calls, in order: the dispute and its decision are
        // mirrored before anything else, and authorisation comes only after
        // the receipt; one settlement.
        expect(effects()).toEqual([
          'createObligation',
          'markFundsHeld',
          'disputeObligation',
          'resolveObligationDispute',
          'authoriseSettlement',
          'markSettling',
          'settle',
          'markCompleted',
        ]);
        expect(calls.filter((c) => c === 'settle')).toHaveLength(1);
        expect(order.history.slice(0, PATH[origin].length)).toEqual(PATH[origin]);
        expect(order.history.slice(-SETTLED_PATH.length)).toEqual(SETTLED_PATH);
      },
    );

    it('raised after receipt: SETTLE returns it to RECEIPT_CONFIRMED and it settles once', async () => {
      const order = new FakeOrder();
      let disputedAfterReceipt = false;
      const { calls, effects, activities } = recordingActivities(order, {
        // The buyer disputes just after confirming receipt, before the saga
        // gets as far as settling.
        markSettling: async () => {
          calls.push('markSettling');
          if (!disputedAfterReceipt) {
            disputedAfterReceipt = true;
            order.raiseDispute('one of the parts was damaged in the box');
          }
          return order.step('SETTLING', ['RECEIPT_CONFIRMED'], ['DISPUTED']);
        },
      });

      const result = await run(order, activities, async ({ party, held }) => {
        await held();
        await party.confirm();
        await party.fulfil();
        await party.confirmReceipt();
        await until(() => calls.includes('disputeObligation'), 'the dispute to be mirrored');
        await party.resolve('SETTLE', 'the damage happened after delivery');
      });

      expect(result).toBe('COMPLETED');
      expect(order.history).toEqual([
        'PENDING',
        'FUNDS_HELD',
        'CONFIRMED',
        'AWAITING_RECEIPT_CONFIRMATION',
        'RECEIPT_CONFIRMED',
        'DISPUTED',
        'RECEIPT_CONFIRMED',
        'SETTLING',
        'COMPLETED',
      ]);
      expect(effects()).toEqual([
        'createObligation',
        'markFundsHeld',
        'authoriseSettlement',
        'markSettling',
        'disputeObligation',
        'resolveObligationDispute',
        'authoriseSettlement',
        'markSettling',
        'settle',
        'markCompleted',
      ]);
      expect(calls.filter((c) => c === 'settle')).toHaveLength(1);
    });

    it('keeps the reminder deadline it had: a dispute does not buy a fresh window', async () => {
      // The fulfilment window is 7 days. Disputed on day 2, settled back on
      // day 3: the reminder is due on day 7, as it always was — a window
      // started again would not remind before day 10.
      const order = new FakeOrder();
      const { calls, activities } = recordingActivities(order);
      const reminders = () => calls.filter((c) => c === 'recordReminder').length;

      const result = await run(
        order,
        activities,
        async ({ party, held }) => {
          await held();
          await env.sleep('2 days');
          await party.dispute('the supplier has not answered at all');
          await until(() => calls.includes('disputeObligation'), 'the dispute to be mirrored');
          await env.sleep('1 day');
          await party.resolve('SETTLE', 'the supplier has answered since');
          await until(
            () => calls.includes('resolveObligationDispute'),
            'the decision to be mirrored',
          );
          expect(reminders()).toBe(0);
          await env.sleep('108 hours'); // day 7.5
          await until(() => reminders() === 1, 'the reminder due on day 7');
          expect(order.status).toBe('FUNDS_HELD');
          expect(calls).not.toContain('authoriseSettlement');
          // Finished, not terminated mid-activity: a saga terminated while an
          // activity is in flight left the time-skipping server unable to skip
          // for the cases after it.
          await REST.FUNDS_HELD(party);
        },
        { input: NO_RECHECK },
      );
      expect(result).toBe('COMPLETED');
    });

    it('records a reminder that fell due during the dispute as soon as it resumes', async () => {
      const order = new FakeOrder();
      const { calls, activities } = recordingActivities(order);

      const result = await run(
        order,
        activities,
        async ({ party, held }) => {
          await held();
          await env.sleep('1 day');
          await party.dispute('the supplier has not answered at all');
          await until(() => calls.includes('disputeObligation'), 'the dispute to be mirrored');
          // Ten days in dispute: no reminder there, ever.
          await env.sleep('10 days');
          expect(calls).not.toContain('recordReminder');
          await party.resolve('SETTLE', 'the supplier has answered since');
          // Due on day 7, so recorded at the first look after resuming.
          await until(() => calls.includes('recordReminder'), 'the overdue reminder');
          expect(calls.indexOf('resolveObligationDispute')).toBeLessThan(
            calls.indexOf('recordReminder'),
          );
          expect(calls).not.toContain('authoriseSettlement');
          await REST.FUNDS_HELD(party);
        },
        { input: NO_RECHECK },
      );
      expect(result).toBe('COMPLETED');
    });

    it('resumes from its own re-read when the decision’s signal was lost', async () => {
      const order = new FakeOrder();
      const { calls, effects, activities } = recordingActivities(order);

      const result = await run(order, activities, async ({ party, held }) => {
        await held();
        await party.confirm();
        await party.dispute('the supplier will not say when');
        await until(() => calls.includes('disputeObligation'), 'the dispute to be mirrored');
        party.silently((o) => o.resolveDispute('SETTLE', 'the supplier gave a date'));
        // No signal: the next scheduled re-read finds it.
        await env.sleep('25 hours');
        await until(() => calls.includes('resolveObligationDispute'), 'the re-read to find it');
        expect(order.status).toBe('CONFIRMED');
        await party.fulfil();
        await party.confirmReceipt();
      });

      expect(result).toBe('COMPLETED');
      expect(effects().filter((e) => e !== 'recordReminder')).toEqual([
        'createObligation',
        'markFundsHeld',
        'disputeObligation',
        'resolveObligationDispute',
        'authoriseSettlement',
        'markSettling',
        'settle',
        'markCompleted',
      ]);
    });

    it('a duplicate decision signal mirrors the decision once', async () => {
      const order = new FakeOrder();
      const { calls, activities, effects } = recordingActivities(order);

      const result = await run(order, activities, async ({ party, held, handle }) => {
        await held();
        await party.dispute('the supplier will not confirm');
        await until(() => calls.includes('disputeObligation'), 'the dispute to be mirrored');
        await party.resolve('SETTLE', 'the supplier has confirmed since');
        await handle.signal('disputeResolved', 'SETTLE');
        await handle.signal('disputeResolved', 'REFUND');
        await until(
          () => calls.includes('resolveObligationDispute'),
          'the decision to be mirrored',
        );
        await REST.FUNDS_HELD(party);
      });

      expect(result).toBe('COMPLETED');
      expect(effects().filter((e) => e === 'resolveObligationDispute')).toHaveLength(1);
      expect(effects().filter((e) => e === 'compensate')).toHaveLength(0);
    });

    it('settled back and disputed again before the saga looked: A is mirrored decided, B disputed, and a refund refunds once', async () => {
      const order = new FakeOrder();
      const mirrored: string[] = [];
      const resolved: string[] = [];
      const { calls, effects, activities } = recordingActivities(order, {
        disputeObligation: async (_o: string, _t: string, disputeId: string) => {
          calls.push('disputeObligation');
          mirrored.push(disputeId);
          return null;
        },
        resolveObligationDispute: async (_o: string, _t: string, disputeId: string) => {
          calls.push('resolveObligationDispute');
          resolved.push(disputeId);
        },
      });

      const result = await run(order, activities, async ({ party, held, handle }) => {
        await held();
        await party.confirm();
        await party.dispute('the supplier sent the wrong model');
        await until(() => mirrored.length === 1, 'A to be mirrored');
        // Both commit before the saga reads the order again.
        party.silently((o) => {
          o.resolveDispute('SETTLE', 'the model was right after all');
          o.raiseDispute('the right model, but the wrong colour');
        });
        await handle.signal('disputeResolved', 'SETTLE');
        await until(() => mirrored.length === 2, 'B to be mirrored');
        expect(resolved).toEqual(['DSP_1']);
        await party.resolve('REFUND', 'the colour was part of the order');
      });

      expect(result).toBe('CANCELLED');
      expect(mirrored).toEqual(['DSP_1', 'DSP_2']);
      expect(resolved).toEqual(['DSP_1', 'DSP_2']);
      expect(effects()).toEqual([
        'createObligation',
        'markFundsHeld',
        'disputeObligation',
        'resolveObligationDispute',
        'disputeObligation',
        'resolveObligationDispute',
        'compensate',
        'markCancelled',
      ]);
    });

    it('repeated dispute and resume cycles, then a cancellation: one refund, no authorisation', async () => {
      const order = new FakeOrder();
      const { calls, effects, activities } = recordingActivities(order);
      const count = (name: string) => calls.filter((c) => c === name).length;

      const result = await run(order, activities, async ({ party, held }) => {
        await held();
        await party.confirm();
        for (let cycle = 1; cycle <= 2; cycle += 1) {
          await party.dispute(`the supplier keeps postponing, round ${cycle}`);
          await until(() => count('disputeObligation') === cycle, `dispute ${cycle} mirrored`);
          await party.resolve('SETTLE', `the supplier gave a new date, round ${cycle}`);
          await until(
            () => count('resolveObligationDispute') === cycle,
            `decision ${cycle} mirrored`,
          );
          expect(order.status).toBe('CONFIRMED');
        }
        await party.cancel('we no longer need the parts');
      });

      expect(result).toBe('CANCELLED');
      expect(effects()).toEqual([
        'createObligation',
        'markFundsHeld',
        'disputeObligation',
        'resolveObligationDispute',
        'disputeObligation',
        'resolveObligationDispute',
        'compensate',
        'markCancelled',
      ]);
    });
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
      const { calls, effects, activities } = recordingActivities(order);

      const result = await run(
        order,
        activities,
        async ({ party, handle, held }) => {
          await held();
          // Waiting, so the commands below land after the read that followed
          // the hold and can only be seen by a re-read.
          await eventually(
            async () =>
              (await handle.query<SagaStatus, []>('status')).phase === 'AWAITING_CONFIRMATION',
            'the saga to wait for the supplier',
          );
          party.silently((o) => o.confirm());
          party.silently((o) => o.fulfil());
          party.silently((o) => o.confirmReceipt());

          // No time skipping. With a one-second recheck the test server's
          // clock simply runs, and the saga's own timer wakes it — the only
          // thing that could, since no signal was sent. Skipping simulated
          // time here stalled on a loaded CI runner: an explicit sleep can
          // wait on the server's skip, which is not this test's subject.
          await until(() => calls.includes('markCompleted'), 'the saga to settle on its re-read');
        },
        // One second. The workflow takes any positive number; only the env
        // schema insists on whole hours, and this is not configuration.
        { input: { recheckIntervalHours: 1 / 3600 } },
      );

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

/**
 * A saga the previous release started, replayed by this one and then run live
 * (review of #625 round 1, R1).
 *
 * A wait entered while replaying a history without `DISPUTE_RESUME_PATCH`'s
 * marker sees `patched()` answer `false`. Decided once, on entry, that answer
 * stayed with the wait after the replay ended: a resumed order kept its
 * economic dispute open, and a dispute wait never noticed a new dispute. The
 * waits now decide at every wake-up, so the first one past the replay
 * reconciles.
 *
 * The previous release is this workflow on a worker whose
 * `patchActivationCallback` leaves the patch inactive: every guarded branch
 * takes its old side and no marker is recorded — the same commands as main's
 * code, which `workflows.replay.spec.ts` proves on main's own histories. Its
 * worker caches nothing, so this release's worker replays the whole history
 * on its first task. Each case ends with the mixed history replayed again,
 * from the start, by this release.
 */
describe('a saga the previous release started, replayed and then run live (#625 r1 R1)', () => {
  let env: TestWorkflowEnvironment;
  let bundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;
  let queues = 0;

  beforeAll(async () => {
    const downloadDir = process.env.TEMPORAL_TEST_SERVER_DIR;
    env = await TestWorkflowEnvironment.createTimeSkipping(
      downloadDir
        ? { server: { executable: { type: 'cached-download', downloadDir, ttl: '30 days' } } }
        : undefined,
    );
    bundle = await bundleWorkflowCode({ workflowsPath: require.resolve('./workflows') });
  }, 300_000);

  afterAll(async () => {
    await env?.teardown();
  });

  type Drive = (ctx: { party: Party; handle: WorkflowHandle }) => Promise<void>;

  /** `previous` on the previous release's worker, then `current` and the rest on this one's. */
  async function upgrade(
    order: FakeOrder,
    activities: OrderActivities,
    previous: Drive,
    current: Drive,
  ): Promise<string> {
    const taskQueue = `upgrade-order-${(queues += 1)}`;
    const handle = await env.client.workflow.start(orderSaga, {
      taskQueue,
      workflowId: `upgrade-${INPUT.orderId}-${Math.trunc(performance.now() * 1000)}`,
      args: [{ ...INPUT, ...NO_RECHECK }],
    });
    const party = new Party(order, handle);
    let finished = false;
    try {
      const old = await Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowBundle: bundle,
        activities,
        maxCachedWorkflows: 0,
        patchActivationCallback: () => false,
      });
      await old.runUntil(
        within(STEP_DEADLINE_MS, previous({ party, handle }), 'the previous release to drive'),
      );
      const fresh = await Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowBundle: bundle,
        activities,
      });
      const result = await fresh.runUntil(async () => {
        await within(STEP_DEADLINE_MS, current({ party, handle }), 'this release to drive');
        return within(STEP_DEADLINE_MS, handle.result(), 'the saga to finish');
      });
      finished = true;
      // The mixed history, replayed from the start by this release.
      await Worker.runReplayHistory(
        { workflowBundle: bundle },
        await handle.fetchHistory(),
        handle.workflowId,
      );
      return result;
    } finally {
      if (!finished) await handle.terminate('test finished').catch(() => undefined);
    }
  }

  type Origin = 'FUNDS_HELD' | 'CONFIRMED' | 'AWAITING_RECEIPT_CONFIRMATION';
  const REACH: Record<Origin, (party: Party) => Promise<void>> = {
    FUNDS_HELD: async () => undefined,
    CONFIRMED: (party) => party.confirm(),
    AWAITING_RECEIPT_CONFIRMATION: async (party) => {
      await party.confirm();
      await party.fulfil();
    },
  };
  const REST: Record<Origin, (party: Party) => Promise<void>> = {
    FUNDS_HELD: async (party) => {
      await party.confirm();
      await party.fulfil();
      await party.confirmReceipt();
    },
    CONFIRMED: async (party) => {
      await party.fulfil();
      await party.confirmReceipt();
    },
    AWAITING_RECEIPT_CONFIRMATION: (party) => party.confirmReceipt(),
  };
  const PHASE: Record<Origin, string> = {
    FUNDS_HELD: 'AWAITING_CONFIRMATION',
    CONFIRMED: 'AWAITING_FULFILMENT',
    AWAITING_RECEIPT_CONFIRMATION: 'AWAITING_RECEIPT_CONFIRMATION',
  };
  const phaseIs = (handle: WorkflowHandle, phase: string) =>
    eventually(
      async () => (await handle.query<SagaStatus, []>('status')).phase === phase,
      `the saga to wait in ${phase}`,
    );

  /** `resolveObligationDispute`, recording which dispute it decided and with what words. */
  function deciding(order: FakeOrder) {
    const decided: [string, string][] = [];
    const recording = recordingActivities(order, {
      resolveObligationDispute: async (
        _orderId: string,
        _transactionId: string,
        disputeId: string,
        resolution: string,
      ) => {
        recording.calls.push('resolveObligationDispute');
        decided.push([disputeId, resolution]);
      },
    } as Partial<OrderActivities>);
    return { ...recording, decided };
  }

  it('a release wait at a live wake-up: no reminder on the read from before the wait (FU-080)', async () => {
    const order = new FakeOrder();
    const { calls, activities } = deciding(order);
    let recovered = false;
    let reminderAt: string | undefined;
    const remind = activities.recordReminder;
    activities.recordReminder = async (...args) => {
      reminderAt = order.status;
      return remind(...args);
    };
    activities.resolveObligationDispute = async () => {
      calls.push('resolveObligationDispute');
      if (!recovered) throw ApplicationFailure.nonRetryable('refused', 'BUSINESS_RULE_VIOLATION');
    };

    const result = await upgrade(
      order,
      activities,
      async ({ party, handle }) => {
        await until(() => order.status !== 'PENDING', 'the hold to be recorded');
        await party.dispute('the parts do not match the offer');
        await until(() => calls.includes('disputeObligation'), 'the dispute to be mirrored');
        await party.resolve('SETTLE', 'the supplier showed the parts match the offer');
        await phaseIs(handle, PHASE.FUNDS_HELD);
        await atRest(handle);
        // Three hours short of the fulfilment window, which the wait below outlasts.
        await env.sleep(`${INPUT.fulfillmentWindowDays * 24 - 3} hours`);
        await atRest(handle);
      },
      async ({ party, handle }) => {
        await handle.signal('orderConfirmed');
        await eventually(
          async () =>
            (await handle.query<SagaStatus, []>('status')).phase === 'RELEASE_UNCONFIRMED',
          'the release wait',
        );
        await until(() => calls.includes('noteReleaseUnconfirmed'), 'the round to be reported');
        await atRest(handle);
        await party.cancel('the buyer changed their mind');
        await atRest(handle);
        await env.sleep('6 hours');
        await atRest(handle);
        recovered = true;
        await handle.signal(retryDisputeRelease);
      },
    );

    expect(result).toBe('CANCELLED');
    expect(reminderAt).toBeUndefined();
  });

  it.each<Origin>(['FUNDS_HELD', 'CONFIRMED', 'AWAITING_RECEIPT_CONFIRMATION'])(
    'resumed at %s under the previous release: the first live wake-up releases the economic dispute',
    async (origin) => {
      const order = new FakeOrder();
      const { calls, effects, activities, decided } = deciding(order);
      let mark = 0;

      const result = await upgrade(
        order,
        activities,
        async ({ party, handle }) => {
          await until(() => order.status !== 'PENDING', 'the hold to be recorded');
          await REACH[origin](party);
          await party.dispute('the parts do not match the offer');
          await until(() => calls.includes('disputeObligation'), 'the dispute to be mirrored');
          await party.resolve('SETTLE', 'the supplier showed the parts match the offer');
          await phaseIs(handle, PHASE[origin]);
          // The previous release waits there with the dispute still open in
          // economic-service.
          expect(order.status).toBe(origin);
          expect(calls).not.toContain('resolveObligationDispute');
        },
        async ({ party, handle }) => {
          mark = calls.length;
          // Any wake-up: a signal about nothing that changed.
          await handle.signal('orderConfirmed');
          await until(
            () => calls.slice(mark).includes('resolveObligationDispute'),
            'the first live wake-up to release the mirrored dispute',
          );
          // Released where the order waits, before anything else happened to it.
          expect(order.status).toBe(origin);
          expect(calls.slice(mark).filter((c) => c !== 'readOrder')).toEqual([
            'resolveObligationDispute',
          ]);
          await REST[origin](party);
        },
      );

      expect(result).toBe('COMPLETED');
      expect(decided).toEqual([['DSP_1', 'the supplier showed the parts match the offer']]);
      expect(effects()).toEqual([
        'createObligation',
        'markFundsHeld',
        'disputeObligation',
        'resolveObligationDispute',
        'authoriseSettlement',
        'markSettling',
        'settle',
        'markCompleted',
      ]);
    },
  );

  it('waiting in a dispute under the previous release: decided and raised again, both are mirrored live', async () => {
    const order = new FakeOrder();
    const { calls, effects, activities, decided } = deciding(order);
    let mark = 0;

    const result = await upgrade(
      order,
      activities,
      async ({ party, handle }) => {
        await until(() => order.status !== 'PENDING', 'the hold to be recorded');
        await party.dispute('the parts do not match the offer');
        await until(() => calls.includes('disputeObligation'), 'the dispute to be mirrored');
        await phaseIs(handle, 'DISPUTED');
        // Between two looks: the operator settles it back and the buyer
        // raises another. The order is DISPUTED throughout.
        party.silently((o) => {
          o.resolveDispute('SETTLE', 'the supplier showed the parts match the offer');
          o.raiseDispute('one part arrived damaged');
        });
      },
      async ({ party, handle }) => {
        mark = calls.length;
        await handle.signal('orderDisputed', 'one part arrived damaged');
        await until(
          () => calls.slice(mark).includes('disputeObligation'),
          'the first live wake-up to notice the new dispute',
        );
        expect(calls.slice(mark).filter((c) => c !== 'readOrder')).toEqual([
          'resolveObligationDispute',
          'disputeObligation',
        ]);
        expect(decided).toEqual([['DSP_1', 'the supplier showed the parts match the offer']]);
        await party.resolve('SETTLE', 'the damage happened after delivery');
        await until(() => decided.length === 2, 'the second decision to be mirrored');
        await REST.FUNDS_HELD(party);
      },
    );

    expect(result).toBe('COMPLETED');
    expect(decided).toEqual([
      ['DSP_1', 'the supplier showed the parts match the offer'],
      ['DSP_2', 'the damage happened after delivery'],
    ]);
    expect(effects()).toEqual([
      'createObligation',
      'markFundsHeld',
      'disputeObligation',
      'resolveObligationDispute',
      'disputeObligation',
      'resolveObligationDispute',
      'authoriseSettlement',
      'markSettling',
      'settle',
      'markCompleted',
    ]);
  });
});
