import { Logger } from '@nestjs/common';
import { RastaError, withinDeadline, type OutboxStopOptions } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { SERVICE_NAME } from '../config/env';
import { ReservationExpiry } from './expiry';
import { ReservationRepository, type DueItem } from './reservation.repository';

export interface SweeperOptions {
  /** How often a sweep runs — and how long one sweep may keep working off backlogs. */
  intervalMs: number;
  /** Stock items handled per sweep. */
  batchSize: number;
}

export interface SweepOutcome {
  /** Stock items found holding a due reservation. */
  due: number;
  /** Reservations expired by this sweep. */
  expired: number;
  /** Items another transaction held: left for it (it expires them itself) or the next sweep. */
  skipped: number;
  /** Items whose expiry failed; retried by the next sweep. */
  failed: number;
  /** Items still holding due reservations when the sweep's time ran out; the next sweep goes on. */
  backlogged: number;
}

/** The closed code recorded for a failure: a platform error code, or `INTERNAL`. */
function errorCodeOf(error: unknown): string {
  return error instanceof RastaError ? error.code : 'INTERNAL';
}

/**
 * Releases reservations past their `expiresAt` on stock items nobody is touching (Q-102,
 * `ReservationExpiry`).
 *
 * Each sweep asks which (owner, stock item) pairs hold a due reservation, then handles each item
 * in its own short transaction (`ReservationExpiry.expireBatch`): lock the item with
 * `SKIP LOCKED` — a command holding it expires its due reservations itself, so there is nothing
 * to wait for — and expire one batch of what is still due under that lock. Item first,
 * reservation second, as every command does, so the sweeper never deadlocks with one. Any number
 * of instances may run: two sweepers on one item serialise on its lock, and the second finds
 * nothing left due.
 *
 * A batch is committed before the next begins: an item with a backlog larger than a batch is
 * worked off pass after pass, every item of the sweep getting its batch in each pass, for at most
 * one interval — whatever is left then is the next sweep's, and nothing done so far is lost.
 *
 * One item failing never stalls the batch, and a sweep never overlaps the previous one.
 *
 * `OutboxShutdown` stops it in Nest's destroy phase, beside the relay and the purge, by their
 * shared deadline (D-052): every batch writes outbox rows, and a sweeper stopped later kept
 * writing them while the relay drained.
 */
export class ReservationSweeper {
  private readonly logger = new Logger(ReservationSweeper.name);
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<unknown>;
  private stopping?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly reservations: ReservationRepository,
    private readonly expiry: ReservationExpiry,
    private readonly options: SweeperOptions,
  ) {}

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      if (this.inFlight || this.stopped) return;
      this.inFlight = this.runOnce()
        .catch((error: unknown) => {
          // A sweep that fails as a whole (the database is down) is retried by the next tick;
          // the reservations are still due.
          this.logger.error(`Reservation expiry sweep failed: ${errorCodeOf(error)}`);
        })
        .finally(() => {
          this.inFlight = undefined;
        });
    }, this.options.intervalMs);
    this.timer.unref?.();
  }

  /**
   * Stops the timer at once, lets a sweep in flight start no further batch, and waits for the
   * batch running — at most until `deadlineAt`, the shutdown's shared deadline. Past it the sweep
   * is abandoned with a warning: each batch commits whole, so an exit rolls back the one in
   * flight and the next sweep, anywhere, finds its reservations again. Without a deadline it
   * waits. One stop per process.
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
        'Reservation expiry sweep still running at the shutdown deadline; abandoned. The batch ' +
          'in flight rolls back and the next sweep finds its reservations again',
      );
    }
  }

  /** One sweep. Public so a test, or an operator's tool, can drive it. */
  async runOnce(): Promise<SweepOutcome> {
    const startedAt = Date.now();
    const due = await this.reservations.dueItems(this.options.batchSize);
    const outcome: SweepOutcome = {
      due: due.length,
      expired: 0,
      skipped: 0,
      failed: 0,
      backlogged: 0,
    };

    let pending: DueItem[] = due;
    while (pending.length > 0) {
      const again: DueItem[] = [];
      for (const target of pending) {
        // Stopping: an item not reached keeps its due reservations for the next sweep.
        if (this.stopped || (await this.sweepItem(target, outcome))) again.push(target);
      }
      if (again.length > 0 && (this.stopped || Date.now() - startedAt >= this.options.intervalMs)) {
        outcome.backlogged = again.length;
        break;
      }
      pending = again;
    }

    if (outcome.expired > 0 || outcome.failed > 0) {
      this.logger.log(
        `${SERVICE_NAME} expiry sweep: ${outcome.expired} expired, ${outcome.skipped} skipped, ${outcome.failed} failed, ${outcome.backlogged} backlogged`,
      );
    }
    return outcome;
  }

  /** One batch of one item, committed. Whether a backlog remains for another pass. */
  private async sweepItem(
    { organizationId, stockItemId }: DueItem,
    outcome: SweepOutcome,
  ): Promise<boolean> {
    try {
      const batch = await this.expiry.expireBatch(organizationId, stockItemId, ulid(), 'sweeper');
      if (batch === null) {
        outcome.skipped += 1;
        return false;
      }
      outcome.expired += batch.expired;
      // A batch that expired nothing would expire nothing again: no second pass for it.
      return batch.backlog && batch.expired > 0;
    } catch (error) {
      outcome.failed += 1;
      this.logger.error(
        `Could not expire the due reservations of a stock item (${errorCodeOf(error)}); the next sweep retries`,
      );
      return false;
    }
  }
}
