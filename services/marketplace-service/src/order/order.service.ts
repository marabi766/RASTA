import { Inject, Injectable, Logger } from '@nestjs/common';
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
  recordDisputeDecision,
  type DisputeAuthority,
  type OrderParties,
} from '../access/access';
import {
  OrganizationHierarchy,
  type HierarchyQuestion,
} from '../organization/organization-hierarchy';
import { ENV } from '../tokens';
import { ECONOMIC_SERVICE, SERVICE_NAME, type MarketplaceEnv } from '../config/env';
import {
  disputesRaisedTotal,
  orderRefusalsTotal,
  orderTransitionsTotal,
  ordersCreatedTotal,
  remindersRecordedTotal,
} from '../observability/metrics';
import { isUniqueViolation, violatedConstraint } from '../shared/prisma-errors';
import type { RecordResponse } from '../shared/idempotency';
import {
  OrderRepository,
  type LockedOrderRow,
  type SagaActivity,
  type SagaStep,
} from './order.repository';
import { ORDER_TRANSITIONS, assertTransition, isTerminal } from './state-machine';
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
import type { OrderStatus, Prisma } from '../generated/prisma';

const DAY_MS = 24 * 60 * 60 * 1000;

/** One Idempotency-Key, at most one order per organization (review of #141). */
const ORDER_KEY_INDEX = 'uq_order_org_idempotency_key';

/**
 * Who may issue each party command on an order — the object check every
 * command runs after visibility, written once so the command and its replay
 * guard ({@link OrderService.assertReplayVisible}) cannot disagree. `place`
 * has none beyond visibility: the order it names was placed by the caller's
 * own organization.
 */
const COMMAND_AUTHORISATION = {
  place: () => undefined,
  confirm: (order: OrderParties) => assertSupplier(order, 'confirm this order'),
  fulfill: (order: OrderParties) => assertSupplier(order, 'record fulfilment for this order'),
  confirmReceipt: (order: OrderParties) => assertBuyer(order, 'confirm receipt'),
  raiseDispute: (order: OrderParties) => assertBuyer(order, 'raise a dispute'),
  // The one check that asks organization-service (docs/24 Q-136).
  resolveDispute: (order: OrderParties, hierarchy: HierarchyQuestion) =>
    assertDisputeResolver(order, hierarchy),
  cancel: (order: OrderParties) => assertBuyer(order, 'cancel this order'),
  review: (order: OrderParties) => assertBuyer(order, 'review this order'),
} satisfies Record<
  string,
  (order: OrderParties, hierarchy: HierarchyQuestion) => unknown | Promise<unknown>
>;

export type OrderCommand = keyof typeof COMMAND_AUTHORISATION;

/**
 * Whether a unique violation's target is that index. The driver names either
 * the index or its columns, depending on how it reports the violation.
 */
function isOrderKeyIndex(target: string | undefined): boolean {
  return (
    target !== undefined &&
    (target === ORDER_KEY_INDEX ||
      target.includes('idempotency_key') ||
      target.includes('idempotencyKey'))
  );
}

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
  private readonly logger = new Logger(OrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: OrderRepository,
    private readonly events: EventPublisher,
    @Inject(ENV) private readonly env: MarketplaceEnv,
    @Inject(OrganizationHierarchy) private readonly hierarchy: HierarchyQuestion,
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
  async place(
    dto: CreateOrderDto,
    idempotencyKey: string,
    record?: RecordResponse<OrderView>,
  ): Promise<OrderView> {
    const context = getContext();
    const buyerOrganizationId = getOrganizationId();
    const actor = context.userId ?? context.callerService ?? SERVICE_NAME;

    let order: OrderView;
    try {
      order = await this.prisma.transaction(async (tx) => {
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

        const view = await this.load(tx, orderId);
        // The last statement: the order and its completed key commit together.
        await record?.(tx, view);
        return view;
      });
    } catch (error) {
      // The key already placed an order in this organization, and its
      // idempotency record — which would have replayed that order — is gone:
      // released after the order committed, or purged after it expired. The
      // index refuses a second order; the caller learns it as a conflict, not
      // a 500, and without Retry-After, because waiting will not change it.
      if (isUniqueViolation(error) && isOrderKeyIndex(violatedConstraint(error))) {
        throw new RastaError(
          'CONFLICT',
          'An order has already been placed with this Idempotency-Key',
          // The index, never the key (S-09).
          { internalContext: { constraint: ORDER_KEY_INDEX } },
        );
      }
      throw error;
    }

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

  /**
   * The replay guard of every idempotent order route (#253): before a stored
   * response is returned, the caller must still pass the checks the command
   * itself runs before its transition — visibility (404 to a stranger, as
   * `get()` answers) and the command's party check (403) — by the rules and
   * the order as they are now. Nothing is locked or written and no transition
   * is checked: a replay answers what was done, not whether it could be done
   * again.
   */
  async assertReplayVisible(orderId: string, command: OrderCommand): Promise<void> {
    const row = await this.repository.findForParty(orderId);
    if (!row) throw RastaError.notFound('Order', orderId);

    assertOrderVisible(row);
    await COMMAND_AUTHORISATION[command](row, this.hierarchy);
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
  async confirm(orderId: string, record?: RecordResponse<OrderView>): Promise<OrderView> {
    return this.transition(orderId, 'CONFIRMED', {
      record,
      authorise: COMMAND_AUTHORISATION.confirm,
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
  async fulfill(
    orderId: string,
    dto: FulfillOrderDto,
    record?: RecordResponse<OrderView>,
  ): Promise<OrderView> {
    const context = getContext();
    const fulfilledAt = new Date();
    const receiptDueAt = new Date(
      fulfilledAt.getTime() + this.env.MARKETPLACE_RECEIPT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    return this.transition(orderId, 'AWAITING_RECEIPT_CONFIRMATION', {
      record,
      authorise: COMMAND_AUTHORISATION.fulfill,
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
  async confirmReceipt(
    orderId: string,
    _dto: ConfirmReceiptDto,
    record?: RecordResponse<OrderView>,
  ): Promise<OrderView> {
    const context = getContext();
    const confirmedAt = new Date();

    return this.transition(orderId, 'RECEIPT_CONFIRMED', {
      record,
      // Never from DISPUTED. That edge belongs to `resolveDispute` and to a
      // platform operator; a buyer travelling it would be resolving their own
      // dispute in their own favour.
      from: ['AWAITING_RECEIPT_CONFIRMATION'],
      authorise: COMMAND_AUTHORISATION.confirmReceipt,
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
  async raiseDispute(
    orderId: string,
    dto: RaiseDisputeDto,
    record?: RecordResponse<OrderView>,
  ): Promise<OrderView> {
    const context = getContext();

    const view = await this.transition(orderId, 'DISPUTED', {
      record,
      authorise: COMMAND_AUTHORISATION.raiseDispute,
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
   * moves money here — but each decides that money moves, on the buyer's
   * books, so a union administrator decides only for a buyer within its
   * union's subtree ({@link assertDisputeResolver}, docs/24 Q-136).
   */
  async resolveDispute(
    orderId: string,
    dto: ResolveDisputeDto,
    record?: RecordResponse<OrderView>,
  ): Promise<OrderView> {
    const context = getContext();
    const target: OrderStatus = dto.outcome === 'SETTLE' ? 'RECEIPT_CONFIRMED' : 'CANCELLING';
    const resolvedAt = new Date();
    let authority: DisputeAuthority | undefined;

    const view = await this.transition(orderId, target, {
      record,
      // The mirror of the restriction on `confirmReceipt`: an operator resolves
      // a dispute, and there is nothing to resolve on an order that has none.
      from: ['DISPUTED'],
      // Under the order's row lock: nothing else the decision writes is
      // locked after this, so organization-service's answer is the last thing
      // read before the decision is written.
      authorise: async (order) => {
        authority = await COMMAND_AUTHORISATION.resolveDispute(order, this.hierarchy);
      },
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
    if (authority) recordDisputeDecision(orderId, dto.outcome, authority);
    return view;
  }

  /** The buyer cancels. Compensation is the saga's job, not this method's. */
  async cancel(
    orderId: string,
    dto: CancelOrderDto,
    record?: RecordResponse<OrderView>,
  ): Promise<OrderView> {
    return this.transition(orderId, 'CANCELLING', {
      record,
      // Narrower than the transition table, for the same reason
      // `confirmReceipt` is. `ORDER_TRANSITIONS` has `DISPUTED → CANCELLING`
      // because a platform operator's `ResolveDispute(REFUND)` travels it
      // (ADR-038). Without this list the buyer's own `CancelOrder` travelled
      // it too: the party who raised the dispute could end it by cancelling,
      // the saga would refund the escrow, and a supplier who had delivered
      // would go unpaid. Leaving a dispute is the operator's decision, whichever
      // exit it takes.
      from: ['PENDING', 'FUNDS_HELD', 'CONFIRMED', 'AWAITING_RECEIPT_CONFIRMATION'],
      authorise: COMMAND_AUTHORISATION.cancel,
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
    record?: RecordResponse<{ id: string; rating: number }>,
  ): Promise<{ id: string; rating: number }> {
    const context = getContext();

    return this.prisma.transaction(async (tx) => {
      const order = await this.repository.lockOrder(tx, orderId);
      // As in `transition()`: a stranger learns nothing, a party learns why.
      assertOrderVisible(order);
      COMMAND_AUTHORISATION.review(order);

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

      const review = { id: reviewId, rating: dto.rating };
      await record?.(tx, review);
      return review;
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
   *
   * A retry is recognised by its step record and, failing that, by the
   * obligation itself: `economic_transaction_id` is unique and written only
   * here, so an order carrying this transaction has had this hold recorded,
   * whatever a party has done to it since (D-053).
   */
  async markFundsHeld(
    orderId: string,
    transactionId: string,
    saga: SagaStep,
  ): Promise<OrderStatus> {
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

    return this.systemTransition(orderId, 'FUNDS_HELD', saga, {
      activity: 'markFundsHeld',
      from: ['PENDING'],
      apply: (tx, order) => recordHold(tx, order, 'FUNDS_HELD'),
      yieldTo: ['CANCELLING'],
      onYield: (tx, order) => recordHold(tx, order, 'CANCELLING'),
      appliedTo: (order) => order.economicTransactionId === transactionId,
    });
  }

  /**
   * The obligation could not be created — usually an empty wallet.
   *
   * Returns `CANCELLING` without changing anything when the buyer cancelled
   * first: that order did not fail, it was cancelled, and the saga closes it
   * as cancelled. Nothing was held, so there is nothing to refund.
   */
  async markFailed(orderId: string, reason: string, saga: SagaStep): Promise<OrderStatus> {
    return this.systemTransition(orderId, 'FAILED', saga, {
      activity: 'markFailed',
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
   *
   * Returns `CANCELLING` the same way when that dispute has since been
   * resolved as a refund: the saga reads the order and compensates. Reached
   * when the step runs late — a retry whose first attempt yielded on a worker
   * older than its record, or a worker down while the dispute was decided —
   * and refusing it ended the saga with the funds held (D-053).
   */
  async markSettling(orderId: string, saga: SagaStep): Promise<OrderStatus> {
    return this.systemTransition(orderId, 'SETTLING', saga, {
      activity: 'markSettling',
      from: ['RECEIPT_CONFIRMED'],
      yieldTo: ['DISPUTED', 'CANCELLING'],
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
  async markSettlementFailed(orderId: string, saga: SagaStep): Promise<OrderStatus> {
    return this.systemTransition(orderId, 'RECEIPT_CONFIRMED', saga, {
      activity: 'markSettlementFailed',
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

  /**
   * economic-service has the obligation DISPUTED, and the saga authorised it
   * first: the order is disputed too, with the objection economic-service
   * holds (D-053; Codex on #287 round 4, finding 2).
   *
   * Someone with authority over the transaction disputed it there rather than
   * here, after the saga's authorisation committed. Settlement is refused for
   * as long as the dispute stands, so trying it only spends the saga's
   * attempts and ends it with the funds held. As the order's own dispute,
   * it takes the path every dispute takes: the saga mirrors it (economic
   * already holds it, with these words), waits, and mirrors an operator's
   * decision back — `SETTLE` settles, `REFUND` refunds.
   *
   * **From `RECEIPT_CONFIRMED` only**, the state the saga authorises and
   * returns a failed settlement attempt to. An order a party disputed here
   * meanwhile is already `DISPUTED`, and keeps that dispute; one whose dispute
   * an operator has since resolved as a refund is `CANCELLING`, and the step
   * yields to it — the saga refunds.
   *
   * **Returns the dispute it filed**, recorded with the step (Codex on #318
   * round 1, finding 1). economic-service already holds it, so the saga counts
   * it as mirrored from the moment it exists, not from the moment it next
   * reads the order DISPUTED. An operator can decide it before that read; the
   * saga then still mirrors that decision back, rather than finding economic
   * DISPUTED again and filing a second dispute over the same objection. Null
   * when the step filed nothing: it yielded, or a party's dispute was there.
   *
   * **Recorded with economic-service's identity of the dispute it takes**
   * (`economicDisputeId`, read with `reason`), and answered with it: the pair
   * is what the saga resolves by — this order's dispute, decided here, is that
   * one there and no other raised since (Codex on #318 round 2, N1). Null when
   * the step filed nothing, or economic-service gave no identity.
   */
  async markObligationDisputed(
    orderId: string,
    reason: string,
    saga: SagaStep,
    economicDisputeId: string | null = null,
  ): Promise<{ status: OrderStatus; disputeId: string | null; economicDisputeId: string | null }> {
    const disputeId = newId(ID_PREFIX.dispute);
    const { status, detail } = await this.systemStep(orderId, 'DISPUTED', saga, {
      activity: 'markObligationDisputed',
      from: ['RECEIPT_CONFIRMED'],
      yieldTo: ['CANCELLING'],
      reason: 'The obligation was disputed in economic-service',
      movedWith: economicDisputeId === null ? { disputeId } : { disputeId, economicDisputeId },
      apply: async (tx, order) => {
        await runUnscoped('the saga files the dispute economic-service holds on the order', () =>
          tx.orderDispute.create({
            data: {
              id: disputeId,
              organizationId: order.organizationId,
              orderId: order.id,
              reason,
              status: 'OPEN',
              // Raised there, by whoever economic-service recorded.
              raisedBy: ECONOMIC_SERVICE,
            },
          }),
        );
        await runUnscoped(
          'the saga records the dispute on an order on behalf of neither party',
          () => tx.order.update({ where: { id: order.id }, data: { status: 'DISPUTED' } }),
        );
        await this.events.enqueue(tx, {
          eventName: MARKETPLACE_EVENTS.ORDER_DISPUTED,
          aggregateId: order.id,
          organizationId: order.organizationId,
          payload: {
            orderId: order.id,
            disputeId,
            buyerOrganizationId: order.organizationId,
            supplierOrganizationId: order.supplierOrganizationId,
            reason,
            raisedBy: ECONOMIC_SERVICE,
            raisedAt: new Date().toISOString(),
          },
        });
      },
    });
    return {
      status,
      disputeId: detail.disputeId ?? null,
      economicDisputeId: detail.economicDisputeId ?? null,
    };
  }

  /** Settlement succeeded. The only path to `COMPLETED`. */
  async markCompleted(
    orderId: string,
    settlement: {
      settlementId: string;
      commissionAmountMinor: string;
      netAmountMinor: string;
    },
    saga: SagaStep,
  ): Promise<OrderStatus> {
    return this.systemTransition(orderId, 'COMPLETED', saga, {
      activity: 'markCompleted',
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
  async markCancelled(orderId: string, reason: string, saga: SagaStep): Promise<OrderStatus> {
    return this.systemTransition(orderId, 'CANCELLED', saga, {
      activity: 'markCancelled',
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
   *
   * Counted once per reminder, not once per attempt: a Temporal retry of a
   * reminder that committed finds its step record and changes nothing
   * (D-053). The next reminder is a different scheduled activity, so a
   * different step. A reminder counted before its record could exist is
   * recognised by its history row, written since the activity was scheduled:
   * the previous reminder is at least a day older.
   */
  async recordReminder(orderId: string, saga: SagaStep): Promise<void> {
    const counted = await this.prisma.transaction(async (tx) => {
      const order = await this.repository.lockOrder(tx, orderId);
      if (await this.repository.findSagaStep(tx, order, saga, 'recordReminder')) return false;

      const countedBefore = await this.repository.hasSagaHistorySince(tx, order, {
        kind: 'REMINDER',
        since: sagaWindowStart(saga),
      });
      if (countedBefore) {
        await this.repository.recordSagaStep(tx, order, saga, 'recordReminder', undefined);
        return false;
      }

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
      await this.repository.recordSagaStep(tx, order, saga, 'recordReminder', undefined);
      return true;
    });
    if (!counted) return;

    const order = await this.repository.findForParty(orderId);
    remindersRecordedTotal.inc({
      service: SERVICE_NAME,
      status: order?.status ?? 'UNKNOWN',
    });
  }

  /**
   * Runs a saga step whose effect is in economic-service, once per scheduled
   * activity (D-053).
   *
   * economic-service keys each call on the order and replays its stored
   * answer to a repeat — for as long as it keeps that answer
   * (`ECONOMIC_IDEMPOTENCY_TTL_HOURS`). A retry that comes later, because the
   * worker was down for that long, would be judged against the transaction's
   * current state and refused. So the answer is also kept here, and a retry
   * that finds it does not call at all.
   *
   * Kept after the call, not with it: there is no transaction spanning two
   * services. A failure to keep it is logged and the answer still returned —
   * failing the step would report money that moved as money that did not —
   * and the retry, if one comes, is answered by economic-service's replay.
   */
  async onceForSaga<T>(
    order: { id: string; organizationId: string },
    saga: SagaStep,
    activity: SagaActivity,
    call: () => Promise<T>,
  ): Promise<T> {
    const recorded = await this.repository.findSagaStep(this.prisma.client, order, saga, activity);
    // Written below by this same activity from a value of type T, under a key
    // no other activity can hold (findSagaStep refuses a mismatch).
    if (recorded) return (recorded.result ?? undefined) as T;

    const result = await call();
    try {
      await this.repository.recordSagaStep(
        this.prisma.client,
        order,
        saga,
        activity,
        // The economic steps return plain records of strings, or nothing: JSON
        // is their own shape.
        result as Prisma.InputJsonValue | undefined,
      );
    } catch (error) {
      this.logger.warn(
        `Saga step ${activity} of order ${order.id} took effect but was not recorded ` +
          `(${error instanceof Error ? error.name : 'unknown error'}); a retry relies on economic-service's replay`,
      );
    }
    return result;
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
   *
   * `mirroredDisputeId` is the dispute economic-service holds for the order
   * as far as the saga knows; its resolution is what the saga mirrors back.
   * It need not be the most recent one: an operator can decide it and a party
   * raise the next before the saga reads the order again.
   */
  async sagaView(
    orderId: string,
    mirroredDisputeId?: string,
  ): Promise<{
    status: OrderStatus;
    economicTransactionId: string | null;
    cancellationReason: string | null;
    /** The most recent dispute's reason and, once decided, its resolution. */
    dispute: { id: string; reason: string; resolution: string | null } | null;
    /** `mirroredDisputeId`'s dispute on this order, when one was named. */
    mirroredDispute?: { id: string; resolution: string | null } | null;
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
    const mirroredDispute =
      mirroredDisputeId === undefined
        ? undefined
        : await runUnscoped('the saga reads the dispute it mirrored, on the order it drives', () =>
            this.prisma.client.orderDispute.findFirst({
              where: { id: mirroredDisputeId, orderId: row.id },
              select: { id: true, resolution: true },
            }),
          );

    return {
      status: row.status,
      economicTransactionId: row.economicTransactionId,
      cancellationReason: row.cancellationReason,
      dispute,
      ...(mirroredDispute === undefined ? {} : { mirroredDispute }),
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
      /** Stores the idempotent response, as the transaction's last statement. */
      record: RecordResponse<OrderView> | undefined;
      /** Awaited under the row lock, before the transition is checked or applied. */
      authorise: (order: LockedOrderRow) => unknown;
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
      await handlers.authorise(order);

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

      const loaded = await this.load(tx, order.id);
      await handlers.record?.(tx, loaded);
      return loaded;
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
   * ## A retry answers what the first attempt answered (D-053)
   *
   * Temporal re-runs an activity whose completion it did not record — a worker
   * that crashed or shut down after the commit, a lost response — and by then
   * a party may have moved the order on. Recognising the retry by "the order
   * is already where this step sends it" stopped working at that moment: a
   * hold recorded, then confirmed by the supplier, then retried, was refused
   * `CONFIRMED -> FUNDS_HELD` as a business rule, and the saga failed with the
   * buyer's money held and nothing left to release it.
   *
   * So every outcome — moved, yielded or already there — is recorded under
   * the step's own key in the same transaction, and a retry that finds the
   * record returns it and does nothing else. The record is read under the
   * order's lock, so two attempts of one step cannot both act.
   *
   * ## A step older than its record (D-053, Codex on #283)
   *
   * A first attempt that ran on a worker older than `saga_step` left no
   * record, only its effect — and that effect includes the history row it
   * wrote in the same transaction. So a retry with no record that the order's
   * state would refuse looks for that row: this step's edge (`from` → `to`,
   * with its reason), written since Temporal first scheduled this activity.
   * Every edge a saga step takes is taken by that step alone, the workflow
   * runs one step at a time, and it waits on this one; so such a row is this
   * step's own. The same edge written by an earlier step is older than this
   * activity's scheduling by at least the settlement backoff (30 s), or is
   * an edge an order takes once; the allowance for clocks
   * (`SAGA_CLOCK_SKEW_MS`) is well inside that.
   *
   * Returns the order's status after the call — for a retry, after the first.
   */
  private async systemTransition(
    orderId: string,
    to: OrderStatus,
    saga: SagaStep,
    step: SystemStepOptions,
  ): Promise<OrderStatus> {
    return (await this.systemStep(orderId, to, saga, step)).status;
  }

  /**
   * `systemTransition`, with what the step recorded beside the status: its
   * `movedWith` when it moved the order — for a retry, when the first attempt
   * did — and nothing otherwise.
   */
  private async systemStep(
    orderId: string,
    to: OrderStatus,
    saga: SagaStep,
    step: SystemStepOptions,
  ): Promise<{ status: OrderStatus; detail: Record<string, string> }> {
    const outcome = await this.prisma.transaction(async (tx) => {
      const order = await this.repository.lockOrder(tx, orderId);

      const recorded = await this.repository.findSagaStep(tx, order, saga, step.activity);
      if (recorded) {
        return {
          status: recordedStatus(order.id, recorded.result),
          detail: recordedDetail(recorded.result),
          moved: false,
        };
      }

      const result = await this.applySystemStep(tx, order, to, saga, step);
      const detail = result.moved ? (step.movedWith ?? {}) : {};
      await this.repository.recordSagaStep(tx, order, saga, step.activity, {
        ...detail,
        status: result.status,
      });
      return { ...result, detail };
    });

    if (outcome.moved) orderTransitionsTotal.inc({ service: SERVICE_NAME, to });
    return { status: outcome.status, detail: outcome.detail };
  }

  /** The decision `systemTransition` records, taken under the order's lock. */
  private async applySystemStep(
    tx: ExtendedPrismaClient,
    order: LockedOrderRow,
    to: OrderStatus,
    saga: SagaStep,
    step: SystemStepOptions,
  ): Promise<{ status: OrderStatus; moved: boolean }> {
    if (order.status === to) {
      // Already there: a retry whose first attempt predates its record. Not an
      // error, and nothing to do.
      return { status: to, moved: false };
    }

    if (step.yieldTo?.includes(order.status)) {
      await step.onYield?.(tx, order);
      return { status: order.status, moved: false };
    }

    if (step.appliedTo?.(order)) return { status: order.status, moved: false };

    // Only for an order the step would refuse: from a state it acts on, it
    // acts. Never for a finished one: only a later saga step finishes an
    // order, and none runs while the saga waits on this one — so a replayed
    // command on a finished order is still refused as finished.
    const applied =
      !step.from.includes(order.status) &&
      !isTerminal(order.status) &&
      (await this.repository.hasSagaHistorySince(tx, order, {
        kind: 'TRANSITION',
        from: step.from,
        to,
        reason: step.reason ?? null,
        since: sagaWindowStart(saga),
      }));
    if (applied) {
      this.logger.log(
        `Saga step ${step.activity} of order ${order.id} was applied before its record existed; ` +
          `answering ${to} from the order's history`,
      );
      return { status: to, moved: false };
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

/**
 * How far the clock that stamps order history may disagree with Temporal's,
 * which stamps an activity's scheduling (D-053).
 *
 * A history row a step wrote is newer than the step's scheduling; with clocks
 * that disagree it can read as slightly older, so the window opens this much
 * early. It must stay well below the shortest gap between two writes of the
 * same edge on one order — the settlement backoff, 30 s; reminders are days
 * apart.
 */
export const SAGA_CLOCK_SKEW_MS = 5_000;

/** Where a step's own history rows begin: its scheduling, less the clock allowance. */
function sagaWindowStart(saga: SagaStep): Date {
  return new Date(saga.scheduledAt.getTime() - SAGA_CLOCK_SKEW_MS);
}

/**
 * The status a recorded transition step returned. Written only by
 * `systemTransition`; anything else under its key is a broken invariant.
 */
function recordedStatus(orderId: string, result: Prisma.JsonValue): OrderStatus {
  const status =
    result !== null && typeof result === 'object' && !Array.isArray(result)
      ? result.status
      : undefined;
  if (typeof status === 'string' && Object.hasOwn(ORDER_TRANSITIONS, status)) {
    return status as OrderStatus;
  }
  throw new Error(`A saga step record of order ${orderId} holds no order status`);
}

/** What a recorded transition step kept beside its status: its `movedWith`. */
function recordedDetail(result: Prisma.JsonValue): Record<string, string> {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return {};
  return Object.fromEntries(
    Object.entries(result).filter(
      (entry): entry is [string, string] => entry[0] !== 'status' && typeof entry[1] === 'string',
    ),
  );
}

/** How one saga step moves the order (`systemTransition`). */
interface SystemStepOptions {
  activity: SagaActivity;
  from: readonly OrderStatus[];
  apply: (tx: ExtendedPrismaClient, order: LockedOrderRow) => Promise<unknown>;
  yieldTo?: readonly OrderStatus[];
  /** Runs inside the lock when the step yields. */
  onYield?: (tx: ExtendedPrismaClient, order: LockedOrderRow) => Promise<unknown>;
  /**
   * Recognises this step's own effect on an order that has moved on, for
   * a retry with no record: one whose first attempt ran before the record
   * existed. Only a step whose effect leaves a mark on the order nothing
   * else writes can say; every step also has its history row
   * (`hasSagaHistorySince`).
   */
  appliedTo?: (order: LockedOrderRow) => boolean;
  reason?: string;
  /**
   * Recorded with the status when the step moves the order, and answered to
   * a retry: what `apply` created that the saga goes on to name.
   */
  movedWith?: Record<string, string>;
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
    id: string;
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
      id: line.id,
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
