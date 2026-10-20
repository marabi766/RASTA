import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@rasta/contracts';
import { RastaError, getContext } from '@rasta/nest-common';
import { assertOrderVisible } from '../access/access';
import { SERVICE_NAME, type MarketplaceEnv } from '../config/env';
import { MARKETPLACE_EVENTS } from '../events/events';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { returnRefusalsTotal, returnTransitionsTotal } from '../observability/metrics';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import type { RecordResponse } from '../shared/idempotency';
import { isUniqueViolation, violatedConstraint } from '../shared/prisma-errors';
import { ENV } from '../tokens';
import type { CancelReturnDto, CreateReturnDto, ListReturnsQuery, ReturnRequestView } from './dto';
import { RETURN_AUTHORISATION, assertReturnVisible, type ReturnCommand } from './return-access';
import { RETURN_GOODS_OWNER, type ReturnGoodsOwner } from './return-goods';
import { ReturnRepository, type ReturnRequestRow } from './return.repository';
import {
  RETURN_STATUSES_HOLDING_UNITS,
  assertReturnTransition,
  versionAfter,
  type ReturnStatus,
} from './state-machine';

/** What a party's command can move a request to; the physical states are inventory's events. */
type DecidedStatus = 'AUTHORIZED' | 'REJECTED' | 'CANCELLED';
import { toReturnView } from './views';

const DAY_MS = 24 * 60 * 60 * 1000;

/** One request per (buyer, command key): the database backstop of the creation key. */
const REQUEST_COMMAND_INDEX = 'ux_return_request_command';

/** Whether a unique violation is the creation key's, by index name or by its column. */
function isRequestCommandIndex(target: string | undefined): boolean {
  return (
    target !== undefined &&
    (target === REQUEST_COMMAND_INDEX ||
      target.includes('command_key_hash') ||
      target.includes('commandKeyHash'))
  );
}

/** The order status a return may be asked of (Q-132, temporary decision): only a settled order. */
const RETURNABLE_ORDER_STATUS = 'COMPLETED';

/**
 * The return request's commands (ADR-048 § 2, § 3; RUN-005): the buyer asks and withdraws, the
 * supplier authorizes or rejects. Marketplace owns the request and this commercial decision; it
 * moves no goods (inventory-service's) and no money (economic-service's).
 *
 * Every command is one database transaction doing the same things in the same order:
 *
 *   1. lock the row — the order for a new request, the request for a decision — so two commands
 *      on one aggregate serialise;
 *   2. check who may (`return-access.ts`), then whether the move is legal (`state-machine.ts`);
 *   3. write the new state, its history row and its outbox event together, and the idempotent
 *      response last (ADR-021).
 *
 * The database holds the same lifecycle in a trigger, so a command that forgets a step is refused
 * there too; the checks here exist to answer with the right status code and a useful message.
 */
@Injectable()
export class ReturnService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: ReturnRepository,
    private readonly events: EventPublisher,
    @Inject(ENV) private readonly env: MarketplaceEnv,
    @Inject(RETURN_GOODS_OWNER) private readonly goods: ReturnGoodsOwner,
  ) {}

  // -- the buyer asks ---------------------------------------------------------------------------

  /**
   * Asks to return goods of a completed order, inside the return window.
   *
   * The window is configuration and has no default (Q-132): unset, returns are refused outright
   * rather than judged against a number nobody decided. Quantities are checked against what the
   * order sold, less what other open requests already take — under the order's lock, so two
   * requests cannot both take the last unit; the line trigger says the same in the database.
   */
  async request(
    orderId: string,
    dto: CreateReturnDto,
    idempotencyKey: string,
    record?: RecordResponse<ReturnRequestView>,
  ): Promise<ReturnRequestView> {
    const context = getContext();
    const actor = context.userId ?? context.callerService ?? SERVICE_NAME;
    const keyHash = commandKeyHash('POST /v1/orders/:id/returns', orderId, idempotencyKey);

    try {
      return await this.fileRequest(orderId, dto, keyHash, actor, record);
    } catch (error) {
      // The key already filed a request on this order, and its idempotency record — which would
      // have replayed that request — is gone: expired and claimed afresh, or purged. The command
      // index refuses a second request; the caller learns it as a conflict, not a 500, and without
      // Retry-After, because waiting will not change it (as `OrderService.place`).
      if (isUniqueViolation(error) && isRequestCommandIndex(violatedConstraint(error))) {
        returnRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'COMMAND_ALREADY_APPLIED' });
        throw new RastaError(
          'CONFLICT',
          'A return has already been requested on this order with this Idempotency-Key',
          // The index, never the key or its hash (S-09).
          { internalContext: { constraint: REQUEST_COMMAND_INDEX } },
        );
      }
      throw error;
    }
  }

  private fileRequest(
    orderId: string,
    dto: CreateReturnDto,
    keyHash: string,
    actor: string,
    record?: RecordResponse<ReturnRequestView>,
  ): Promise<ReturnRequestView> {
    const context = getContext();
    return this.prisma.transaction(async (tx) => {
      const order = await this.repository.lockOrder(tx, orderId);
      if (!order) throw RastaError.notFound('Order', orderId);
      // Visible, then the buyer: an organization that is neither party learns nothing (404), the
      // supplier — who can see the order — is told it may not ask (403).
      assertOrderVisible(order);
      RETURN_AUTHORISATION.request(order);

      const at = new Date();
      this.assertReturnable(order, at);

      const sold = await this.repository.orderLines(tx, order.id, order.organizationId);
      const byId = new Map(sold.map((line) => [line.id, line]));
      const open = await this.openQuantities(tx, [...byId.keys()]);
      const lines = dto.lines.map((wanted) => {
        const line = byId.get(wanted.orderLineId);
        if (!line) {
          throw RastaError.validation(
            [
              {
                path: 'lines',
                code: 'unknown_order_line',
                message: `Order line ${wanted.orderLineId} is not a line of order ${order.id}`,
              },
            ],
            'A return names lines of its own order',
          );
        }
        const available = line.quantity - (open.get(line.id) ?? 0);
        if (wanted.quantity > available) {
          returnRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'QUANTITY_EXCEEDS_SOLD' });
          throw RastaError.businessRule(
            `Order line ${line.id} has ${available} unit(s) left to return, ${wanted.quantity} asked`,
            { orderLineId: line.id, available, requested: wanted.quantity },
          );
        }
        return { id: line.id, productId: line.productId, quantity: wanted.quantity };
      });

      const id = newId(ID_PREFIX.returnRequest);
      await this.repository.insertRequest(tx, {
        id,
        organizationId: order.organizationId,
        supplierOrganizationId: order.supplierOrganizationId,
        orderId: order.id,
        status: 'REQUESTED',
        version: 1,
        reason: dto.reason,
        commandKeyHash: keyHash,
        requestedAt: at,
        requestedBy: actor,
        requestedCorrelationId: context.correlationId,
        updatedAt: at,
      });
      for (const line of lines) {
        await this.repository.insertLine(tx, {
          id: newId(ID_PREFIX.returnLine),
          organizationId: order.organizationId,
          returnRequestId: id,
          orderLineId: line.id,
          productId: line.productId,
          quantity: line.quantity,
          createdAt: at,
        });
      }
      await this.repository.insertHistory(tx, {
        id: newId(ID_PREFIX.returnHistory),
        organizationId: order.organizationId,
        returnRequestId: id,
        fromStatus: null,
        toStatus: 'REQUESTED',
        version: 1,
        actorId: actor,
        correlationId: context.correlationId,
        commandKeyHash: keyHash,
        occurredAt: at,
      });
      const row = await this.repository.findWithLines(id, tx);
      if (!row) throw new Error(`Return request ${id} vanished inside its own transaction`);

      await this.events.enqueue(tx, {
        eventName: MARKETPLACE_EVENTS.RETURN_REQUESTED,
        aggregateId: id,
        organizationId: row.organizationId,
        payload: {
          ...facts(row),
          returnVersion: 1,
          requestedBy: actor,
          requestedAt: at.toISOString(),
        },
      });
      returnTransitionsTotal.inc({ service: SERVICE_NAME, to: 'REQUESTED' });

      const view = toReturnView(row);
      await record?.(tx, view);
      return view;
    });
  }

  // -- the supplier decides, the buyer withdraws ------------------------------------------------

  /** REQUESTED → AUTHORIZED. The supplier agrees to take the goods back; nothing physical moves. */
  authorize(
    id: string,
    idempotencyKey: string,
    record?: RecordResponse<ReturnRequestView>,
  ): Promise<ReturnRequestView> {
    return this.decide(id, 'AUTHORIZED', 'authorize', idempotencyKey, record);
  }

  /** REQUESTED → REJECTED. The supplier refuses; the request is over. */
  reject(
    id: string,
    idempotencyKey: string,
    record?: RecordResponse<ReturnRequestView>,
  ): Promise<ReturnRequestView> {
    return this.decide(id, 'REJECTED', 'reject', idempotencyKey, record);
  }

  /**
   * REQUESTED|AUTHORIZED → CANCELLED. The buyer withdraws it, before any goods moved:
   *
   * - only from the status it saw (`expectedStatus`), judged under the row lock — a request the
   *   supplier authorized after the buyer's read is refused, `409`, nothing written (Codex r1 on
   *   #339, finding 1);
   * - never once inventory has reserved its dispatch, even while it still reads AUTHORIZED (Q-133
   *   (5));
   * - and from AUTHORIZED only once inventory, the owner of the goods, has said it holds no
   *   shipment for it (Q-133 (9), PM ruling): a request authorized before reservations existed —
   *   or dispatched without one — may have goods on the road this service never heard of. Asked
   *   before the transaction; no definite answer refuses the cancellation (fail closed).
   */
  async cancel(
    id: string,
    dto: CancelReturnDto,
    idempotencyKey: string,
    record?: RecordResponse<ReturnRequestView>,
  ): Promise<ReturnRequestView> {
    const goodsAbsent = await this.confirmNoGoods(id, dto.expectedStatus);
    return this.decide(id, 'CANCELLED', 'cancel', idempotencyKey, record, {
      expectedStatus: dto.expectedStatus,
      goodsAbsent,
    });
  }

  /**
   * Whether inventory confirmed it holds no shipment for an AUTHORIZED, unreserved request the
   * buyer means to cancel. `false` when the question does not arise — the caller expects REQUESTED,
   * or the request is not (or no longer) unreserved AUTHORIZED: the checks under the lock answer
   * those, and a request found AUTHORIZED there without this confirmation is refused.
   */
  private async confirmNoGoods(id: string, expected: CancelReturnDto['expectedStatus']) {
    if (expected !== 'AUTHORIZED') return false;
    // The parties first: nobody else makes this service ask inventory anything.
    const row = await this.visible(id);
    RETURN_AUTHORISATION.cancel(row);
    if (row.status !== 'AUTHORIZED' || row.dispatchReservedAt !== null) return false;

    const shipment = await this.goods.shipmentOf(row.supplierOrganizationId, row.id);
    if (shipment) {
      returnRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'DISPATCHED' });
      throw dispatchedRefusal(row.id, shipment.id);
    }
    return true;
  }

  // -- either party reconciles a dispatch reservation ------------------------------------------

  /**
   * Releases a dispatch reservation whose dispatch never happened — inventory's transaction
   * failed or its process died after reserving (Codex r1 on #339, finding 2; Q-133 (9)(a), PM
   * ruling: no clock releases one). Either party asks; inventory answers (A-13):
   *
   * 1. outside any transaction, inventory is asked to withdraw **this** reservation. Under its own
   *    lock it either names a shipment that exists for the request — the reservation stands, 422
   *    `RETURN_DISPATCHED` — or records the reservation id as withdrawn, after which a dispatch
   *    carrying it is refused there however late it arrives. No definite answer: 503/504, nothing
   *    written;
   * 2. on "withdrawn", under the request's row lock, the reservation is cleared beside its release
   *    record (who asked, when, inventory's answer) — once: a second reconciliation finds nothing
   *    reserved, and the record is unique per reservation. The trigger clears a reservation on no
   *    other path.
   *
   * After it the buyer may cancel (inventory is asked again), and the supplier may dispatch again
   * under a new reservation.
   */
  async reconcileDispatch(
    id: string,
    idempotencyKey: string,
    record?: RecordResponse<ReturnRequestView>,
  ): Promise<ReturnRequestView> {
    const context = getContext();
    const actor = context.userId ?? context.callerService ?? SERVICE_NAME;
    const keyHash = commandKeyHash(
      'POST /v1/returns/:id/dispatch-reconciliation',
      id,
      idempotencyKey,
    );

    const row = await this.visible(id);
    RETURN_AUTHORISATION.reconcile(row);
    const reservationId = row.status === 'AUTHORIZED' ? row.dispatchReservationId : null;
    if (reservationId === null) {
      returnRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'NOT_RESERVED' });
      throw notReservedRefusal(id);
    }

    const answer = await this.goods.withdraw(row.supplierOrganizationId, row.id, reservationId);
    if (answer.outcome === 'DISPATCHED') {
      returnRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'DISPATCHED' });
      throw dispatchedRefusal(row.id, answer.returnShipment.id);
    }

    return this.prisma.transaction(async (tx) => {
      const locked = await this.repository.lockRequest(tx, id);
      if (!locked) throw RastaError.notFound('ReturnRequest', id);
      assertReturnVisible(locked);
      RETURN_AUTHORISATION.reconcile(locked);
      // Released by another reconciliation meanwhile (or moved on): exactly once.
      if (
        locked.status !== 'AUTHORIZED' ||
        locked.dispatchReservationId !== reservationId ||
        locked.dispatchReservedAt === null ||
        locked.dispatchReservedBy === null ||
        locked.dispatchReservedCorrelationId === null
      ) {
        returnRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'NOT_RESERVED' });
        throw notReservedRefusal(id);
      }

      const at = new Date(Math.max(Date.now(), locked.updatedAt.getTime()));
      const released = await this.repository.releaseDispatch(
        tx,
        {
          ...locked,
          dispatchReservationId: reservationId,
          dispatchReservedAt: locked.dispatchReservedAt,
          dispatchReservedBy: locked.dispatchReservedBy,
          dispatchReservedCorrelationId: locked.dispatchReservedCorrelationId,
        },
        {
          id: newId(ID_PREFIX.returnDispatchRelease),
          withdrawnAt: answer.withdrawnAt,
          at,
          by: actor,
          correlationId: context.correlationId,
          commandKeyHash: keyHash,
        },
      );
      if (!released) throw RastaError.optimisticLockFailed('ReturnRequest', id);
      returnTransitionsTotal.inc({ service: SERVICE_NAME, to: 'DISPATCH_RELEASED' });

      const after = await this.repository.findWithLines(id, tx);
      if (!after) throw new Error(`Return request ${id} vanished inside its own transaction`);
      const view = toReturnView(after);
      await record?.(tx, view);
      return view;
    });
  }

  private async decide(
    id: string,
    to: DecidedStatus,
    command: Exclude<ReturnCommand, 'request' | 'reconcile'>,
    idempotencyKey: string,
    record?: RecordResponse<ReturnRequestView>,
    cancellation?: { expectedStatus: ReturnStatus; goodsAbsent: boolean },
  ): Promise<ReturnRequestView> {
    const context = getContext();
    const actor = context.userId ?? context.callerService ?? SERVICE_NAME;
    const keyHash = commandKeyHash(`POST /v1/returns/:id/${command}`, id, idempotencyKey);

    return this.prisma.transaction(async (tx) => {
      const locked = await this.repository.lockRequest(tx, id);
      if (!locked) throw RastaError.notFound('ReturnRequest', id);
      // Visibility before the party check, as for orders: a stranger gets 404, never the 403
      // that would confirm the request exists. A real party who tries the other side's command
      // can already see the request, so for it 403 is the truth.
      assertReturnVisible(locked);
      RETURN_AUTHORISATION[command](locked);

      // Conditional: the status the buyer saw, judged here, under the lock — not by a read the
      // supplier's authorization can overtake (Codex r1 on #339, finding 1). Before the transition
      // check: a request the buyer saw REQUESTED and the supplier has since rejected — or saw
      // AUTHORIZED and its goods have since moved it IN_TRANSIT — is a stale command, 409, not an
      // illegal one, 422 (Codex r2 on #339, finding 2).
      if (cancellation && locked.status !== cancellation.expectedStatus) {
        returnRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'STALE_EXPECTED_STATUS' });
        throw RastaError.optimisticLockFailed('ReturnRequest', id);
      }
      try {
        assertReturnTransition(locked.id, locked.status, to);
      } catch (error) {
        returnRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'ILLEGAL_TRANSITION' });
        throw error;
      }
      if (cancellation) {
        // The goods may be on the road while the request still reads AUTHORIZED: inventory
        // reserved the dispatch here before recording its shipment, and the shipment's own event
        // moves the request on later — or not at all while the mirror is off (Q-133 (5)). Read
        // under the same lock the reservation takes, so the two never both succeed.
        if (locked.dispatchReservedAt !== null) {
          returnRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'DISPATCH_RESERVED' });
          throw dispatchReservedRefusal(locked.id);
        }
        // AUTHORIZED and unreserved: only on inventory's word that it holds no shipment. A request
        // that became so after the question was skipped (a reservation released meanwhile) was not
        // asked about: refused, and the buyer retries.
        if (locked.status === 'AUTHORIZED' && !cancellation.goodsAbsent) {
          returnRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'GOODS_NOT_CONFIRMED' });
          throw RastaError.optimisticLockFailed('ReturnRequest', id);
        }
      }

      // Never before what it follows: a command whose transaction began before the previous move
      // committed (it then waited on the row) still records its step after that one.
      const at = new Date(Math.max(Date.now(), locked.updatedAt.getTime()));
      const version = versionAfter(to, locked.status);
      const moved = await this.repository.advance(tx, locked, {
        status: to,
        version,
        updatedAt: at,
        ...(to === 'AUTHORIZED' ? { authorizedAt: at, authorizedBy: actor } : {}),
        ...(to === 'REJECTED' ? { rejectedAt: at, rejectedBy: actor } : {}),
        ...(to === 'CANCELLED'
          ? {
              cancelledAt: at,
              cancelledBy: actor,
              cancelledFrom: locked.status as 'REQUESTED' | 'AUTHORIZED',
            }
          : {}),
      });
      if (!moved) throw RastaError.optimisticLockFailed('ReturnRequest', id);

      await this.repository.insertHistory(tx, {
        id: newId(ID_PREFIX.returnHistory),
        organizationId: locked.organizationId,
        returnRequestId: locked.id,
        fromStatus: locked.status,
        toStatus: to,
        version,
        actorId: actor,
        correlationId: context.correlationId,
        commandKeyHash: keyHash,
        occurredAt: at,
      });

      const row = await this.repository.findWithLines(id, tx);
      if (!row) throw new Error(`Return request ${id} vanished inside its own transaction`);
      await this.publish(tx, row, to, locked.status, actor, at);
      returnTransitionsTotal.inc({ service: SERVICE_NAME, to });

      const view = toReturnView(row);
      await record?.(tx, view);
      return view;
    });
  }

  private async publish(
    tx: ExtendedPrismaClient,
    row: ReturnRequestRow,
    to: DecidedStatus,
    from: ReturnStatus,
    actor: string,
    at: Date,
  ): Promise<void> {
    const common = { aggregateId: row.id, organizationId: row.organizationId };
    switch (to) {
      case 'AUTHORIZED':
        return this.events.enqueue(tx, {
          ...common,
          eventName: MARKETPLACE_EVENTS.RETURN_AUTHORIZED,
          payload: {
            ...facts(row),
            returnVersion: 2,
            authorizedBy: actor,
            authorizedAt: at.toISOString(),
          },
        });
      case 'REJECTED':
        return this.events.enqueue(tx, {
          ...common,
          eventName: MARKETPLACE_EVENTS.RETURN_REJECTED,
          payload: {
            ...facts(row),
            returnVersion: 2,
            rejectedBy: actor,
            rejectedAt: at.toISOString(),
          },
        });
      case 'CANCELLED':
        return this.events.enqueue(tx, {
          ...common,
          eventName: MARKETPLACE_EVENTS.RETURN_CANCELLED,
          payload: {
            ...facts(row),
            returnVersion: versionAfter('CANCELLED', from),
            cancelledFrom: from,
            cancelledBy: actor,
            cancelledAt: at.toISOString(),
          },
        });
    }
  }

  // -- reads ------------------------------------------------------------------------------------

  async get(id: string): Promise<ReturnRequestView> {
    const row = await this.visible(id);
    return toReturnView(row);
  }

  async list(
    query: ListReturnsQuery,
  ): Promise<{ items: ReturnRequestView[]; nextCursor: string | null }> {
    const rows = await this.repository.list(query);
    return {
      items: rows.map(toReturnView),
      nextCursor: rows.length === query.limit ? (rows[rows.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * Whether the caller may still do what a stored response says it did (#253): the request is
   * still visible to it, and — for a decision — it is still the party that command requires.
   */
  async assertReplayVisible(id: string, command: Exclude<ReturnCommand, 'request'>): Promise<void> {
    const row = await this.visible(id);
    RETURN_AUTHORISATION[command](row);
  }

  /** A replay of the request itself: the caller must still see the request it created. */
  async assertRequestReplayVisible(id: string): Promise<void> {
    await this.visible(id);
  }

  private async visible(id: string): Promise<ReturnRequestRow> {
    const row = await this.repository.findWithLines(id);
    if (!row) throw RastaError.notFound('ReturnRequest', id);
    assertReturnVisible(row);
    return row;
  }

  // -- rules ------------------------------------------------------------------------------------

  /**
   * Whether the order may be asked about at all: settled, and inside the configured window. Both
   * are Q-132's temporary decision (docs/24) — no window is invented, so with none configured the
   * answer is no.
   */
  private assertReturnable(
    order: { id: string; status: string; completedAt: Date | null },
    now: Date,
  ): void {
    if (order.status !== RETURNABLE_ORDER_STATUS || !order.completedAt) {
      returnRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'ORDER_NOT_COMPLETED' });
      throw RastaError.businessRule(
        `Order ${order.id} is ${order.status}: goods are returned only from a COMPLETED order`,
        { orderId: order.id, status: order.status },
      );
    }
    const windowDays = this.env.MARKETPLACE_RETURN_WINDOW_DAYS;
    if (windowDays === undefined) {
      returnRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'WINDOW_NOT_CONFIGURED' });
      throw RastaError.businessRule(
        'Returns are not open: no return window is configured (open question Q-132)',
        { orderId: order.id },
      );
    }
    if (now.getTime() - order.completedAt.getTime() > windowDays * DAY_MS) {
      returnRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'WINDOW_ELAPSED' });
      throw RastaError.businessRule(
        `The ${windowDays}-day return window for order ${order.id} has elapsed`,
        { orderId: order.id, windowDays },
      );
    }
  }

  /**
   * What other requests of these order lines already take: every one not REJECTED or CANCELLED.
   * Goods on the road, received or resolved were returned and are not returnable again.
   */
  private async openQuantities(
    tx: ExtendedPrismaClient,
    orderLineIds: readonly string[],
  ): Promise<Map<string, number>> {
    const taken = await tx.returnLine.findMany({
      where: {
        orderLineId: { in: [...orderLineIds] },
        returnRequest: { status: { in: [...RETURN_STATUSES_HOLDING_UNITS] } },
      },
      select: { orderLineId: true, quantity: true },
    });
    const sums = new Map<string, number>();
    for (const line of taken) {
      sums.set(line.orderLineId, (sums.get(line.orderLineId) ?? 0) + line.quantity);
    }
    return sums;
  }
}

/** What every return event says about the request: which, for what, between whom. */
export function facts(row: ReturnRequestRow) {
  return {
    returnRequestId: row.id,
    orderId: row.orderId,
    buyerOrganizationId: row.organizationId,
    supplierOrganizationId: row.supplierOrganizationId,
    lines: row.lines.map((line) => ({
      orderLineId: line.orderLineId,
      productId: line.productId,
      quantity: line.quantity,
    })),
  };
}

/**
 * A cancellation of a request whose dispatch inventory reserved: the platform's business-rule code
 * (`422`, as any other move the request's state refuses), with the closed reason in `details` so a
 * client can say why without reading the message.
 */
export function dispatchReservedRefusal(returnRequestId: string): RastaError {
  return new RastaError(
    ERROR_CODES.BUSINESS_RULE_VIOLATION,
    `Return request ${returnRequestId} is being dispatched and can no longer be cancelled`,
    {
      details: [
        {
          path: 'returnRequest',
          code: 'RETURN_DISPATCH_RESERVED',
          message: 'The goods of this return are being dispatched',
        },
      ],
      internalContext: { returnRequestId },
    },
  );
}

/**
 * A cancellation or reconciliation refused because inventory, the owner of the goods, holds a
 * shipment for the request (Q-133 (9)): the goods may be on the road, whatever this service's
 * mirror has heard. The shipment's id stays in the log; the buyer reads it from inventory.
 */
export function dispatchedRefusal(returnRequestId: string, returnShipmentId: string): RastaError {
  return new RastaError(
    ERROR_CODES.BUSINESS_RULE_VIOLATION,
    `Return request ${returnRequestId} has a return shipment and can no longer be cancelled`,
    {
      details: [
        {
          path: 'returnRequest',
          code: 'RETURN_DISPATCHED',
          message: 'The goods of this return have been dispatched',
        },
      ],
      internalContext: { returnRequestId, returnShipmentId },
    },
  );
}

/** A reconciliation of a request with no dispatch reservation standing: nothing to release. */
export function notReservedRefusal(returnRequestId: string): RastaError {
  return new RastaError(
    ERROR_CODES.BUSINESS_RULE_VIOLATION,
    `Return request ${returnRequestId} has no dispatch reservation to reconcile`,
    {
      details: [
        {
          path: 'returnRequest',
          code: 'RETURN_DISPATCH_NOT_RESERVED',
          message: 'No dispatch of this return is reserved',
        },
      ],
      internalContext: { returnRequestId },
    },
  );
}

/**
 * The database backstop of an Idempotency-Key: the route, the resource and the key, hashed. The raw
 * key never reaches a table of this service's own (S-09).
 */
export function commandKeyHash(route: string, target: string, key: string): string {
  return createHash('sha256').update(`${route}\n${target}\n${key}`).digest('hex');
}
