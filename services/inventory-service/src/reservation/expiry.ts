import { Injectable } from '@nestjs/common';
import { SERVICE_NAME } from '../config/env';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { inventoryReservationsExpiredTotal } from '../observability/metrics';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import { expiryKeyHash } from '../shared/command';
import { reservationFacts, stockFacts } from '../stock/facts';
import { StockRepository, type StockItemRow } from '../stock/stock.repository';
import { ReservationRepository } from './reservation.repository';

/** Who ends a reservation that expired: this service, not a person. */
export const EXPIRY_ACTOR = SERVICE_NAME;

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
 */
@Injectable()
export class ReservationExpiry {
  constructor(
    private readonly reservations: ReservationRepository,
    private readonly stock: StockRepository,
    private readonly publisher: EventPublisher,
  ) {}

  /**
   * Expires the due reservations of a stock item **the caller has locked**, and returns the item
   * as it then stands.
   */
  async expireDue(
    tx: ExtendedPrismaClient,
    item: StockItemRow,
    at: Date,
    correlationId: string,
    path: 'command' | 'sweeper',
  ): Promise<StockItemRow> {
    const due = await this.reservations.dueOf(tx, item.organizationId, item.id, at);
    let current = item;
    for (const reservation of due) {
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
      await this.publisher.enqueue(tx, {
        eventName: 'STOCK_RELEASED',
        aggregateId: current.id,
        organizationId: current.organizationId,
        occurredAt: at,
        payload: {
          ...stockFacts(current, movement.id),
          ...reservationFacts(ended),
          reason: 'EXPIRED',
          releasedBy: null,
          releasedAt: at.toISOString(),
        },
      });
      inventoryReservationsExpiredTotal.inc({ service: SERVICE_NAME, path });
    }
    return current;
  }
}
