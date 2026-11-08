import { Logger } from '@nestjs/common';
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
 * The service's Kafka publisher (`publishers`) closes last, once that drain
 * has returned, and by the same deadline (D-052 phase 4b, Codex r1 on #293).
 * Its own `onModuleDestroy` ran beside this one and counted a budget of its
 * own; where the relay still drained in `onApplicationShutdown`, that drain
 * began only after the publisher had spent its budget, and the two added up
 * past SHUTDOWN_TIMEOUT_MS. Closed here, the publisher gets what the drain
 * left of the one budget — none, when the relay waited the deadline out on a
 * publish the broker never answered, and then its close is abandoned at once —
 * and the relay never publishes through a producer that is already closing.
 *
 * The service's database pools (`databases`) close last of all, once the
 * drain **and** the publishers' close have returned, by the same deadline
 * (Codex r2 on #458, F2). Each pool's own `onModuleDestroy` ran beside this
 * one — Nest runs every provider's destroy hook at once — so a pool could
 * disconnect while a worker it stops here still flushed through it, and the
 * worker's next statement reconnected it. A service that passes its pools
 * here gives them no destroy hook of their own.
 *
 * **A failure never ends a phase early** (Codex r3 on #458, F7). Each phase —
 * the drain, the publishers, the databases — waits for **every** one of its
 * participants to settle, each by its own bound on the deadline, before the
 * next begins; one that fails is logged and collected, and the wait for its
 * siblings goes on. Only once the last phase settled is the failure rethrown
 * (several: one `AggregateError` of them all). Before, the phase's
 * `Promise.all` rejected at the first failure — a Kafka disconnect that
 * failed — and the next phase began beside a worker still draining: its
 * pools closed under it. A service gains only that wait; nothing that used
 * to stop is refused.
 *
 * `stop()` is one promise: a later call — `onApplicationShutdown` confirming
 * the stop, a repeated signal — joins it, and once it has returned, returns at
 * once. Cross-cutting mechanism only (ADR-018).
 */

/**
 * What the coordinator needs of a component: a stop that honours a deadline.
 * What it resolves to is the component's own report (a pool: how many
 * transactions it left unsettled); the coordinator does not read it.
 */
export interface OutboxStoppable {
  stop(options?: OutboxStopOptions): Promise<unknown>;
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
  /**
   * Closed after the relay, the purge and the workers have returned — whether
   * they stopped or failed to — by the same deadline: the service's Kafka
   * publisher, whose producer the relay publishes through.
   */
  publishers?: readonly OutboxStoppable[];
  /**
   * Closed last, after the relay, the purge, the workers and the publishers
   * have all returned, by the same deadline: the service's database pools,
   * which every one of them may use until it returns. Each waits, by the
   * deadline, for the transactions still in flight on it, then refuses
   * everything and disconnects.
   */
  databases?: readonly OutboxStoppable[];
  /** The shared budget, from the first `stop()` (`outboxShutdownBudgetMs`). */
  budgetMs: number;
  /** Injection seam for the tests; nothing else should pass this. */
  now?: () => number;
  /** Where each participant's failure is logged; Nest's logger when absent. */
  logger?: Pick<Logger, 'error'>;
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

  /**
   * Drains the relay, the purge and the workers concurrently, then closes the
   * publishers, then the databases, all by one deadline.
   */
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
    const failures: unknown[] = [];
    await this.phase(
      'drain',
      failures,
      [
        this.options.relay,
        ...(this.options.purge ? [this.options.purge] : []),
        ...(this.options.workers ?? []),
      ],
      deadlineAt,
    );
    // After the drain, never beside it: a publish still in flight is the
    // relay's to finish or abandon, by the deadline, before its producer
    // closes. A drain that failed still leaves a producer to close.
    await this.phase('publishers', failures, this.options.publishers ?? [], deadlineAt);
    // Last of all: nothing that could still use a pool is running.
    await this.phase('databases', failures, this.options.databases ?? [], deadlineAt);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, `OutboxShutdown: ${failures.length} stops failed`);
    }
  }

  /** Every participant settled — each by its own bound — before this returns; failures collected. */
  private async phase(
    name: string,
    failures: unknown[],
    participants: readonly OutboxStoppable[],
    deadlineAt: number,
  ): Promise<void> {
    const settled = await Promise.allSettled(
      // A stop that throws instead of rejecting is a failure of the same kind.
      participants.map(async (participant) => participant.stop({ deadlineAt })),
    );
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') continue;
      failures.push(outcome.reason);
      const error = outcome.reason instanceof Error ? outcome.reason : undefined;
      (this.options.logger ?? new Logger(OutboxShutdown.name)).error(
        `Shutdown phase ${name}: a stop failed (${error ? error.message : String(outcome.reason)}); ` +
          'the phase still waited for every other participant',
        error?.stack,
      );
    }
  }
}
