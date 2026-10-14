import type { OutboxStopOptions } from './outbox';

/**
 * One shutdown deadline for a service's outbox work: the relay and the purge
 * (D-052).
 *
 * Each has its own bound — the relay keeps renewing an in-flight publish for
 * up to `OUTBOX_SHUTDOWN_GRACE_SECONDS`, the purge waits for its batch for up
 * to `outboxPurgeBatchBoundMs` — and each fit SHUTDOWN_TIMEOUT_MS on its own.
 * Stopped one after the other (the purge in Nest's destroy phase, the relay in
 * `onApplicationShutdown`) the two waits added up past it, and the process
 * exited forced, mid-close (Codex r2 on #247).
 *
 * So this starts both drains at once, in Nest's destroy phase — the earliest
 * hook `app.close()` runs, alongside every other provider's — and hands both
 * the same deadline: `budgetMs` from the moment the first stop began
 * (`outboxShutdownBudgetMs`, SHUTDOWN_TIMEOUT_MS less a reserve for the rest
 * of the close). Each waits for the earlier of its own bound and that
 * deadline, so the path takes the longer of the two waits rather than their
 * sum, and `loadEnv` refuses a configuration in which either one's own bound
 * does not fit the budget.
 *
 * A service's other background loops that write through the same database
 * (`workers`: document-service's scan worker) stop here too, by the same
 * deadline (Codex r3 on #247). Stopped later, in `onApplicationShutdown`, one
 * kept polling while the relay drained and then waited for its own unit of
 * work on top of the relay's — the same sum this coordinator exists to avoid.
 *
 * `stop()` is one promise: a later call — `onApplicationShutdown` confirming
 * the stop, a repeated signal — joins it, and once it has returned, returns at
 * once. Cross-cutting mechanism only (ADR-018).
 */

/** What the coordinator needs of a component: a stop that honours a deadline. */
export interface OutboxStoppable {
  stop(options?: OutboxStopOptions): Promise<void>;
}

export interface OutboxShutdownOptions {
  relay: OutboxStoppable;
  /** Absent in a service that does not run the purge. */
  purge?: OutboxStoppable;
  /**
   * Other background loops stopped in the same phase by the same deadline. Each
   * must stop polling at once and return by `deadlineAt`, abandoning its unit
   * of work in a state another instance can take over.
   */
  workers?: readonly OutboxStoppable[];
  /** The shared budget, from the first `stop()` (`outboxShutdownBudgetMs`). */
  budgetMs: number;
  /** Injection seam for the tests; nothing else should pass this. */
  now?: () => number;
}

export class OutboxShutdown {
  private stopping?: Promise<void>;
  private readonly now: () => number;

  constructor(private readonly options: OutboxShutdownOptions) {
    if (!Number.isSafeInteger(options.budgetMs) || options.budgetMs < 1) {
      throw new Error(
        `OutboxShutdown: budgetMs must be a positive integer, received ${options.budgetMs}`,
      );
    }
    this.now = options.now ?? Date.now;
  }

  /** Drains the relay, the purge and the workers concurrently, all by one deadline. */
  stop(): Promise<void> {
    this.stopping ??= this.drain();
    return this.stopping;
  }

  /** Nest's destroy phase: the drain begins with the close, not after the HTTP server. */
  onModuleDestroy(): Promise<void> {
    return this.stop();
  }

  private async drain(): Promise<void> {
    const deadlineAt = this.now() + this.options.budgetMs;
    await Promise.all([
      this.options.relay.stop({ deadlineAt }),
      this.options.purge?.stop({ deadlineAt }),
      ...(this.options.workers ?? []).map((worker) => worker.stop({ deadlineAt })),
    ]);
  }
}
