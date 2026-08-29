import { Inject, Injectable } from '@nestjs/common';
import { RastaError, getContext, getOrganizationId, runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { MARKETPLACE_EVENTS } from '../events/events';
import {
  assertBuyer,
  assertDisputeResolver,
  assertOrderVisible,
  assertSupplier,
} from '../access/access';
import { ENV } from '../tokens';
import { SERVICE_NAME, type MarketplaceEnv } from '../config/env';
import {
  disputesRaisedTotal,
  orderRefusalsTotal,
  orderTransitionsTotal,
  ordersCreatedTotal,
  remindersRecordedTotal,
} from '../observability/metrics';
import { OrderRepository, type LockedOrderRow } from './order.repository';
import { assertTransition } from './state-machine';
import { priceOrder, type PriceableOffer } from './pricing';
import type {
  CancelOrderDto,
  ConfirmReceiptDto,
  CreateOrderDto,
  FulfillOrderDto,
  ListOrdersQuery,
  OrderView,
  RaiseDisputeDto,
  ResolveDisputeDto,
  SubmitReviewDto,
} from './dto';
import type { OrderStatus } from '../generated/prisma';

/**
 * The order aggregate's behaviour.
 *
 * Every method that changes status does the same four things in one database
 * transaction, and the order matters:
 *
 *   1. lock the order row, so two concurrent commands serialise;
 *   2. check the transition against the table (ADR-038);
 *   3. write the new state **and** its history row;
 *   4. write the domain event to the outbox.
 *
 * Steps 3 and 4 share the transaction, which is the whole reason a rolled-back
 * order cannot announce itself and a committed one cannot fail to (ADR-021).
 *
 * Money is not touched here at all. Every financial effect belongs to the saga
 * and goes out as a command to economic-service (ADR-040); this service only
 * ever records what that command reported.
 */
@Injectable()
export class OrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: OrderRepository,
    private readonly events: EventPublisher,
    @Inject(ENV) private readonly env: MarketplaceEnv,
  ) {}

  // =========================================================================
  // Placement
  // =========================================================================

  /**
   * Places an order at the price the catalogue holds right now.
   *
   * The offers are locked before they are priced, so the price a buyer is
   * charged and the availability they consume come from the same read. Without
   * the lock, two buyers both see one unit available and both succeed — which
   * is the overselling claim this service would otherwise be making without
   * evidence (ADR-041 § 2).
   *
   * No money moves here. The order is `PENDING` until the saga's first
   * activity creates the obligation.
   */
  async place(dto: CreateOrderDto, idempotencyKey: string): Promise<OrderView> {
    const context = getContext();
    const buyerOrganizationId = getOrganizationId();
    const actor = context.userId ?? context.callerService ?? SERVICE_NAME;

    const order = await this.prisma.transaction(async (tx) => {
      const locked = await this.repository.lockOffers(
        tx,
        dto.lines.map((line) => line.offerId),
      );

      const offers = new Map<string, PriceableOffer>(
        locked.map((row) => [
          row.id,
          {
            id: row.id,
            organizationId: row.organization_id,
            productId: row.product_id,
            unitPriceMinor: row.unit_price_minor,
            currency: row.currency,
            availableQuantity: row.available_quantity,
            minimumQuantity: row.minimum_quantity,
            version: row.version,
            status: row.status,
          },
        ]),
      );

      const priced = priceOrder(dto.lines, offers);

      if (priced.supplierOrganizationId === buyerOrganizationId) {
        // The database refuses it too, but a CHECK violation reaches the
        // caller as an internal error; this reaches them as what it is.
        throw RastaError.businessRule('An organization cannot order from itself');
      }

      const orderId = newId(ID_PREFIX.order);

      // Product names are copied onto the line so a completed order still
      // reads correctly after the product is renamed. Read across the tenant
      // boundary because the products belong to the supplier.
      const productNames = await runUnscoped(
        'a line snapshots the supplier product name it was bought under',
        () =>
          tx.product.findMany({
            where: { id: { in: priced.lines.map((line) => line.productId) } },
            select: { id: true, name: true },
          }),
      );
      const nameOf = new Map(productNames.map((row) => [row.id, row.name]));

      await tx.order.create({
        data: {
          id: orderId,
          organizationId: buyerOrganizationId,
          supplierOrganizationId: priced.supplierOrganizationId,
          placedBy: actor,
          status: 'PENDING',
          totalAmountMinor: priced.totalAmountMinor,
          currency: priced.currency,
          idempotencyKey,
          correlationId: context.correlationId,
          createdBy: actor,
          lines: {
            create: priced.lines.map((line) => ({
              id: newId(ID_PREFIX.orderLine),
              organizationId: buyerOrganizationId,
              offerId: line.offerId,
              productId: line.productId,
              unitPriceMinor: line.unitPriceMinor,
              quantity: line.quantity,
              lineTotalMinor: line.lineTotalMinor,
              currency: line.currency,
              offerVersion: line.offerVersion,
              productName: nameOf.get(line.productId) ?? line.productId,
            })),
          },
        },
      });

      await this.repository.consumeAvailability(tx, priced.lines);

      await this.events.enqueue(tx, {
        eventName: MARKETPLACE_EVENTS.ORDER_CREATED,
        aggregateId: orderId,
        organizationId: buyerOrganizationId,
        payload: {
          orderId,
          buyerOrganizationId,
          supplierOrganizationId: priced.supplierOrganizationId,
          totalAmountMinor: priced.totalAmountMinor.toString(),
          currency: priced.currency,
          lines: priced.lines.map((line) => ({
            offerId: line.offerId,
            productId: line.productId,
            quantity: line.quantity,
            unitPriceMinor: line.unitPriceMinor.toString(),
            lineTotalMinor: line.lineTotalMinor.toString(),
            offerVersion: line.offerVersion,
          })),
          createdAt: new Date().toISOString(),
        },
      });

      return this.load(tx, orderId);
    });

    ordersCreatedTotal.inc({ service: SERVICE_NAME });
    return order;
  }

  // =========================================================================
  // Reads
  // =========================================================================

  async get(orderId: string): Promise<OrderView> {
    const row = await this.repository.findForParty(orderId);
    if (!row) throw RastaError.notFound('Order', orderId);

    assertOrderVisible(row);
    return toView(row);
  }

  async list(query: ListOrdersQuery): Promise<{ items: OrderView[]; nextCursor: string | null }> {
    const rows = await this.repository.listForCaller(query);
    return {
      items: rows.map(toView),
      nextCursor: rows.length === query.limit ? (rows[rows.length - 1]?.id ?? null) : null,
    };
  }

  // =========================================================================
  // Commands from the two parties
  // =========================================================================

  /** The supplier accepts the order. */
  async confirm(orderId: string): Promise<OrderView> {
    return this.transition(orderId, 'CONFIRMED', {
      authorise: (order) => assertSupplier(order, 'confirm this order'),
      apply: async (tx, order) => {
        // The order row is scoped to the **buyer** (ADR-037 § 8) and the actor
        // here is the seller, so this write crosses the guard with its reason.
        // `assertSupplier` above has already established which seller.
        await runUnscoped('the supplier accepts an order the buyer owns', () =>
          tx.order.update({
            where: { id: order.id },
            data: { status: 'CONFIRMED', confirmedAt: new Date() },
          }),
        );
        await this.events.enqueue(tx, {
          eventName: MARKETPLACE_EVENTS.ORDER_CONFIRMED,
          aggregateId: order.id,
          organizationId: order.organizationId,
          payload: {
            orderId: order.id,
            buyerOrganizationId: order.organizationId,
            supplierOrganizationId: order.supplierOrganizationId,
            confirmedAt: new Date().toISOString(),
          },
        });
      },
    });
  }

  /**
   * The supplier records delivery.
   *
   * The resulting state is `AWAITING_RECEIPT_CONFIRMATION`, not "fulfilled":
   * what matters next is that the platform is waiting for the buyer, and
   * nothing here releases money (ADR-038 § 2).
   */
  async fulfill(orderId: string, dto: FulfillOrderDto): Promise<OrderView> {
    const context = getContext();
    const fulfilledAt = new Date();
    const receiptDueAt = new Date(
      fulfilledAt.getTime() + this.env.MARKETPLACE_RECEIPT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    return this.transition(orderId, 'AWAITING_RECEIPT_CONFIRMATION', {
      authorise: (order) => assertSupplier(order, 'record fulfilment for this order'),
      apply: async (tx, order) => {
        const fulfillmentId = newId(ID_PREFIX.fulfillment);

        await runUnscoped('a fulfilment is filed under the order it belongs to', () =>
          tx.fulfillment.create({
            data: {
              id: fulfillmentId,
              organizationId: order.organizationId,
              orderId: order.id,
              trackingReference: dto.trackingReference ?? null,
              note: dto.note ?? null,
              fulfilledAt,
              fulfilledBy: context.userId ?? SERVICE_NAME,
              fulfilledByOrganizationId: order.supplierOrganizationId,
            },
          }),
        );

        await runUnscoped('the supplier records delivery on an order the buyer owns', () =>
          tx.order.update({
            where: { id: order.id },
            data: { status: 'AWAITING_RECEIPT_CONFIRMATION', fulfilledAt },
          }),
        );

        await this.events.enqueue(tx, {
          eventName: MARKETPLACE_EVENTS.ORDER_FULFILLED,
          aggregateId: order.id,
          organizationId: order.organizationId,
          payload: {
            orderId: order.id,
            fulfillmentId,
            buyerOrganizationId: order.organizationId,
            supplierOrganizationId: order.supplierOrganizationId,
            trackingReference: dto.trackingReference ?? null,
            fulfilledAt: fulfilledAt.toISOString(),
            receiptDueAt: receiptDueAt.toISOString(),
          },
        });
      },
    });
  }

  /**
   * The buyer confirms receipt — the only fact that permits settlement.
   *
   * Only the buying organization may do it. Not the supplier, who would be
   * confirming their own delivery; not a platform operator, who was not there
   * (ADR-038 § 5).
   */
  async confirmReceipt(orderId: string, _dto: ConfirmReceiptDto): Promise<OrderView> {
    const context = getContext();
    const confirmedAt = new Date();

    return this.transition(orderId, 'RECEIPT_CONFIRMED', {
      authorise: (order) => assertBuyer(order, 'confirm receipt'),
      apply: async (tx, order) => {
        await tx.order.update({
          where: { id: order.id },
          data: {
            status: 'RECEIPT_CONFIRMED',
            receiptConfirmedAt: confirmedAt,
            receiptConfirmedBy: context.userId ?? SERVICE_NAME,
          },
        });

        await this.events.enqueue(tx, {
          eventName: MARKETPLACE_EVENTS.ORDER_RECEIPT_CONFIRMED,
          aggregateId: order.id,
          organizationId: order.organizationId,
          payload: {
            orderId: order.id,
            buyerOrganizationId: order.organizationId,
            supplierOrganizationId: order.supplierOrganizationId,
            totalAmountMinor: order.totalAmountMinor.toString(),
            currency: order.currency,
            confirmedBy: context.userId ?? SERVICE_NAME,
            confirmedAt: confirmedAt.toISOString(),
          },
        });
      },
    });
  }

  /** A dispute stops settlement completely, on both sides (ADR-040 § 5). */
  async raiseDispute(orderId: string, dto: RaiseDisputeDto): Promise<OrderView> {
    const context = getContext();

    const view = await this.transition(orderId, 'DISPUTED', {
      authorise: (order) => assertBuyer(order, 'raise a dispute'),
      apply: async (tx, order) => {
        await runUnscoped('a dispute is filed under the order it belongs to', () =>
          tx.orderDispute.create({
            data: {
              id: newId(ID_PREFIX.dispute),
              organizationId: order.organizationId,
              orderId: order.id,
              reason: dto.reason,
              status: 'OPEN',
              raisedBy: context.userId ?? SERVICE_NAME,
            },
          }),
        );

        await tx.order.update({ where: { id: order.id }, data: { status: 'DISPUTED' } });

        const dispute = await runUnscoped('the event names the dispute just written', () =>
          tx.orderDispute.findFirst({
            where: { orderId: order.id, status: 'OPEN' },
            orderBy: { raisedAt: 'desc' },
          }),
        );

        await this.events.enqueue(tx, {
          eventName: MARKETPLACE_EVENTS.ORDER_DISPUTED,
          aggregateId: order.id,
          organizationId: order.organizationId,
          payload: {
            orderId: order.id,
            disputeId: dispute?.id ?? order.id,
            buyerOrganizationId: order.organizationId,
            supplierOrganizationId: order.supplierOrganizationId,
            reason: dto.reason,
            raisedBy: context.userId ?? SERVICE_NAME,
            raisedAt: new Date().toISOString(),
          },
        });
      },
    });

    disputesRaisedTotal.inc({ service: SERVICE_NAME });
    return view;
  }

  /**
   * A platform operator decides a dispute.
   *
   * The outcome re-enters the normal path rather than jumping to an end state:
   * `SETTLE` returns the order to `RECEIPT_CONFIRMED` so the saga settles it,
   * and `REFUND` moves it to `CANCELLING` so the saga compensates. Neither
   * moves money here.
   */
  async resolveDispute(orderId: string, dto: ResolveDisputeDto): Promise<OrderView> {
    const context = getContext();
    const target: OrderStatus = dto.outcome === 'SETTLE' ? 'RECEIPT_CONFIRMED' : 'CANCELLING';

    return this.transition(orderId, target, {
      authorise: () => assertDisputeResolver(),
      apply: async (tx, order) => {
        await runUnscoped('an operator resolves a dispute on either party’s order', () =>
          tx.orderDispute.updateMany({
            where: { orderId: order.id, status: 'OPEN' },
            data: {
              status: dto.outcome === 'SETTLE' ? 'RESOLVED_SETTLE' : 'RESOLVED_REFUND',
              resolution: dto.resolution,
              resolvedAt: new Date(),
              resolvedBy: context.userId ?? SERVICE_NAME,
            },
          }),
        );

        await runUnscoped('an operator resolves a dispute on either party’s order', () =>
          tx.order.update({
            where: { id: order.id },
            data:
              target === 'CANCELLING'
                ? { status: target, cancellationReason: dto.resolution }
                : { status: target },
          }),
        );
      },
      reason: dto.resolution,
    });
  }

  /** The buyer cancels. Compensation is the saga's job, not this method's. */
  async cancel(orderId: string, dto: CancelOrderDto): Promise<OrderView> {
    return this.transition(orderId, 'CANCELLING', {
      authorise: (order) => assertBuyer(order, 'cancel this order'),
      apply: async (tx, order) => {
        await tx.order.update({
          where: { id: order.id },
          data: { status: 'CANCELLING', cancellationReason: dto.reason },
        });
      },
      reason: dto.reason,
    });
  }

  /** A buyer reviews a completed order. One review per order. */
  async submitReview(
    orderId: string,
    dto: SubmitReviewDto,
  ): Promise<{ id: string; rating: number }> {
    const context = getContext();

    return this.prisma.transaction(async (tx) => {
      const order = await this.repository.lockOrder(tx, orderId);
      assertBuyer(order, 'review this order');

      if (order.status !== 'COMPLETED') {
        // `docs/17`: a review is only possible after a completed order. A
        // rating on an order that was never delivered would be a rating of
        // nothing.
        orderRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'REVIEW_BEFORE_COMPLETION' });
        throw RastaError.businessRule('Only a completed order may be reviewed', {
          orderId,
          status: order.status,
        });
      }

      const reviewId = newId(ID_PREFIX.review);

      await runUnscoped('a review is filed under the order it belongs to', () =>
        tx.review.create({
          data: {
            id: reviewId,
            organizationId: order.organizationId,
            orderId: order.id,
            supplierOrganizationId: order.supplierOrganizationId,
            rating: dto.rating,
            comment: dto.comment ?? null,
            submittedBy: context.userId ?? SERVICE_NAME,
          },
        }),
      );

      await this.events.enqueue(tx, {
        eventName: MARKETPLACE_EVENTS.REVIEW_SUBMITTED,
        aggregateId: reviewId,
        organizationId: order.organizationId,
        payload: {
          reviewId,
          orderId: order.id,
          buyerOrganizationId: order.organizationId,
          supplierOrganizationId: order.supplierOrganizationId,
          rating: dto.rating,
          submittedAt: new Date().toISOString(),
        },
      });

      return { id: reviewId, rating: dto.rating };
    });
  }

  // =========================================================================
  // Transitions the saga drives
  // =========================================================================

  /** The obligation exists and the money is held. */
  async markFundsHeld(orderId: string, transactionId: string): Promise<void> {
    await this.systemTransition(orderId, 'FUNDS_HELD', async (tx, order) => {
      await runUnscoped('the saga advances an order on behalf of neither party', () =>
        tx.order.update({
          where: { id: order.id },
          data: { status: 'FUNDS_HELD', economicTransactionId: transactionId },
        }),
      );
    });
  }

  /** The obligation could not be created — usually an empty wallet. */
  async markFailed(orderId: string, reason: string): Promise<void> {
    await this.systemTransition(
      orderId,
      'FAILED',
      async (tx, order) => {
        await runUnscoped('the saga records a failure on an order it could not fund', () =>
          tx.order.update({
            where: { id: order.id },
            data: { status: 'FAILED', failureReason: reason },
          }),
        );
        // Nothing was delivered, so what the order reserved goes back.
        const lines = await runUnscoped('a failed order returns what it reserved', () =>
          tx.orderLine.findMany({ where: { orderId: order.id } }),
        );
        await this.repository.restoreAvailability(tx, lines);
      },
      reason,
    );
  }

  async markSettling(orderId: string): Promise<void> {
    await this.systemTransition(orderId, 'SETTLING', async (tx, order) => {
      await runUnscoped('the saga records that settlement is in flight', () =>
        tx.order.update({ where: { id: order.id }, data: { status: 'SETTLING' } }),
      );
    });
  }

  /** A settlement attempt failed; the order is still authorised. */
  async markSettlementFailed(orderId: string): Promise<void> {
    await this.systemTransition(orderId, 'RECEIPT_CONFIRMED', async (tx, order) => {
      await runUnscoped('the saga returns an order whose settlement attempt failed', () =>
        tx.order.update({ where: { id: order.id }, data: { status: 'RECEIPT_CONFIRMED' } }),
      );
    });
  }

  /** Settlement succeeded. The only path to `COMPLETED`. */
  async markCompleted(
    orderId: string,
    settlement: {
      settlementId: string;
      commissionAmountMinor: string;
      netAmountMinor: string;
    },
  ): Promise<void> {
    await this.systemTransition(orderId, 'COMPLETED', async (tx, order) => {
      const completedAt = new Date();
      await runUnscoped('the saga closes an order economic-service reported settled', () =>
        tx.order.update({
          where: { id: order.id },
          data: {
            status: 'COMPLETED',
            completedAt,
            economicSettlementId: settlement.settlementId,
          },
        }),
      );

      await this.events.enqueue(tx, {
        eventName: MARKETPLACE_EVENTS.ORDER_COMPLETED,
        aggregateId: order.id,
        organizationId: order.organizationId,
        payload: {
          orderId: order.id,
          buyerOrganizationId: order.organizationId,
          supplierOrganizationId: order.supplierOrganizationId,
          totalAmountMinor: order.totalAmountMinor.toString(),
          // Echoed from economic-service, never computed here: this service
          // does not know a commission rate and must not appear to (ADR-040).
          commissionAmountMinor: settlement.commissionAmountMinor,
          netAmountMinor: settlement.netAmountMinor,
          currency: order.currency,
          settlementId: settlement.settlementId,
          completedAt: completedAt.toISOString(),
        },
      });
    });
  }

  /** Compensation finished. Published only after the refund succeeded. */
  async markCancelled(orderId: string, reason: string): Promise<void> {
    await this.systemTransition(
      orderId,
      'CANCELLED',
      async (tx, order) => {
        const cancelledAt = new Date();
        await runUnscoped('the saga closes an order whose compensation completed', () =>
          tx.order.update({
            where: { id: order.id },
            data: { status: 'CANCELLED', cancelledAt, cancellationReason: reason },
          }),
        );

        const lines = await runUnscoped('a cancelled order returns what it reserved', () =>
          tx.orderLine.findMany({ where: { orderId: order.id } }),
        );
        await this.repository.restoreAvailability(tx, lines);

        await this.events.enqueue(tx, {
          eventName: MARKETPLACE_EVENTS.ORDER_CANCELLED,
          aggregateId: order.id,
          organizationId: order.organizationId,
          payload: {
            orderId: order.id,
            buyerOrganizationId: order.organizationId,
            supplierOrganizationId: order.supplierOrganizationId,
            totalAmountMinor: order.totalAmountMinor.toString(),
            currency: order.currency,
            reason,
            cancelledBy: getContext().callerService ?? SERVICE_NAME,
            cancelledAt: cancelledAt.toISOString(),
          },
        });
      },
      reason,
    );
  }

  /**
   * Records that a window elapsed and the order is still waiting.
   *
   * **Moves no money and changes no state** (ADR-043). The history row has
   * `fromStatus === toStatus` and kind `REMINDER`, which the database enforces:
   * recording it as a transition would claim something happened that did not.
   */
  async recordReminder(orderId: string): Promise<void> {
    await this.prisma.transaction(async (tx) => {
      const order = await this.repository.lockOrder(tx, orderId);

      await runUnscoped('an overdue order is counted by the saga, for neither party', () =>
        tx.order.update({
          where: { id: order.id },
          data: { reminderCount: { increment: 1 }, lastReminderAt: new Date() },
        }),
      );

      await this.repository.recordHistory(tx, {
        orderId: order.id,
        organizationId: order.organizationId,
        kind: 'REMINDER',
        fromStatus: order.status,
        toStatus: order.status,
        reason: 'The configured window elapsed and the order is still waiting',
      });
    });

    const order = await this.repository.findForParty(orderId);
    remindersRecordedTotal.inc({
      service: SERVICE_NAME,
      status: order?.status ?? 'UNKNOWN',
    });
  }

  /** What the saga needs to know to drive an order without re-reading it. */
  async describe(orderId: string): Promise<{
    id: string;
    status: OrderStatus;
    buyerOrganizationId: string;
    supplierOrganizationId: string;
    totalAmountMinor: string;
    currency: string;
    economicTransactionId: string | null;
    correlationId: string;
  }> {
    const row = await this.repository.findForParty(orderId);
    if (!row) throw RastaError.notFound('Order', orderId);
    return {
      id: row.id,
      status: row.status,
      buyerOrganizationId: row.organizationId,
      supplierOrganizationId: row.supplierOrganizationId,
      totalAmountMinor: row.totalAmountMinor.toString(),
      currency: row.currency,
      economicTransactionId: row.economicTransactionId,
      correlationId: row.correlationId,
    };
  }

  // =========================================================================
  // Internals
  // =========================================================================

  /**
   * The shape every user-driven transition shares.
   *
   * Written once rather than per command, because the sequence — lock, check,
   * apply, record — is exactly the kind of thing that gets one step wrong when
   * it is repeated eight times.
   */
  private async transition(
    orderId: string,
    to: OrderStatus,
    handlers: {
      authorise: (order: LockedOrderRow) => void;
      apply: (tx: ExtendedPrismaClient, order: LockedOrderRow) => Promise<void>;
      reason?: string;
    },
  ): Promise<OrderView> {
    const view = await this.prisma.transaction(async (tx) => {
      const order = await this.repository.lockOrder(tx, orderId);

      handlers.authorise(order);

      try {
        assertTransition(order.id, order.status, to);
      } catch (error) {
        orderRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'ILLEGAL_TRANSITION' });
        throw error;
      }

      await handlers.apply(tx, order);

      await this.repository.recordHistory(tx, {
        orderId: order.id,
        organizationId: order.organizationId,
        kind: 'TRANSITION',
        fromStatus: order.status,
        toStatus: to,
        reason: handlers.reason ?? null,
      });

      return this.load(tx, order.id);
    });

    orderTransitionsTotal.inc({ service: SERVICE_NAME, to });
    return view;
  }

  /**
   * A transition the saga performs, with no user in context.
   *
   * The authorisation step is absent rather than skipped: these are only
   * reachable from an activity inside this service's own process, and there is
   * no caller to check. What remains is the state machine, which is the part
   * that keeps a saga from settling an order twice.
   */
  private async systemTransition(
    orderId: string,
    to: OrderStatus,
    apply: (tx: ExtendedPrismaClient, order: LockedOrderRow) => Promise<void>,
    reason?: string,
  ): Promise<void> {
    await this.prisma.transaction(async (tx) => {
      const order = await this.repository.lockOrder(tx, orderId);

      if (order.status === to) {
        // A Temporal retry re-running a completed activity. Not an error: the
        // effect it wanted is already there, which is what makes the activity
        // idempotent.
        return;
      }

      assertTransition(order.id, order.status, to);
      await apply(tx, order);

      await this.repository.recordHistory(tx, {
        orderId: order.id,
        organizationId: order.organizationId,
        kind: 'TRANSITION',
        fromStatus: order.status,
        toStatus: to,
        reason: reason ?? null,
      });
    });

    orderTransitionsTotal.inc({ service: SERVICE_NAME, to });
  }

  private async load(tx: ExtendedPrismaClient, orderId: string): Promise<OrderView> {
    const row = await runUnscoped('reading back the order just written in this transaction', () =>
      tx.order.findUnique({ where: { id: orderId }, include: { lines: true } }),
    );
    if (!row) throw RastaError.notFound('Order', orderId);
    return toView(row);
  }
}

type OrderRow = {
  id: string;
  status: OrderStatus;
  organizationId: string;
  supplierOrganizationId: string;
  totalAmountMinor: bigint;
  currency: string;
  economicTransactionId: string | null;
  economicSettlementId: string | null;
  reminderCount: number;
  lastReminderAt: Date | null;
  confirmedAt: Date | null;
  fulfilledAt: Date | null;
  receiptConfirmedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  failureReason: string | null;
  createdAt: Date;
  placedBy: string;
  lines: {
    offerId: string;
    productId: string;
    productName: string;
    quantity: number;
    unitPriceMinor: bigint;
    lineTotalMinor: bigint;
    currency: string;
    offerVersion: number;
  }[];
};

export function toView(row: OrderRow): OrderView {
  return {
    id: row.id,
    status: row.status,
    buyerOrganizationId: row.organizationId,
    supplierOrganizationId: row.supplierOrganizationId,
    totalAmountMinor: row.totalAmountMinor.toString(),
    currency: row.currency,
    lines: row.lines.map((line) => ({
      offerId: line.offerId,
      productId: line.productId,
      productName: line.productName,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor.toString(),
      lineTotalMinor: line.lineTotalMinor.toString(),
      currency: line.currency,
      offerVersion: line.offerVersion,
    })),
    economicTransactionId: row.economicTransactionId,
    economicSettlementId: row.economicSettlementId,
    // ADR-041: not `false`. A false says the check ran and failed.
    supplierQualification: 'UNAVAILABLE',
    reminderCount: row.reminderCount,
    lastReminderAt: row.lastReminderAt?.toISOString() ?? null,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    fulfilledAt: row.fulfilledAt?.toISOString() ?? null,
    receiptConfirmedAt: row.receiptConfirmedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancellationReason: row.cancellationReason,
    failureReason: row.failureReason,
    createdAt: row.createdAt.toISOString(),
    placedBy: row.placedBy,
  };
}
