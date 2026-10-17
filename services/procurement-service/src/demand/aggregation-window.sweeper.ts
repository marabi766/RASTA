import { Logger } from '@nestjs/common';
import { RastaError, withinDeadline, type OutboxStopOptions } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { SERVICE_NAME } from '../config/env';
import { windowSweepTotal } from '../observability/metrics';
import { WindowSweepRepository } from './window-sweep.repository';
import { WindowSweepService, type SweepResult } from './window-sweep.service';

export interface AggregationWindowSweeperOptions {
  /** How often a sweep runs. */
  intervalMs: number;
  /** Windows claimed per sweep. */
  batchSize: number;
  /** How long a claim holds before another sweeper may take the window; renewed by every step. */
  leaseSeconds: number;
  /** A failed window waits `min(max, base × 2^attempts)` seconds before it is claimed again. */
  retryBackoffBaseSeconds: number;
  retryBackoffMaxSeconds: number;
}

export interface WindowSweepOutcome {
  claimed: number;
  /** Windows this sweep ended. */
  ended: number;
  /** Batches of an ended window's demands moved. */
  followed: number;
  /** Ended by someone else, nothing to follow. */
  noop: number;
  /** Moved on after the claim (a demand extended it): given back, still OPEN. */
  notDue: number;
  /** The claim was taken back before the write: nothing was changed. */
  lost: number;
  /** Failed; counted, and the window is taken again only after its backoff. */
  failed: number;
}

const COUNTED: Record<SweepResult, keyof Omit<WindowSweepOutcome, 'claimed' | 'failed'>> = {
  ENDED: 'ended',
  FOLLOWED: 'followed',
  NOOP: 'noop',
  NOT_DUE: 'notDue',
  NOT_OWNER: 'lost',
  NOT_FOUND: 'noop',
};

const METRIC_RESULT: Record<SweepResult, string> = {
  ENDED: 'ended',
  FOLLOWED: 'followed',
  NOOP: 'noop',
  NOT_DUE: 'not_due',
  NOT_OWNER: 'lost',
  NOT_FOUND: 'noop',
};

/**
 * Ends the aggregation windows whose `closes_at` has passed (ADR-070 § 2, plan PR 2), so a window
 * ends on time whether or not another demand for its product ever arrives — the shape of
 * construction's `TenderCloseSweeper` (ADR-065 § 3). Each sweep claims a bounded batch of windows
 * in one statement (`FOR UPDATE SKIP LOCKED`, a lease and a fencing token), so any number of
 * instances may run, and sweeps each in short transactions of its own, in the window's own tenant,
 * via `WindowSweepService`: the end, then — for a REFERRED or LAPSED window of more live demands
 * than one transaction moves — one transaction per further batch, renewing the lease each time,
 * until every demand followed it or this process stops.
 *
 * Bounded by configuration: windows per sweep, demands per transaction, the interval. One window
 * failing never stalls the batch, and never starves the queue: its attempts are counted and it is
 * not claimed again until a bounded exponential backoff has passed
 * (`RastaProcurementWindowSweepRetriesHigh` alerts on one that keeps failing). Nothing here is
 * required for a demand to stay out of an ended window — that is the database's clock, read after
 * the window's lock by every submit — so a sweeper that is down delays only the state.
 */
export class AggregationWindowSweeper {
  private readonly logger = new Logger(AggregationWindowSweeper.name);
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<unknown>;
  private stopping?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly sweeps: WindowSweepRepository,
    private readonly service: WindowSweepService,
    private readonly options: AggregationWindowSweeperOptions,
  ) {}

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      // Never overlap with itself: a slow sweep is followed by the next tick.
      if (this.inFlight) return;
      this.inFlight = this.runOnce()
        .catch((error: unknown) => {
          // A sweep that fails as a whole (the database is down) is retried by the next tick;
          // the windows are still due.
          this.logger.error(`Aggregation window sweep failed: ${codeOf(error)}`);
        })
        .finally(() => {
          this.inFlight = undefined;
        });
    }, this.options.intervalMs);
    this.timer.unref?.();
  }

  /**
   * Stops the timer at once, lets a sweep in flight start no further step, and waits for the one
   * running — at most until `deadlineAt`, the shutdown's shared deadline (`OutboxShutdown` calls
   * this in Nest's destroy phase, beside the relay and the purge; D-052), so no step writes an
   * outbox row after the relay drained.
   *
   * Past the deadline the sweep is abandoned with a warning: each step and its event commit in
   * one transaction, so an exit rolls back the one in flight, and the lease lets the next sweep,
   * anywhere, take that window and the rest of the batch again. Without a deadline it waits. One
   * stop per process.
   */
  stop(options: OutboxStopOptions = {}): Promise<void> {
    this.stopping ??= this.halt(options.deadlineAt);
    return this.stopping;
  }

  private async halt(deadlineAt: number | undefined): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;

    const current = this.inFlight;
    if (!current) return;
    if (deadlineAt === undefined) {
      await current;
      return;
    }
    if ((await withinDeadline(current, deadlineAt - Date.now())) === 'abandoned') {
      this.logger.warn(
        'Aggregation window sweep still running at the shutdown deadline; abandoned. The step ' +
          'in flight rolls back and its lease lets the next sweep take the window again',
      );
    }
  }

  /** One sweep. Public so a test, or an operator's tool, can drive it. */
  async runOnce(): Promise<WindowSweepOutcome> {
    const fence = ulid();
    const claimed = await this.sweeps.claimDue(
      this.options.batchSize,
      this.options.leaseSeconds,
      fence,
    );
    const outcome: WindowSweepOutcome = {
      claimed: claimed.length,
      ended: 0,
      followed: 0,
      noop: 0,
      notDue: 0,
      lost: 0,
      failed: 0,
    };

    for (const window of claimed) {
      const target = {
        organizationId: window.organizationId,
        aggregationId: window.id,
        fence: window.fence,
      };
      // One window: its end, then a step per batch of demands still to follow it.
      for (;;) {
        // Stopping: the window keeps its claim until the lease runs out, then any sweep takes it.
        if (this.stopped) break;
        try {
          const step = await this.service.step(target, this.options.leaseSeconds);
          outcome[COUNTED[step.result]] += 1;
          windowSweepTotal.inc({ service: SERVICE_NAME, result: METRIC_RESULT[step.result] });
          if (step.demandsToFollow === 0) break;
        } catch (error) {
          outcome.failed += 1;
          windowSweepTotal.inc({ service: SERVICE_NAME, result: 'failed' });
          this.logger.warn(
            `Sweeping aggregation window ${window.id} failed: ${codeOf(error)}; retried after a backoff`,
          );
          try {
            await this.service.recordFailure(target, {
              baseSeconds: this.options.retryBackoffBaseSeconds,
              maxSeconds: this.options.retryBackoffMaxSeconds,
            });
          } catch (recordError) {
            // The lease running out is the fallback retry.
            this.logger.warn(
              `Recording the failed sweep of aggregation window ${window.id} failed: ${codeOf(recordError)}`,
            );
          }
          break;
        }
      }
      if (this.stopped) break;
    }

    if (outcome.claimed > 0) {
      this.logger.log(
        `Aggregation window sweep: claimed ${outcome.claimed}, ended ${outcome.ended}, ` +
          `followed ${outcome.followed}, noop ${outcome.noop}, not due ${outcome.notDue}, ` +
          `lost ${outcome.lost}, failed ${outcome.failed}`,
      );
    }
    return outcome;
  }
}

/** The closed code recorded for a failure: a platform error code, or `INTERNAL`. */
function codeOf(error: unknown): string {
  return error instanceof RastaError ? error.code : 'INTERNAL';
}
