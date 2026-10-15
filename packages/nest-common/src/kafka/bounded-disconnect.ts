import { DEFAULT_SHUTDOWN_TIMEOUT_MS, outboxShutdownBudgetMs } from '@rasta/config';
import type { KafkaConnectionOptions } from './connection';

/**
 * A Kafka client's close, held to the shutdown deadline (D-052 phase 4b).
 *
 * kafkajs's `disconnect()` cancels nothing: producer → cluster → broker pool →
 * connection pool → `Connection.disconnect()`, which first waits for every
 * request in flight on the connection (`RequestQueue.waitForPendingRequests`).
 * A broker that has stopped answering holds that wait until each request's own
 * `requestTimeout` (30 s by default), and a request still connecting can hold
 * it longer. Nest awaits every provider's `onModuleDestroy`, so a publisher that
 * awaited `producer.disconnect()` kept `app.close()` pending after
 * `OutboxShutdown` had finished — past SHUTDOWN_TIMEOUT_MS, and the process
 * exited 1, forced (Codex r2 on #276, F2).
 *
 * So the close races the deadline the rest of the shutdown drains by. One that
 * finishes in time is a clean close. One that does not is abandoned with a
 * warning: the requests it was waiting for end with the process, which exits
 * moments later, and the outbox rows they carried were never acknowledged, so
 * the next process publishes them again (consumers dedupe on `eventId`). A
 * close that fails is logged the same way and does not fail the shutdown: the
 * client is left behind either way, and an abandoned one is not worse.
 *
 * Utility only (ADR-018): no business rule lives here.
 */

/** What this needs of a kafkajs client: a producer, a consumer, an admin. */
export interface Disconnectable {
  disconnect(): Promise<void>;
}

/** Where the warnings go. Nest's `Logger` and the platform logger both fit. */
export interface DisconnectLogger {
  warn(message: string): void;
}

export interface BoundedDisconnectOptions {
  /** Epoch milliseconds by which the close returns, finished or not. */
  deadlineAt: number;
  /** Names the client in the warnings: "Kafka producer". */
  label: string;
  logger: DisconnectLogger;
  /** Test seam. Default: `Date.now`. */
  now?: () => number;
}

/** How a close ended. Never a rejection. */
export type DisconnectOutcome = 'disconnected' | 'failed' | 'abandoned';

/**
 * The close of every client that has begun one. A second call for the same
 * client — a lifecycle hook arriving after a coordinated stop, a repeated
 * signal — joins the first close and its deadline instead of starting
 * another `disconnect()`.
 */
const closing = new WeakMap<Disconnectable, Promise<DisconnectOutcome>>();

/**
 * Disconnects `client`, returning by `deadlineAt` at the latest.
 *
 * Settles with how the close ended and never rejects. The timer is cleared as
 * soon as the close settles, and a close that fails after it was abandoned is
 * consumed here, so it cannot become an unhandled rejection in a process that
 * is already exiting.
 */
export function boundedDisconnect(
  client: Disconnectable,
  options: BoundedDisconnectOptions,
): Promise<DisconnectOutcome> {
  let outcome = closing.get(client);
  if (!outcome) {
    outcome = race(client, options);
    closing.set(client, outcome);
  }
  return outcome;
}

function race(
  client: Disconnectable,
  { deadlineAt, label, logger, now = Date.now }: BoundedDisconnectOptions,
): Promise<DisconnectOutcome> {
  return new Promise<DisconnectOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: DisconnectOutcome): void => {
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const boundMs = Math.max(0, deadlineAt - now());
    const timer = setTimeout(() => {
      if (settled) return;
      logger.warn(
        `${label}: disconnect did not finish by the shutdown deadline (${boundMs} ms); ` +
          'abandoned, its requests in flight end with the process',
      );
      settle('abandoned');
    }, boundMs);
    // `then(...)` so a synchronous throw is a failed close, not an exception here.
    Promise.resolve()
      .then(() => client.disconnect())
      .then(
        () => {
          if (!settled) settle('disconnected');
        },
        (error: unknown) => {
          if (settled) return;
          logger.warn(`${label}: disconnect failed: ${describeError(error)}`);
          settle('failed');
        },
      );
  });
}

/**
 * When a close that begins now must return: the outbox shutdown budget the
 * connection carries (`kafkaConnection`, from SHUTDOWN_TIMEOUT_MS), from now.
 *
 * The same deadline `OutboxShutdown` drains the relay and the purge by. Both
 * are measured from the start of Nest's destroy phase — a publisher's
 * `onModuleDestroy` and the coordinator's run in the same pass — so they land
 * on the same instant. A connection built without SHUTDOWN_TIMEOUT_MS (a
 * script's) gets the default timeout's budget.
 */
export function kafkaShutdownDeadline(
  connection: Pick<KafkaConnectionOptions, 'shutdownBudgetMs'>,
  now: () => number = Date.now,
): number {
  const budgetMs =
    connection.shutdownBudgetMs ??
    outboxShutdownBudgetMs({ SHUTDOWN_TIMEOUT_MS: DEFAULT_SHUTDOWN_TIMEOUT_MS });
  return now() + budgetMs;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 500);
  return String(error).slice(0, 500);
}
