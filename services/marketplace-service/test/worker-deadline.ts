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

type DeadlineConnection = Pick<Connection, 'withDeadline' | 'withAbortSignal'>;

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
}

export function startDeadline(
  what: string,
  ms: number = WORKER_DEADLINE_MS,
  connection?: DeadlineConnection,
): Deadline {
  const controller = new AbortController();
  const expiresAt = Date.now() + ms;
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new WorkerDeadlineError(what, ms);
      controller.abort(error);
      reject(error);
    }, ms);
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
  };
}

/** The part of a Temporal `Worker` that {@link runBounded} needs. */
export interface RunsUntil {
  runUntil<R>(fn: () => Promise<R>): Promise<R>;
}

/**
 * `worker.runUntil(body)` under one deadline: when it expires, `body` rejects
 * with a {@link WorkerDeadlineError}, so `runUntil` shuts the worker down and
 * rethrows it. `body` gets the deadline to put around its own waits.
 */
export async function runBounded<T>(
  worker: RunsUntil,
  options: { what: string; ms?: number; connection?: DeadlineConnection },
  body: (deadline: Deadline) => Promise<T>,
): Promise<T> {
  const deadline = startDeadline(options.what, options.ms, options.connection);
  try {
    return await worker.runUntil(() => deadline.guard(body(deadline)));
  } finally {
    deadline.stop();
  }
}
