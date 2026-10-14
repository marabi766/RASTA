import { withinDeadline, type OutboxStopOptions } from '@rasta/nest-common';
import type { InsuranceService } from './insurance.service';

/** How often the expiry sweep runs. */
export const EXPIRY_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** What the scheduler logs through. */
export interface ExpirySweepLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * The timer that runs {@link InsuranceService.runExpirySweep}.
 *
 * An interval, not a scheduler, for the MVP. It is honest about what it is:
 * with several replicas every one of them sweeps, which the outbox and
 * idempotent consumers already absorb. When Temporal takes over the scheduled
 * work (ADR-013), this moves there and the method stays.
 *
 * Its own class rather than a timer in `AppModule` so the shutdown can stop it
 * (#247 r4, Codex r3): `OutboxShutdown` calls {@link stop} in Nest's destroy
 * phase beside the relay and the purge. Cleared only in `onApplicationShutdown`
 * and never awaited, a sweep could start or keep writing outbox rows while the
 * relay drained.
 */
export class InsuranceExpirySweepScheduler {
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private stopping?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly insurance: InsuranceService,
    private readonly logger?: ExpirySweepLogger,
  ) {}

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.runOnce(), EXPIRY_SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** One sweep, now; a call while one runs joins it. Nothing once stopped. */
  runOnce(): Promise<void> {
    if (this.stopped) return this.inFlight ?? Promise.resolve();
    this.inFlight ??= this.insurance
      .runExpirySweep({ shouldStop: () => this.stopped })
      .then(
        () => undefined,
        () => {
          // Already logged inside; a failed sweep retries on the next tick.
        },
      )
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  /**
   * Stops the timer at once, lets a sweep in flight start no further batch, and
   * waits for the batch running — at most until `deadlineAt`, the shutdown's
   * shared deadline. Past it the sweep is abandoned with a warning: every batch
   * commits whole, so an exit rolls back the one in flight and the next sweep
   * finds its policies again. Without a deadline it waits. One stop per process.
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
      this.logger?.warn(
        {},
        'Insurance expiry sweep still running at the shutdown deadline; abandoned. The batch ' +
          'in flight rolls back and the next sweep finds its policies again',
      );
    }
  }
}
