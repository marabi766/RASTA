import { outboxPurgeBatchBoundMs, type OutboxPurgeEnv } from '@rasta/config';
import {
  outboxPurgedTotal,
  outboxPurgeLastSuccessSeconds,
  outboxPurgeRunsTotal,
} from '@rasta/observability';

import type { PurgePublishedBatch, PurgePublishedOptions } from './outbox-sql';

/**
 * Scheduled purge of published outbox rows (D-052).
 *
 * Every service's `outbox_message` keeps a row after the relay has published
 * it, and nothing deleted those rows: the table grew without bound. This runs
 * the bounded delete (`purgePublishedSql`) on a timer, in each service against
 * its own table, so there is one scheduler to get right rather than twelve.
 *
 * What it guarantees, and where each guarantee actually lives:
 *
 * - **Only published rows past the retention, never a live claim** — the SQL
 *   (`purgePublishedSql`), not this class.
 * - **Bounded work** — at most `maxBatchesPerRun` batches of `batchSize` rows
 *   per run, each batch its own short transaction under `statement_timeout`.
 * - **Runs never overlap in a process** — the next run is scheduled only once
 *   the previous one has finished (a `setTimeout` chain, not `setInterval`).
 * - **Several replicas are safe** — the SQL takes a transaction-scoped advisory
 *   lock per batch; a replica that finds it held ends its run as `busy`.
 * - **Never takes the service down** — a failed run is logged and counted, and
 *   the next one is scheduled as usual.
 * - **Shutdown waits for at most one batch** — `stop()` starts no further
 *   batch or run and waits for the one in flight no longer than its bound
 *   (`outboxPurgeBatchBoundMs`: the wait for a connection plus the
 *   transaction), which `loadEnv` holds under SHUTDOWN_TIMEOUT_MS. It is
 *   called from `onModuleDestroy`, so the purge halts as Nest's destroy phase
 *   begins, alongside the Prisma disconnect. From `onApplicationShutdown`
 *   alone, which Nest runs only after every provider was destroyed, a run
 *   would go on starting batches on a client that reconnects on demand.
 */

/** Persistence port, implemented by each service's outbox store. */
export interface OutboxPurgeStore {
  purgePublished(options: PurgePublishedOptions): Promise<PurgePublishedBatch>;
}

export interface OutboxPurgeSettings {
  enabled: boolean;
  retentionHours: number;
  intervalMs: number;
  batchSize: number;
  maxBatchesPerRun: number;
  statementTimeoutMs: number;
  /** Longest wait for a pooled connection before a batch's transaction starts. */
  maxWaitMs: number;
}

/** The validated environment (`outboxPurgeEnvSchema`) as scheduler settings. */
export function outboxPurgeSettings(env: OutboxPurgeEnv): OutboxPurgeSettings {
  return {
    enabled: env.OUTBOX_PURGE_ENABLED,
    retentionHours: env.OUTBOX_PURGE_RETENTION_HOURS,
    intervalMs: env.OUTBOX_PURGE_INTERVAL_SECONDS * 1000,
    batchSize: env.OUTBOX_PURGE_BATCH_SIZE,
    maxBatchesPerRun: env.OUTBOX_PURGE_MAX_BATCHES_PER_RUN,
    statementTimeoutMs: env.OUTBOX_PURGE_STATEMENT_TIMEOUT_MS,
    maxWaitMs: env.OUTBOX_PURGE_MAX_WAIT_MS,
  };
}

export interface OutboxPurgeLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface OutboxPurgeSchedulerOptions extends OutboxPurgeSettings {
  store: OutboxPurgeStore;
  /** The `service` label on the metrics and logs. */
  service: string;
  logger?: OutboxPurgeLogger;
  /**
   * Delay before the first run. Defaults to a random point within one
   * interval, so replicas rolled out together do not all purge at once.
   */
  initialDelayMs?: number;
  /** Injection seam for the tests; nothing else should pass this. */
  now?: () => number;
}

/**
 * How a run ended.
 *
 * - `completed` — a batch came back short: nothing due is left.
 * - `truncated` — `maxBatchesPerRun` full batches; more is due, and the next
 *   run continues. Persistently truncated means the purge is falling behind.
 * - `busy` — another replica held the purge lock; it is purging instead.
 * - `failed` — a batch threw. Rows already deleted stay deleted.
 * - `stopped` — shutdown began before the next batch.
 */
export type OutboxPurgeOutcome = 'completed' | 'truncated' | 'busy' | 'failed' | 'stopped';

export interface OutboxPurgeRun {
  outcome: OutboxPurgeOutcome;
  deleted: number;
  batches: number;
  durationMs: number;
}

export class OutboxPurgeScheduler {
  private timer?: NodeJS.Timeout;
  /** Not scheduling: before `start()`, when disabled, or after `stop()`. */
  private stopped = true;
  /** `stop()` was called: a run in flight ends after its current batch. */
  private halting = false;
  private current?: Promise<OutboxPurgeRun>;
  private readonly now: () => number;
  /** The most `stop()` waits for the batch in flight. */
  readonly stopBoundMs: number;

  constructor(private readonly options: OutboxPurgeSchedulerOptions) {
    // The environment schema already bounds these; a direct caller is held to
    // the same rule rather than trusted, because a zero batch size would make
    // every run "complete" without deleting anything.
    for (const name of [
      'retentionHours',
      'intervalMs',
      'batchSize',
      'maxBatchesPerRun',
      'statementTimeoutMs',
      'maxWaitMs',
    ] as const) {
      const value = options[name];
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(
          `OutboxPurgeScheduler: ${name} must be a positive integer, received ${value}`,
        );
      }
    }
    this.now = options.now ?? Date.now;
    this.stopBoundMs = outboxPurgeBatchBoundMs(options);
  }

  /** Schedules the first run. A no-op when disabled, apart from saying so. */
  start(): void {
    if (!this.stopped) return;
    const { enabled, service, retentionHours, intervalMs, batchSize, maxBatchesPerRun } =
      this.options;

    if (!enabled) {
      this.options.logger?.warn(
        { service },
        'Outbox purge is disabled (OUTBOX_PURGE_ENABLED=false): published outbox rows are ' +
          'kept indefinitely and outbox_message grows without bound (D-052)',
      );
      return;
    }

    this.stopped = false;
    this.halting = false;
    this.options.logger?.info(
      { service, retentionHours, intervalMs, batchSize, maxBatchesPerRun },
      'Outbox purge scheduled',
    );
    this.schedule(this.options.initialDelayMs ?? Math.floor(Math.random() * intervalMs));
  }

  /**
   * Stops the purge: no further run is scheduled, a run in flight starts no
   * further batch, and the batch in flight is waited for at most
   * `stopBoundMs` — the longest it can take. Past that it is abandoned with a
   * warning rather than awaited: the database's `statement_timeout` and the
   * transaction timeout still end it, and the rows it would have deleted are
   * due again at the next start. Idempotent.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.halting = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;

    const current = this.current;
    if (!current) return;
    let deadline: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      current.then(() => 'finished' as const),
      new Promise<'abandoned'>((resolve) => {
        deadline = setTimeout(() => resolve('abandoned'), this.stopBoundMs);
        deadline.unref?.();
      }),
    ]);
    clearTimeout(deadline);
    if (outcome === 'abandoned') {
      this.options.logger?.warn(
        { service: this.options.service, stopBoundMs: this.stopBoundMs },
        'Outbox purge batch still running at its bound on shutdown; abandoned. Its statement ' +
          'and transaction timeouts end it, and the rows stay due for the next start',
      );
    }
  }

  /** Nest's destroy phase, alongside the Prisma disconnect (see the class comment). */
  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /**
   * One run, now. Used by the timer; exposed so an operator task or a test can
   * drive it directly. A call while a run is in flight joins that run.
   */
  runOnce(): Promise<OutboxPurgeRun> {
    this.current ??= this.run().finally(() => {
      this.current = undefined;
    });
    return this.current;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      void this.runOnce().then(() => {
        if (!this.stopped) this.schedule(this.options.intervalMs);
      });
    }, delayMs);
    // Do not hold the event loop open on shutdown.
    this.timer.unref?.();
  }

  private async run(): Promise<OutboxPurgeRun> {
    const { store, service, batchSize, maxBatchesPerRun, statementTimeoutMs, maxWaitMs } =
      this.options;
    const startedAt = this.now();
    const request: PurgePublishedOptions = {
      retentionSeconds: this.options.retentionHours * 3600,
      limit: batchSize,
      statementTimeoutMs,
      maxWaitMs,
    };

    let deleted = 0;
    let batches = 0;
    let outcome: OutboxPurgeOutcome = 'truncated';

    try {
      while (batches < maxBatchesPerRun) {
        // Checked before every batch, the first included, so nothing starts
        // once `stop()` was called; a batch already sent runs to its end (or
        // its timeout), and stopping here leaves nothing half-done.
        if (this.halting) {
          outcome = 'stopped';
          break;
        }
        const batch = await store.purgePublished(request);
        if (batch.busy) {
          outcome = 'busy';
          break;
        }
        batches += 1;
        deleted += batch.deleted;
        // Counted per batch, so rows deleted before a later batch fails are
        // still on the counter.
        if (batch.deleted > 0) outboxPurgedTotal.inc({ service }, batch.deleted);
        if (batch.deleted < batchSize) {
          outcome = 'completed';
          break;
        }
      }
    } catch (error) {
      outcome = 'failed';
      this.options.logger?.error(
        { service, err: error, deleted, batches },
        'Outbox purge run failed; the next run is scheduled as usual',
      );
    }

    const run: OutboxPurgeRun = { outcome, deleted, batches, durationMs: this.now() - startedAt };
    outboxPurgeRunsTotal.inc({ service, outcome });
    if (outcome === 'completed' || outcome === 'truncated') {
      outboxPurgeLastSuccessSeconds.set({ service }, Math.floor(Date.now() / 1000));
    }
    this.log(run);
    return run;
  }

  private log(run: OutboxPurgeRun): void {
    const logger = this.options.logger;
    if (!logger || run.outcome === 'failed') return;
    const fields = {
      service: this.options.service,
      outcome: run.outcome,
      deleted: run.deleted,
      batches: run.batches,
      durationMs: run.durationMs,
      retentionHours: this.options.retentionHours,
    };
    if (run.outcome === 'truncated') {
      logger.warn(
        { ...fields, maxBatchesPerRun: this.options.maxBatchesPerRun },
        'Outbox purge reached its per-run batch cap; more published rows are due and the next ' +
          'run continues. If this persists, raise OUTBOX_PURGE_MAX_BATCHES_PER_RUN or ' +
          'OUTBOX_PURGE_BATCH_SIZE, or shorten OUTBOX_PURGE_INTERVAL_SECONDS',
      );
    } else if (run.deleted > 0) {
      logger.info(fields, 'Outbox purge deleted published rows past their retention');
    } else {
      logger.debug(fields, 'Outbox purge run finished');
    }
  }
}
