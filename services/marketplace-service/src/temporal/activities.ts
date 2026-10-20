import { Logger } from '@nestjs/common';
import { ApplicationFailure, Context } from '@temporalio/activity';
import {
  createSystemContext,
  isRastaError,
  runWithContext,
  type RequestContext,
} from '@rasta/nest-common';
import { ulid } from 'ulid';
import type { OrderService } from '../order/order.service';
import type { SagaActivity, SagaStep } from '../order/order.repository';
import type { OrderStatus } from '../generated/prisma';
import {
  fundsOf,
  idempotencyKeyFor,
  ObligationLookupIncomplete,
  termsDiffer,
  type EconomicClient,
  type ObligationFunds,
  type ObligationTerms,
  type TransactionDetailView,
} from '../economic/economic.client';
import { SERVICE_NAME } from '../config/env';
import { settlementsExhaustedTotal } from '../observability/metrics';

/**
 * Everything the order saga does that touches the world.
 *
 * All I/O lives here rather than in the workflow, because Temporal re-executes
 * workflow code on replay and a database read there would produce a different
 * answer the second time. An activity runs once per attempt and its result is
 * recorded.
 *
 * ## Context
 *
 * An activity has no HTTP request behind it, so it establishes its own
 * `RequestContext` — a SYSTEM actor with the order's own correlation id, so a
 * saga step is traceable back to the request that started it. The organization
 * on that context is the **buyer's**, taken from the order row, which is what
 * makes the internal token this service mints name the right tenant (ADR-035).
 *
 * ## Idempotency: a retry answers what the first attempt answered (D-053)
 *
 * Temporal re-runs an activity whose completion it did not record: the worker
 * crashed or shut down after the work committed, or the answer was lost on
 * the way. Every activity with an effect is safe to re-run, and not by
 * looking at where the order is now — a party may have moved it since:
 *
 * - a local transition (`mark*`) and `recordReminder` record their outcome
 *   under the step's key in their own transaction; a retry that finds the
 *   record returns it and changes nothing;
 * - an economic-service call carries a key derived from the order
 *   (ADR-039 § 6), so economic-service replays its stored answer; the answer
 *   is also recorded here, so a retry that comes after economic-service has
 *   let its copy expire does not call at all; and one whose first attempt
 *   never recorded it, refused for the state that attempt produced, is
 *   answered from the order's obligation as economic-service has it;
 * - a local step whose first attempt ran on a worker older than its record is
 *   recognised by the history row it wrote.
 *
 * The step's key is Temporal's own identity for one scheduled activity —
 * workflow, run and activity id — which every retry of it shares and no other
 * call does (`docs/08` § 8.8, Idempotency). Reads (`readOrder`,
 * `findObligation`) have no effect and record nothing.
 */

export interface ActivityDependencies {
  orders: OrderService;
  economic: EconomicClient;
  /**
   * Which scheduled activity is running. Temporal's own identity unless a
   * suite that runs the activities outside a worker supplies one.
   */
  currentStep?: () => SagaStep;
}

/** The running activity's identity: the same on every retry of it, unique otherwise. */
export function temporalStep(): SagaStep {
  const { workflowExecution, activityId, scheduledTimestampMs } = Context.current().info;
  // Only a standalone activity has no workflow, and the saga schedules none.
  if (!workflowExecution) throw new Error('A saga activity ran outside a workflow');
  return {
    key: `${workflowExecution.workflowId}/${workflowExecution.runId}/${activityId}`,
    // The first attempt's scheduling, which a retry keeps.
    scheduledAt: new Date(scheduledTimestampMs),
  };
}

export interface HeldResult {
  transactionId: string;
}

/**
 * economic-service holds a transaction naming this order as its source that
 * is not the obligation the saga records: some term differs (`differ`). Not
 * adopted; the saga stops (`OBLIGATION_TERMS_MISMATCH`).
 */
export interface ObligationMismatch {
  mismatch: true;
  transactionIds: string[];
  /** Which terms differ, by name — never their values. */
  differ: string[];
}

/**
 * economic-service holds the order's obligation, on exactly its terms, in a
 * status that does not prove its funds are held now (`fundsOf`). Not adopted:
 * recording it as held would publish `ORDER_FUNDS_HELD` for money that is
 * back with the buyer, paid out or never was in escrow. The saga stops
 * (`OBLIGATION_NOT_HELD`), naming the status and what it says of the funds.
 */
export interface ObligationNotHeld {
  notHeld: true;
  transactionId: string;
  status: string;
  funds: Exclude<ObligationFunds, 'HELD'>;
}

/** What `readOrder` returns: the fields the saga's decisions depend on. */
export type SagaOrderView = Awaited<ReturnType<OrderService['sagaView']>>;

export interface SettledResult {
  settlementId: string;
  commissionAmountMinor: string;
  netAmountMinor: string;
}

/**
 * The saga authorised the obligation and economic-service has it DISPUTED
 * since — by someone who disputed it there, not through this service. It
 * cannot settle until that dispute is decided, so the saga takes it to the
 * order's dispute (`markObligationDisputed`) instead of failing settlement
 * attempts against it (D-053).
 */
export interface DisputedObligation {
  disputed: true;
  /** The objection as economic-service has it: what the order's dispute says. */
  reason: string;
  /**
   * economic-service's identity of that dispute, read with its words. The
   * order's dispute is taken with it, and the operator's decision is mirrored
   * naming it: a dispute raised there since is not the one decided (Codex on
   * #318 round 2, N1). Null from an economic-service older than the identity;
   * absent from an answer recorded before it existed.
   */
  economicDisputeId?: string | null;
}

/** What `authoriseSettlement` answers. Undefined: authorised. */
export type AuthorisationResult = DisputedObligation | undefined;

/**
 * What `markObligationDisputed` answers: the order's status, and the dispute
 * it filed for the one economic-service holds — null when it filed none.
 */
export type ObligationDisputeTaken = Awaited<ReturnType<OrderService['markObligationDisputed']>>;

/** The terms the order's obligation is recorded on, from the order row alone. */
function obligationTermsOf(order: Awaited<ReturnType<OrderService['describe']>>): ObligationTerms {
  return {
    orderId: order.id,
    buyerOrganizationId: order.buyerOrganizationId,
    supplierOrganizationId: order.supplierOrganizationId,
    totalAmountMinor: BigInt(order.totalAmountMinor),
    currency: order.currency,
  };
}

export function createActivities(deps: ActivityDependencies) {
  const logger = new Logger('OrderSagaActivities');

  /**
   * Runs `fn` as the system, acting for the order's buying organization.
   *
   * The organization is read from the order rather than passed in, so a
   * workflow cannot name a tenant of its own choosing.
   *
   * A platform error leaves here classified (`asTemporalFailure`), whichever
   * step raised it. The workflow retries its reads and local writes until
   * they answer, so a state-machine refusal that arrived unclassified would be
   * retried forever instead of stopping the saga.
   */
  async function asSystemFor<T>(
    orderId: string,
    fn: (order: Awaited<ReturnType<OrderService['describe']>>) => Promise<T>,
  ): Promise<T> {
    try {
      // Read once without a tenant, purely to learn which tenant to adopt. The
      // describe() call is scoped by the repository's own written reason.
      const bootstrap = systemContext(undefined, ulid());
      const order = await runWithContext(bootstrap, () => deps.orders.describe(orderId));

      const context = systemContext(order.buyerOrganizationId, order.correlationId);
      return await runWithContext(context, () => fn(order));
    } catch (error) {
      throw asTemporalFailure(error);
    }
  }

  const currentStep = deps.currentStep ?? temporalStep;

  /**
   * An economic-service call, made at most once per scheduled activity
   * (D-053). A refusal or an outage records nothing, so the retry calls again.
   *
   * With `applied`, a refusal for the transaction's **state** is not taken at
   * its word. It is what a retry gets once economic-service has let the
   * command's stored answer expire (`ECONOMIC_IDEMPOTENCY_TTL_HOURS`, 24 h)
   * — or lost it after committing — and the first attempt's effect is exactly
   * the state that refuses it. So the order's own obligation is read, as its
   * payer; if it shows this command's effect, that is the answer, recorded
   * like any other. For authorisation and settlement, so is a dispute on a
   * transaction economic-service records this order's saga as having
   * authorised (`disputedSinceAuthorised`): the saga takes it to the order's
   * dispute. Anything else — another refusal, a transaction that is not this
   * order's, a state the command does not produce — stays the refusal it was.
   */
  async function economicStep<T>(
    orderId: string,
    activity: SagaActivity,
    call: (order: Awaited<ReturnType<OrderService['describe']>>) => Promise<T>,
    applied?: {
      transactionId: string;
      /** This command's effect on the obligation, as its answer; null when not there. */
      answer: (transaction: TransactionDetailView) => { result: T } | null;
    },
  ): Promise<T> {
    const step = currentStep();
    return asSystemFor(orderId, (order) =>
      deps.orders.onceForSaga(
        { id: order.id, organizationId: order.buyerOrganizationId },
        step,
        activity,
        async () => {
          try {
            return await call(order);
          } catch (refusal) {
            if (!applied || !refusedForState(refusal)) throw refusal;
            const transaction = await deps.economic.readObligation({
              orderId: order.id,
              transactionId: applied.transactionId,
              buyerOrganizationId: order.buyerOrganizationId,
              correlationId: order.correlationId,
            });
            const answer = transaction ? applied.answer(transaction) : null;
            if (!answer) throw refusal;
            logger.warn(
              `Saga step ${activity} of order ${order.id} was refused for the transaction's state, ` +
                `which already shows its effect (${transaction?.status}); answering from economic-service's record`,
            );
            return answer.result;
          }
        },
      ),
    );
  }

  return {
    /**
     * Creates the obligation and holds the funds, in one call (ADR-040) —
     * and answers only while economic-service holds them now.
     *
     * Every way this answers can be history: the transaction id already on
     * the order, the step's own record of a first attempt (D-053), and
     * economic-service's stored answer to an idempotent retry, which it
     * replays without reading the row again. The hold committed, its answer
     * was lost, the supplier refunded it, and the retry got the stored
     * answer: adopting that id recorded FUNDS_HELD and published
     * ORDER_FUNDS_HELD for money back with the buyer (review of #334
     * round 3, F2). So whatever the step answers is checked against the
     * obligation as economic-service has it now, outside the step's record,
     * on every attempt. Not HELD: a non-retryable `OBLIGATION_NOT_HELD`, and
     * the workflow's recovery (`findObligation`) names the status and stops.
     */
    async createObligation(orderId: string): Promise<HeldResult> {
      const held = await economicStep(orderId, 'createObligation', async (order) => {
        if (order.economicTransactionId) {
          // A retry after the call succeeded but the recording did not. The
          // obligation exists; do not create a second one.
          return { transactionId: order.economicTransactionId };
        }

        const transaction = await deps.economic.createObligation({
          ...obligationTermsOf(order),
          correlationId: order.correlationId,
        });
        return { transactionId: transaction.id };
      });
      await asSystemFor(orderId, async (order) => {
        const now = await deps.economic.readObligation({
          orderId: order.id,
          transactionId: held.transactionId,
          buyerOrganizationId: order.buyerOrganizationId,
          correlationId: order.correlationId,
        });
        const funds = now ? fundsOf(now.status) : 'UNPROVEN';
        if (funds === 'HELD') return;
        logger.error(
          `Order ${order.id}: its obligation ${held.transactionId} is ${now?.status ?? 'not found as its own'} ` +
            `at economic-service (funds ${funds}); the hold is not adopted`,
        );
        throw ApplicationFailure.nonRetryable(
          `economic-service does not hold order ${order.id}'s obligation now (funds ${funds})`,
          'OBLIGATION_NOT_HELD',
        );
      });
      return held;
    },

    /**
     * Whether economic-service holds this order's obligation.
     *
     * Asked whenever `createObligation` ends without a definite answer,
     * because only a refusal proves nothing moved (see
     * `EconomicClient.findObligations`).
     *
     * Adopted only on exactly the terms `createObligation` sends — payer,
     * payee, amount, currency, type, source — never on the key alone. While
     * the order was PENDING, the buyer's administrator could record
     * `ORDER/<order id>` first, 1 rial to an accomplice; the saga's own
     * creation got 409, this read found that row, and the saga settled it
     * (review of #334 round 1, F1). A row that names this order on any other
     * terms is answered as `ObligationMismatch`: the saga stops there, adopts
     * nothing, authorises and settles nothing, and leaves what is held for a
     * person to decide. economic-service now refuses such a row to anyone but
     * this service; this check does not rely on it.
     *
     * And adopted only while it is HELD. Equal terms say whose obligation it
     * is, not where the money is: the hold committed, its answer was lost,
     * and the supplier's administrator refunded it before this read — every
     * term still equal, the status REFUNDED. Adopting it recorded FUNDS_HELD
     * and published ORDER_FUNDS_HELD for money back with the buyer (review of
     * #334 round 2, F1). Any other status is answered as `ObligationNotHeld`,
     * and the saga stops on it.
     */
    async findObligation(
      orderId: string,
    ): Promise<HeldResult | ObligationMismatch | ObligationNotHeld | null> {
      return asSystemFor(orderId, async (order) => {
        try {
          const found = await deps.economic.findObligations({
            orderId: order.id,
            buyerOrganizationId: order.buyerOrganizationId,
            correlationId: order.correlationId,
          });
          if (found.length === 0) return null;
          const terms = obligationTermsOf(order);
          const own = found.find((transaction) => termsDiffer(terms, transaction).length === 0);
          if (own) {
            const funds = fundsOf(own.status);
            if (funds === 'HELD') return { transactionId: own.id };
            logger.error(
              `Order ${order.id}: economic-service holds its obligation ${own.id} as ${own.status} ` +
                `(funds ${funds}), which does not prove the funds are held; it is not adopted`,
            );
            return { notHeld: true, transactionId: own.id, status: own.status, funds };
          }
          const differ = [
            ...new Set(found.flatMap((transaction) => termsDiffer(terms, transaction))),
          ];
          logger.error(
            `Order ${order.id}: economic-service holds ${found.length} obligation(s) naming it on ` +
              `terms the order did not set (${differ.join(', ')}); none is adopted`,
          );
          return {
            mismatch: true,
            transactionIds: found.map((transaction) => transaction.id),
            differ,
          };
        } catch (error) {
          // Not retried: the same answer would end the same way.
          if (error instanceof ObligationLookupIncomplete) {
            throw ApplicationFailure.nonRetryable(error.message, 'OBLIGATION_LOOKUP_INCOMPLETE');
          }
          throw asTemporalFailure(error);
        }
      });
    },

    /**
     * The order as the database has it now. What the saga decides on
     * (ADR-039). With `mirroredDisputeId`, also that dispute's resolution.
     */
    async readOrder(orderId: string, mirroredDisputeId?: string): Promise<SagaOrderView> {
      return asSystemFor(orderId, () => deps.orders.sagaView(orderId, mirroredDisputeId));
    },

    async markFundsHeld(orderId: string, transactionId: string): Promise<OrderStatus> {
      const step = currentStep();
      return asSystemFor(orderId, () => deps.orders.markFundsHeld(orderId, transactionId, step));
    },

    async markFailed(orderId: string, reason: string): Promise<OrderStatus> {
      const step = currentStep();
      return asSystemFor(orderId, () => deps.orders.markFailed(orderId, reason, step));
    },

    /**
     * Authorises settlement. Undefined once authorised; a
     * {@link DisputedObligation} when a retry finds its own authorisation
     * disputed since in economic-service.
     */
    async authoriseSettlement(
      orderId: string,
      transactionId: string,
    ): Promise<AuthorisationResult> {
      return economicStep<AuthorisationResult>(
        orderId,
        'authoriseSettlement',
        async (order) => {
          await deps.economic.authoriseSettlement({
            orderId: order.id,
            transactionId,
            buyerOrganizationId: order.buyerOrganizationId,
            correlationId: order.correlationId,
          });
          return undefined;
        },
        {
          transactionId,
          // Authorised, or authorised and since settled. REFUNDED never: it is
          // reachable from HELD without an authorisation. DISPUTED is too, so
          // the state alone proves nothing there — only economic-service's
          // record that this order's own command authorised it (Codex on #287
          // round 4, finding 2). With it, the dispute is the answer.
          answer: (transaction) => {
            if (transaction.status === 'PENDING_SETTLEMENT' || transaction.status === 'SETTLED') {
              return { result: undefined };
            }
            const disputed = disputedSinceAuthorised(transaction, orderId);
            return disputed ? { result: disputed } : null;
          },
        },
      );
    },

    async markSettling(orderId: string): Promise<OrderStatus> {
      const step = currentStep();
      return asSystemFor(orderId, () => deps.orders.markSettling(orderId, step));
    },

    /**
     * Moves the money. A {@link DisputedObligation} instead when the
     * authorised transaction was disputed in economic-service before it could
     * settle: refused for its state, and every further attempt would be too.
     */
    async settle(
      orderId: string,
      transactionId: string,
    ): Promise<SettledResult | DisputedObligation> {
      return economicStep<SettledResult | DisputedObligation>(
        orderId,
        'settle',
        async (order) => {
          const settlement = await deps.economic.settle({
            orderId: order.id,
            transactionId,
            buyerOrganizationId: order.buyerOrganizationId,
            correlationId: order.correlationId,
          });
          return {
            settlementId: settlement.settlementId,
            commissionAmountMinor: settlement.commissionAmountMinor,
            netAmountMinor: settlement.netAmountMinor,
          };
        },
        {
          transactionId,
          // A transaction settles once (`settlement.transaction_id` is unique),
          // and the settlement writes its commission and net onto it: the same
          // three values its answer carried.
          answer: (transaction) => {
            if (transaction.status === 'SETTLED' && transaction.settlement) {
              return {
                result: {
                  settlementId: transaction.settlement.id,
                  commissionAmountMinor: transaction.commissionAmountMinor,
                  netAmountMinor: transaction.netAmountMinor,
                },
              };
            }
            // Not this command's effect, but the reason no attempt of it can
            // succeed. The same proof as for authorisation: this order's own.
            const disputed = disputedSinceAuthorised(transaction, orderId);
            return disputed ? { result: disputed } : null;
          },
        },
      );
    },

    /**
     * Takes an order whose obligation economic-service has DISPUTED to the
     * order's own dispute, where the saga mirrors it and waits for an
     * operator (D-053). See `OrderService.markObligationDisputed`.
     */
    async markObligationDisputed(
      orderId: string,
      reason: string,
      economicDisputeId?: string | null,
    ): Promise<ObligationDisputeTaken> {
      const step = currentStep();
      return asSystemFor(orderId, () =>
        deps.orders.markObligationDisputed(orderId, reason, step, economicDisputeId ?? null),
      );
    },

    async markSettlementFailed(orderId: string): Promise<OrderStatus> {
      settlementsExhaustedTotal.inc({ service: SERVICE_NAME }, 0);
      const step = currentStep();
      return asSystemFor(orderId, () => deps.orders.markSettlementFailed(orderId, step));
    },

    async markCompleted(orderId: string, settlement: SettledResult): Promise<OrderStatus> {
      const step = currentStep();
      return asSystemFor(orderId, () => deps.orders.markCompleted(orderId, settlement, step));
    },

    /**
     * Returns the held funds.
     *
     * The only compensation this saga performs, and only before settlement.
     * After receipt confirmation `docs/08` § 8.4 forbids automatic financial
     * compensation entirely.
     */
    async compensate(orderId: string, transactionId: string, reason: string): Promise<void> {
      await economicStep(
        orderId,
        'compensate',
        async (order) => {
          await deps.economic.refund({
            orderId: order.id,
            transactionId,
            buyerOrganizationId: order.buyerOrganizationId,
            reason,
            correlationId: order.correlationId,
          });
        },
        {
          transactionId,
          // Terminal, and only a refund reaches it: the held money is back
          // with the buyer, which is all compensation is for.
          answer: (transaction) =>
            transaction.status === 'REFUNDED' ? { result: undefined } : null,
        },
      );
    },

    /**
     * Tells economic-service the order is disputed (ADR-040 § 5).
     *
     * Both sides have to know. If only marketplace did, a direct settlement
     * command to economic-service would still succeed; if only economic did,
     * the order could not say why it was stuck. The transaction moves to
     * DISPUTED there, and economic-service refuses to settle it independently
     * of anything this service does.
     *
     * Answers economic-service's identity of the dispute it filed — what the
     * saga names when it mirrors the decision (Codex on #318 round 2, N1) —
     * or null from an economic-service older than the identity.
     */
    async disputeObligation(
      orderId: string,
      transactionId: string,
      disputeId: string,
      reason: string,
    ): Promise<string | null> {
      return economicStep(
        orderId,
        'disputeObligation',
        async (order) => {
          const disputed = await deps.economic.dispute({
            orderId: order.id,
            disputeId,
            transactionId,
            buyerOrganizationId: order.buyerOrganizationId,
            reason,
            correlationId: order.correlationId,
          });
          return disputed.disputeId ?? null;
        },
        {
          transactionId,
          // Disputed with this dispute's own words. Nothing but the next
          // resolution — which the saga sends only after this step — changes
          // them.
          answer: (transaction) =>
            transaction.status === 'DISPUTED' && transaction.disputeReason === reason
              ? { result: transaction.disputeId ?? null }
              : null,
        },
      );
    },

    /**
     * Reopens the transaction so a dispute decided for the supplier can settle.
     *
     * With `economicDisputeId`, only that dispute: economic-service refuses the
     * resolution, under its row lock, once the transaction holds another — one
     * raised since the dispute decided here was taken, after that one was
     * resolved there (Codex on #318 round 2, N1). The refusal stands, and the
     * saga stops with the funds held for an operator, as it did before the
     * order took economic-service's disputes at all.
     */
    async resolveObligationDispute(
      orderId: string,
      transactionId: string,
      disputeId: string,
      resolution: string,
      economicDisputeId?: string,
    ): Promise<void> {
      await economicStep(
        orderId,
        'resolveObligationDispute',
        async (order) => {
          await deps.economic.resolveDispute({
            orderId: order.id,
            disputeId,
            ...(economicDisputeId === undefined ? {} : { economicDisputeId }),
            transactionId,
            buyerOrganizationId: order.buyerOrganizationId,
            resolution,
            correlationId: order.correlationId,
          });
        },
        {
          transactionId,
          // Out of the dispute and back in the settlement queue (or since
          // settled). With the dispute's identity, out of THAT dispute — by
          // whoever resolved it, since economic-service's resolution only
          // releases the transaction and the order's decision is what moves
          // the money (Q-138). Without it, carrying this resolution's
          // words: in the field economic-service keeps them in, or over the
          // objection where it has none.
          answer: (transaction) => {
            const released =
              (transaction.status === 'PENDING_SETTLEMENT' || transaction.status === 'SETTLED') &&
              transaction.disputedAt !== null;
            const ours =
              economicDisputeId === undefined
                ? (transaction.disputeResolution ?? transaction.disputeReason) === resolution
                : transaction.disputeId === economicDisputeId;
            return released && ours ? { result: undefined } : null;
          },
        },
      );
    },

    async markCancelled(orderId: string, reason: string): Promise<OrderStatus> {
      const step = currentStep();
      return asSystemFor(orderId, () => deps.orders.markCancelled(orderId, reason, step));
    },

    /**
     * Records that a window elapsed (ADR-043).
     *
     * Moves no money, changes no state, and notifies nobody —
     * notification-service does not exist (ADR-041 § 3). It writes a history
     * row and increments a counter, which is what makes an overdue order
     * visible to an operator. Once per reminder, however many attempts it took.
     */
    async recordReminder(orderId: string): Promise<void> {
      const step = currentStep();
      await asSystemFor(orderId, () => deps.orders.recordReminder(orderId, step));
    },
  };
}

/**
 * A `RequestContext` for work with no request behind it.
 *
 * The correlation id is the **order's own**, not a fresh one: a saga step and
 * the HTTP call that placed the order then share one identifier through the
 * logs, the outbox and Kafka.
 */
function systemContext(organizationId: string | undefined, correlationId: string): RequestContext {
  return createSystemContext({
    correlationId,
    callerService: SERVICE_NAME,
    roles: ['SERVICE'],
    path: 'temporal://order-saga',
    method: 'ACTIVITY',
    ...(organizationId ? { organizationId } : {}),
  });
}

/**
 * Converts a platform error into one Temporal can classify.
 *
 * The `type` is the platform error code, which is what the workflow's
 * `nonRetryableErrorTypes` matches on: a business-rule refusal must not be
 * retried, because the second attempt gets the same answer and only reports
 * the failure later.
 */
/**
 * economic-service refused the command for the transaction's current state —
 * the refusal its state machine gives (`nextStatus`), and the only one a
 * command's own earlier effect can cause. Every other refusal is about the
 * request or the money, and is never read as "already done".
 */
function refusedForState(error: unknown): boolean {
  return isRastaError(error) && error.code === 'INVALID_STATE_TRANSITION';
}

/**
 * The obligation is DISPUTED, and this order's saga authorised it first: a
 * {@link DisputedObligation}, else null.
 *
 * DISPUTED by itself proves no authorisation — a dispute starts from HELD too.
 * The proof is economic-service's own record of the command that authorised
 * the transaction, kept for good: made by this service's signed token, under
 * the key only this order's `authoriseSettlement` sends. A person who
 * authorised, another service, another key, or a transaction authorised
 * before economic-service kept the record — none of them is this saga's
 * authorisation, and the refusal stands.
 */
function disputedSinceAuthorised(
  transaction: TransactionDetailView,
  orderId: string,
): DisputedObligation | null {
  const authorisation = transaction.settlementAuthorisation;
  const ours =
    authorisation?.service === SERVICE_NAME &&
    authorisation.idempotencyKey === idempotencyKeyFor.authorise(orderId);
  return transaction.status === 'DISPUTED' && ours && transaction.disputeReason
    ? {
        disputed: true,
        reason: transaction.disputeReason,
        economicDisputeId: transaction.disputeId ?? null,
      }
    : null;
}

function asTemporalFailure(error: unknown): Error {
  if (!isRastaError(error)) {
    return error instanceof Error ? error : new Error('The financial service call failed');
  }

  const retryable = !NON_RETRYABLE.has(error.code);
  return retryable
    ? ApplicationFailure.retryable(error.message, error.code)
    : ApplicationFailure.nonRetryable(error.message, error.code);
}

const NON_RETRYABLE = new Set([
  'BUSINESS_RULE_VIOLATION',
  'VALIDATION_FAILED',
  'TENANT_MISMATCH',
  'FORBIDDEN',
  'NOT_FOUND',
  'INSUFFICIENT_BALANCE',
  'IDEMPOTENCY_KEY_REUSED',
  'SERVICE_TENANT_CONTEXT_INVALID',
]);

/** The shape the workflow proxies. Derived, so it cannot drift. */
export type OrderActivities = ReturnType<typeof createActivities>;
