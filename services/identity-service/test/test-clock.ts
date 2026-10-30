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

/**
 * How `work` settled, and when (#912): recorded by the work itself — a
 * handler on the original promise, with the test's clock at that instant —
 * so an assertion on it says when the operation returned, never when the
 * test next looked.
 */
export type Settlement<T> = PromiseSettledResult<T> & { settledAt: number };

/** Whether `work` has settled yet, without waiting for it; and how, and when. */
export function watch<T>(work: Promise<T>): { settled: boolean; settlement?: Settlement<T> } {
  const state: { settled: boolean; settlement?: Settlement<T> } = { settled: false };
  void work.then(
    (value) => {
      state.settlement = { status: 'fulfilled', value, settledAt: Date.now() };
      state.settled = true;
    },
    (reason: unknown) => {
      state.settlement = { status: 'rejected', reason, settledAt: Date.now() };
      state.settled = true;
    },
  );
  return state;
}

/** Real turns of the event loop, until `condition` holds; a bounded number. */
export async function until(condition: () => boolean): Promise<void> {
  await turns(condition);
  if (!condition()) throw new Error('never happened');
}

async function turns(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Moves the clock at most `ms`, timer by timer, and **stops it the instant
 * `work` settles** (#912): requires it to have settled by then, and resolves
 * to how it settled and at what time (a rejection included). After each
 * timer the event loop's real turns run first, so work that settles on one
 * (Prisma's disconnect takes a `setImmediate`) does so at that instant.
 *
 * So whatever a test observes once this returned — a log, a count, a later
 * marker — is the state when the work returned, not `ms` later: a stop that
 * returned early, before a COMMIT it should have waited for, is seen as
 * returned before that COMMIT, at its own `settledAt`.
 */
export async function returnedBy<T>(work: Promise<T>, ms: number): Promise<Settlement<T>> {
  const state = watch(work);
  const end = Date.now() + ms;
  // A timer at the limit: moving to the next timer never passes it.
  const limit = setTimeout(() => undefined, ms);
  try {
    await turns(() => state.settled);
    for (let step = 0; !state.settled && Date.now() < end; step += 1) {
      if (step === 10_000) throw new Error(`a timer loop: not settled after ${step} timers`);
      await jest.advanceTimersToNextTimerAsync();
      await turns(() => state.settled);
    }
    // At the limit: what is due then — a deadline's own timer — still runs.
    for (let step = 0; !state.settled && step < 10; step += 1) {
      await jest.advanceTimersByTimeAsync(0);
      await turns(() => state.settled);
    }
  } finally {
    clearTimeout(limit);
  }
  if (!state.settlement) throw new Error(`not returned within ${ms} ms on the test's clock`);
  return state.settlement;
}
