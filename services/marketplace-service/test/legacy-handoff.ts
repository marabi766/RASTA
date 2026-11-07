import type { WorkflowHandle } from '@temporalio/client';
import { startDeadline, type Deadline } from './worker-deadline';

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
  while (!deadline.signal.aborted) {
    if (await deadline.call(predicate)) return;
    await deadline.sleep(pauseMs);
  }
  throw new Error(`Timed out waiting for ${what}`, { cause: deadline.signal.reason });
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
  return (
    open.size === 0 &&
    Boolean(
      last?.timerStartedEventAttributes ??
      last?.timerCanceledEventAttributes ??
      last?.workflowTaskCompletedEventAttributes,
    )
  );
}

export const quiet = (handle: HandoffHandle, deadline: Deadline): Promise<void> =>
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
