import { Worker } from '@temporalio/worker';
import {
  clearOfTimers,
  eventually,
  handOff,
  isQuiet,
  pendingTimers,
  signalling,
  TIMER_MARGIN_MS,
  queryQuiet,
  type HandoffHandle,
} from '../../test/legacy-handoff';
import {
  cleanUp,
  currentDeadline,
  runBounded,
  startDeadline,
  WorkerDeadlineError,
} from '../../test/worker-deadline';

type Events = Parameters<typeof isQuiet>[0];
const ev = (eventId: number, attributes: Record<string, unknown> = {}) => ({
  eventId,
  ...attributes,
});
const scheduled = (id: number) => ev(id, { activityTaskScheduledEventAttributes: {} });
const completed = (id: number, of: number) =>
  ev(id, { activityTaskCompletedEventAttributes: { scheduledEventId: of } });
const timer = (id: number) => ev(id, { timerStartedEventAttributes: {} });
const taskDone = (id: number) => ev(id, { workflowTaskCompletedEventAttributes: {} });
const taskStarted = (id: number) => ev(id, { workflowTaskStartedEventAttributes: {} });
const taskScheduled = (id: number) => ev(id, { workflowTaskScheduledEventAttributes: {} });

describe('isQuiet: a history with nothing in flight (FU-147, FU-192)', () => {
  const cases: [string, unknown[], boolean][] = [
    ['empty', [], false],
    ['ends in an armed timer', [taskDone(4), timer(5)], true],
    ['ends in an answered task with no command', [timer(5), taskDone(9)], true],
    ['ends in a scheduled workflow task', [timer(5), taskScheduled(6)], false],
    ['ends in a started workflow task', [timer(5), taskScheduled(6), taskStarted(7)], false],
    ['an activity still running', [scheduled(5), taskDone(9)], false],
    ['an activity answered', [scheduled(5), completed(6, 5), taskDone(9)], true],
    [
      'closed, the saga finished by itself',
      [taskDone(9), ev(10, { workflowExecutionCompletedEventAttributes: {} })],
      true,
    ],
    [
      'closed by termination',
      [scheduled(5), ev(6, { workflowExecutionTerminatedEventAttributes: {} })],
      true,
    ],
  ];
  it.each(cases)('%s', (_name, events, expected) => {
    expect(isQuiet(events as Events)).toBe(expected);
  });
});

/** A handle whose history ends in a started task until `settle()` is called and `lag` more reads pass. */
function handleWith(lag: number) {
  let settled = false;
  let reads = 0;
  let queriedAt = -1;
  const handle = {
    fetchHistory: async () => {
      reads += 1;
      if (queriedAt >= 0 && reads - queriedAt > lag) settled = true;
      return { events: [timer(5), ...(settled || queriedAt < 0 ? [] : [taskStarted(7)])] };
    },
    query: async () => {
      queriedAt = reads;
      return { phase: 'AWAITING_CONFIRMATION' };
    },
  } as unknown as HandoffHandle;
  return { handle, settled: () => settled, queried: () => queriedAt >= 0 };
}

describe('handing a cacheless worker over', () => {
  it('stops only from a quiet history that the final query left behind', async () => {
    const { handle, settled } = handleWith(3);
    const deadline = startDeadline('the handoff', 5_000);
    await handOff(handle, deadline, () => queryQuiet(handle, deadline, 'status'));
    deadline.stop();
    expect(settled()).toBe(true);
  });

  it('asks only once the history is quiet', async () => {
    let reads = 0;
    const query = jest.fn(async () => reads);
    const handle = {
      fetchHistory: async () => ({
        events: reads++ < 2 ? [timer(5), taskStarted(7)] : [timer(5), taskDone(8)],
      }),
      query,
    } as unknown as HandoffHandle;
    const deadline = startDeadline('the query', 5_000);
    await expect(queryQuiet(handle, deadline, 'status')).resolves.toBeGreaterThanOrEqual(3);
    deadline.stop();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns what the drive returned', async () => {
    const { handle } = handleWith(0);
    const deadline = startDeadline('the handoff', 5_000);
    await expect(handOff(handle, deadline, async () => 'driven')).resolves.toBe('driven');
    deadline.stop();
  });
});

/**
 * A request that is never answered (FU-192 r2). The SDK's own `runUntil` runs on
 * a worker that is only a stand-in: its `run()` ends when it is shut down, which
 * `runUntil` does once the callback settles — and not before.
 */
const NEVER = new Promise<never>(() => undefined);
const DEADLINE_MS = 60;

function standIn() {
  let stop: () => void = () => undefined;
  const worker = {
    state: 'RUNNING',
    shutdowns: 0,
    run: () => new Promise<void>((resolve) => (stop = resolve)),
    shutdown() {
      worker.shutdowns += 1;
      worker.state = 'STOPPING';
      stop();
    },
  };
  return {
    worker,
    // The SDK's real runUntil, bound to the stand-in.
    runUntil: <R>(fn: () => Promise<R>): Promise<R> =>
      (Worker.prototype.runUntil as (this: unknown, fn: () => Promise<R>) => Promise<R>).call(
        worker,
        fn,
      ),
  };
}

const quietHistory = { events: [timer(5), taskDone(8)] };

describe('a handoff has a deadline that an unanswered request cannot outlast (FU-192 r2)', () => {
  const bounded = <T>(
    runs: ReturnType<typeof standIn>,
    body: Parameters<typeof runBounded<T>>[2],
  ): Promise<T> =>
    runBounded(runs, { what: 'the handoff', ms: DEADLINE_MS, settleMs: DEADLINE_MS }, body);

  it('a history read that never answers: rejects and shuts the worker down', async () => {
    const runs = standIn();
    const handle = { fetchHistory: () => NEVER, query: jest.fn() } as unknown as HandoffHandle;
    await expect(
      bounded(runs, (deadline) =>
        handOff(handle, deadline, () => queryQuiet(handle, deadline, 'status')),
      ),
    ).rejects.toBeInstanceOf(WorkerDeadlineError);
    expect(runs.worker.shutdowns).toBe(1);
    expect(handle.query).not.toHaveBeenCalled();
  });

  it('a query that never answers: rejects and shuts the worker down', async () => {
    const runs = standIn();
    const handle = {
      fetchHistory: async () => quietHistory,
      query: () => NEVER,
    } as unknown as HandoffHandle;
    await expect(
      bounded(runs, (deadline) => queryQuiet(handle, deadline, 'status')),
    ).rejects.toBeInstanceOf(WorkerDeadlineError);
    expect(runs.worker.shutdowns).toBe(1);
  });

  it('the history read after the query never answers: rejects and shuts the worker down', async () => {
    const runs = standIn();
    let reads = 0;
    const handle = {
      fetchHistory: () => (++reads === 1 ? Promise.resolve(quietHistory) : NEVER),
      query: async () => ({ phase: 'AWAITING_CONFIRMATION' }),
    } as unknown as HandoffHandle;
    await expect(
      bounded(runs, (deadline) =>
        handOff(handle, deadline, () => queryQuiet(handle, deadline, 'status')),
      ),
    ).rejects.toBeInstanceOf(WorkerDeadlineError);
    expect(reads).toBe(2);
    expect(runs.worker.shutdowns).toBe(1);
  });

  it('a drive that never returns: rejects and shuts the worker down', async () => {
    const runs = standIn();
    const handle = { fetchHistory: async () => quietHistory } as unknown as HandoffHandle;
    await expect(
      bounded(runs, (deadline) => handOff(handle, deadline, () => NEVER)),
    ).rejects.toBeInstanceOf(WorkerDeadlineError);
    expect(runs.worker.shutdowns).toBe(1);
  });

  it('a history that never becomes quiet: rejects and shuts the worker down', async () => {
    const runs = standIn();
    const handle = {
      fetchHistory: async () => ({ events: [timer(5), taskStarted(7)] }),
    } as unknown as HandoffHandle;
    await expect(
      bounded(runs, (deadline) => handOff(handle, deadline, async () => 1)),
    ).rejects.toThrow(/deadline/);
    expect(runs.worker.shutdowns).toBe(1);
  });

  it('answers within the deadline: the same result and one shutdown', async () => {
    const runs = standIn();
    const { handle } = {
      handle: { fetchHistory: async () => quietHistory } as unknown as HandoffHandle,
    };
    await expect(
      bounded(runs, (deadline) => handOff(handle, deadline, async () => 'driven')),
    ).resolves.toBe('driven');
    expect(runs.worker.shutdowns).toBe(1);
  });

  it('each helper holds the deadline itself, with no enclosing runUntil to rescue it', async () => {
    const stalled = [
      ['history read', { fetchHistory: () => NEVER, query: async () => 1 }, 'status'],
      ['query', { fetchHistory: async () => quietHistory, query: () => NEVER }, 'status'],
    ] as const;
    for (const [, handle, name] of stalled) {
      const deadline = startDeadline('the helper', DEADLINE_MS);
      await expect(
        queryQuiet(handle as unknown as HandoffHandle, deadline, name),
      ).rejects.toBeInstanceOf(WorkerDeadlineError);
      deadline.stop();
    }
    const deadline = startDeadline('the drive', DEADLINE_MS);
    const handle = { fetchHistory: async () => quietHistory } as unknown as HandoffHandle;
    await expect(handOff(handle, deadline, () => NEVER)).rejects.toBeInstanceOf(
      WorkerDeadlineError,
    );
    deadline.stop();
  });

  it('a body that waits on something outside the deadline is still cut off', async () => {
    const runs = standIn();
    await expect(bounded(runs, () => NEVER)).rejects.toBeInstanceOf(WorkerDeadlineError);
    expect(runs.worker.shutdowns).toBe(1);
  });

  it('hands the SDK a deadline and an abort signal for each call it makes', async () => {
    const seen: { deadline?: number; aborted?: boolean }[] = [];
    const connection = {
      withDeadline: <R>(deadline: number | Date, fn: () => Promise<R>) => {
        seen.push({ deadline: Number(deadline) });
        return fn();
      },
      withAbortSignal: <R>(signal: AbortSignal, fn: () => Promise<R>) => {
        seen.push({ aborted: signal.aborted });
        return fn();
      },
    };
    const deadline = startDeadline('the call', DEADLINE_MS, connection);
    await deadline.call(async () => 1);
    deadline.stop();
    expect(seen).toEqual([{ deadline: expect.any(Number) }, { aborted: false }]);
  });

  it('cancels the SDK call when the deadline expires', async () => {
    let signal: AbortSignal | undefined;
    const connection = {
      withDeadline: <R>(_: number | Date, fn: () => Promise<R>) => fn(),
      withAbortSignal: <R>(s: AbortSignal, fn: () => Promise<R>) => {
        signal = s;
        return fn();
      },
    };
    const deadline = startDeadline('the call', DEADLINE_MS, connection);
    await expect(deadline.call(() => NEVER)).rejects.toBeInstanceOf(WorkerDeadlineError);
    expect(signal?.aborted).toBe(true);
  });

  it('stops asking once the deadline has passed', async () => {
    const deadline = startDeadline('the poll', DEADLINE_MS);
    const ask = jest.fn(async () => false);
    await expect(eventually(deadline, ask, 'never')).rejects.toBeInstanceOf(WorkerDeadlineError);
    const asked = ask.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(ask).toHaveBeenCalledTimes(asked);
  });
});

describe('a body cut off at its deadline owns nothing past it (FU-214)', () => {
  /** A connection that records the context each call is made in. */
  function recordingConnection() {
    const context: { deadline?: number; signal?: AbortSignal } = {};
    const calls: { deadline?: number; signal?: AbortSignal; abortedThen?: boolean }[] = [];
    const connection = {
      withDeadline: async <R>(deadline: number | Date, fn: () => Promise<R>) => {
        const before = context.deadline;
        context.deadline = Number(deadline);
        try {
          return await fn();
        } finally {
          context.deadline = before;
        }
      },
      withAbortSignal: async <R>(signal: AbortSignal, fn: () => Promise<R>) => {
        const before = context.signal;
        context.signal = signal;
        try {
          return await fn();
        } finally {
          context.signal = before;
        }
      },
    };
    /** An SDK call made directly, not through `deadline.call`. */
    const rpc = <R>(answer: Promise<R>): Promise<R> => {
      calls.push({ ...context, abortedThen: context.signal?.aborted });
      return answer;
    };
    return { connection, calls, rpc };
  }

  it('every SDK call the body makes carries the deadline and its signal', async () => {
    const runs = standIn();
    const { connection, calls, rpc } = recordingConnection();
    await runBounded(runs, { what: 'the drive', ms: 5_000, connection }, () =>
      rpc(Promise.resolve(1)),
    );
    expect(calls).toEqual([
      { deadline: expect.any(Number), signal: expect.any(AbortSignal), abortedThen: false },
    ]);
  });

  it('on expiry the signal aborts, and the worker stops only once the body has settled', async () => {
    const runs = standIn();
    const order: string[] = [];
    const shutdown = runs.worker.shutdown.bind(runs.worker);
    runs.worker.shutdown = () => {
      order.push('shutdown');
      shutdown();
    };
    const { connection, rpc } = recordingConnection();
    await expect(
      runBounded(runs, { what: 'the drive', ms: DEADLINE_MS, connection }, async (deadline) => {
        // A call that ends only on its abort, as the SDK's does.
        await rpc(
          new Promise((_, reject) => {
            deadline.signal.addEventListener('abort', () => reject(new Error('aborted')));
          }),
        ).catch(() => undefined);
        // What a body does after its wait, such as stopping its workflow.
        await new Promise((resolve) => setTimeout(resolve, 2 * DEADLINE_MS));
        order.push('body settled');
      }),
    ).rejects.toBeInstanceOf(WorkerDeadlineError);
    expect(order).toEqual(['body settled', 'shutdown']);
  });

  it('a body that does not settle is reported, and the worker still stops', async () => {
    const runs = standIn();
    await expect(
      runBounded(runs, { what: 'the drive', ms: DEADLINE_MS, settleMs: DEADLINE_MS }, () => NEVER),
    ).rejects.toThrow(/was cut off and still ran/);
    expect(runs.worker.shutdowns).toBe(1);
  });

  it('a body that fails on its own fails at once, with its own error', async () => {
    const runs = standIn();
    const own = new Error('the assertion');
    await expect(
      runBounded(runs, { what: 'the drive', ms: 5_000 }, () => Promise.reject(own)),
    ).rejects.toBe(own);
    expect(runs.worker.shutdowns).toBe(1);
  });

  it('a wait finds the deadline of the body it runs in, and none outside one', async () => {
    const runs = standIn();
    await runBounded(runs, { what: 'the drive', ms: 5_000 }, async (deadline) => {
      await Promise.resolve();
      expect(currentDeadline('a wait')).toBe(deadline);
    });
    expect(() => currentDeadline('a wait')).toThrow(/outside runBounded/);
  });

  it('a wait after the deadline stops asking, and its body settles', async () => {
    const runs = standIn();
    const ask = jest.fn(async () => false);
    await expect(
      runBounded(runs, { what: 'the drive', ms: DEADLINE_MS }, () =>
        eventually(currentDeadline('never'), ask, 'never'),
      ),
    ).rejects.toBeInstanceOf(WorkerDeadlineError);
    const asked = ask.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(ask).toHaveBeenCalledTimes(asked);
  });

  it('a worker that dies before its body has settled ends the body’s waits too', async () => {
    const dying = {
      state: 'RUNNING',
      run: () => Promise.reject(new Error('fatal worker error')),
      shutdown: () => undefined,
    };
    const runs = {
      runUntil: <R>(fn: () => Promise<R>): Promise<R> =>
        (Worker.prototype.runUntil as (this: unknown, fn: () => Promise<R>) => Promise<R>).call(
          dying,
          fn,
        ),
    };
    const ask = jest.fn(async () => false);
    let body: Promise<void> | undefined;
    await expect(
      runBounded(runs, { what: 'the drive', ms: 5_000 }, () => {
        body = eventually(currentDeadline('never'), ask, 'never');
        return body;
      }),
    ).rejects.toThrow();
    const stillRunning = new Promise((resolve) =>
      setTimeout(() => resolve('still running'), 1_000),
    );
    await expect(Promise.race([body, stillRunning])).rejects.toThrow(
      /ended early: the worker stopped/,
    );
    const asked = ask.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(ask).toHaveBeenCalledTimes(asked);
  });

  it('clean-up after the deadline runs under a signal and deadline of its own', async () => {
    const runs = standIn();
    const { connection, calls, rpc } = recordingConnection();
    await expect(
      runBounded(runs, { what: 'the drive', ms: DEADLINE_MS, connection }, async (deadline) => {
        try {
          await new Promise((_, reject) => {
            deadline.signal.addEventListener('abort', () => reject(new Error('aborted')));
          });
        } finally {
          await cleanUp(connection, () => rpc(Promise.resolve('terminated')));
        }
      }),
    ).rejects.toBeInstanceOf(WorkerDeadlineError);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.abortedThen).toBe(false);
    expect(calls[0]?.deadline).toBeGreaterThan(Date.now());
  });
});

describe('pendingTimers: the timers a signal could land on (FU-214)', () => {
  const at = (seconds: number) => ({ seconds, nanos: 0 });
  const started = (id: string, atS: number, fireS: number) => ({
    eventTime: at(atS),
    timerStartedEventAttributes: { timerId: id, startToFireTimeout: at(fireS) },
  });
  const fired = (id: string) => ({ timerFiredEventAttributes: { timerId: id } });
  const cancelled = (id: string) => ({ timerCanceledEventAttributes: { timerId: id } });
  const long = (n: number) => ({ toNumber: () => n });

  it.each<[string, unknown[], number[]]>([
    ['none armed', [taskDone(3)], []],
    ['one armed: its due time', [started('1', 100, 86_400)], [86_500_000]],
    ['fired', [started('1', 100, 60), fired('1')], []],
    ['cancelled', [started('1', 100, 60), cancelled('1')], []],
    [
      'only the one still armed',
      [started('1', 0, 60), fired('1'), started('2', 60, 120)],
      [180_000],
    ],
  ])('%s', (_name, events, due) => {
    expect(pendingTimers(events as Events)).toEqual(due);
  });

  it('reads seconds given as a Long, and nanos', () => {
    const events = [
      {
        eventTime: { seconds: long(10), nanos: 500_000_000 },
        timerStartedEventAttributes: { timerId: '1', startToFireTimeout: { seconds: long(1) } },
      },
    ];
    expect(pendingTimers(events as unknown as Events)).toEqual([11_500]);
  });
});

describe('a signal never lands on a timer (FU-214)', () => {
  /**
   * A saga with one recheck armed at 0 to fire at `dueMs`, on a server whose
   * clock reads `nowMs`. Sleeping past it fires it once; the re-read it starts
   * is answered at the second look after that, and the saga arms the next.
   */
  /** A turn of the event loop, as a call to the server takes: timers can fire. */
  const io = () => new Promise<void>((resolve) => setImmediate(resolve));
  function saga(dueMs: number, nowMs = 0) {
    const log: string[] = [];
    let now = nowMs;
    let readsSinceFired = -1;
    const events: unknown[] = [
      taskDone(1),
      {
        eventId: 2,
        eventTime: { seconds: 0 },
        timerStartedEventAttributes: {
          timerId: '2',
          startToFireTimeout: { seconds: dueMs / 1000 },
        },
      },
    ];
    const clock = {
      currentTimeMs: async () => now,
      sleep: async (ms: number) => {
        await io();
        log.push(`sleep ${ms}`);
        now += ms;
        if (now >= dueMs && readsSinceFired < 0) {
          readsSinceFired = 0;
          events.push({ eventId: 3, timerFiredEventAttributes: { timerId: '2' } }, taskDone(4));
          events.push(scheduled(5));
        }
      },
    };
    const handle = {
      workflowId: 'saga',
      fetchHistory: async () => {
        await io();
        if (readsSinceFired >= 0 && ++readsSinceFired === 3) {
          log.push('re-read answered');
          events.push(completed(6, 5), taskDone(7), {
            eventId: 8,
            eventTime: { seconds: now / 1000 },
            timerStartedEventAttributes: { timerId: '8', startToFireTimeout: { seconds: 86_400 } },
          });
        }
        return { events: [...events] };
      },
      signal: async (name: string) => {
        log.push(`signal ${name}`);
      },
    } as unknown as Parameters<typeof signalling>[1];
    return { clock, handle, log };
  }
  const bounded = (body: () => Promise<unknown>) =>
    runBounded(standIn(), { what: 'the drive', ms: 5_000 }, body);

  it('a timer due within the margin fires first, then the signal is sent', async () => {
    const { clock, handle, log } = saga(5_000);
    await bounded(() => signalling(clock, handle).signal('disputeResolved'));
    expect(log).toEqual(['sleep 5001', 're-read answered', 'signal disputeResolved']);
  });

  it('an overdue timer that has not fired yet fires first too', async () => {
    const { clock, handle, log } = saga(5_000, 7_000);
    await bounded(() => signalling(clock, handle).signal('orderConfirmed'));
    expect(log).toEqual(['sleep 1', 're-read answered', 'signal orderConfirmed']);
  });

  it('a timer further off than the margin is left alone: a backoff a test signals into', async () => {
    const { clock, handle, log } = saga(TIMER_MARGIN_MS + 50_000);
    await bounded(() => signalling(clock, handle).signal('retryDisputeRelease'));
    expect(log).toEqual(['signal retryDisputeRelease']);
  });

  it('a party commits only once the saga is clear of timers', async () => {
    const { clock, handle, log } = saga(2_000);
    const guarded = signalling(clock, handle);
    await bounded(async () => {
      await clearOfTimers(guarded);
      log.push('commit');
      await guarded.signal('disputeResolved');
    });
    expect(log).toEqual(['sleep 2001', 're-read answered', 'commit', 'signal disputeResolved']);
  });

  it('a handle with no clock is refused, and so is a wait outside a run', async () => {
    const { clock, handle } = saga(60_000);
    await expect(bounded(() => clearOfTimers(handle))).rejects.toThrow(/no clock/);
    await expect(clearOfTimers(signalling(clock, handle))).rejects.toThrow(/outside runBounded/);
  });
});
