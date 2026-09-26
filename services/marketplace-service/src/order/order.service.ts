import { Inject, Injectable } from '@nestjs/common';
import { RastaError, getContext, getOrganizationId, runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { MARKETPLACE_EVENTS } from '../events/events';
import {
  assertBuyer,
  assertDisputeResolver,
  assertOrderVisible,
  viewerParties,
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
import { availableOrderActions } from './order-actions';
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

const DAY_MS = 24 * 60 * 60 * 1000;

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
            leadTimeDays: row.lead_time_days,
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

      // The supplier's committed delivery date (ADR-052 § 1-a), fixed now
      // from the slowest lead time among the offers just priced. One instant
      // for the stored column and the event payload below, so the two can
      // never disagree about when "now" was.
      const createdAt = new Date();
      const promisedDeliveryAt = new Date(createdAt.getTime() + priced.maxLeadTimeDays * DAY_MS);

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
          promisedDeliveryAt,
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
          createdAt: createdAt.toISOString(),
          promisedDeliveryAt: promisedDeliveryAt.toISOString(),
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
      // Never from DISPUTED. That edge belongs to `resolveDispute` and to a
      // platform operator; a buyer travelling it would be resolving their own
      // dispute in their own favour.
      from: ['AWAITING_RECEIPT_CONFIRMATION'],
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
    const resolvedAt = new Date();

    return this.transition(orderId, target, {
      // The mirror of the restriction on `confirmReceipt`: an operator resolves
      // a dispute, and there is nothing to resolve on an order that has none.
      from: ['DISPUTED'],
      authorise: () => assertDisputeResolver(),
      apply: async (tx, order) => {
        // Read before the update names the dispute the event below is about —
        // the same pattern `raiseDispute` uses, and for the same reason: after
        // `updateMany` flips it away from OPEN, nothing OPEN is left to find.
        const dispute = await runUnscoped(
          'an operator resolves the dispute open on either party’s order',
          () =>
            tx.orderDispute.findFirst({
              where: { orderId: order.id, status: 'OPEN' },
              orderBy: { raisedAt: 'desc' },
            }),
        );

        await runUnscoped('an operator resolves a dispute on either party’s order', () =>
          tx.orderDispute.updateMany({
            where: { orderId: order.id, status: 'OPEN' },
            data: {
              status: dto.outcome === 'SETTLE' ? 'RESOLVED_SETTLE' : 'RESOLVED_REFUND',
              resolution: dto.resolution,
              // Chosen by the operator, never derived from `resolution`
              // (ADR-052 § 4 rule 14).
              responsibility: dto.responsibility,
              resolvedAt,
              resolvedBy: context.userId ?? SERVICE_NAME,
            },
          }),
        );

        await runUnscoped('an operator resolves a dispute on either party’s order', () =>
          tx.order.update({
            where: { id: order.id },
            data:
              target === 'CANCELLING'
                ? {
                    status: target,
                    cancellationReason: dto.resolution,
                    // Propagated from the dispute's own structured
                    // attribution — not re-decided and not parsed from text.
                    cancellationCause: dto.responsibility,
                  }
                : { status: target },
          }),
        );

        await this.events.enqueue(tx, {
          eventName: MARKETPLACE_EVENTS.ORDER_DISPUTE_RESOLVED,
          aggregateId: order.id,
          organizationId: order.organizationId,
          payload: {
            orderId: order.id,
            disputeId: dispute?.id ?? order.id,
            buyerOrganizationId: order.organizationId,
            supplierOrganizationId: order.supplierOrganizationId,
            outcome: dto.outcome,
            responsibility: dto.responsibility,
            resolvedBy: context.userId ?? SERVICE_NAME,
            resolvedAt: resolvedAt.toISOString(),
          },
        });
      },
      reason: dto.resolution,
    });
  }

  /** The buyer cancels. Compensation is the saga's job, not this method's. */
  async cancel(orderId: string, dto: CancelOrderDto): Promise<OrderView> {
    return this.transition(orderId, 'CANCELLING', {
      // Narrower than the transition table, for the same reason
      // `confirmReceipt` is. `ORDER_TRANSITIONS` has `DISPUTED → CANCELLING`
      // because a platform operator's `ResolveDispute(REFUND)` travels it
      // (ADR-038). Without this list the buyer's own `CancelOrder` travelled
      // it too: the party who raised the dispute could end it by cancelling,
      // the saga would refund the escrow, and a supplier who had delivered
      // would go unpaid. Leaving a dispute is the operator's decision, whichever
      // exit it takes.
      from: ['PENDING', 'FUNDS_HELD', 'CONFIRMED', 'AWAITING_RECEIPT_CONFIRMATION'],
      authorise: (order) => assertBuyer(order, 'cancel this order'),
      apply: async (tx, order) => {
        await tx.order.update({
          where: { id: order.id },
          data: {
            status: 'CANCELLING',
            cancellationReason: dto.reason,
            // The buyer's own self-service cancellation, with no dispute and
            // no operator ruling — never the supplier's fault (ADR-052 § 4
            // rule 13). Fixed by which command this is, not read from
            // `dto.reason` (rule 14).
            cancellationCause: 'BUYER',
          },
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
      // As in `transition()`: a stranger learns nothing, a party learns why.
      assertOrderVisible(order);
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

  /**
   * The obligation exists and the money is held.
   *
   * Returns `CANCELLING` instead of refusing when the buyer cancelled while
   * the hold was being placed. The money is held either way, so the
   * transaction id is recorded on the order in both cases, and the saga
   * compensates. Refusing here used to send the saga into its "nothing has
   * moved" branch, which tried `CANCELLING -> FAILED`, failed on that too, and
   * left the order stuck in `CANCELLING` with the buyer's funds held.
   */
  async markFundsHeld(orderId: string, transactionId: string): Promise<OrderStatus> {
    const recordHold = async (
      tx: ExtendedPrismaClient,
      order: LockedOrderRow,
      status: 'FUNDS_HELD' | 'CANCELLING',
    ) => {
      await runUnscoped('the saga records the hold on an order on behalf of neither party', () =>
        tx.order.update({
          where: { id: order.id },
          data: { status, economicTransactionId: transactionId },
        }),
      );

      // The audit record of the hold (L7-14), in the same transaction. Only
      // the write that first records this obligation announces it: a Temporal
      // retry of the yielding branch re-runs this with the id already stored.
      if (order.economicTransactionId === transactionId) return;
      await this.events.enqueue(tx, {
        eventName: MARKETPLACE_EVENTS.ORDER_FUNDS_HELD,
        aggregateId: order.id,
        organizationId: order.organizationId,
        payload: {
          ...this.partiesOf(order),
          transactionId,
          status,
          heldAt: new Date().toISOString(),
        },
      });
    };

    return this.systemTransition(orderId, 'FUNDS_HELD', {
      from: ['PENDING'],
      apply: (tx, order) => recordHold(tx, order, 'FUNDS_HELD'),
      yieldTo: ['CANCELLING'],
      onYield: (tx, order) => recordHold(tx, order, 'CANCELLING'),
    });
  }

  /**
   * The obligation could not be created — usually an empty wallet.
   *
   * Returns `CANCELLING` without changing anything when the buyer cancelled
   * first: that order did not fail, it was cancelled, and the saga closes it
   * as cancelled. Nothing was held, so there is nothing to refund.
   */
  async markFailed(orderId: string, reason: string): Promise<OrderStatus> {
    return this.systemTransition(orderId, 'FAILED', {
      from: ['PENDING'],
      yieldTo: ['CANCELLING'],
      reason,
      apply: async (tx, order) => {
        await runUnscoped('the saga records a failure on an order it could not fund', () =>
          tx.order.update({
            where: { id: order.id },
            data: { status: 'FAILED', failureReason: reason },
          }),
        );
        // No reason on the wire: it is economic-service's refusal text. It
        // stays on the row, behind the API (L7-14).
        await this.events.enqueue(tx, {
          eventName: MARKETPLACE_EVENTS.ORDER_FAILED,
          aggregateId: order.id,
          organizationId: order.organizationId,
          payload: { ...this.partiesOf(order), failedAt: new Date().toISOString() },
        });
        // Nothing was delivered, so what the order reserved goes back.
        const lines = await runUnscoped('a failed order returns what it reserved', () =>
          tx.orderLine.findMany({ where: { orderId: order.id } }),
        );
        await this.repository.restoreAvailability(tx, lines);
      },
    });
  }

  /**
   * Settlement is about to be attempted.
   *
   * Returns `DISPUTED` without changing anything when a dispute committed
   * after the saga last looked. The saga then goes back to waiting on the
   * dispute rather than treating the refusal as a failed settlement attempt.
   */
  async markSettling(orderId: string): Promise<OrderStatus> {
    return this.systemTransition(orderId, 'SETTLING', {
      from: ['RECEIPT_CONFIRMED'],
      yieldTo: ['DISPUTED'],
      apply: async (tx, order) => {
        await runUnscoped('the saga records that settlement is in flight', () =>
          tx.order.update({ where: { id: order.id }, data: { status: 'SETTLING' } }),
        );
        await this.events.enqueue(tx, {
          eventName: MARKETPLACE_EVENTS.ORDER_SETTLEMENT_STARTED,
          aggregateId: order.id,
          organizationId: order.organizationId,
          payload: { ...this.partiesOf(order), startedAt: new Date().toISOString() },
        });
      },
    });
  }

  /**
   * A settlement attempt failed; the order is still authorised.
   *
   * **From `SETTLING` only.** The transition table also has
   * `DISPUTED -> RECEIPT_CONFIRMED`, but that edge belongs to an operator's
   * `resolveDispute(SETTLE)`. Borrowed by this command, a dispute that
   * committed between the saga's check and `markSettling` was erased: the
   * refused `markSettling` counted as a failed attempt, and this call then
   * moved the order out of `DISPUTED` with nobody having decided anything.
   */
  async markSettlementFailed(orderId: string): Promise<OrderStatus> {
    return this.systemTransition(orderId, 'RECEIPT_CONFIRMED', {
      from: ['SETTLING'],
      apply: async (tx, order) => {
        await runUnscoped('the saga returns an order whose settlement attempt failed', () =>
          tx.order.update({ where: { id: order.id }, data: { status: 'RECEIPT_CONFIRMED' } }),
        );
        await this.events.enqueue(tx, {
          eventName: MARKETPLACE_EVENTS.ORDER_SETTLEMENT_FAILED,
          aggregateId: order.id,
          organizationId: order.organizationId,
          payload: { ...this.partiesOf(order), failedAt: new Date().toISOString() },
        });
      },
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
  ): Promise<OrderStatus> {
    return this.systemTransition(orderId, 'COMPLETED', {
      from: ['SETTLING'],
      apply: async (tx, order) => {
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
      },
    });
  }

  /**
   * Compensation finished, or there was nothing to compensate. Published only
   * after the refund, if one was owed, succeeded.
   */
  async markCancelled(orderId: string, reason: string): Promise<OrderStatus> {
    return this.systemTransition(orderId, 'CANCELLED', {
      from: ['CANCELLING'],
      reason,
      apply: async (tx, order) => {
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
            // Fixed at `CANCELLING` by `cancel()` or `resolveDispute()`, never
            // parsed from `reason` (ADR-052 § 4 rule 14). `UNDETERMINED` is
            // the honest fallback for a row written before this column
            // existed — it excludes the order from a denominator, never
            // zeroes it (rule 13).
            cancellationCause: order.cancellationCause ?? 'UNDETERMINED',
          },
        });
      },
    });
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

  /**
   * What the saga acts on: the order as the database has it now (ADR-039).
   *
   * A signal only tells the saga to look. The decision, and every piece of
   * text passed on to economic-service, comes from here, so a signal that was
   * lost, repeated or sent to the wrong order can make the saga look sooner
   * but can never tell it something the order does not say.
   */
  async sagaView(orderId: string): Promise<{
    status: OrderStatus;
    economicTransactionId: string | null;
    cancellationReason: string | null;
    /** The most recent dispute's reason and, once decided, its resolution. */
    dispute: { id: string; reason: string; resolution: string | null } | null;
  }> {
    const row = await this.repository.findForParty(orderId);
    if (!row) throw RastaError.notFound('Order', orderId);

    const dispute = await runUnscoped('the saga reads the dispute on the order it drives', () =>
      this.prisma.client.orderDispute.findFirst({
        where: { orderId: row.id },
        orderBy: { raisedAt: 'desc' },
        select: { id: true, reason: true, resolution: true },
      }),
    );

    return {
      status: row.status,
      economicTransactionId: row.economicTransactionId,
      cancellationReason: row.cancellationReason,
      dispute,
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
      /**
       * The states this particular command may be issued from.
       *
       * The transition table says which moves are legal; it does not say *who*
       * may make them, and two commands can legitimately target the same state
       * from different places. `DISPUTED → RECEIPT_CONFIRMED` exists for an
       * operator resolving a dispute — and without this restriction the buyer's
       * own `ConfirmReceipt` would travel the same edge, letting the party who
       * raised the dispute walk out of it and release the money. That is the
       * one invariant this service exists to keep, so the restriction is
       * declared per command rather than inferred.
       */
      from?: readonly OrderStatus[];
    },
  ): Promise<OrderView> {
    const view = await this.prisma.transaction(async (tx) => {
      const order = await this.repository.lockOrder(tx, orderId);

      // Visibility before the party check, as `get()` does. `lockOrder` is
      // unscoped — the supplier must be able to reach the buyer's row — so
      // without this an organization that is neither party reached
      // `assertSupplier`/`assertBuyer` and was refused with **403**: an answer
      // that confirms the order exists, and whose message ("only the supplying
      // organization may…") says it has one. The controller promises 404 to a
      // stranger for exactly that reason. Either real party still passes here
      // and gets the 403 below when they try the other side's command — they
      // can already see the order, so 404 would be a lie to them.
      assertOrderVisible(order);
      handlers.authorise(order);

      if (handlers.from && !handlers.from.includes(order.status)) {
        orderRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'WRONG_SOURCE_STATE' });
        throw RastaError.businessRule(
          `Order ${order.id} cannot take this command while it is ${order.status}`,
          { orderId: order.id, status: order.status },
        );
      }

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
   *
   * ## `from`: the table is not enough
   *
   * The table says which moves are legal, not which command may make them —
   * the lesson `transition()` records for the parties' commands. Each saga
   * step names the states it may leave, so a step can never borrow an edge
   * that exists for somebody else's decision.
   *
   * ## `yieldTo`: a party got there first
   *
   * The saga acts on what it last read, and a party's command can commit in
   * between. For a state a step lists in `yieldTo`, the step changes nothing
   * and returns the state it found, and the saga takes the path that state
   * calls for. Any other unexpected state is still refused.
   *
   * Returns the order's status after the call.
   */
  private async systemTransition(
    orderId: string,
    to: OrderStatus,
    step: {
      from: readonly OrderStatus[];
      apply: (tx: ExtendedPrismaClient, order: LockedOrderRow) => Promise<unknown>;
      yieldTo?: readonly OrderStatus[];
      /** Runs inside the lock when the step yields. */
      onYield?: (tx: ExtendedPrismaClient, order: LockedOrderRow) => Promise<unknown>;
      reason?: string;
    },
  ): Promise<OrderStatus> {
    const outcome = await this.prisma.transaction(async (tx) => {
      const order = await this.repository.lockOrder(tx, orderId);

      if (order.status === to) {
        // A Temporal retry re-running a completed activity. Not an error: the
        // effect it wanted is already there, which is what makes the activity
        // idempotent.
        return { status: to, moved: false };
      }

      if (step.yieldTo?.includes(order.status)) {
        await step.onYield?.(tx, order);
        return { status: order.status, moved: false };
      }

      // The table first, so a finished order is refused as finished.
      assertTransition(order.id, order.status, to);
      if (!step.from.includes(order.status)) {
        orderRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'WRONG_SOURCE_STATE' });
        throw RastaError.businessRule(
          `The order saga cannot move order ${order.id} from ${order.status} to ${to}`,
          { orderId: order.id, from: order.status, to },
        );
      }

      await step.apply(tx, order);

      await this.repository.recordHistory(tx, {
        orderId: order.id,
        organizationId: order.organizationId,
        kind: 'TRANSITION',
        fromStatus: order.status,
        toStatus: to,
        reason: step.reason ?? null,
      });
      return { status: to, moved: true };
    });

    if (outcome.moved) orderTransitionsTotal.inc({ service: SERVICE_NAME, to });
    return outcome.status;
  }

  /** The parties and amount every saga audit record names (L7-14). */
  private partiesOf(order: LockedOrderRow) {
    return {
      orderId: order.id,
      buyerOrganizationId: order.organizationId,
      supplierOrganizationId: order.supplierOrganizationId,
      totalAmountMinor: order.totalAmountMinor.toString(),
      currency: order.currency,
    };
  }

  private async load(tx: ExtendedPrismaClient, orderId: string): Promise<OrderView> {
    const row = await runUnscoped('reading back the order just written in this transaction', () =>
      tx.order.findUnique({
        where: { id: orderId },
        include: { lines: true, review: { select: { id: true } } },
      }),
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
  /**
   * Whether this order has been reviewed — `Review.orderId` is unique, so at
   * most one. Selected by **every** path that builds a view (both reads and
   * `load`, the read-back after a command), because `availableActions` offers
   * `REVIEW` only when it is absent: a path that forgot to select it would
   * read `undefined` as "no review" and offer a second one the unique
   * constraint then refuses. **Required** in this type for exactly that
   * reason: a query that forgets the include no longer typechecks, instead of
   * quietly offering a second review.
   */
  review: { id: string } | null;
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
    // Computed per caller, from the request context — so the same order
    // answers differently to its buyer, its supplier and an operator, which
    // is the whole point. Not a permission check: every command re-checks its
    // own transition and its own `assert*` when it runs.
    availableActions: [
      ...availableOrderActions(
        { status: row.status, hasReview: row.review != null },
        viewerParties(row),
      ),
    ],
  };
}
