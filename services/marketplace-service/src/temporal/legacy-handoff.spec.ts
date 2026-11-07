import { Worker } from '@temporalio/worker';
import {
  eventually,
  handOff,
  isQuiet,
  queryQuiet,
  type HandoffHandle,
} from '../../test/legacy-handoff';
import { runBounded, startDeadline, WorkerDeadlineError } from '../../test/worker-deadline';

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
  ): Promise<T> => runBounded(runs, { what: 'the handoff', ms: DEADLINE_MS }, body);

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
