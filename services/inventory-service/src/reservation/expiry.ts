import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  RastaError,
  createSystemContext,
  runWithContext,
  tryGetContext,
  type RequestContext,
} from '@rasta/nest-common';
import { SERVICE_NAME, type InventoryEnv } from '../config/env';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { inventoryReservationsExpiredTotal } from '../observability/metrics';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { transactionNow } from '../shared/clock';
import { boundLockWaits, expiryKeyHash } from '../shared/command';
import { reservationFacts, stockFacts } from '../stock/facts';
import { StockRepository, type StockItemRow } from '../stock/stock.repository';
import { ENV } from '../tokens';
import { ReservationRepository } from './reservation.repository';

/** Who ends a reservation that expired: this service, not a person. */
export const EXPIRY_ACTOR = SERVICE_NAME;

/** `Retry-After` on a command refused while an expiry backlog is worked off. */
const BACKLOG_RETRY_AFTER_SECONDS = 1;

/** What one batch of expiry left behind. */
export interface ExpiryBatch {
  /** The stock item as it then stands. */
  item: StockItemRow;
  /** Reservations this batch expired. */
  expired: number;
  /**
   * Due reservations remain past the batch: still ACTIVE, still counted in `reserved`, and
   * expired by a later batch — the next command's, the sweeper's or {@link ReservationExpiry.expireBatch}.
   */
  backlog: boolean;
}

/**
 * A command whose refusal the not-yet-expired part of a backlog could change: `reserved` still
 * counts reservations that are due, so "not enough available" or "on hand below reserved" may
 * no longer be true once they are expired. Answered `409 CONFLICT` with `Retry-After` — never a
 * 422 that might be wrong. `CommandRunner` expires a batch of each item in its own transaction
 * before answering, so every retry finds the backlog smaller.
 */
export class ExpiryBacklog extends RastaError {
  constructor(
    readonly organizationId: string,
    readonly stockItemIds: readonly string[],
  ) {
    super(
      'CONFLICT',
      'Expired reservations of this stock are still being released; retry shortly',
      {
        internalContext: { stockItemIds },
        retryAfterSeconds: BACKLOG_RETRY_AFTER_SECONDS,
      },
    );
  }
}

/**
 * Expiry of reservations past their `expiresAt` (Q-102; ADR-056 plan step 5 asked for the choice).
 *
 * **Not derived on read.** A reservation that merely *looked* expired would still be counted in
 * `reserved_quantity`, and the balance the database keeps — the one its CHECKs guard — would
 * disagree with the one shown. An expiry is therefore a real transition with its own RELEASE
 * movement and `STOCK_RELEASED { reason: EXPIRED }`, made in one of two places, both under the
 * stock item's lock:
 *
 *   1. by **any command that locks the item**, as the first thing it does with it — so a command
 *      never refuses for stock that a due reservation still holds;
 *   2. by the **sweeper** (`ReservationSweeper`), which bounds how long a due reservation of an
 *      item nobody touches keeps its stock.
 *
 * Due means `expires_at <= now()` by the database's clock, in the transaction. A release, an
 * issue and an expiry of one reservation are serialised by the item's lock and decided by its
 * ACTIVE status: whichever runs first ends it, the other finds it ended.
 *
 * ## A batch, never the whole backlog
 *
 * One transaction expires at most INVENTORY_RESERVATION_EXPIRY_BATCH_SIZE reservations of an
 * item, the longest overdue first. Expiring every due one at once made the work grow with the
 * backlog: past the transaction's budget it rolled back — and every later command on the item,
 * and every sweep, repeated it and rolled back too, so the item was blocked for good. A batch
 * fits the budget whatever the backlog, and the sweeper commits one after another.
 *
 * What a command does with what is left: expiring a reservation only ever **lowers** `reserved`,
 * never on hand. A decision that holds with the leftover due reservations still counted holds
 * without them — so a receipt, an adjustment that keeps on hand above reserved, a reservation
 * that fits what is available, a release and an issue all **proceed**. Only a refusal could be
 * wrong: "not enough available" or "on hand below reserved" with a backlog left is
 * {@link ExpiryBacklog}, a retryable 409, not a 422.
 *
 * ## The service acts, under its own context
 *
 * Each expiry's event is built under a system context of this service — the tenant, correlation
 * and trace of the transaction it runs in, but not the person whose command happened to lock the
 * item: the envelope's actor is `SERVICE inventory-service`, as the payload's `releasedBy: null`
 * and the movement's `createdBy` say, on the command path and the sweeper's alike.
 */
@Injectable()
export class ReservationExpiry {
  private readonly logger = new Logger(ReservationExpiry.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reservations: ReservationRepository,
    private readonly stock: StockRepository,
    private readonly publisher: EventPublisher,
    @Inject(ENV) private readonly env: InventoryEnv,
  ) {}

  /**
   * Expires one batch of the due reservations of a stock item **the caller has locked**, and
   * reports the item as it then stands and whether a backlog remains.
   */
  async expireDue(
    tx: ExtendedPrismaClient,
    item: StockItemRow,
    at: Date,
    correlationId: string,
    path: 'command' | 'sweeper',
  ): Promise<ExpiryBatch> {
    const size = this.env.INVENTORY_RESERVATION_EXPIRY_BATCH_SIZE;
    // One more than the batch, to learn whether a backlog remains.
    const due = await this.reservations.dueOf(tx, item.organizationId, item.id, at, size + 1);
    const context = expiryContext(item.organizationId, correlationId);
    let current = item;
    let expired = 0;
    for (const reservation of due.slice(0, size)) {
      const ended = await this.reservations.end(tx, reservation, 'EXPIRED', EXPIRY_ACTOR, at);
      if (!ended) continue;
      current = await this.stock.move(
        tx,
        current,
        { onHand: 0, reserved: -ended.quantity },
        EXPIRY_ACTOR,
        at,
      );
      const movement = await this.stock.insertMovement(tx, {
        id: newId(ID_PREFIX.movement),
        item: current,
        type: 'RELEASE',
        onHandDelta: 0,
        reservedDelta: -ended.quantity,
        reservationId: ended.id,
        sourceReference: null,
        commandKeyHash: expiryKeyHash(ended.id),
        correlationId,
        actor: EXPIRY_ACTOR,
        at,
      });
      const facts = { ...stockFacts(current, movement.id), ...reservationFacts(ended) };
      await runWithContext(context, () =>
        this.publisher.enqueue(tx, {
          eventName: 'STOCK_RELEASED',
          aggregateId: current.id,
          organizationId: current.organizationId,
          occurredAt: at,
          payload: { ...facts, reason: 'EXPIRED', releasedBy: null, releasedAt: at.toISOString() },
        }),
      );
      expired += 1;
      inventoryReservationsExpiredTotal.inc({ service: SERVICE_NAME, path });
    }
    return { item: current, expired, backlog: due.length > size };
  }

  /**
   * One batch of a stock item's due reservations in a short transaction of its own, under this
   * service's context, committed whatever comes after it — the sweeper's step, and the progress
   * a command refused for a backlog leaves behind. `null` when another transaction holds the
   * item: it expires them itself, so there is nothing to wait for (`SKIP LOCKED`).
   */
  async expireBatch(
    organizationId: string,
    stockItemId: string,
    correlationId: string,
    path: 'command' | 'sweeper',
  ): Promise<ExpiryBatch | null> {
    const lockTimeoutMs = this.env.INVENTORY_LOCK_TIMEOUT_MS;
    return runWithContext(expiryContext(organizationId, correlationId), () =>
      this.prisma.transaction(
        async (tx) => {
          await boundLockWaits(tx, lockTimeoutMs);
          const at = await transactionNow(tx);
          const item = await this.stock.lock(tx, organizationId, stockItemId, {
            skipLocked: true,
          });
          if (!item) return null;
          return this.expireDue(tx, item, at, correlationId, path);
        },
        { timeoutMs: lockTimeoutMs * 2 + 10_000, maxWaitMs: lockTimeoutMs },
      ),
    );
  }

  /**
   * After {@link ExpiryBacklog} rolled a command back: one committed batch per item, so the
   * retry finds less due. Never throws — the 409 is the answer whatever happens here, and the
   * sweeper takes over what this could not do.
   */
  async workOff(backlog: ExpiryBacklog, correlationId: string): Promise<void> {
    for (const stockItemId of backlog.stockItemIds) {
      try {
        await this.expireBatch(backlog.organizationId, stockItemId, correlationId, 'command');
      } catch (error) {
        this.logger.warn(
          `Could not expire a batch of a stock item's due reservations (${
            error instanceof RastaError ? error.code : 'INTERNAL'
          }); the sweeper retries`,
        );
      }
    }
  }
}

/**
 * The context an expiry runs and is recorded under: this service, for the tenant of the item —
 * keeping the correlation, the request and the trace of whatever triggered it, and none of its
 * caller's identity.
 */
function expiryContext(organizationId: string, correlationId: string): RequestContext {
  const current = tryGetContext();
  return createSystemContext({
    correlationId,
    organizationId,
    callerService: SERVICE_NAME,
    ...(current?.requestId === undefined ? {} : { requestId: current.requestId }),
    ...(current?.traceId === undefined ? {} : { traceId: current.traceId }),
    ...(current?.spanId === undefined ? {} : { spanId: current.spanId }),
  });
}
