import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/activity';
import { RastaError } from '@rasta/nest-common';
import type { WorkflowHandle, WorkflowHandleWithFirstExecutionRunId } from '@temporalio/client';
import {
  orderSaga,
  retryDisputeRelease,
  type OrderSagaInput,
  type OutstandingWork,
  type SagaStatus,
} from './workflows';
import { createActivities, type OrderActivities } from './activities';
import { REFUSED_ON_FIRST_ATTEMPT } from './economic-refusal';
import type { EconomicClient } from '../economic/economic.client';
import type { OrderService } from '../order/order.service';

/**
 * Review of #796 round 1, F2 and F3: each probe that printed a failing outcome, as a
 * test. Work the saga still owes outlives every exit, and the owner's terminal status
 * is an answer the order can follow, never an end of the saga or a false cancellation.
 */

jest.setTimeout(120_000);

const INPUT: OrderSagaInput = {
  orderId: 'ORD_OWED',
  fulfillmentWindowDays: 7,
  receiptWindowDays: 3,
  reminderIntervalDays: 3,
  recheckIntervalHours: 24 * 365,
};
const TXN = 'TXN_OWED';
const DISPUTE = { id: 'DSP_1', reason: 'it arrived broken', resolution: null };
const SETTLED = { settlementId: 'STL', commissionAmountMinor: '1', netAmountMinor: '2' };
const final = (status: string, funds: string) => ({ final: true, status, funds });
const refused = (code = 'NOT_FOUND') => ApplicationFailure.nonRetryable('refused', code);
const down = () => ApplicationFailure.retryable('down', 'UPSTREAM_UNAVAILABLE');
const firstAttemptRefusal = (code = 'INVALID_STATE_TRANSITION') =>
  ApplicationFailure.create({
    message: 'refused',
    type: code,
    nonRetryable: true,
    details: [REFUSED_ON_FIRST_ATTEMPT],
  });
const STATUS = (phase: string) => ({
  phase,
  deferredSteps: [],
  remindersRecorded: 0,
  settlementAttempts: 0,
});

interface State {
  status: string;
  economicTransactionId: string | null;
  cancellationReason: string | null;
  dispute: typeof DISPUTE | null;
}
const cancelling = (economicTransactionId: string | null = TXN): Partial<State> => ({
  status: 'CANCELLING',
  cancellationReason: 'changed their mind',
  economicTransactionId,
});
const receipt: Partial<State> = { status: 'RECEIPT_CONFIRMED', economicTransactionId: TXN };
const disputed: Partial<State> = {
  status: 'DISPUTED',
  economicTransactionId: TXN,
  dispute: DISPUTE,
};

/** The `patched()` ids a history records, as the drain gate reads them. */
function markersOf(history: Awaited<ReturnType<WorkflowHandle['fetchHistory']>>): string[] {
  return (history.events ?? []).flatMap((event) => {
    const payload = event.markerRecordedEventAttributes?.details?.['patch-data']?.payloads?.[0];
    if (!payload?.data) return [];
    return [(JSON.parse(Buffer.from(payload.data).toString()) as { id: string }).id];
  });
}

describe('work the saga owes (#796 r1)', () => {
  let env: TestWorkflowEnvironment;
  // One bundle for the file: per test, it took more time than the tests.
  let workflowBundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;
  let queues = 0;

  beforeAll(async () => {
    workflowBundle = await bundleWorkflowCode({ workflowsPath: require.resolve('./workflows') });
    const downloadDir = process.env.TEMPORAL_TEST_SERVER_DIR;
    env = await TestWorkflowEnvironment.createTimeSkipping(
      downloadDir
        ? { server: { executable: { type: 'cached-download', downloadDir, ttl: '30 days' } } }
        : undefined,
    );
  }, 300_000);
  afterAll(async () => {
    await env?.teardown();
  });

  type Fn = (...args: never[]) => unknown;
  /** The saga over a small order row; `acts` replaces whichever activities a test is about. */
  function saga(start: Partial<State>, acts: (state: State) => Record<string, Fn> = () => ({})) {
    const state: State = {
      status: 'PENDING',
      economicTransactionId: null,
      cancellationReason: null,
      dispute: null,
      ...start,
    };
    const calls: string[] = [];
    const sent: Record<string, unknown[][]> = {};
    const rounds: string[] = [];
    const base: Record<string, Fn> = {
      readOrder: () => ({ ...state, dispute: state.status === 'DISPUTED' ? state.dispute : null }),
      findObligation: () => null,
      authoriseSettlement: () => undefined,
      settle: () => SETTLED,
      disputeObligation: () => 'ECON_1',
      resolveObligationDispute: () => undefined,
      compensate: () => undefined,
      recordReminder: () => undefined,
      // As `OrderService.markSettling`: it yields to what got in first.
      markSettling: () =>
        ['DISPUTED', 'CANCELLING'].includes(state.status)
          ? state.status
          : (state.status = 'SETTLING'),
      markSettlementFailed: () => (state.status = 'RECEIPT_CONFIRMED'),
      markObligationDisputed: () => {
        state.status = 'DISPUTED';
        state.dispute = DISPUTE;
        return { status: 'DISPUTED', disputeId: DISPUTE.id, economicDisputeId: 'ECON_1' };
      },
      markCompleted: () => (state.status = 'COMPLETED'),
      markCancelled: () => (state.status = 'CANCELLED'),
      markFundsHeld: () => state.status,
      markFailed: () => state.status,
      createObligation: () => ({ transactionId: TXN }),
      noteReleaseUnconfirmed: () => undefined,
      noteEconomicCallUnconfirmed: () => undefined,
      ...acts(state),
    };
    const activities = Object.fromEntries(
      Object.entries(base).map(([name, fn]) => [
        name,
        async (...args: never[]) => {
          calls.push(name);
          (sent[name] ??= []).push(args);
          if (name === 'noteReleaseUnconfirmed') rounds.push(`release: ${String(args[2])}`);
          if (name === 'noteEconomicCallUnconfirmed') {
            rounds.push(`${String(args[1])}: ${String(args[3])}`);
          }
          return fn(...args);
        },
      ]),
    ) as unknown as OrderActivities;
    return { state, calls, sent, rounds, activities };
  }
  type Saga = ReturnType<typeof saga>;

  /** Starts it, lets `drive` act, terminates whatever is still running. */
  async function drive<T>(
    { activities }: Saga,
    body: (handle: WorkflowHandleWithFirstExecutionRunId, taskQueue: string) => Promise<T>,
    input: Partial<OrderSagaInput> = {},
    worker?: (activities: OrderActivities) => OrderActivities,
  ): Promise<T> {
    const taskQueue = `owed-${(queues += 1)}`;
    const running = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle,
      activities: worker ? worker(activities) : activities,
    });
    return running.runUntil(async () => {
      const handle = await env.client.workflow.start(orderSaga, {
        taskQueue,
        workflowId: taskQueue,
        args: [{ ...INPUT, ...input }],
      });
      const latest = env.client.workflow.getHandle(taskQueue);
      try {
        return await body(handle, taskQueue);
      } finally {
        // Never with an activity in flight: that stalls the test server's clock for the
        // tests after this one.
        await atRest(latest).catch(() => undefined);
        await latest.terminate('test finished').catch(() => undefined);
      }
    });
  }

  async function eventually(predicate: () => boolean | Promise<boolean>, what: string) {
    for (let i = 0; i < 800; i += 1) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${what}`);
  }
  const phase = async (handle: WorkflowHandle) =>
    (await handle.query<SagaStatus, []>('status')).phase;
  const phaseIs = (handle: WorkflowHandle, expected: string) =>
    eventually(async () => (await phase(handle)) === expected, `phase ${expected}`);
  async function atRest(handle: WorkflowHandle) {
    await eventually(async () => {
      if ((await handle.describe()).status.name !== 'RUNNING') return true;
      const last = (await handle.fetchHistory()).events?.at(-1);
      return Boolean(
        last?.timerStartedEventAttributes ??
        last?.timerCanceledEventAttributes ??
        last?.workflowTaskCompletedEventAttributes,
      );
    }, 'the saga to come to rest');
  }
  /** Rounds, each one woken, until the wait has rolled over; the handle of the run after it. */
  async function rolled(
    handle: WorkflowHandleWithFirstExecutionRunId,
    id: string,
  ): Promise<WorkflowHandle> {
    const latest = env.client.workflow.getHandle(id);
    for (let i = 0; i < 40; i += 1) {
      if ((await latest.describe()).runId !== handle.firstExecutionRunId) return latest;
      await atRest(latest);
      await latest.signal(retryDisputeRelease);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('The wait did not roll over');
  }
  /** Lets `change` land while the saga waits, and wakes it. */
  async function retry(handle: WorkflowHandle, change: () => void = () => undefined) {
    await atRest(handle);
    change();
    await handle.signal(retryDisputeRelease);
  }
  const reported = (s: Saga, count = 1) =>
    eventually(() => s.rounds.length >= count, `${count} reported round(s)`);
  const stays = async (s: Saga, handle: WorkflowHandle, expected: string) => {
    await reported(s);
    await phaseIs(handle, expected);
    const { status } = await handle.describe();
    expect(status.name).toBe('RUNNING');
  };

  describe('F2: the lookup of a cancellation', () => {
    it('FORBIDDEN stays, refunds once it is answered, and only then cancels', async () => {
      let answer: (() => unknown) | undefined;
      const s = saga(cancelling(null), () => ({
        findObligation: () => {
          if (answer) return answer();
          throw refused('FORBIDDEN');
        },
      }));
      const result = await drive(s, async (handle) => {
        await stays(s, handle, 'COMPENSATION_UNCONFIRMED');
        expect(s.calls).not.toContain('compensate');
        expect(s.calls).not.toContain('markCancelled');
        await retry(handle, () => {
          answer = () => ({ transactionId: 'TXN_FOUND' });
        });
        return handle.result();
      });
      expect(result).toBe('CANCELLED');
      expect(s.sent.compensate?.[0]?.[1]).toBe('TXN_FOUND');
      expect(s.calls.indexOf('compensate')).toBeLessThan(s.calls.indexOf('markCancelled'));
    });

    it('an incomplete list is no answer either', async () => {
      const s = saga(cancelling(null), () => ({
        findObligation: () => {
          throw refused('OBLIGATION_LOOKUP_INCOMPLETE');
        },
      }));
      await drive(s, (handle) => stays(s, handle, 'COMPENSATION_UNCONFIRMED'));
      expect(s.calls).not.toContain('markCancelled');
    });

    it('refused, then finding the obligation refunded: closes, unrefunded', async () => {
      let answer: (() => unknown) | undefined;
      const s = saga(cancelling(null), () => ({
        findObligation: () => {
          if (answer) return answer();
          throw refused('FORBIDDEN');
        },
      }));
      const result = await drive(s, async (handle) => {
        await stays(s, handle, 'COMPENSATION_UNCONFIRMED');
        await retry(handle, () => {
          answer = () => ({
            notHeld: true,
            transactionId: 'T',
            status: 'REFUNDED',
            funds: 'RETURNED',
          });
        });
        return handle.result();
      });
      expect(result).toBe('CANCELLED');
      expect(s.calls).not.toContain('compensate');
      // Answered at once, not by a rollover asking again.
      expect(s.rounds).toHaveLength(1);
    });

    it('other terms: stays with nothing refunded and nothing cancelled', async () => {
      const s = saga(cancelling(null), () => ({
        findObligation: () => ({ mismatch: true, transactionIds: ['T'], differ: ['amount'] }),
      }));
      await drive(s, (handle) => stays(s, handle, 'OBLIGATION_MISMATCH'));
      expect(s.calls).not.toContain('compensate');
      expect(s.calls).not.toContain('markCancelled');
    });

    it.each([
      ['REFUNDED', 'RETURNED'],
      ['CANCELLED', 'NEVER_HELD'],
      ['FAILED', 'NEVER_HELD'],
    ])('its own obligation %s (funds %s) closes the order, unrefunded', async (status, funds) => {
      const s = saga(cancelling(null), () => ({
        findObligation: () => ({ notHeld: true, transactionId: 'T', status, funds }),
      }));
      await expect(drive(s, (handle) => handle.result())).resolves.toBe('CANCELLED');
      expect(s.calls).not.toContain('compensate');
      expect(s.calls).toContain('markCancelled');
      expect(s.rounds).toEqual([]);
    });

    it.each([
      ['SETTLED', 'PAID_OUT'],
      ['PENDING_SETTLEMENT', 'UNPROVEN'],
      ['DISPUTED', 'UNPROVEN'],
      ['CREATED', 'NEVER_HELD'],
    ])('its own obligation %s (funds %s) never cancels the order', async (status, funds) => {
      const s = saga(cancelling(null), () => ({
        findObligation: () => ({ notHeld: true, transactionId: 'T', status, funds }),
      }));
      await drive(s, (handle) => stays(s, handle, 'OBLIGATION_NOT_HELD'));
      expect(s.calls).not.toContain('compensate');
      expect(s.calls).not.toContain('markCancelled');
    });
  });

  describe('F2: an empty lookup is not proof', () => {
    const resumedAt = (work?: OutstandingWork): Partial<OrderSagaInput> => ({
      resume: {
        status: STATUS('COMPENSATING'),
        waitingIn: 'CANCELLING',
        activitySequence: 5,
        ...(work ? { outstandingWork: work } : {}),
      },
    });

    it('a saga that never sent a hold may close on it', async () => {
      const s = saga(cancelling(null));
      await expect(drive(s, (handle) => handle.result())).resolves.toBe('CANCELLED');
      expect(s.calls).not.toContain('createObligation');
    });

    it('a hold left unanswered gives the next run no proof', async () => {
      let refusing = true;
      let lookups = 0;
      const s = saga({ status: 'PENDING' }, (state) => ({
        createObligation: () => {
          state.status = 'CANCELLING';
          state.cancellationReason = 'changed their mind';
          throw refused('UPSTREAM_UNAVAILABLE');
        },
        findObligation: () => {
          lookups += 1;
          if (lookups > 1 && refusing) throw refused('FORBIDDEN');
          return null;
        },
      }));
      await drive(
        s,
        async (handle, id) => {
          const latest = await rolled(handle, id);
          await atRest(latest);
          refusing = false;
          await latest.signal(retryDisputeRelease);
          await eventually(
            () => s.rounds.some((round) => round.includes('does not show')),
            'the empty lookup to be refused',
          );
          expect(s.calls).not.toContain('markCancelled');
        },
        { historyEventThreshold: 32 },
      );
    });

    it('a continued run with no proof of its hold does not close on it', async () => {
      const s = saga(cancelling(null));
      await drive(s, (handle) => stays(s, handle, 'COMPENSATION_UNCONFIRMED'), resumedAt());
      expect(s.rounds[0]).toContain('does not show');
      expect(s.calls).not.toContain('markCancelled');
    });

    it('a continued run told no hold is out there closes on it', async () => {
      const s = saga(cancelling(null));
      await expect(
        drive(
          s,
          (handle) => handle.result(),
          resumedAt({ operation: 'compensate', rounds: 1, noHold: true }),
        ),
      ).resolves.toBe('CANCELLED');
    });

    it('the proof survives a rollover of the lookup’s wait', async () => {
      let answered = false;
      const s = saga(cancelling(null), () => ({
        findObligation: () => {
          if (!answered) throw refused('FORBIDDEN');
          return null;
        },
      }));
      const result = await drive(
        s,
        async (handle, id) => {
          const latest = await rolled(handle, id);
          const history = await latest.fetchHistory();
          const started = history.events?.[0]?.workflowExecutionStartedEventAttributes;
          const data = started?.input?.payloads?.[0]?.data as Uint8Array;
          const { resume } = JSON.parse(Buffer.from(data).toString()) as OrderSagaInput;
          expect(resume?.outstandingWork).toMatchObject({ operation: 'compensate', noHold: true });
          await retry(latest, () => {
            answered = true;
          });
          return latest.result();
        },
        { historyEventThreshold: 32 },
      );
      expect(result).toBe('CANCELLED');
    });

    it('nor does a refused read of the next run lose that work', async () => {
      let refusing = true;
      const s = saga(cancelling(null), (state) => ({
        readOrder: () => {
          if (refusing) throw refused('NOT_FOUND');
          return { ...state };
        },
      }));
      const result = await drive(
        s,
        async (handle) => {
          await stays(s, handle, 'COMPENSATION_UNCONFIRMED');
          await retry(handle, () => {
            refusing = false;
          });
          return handle.result();
        },
        resumedAt({ operation: 'compensate', rounds: 1, noHold: true }),
      );
      expect(result).toBe('CANCELLED');
    });
  });

  describe('F2: an unconfirmed settlement', () => {
    const settleFailsThenDisputed = (state: State): Record<string, Fn> => ({
      settle: () => {
        throw down();
      },
      markSettlementFailed: () => {
        state.status = 'DISPUTED';
        state.dispute = DISPUTE;
        return 'RECEIPT_CONFIRMED';
      },
    });

    it('the filing after it goes in doubt, and a first-attempt refusal stays', async () => {
      let filed = false;
      const s = saga(receipt, (state) => ({
        ...settleFailsThenDisputed(state),
        disputeObligation: () => {
          if (!filed) throw firstAttemptRefusal();
          return 'ECON_1';
        },
      }));
      await drive(s, async (handle) => {
        // The backoff between settlement attempts.
        await env.sleep('1 minute');
        await stays(s, handle, 'DISPUTE_UNCONFIRMED');
        expect(s.sent.disputeObligation?.[0]?.[4]).toBe(true);
        await retry(handle, () => {
          filed = true;
        });
        await phaseIs(handle, 'DISPUTED');
      });
    });

    it('the refund after it goes in doubt', async () => {
      const s = saga(receipt, (state) => ({
        settle: () => {
          throw down();
        },
        markSettlementFailed: () => {
          state.status = 'CANCELLING';
          state.cancellationReason = 'decided for the buyer';
          return 'RECEIPT_CONFIRMED';
        },
      }));
      await expect(drive(s, (handle) => handle.result())).resolves.toBe('CANCELLED');
      expect(s.sent.compensate?.[0]?.[3]).toBe(true);
    });

    it('the doubt goes across a rollover, to the authorisation sent next', async () => {
      const s = saga(receipt);
      await expect(
        drive(s, (handle) => handle.result(), {
          resume: {
            status: STATUS('SETTLING'),
            waitingIn: 'RECEIPT_CONFIRMED',
            activitySequence: 5,
            outstandingWork: { operation: 'settle', rounds: 1 },
          },
        }),
      ).resolves.toBe('COMPLETED');
      expect(s.sent.authoriseSettlement?.[0]?.[2]).toBe(true);
    });

    it('a first-attempt refusal of that authorisation stays too', async () => {
      let refusing = true;
      const s = saga(receipt, () => ({
        authoriseSettlement: () => {
          if (refusing) throw firstAttemptRefusal();
        },
      }));
      const result = await drive(
        s,
        async (handle) => {
          await stays(s, handle, 'AUTHORISATION_UNCONFIRMED');
          await retry(handle, () => {
            refusing = false;
          });
          return handle.result();
        },
        {
          resume: {
            status: STATUS('SETTLING'),
            waitingIn: 'RECEIPT_CONFIRMED',
            activitySequence: 5,
            outstandingWork: { operation: 'settle', rounds: 1 },
          },
        },
      );
      expect(result).toBe('COMPLETED');
    });

    it('a settlement that never failed sends the authorisation as new', async () => {
      const s = saga(receipt);
      await expect(drive(s, (handle) => handle.result())).resolves.toBe('COMPLETED');
      expect(s.sent.authoriseSettlement?.[0]?.[2]).toBeUndefined();
      expect(s.rounds).toEqual([]);
    });

    it('five failed attempts still end for a human, as docs/08 § 8.4 says', async () => {
      const s = saga(receipt, () => ({
        settle: () => {
          throw refused('BUSINESS_RULE_VIOLATION');
        },
      }));
      await expect(drive(s, (handle) => handle.result())).rejects.toMatchObject({
        cause: { type: 'SETTLEMENT_EXHAUSTED' },
      });
    });
  });

  describe('F2: a refused read with work owed', () => {
    it('after a successful filing: stays, and the decision is still released', async () => {
      let refusing = false;
      const s = saga(disputed, (state) => ({
        readOrder: () => {
          if (refusing) throw refused('NOT_FOUND');
          return { ...state };
        },
      }));
      const result = await drive(s, async (handle) => {
        await phaseIs(handle, 'DISPUTED');
        await atRest(handle);
        refusing = true;
        await handle.signal('orderDisputed', 'look');
        await stays(s, handle, 'RELEASE_UNCONFIRMED');
        await retry(handle, () => {
          refusing = false;
          s.state.status = 'CANCELLING';
          s.state.cancellationReason = 'decided for the buyer';
        });
        return handle.result();
      });
      expect(result).toBe('CANCELLED');
      expect(s.calls.filter((c) => c === 'resolveObligationDispute')).toHaveLength(1);
    });

    it('on a resumed release wait: stays, and the release goes on', async () => {
      let refusing = true;
      const s = saga(cancelling(), (state) => ({
        readOrder: () => {
          if (refusing) throw refused('NOT_FOUND');
          return { ...state };
        },
      }));
      const result = await drive(
        s,
        async (handle) => {
          await stays(s, handle, 'RELEASE_UNCONFIRMED');
          await retry(handle, () => {
            refusing = false;
          });
          return handle.result();
        },
        {
          resume: {
            status: STATUS('COMPENSATING'),
            mirroredDispute: 'DSP_1',
            waitingIn: 'CANCELLING',
            activitySequence: 5,
            releaseRounds: 2,
          },
        },
      );
      expect(result).toBe('CANCELLED');
      expect(s.sent.resolveObligationDispute).toHaveLength(1);
    });

    it('a first read, with nothing sent, still ends as it always did', async () => {
      const s = saga({ status: 'FUNDS_HELD', economicTransactionId: TXN }, () => ({
        readOrder: () => {
          throw refused('NOT_FOUND');
        },
      }));
      await expect(drive(s, (handle) => handle.result())).rejects.toMatchObject({
        cause: { cause: { type: 'NOT_FOUND' } },
      });
      expect(s.rounds).toEqual([]);
    });

    it('past it, the buyer cancelling at FUNDS_HELD still gets the refund', async () => {
      let refusing = false;
      const s = saga({ status: 'FUNDS_HELD', economicTransactionId: TXN }, (state) => ({
        readOrder: () => {
          if (refusing) throw refused('NOT_FOUND');
          return { ...state };
        },
      }));
      const result = await drive(s, async (handle) => {
        await eventually(() => s.calls.includes('readOrder'), 'the first read');
        await atRest(handle);
        refusing = true;
        s.state.status = 'CANCELLING';
        s.state.cancellationReason = 'changed their mind';
        await handle.signal('orderCancelled', 'look');
        await stays(s, handle, 'ORDER_UNREADABLE');
        expect(s.rounds[0]).toContain('readOrder: NOT_FOUND');
        expect(s.calls).not.toContain('compensate');
        await retry(handle, () => {
          refusing = false;
        });
        return handle.result();
      });
      expect(result).toBe('CANCELLED');
      expect(s.calls.indexOf('compensate')).toBeLessThan(s.calls.indexOf('markCancelled'));
    });

    it('a run continued with nothing owed waits on its first read too', async () => {
      let refusing = true;
      const s = saga(cancelling(), (state) => ({
        readOrder: () => {
          if (refusing) throw refused('NOT_FOUND');
          return { ...state };
        },
      }));
      const result = await drive(
        s,
        async (handle) => {
          await stays(s, handle, 'ORDER_UNREADABLE');
          await retry(handle, () => {
            refusing = false;
          });
          return handle.result();
        },
        { resume: { status: STATUS('X'), waitingIn: 'FUNDS_HELD', activitySequence: 5 } },
      );
      expect(result).toBe('CANCELLED');
    });
  });

  describe('F2: a local step', () => {
    it('a refused reminder with an authorisation moved on keeps the saga, and the doubt', async () => {
      let refusing = true;
      const s = saga({ status: 'FUNDS_HELD', economicTransactionId: TXN }, () => ({
        recordReminder: () => {
          if (refusing) throw refused('NOT_FOUND');
        },
      }));
      await drive(
        s,
        async (handle) => {
          await env.sleep(`${INPUT.fulfillmentWindowDays + 1} days`);
          await reported(s);
          expect(s.rounds[0]).toContain('authoriseSettlement: recordReminder: NOT_FOUND');
          const before = (await handle.query<SagaStatus, []>('status')).remindersRecorded;
          expect(before).toBe(0);
          await atRest(handle);
          refusing = false;
          await env.sleep(`${INPUT.reminderIntervalDays + 1} days`);
          await eventually(
            async () => (await handle.query<SagaStatus, []>('status')).remindersRecorded === 1,
            'the next window’s reminder',
          );
          expect((await handle.describe()).status.name).toBe('RUNNING');
        },
        {
          resume: {
            status: STATUS('AWAITING_CONFIRMATION'),
            waitingIn: 'FUNDS_HELD',
            activitySequence: 5,
            unconfirmedCall: { operation: 'authoriseSettlement', rounds: 1, movedOn: true },
          },
        },
      );
    });

    it('a refused reminder with nothing owed keeps the saga too', async () => {
      const s = saga({ status: 'FUNDS_HELD', economicTransactionId: TXN }, () => ({
        recordReminder: () => {
          throw refused('NOT_FOUND');
        },
      }));
      await drive(s, async (handle) => {
        await env.sleep(`${INPUT.fulfillmentWindowDays + 1} days`);
        await reported(s);
        expect(s.rounds[0]).toContain('readOrder: recordReminder: NOT_FOUND');
        expect((await handle.describe()).status.name).toBe('RUNNING');
      });
    });

    it.each(['markSettling', 'markCompleted'])(
      '%s refused: stays, then completes',
      async (step) => {
        let refusing = true;
        const s = saga(receipt, (state) => ({
          [step]: () => {
            if (refusing) throw refused('BUSINESS_RULE_VIOLATION');
            return step === 'markSettling'
              ? (state.status = 'SETTLING')
              : (state.status = 'COMPLETED');
          },
        }));
        const result = await drive(s, async (handle) => {
          await stays(s, handle, 'SETTLEMENT_NOT_RECORDED');
          expect(s.rounds[0]).toContain(`${step}: BUSINESS_RULE_VIOLATION`);
          await retry(handle, () => {
            refusing = false;
          });
          return handle.result();
        });
        expect(result).toBe('COMPLETED');
      },
    );

    it('markCompleted refused across a rollover: the money is not lost to the catch', async () => {
      let refusing = true;
      const s = saga(receipt, (state) => ({
        markCompleted: () => {
          if (refusing) throw refused('BUSINESS_RULE_VIOLATION');
          return (state.status = 'COMPLETED');
        },
      }));
      const result = await drive(
        s,
        async (handle, id) => {
          const latest = await rolled(handle, id);
          await retry(latest, () => {
            refusing = false;
          });
          return latest.result();
        },
        { historyEventThreshold: 32 },
      );
      expect(result).toBe('COMPLETED');
    });

    it('markSettlementFailed refused: stays, and goes on to the next attempt', async () => {
      let refusing = true;
      let settles = 0;
      const s = saga(receipt, (state) => ({
        settle: () => {
          settles += 1;
          if (settles === 1) throw refused('UPSTREAM_UNAVAILABLE');
          return SETTLED;
        },
        markSettlementFailed: () => {
          if (refusing) throw refused('BUSINESS_RULE_VIOLATION');
          return (state.status = 'RECEIPT_CONFIRMED');
        },
      }));
      const result = await drive(s, async (handle) => {
        await stays(s, handle, 'SETTLEMENT_NOT_RECORDED');
        await retry(handle, () => {
          refusing = false;
        });
        return handle.result();
      });
      expect(result).toBe('COMPLETED');
    });

    it('markObligationDisputed refused: stays, then takes the dispute', async () => {
      let refusing = true;
      const s = saga(receipt, (state) => ({
        settle: () => ({ disputed: true, reason: 'theirs', economicDisputeId: 'E' }),
        markObligationDisputed: () => {
          if (refusing) throw refused('BUSINESS_RULE_VIOLATION');
          state.status = 'DISPUTED';
          state.dispute = DISPUTE;
          return { status: 'DISPUTED', disputeId: DISPUTE.id, economicDisputeId: 'E' };
        },
      }));
      await drive(s, async (handle) => {
        await stays(s, handle, 'SETTLEMENT_NOT_RECORDED');
        await retry(handle, () => {
          refusing = false;
        });
        await phaseIs(handle, 'DISPUTED');
      });
      expect(s.calls).not.toContain('disputeObligation');
    });
  });

  describe('F3: the owner’s terminal status', () => {
    it('a filing in doubt, a refund landing meanwhile: the cancellation finishes', async () => {
      // The activities as they really answer, over the owner the review probed.
      const owner = { status: 'HELD' };
      const economic = {
        dispute: async () => {
          throw RastaError.upstreamUnavailable('economic-service');
        },
        refund: async () => {
          throw new RastaError('INVALID_STATE_TRANSITION', 'refused for its state');
        },
        readObligation: async () => ({ status: owner.status }),
      };
      const real = createActivities({
        orders: {
          describe: async () => ({
            id: INPUT.orderId,
            buyerOrganizationId: 'ORG',
            correlationId: 'COR',
          }),
          onceForSaga: (_o: unknown, _s: unknown, _a: unknown, call: () => unknown) => call(),
        } as unknown as OrderService,
        economic: economic as unknown as EconomicClient,
        currentStep: () => ({ key: 'K', scheduledAt: new Date(0) }),
        currentAttempt: () => 1,
      });
      const s = saga(disputed);
      const result = await drive(
        s,
        async (handle) => {
          await stays(s, handle, 'DISPUTE_UNCONFIRMED');
          await retry(handle, () => {
            owner.status = 'REFUNDED';
            s.state.status = 'CANCELLING';
            s.state.cancellationReason = 'decided for the buyer';
          });
          return handle.result();
        },
        {},
        (recording) => ({
          ...recording,
          disputeObligation: real.disputeObligation,
          compensate: real.compensate,
        }),
      );
      expect(result).toBe('CANCELLED');
      expect(s.calls.filter((c) => c === 'markCancelled')).toHaveLength(1);
      expect(s.calls).not.toContain('resolveObligationDispute');
      // The order already says what to do: nothing for a person, no round on the alert.
      expect(s.rounds.join()).not.toContain('OBLIGATION_ALREADY_FINAL');
    });

    it.each([
      ['CANCELLED', 'NEVER_HELD'],
      ['FAILED', 'NEVER_HELD'],
    ])(
      'a refund told %s has nothing to return: the cancellation finishes',
      async (status, funds) => {
        const s = saga(cancelling(), () => ({ compensate: () => final(status, funds) }));
        await expect(drive(s, (handle) => handle.result())).resolves.toBe('CANCELLED');
        expect(s.calls).toContain('markCancelled');
      },
    );

    it('a refund told SETTLED: reconciliation, never a false cancellation', async () => {
      const s = saga(cancelling(), () => ({ compensate: () => final('SETTLED', 'PAID_OUT') }));
      const result = await drive(s, async (handle) => {
        await stays(s, handle, 'OBLIGATION_RECONCILIATION');
        // What tells the drain gate a lower build cannot read this answer.
        expect(markersOf(await handle.fetchHistory())).toContain('saga-owed-work-durable-v1');
        expect(s.rounds[0]).toContain('SETTLED');
        expect(s.rounds[0]).toContain('PAID_OUT');
        await retry(handle);
        await reported(s, 2);
        expect(s.calls).not.toContain('markCancelled');
        // A person put the order right.
        const before = s.rounds.length;
        await retry(handle, () => {
          s.state.status = 'CANCELLED';
        });
        const ended = await handle.result();
        // Seen at the next round, not only after a rollover reads the order afresh.
        expect(s.rounds.length).toBeLessThanOrEqual(before + 1);
        return ended;
      });
      expect(result).toBe('CANCELLED');
      expect(s.calls).not.toContain('markCancelled');
    });

    it('an unknown funds word is for a person too', async () => {
      const s = saga(cancelling(), () => ({ compensate: () => final('REVERSED', 'UNPROVEN') }));
      await drive(s, (handle) => stays(s, handle, 'OBLIGATION_RECONCILIATION'));
      expect(s.calls).not.toContain('markCancelled');
    });

    it('reconciliation rolls over, and the next run asks the owner again', async () => {
      const s = saga(cancelling(), () => ({ compensate: () => final('SETTLED', 'PAID_OUT') }));
      await drive(
        s,
        async (handle, id) => {
          // After the first run has asked, or its own call would look like the next run's.
          await reported(s);
          const asked = s.calls.filter((c) => c === 'compensate').length;
          const latest = await rolled(handle, id);
          await eventually(
            () => s.calls.filter((c) => c === 'compensate').length > asked,
            'the next run to ask the owner',
          );
          await phaseIs(latest, 'OBLIGATION_RECONCILIATION');
          expect(s.calls).not.toContain('markCancelled');
          expect(s.sent.compensate?.at(-1)?.[3]).toBe(true);
        },
        { historyEventThreshold: 32 },
      );
    });

    it('a filing told final with the order still disputed: the operator decides', async () => {
      const s = saga(disputed, () => ({
        disputeObligation: () => final('REFUNDED', 'RETURNED'),
      }));
      const result = await drive(s, async (handle) => {
        await stays(s, handle, 'OBLIGATION_RECONCILIATION');
        await retry(handle, () => {
          s.state.status = 'CANCELLING';
          s.state.cancellationReason = 'decided for the buyer';
          s.state.dispute = null;
        });
        return handle.result();
      });
      expect(result).toBe('CANCELLED');
      // Nothing was filed, so nothing is released.
      expect(s.calls).not.toContain('resolveObligationDispute');
    });

    it('a filing told final, another dispute raised meanwhile: that one is filed too', async () => {
      const s = saga(disputed, () => ({
        disputeObligation: () => final('REFUNDED', 'RETURNED'),
      }));
      await drive(s, async (handle) => {
        await stays(s, handle, 'OBLIGATION_RECONCILIATION');
        await retry(handle, () => {
          s.state.dispute = { ...DISPUTE, id: 'DSP_2' };
        });
        await eventually(
          () => s.sent.disputeObligation?.at(-1)?.[2] === ('DSP_2' as never),
          'the second filing',
        );
        await phaseIs(handle, 'OBLIGATION_RECONCILIATION');
      });
    });

    it('a mirrored dispute released into a refund: the cancellation finishes', async () => {
      const s = saga(cancelling(), () => ({
        resolveObligationDispute: () => final('REFUNDED', 'RETURNED'),
      }));
      await expect(
        drive(s, (handle) => handle.result(), {
          resume: {
            status: STATUS('COMPENSATING'),
            mirroredDispute: 'DSP_1',
            waitingIn: 'CANCELLING',
            activitySequence: 5,
          },
        }),
      ).resolves.toBe('CANCELLED');
      expect(s.calls).toContain('markCancelled');
    });

    it('an authorisation told final: reconciliation, no settling', async () => {
      const s = saga(receipt, () => ({
        authoriseSettlement: () => final('REFUNDED', 'RETURNED'),
      }));
      await drive(s, (handle) => stays(s, handle, 'OBLIGATION_RECONCILIATION'));
      expect(s.calls).not.toContain('markSettling');
      expect(s.calls).not.toContain('markCompleted');
    });

    it('an authorisation told final follows a dispute raised meanwhile', async () => {
      const s = saga(receipt, () => ({
        authoriseSettlement: () => final('REFUNDED', 'RETURNED'),
        disputeObligation: () => final('REFUNDED', 'RETURNED'),
      }));
      await drive(s, async (handle) => {
        await stays(s, handle, 'OBLIGATION_RECONCILIATION');
        await atRest(handle);
        s.state.status = 'DISPUTED';
        s.state.dispute = DISPUTE;
        await handle.signal('orderDisputed', 'look');
        await eventually(() => s.calls.includes('disputeObligation'), 'the filing');
        await phaseIs(handle, 'OBLIGATION_RECONCILIATION');
      });
    });
  });

  describe('F3: markCancelled', () => {
    it('refused after the refund: stays, and finishes once, without a second effect', async () => {
      let refusing = true;
      const s = saga(cancelling(), (state) => ({
        markCancelled: () => {
          if (refusing) throw refused('BUSINESS_RULE_VIOLATION');
          return (state.status = 'CANCELLED');
        },
      }));
      const result = await drive(s, async (handle) => {
        await stays(s, handle, 'CANCELLATION_NOT_RECORDED');
        expect(s.rounds[0]).toContain('markCancelled: BUSINESS_RULE_VIOLATION');
        await retry(handle, () => {
          refusing = false;
        });
        return handle.result();
      });
      expect(result).toBe('CANCELLED');
      expect(s.state.status).toBe('CANCELLED');
      expect(s.calls.filter((c) => c === 'compensate')).toHaveLength(1);
    });

    it('refused with nothing to refund stays too, across a rollover', async () => {
      let refusing = true;
      const s = saga(cancelling(null), (state) => ({
        markCancelled: () => {
          if (refusing) throw refused('BUSINESS_RULE_VIOLATION');
          return (state.status = 'CANCELLED');
        },
      }));
      const result = await drive(
        s,
        async (handle, id) => {
          const latest = await rolled(handle, id);
          await retry(latest, () => {
            refusing = false;
          });
          return latest.result();
        },
        { historyEventThreshold: 32 },
      );
      expect(result).toBe('CANCELLED');
      expect(s.calls).not.toContain('compensate');
    });
  });
});
