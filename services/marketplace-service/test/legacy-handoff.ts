import type { WorkflowHandle } from '@temporalio/client';
import {
  currentDeadline,
  startDeadline,
  WorkerDeadlineError,
  type Deadline,
} from './worker-deadline';

/**
 * The one way a test stops a worker that has no cache (`maxCachedWorkflows: 0`)
 * and goes on with another on the same queue (FU-147, FU-192). Such a worker
 * answers a query by replaying the events it was sent, answered or not, so a
 * successful query says nothing about a workflow task it is still running:
 * stopping on it hands that task to the next worker, whose first wake-up then
 * depends on the task being recovered. So a history is read, not a phase:
 * ask only from a history with nothing in flight ({@link queryQuiet}), and
 * stop only from one ({@link handOff}, which also covers the query it ran).
 *
 * Every read and query here goes through the caller's {@link Deadline}: a poll
 * limit does not bound a request that is never answered, and the worker is
 * only stopped once the callback around these calls settles.
 */
export type HandoffHandle = Pick<WorkflowHandle, 'fetchHistory' | 'query'>;
type HistoryEvents = Awaited<ReturnType<WorkflowHandle['fetchHistory']>>['events'];

/**
 * Asks until `predicate` holds, or the deadline passes: each ask is itself
 * raced against it, so an unanswered ask ends the wait too. There is no
 * count of asks to stop on — only the deadline, which is what also stops the
 * worker.
 */
export async function eventually(
  deadline: Deadline,
  predicate: () => Promise<boolean>,
  what: string,
  pauseMs = 25,
): Promise<void> {
  try {
    while (!deadline.signal.aborted) {
      if (await deadline.call(predicate)) return;
      await deadline.sleep(pauseMs);
    }
  } catch (error) {
    // The deadline's own error, naming the wait it ended (FU-214).
    if (error !== deadline.signal.reason || !(error instanceof WorkerDeadlineError)) throw error;
    throw named(error, what);
  }
  throw new Error(`Timed out waiting for ${what}`, { cause: deadline.signal.reason });
}

/** A copy of the deadline's error that says which wait it cut off. */
function named(error: WorkerDeadlineError, what: string): WorkerDeadlineError {
  const copy = new WorkerDeadlineError(what, 0);
  copy.message = `${error.message} (waiting for ${what})`;
  copy.cause = error;
  return copy;
}

/** {@link eventually} under a deadline of its own, for a poll that has no enclosing one. */
export async function pollWithin(
  ms: number,
  predicate: (deadline: Deadline) => Promise<boolean>,
  what: string,
): Promise<void> {
  const deadline = startDeadline(what, ms);
  try {
    await eventually(deadline, () => predicate(deadline), what);
  } finally {
    deadline.stop();
  }
}

/**
 * Every activity the saga scheduled has been answered, and the last event of
 * its history is the timer it armed or a workflow task that has been answered:
 * none scheduled or started.
 */
export function isQuiet(history: HistoryEvents): boolean {
  const events = history ?? [];
  const open = new Set<number>();
  for (const e of events) {
    if (e.activityTaskScheduledEventAttributes) open.add(Number(e.eventId));
    const answered =
      e.activityTaskCompletedEventAttributes ??
      e.activityTaskFailedEventAttributes ??
      e.activityTaskTimedOutEventAttributes ??
      e.activityTaskCanceledEventAttributes;
    if (answered) open.delete(Number(answered.scheduledEventId));
  }
  const last = events.at(-1);
  // Closed: nothing is in flight, and nothing will run again (FU-214).
  if (
    last?.workflowExecutionCompletedEventAttributes ??
    last?.workflowExecutionFailedEventAttributes ??
    last?.workflowExecutionTimedOutEventAttributes ??
    last?.workflowExecutionTerminatedEventAttributes ??
    last?.workflowExecutionCanceledEventAttributes ??
    last?.workflowExecutionContinuedAsNewEventAttributes
  ) {
    return true;
  }
  return (
    open.size === 0 &&
    Boolean(
      last?.timerStartedEventAttributes ??
      last?.timerCanceledEventAttributes ??
      last?.workflowTaskCompletedEventAttributes,
    )
  );
}

type Duration = { seconds?: unknown; nanos?: number | null } | null | undefined;
/** A protobuf duration or timestamp in milliseconds; `seconds` may be a Long. */
const toMs = (value: Duration): number => {
  const seconds = value?.seconds;
  const whole =
    typeof seconds === 'object' && seconds !== null && 'toNumber' in seconds
      ? (seconds as { toNumber(): number }).toNumber()
      : Number(seconds ?? 0);
  return whole * 1000 + Math.floor((value?.nanos ?? 0) / 1e6);
};

/**
 * When each timer the history armed, and has neither fired nor cancelled, is
 * due: server time, in milliseconds (FU-214).
 */
export function pendingTimers(history: HistoryEvents): number[] {
  const due = new Map<string, number>();
  for (const e of history ?? []) {
    const started = e.timerStartedEventAttributes;
    if (started?.timerId) {
      due.set(started.timerId, toMs(e.eventTime) + toMs(started.startToFireTimeout));
    }
    const ended = e.timerFiredEventAttributes ?? e.timerCanceledEventAttributes;
    if (ended?.timerId) due.delete(ended.timerId);
  }
  return [...due.values()];
}

export const quiet = (
  handle: Pick<HandoffHandle, 'fetchHistory'>,
  deadline: Deadline,
): Promise<void> =>
  eventually(
    deadline,
    async () => isQuiet((await handle.fetchHistory()).events),
    'the saga to be quiet',
  );

/** A query asked only once the history is quiet: it takes one query, not a poll. */
export async function queryQuiet<T>(
  handle: HandoffHandle,
  deadline: Deadline,
  name: string,
): Promise<T> {
  await quiet(handle, deadline);
  return deadline.call(() => handle.query<T, []>(name));
}

/**
 * Runs `drive` on the worker being retired, then waits for a quiet history —
 * after the last query, immediately before the caller's `runUntil` returns and
 * the worker shuts down.
 */
export async function handOff<T>(
  handle: HandoffHandle,
  deadline: Deadline,
  drive: () => Promise<T>,
): Promise<T> {
  const result = await deadline.call(drive);
  await quiet(handle, deadline);
  return result;
}

/**
 * How near, in server time, a timer may be due when a signal is sent (FU-214).
 * The signal's workflow task cancels the timers the saga waits on; when one of
 * them fires while that task runs, the time-skipping test server refuses the
 * task ("invalid history builder state for action") and the saga never moves
 * again (a 24-hour recheck due the moment a three-day sleep ended, #937).
 * Between skips the server's clock runs at wall speed, so ten seconds are many
 * workflow tasks even on a loaded runner — and below the timers a test signals
 * into on purpose: the one-minute release backoff and the 30-second pause per
 * attempt. A test whose saga rechecks more often than this, and signals, waits
 * on the guard until its deadline: it fails loudly, it does not race.
 */
export const TIMER_MARGIN_MS = 10_000;

/** The test server's clock, as a time-skipping `TestWorkflowEnvironment` has it. */
export interface Clock {
  currentTimeMs(): Promise<number>;
  sleep(durationMs: number): Promise<void>;
}
type Signalled = Pick<WorkflowHandle, 'fetchHistory' | 'signal' | 'workflowId'>;

/** The clock each {@link signalling} handle's timers run on. */
const clocks = new WeakMap<object, Clock>();

/**
 * Returns once none of the saga's timers is due within
 * {@link TIMER_MARGIN_MS}: one that is, is let fire first — the clock skipped
 * just past it and the saga waited for until quiet, as on every run where the
 * race went that way — and the check repeats (FU-214). Under the ambient
 * deadline, as every wait in a test run is. A handle not made by
 * {@link signalling} is refused: its timers are on no known clock.
 */
export async function clearOfTimers(handle: Signalled): Promise<void> {
  const clock = clocks.get(handle);
  if (!clock) throw new Error(`${handle.workflowId}: a signal from a handle with no clock`);
  const deadline = currentDeadline('the saga to be clear of timers');
  for (;;) {
    const [history, now] = await Promise.all([
      deadline.call(() => handle.fetchHistory()),
      deadline.call(() => clock.currentTimeMs()),
    ]);
    const near = pendingTimers(history.events).filter((due) => due - now < TIMER_MARGIN_MS);
    if (near.length === 0) return;
    await deadline.call(() => clock.sleep(Math.max(Math.max(...near) - now, 0) + 1));
    await quiet(handle, deadline);
  }
}

/** `handle`, whose signals never land on a timer: each is sent {@link clearOfTimers}. */
export function signalling<H extends Signalled>(clock: Clock, handle: H): H {
  const guarded: H = new Proxy(handle, {
    get: (target, key, receiver) =>
      key === 'signal' ? signal : (Reflect.get(target, key, receiver) as unknown),
  });
  const signal: WorkflowHandle['signal'] = async (...args) => {
    await clearOfTimers(guarded);
    return handle.signal(...args);
  };
  clocks.set(guarded, clock);
  return guarded;
}
