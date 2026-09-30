import { DEFAULT_SHUTDOWN_TIMEOUT_MS } from '@rasta/config';

/**
 * One graceful-shutdown path for a Nest service.
 *
 * A service used to have two, running at once: `app.enableShutdownHooks()`,
 * which makes Nest close the application on a signal, and its own signal
 * handler, which flushed telemetry and called `process.exit(0)`. The exit did
 * not wait for Nest, so it could cut off exactly what the hooks exist to
 * finish — an outbox relay batch mid-publish, a consumer mid-message, a
 * sweeper mid-scan — and it reported success while doing so.
 *
 * This is the single path instead:
 *
 *   1. `app.close(signal)` — Nest runs `onModuleDestroy`,
 *      `beforeApplicationShutdown`, stops the HTTP server, then runs
 *      `onApplicationShutdown`. `close()` does all of that whether or not
 *      `enableShutdownHooks()` was called; that call only registers Nest's own
 *      signal listeners, which is the second path this replaces.
 *   2. `afterClose` — the telemetry flush, after the hooks, so spans they emit
 *      while stopping are not lost.
 *   3. `exit(0)` if step 1 completed, `exit(1)` if it threw or outlasted
 *      `timeoutMs`.
 *
 * Step 1 is bounded so a batch that never ends cannot hold the process past
 * its orchestrator's grace period; step 2 is bounded separately so a dead
 * collector cannot either. A failure in step 2 is logged but does not change
 * the exit code: the application did close cleanly, which is what the code
 * reports.
 *
 * Call it once, right after `NestFactory.create` and before `listen`. A signal
 * that arrives before then — during module initialisation — takes Node's
 * default action (terminate), because there is no application to close yet.
 *
 * Cross-cutting mechanism only: no business rules live here (ADR-018).
 */

/** The part of a Nest application this needs; `INestApplication` satisfies it. */
export interface ShutdownTarget {
  close(signal?: string): Promise<void>;
}

/**
 * Where lifecycle lines go. Structurally a subset of the platform logger, so
 * one can be passed once it exists; until then the default writes with
 * `console.warn`/`console.error`, which is what `main.ts` has always done
 * around startup and shutdown.
 */
export interface ShutdownLogger {
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

/** What signal listeners are registered on. `process` in production. */
export interface ShutdownSignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface GracefulShutdownOptions {
  /** Prefixes every line, so a shared log stream says which service spoke. */
  serviceName: string;
  /**
   * Upper bound on `app.close()`. Defaults to `DEFAULT_SHUTDOWN_TIMEOUT_MS`;
   * services pass `env.SHUTDOWN_TIMEOUT_MS`. Keep it under the orchestrator's
   * grace period.
   */
  timeoutMs?: number;
  /** Runs after the application has closed; normally `shutdownTelemetry`. */
  afterClose?: () => Promise<void>;
  /** Upper bound on `afterClose`. Default 3 s, so both bounds fit in 30 s. */
  afterCloseTimeoutMs?: number;
  logger?: ShutdownLogger;
  /** Default: SIGTERM (orchestrators) and SIGINT (a terminal). */
  signals?: readonly NodeJS.Signals[];
  /** Test seam. Default: `process.exit`. */
  exit?: (code: number) => void;
  /** Test seam. Default: `process`. */
  signalSource?: ShutdownSignalSource;
}

export interface GracefulShutdown {
  /**
   * Runs the shutdown path for `signal`. The first call does the work and
   * every later call returns the same promise, so a repeated signal neither
   * re-closes the application nor starts a second exit.
   */
  shutdown(signal: string): Promise<void>;
}

export const DEFAULT_AFTER_CLOSE_TIMEOUT_MS = 3_000;
export const DEFAULT_SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

const consoleLogger: ShutdownLogger = {
  warn: (message) => console.warn(message),
  error: (message, error) =>
    error === undefined ? console.error(message) : console.error(message, error),
};

/** A source can be installed on once: a second install would be a second path. */
const installedOn = new WeakSet<object>();

type Outcome = { kind: 'done' } | { kind: 'failed'; error: unknown } | { kind: 'timeout' };

/**
 * Settles with how `work` ended, never rejecting. The timer is cleared as soon
 * as `work` settles, and a rejection that arrives after the timeout is still
 * consumed here, so a hung close that later fails cannot become an unhandled
 * rejection in a process that is already exiting.
 */
function settle(work: () => Promise<void>, timeoutMs: number): Promise<Outcome> {
  return new Promise<Outcome>((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
    // `then(work)` so a synchronous throw is a failure, not an exception here.
    Promise.resolve()
      .then(work)
      .then(
        () => {
          clearTimeout(timer);
          resolve({ kind: 'done' });
        },
        (error: unknown) => {
          clearTimeout(timer);
          resolve({ kind: 'failed', error });
        },
      );
  });
}

function assertBound(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer number of milliseconds, got ${value}`);
  }
}

export function installGracefulShutdown(
  app: ShutdownTarget,
  options: GracefulShutdownOptions,
): GracefulShutdown {
  const {
    serviceName,
    afterClose,
    logger = consoleLogger,
    signals = DEFAULT_SHUTDOWN_SIGNALS,
    exit = (code: number): void => process.exit(code),
    signalSource = process,
  } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const afterCloseTimeoutMs = options.afterCloseTimeoutMs ?? DEFAULT_AFTER_CLOSE_TIMEOUT_MS;
  assertBound('timeoutMs', timeoutMs);
  assertBound('afterCloseTimeoutMs', afterCloseTimeoutMs);

  if (installedOn.has(signalSource)) {
    throw new Error(
      `[${serviceName}] graceful shutdown is already installed on this process; a second ` +
        'install would register a second competing shutdown path',
    );
  }
  installedOn.add(signalSource);

  let running: Promise<void> | undefined;

  const run = async (signal: string): Promise<void> => {
    logger.warn(`[${serviceName}] received ${signal}, shutting down`);

    const closed = await settle(() => app.close(signal), timeoutMs);
    if (closed.kind === 'failed') {
      logger.error(`[${serviceName}] error while closing`, closed.error);
    } else if (closed.kind === 'timeout') {
      logger.error(`[${serviceName}] shutdown timed out after ${timeoutMs} ms`);
    }

    if (afterClose) {
      const flushed = await settle(afterClose, afterCloseTimeoutMs);
      if (flushed.kind === 'failed') {
        logger.error(`[${serviceName}] error after closing`, flushed.error);
      } else if (flushed.kind === 'timeout') {
        logger.error(`[${serviceName}] post-close step timed out after ${afterCloseTimeoutMs} ms`);
      }
    }

    exit(closed.kind === 'done' ? 0 : 1);
  };

  const shutdown = (signal: string): Promise<void> => {
    if (running) {
      logger.warn(`[${serviceName}] already shutting down, ignoring ${signal}`);
      return running;
    }
    running = run(signal);
    return running;
  };

  for (const signal of signals) {
    signalSource.on(signal, () => void shutdown(signal));
  }

  return { shutdown };
}
