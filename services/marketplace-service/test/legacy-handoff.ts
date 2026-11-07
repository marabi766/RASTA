import type { WorkflowHandle } from '@temporalio/client';

/**
 * The one way a test stops a worker that has no cache (`maxCachedWorkflows: 0`)
 * and goes on with another on the same queue (FU-147, FU-192). Such a worker
 * answers a query by replaying the events it was sent, answered or not, so a
 * successful query says nothing about a workflow task it is still running:
 * stopping on it hands that task to the next worker, whose first wake-up then
 * depends on the task being recovered. So a history is read, not a phase:
 * ask only from a history with nothing in flight ({@link queryQuiet}), and
 * stop only from one ({@link handOff}, which also covers the query it ran).
 */
export type HandoffHandle = Pick<WorkflowHandle, 'fetchHistory' | 'query'>;
type HistoryEvents = Awaited<ReturnType<WorkflowHandle['fetchHistory']>>['events'];

export async function eventually(predicate: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
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

export const quiet = (handle: HandoffHandle): Promise<void> =>
  eventually(async () => isQuiet((await handle.fetchHistory()).events), 'the saga to be quiet');

/** A query asked only once the history is quiet: it takes one query, not a poll. */
export async function queryQuiet<T>(handle: HandoffHandle, name: string): Promise<T> {
  await quiet(handle);
  return handle.query<T, []>(name);
}

/**
 * Runs `drive` on the worker being retired, then waits for a quiet history —
 * after the last query, immediately before the caller's `runUntil` returns and
 * the worker shuts down.
 */
export async function handOff<T>(handle: HandoffHandle, drive: () => Promise<T>): Promise<T> {
  const result = await drive();
  await quiet(handle);
  return result;
}
