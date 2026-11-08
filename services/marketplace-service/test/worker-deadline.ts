import { AsyncLocalStorage } from 'node:async_hooks';
import type { Connection } from '@temporalio/client';

/**
 * The one deadline a test that runs a Temporal worker puts around everything
 * it waits for (FU-192 r2). A poll's iteration limit bounds the *times it
 * asks*, never one question that is not answered: a history read, a query or a
 * database read that stalls keeps its caller pending, so the callback given to
 * `Worker.runUntil` never settles, the worker is never shut down, and it is
 * still running when Jest tears the test down. So every wait inside such a
 * callback goes through a {@link Deadline}: each call is raced against it (and,
 * when a client connection is given, carries the SDK's own gRPC deadline and
 * abort signal), and on expiry the callback rejects loudly, which is what makes
 * `runUntil` stop the worker.
 */

/** Below Jest's 120 s: the worker is stopped by the test, not by Jest's timeout. */
export const WORKER_DEADLINE_MS = 90_000;

export class WorkerDeadlineError extends Error {
  constructor(what: string, ms: number) {
    super(`Worker test deadline: ${what} did not finish within ${ms} ms; shutting the worker down`);
    this.name = 'WorkerDeadlineError';
  }
}

export type DeadlineConnection = Pick<Connection, 'withDeadline' | 'withAbortSignal'>;

export interface Deadline {
  /** Aborted when the deadline expires; handed to the SDK's calls. */
  readonly signal: AbortSignal;
  /** One call (an RPC, a read, a query) raced against the deadline. */
  call<T>(rpc: () => Promise<T>): Promise<T>;
  /** The same race for a promise that is already running. */
  guard<T>(work: Promise<T>): Promise<T>;
  /** A pause between two asks; it ends early, rejecting, on expiry. */
  sleep(ms: number): Promise<void>;
  /** Disarms the timer once the guarded work has settled. */
  stop(): void;
  /**
   * Ends it now, as its expiry would: every wait and call under it rejects.
   * For a run whose worker stopped before its body settled (FU-214).
   */
  end(why: string): void;
}

export function startDeadline(
  what: string,
  ms: number = WORKER_DEADLINE_MS,
  connection?: DeadlineConnection,
): Deadline {
  const controller = new AbortController();
  const expiresAt = Date.now() + ms;
  let timer: NodeJS.Timeout | undefined;
  let fire: (error: WorkerDeadlineError) => void = () => undefined;
  const expired = new Promise<never>((_, reject) => {
    fire = (error) => {
      clearTimeout(timer);
      if (controller.signal.aborted) return;
      controller.abort(error);
      reject(error);
    };
    timer = setTimeout(() => fire(new WorkerDeadlineError(what, ms)), ms);
  });
  // The race below attaches the handlers that matter; this one only keeps an
  // expiry nobody is racing any more from being an unhandled rejection.
  expired.catch(() => undefined);

  const guard = <T>(work: Promise<T>): Promise<T> => Promise.race([work, expired]);
  const call = <T>(rpc: () => Promise<T>): Promise<T> =>
    guard(
      (async () =>
        connection
          ? connection.withDeadline(expiresAt, () =>
              connection.withAbortSignal(controller.signal, rpc),
            )
          : rpc())(),
    );
  return {
    signal: controller.signal,
    call,
    guard,
    sleep: (pause) => guard(new Promise((resolve) => setTimeout(resolve, pause))),
    stop: () => clearTimeout(timer),
    end: (why) => {
      const error = new WorkerDeadlineError(what, ms);
      error.message = `Worker test deadline: ${what} ended early: ${why}`;
      fire(error);
    },
  };
}

/** The part of a Temporal `Worker` that {@link runBounded} needs. */
export interface RunsUntil {
  runUntil<R>(fn: () => Promise<R>): Promise<R>;
}

/**
 * How long {@link runBounded} waits, after its deadline, for the body it cut off
 * to settle before the worker is stopped (FU-214).
 */
export const SETTLE_MS = 10_000;

/** The deadline of the {@link runBounded} body this code runs in, if any. */
const ambient = new AsyncLocalStorage<Deadline>();

/**
 * The deadline of the test body this code runs in. A wait that has none is
 * refused: it would have no bound but a count of asks, and nothing would stop
 * it once its test had ended (FU-214).
 */
export function currentDeadline(what: string): Deadline {
  const deadline = ambient.getStore();
  if (!deadline) {
    throw new Error(`${what}: waited outside runBounded, so nothing bounds or ends the wait`);
  }
  return deadline;
}

/**
 * `fn` under a deadline and abort signal of its own: for the clean-up after a
 * body whose own deadline (and signal) may already have expired, such as
 * terminating the workflow it started.
 */
export function cleanUp<T>(
  connection: DeadlineConnection,
  fn: () => Promise<T>,
  ms: number = SETTLE_MS,
): Promise<T> {
  const signal = AbortSignal.timeout(ms);
  return connection.withDeadline(Date.now() + ms, () => connection.withAbortSignal(signal, fn));
}

/**
 * `worker.runUntil(body)` under one deadline: when it expires, `body` rejects
 * with a {@link WorkerDeadlineError}, so `runUntil` shuts the worker down and
 * rethrows it. `body` gets the deadline to put around its own waits.
 *
 * The body owns nothing past its test (FU-214). It runs with the deadline as
 * its ambient one ({@link currentDeadline}) and, given a connection, every SDK
 * call it makes carries the deadline and its abort signal, not only those
 * passed through `deadline.call`. On expiry the signal aborts those calls and
 * the body is awaited, for at most `settleMs`, before the worker is stopped: a
 * body that ran on would make calls after its test, and a call in flight when
 * the test environment is torn down retries into the closed channel ("Channel
 * has been shut down", failing whichever test runs then).
 */
export async function runBounded<T>(
  worker: RunsUntil,
  options: { what: string; ms?: number; settleMs?: number; connection?: DeadlineConnection },
  body: (deadline: Deadline) => Promise<T>,
): Promise<T> {
  const { connection, settleMs = SETTLE_MS } = options;
  const deadline = startDeadline(options.what, options.ms, connection);
  const expiresAt = Date.now() + (options.ms ?? WORKER_DEADLINE_MS);
  const scoped = (): Promise<T> =>
    ambient.run(deadline, () =>
      connection
        ? connection.withDeadline(expiresAt, () =>
            connection.withAbortSignal(deadline.signal, () => body(deadline)),
          )
        : body(deadline),
    );
  try {
    return await worker.runUntil(async () => {
      const work = scoped();
      try {
        return await deadline.guard(work);
      } catch (error) {
        if (!deadline.signal.aborted) throw error;
        const stoppedAt = await settleWithin(work, settleMs, options.what);
        // Where the body was when the deadline cut it off: the wait it was in.
        if (stoppedAt instanceof Error && error instanceof Error && stoppedAt !== error) {
          error.message = `${error.message} (cut off in: ${stoppedAt.message})`;
        }
        throw error;
      }
    });
  } finally {
    // The worker can stop before the body settles (a fatal worker error ends
    // `runUntil` at once): end its waits and calls rather than leave them to
    // run past the test.
    deadline.end('the worker stopped');
  }
}

/**
 * Waits for `work` to settle, failing loudly when it has not within `ms`;
 * returns what it rejected with, if it did.
 */
async function settleWithin(work: Promise<unknown>, ms: number, what: string): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<{ late: true }>((resolve) => {
    timer = setTimeout(() => resolve({ late: true }), ms);
  });
  const settled = work.then(
    () => ({ late: false, reason: undefined }),
    (reason: unknown) => ({ late: false, reason }),
  );
  try {
    const outcome = await Promise.race([settled, late]);
    if (outcome.late) {
      const error = new WorkerDeadlineError(what, ms);
      error.message = `Worker test deadline: ${what} was cut off and still ran ${ms} ms later; shutting the worker down anyway`;
      throw error;
    }
    return 'reason' in outcome ? outcome.reason : undefined;
  } finally {
    clearTimeout(timer);
  }
}
