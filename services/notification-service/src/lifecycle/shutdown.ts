import type { OnModuleDestroy } from '@nestjs/common';
import type { ScrubbedLogger } from '../logging/scrub';

/**
 * One shutdown deadline for this service's background work: the outbox relay,
 * the resolution worker and the mail worker.
 *
 * Nothing stopped the relay before. `AppModule` had no shutdown hook and
 * nothing called `relay.stop()`, while `KafkaEventPublisher` closed in the
 * destroy phase — so through the whole close the relay kept claiming rows it
 * could no longer publish, and each one sat under its lease until that
 * expired. The two workers stopped only in `onApplicationShutdown`, and each
 * waited for its batch with no limit.
 *
 * So this stops all three at once, in Nest's destroy phase — the earliest hook
 * `app.close()` runs, beside every other provider's — and hands them one
 * deadline: `budgetMs` from the moment the stop began
 * ({@link notificationShutdownBudgetMs}, SHUTDOWN_TIMEOUT_MS less a reserve for
 * the rest of the close). The close then takes the longest of the three waits,
 * not their sum, and ends inside SHUTDOWN_TIMEOUT_MS with exit 0 instead of
 * being cut off by the forced exit.
 *
 * The shape is #247's `OutboxShutdown` (D-052), which is not on main yet; this
 * is the service-local equivalent, to be replaced by it once it is. The relay
 * here has no deadline of its own to take — its grace bounds the wait for a
 * publish in flight, and nothing bounds the release after it — so the whole
 * `relay.stop()` is bounded from outside.
 *
 * `stop()` is one promise: a later call joins it.
 */

/**
 * The part of SHUTDOWN_TIMEOUT_MS kept back for what `app.close()` still does
 * after the drain: `beforeApplicationShutdown`, the HTTP server close and
 * `onApplicationShutdown`. The same 2 s #247 keeps (`OUTBOX_SHUTDOWN_RESERVE_MS`).
 */
export const SHUTDOWN_RESERVE_MS = 2_000;

/** How long the drain may take: SHUTDOWN_TIMEOUT_MS less {@link SHUTDOWN_RESERVE_MS}. */
export function notificationShutdownBudgetMs(env: { SHUTDOWN_TIMEOUT_MS: number }): number {
  return env.SHUTDOWN_TIMEOUT_MS - SHUTDOWN_RESERVE_MS;
}

/** What a stop is told by the shutdown: the epoch milliseconds it must return by. */
export interface ShutdownStopOptions {
  deadlineAt?: number;
}

/** A component that stops polling at once and returns by `deadlineAt`. */
export interface DeadlineStoppable {
  stop(options?: ShutdownStopOptions): Promise<void>;
}

/**
 * How `work` ended within `boundMs`: `finished`, or `abandoned` once the bound
 * passed first. A rejection counts as finished (the callers handle their own
 * errors), and the timer is cleared and unreferenced either way.
 */
export async function withinDeadline(
  work: Promise<unknown>,
  boundMs: number,
): Promise<'finished' | 'abandoned'> {
  if (boundMs <= 0) {
    // Abandoned, but never left to reject unhandled.
    work.catch(() => undefined);
    return 'abandoned';
  }
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    work.then(
      () => 'finished' as const,
      () => 'finished' as const,
    ),
    new Promise<'abandoned'>((resolve) => {
      timer = setTimeout(() => resolve('abandoned'), boundMs);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
  return outcome;
}

export interface NotificationShutdownOptions {
  /** The outbox relay; its `stop()` takes no deadline, so it is bounded here. */
  relay: { stop(): Promise<void> };
  /** The resolution and mail workers, stopped by the same deadline. */
  workers: readonly DeadlineStoppable[];
  /** The shared budget, from the first `stop()` ({@link notificationShutdownBudgetMs}). */
  budgetMs: number;
  logger?: ScrubbedLogger;
  /** Injection seam for the tests; nothing else should pass this. */
  now?: () => number;
}

export class NotificationShutdown implements OnModuleDestroy {
  private stopping?: Promise<void>;
  private readonly now: () => number;

  constructor(private readonly options: NotificationShutdownOptions) {
    if (!Number.isSafeInteger(options.budgetMs) || options.budgetMs < 1) {
      throw new Error(
        `NotificationShutdown: budgetMs must be a positive integer, received ${options.budgetMs} ` +
          `(SHUTDOWN_TIMEOUT_MS must be more than ${SHUTDOWN_RESERVE_MS} ms)`,
      );
    }
    this.now = options.now ?? Date.now;
  }

  /** Stops the relay and the workers concurrently, all by one deadline. */
  stop(): Promise<void> {
    this.stopping ??= this.drain();
    return this.stopping;
  }

  /** Nest's destroy phase: the drain begins with the close. */
  onModuleDestroy(): Promise<void> {
    return this.stop();
  }

  private async drain(): Promise<void> {
    const deadlineAt = this.now() + this.options.budgetMs;
    await Promise.all([
      this.stopRelay(deadlineAt),
      ...this.options.workers.map((worker) => worker.stop({ deadlineAt })),
    ]);
  }

  private async stopRelay(deadlineAt: number): Promise<void> {
    const outcome = await withinDeadline(this.options.relay.stop(), deadlineAt - this.now());
    if (outcome === 'abandoned') {
      // Safe: a row not released returns to the queue when its lease expires.
      this.options.logger?.warn(
        'Outbox relay still stopping at the shutdown deadline; abandoned. Rows it still ' +
          'holds return to the queue when their lease expires',
      );
    }
  }
}
