import { TestWorkflowEnvironment } from '@temporalio/testing';
import { createTemporalTestEnvironment } from '../../test/temporal-environment';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/activity';
import type { WorkflowHandle, WorkflowHandleWithFirstExecutionRunId } from '@temporalio/client';
import {
  HOLD_FENCE_PATCH,
  HOLD_REFUSAL_EXIT_PATCH,
  HOLD_WAIT_PATCH,
  orderSaga,
  retryDisputeRelease,
  type OrderSagaInput,
  type SagaResume,
  type SagaStatus,
} from './workflows';
import type { OrderActivities } from './activities';
import {
  FINAL_ANSWER_CONTRACT,
  doubtOutlivesKeyMs,
  HOLD_DEADLINE_PASSED,
  HOLD_FENCE,
  holdDeadlineFrom,
  REFUSED_ON_FIRST_ATTEMPT,
  REFUSED_PAST_HOLD_DEADLINE,
  sentPastHoldFence,
} from './economic-refusal';

/**
 * Review of #812: after one 5xx, a refusal that persists kept the saga waiting for
 * good, the order CANCELLING and its stock reserved. The exit (D-132): every request
 * carries the deadline its first send fixed, economic-service refuses past it (its own
 * specs), and only that refusal, to a request sent past the deadline and its margin,
 * with an empty lookup after it, ends the wait. The saga stays one margin more.
 */

jest.setTimeout(120_000);

/** From the first send to the first request whose refusal counts. */
const LIMIT_MS = HOLD_FENCE.sendWindowMs + HOLD_FENCE.clockMarginMs;
const INPUT: OrderSagaInput = {
  orderId: 'ORD_EXIT',
  fulfillmentWindowDays: 7,
  receiptWindowDays: 3,
  reminderIntervalDays: 3,
  recheckIntervalHours: 24 * 365,
};
const TXN = 'TXN_LATE';
/** A step answered with nothing about the money: every 5xx, reset and timeout. */
const gone = () => ApplicationFailure.nonRetryable('gateway', 'UPSTREAM_UNAVAILABLE');
const marked = (code = 'INSUFFICIENT_BALANCE') =>
  ApplicationFailure.create({
    message: 'Insufficient balance',
    type: code,
    nonRetryable: true,
    details: [REFUSED_ON_FIRST_ATTEMPT],
  });
const FENCE_WORDS = 'The deadline for placing this hold has passed';
/** The key's own answer past the deadline, as the activity marks it on any attempt. */
const fenced = () =>
  ApplicationFailure.create({
    message: FENCE_WORDS,
    type: HOLD_DEADLINE_PASSED,
    nonRetryable: true,
    details: [REFUSED_PAST_HOLD_DEADLINE],
  });
const STATUS = {
  phase: 'WAS',
  deferredSteps: [],
  remindersRecorded: 0,
  settlementAttempts: 0,
};

interface State {
  status: string;
  economicTransactionId: string | null;
  cancellationReason: string | null;
  dispute: null;
}

type Fn = (...args: never[]) => unknown;
type History = Awaited<ReturnType<WorkflowHandle['fetchHistory']>>;

function markersOf(history: History): string[] {
  return (history.events ?? []).flatMap((event) => {
    const payload = event.markerRecordedEventAttributes?.details?.['patch-data']?.payloads?.[0];
    if (!payload?.data) return [];
    return [(JSON.parse(Buffer.from(payload.data).toString()) as { id: string }).id];
  });
}

/** When the history scheduled `activity`, each time. */
function scheduledAt(history: History, activity: string): number[] {
  return (history.events ?? []).flatMap((event) => {
    const type = event.activityTaskScheduledEventAttributes?.activityType?.name;
    if (type !== activity) return [];
    const { seconds, nanos } = event.eventTime as { seconds: unknown; nanos?: number | null };
    return [Number(seconds) * 1000 + Math.trunc((nanos ?? 0) / 1e6)];
  });
}

describe('a hold refused after a lost answer (#812)', () => {
  let env: TestWorkflowEnvironment;
  let workflowBundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;
  let queues = 0;

  beforeAll(async () => {
    workflowBundle = await bundleWorkflowCode({ workflowsPath: require.resolve('./workflows') });
    env = await createTemporalTestEnvironment();
  }, 300_000);
  afterAll(async () => {
    await env?.teardown();
  });

  /** What an empty wallet's economic-service says: its refusal, and past the deadline the fence's. */
  const refusalTo = async (holdNotAfter?: string) =>
    holdNotAfter !== undefined && (await env.currentTimeMs()) > Date.parse(holdNotAfter)
      ? fenced()
      : marked();

  /** The saga over a small order row; each `acts` replaces an activity. */
  function saga(acts: (state: State, s: { rounds: string[] }) => Record<string, Fn> = () => ({})) {
    const state: State = {
      status: 'PENDING',
      economicTransactionId: null,
      cancellationReason: null,
      dispute: null,
    };
    const calls: string[] = [];
    const sent: Record<string, unknown[][]> = {};
    const rounds: string[] = [];
    const base: Record<string, Fn> = {
      readOrder: () => ({ ...state }),
      // Once a 5xx, then the refusal, every round.
      createObligation: (() => {
        let sends = 0;
        return async (_id: string, holdNotAfter?: string) => {
          sends += 1;
          throw sends === 1 ? gone() : await refusalTo(holdNotAfter);
        };
      })(),
      findObligation: () => null,
      compensate: () => undefined,
      markFundsHeld: (_id: string, transactionId: string) => {
        state.economicTransactionId = transactionId;
        if (state.status === 'PENDING') state.status = 'FUNDS_HELD';
        return state.status;
      },
      // As `OrderService.markFailed`: from PENDING, yielding to a cancellation.
      markFailed: () => {
        if (state.status === 'PENDING') state.status = 'FAILED';
        return state.status;
      },
      markCancelled: () => (state.status = 'CANCELLED'),
      recordReminder: () => undefined,
      noteReleaseUnconfirmed: () => undefined,
      noteEconomicCallUnconfirmed: () => undefined,
      ...acts(state, { rounds }),
    };
    const activities = Object.fromEntries(
      Object.entries(base).map(([name, fn]) => [
        name,
        async (...args: never[]) => {
          calls.push(name);
          (sent[name] ??= []).push(args);
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

  async function drive<T>(
    { activities }: Saga,
    body: (handle: WorkflowHandleWithFirstExecutionRunId, id: string) => Promise<T>,
    input: Partial<OrderSagaInput> = {},
  ): Promise<T> {
    const taskQueue = `hold-exit-${(queues += 1)}`;
    const running = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle,
      activities,
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
  const phase = async (handle: WorkflowHandle) =>
    (await handle.query<SagaStatus, []>('status')).phase;
  const phaseIs = (handle: WorkflowHandle, expected: string) =>
    eventually(async () => (await phase(handle)) === expected, `phase ${expected}`);
  /** `handle.result()`, or a failure a stuck saga cannot hide: it would skip time for good. */
  async function resultOf(handle: WorkflowHandle): Promise<unknown> {
    let timer: NodeJS.Timeout | undefined;
    const stuck = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('The saga did not end')), 60_000);
    });
    try {
      return await Promise.race([handle.result(), stuck]);
    } finally {
      clearTimeout(timer);
    }
  }
  const replay = async (handle: WorkflowHandle) =>
    Worker.runReplayHistory({ workflowBundle }, await handle.fetchHistory(), handle.workflowId);
  /** A run continued in the hold's wait, whose first send was `age` ago. */
  const inWait = async (age: number, rounds = 4): Promise<Partial<OrderSagaInput>> => ({
    resume: {
      status: STATUS,
      waitingIn: 'PENDING',
      activitySequence: 7,
      holdCall: { rounds },
      holdNotAfter: holdDeadlineFrom((await env.currentTimeMs()) - age),
    } as SagaResume,
  });
  /** Started just past the limit, so its first refused send gives the hold up. */
  const pastLimit = () => inWait(LIMIT_MS + 1);
  const refusing = {
    createObligation: async (_id: string, holdNotAfter?: string) => {
      throw await refusalTo(holdNotAfter);
    },
  };
  /** Refused for good, its lookup finding the hold once it has `landed`. */
  const closesThenLands = (landed: { now: boolean }, more: Record<string, Fn> = {}) =>
    saga(() => ({
      ...refusing,
      findObligation: () => (landed.now ? { transactionId: TXN } : null),
      ...more,
    }));
  const cancelled = (state: State) => {
    state.status = 'CANCELLING';
    state.cancellationReason = 'changed their mind';
  };

  describe('the rule', () => {
    it('the deadline is the first send and the window, in the one form economic-service hashes', () => {
      expect(holdDeadlineFrom(1_000)).toBe(new Date(1_000 + HOLD_FENCE.sendWindowMs).toISOString());
    });
    it.each([
      ['at the deadline', 0, false],
      ['one margin past it, to the millisecond', HOLD_FENCE.clockMarginMs, false],
      ['just past that', HOLD_FENCE.clockMarginMs + 1, true],
      ['just before the deadline', -1, false],
    ])('a request sent %s', (_name, after, past) => {
      const deadline = holdDeadlineFrom(5_000);
      expect(sentPastHoldFence(deadline, Date.parse(deadline) + after)).toBe(past);
    });
    it.each(['', 'not an instant'])('a deadline %j is not past anything', (deadline) => {
      expect(sentPastHoldFence(deadline, Number.MAX_SAFE_INTEGER)).toBe(false);
    });
    it.each([
      [24, 30 * 60 * 60 * 1000],
      [1, 75 * 60 * 1000],
      [168, 210 * 60 * 60 * 1000],
    ])('retired, for replay only: retention %d h gave a limit of %d ms', (hours, limit) => {
      expect(doubtOutlivesKeyMs(hours)).toBe(limit);
    });
    it.each([undefined, null, 0, -1, NaN, Infinity, '24'])('%s is no retention', (hours) => {
      expect(doubtOutlivesKeyMs(hours)).toBeNull();
    });
  });

  describe('the exit', () => {
    // That each close returns the stock is `test/activities.int-spec.ts` ("a hold given
    // up on"), on a real database; here the saga has to reach that close.
    it('the 150-round probe: one 5xx, refused every round, cancelled: the saga closes the order', async () => {
      const s = saga();
      const result = await drive(s, async (handle) => {
        await eventually(() => s.rounds.length > 0, 'the first round');
        await atRest(handle);
        cancelled(s.state);
        return resultOf(handle);
      });
      expect(result).toBe('CANCELLED');
      expect(s.state.status).toBe('CANCELLED');
      expect(s.calls).toContain('markCancelled');
      expect(s.calls).not.toContain('compensate');
      expect(s.rounds.length).toBeGreaterThan(1);
      expect(s.rounds.length).toBeLessThan(150);
    });

    it('nobody cancelled: the saga fails the order, and sends no request after it', async () => {
      const s = saga();
      let seen: WorkflowHandle | undefined;
      const result = await drive(s, async (handle) => {
        seen = handle;
        return resultOf(handle);
      });
      expect(result).toBe('FAILED');
      expect(s.sent.markFailed).toEqual([[INPUT.orderId, FENCE_WORDS]]);
      expect(s.calls.lastIndexOf('createObligation')).toBeLessThan(s.calls.indexOf('markFailed'));
      const history = await (seen as WorkflowHandle).fetchHistory();
      const [first] = scheduledAt(history, 'createObligation');
      const [closed] = scheduledAt(history, 'markFailed');
      expect((closed as number) - (first as number)).toBeGreaterThan(LIMIT_MS);
      expect(markersOf(history)).toEqual(
        expect.arrayContaining([HOLD_WAIT_PATCH, HOLD_FENCE_PATCH]),
      );
      // The retired exit's marker is for the histories that took it, and no others.
      expect(markersOf(history)).not.toContain(HOLD_REFUSAL_EXIT_PATCH);
      await replay(seen as WorkflowHandle);
    });

    it('refused by the fence, a request sent just before deadline + margin waits; the next one closes', async () => {
      const s = saga(() => refusing);
      await drive(
        s,
        async (handle) => {
          await eventually(() => s.rounds.length > 0, 'a refused round');
          await atRest(handle);
          expect(s.calls).not.toContain('markFailed');
          expect(await phase(handle)).toBe('HOLD_UNCONFIRMED');
          expect(s.rounds.at(-1)).toContain(HOLD_DEADLINE_PASSED);
          await env.sleep(90_000);
          await handle.signal(retryDisputeRelease);
          await eventually(() => s.calls.includes('markFailed'), 'the exit');
          await atRest(handle);
        },
        await inWait(LIMIT_MS - 60_000),
      );
      expect(s.state.status).toBe('FAILED');
    });

    it('a wait just past deadline + margin: the first send refused ends it', async () => {
      const s = saga(() => refusing);
      await drive(
        s,
        async (handle) => {
          await eventually(() => s.calls.includes('markFailed'), 'the exit');
          await atRest(handle);
        },
        await inWait(LIMIT_MS + 1),
      );
      expect(s.rounds).toEqual([]);
      expect(s.state.status).toBe('FAILED');
    });

    it('a 5xx past deadline + margin is no refusal: only the round refused after it ends the wait', async () => {
      let sends = 0;
      const s = saga(() => ({
        createObligation: async (_id: string, holdNotAfter?: string) => {
          sends += 1;
          throw sends === 1 ? gone() : await refusalTo(holdNotAfter);
        },
      }));
      const result = await drive(s, async (handle) => resultOf(handle), await pastLimit());
      expect(result).toBe('FAILED');
      expect(sends).toBe(2);
      expect(s.rounds).toEqual([expect.stringMatching(/^createObligation: UPSTREAM_UNAVAILABLE/)]);
    });

    it('sent before deadline + margin and answered after it: the send is what counts', async () => {
      let lookups = 0;
      let looked = 0;
      const s = saga(() => ({
        ...refusing,
        // Retried by the activity's own policy, so workflow time passes after the send.
        findObligation: async () => {
          lookups += 1;
          if (lookups < 3) throw ApplicationFailure.retryable('down', 'UPSTREAM_UNAVAILABLE');
          looked = await env.currentTimeMs();
          return null;
        },
      }));
      const started = await inWait(LIMIT_MS - 2_500);
      const limit =
        Date.parse((started.resume as SagaResume).holdNotAfter as string) +
        HOLD_FENCE.clockMarginMs;
      await drive(
        s,
        async (handle) => {
          await eventually(() => s.rounds.length > 0, 'its round');
          await atRest(handle);
          expect(await phase(handle)).toBe('HOLD_UNCONFIRMED');
        },
        started,
      );
      // Not vacuous: the answer did come past the limit.
      expect(looked).toBeGreaterThan(limit);
      expect(s.calls).not.toContain('markFailed');
    });

    it.each([
      ['a 5xx', gone],
      [
        'a listed code not marked: a later attempt, or a guard',
        () => ApplicationFailure.nonRetryable('no', 'INSUFFICIENT_BALANCE'),
      ],
      [
        'ALREADY_EXISTS, which the activity does not mark',
        () => ApplicationFailure.nonRetryable('there', 'ALREADY_EXISTS'),
      ],
      ['a mark on a code nobody listed', () => marked('CONFLICT')],
      ['a first-attempt refusal', () => marked()],
      [
        'the code without its mark',
        () => ApplicationFailure.nonRetryable('no', HOLD_DEADLINE_PASSED),
      ],
      ['the first-attempt mark on the code', () => marked(HOLD_DEADLINE_PASSED)],
      [
        'its mark on another code',
        () =>
          ApplicationFailure.create({
            message: 'no',
            type: 'CONFLICT',
            nonRetryable: true,
            details: [REFUSED_PAST_HOLD_DEADLINE],
          }),
      ],
    ])('%s never counts, however far past the fence', async (_name, failure) => {
      const s = saga(() => ({
        createObligation: () => {
          throw failure();
        },
      }));
      await drive(
        s,
        async (handle) => {
          await eventually(() => s.rounds.length > 0, 'a round');
          await atRest(handle);
          expect(await phase(handle)).toBe('HOLD_UNCONFIRMED');
        },
        await inWait(10 * LIMIT_MS),
      );
      expect(s.calls).not.toContain('markFailed');
    });

    it.each([
      ['fails', gone],
      [
        'cannot finish',
        () => ApplicationFailure.nonRetryable('more', 'OBLIGATION_LOOKUP_INCOMPLETE'),
      ],
    ])('a lookup that %s is no proof, however far past the fence', async (_name, failure) => {
      const s = saga(() => ({
        ...refusing,
        findObligation: () => {
          throw failure();
        },
      }));
      await drive(
        s,
        async (handle) => {
          await eventually(() => s.rounds.length > 0, 'a round');
          await atRest(handle);
        },
        await inWait(10 * LIMIT_MS),
      );
      expect(s.calls).not.toContain('markFailed');
    });

    it('an obligation found after the refusal is adopted, however far past the fence', async () => {
      const s = saga(() => ({
        ...refusing,
        findObligation: () => ({ transactionId: TXN }),
      }));
      await drive(
        s,
        async (handle) => {
          await eventually(() => s.calls.includes('markFundsHeld'), 'the hold adopted');
          await atRest(handle);
        },
        await inWait(10 * LIMIT_MS),
      );
      expect(s.calls).not.toContain('markFailed');
      expect(s.state.economicTransactionId).toBe(TXN);
    });

    it('an obligation not adopted stops the saga as ever, however far past the fence', async () => {
      const s = saga(() => ({
        ...refusing,
        findObligation: () => ({
          mismatch: true,
          transactionIds: ['TXN_OTHER'],
          differ: ['payee'],
        }),
      }));
      await expect(
        drive(s, async (handle) => handle.result(), await inWait(10 * LIMIT_MS)),
      ).rejects.toMatchObject({ cause: { type: 'OBLIGATION_TERMS_MISMATCH' } });
      expect(s.calls).not.toContain('markFailed');
    });

    it.each([
      ["the executed probe, 1 h against economic-service's 168 h", 1],
      ['the default', 24],
      ['absent', undefined],
    ])(
      'with no deadline nothing can be fenced, so no live age ends the wait: retention %s',
      async (_name, hours) => {
        const s = saga(() => refusing);
        await drive(
          s,
          async (handle) => {
            await eventually(() => s.rounds.length > 0, 'a round');
            await atRest(handle);
            expect(await phase(handle)).toBe('HOLD_UNCONFIRMED');
          },
          {
            economicKeyRetentionHours: hours,
            resume: {
              status: STATUS,
              waitingIn: 'PENDING',
              activitySequence: 7,
              holdCall: { rounds: 4, doubtAt: (await env.currentTimeMs()) - 1000 * LIMIT_MS },
            } as SagaResume,
          },
        );
        expect(s.calls).not.toContain('markFailed');
      },
    );

    it('a retention still in the input decides nothing: 1 h against 168 h, past 2.05 h the order stays', async () => {
      const s = saga();
      await drive(
        s,
        async (handle) => {
          await eventually(() => s.rounds.length > 0, 'the first round');
          await atRest(handle);
          await env.sleep(2.1 * 60 * 60_000);
          await atRest(handle);
          expect(s.calls).not.toContain('markFailed');
          expect(await phase(handle)).toBe('HOLD_UNCONFIRMED');
        },
        { economicKeyRetentionHours: 1 },
      );
    });

    it('the stalled request of the review: it resumes after the saga ended, and economic-service refuses it', async () => {
      // economic-service as its specs show it, with a wallet funded by then.
      const economic = { held: false, stalled: [] as (string | undefined)[] };
      const receive = async (holdNotAfter?: string) => {
        if (holdNotAfter !== undefined && (await env.currentTimeMs()) > Date.parse(holdNotAfter)) {
          throw fenced();
        }
        economic.held = true;
      };
      const s = saga(() => ({
        createObligation: async (_id: string, holdNotAfter?: string) => {
          // The first request never reaches it: only its answer is lost.
          if (economic.stalled.length === 0) {
            economic.stalled.push(holdNotAfter);
            throw gone();
          }
          throw await refusalTo(holdNotAfter);
        },
      }));
      // The retention is what the reviewed build gave up by, 60 h before this request arrives.
      const result = await drive(s, async (handle) => resultOf(handle), {
        economicKeyRetentionHours: 24,
      });
      expect(result).toBe('FAILED');
      expect(s.state.status).toBe('FAILED');
      await expect(receive(economic.stalled[0])).rejects.toMatchObject({
        type: HOLD_DEADLINE_PASSED,
      });
      expect(economic.held).toBe(false);
    });

    it('every request carries the deadline of the first send, and only a hold is sent one', async () => {
      const s = saga();
      let seen: WorkflowHandle | undefined;
      await drive(s, async (handle) => {
        seen = handle;
        return resultOf(handle);
      });
      const deadlines = new Set(s.sent.createObligation?.map((args) => args[1]));
      expect(deadlines.size).toBe(1);
      const [firstSend] = scheduledAt(
        await (seen as WorkflowHandle).fetchHistory(),
        'createObligation',
      );
      const [deadline] = [...deadlines] as unknown as [string];
      const from = Date.parse(deadline) - HOLD_FENCE.sendWindowMs;
      expect(Math.abs(from - (firstSend as number))).toBeLessThan(5_000);
    });

    it('a refused first attempt with no doubt still fails at once, with nothing to watch', async () => {
      const s = saga(() => refusing);
      let seen: WorkflowHandle | undefined;
      const result = await drive(s, async (handle) => {
        seen = handle;
        return resultOf(handle);
      });
      expect(result).toBe('FAILED');
      expect(s.calls.filter((call) => call === 'findObligation')).toHaveLength(1);
      expect(s.sent.createObligation).toHaveLength(1);
      await replay(seen as WorkflowHandle);
    });
  });

  describe('a top-up', () => {
    const toppedUp = () => {
      const wallet = { funded: false };
      let sends = 0;
      const s = saga(() => ({
        createObligation: () => {
          sends += 1;
          if (sends === 1) throw gone();
          if (!wallet.funded) throw marked();
          return { transactionId: TXN };
        },
      }));
      return { s, wallet };
    };

    it('before the limit, on an order still wanted: the hold is placed and the order goes on', async () => {
      const { s, wallet } = toppedUp();
      await drive(s, async (handle) => {
        await eventually(() => s.rounds.length > 0, 'the first round');
        await atRest(handle);
        await handle.signal(retryDisputeRelease);
        await eventually(() => s.rounds.length > 1, 'a refused round');
        await atRest(handle);
        wallet.funded = true;
        await handle.signal(retryDisputeRelease);
        await eventually(() => s.calls.includes('markFundsHeld'), 'the hold');
        await atRest(handle);
      });
      expect(s.state.status).toBe('FUNDS_HELD');
      expect(s.calls).not.toContain('markFailed');
    });

    it('before the limit, on an order cancelled: refunded, never left held', async () => {
      const { s, wallet } = toppedUp();
      const result = await drive(s, async (handle) => {
        await eventually(() => s.rounds.length > 0, 'a round');
        await atRest(handle);
        cancelled(s.state);
        wallet.funded = true;
        await handle.signal(retryDisputeRelease);
        return resultOf(handle);
      });
      expect(result).toBe('CANCELLED');
      expect(s.sent.compensate?.[0]?.[1]).toBe(TXN);
      expect(s.calls.indexOf('compensate')).toBeLessThan(s.calls.indexOf('markCancelled'));
    });

    it('after the exit: nothing is sent, so a funded wallet places no hold', async () => {
      const wallet = { funded: false };
      const s = saga(() => ({
        createObligation: async (_id: string, holdNotAfter?: string) => {
          if (!wallet.funded) throw await refusalTo(holdNotAfter);
          return { transactionId: TXN };
        },
      }));
      await drive(
        s,
        async (handle) => {
          await eventually(() => s.calls.includes('markFailed'), 'the exit');
          await atRest(handle);
          const sends = s.sent.createObligation?.length;
          wallet.funded = true;
          const lookups = () => s.calls.filter((call) => call === 'findObligation').length;
          const before = lookups();
          await handle.signal(retryDisputeRelease);
          await phaseIs(handle, 'LATE_HOLD_WATCH');
          await eventually(() => lookups() > before, 'the look the signal asked for');
          await atRest(handle);
          // One look per signal: the watch goes back to its backoff, it does not spin.
          expect(lookups()).toBe(before + 1);
          await env.sleep(5 * 60_000);
          await atRest(handle);
          expect(s.sent.createObligation?.length).toBe(sends);
        },
        await pastLimit(),
      );
      expect(s.state.status).toBe('FAILED');
      expect(s.calls).not.toContain('markFundsHeld');
    });
  });

  describe('the late hold', () => {
    it('landing on an order FAILED: refunded, with no party asked, and the order stays FAILED', async () => {
      const landed = { now: false };
      const s = closesThenLands(landed);
      let seen: WorkflowHandle | undefined;
      const result = await drive(
        s,
        async (handle) => {
          seen = handle;
          await eventually(() => s.calls.includes('markFailed'), 'the exit');
          await atRest(handle);
          expect(s.calls).not.toContain('compensate');
          expect(await phase(handle)).toBe('LATE_HOLD_WATCH');
          landed.now = true;
          await handle.signal(retryDisputeRelease);
          return resultOf(handle);
        },
        await pastLimit(),
      );
      expect(result).toBe('FAILED');
      expect(s.state.status).toBe('FAILED');
      expect(s.sent.compensate).toEqual([
        [
          INPUT.orderId,
          TXN,
          'A hold arrived after the saga gave up on it',
          true,
          FINAL_ANSWER_CONTRACT,
        ],
      ]);
      expect(s.calls).not.toContain('markFundsHeld');
      expect(s.calls.lastIndexOf('createObligation')).toBeLessThan(s.calls.indexOf('markFailed'));
      await replay(seen as WorkflowHandle);
    });

    it('landing on an order CANCELLED: refunded the same way', async () => {
      const landed = { now: false };
      const s = closesThenLands(landed);
      cancelled(s.state);
      const result = await drive(
        s,
        async (handle) => {
          await eventually(() => s.calls.includes('markCancelled'), 'the exit');
          await atRest(handle);
          expect(s.calls).not.toContain('compensate');
          landed.now = true;
          await handle.signal(retryDisputeRelease);
          return resultOf(handle);
        },
        await pastLimit(),
      );
      expect(result).toBe('CANCELLED');
      expect(s.sent.compensate?.[0]?.[1]).toBe(TXN);
      expect(s.state.status).toBe('CANCELLED');
    });

    it('landing before a cancelled order closes: refunded before it is cancelled', async () => {
      let exited = false;
      const s = saga((state) => ({
        markFailed: () => {
          exited = true;
          return state.status;
        },
        findObligation: () => (exited ? { transactionId: TXN } : null),
      }));
      const result = await drive(s, async (handle) => {
        await eventually(() => s.rounds.length > 0, 'the first round');
        await atRest(handle);
        cancelled(s.state);
        return resultOf(handle);
      });
      expect(result).toBe('CANCELLED');
      expect(s.calls.indexOf('compensate')).toBeLessThan(s.calls.indexOf('markCancelled'));
    });

    it('a refund earlier in the watch: the status query does not go on naming the obligation', async () => {
      const lookups = { answer: (): unknown => null };
      const s = saga(() => ({ ...refusing, findObligation: () => lookups.answer() }));
      await drive(
        s,
        async (handle) => {
          await eventually(() => s.calls.includes('markFailed'), 'the exit');
          await atRest(handle);
          lookups.answer = () => ({
            notHeld: true,
            transactionId: TXN,
            status: 'REFUNDED',
            funds: 'RETURNED',
          });
          await handle.signal(retryDisputeRelease);
          await eventually(
            () => s.calls.filter((call) => call === 'findObligation').length > 2,
            'a lookup naming it',
          );
          await atRest(handle);
          expect(await phase(handle)).toBe('LATE_HOLD_WATCH');
        },
        await pastLimit(),
      );
      expect(s.calls).not.toContain('compensate');
    });

    it('none lands: the saga looks for one more margin, and then ends', async () => {
      const s = saga();
      let seen: WorkflowHandle | undefined;
      const result = await drive(s, async (handle) => {
        seen = handle;
        const outcome = await resultOf(handle);
        expect(await phase(handle)).toBe('FAILED');
        return outcome;
      });
      expect(result).toBe('FAILED');
      const history = await (seen as WorkflowHandle).fetchHistory();
      const [closed] = scheduledAt(history, 'markFailed');
      const lookups = scheduledAt(history, 'findObligation');
      const last = lookups.at(-1) as number;
      expect(lookups.filter((at) => at > (closed as number)).length).toBeGreaterThan(1);
      // The saga's clock read when it gave up is at or before the step's scheduling.
      expect(last - (closed as number)).toBeGreaterThanOrEqual(HOLD_FENCE.clockMarginMs - 5000);
      expect(last - (closed as number)).toBeLessThan(2 * HOLD_FENCE.clockMarginMs);
      expect(s.calls).not.toContain('compensate');
    });

    it('a lookup that fails during the watch counts as a round, and the refund still comes', async () => {
      const lookup: { answer: () => unknown } = { answer: () => null };
      const s = saga(() => ({ ...refusing, findObligation: () => lookup.answer() }));
      const result = await drive(
        s,
        async (handle) => {
          await eventually(() => s.calls.includes('markFailed'), 'the exit');
          await atRest(handle);
          // Retryable: only the capped lookup comes back from this to count a round.
          lookup.answer = () => {
            throw ApplicationFailure.retryable('down', 'UPSTREAM_UNAVAILABLE');
          };
          await handle.signal(retryDisputeRelease);
          await eventually(() => s.rounds.length > 0, 'a counted round');
          await atRest(handle);
          expect(s.rounds.at(-1)).toMatch(/^compensate: /);
          lookup.answer = () => ({ transactionId: TXN });
          await handle.signal(retryDisputeRelease);
          return resultOf(handle);
        },
        await pastLimit(),
      );
      expect(result).toBe('FAILED');
      expect(s.sent.compensate?.[0]?.[1]).toBe(TXN);
    });

    it('its refund refused, even on a first attempt, waits and is sent again', async () => {
      const refund: { answer: () => unknown } = {
        answer: () => {
          throw marked('BUSINESS_RULE_VIOLATION');
        },
      };
      const landed = { now: false };
      const s = closesThenLands(landed, { compensate: () => refund.answer() });
      const result = await drive(
        s,
        async (handle) => {
          await eventually(() => s.calls.includes('markFailed'), 'the exit');
          await atRest(handle);
          landed.now = true;
          await handle.signal(retryDisputeRelease);
          await phaseIs(handle, 'COMPENSATION_UNCONFIRMED');
          await eventually(() => s.rounds.at(-1)?.startsWith('compensate') === true, 'a round');
          await atRest(handle);
          refund.answer = () => undefined;
          await handle.signal(retryDisputeRelease);
          return resultOf(handle);
        },
        await pastLimit(),
      );
      expect(result).toBe('FAILED');
      expect(s.sent.compensate?.length).toBe(2);
    });

    it('one no refund can reach stays for a person', async () => {
      const landed = { now: false };
      const s = closesThenLands(landed, {
        compensate: () => ({ final: true, status: 'SETTLED', funds: 'PAID_OUT' }),
      });
      await drive(
        s,
        async (handle) => {
          await eventually(() => s.calls.includes('markFailed'), 'the exit');
          await atRest(handle);
          landed.now = true;
          await handle.signal(retryDisputeRelease);
          await phaseIs(handle, 'OBLIGATION_RECONCILIATION');
          await atRest(handle);
          expect((await handle.describe()).status.name).toBe('RUNNING');
        },
        await pastLimit(),
      );
    });

    it('an obligation already back with the buyer ends the watch quietly', async () => {
      const landed = { now: false };
      const s = closesThenLands(landed, {
        compensate: () => ({ final: true, status: 'REFUNDED', funds: 'RETURNED' }),
      });
      const result = await drive(
        s,
        async (handle) => {
          await eventually(() => s.calls.includes('markFailed'), 'the exit');
          await atRest(handle);
          landed.now = true;
          await handle.signal(retryDisputeRelease);
          return resultOf(handle);
        },
        await pastLimit(),
      );
      expect(result).toBe('FAILED');
    });
  });

  describe('across a rollover', () => {
    const THRESHOLD = { historyEventThreshold: 40 };
    const inputOf = async (id: string, runId: string): Promise<SagaResume | undefined> => {
      const history = await env.client.workflow.getHandle(id, runId).fetchHistory();
      const payload =
        history.events?.[0]?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0];
      return (
        JSON.parse(Buffer.from(payload?.data as Uint8Array).toString()) as {
          resume?: SagaResume;
        }
      ).resume;
    };

    it('the deadline is carried, not fixed again, and a resumed run may close on an empty lookup', async () => {
      const s = saga();
      let seen: WorkflowHandleWithFirstExecutionRunId | undefined;
      const result = await drive(
        s,
        async (handle, id) => {
          seen = handle;
          await eventually(() => s.rounds.length > 0, 'the first round');
          await atRest(handle);
          cancelled(s.state);
          return resultOf(env.client.workflow.getHandle(id));
        },
        THRESHOLD,
      );
      expect(result).toBe('CANCELLED');
      expect(s.calls).toContain('markCancelled');
      // Run by run, from the first: every wait carried the first send's deadline.
      const carried: unknown[] = [];
      let runs = 0;
      let runId: string | undefined = seen?.firstExecutionRunId;
      while (runId) {
        const history = await env.client.workflow
          .getHandle(seen?.workflowId as string, runId)
          .fetchHistory();
        const resume = await inputOf(seen?.workflowId as string, runId);
        if (resume?.holdCall) carried.push(resume.holdNotAfter);
        runs += 1;
        runId =
          history.events?.at(-1)?.workflowExecutionContinuedAsNewEventAttributes
            ?.newExecutionRunId ?? undefined;
      }
      expect(runs).toBeGreaterThan(1);
      expect(carried.length).toBeGreaterThan(0);
      const sent = new Set(s.sent.createObligation?.map((args) => args[1]));
      expect(sent.size).toBe(1);
      expect(new Set(carried)).toEqual(sent);
    });

    it('the watch rolls over with its deadline, and the next run still refunds', async () => {
      const landed = { now: false };
      const s = closesThenLands(landed);
      const result = await drive(
        s,
        async (handle, id) => {
          const latest = env.client.workflow.getHandle(id);
          await eventually(() => s.calls.includes('markFailed'), 'the exit');
          await atRest(latest);
          for (let i = 0; i < 60; i += 1) {
            if ((await latest.describe()).runId !== handle.firstExecutionRunId) {
              const resume = await inputOf(id, (await latest.describe()).runId);
              if (resume?.lateHoldWatch) break;
            }
            await atRest(latest);
            await latest.signal(retryDisputeRelease);
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          const resume = await inputOf(id, (await latest.describe()).runId);
          expect(resume?.lateHoldWatch?.until).toEqual(expect.any(Number));
          await atRest(latest);
          landed.now = true;
          await latest.signal(retryDisputeRelease);
          return resultOf(latest);
        },
        { ...(await pastLimit()), ...THRESHOLD },
      );
      expect(result).toBe('FAILED');
      expect(s.sent.compensate?.[0]?.[1]).toBe(TXN);
      expect(s.calls.filter((call) => call === 'markFailed')).toHaveLength(1);
      // The next run does not go back to the hold it gave up on.
      expect(s.calls.lastIndexOf('createObligation')).toBeLessThan(s.calls.indexOf('markFailed'));
    });

    it('a run continued in the watch, with the order closed, watches before it ends', async () => {
      const s = saga(() => ({ findObligation: () => ({ transactionId: TXN }) }));
      s.state.status = 'FAILED';
      const until = (await env.currentTimeMs()) + 60 * 60_000;
      const result = await drive(s, async (handle) => resultOf(handle), {
        resume: {
          status: STATUS,
          waitingIn: 'FAILED',
          activitySequence: 40,
          outstandingWork: { operation: 'compensate', rounds: 0, noHold: true },
          lateHoldWatch: { until, reason: FENCE_WORDS },
        } as SagaResume,
      });
      expect(result).toBe('FAILED');
      expect(s.sent.compensate?.[0]?.[1]).toBe(TXN);
    });

    it('a run continued mid-refund goes on with that refund, without a lookup', async () => {
      const s = saga();
      s.state.status = 'CANCELLED';
      const until = (await env.currentTimeMs()) + 60 * 60_000;
      const result = await drive(s, async (handle) => resultOf(handle), {
        resume: {
          status: STATUS,
          waitingIn: 'CANCELLED',
          activitySequence: 40,
          outstandingWork: { operation: 'compensate', rounds: 0, noHold: true },
          lateHoldWatch: { until, reason: 'x' },
          siblingCall: { operation: 'compensate', rounds: 2, transactionId: TXN },
        } as SagaResume,
      });
      expect(result).toBe('CANCELLED');
      expect(s.sent.compensate?.[0]?.[1]).toBe(TXN);
      expect(s.calls).not.toContain('findObligation');
    });

    it('a run continued before the order recorded its failure records it, and watches', async () => {
      const s = saga();
      const until = (await env.currentTimeMs()) + 60_000;
      const result = await drive(s, async (handle) => resultOf(handle), {
        resume: {
          status: STATUS,
          waitingIn: 'PENDING',
          activitySequence: 40,
          outstandingWork: { operation: 'compensate', rounds: 1, noHold: true },
          lateHoldWatch: { until, reason: 'Insufficient balance' },
        } as SagaResume,
      });
      expect(result).toBe('FAILED');
      expect(s.sent.markFailed).toEqual([[INPUT.orderId, 'Insufficient balance']]);
      expect(s.calls).not.toContain('createObligation');
    });

    it('a run continued at PENDING with neither wait is still refused', async () => {
      const s = saga();
      await expect(
        drive(s, async (handle) => resultOf(handle), {
          resume: { status: STATUS, waitingIn: 'PENDING', activitySequence: 40 } as SagaResume,
        }),
      ).rejects.toMatchObject({ cause: { type: 'SAGA_INCONSISTENT' } });
      expect(s.calls).not.toContain('createObligation');
    });

    it('a hold wait rolled over before the fence goes on with no deadline, and does not start one', async () => {
      const s = saga(() => refusing);
      await drive(
        s,
        async (handle) => {
          await eventually(() => s.rounds.length > 0, 'a refused round');
          await atRest(handle);
          expect(await phase(handle)).toBe('HOLD_UNCONFIRMED');
          expect(markersOf(await handle.fetchHistory())).not.toContain(HOLD_FENCE_PATCH);
        },
        {
          resume: {
            status: STATUS,
            waitingIn: 'PENDING',
            activitySequence: 7,
            holdCall: { rounds: 4 },
          } as SagaResume,
        },
      );
      expect(s.calls).not.toContain('markFailed');
      expect(s.sent.createObligation?.[0]?.[1]).toBeUndefined();
    });

    it('a refused markFailed at the exit waits and is asked again', async () => {
      const closing: { answer: (state: State) => unknown } = {
        answer: () => {
          throw ApplicationFailure.nonRetryable('no', 'BUSINESS_RULE_VIOLATION');
        },
      };
      const s = saga((state) => ({ ...refusing, markFailed: () => closing.answer(state) }));
      const result = await drive(
        s,
        async (handle) => {
          await eventually(() => s.calls.includes('markFailed'), 'the exit');
          await phaseIs(handle, 'CANCELLATION_NOT_RECORDED');
          await atRest(handle);
          closing.answer = (state) => (state.status = 'FAILED');
          await handle.signal(retryDisputeRelease);
          return resultOf(handle);
        },
        await pastLimit(),
      );
      expect(result).toBe('FAILED');
      expect(s.calls.filter((call) => call === 'markFailed').length).toBeGreaterThan(1);
    });
  });
});
