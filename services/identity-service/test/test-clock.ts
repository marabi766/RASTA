/**
 * The deadline is the test's (#910): `Date.now` and the timers that measure
 * it — a stop's window and deadline, a pool's close, the modelled engine's
 * `maxWait` and `timeout`, the answers a test schedules — are fake, and move
 * only when a test moves them; promise turns, `setImmediate` and
 * `process.nextTick` run for real (Prisma's own disconnect takes a
 * `setImmediate`). So what began, committed, drained or was abandoned before
 * a stop returned is decided by the order of those instants, never by how
 * fast the runner is: an operation held past a deadline is abandoned because
 * it is held, and one that finished did so while the clock stood still.
 *
 * Called inside a `describe`: every test of it runs on that clock.
 */
export function onTheTestsClock(): void {
  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'queueMicrotask'],
    });
  });
  afterEach(() => {
    jest.useRealTimers();
  });
}

/** Whether `work` has settled yet, without waiting for it. */
export function watch(work: Promise<unknown>): { settled: boolean } {
  const state = { settled: false };
  const settle = () => void (state.settled = true);
  void work.then(settle, settle);
  return state;
}

/** Real turns of the event loop, until `condition` holds; a bounded number. */
export async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (!condition()) throw new Error('never happened');
}

/**
 * Moves the clock `ms`, and requires `work` to have returned by then — with
 * no more time passing — and resolves to what it did (a rejection included).
 */
export async function returnedBy<T>(work: Promise<T>, ms: number): Promise<T> {
  const state = watch(work);
  await jest.advanceTimersByTimeAsync(ms);
  await until(() => state.settled);
  return work;
}
