import { Logger } from '@nestjs/common';
import { RastaError, createSystemContext, runWithContext } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { SERVICE_NAME } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { transactionNow } from '../shared/clock';
import { boundLockWaits } from '../shared/command';
import { StockRepository } from '../stock/stock.repository';
import { ReservationExpiry } from './expiry';
import { ReservationRepository } from './reservation.repository';

export interface SweeperOptions {
  /** How often a sweep runs. */
  intervalMs: number;
  /** Stock items handled per sweep. */
  batchSize: number;
  /** INVENTORY_LOCK_TIMEOUT_MS: the bound on any one statement's lock wait. */
  lockTimeoutMs: number;
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
 * in its own short transaction: lock the item with `SKIP LOCKED` — a command holding it expires
 * its due reservations itself, so there is nothing to wait for — and expire what is still due
 * under that lock. Item first, reservation second, as every command does, so the sweeper never
 * deadlocks with one. Any number of instances may run: two sweepers on one item serialise on its
 * lock, and the second finds nothing left due.
 *
 * One item failing never stalls the batch, and a sweep never overlaps the previous one.
 */
export class ReservationSweeper {
  private readonly logger = new Logger(ReservationSweeper.name);
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<unknown>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly reservations: ReservationRepository,
    private readonly stock: StockRepository,
    private readonly expiry: ReservationExpiry,
    private readonly options: SweeperOptions,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.inFlight) return;
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

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  /** One sweep. Public so a test, or an operator's tool, can drive it. */
  async runOnce(): Promise<SweepOutcome> {
    const due = await this.reservations.dueItems(this.options.batchSize);
    const outcome: SweepOutcome = { due: due.length, expired: 0, skipped: 0, failed: 0 };

    for (const { organizationId, stockItemId } of due) {
      const correlationId = ulid();
      const context = createSystemContext({ correlationId, organizationId });
      try {
        const expired = await runWithContext(context, () =>
          this.prisma.transaction(
            async (tx) => {
              await boundLockWaits(tx, this.options.lockTimeoutMs);
              const at = await transactionNow(tx);
              const item = await this.stock.lock(tx, organizationId, stockItemId, {
                skipLocked: true,
              });
              if (!item) return null;
              const after = await this.expiry.expireDue(tx, item, at, correlationId, 'sweeper');
              return after.version - item.version;
            },
            {
              timeoutMs: this.options.lockTimeoutMs * 2 + 10_000,
              maxWaitMs: this.options.lockTimeoutMs,
            },
          ),
        );
        if (expired === null) outcome.skipped += 1;
        else outcome.expired += expired;
      } catch (error) {
        outcome.failed += 1;
        this.logger.error(
          `Could not expire the due reservations of a stock item (${errorCodeOf(error)}); the next sweep retries`,
        );
      }
    }
    if (outcome.expired > 0 || outcome.failed > 0) {
      this.logger.log(
        `${SERVICE_NAME} expiry sweep: ${outcome.expired} expired, ${outcome.skipped} skipped, ${outcome.failed} failed`,
      );
    }
    return outcome;
  }
}
