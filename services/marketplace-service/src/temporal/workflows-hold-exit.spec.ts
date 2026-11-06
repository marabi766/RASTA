import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/activity';
import type { WorkflowHandle, WorkflowHandleWithFirstExecutionRunId } from '@temporalio/client';
import {
  HOLD_REFUSAL_EXIT_PATCH,
  HOLD_WAIT_PATCH,
  orderSaga,
  retryDisputeRelease,
  type OrderSagaInput,
  type SagaResume,
  type SagaStatus,
} from './workflows';
import type { OrderActivities } from './activities';
import { doubtOutlivesKeyMs, REFUSED_ON_FIRST_ATTEMPT } from './economic-refusal';

/**
 * Review of #812: after one 5xx, a refusal that persists kept the saga waiting for
 * good, the order CANCELLING and its stock reserved. The exit: a marked refusal counts
 * once the doubt has outlived the key, and the saga stays to refund a hold that lands
 * after it.
 */

jest.setTimeout(120_000);

const RETENTION_HOURS = 1;
const LIMIT_MS = doubtOutlivesKeyMs(RETENTION_HOURS) as number;
const INPUT: OrderSagaInput = {
  orderId: 'ORD_EXIT',
  fulfillmentWindowDays: 7,
  receiptWindowDays: 3,
  reminderIntervalDays: 3,
  recheckIntervalHours: 24 * 365,
  economicKeyRetentionHours: RETENTION_HOURS,
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
        return () => {
          sends += 1;
          throw sends === 1 ? gone() : marked();
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
  /** A run continued in the hold's wait, its doubt `age` old. */
  const inWait = async (age: number, rounds = 4): Promise<Partial<OrderSagaInput>> => ({
    resume: {
      status: STATUS,
      waitingIn: 'PENDING',
      activitySequence: 7,
      holdCall: { rounds, doubtAt: (await env.currentTimeMs()) - age },
    } as SagaResume,
  });
  /** Started just past the limit, so its first refused send gives the hold up. */
  const pastLimit = () => inWait(LIMIT_MS + 1);
  const refusing = {
    createObligation: () => {
      throw marked();
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
    it.each([
      [24, 30 * 60 * 60 * 1000],
      [1, 75 * 60 * 1000],
      [168, 210 * 60 * 60 * 1000],
    ])('retention %d h gives a limit of %d ms, margin included', (hours, limit) => {
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
      const hours = 24;
      const result = await drive(
        s,
        async (handle) => {
          await eventually(() => s.rounds.length > 0, 'the first round');
          await atRest(handle);
          cancelled(s.state);
          return resultOf(handle);
        },
        { economicKeyRetentionHours: hours },
      );
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
      expect(s.sent.markFailed).toEqual([[INPUT.orderId, 'Insufficient balance']]);
      expect(s.calls.lastIndexOf('createObligation')).toBeLessThan(s.calls.indexOf('markFailed'));
      const history = await (seen as WorkflowHandle).fetchHistory();
      const [first] = scheduledAt(history, 'createObligation');
      const [closed] = scheduledAt(history, 'markFailed');
      expect((closed as number) - (first as number)).toBeGreaterThan(LIMIT_MS);
      expect(markersOf(history)).toEqual(
        expect.arrayContaining([HOLD_WAIT_PATCH, HOLD_REFUSAL_EXIT_PATCH]),
      );
      await replay(seen as WorkflowHandle);
    });

    it('just before the limit it waits, and just after it the same saga closes', async () => {
      const s = saga(() => ({
        createObligation: () => {
          throw marked();
        },
      }));
      await drive(
        s,
        async (handle) => {
          await eventually(() => s.rounds.length > 0, 'a refused round');
          await atRest(handle);
          expect(s.calls).not.toContain('markFailed');
          expect(await phase(handle)).toBe('HOLD_UNCONFIRMED');
          expect(markersOf(await handle.fetchHistory())).not.toContain(HOLD_REFUSAL_EXIT_PATCH);
          await env.sleep(90_000);
          await handle.signal(retryDisputeRelease);
          await eventually(() => s.calls.includes('markFailed'), 'the exit');
          await atRest(handle);
        },
        await inWait(LIMIT_MS - 60_000),
      );
      expect(s.state.status).toBe('FAILED');
    });

    it('a doubt just past the limit: the first send refused ends it', async () => {
      const s = saga(() => ({
        createObligation: () => {
          throw marked();
        },
      }));
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

    it('a 5xx starts the age again: refused rounds after it wait out a whole limit', async () => {
      let sends = 0;
      const s = saga(() => ({
        createObligation: () => {
          sends += 1;
          throw sends === 1 ? gone() : marked();
        },
      }));
      let seen: WorkflowHandle | undefined;
      const result = await drive(
        s,
        async (handle) => {
          seen = handle;
          return resultOf(handle);
        },
        await inWait(10 * LIMIT_MS),
      );
      expect(result).toBe('FAILED');
      const history = await (seen as WorkflowHandle).fetchHistory();
      const [fiveHundred] = scheduledAt(history, 'createObligation');
      const [closed] = scheduledAt(history, 'markFailed');
      expect((closed as number) - (fiveHundred as number)).toBeGreaterThan(LIMIT_MS);
      expect(s.rounds.length).toBeGreaterThan(1);
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
    ])('%s never counts, however old the doubt', async (_name, failure) => {
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
    ])('a lookup that %s is no proof, however old the doubt', async (_name, failure) => {
      const s = saga(() => ({
        createObligation: () => {
          throw marked();
        },
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

    it('an obligation found after the refusal is adopted, however old the doubt', async () => {
      const s = saga(() => ({
        createObligation: () => {
          throw marked();
        },
        findObligation: () => ({ transactionId: TXN }),
      }));
      await drive(
        s,
        async (handle) => {
          await eventually(() => s.calls.includes('markFundsHeld'), 'the hold adopted');
          await atRest(handle);
          expect(markersOf(await handle.fetchHistory())).not.toContain(HOLD_REFUSAL_EXIT_PATCH);
        },
        await inWait(10 * LIMIT_MS),
      );
      expect(s.calls).not.toContain('markFailed');
      expect(s.state.economicTransactionId).toBe(TXN);
    });

    it('an obligation not adopted stops the saga as ever, and records no exit, however old the doubt', async () => {
      const s = saga(() => ({
        ...refusing,
        findObligation: () => ({
          mismatch: true,
          transactionIds: ['TXN_OTHER'],
          differ: ['payee'],
        }),
      }));
      let seen: WorkflowHandle | undefined;
      await expect(
        drive(
          s,
          async (handle) => {
            seen = handle;
            return handle.result();
          },
          await inWait(10 * LIMIT_MS),
        ),
      ).rejects.toMatchObject({ cause: { type: 'OBLIGATION_TERMS_MISMATCH' } });
      expect(s.calls).not.toContain('markFailed');
      expect(markersOf(await (seen as WorkflowHandle).fetchHistory())).not.toContain(
        HOLD_REFUSAL_EXIT_PATCH,
      );
    });

    it.each([
      ['absent', undefined],
      ['zero', 0],
      ['negative', -24],
      ['not a number', '24'],
    ])('a retention %s proves nothing, however old the doubt', async (_name, hours) => {
      const s = saga(() => ({
        createObligation: () => {
          throw marked();
        },
      }));
      await drive(
        s,
        async (handle) => {
          await eventually(() => s.rounds.length > 0, 'a round');
          await atRest(handle);
        },
        { ...(await inWait(1000 * LIMIT_MS)), economicKeyRetentionHours: hours as never },
      );
      expect(s.calls).not.toContain('markFailed');
    });

    it('a refused first attempt with no doubt still fails at once, with nothing to watch', async () => {
      const s = saga(() => ({
        createObligation: () => {
          throw marked();
        },
      }));
      let seen: WorkflowHandle | undefined;
      const result = await drive(s, async (handle) => {
        seen = handle;
        return resultOf(handle);
      });
      expect(result).toBe('FAILED');
      expect(s.calls.filter((call) => call === 'findObligation')).toHaveLength(1);
      expect(markersOf(await (seen as WorkflowHandle).fetchHistory())).not.toContain(
        HOLD_REFUSAL_EXIT_PATCH,
      );
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
        expect(markersOf(await handle.fetchHistory())).not.toContain(HOLD_REFUSAL_EXIT_PATCH);
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
        createObligation: () => {
          if (!wallet.funded) throw marked();
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
        [INPUT.orderId, TXN, 'A hold arrived after the saga gave up on it', true],
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

    it('none lands: the saga looks for one more limit, and then ends', async () => {
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
      expect(last - (closed as number)).toBeGreaterThanOrEqual(LIMIT_MS - 5000);
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

    it('the age is carried, not started again, and a resumed run may close on an empty lookup', async () => {
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
      // Run by run, from the first: every wait carried the first failure's time.
      const doubts: number[] = [];
      let runId: string | undefined = seen?.firstExecutionRunId;
      const first = await env.client.workflow
        .getHandle(seen?.workflowId as string, runId)
        .fetchHistory();
      while (runId) {
        const history = await env.client.workflow
          .getHandle(seen?.workflowId as string, runId)
          .fetchHistory();
        const started = history.events?.[0]?.workflowExecutionStartedEventAttributes;
        const payload = started?.input?.payloads?.[0];
        const { resume } = JSON.parse(Buffer.from(payload?.data as Uint8Array).toString()) as {
          resume?: SagaResume;
        };
        if (resume?.holdCall) doubts.push(resume.holdCall.doubtAt as number);
        runId =
          history.events?.at(-1)?.workflowExecutionContinuedAsNewEventAttributes
            ?.newExecutionRunId ?? undefined;
      }
      expect(doubts.length).toBeGreaterThan(0);
      expect(new Set(doubts).size).toBe(1);
      // Within the time a first failure's task takes of sending it.
      const [sentAt] = scheduledAt(first, 'createObligation');
      expect((doubts[0] as number) - (sentAt as number)).toBeLessThan(60_000);
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
          lateHoldWatch: { until, reason: 'Insufficient balance' },
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

    it('a hold wait rolled over before doubtAt existed starts the age where it resumes', async () => {
      const s = saga(() => ({
        createObligation: () => {
          throw marked();
        },
      }));
      await drive(
        s,
        async (handle) => {
          await eventually(() => s.rounds.length > 0, 'a refused round');
          await atRest(handle);
          expect(await phase(handle)).toBe('HOLD_UNCONFIRMED');
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
