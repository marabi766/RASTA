import { Logger } from '@nestjs/common';
import { ApplicationFailure, Context, CancelledFailure } from '@temporalio/activity';
import { ERROR_STATUS, type ErrorCode } from '@rasta/contracts';
import {
  createSystemContext,
  isRastaError,
  RastaError,
  runWithContext,
  type RequestContext,
} from '@rasta/nest-common';
import { ulid } from 'ulid';
import type { OrderService } from '../order/order.service';
import {
  SagaCallSuperseded,
  type HeldOrderRow,
  type SagaActivity,
  type SagaStep,
} from '../order/order.repository';
import type { OrderStatus } from '../generated/prisma';
import {
  fundsOf,
  heldProofMissing,
  idempotencyKeyFor,
  ObligationLookupIncomplete,
  termsDiffer,
  type EconomicClient,
  type ObligationFunds,
  type ObligationTerms,
  type TransactionDetailView,
} from '../economic/economic.client';
import { SERVICE_NAME } from '../config/env';
import {
  FINAL_ANSWER_CONTRACT,
  OWNER_STATE_IS_FINAL,
  PROVEN_REFUSALS,
  REFUSED_ON_FIRST_ATTEMPT,
} from './economic-refusal';
import {
  economicCallsUnconfirmedTotal,
  releasesUnconfirmedTotal,
  settlementsExhaustedTotal,
} from '../observability/metrics';

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
 * Step keys include the workflow, run and activity ids, isolating restarted
 * and reset runs. Continue-As-New checkpoints have no activity in flight,
 * so each scheduled activity and all its retries belong to one run. Every
 * retry shares its key (`docs/08` § 8.8, Idempotency). Reads (`readOrder`,
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
  /** Which attempt this is. Temporal's own; not known counts as a retry. */
  currentAttempt?: () => number;
}

function temporalAttempt(): number | undefined {
  try {
    return Context.current().info.attempt;
  } catch {
    return undefined;
  }
}

/** The running activity's identity: the same on every retry of it, unique otherwise. */
export function temporalStep(): SagaStep {
  const { workflowExecution, activityId, scheduledTimestampMs } = Context.current().info;
  // Only a standalone activity has no workflow, and the saga schedules none.
  if (!workflowExecution) throw new Error('A saga activity ran outside a workflow');
  return {
    // Activity-side only: workflow commands and recorded results are unchanged
    // on replay, for both legacy numeric and patched saga-step-N activity ids.
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

/** The economic-service calls with a durable record until answered (FU-104, FU-145, #836 r1). */
type RecordedCall =
  'createObligation' | 'authoriseSettlement' | 'settle' | 'compensate' | 'resolveObligationDispute';

/** A call record as one attempt of one scheduled command opened it (#836 r1 R1). */
interface Opening {
  command: SagaStep;
  generation: number;
  /** This opening began the episode: no earlier send in it is unanswered. */
  started: boolean;
}

/**
 * The obligation is in a terminal status that is not the call's own effect, so no
 * attempt can ever have that effect, and no request still in flight can move it.
 * An answer, not a refusal: the saga decides from it what the order can do.
 */
export interface ObligationFinal {
  final: true;
  status: string;
  funds: ObligationFunds;
}

/** The economic calls whose outcome the saga can owe beside the release (FU-103, FU-117). */
export const UNCONFIRMED_OPERATIONS = [
  'readOrder',
  'authoriseSettlement',
  'settle',
  'disputeObligation',
  'compensate',
] as const;
export type UnconfirmedOperation = (typeof UNCONFIRMED_OPERATIONS)[number];

/** What `authoriseSettlement` answers. Undefined: authorised. */
export type AuthorisationResult =
  DisputedObligation | ObligationFinal | AuthorisationFenced | undefined;

/** Where the saga may authorise, the same two its read checks. Any other status is fenced. */
const AUTHORISABLE_STATUSES: readonly OrderStatus[] = ['RECEIPT_CONFIRMED', 'SETTLING'];

/**
 * The authorisation was not sent: the order, read under the lock the send would
 * have held, does not allow it (D-138). The saga follows the order instead, and
 * comes back to authorise only if the order returns to where it can.
 */
export interface AuthorisationFenced {
  fenced: true;
  status: OrderStatus;
  /**
   * An earlier attempt may have sent it, and the obligation shows no effect of
   * that yet. It could still land, so the saga keeps the doubt (`unconfirmed`).
   */
  inDoubt: boolean;
}

/**
 * The fence's own answer, not economic-service's (D-151): this attempt sent
 * nothing, so it says nothing of an earlier send still on its way, and never
 * confirms the call record — whatever its doubt, attempt or episode.
 */
function isAuthorisationFenced(result: AuthorisationResult): result is AuthorisationFenced {
  return result !== undefined && 'fenced' in result && result.fenced === true;
}

/**
 * What `markObligationDisputed` answers: the order's status, and the dispute
 * it filed for the one economic-service holds — null when it filed none.
 */
export type ObligationDisputeTaken = Awaited<ReturnType<OrderService['markObligationDisputed']>>;

/**
 * The statuses no late request can move for any call the saga waits on. Each call's
 * own effect is its answer first. A reversal starts from SETTLED and goes only further.
 */
const PAST_ANY_CALL = [
  'SETTLED',
  'PARTIALLY_REVERSED',
  'REVERSED',
  'REFUNDED',
  'CANCELLED',
  'FAILED',
];

/**
 * `transaction` as an {@link ObligationFinal} step answer when past any call, else null.
 * Null too for a caller that did not declare the answer (`FINAL_ANSWER_CONTRACT`): an
 * older workflow reads any answer as the call's effect, and it keeps the refusal.
 */
function finalFor(
  contract: string | undefined,
  transaction: TransactionDetailView,
): { result: ObligationFinal } | null {
  return contract === FINAL_ANSWER_CONTRACT && PAST_ANY_CALL.includes(transaction.status)
    ? {
        result: {
          final: true,
          status: transaction.status,
          funds: fundsOf(transaction),
        },
      }
    : null;
}

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

  /** A version mismatch, not a verdict: nothing is adopted, and nothing is stopped for good. */
  function heldProofUnavailable(orderId: string, transactionId: string): ApplicationFailure {
    logger.error(
      `Order ${orderId}: economic-service reads its obligation ${transactionId} as HELD and does not ` +
        'say whether that is proven: it is older than this release, which waits for it to be upgraded',
    );
    return ApplicationFailure.retryable(
      `economic-service does not yet prove order ${orderId}'s funds held`,
      'ECONOMIC_HELD_PROOF_UNAVAILABLE',
    );
  }
  // At zero from the start: `increase()` cannot see a series' first increment.
  releasesUnconfirmedTotal.inc({ service: SERVICE_NAME }, 0);
  for (const operation of UNCONFIRMED_OPERATIONS) {
    economicCallsUnconfirmedTotal.inc({ service: SERVICE_NAME, operation }, 0);
  }

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
    let activity: Context | undefined;
    try {
      activity = Context.current();
    } catch {
      /* Direct domain test, outside a worker. */
    }
    let heartbeat: NodeJS.Timeout | undefined;
    if (activity?.info.heartbeatTimeoutMs) {
      activity.heartbeat();
      heartbeat = setInterval(() => activity?.heartbeat(), 1000);
      heartbeat.unref();
    }
    try {
      // Read once without a tenant, purely to learn which tenant to adopt. The
      // describe() call is scoped by the repository's own written reason.
      const bootstrap = systemContext(undefined, ulid());
      const order = await runWithContext(bootstrap, () => deps.orders.describe(orderId));

      const context = systemContext(order.buyerOrganizationId, order.correlationId);
      return await runWithContext(context, () => fn(order));
    } catch (error) {
      if (activity?.cancellationSignal.aborted)
        throw new CancelledFailure('The financial activity was cancelled');
      throw asTemporalFailure(error);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  const currentStep = deps.currentStep ?? temporalStep;
  const currentAttempt = deps.currentAttempt ?? temporalAttempt;

  /**
   * The durable record of an economic-service call whose outcome is not yet
   * confirmed (FU-104, FU-145), under the order's own tenant: opened before the
   * call, since one that fails may still have committed, and closed only by
   * that attempt's own answer. It outlives the order's status: a dispute raised
   * on an order a failed settlement left RECEIPT_CONFIRMED pauses settlement,
   * and confirms nothing about the command already sent (#792 r2 F2).
   *
   * Bound to the scheduled command (#836 r1 R1): an attempt of a command older
   * than the record's owner is refused here, before it calls, and fails for
   * good — the saga has moved past it, and its answer, a step record's cached
   * one included, says nothing about the newer command's call.
   */
  const openCall = (
    orderId: string,
    operation: RecordedCall,
    subject: string,
  ): Promise<Opening> => {
    const command = currentStep();
    return asSystemFor(orderId, async (order) => ({
      command,
      ...(await deps.orders.openSagaCall(
        { id: order.id, organizationId: order.buyerOrganizationId },
        operation,
        subject,
        command,
      )),
    }));
  };
  const confirmCall = (
    orderId: string,
    operation: RecordedCall,
    subject: string,
    opening: Opening,
  ): Promise<void> =>
    asSystemFor(orderId, (order) =>
      deps.orders.confirmSagaCall(
        { id: order.id, organizationId: order.buyerOrganizationId },
        operation,
        subject,
        opening,
      ),
    );
  const openRelease = (orderId: string, disputeId: string): Promise<Opening> =>
    openCall(orderId, 'resolveObligationDispute', disputeId);

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
   *
   * A failed read is never that refusal: it is reported as a read
   * (`RECONCILIATION_READ_FAILED`), an unknown outcome, whatever code it got.
   *
   * With `confirmed`, for a call the saga waits on (`confirmedCall`), the only
   * failure marked as proof is this step's own refusal, by `fence` or the send,
   * on the first attempt of this scheduling. In doubt — a retry, or a round after
   * an unconfirmed attempt — a failed send asks the obligation, because a code
   * then says nothing of the attempts before it: its effect or a terminal status
   * is the answer (`finalFor`), and anything else stays unknown.
   *
   * ## No send past `fence` (D-138)
   *
   * Every send of such a call, on every attempt and round, goes out from inside
   * `whileOrderHeld`, after `fence` has passed the row as it stands under that
   * lock. The order read before this step is what the saga knew, and the
   * idempotency key only stops a second effect, not a first one after a dispute.
   * Fenced, nothing is sent, and `fence`'s answer is recorded like any other. The
   * lock is released before anything else runs: the record, or a reconciliation.
   *
   * In doubt, the obligation is asked first. An earlier attempt's effect is
   * answered from there and never by sending again. Only when it shows no effect
   * yet, and `fence` still passes, does the same key go out again. A fenced
   * attempt in doubt has therefore asked economic-service before the saga moves on.
   */
  async function economicStep<T>(
    orderId: string,
    activity: SagaActivity,
    call: (order: Awaited<ReturnType<OrderService['describe']>>) => Promise<T>,
    applied?: {
      transactionId: string;
      /** This command's effect on the obligation, as its answer; null when not there. */
      answer: (transaction: TransactionDetailView) => { result: T } | null;
      confirmed?: {
        inDoubt: boolean;
        /** Terminal, for a caller that cannot take an {@link ObligationFinal}: a marked failure. */
        isFinal?: (transaction: TransactionDetailView) => boolean;
        /**
         * Whether the order, as it stands, lets the call be sent: null if so, or the
         * step's answer in its place. A refusal it throws is never reconciled: the
         * obligation's state cannot stand in for a condition of this order's.
         */
        fence?: (order: HeldOrderRow, inDoubt: boolean) => { answer: T } | null;
      };
    },
  ): Promise<T> {
    const step = currentStep();
    const confirmed = applied?.confirmed;
    const inDoubt = confirmed !== undefined && (confirmed.inDoubt || currentAttempt() !== 1);
    const unanswered = (refusal: unknown): unknown =>
      confirmed && !inDoubt ? provenIfListed(refusal) : refusal;
    return asSystemFor(orderId, (order) =>
      deps.orders.onceForSaga(
        { id: order.id, organizationId: order.buyerOrganizationId },
        step,
        activity,
        async () => {
          const askObligation = (transactionId: string) =>
            deps.economic
              .readObligation({
                orderId: order.id,
                transactionId,
                buyerOrganizationId: order.buyerOrganizationId,
                correlationId: order.correlationId,
              })
              .catch((failure: unknown) => {
                throw reconciliationReadFailed(activity, failure);
              });

          let refusal: unknown;
          const fence = confirmed?.fence;
          if (applied && fence) {
            const passes = (row: HeldOrderRow): { answer: T } | null => {
              try {
                return fence(row, inDoubt);
              } catch (fenceRefusal) {
                throw unanswered(fenceRefusal);
              }
            };
            if (inDoubt) {
              // Its refusal comes first: an obligation is not asked for an order
              // that may not ask. What it lets through is decided again below.
              passes(order);
              const transaction = await askObligation(applied.transactionId);
              const answer = transaction ? applied.answer(transaction) : null;
              if (answer) {
                logger.warn(
                  `Saga step ${activity} of order ${order.id} is in doubt, and the transaction's state ` +
                    `(${transaction?.status}) answers it; answering from economic-service's record`,
                );
                return answer.result;
              }
            }
            const held = await deps.orders.whileOrderHeld(
              order.id,
              async (row): Promise<{ answer: T } | { failure: unknown }> => {
                const closed = passes(row);
                if (closed) {
                  logger.warn(
                    `Saga step ${activity} of order ${order.id} was not sent: the order is ${row.status}`,
                  );
                  return closed;
                }
                try {
                  return { answer: await call(order) };
                } catch (failure) {
                  // Returned, not thrown, so what the send said reaches the reads
                  // below with the lock already released.
                  return { failure };
                }
              },
            );
            if ('answer' in held) return held.answer;
            refusal = held.failure;
          } else {
            try {
              return await call(order);
            } catch (failure) {
              refusal = failure;
            }
          }

          if (!applied || !(inDoubt || refusedForState(refusal))) throw unanswered(refusal);
          const transaction = await askObligation(applied.transactionId);
          const answer = transaction ? applied.answer(transaction) : null;
          if (!answer) {
            if (inDoubt && transaction && confirmed?.isFinal?.(transaction)) {
              throw ApplicationFailure.create({
                message: `The obligation is ${transaction.status}: terminal, and nothing further can move it`,
                type: 'OBLIGATION_ALREADY_FINAL',
                nonRetryable: true,
                details: [OWNER_STATE_IS_FINAL],
              });
            }
            throw unanswered(refusal);
          }
          logger.warn(
            `Saga step ${activity} of order ${order.id} was refused, and the transaction's state ` +
              `(${transaction?.status}) answers it; answering from economic-service's record`,
          );
          return answer.result;
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
     * HELD from a release too old to say whether it is proven: retryable, and
     * that recovery waits for one that can (`heldProofUnavailable`).
     */
    async createObligation(orderId: string): Promise<HeldResult> {
      // The hold's intent, keyed by the order, before anything is sent (#836 r1
      // R2): a create that times out may commit after the saga stopped looking,
      // so only its own answer, a refusal proving it held nothing, or a lookup
      // that finds the obligation (`findObligation`) ends it. An empty lookup,
      // the order's terminal status or the record's age never does: a create
      // delayed before its claim can still commit, and economic-service's
      // retention starts at the claim (#836 r2 N1, D-135; the fence is FU-161).
      const opening = await openCall(orderId, 'createObligation', orderId);
      const held = await economicStep(orderId, 'createObligation', async (order) => {
        if (order.economicTransactionId) {
          // A retry after the call succeeded but the recording did not. The
          // obligation exists; do not create a second one.
          return { transactionId: order.economicTransactionId };
        }

        try {
          const transaction = await deps.economic.createObligation({
            ...obligationTermsOf(order),
            correlationId: order.correlationId,
          });
          return { transactionId: transaction.id };
        } catch (refusal) {
          // Only for the send that began the episode: economic-service frees
          // the key on a refusal, so an earlier send of this episode still on
          // its way could claim it and commit after this one was refused.
          // And only on the scheduling's first attempt (#836 r2 N1, D-135): a
          // record that began here proves no earlier send only of attempts
          // that record one, and an older worker's attempt sent unrecorded. A
          // missing record, like an empty lookup or an old row, is absence,
          // which never closes anything; unknown (no Temporal context) is not 1.
          if (opening.started && currentAttempt() === 1 && heldNothing(refusal)) {
            await deps.orders.confirmSagaCall(
              { id: order.id, organizationId: order.buyerOrganizationId },
              'createObligation',
              order.id,
              opening,
            );
          }
          throw refusal;
        }
      });
      await confirmCall(orderId, 'createObligation', orderId, opening);
      await asSystemFor(orderId, async (order) => {
        const now = await deps.economic.readObligation({
          orderId: order.id,
          transactionId: held.transactionId,
          buyerOrganizationId: order.buyerOrganizationId,
          correlationId: order.correlationId,
        });
        if (now && heldProofMissing(now)) throw heldProofUnavailable(order.id, now.id);
        const funds = now ? fundsOf(now) : 'UNPROVEN';
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
            // The order's own obligation exists, whatever its status: no create
            // for this order is in doubt any more (#836 r1 R2). A row on other
            // terms, or none, proves nothing of the order's own create.
            await deps.orders.confirmSagaCallsOn(
              { id: order.id, organizationId: order.buyerOrganizationId },
              ['createObligation'],
              order.id,
            );
            // Retried until it answers (LOCAL_OPTIONS): the order waits, and carries on
            // by itself once economic-service is upgraded (FU-138; ADR-040).
            if (heldProofMissing(own)) throw heldProofUnavailable(order.id, own.id);
            const funds = fundsOf(own);
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
     * disputed since in economic-service; an {@link AuthorisationFenced} when the
     * order, under the lock the send would hold, does not allow it. `inDoubt` is
     * the workflow's word that an earlier scheduling of this call went unconfirmed,
     * which this attempt cannot see. Omitted, the workflow still ends nothing on a
     * mark it did not ask for: it ignores the mark while in doubt (`outcomeUnknown`).
     * An {@link ObligationFinal} when it can never be authorised.
     */
    async authoriseSettlement(
      orderId: string,
      transactionId: string,
      inDoubt = false,
      contract?: string,
    ): Promise<AuthorisationResult> {
      // Only economic-service's answer closes the record: authorised, disputed
      // since this order's own authorisation, or final. A refusal, no answer or
      // the fence's answer (nothing sent; D-151) leaves it open.
      const opening = await openCall(orderId, 'authoriseSettlement', transactionId);
      const authorisation = await economicStep<AuthorisationResult>(
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
            if (disputed) return { result: disputed };
            // SETTLED is the effect, above. DISPUTED and HELD can still move.
            return finalFor(contract, transaction);
          },
          confirmed: {
            inDoubt,
            ...(contract === FINAL_ANSWER_CONTRACT
              ? {}
              : { isFinal: ({ status }) => ['REFUNDED', 'CANCELLED', 'FAILED'].includes(status) }),
            fence: ({ status, receiptConfirmed }, doubt) => {
              // Anything else is the order's own path now, not this call's: a
              // dispute or a refund to wait on, or a settled dispute taken back
              // before receipt. Listed by what may send, so a status added later
              // sends nothing until it is named here.
              if (!AUTHORISABLE_STATUSES.includes(status)) {
                return { answer: { fenced: true, status, inDoubt: doubt } };
              }
              // The buyer's receipt is what authorises settlement; without it on
              // the row, nothing is asked of economic-service. An order an older
              // release's SETTLE left RECEIPT_CONFIRMED with no receipt would
              // otherwise authorise an obligation migration 20261103121000 put
              // back in HELD (#625 round 2 self-review). Refused for good, with
              // the funds held, for the runbook
              // (docs/runbooks/marketplace-receipt-evidence.md): the saga stops on
              // a first attempt, and in doubt it waits, never reading as authorised.
              if (!receiptConfirmed) {
                throw RastaError.businessRule(
                  'Settlement is authorised only for an order whose receipt the buyer confirmed',
                  { orderId },
                );
              }
              return null;
            },
          },
        },
      );
      if (!isAuthorisationFenced(authorisation)) {
        await confirmCall(orderId, 'authoriseSettlement', transactionId, opening);
      }
      return authorisation;
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
      // An attempt that gets no answer leaves the record open after the saga
      // gives up (SETTLEMENT_EXHAUSTED), whatever the order's status becomes.
      const opening = await openCall(orderId, 'settle', transactionId);
      const settled = await economicStep<SettledResult | DisputedObligation>(
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
      await confirmCall(orderId, 'settle', transactionId, opening);
      return settled;
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
     * compensation entirely. An {@link ObligationFinal} when another terminal status
     * means no refund can ever land.
     */
    async compensate(
      orderId: string,
      transactionId: string,
      reason: string,
      inDoubt = false,
      contract?: string,
    ): Promise<ObligationFinal | void> {
      const opening = await openCall(orderId, 'compensate', transactionId);
      const answer = await economicStep<ObligationFinal | void>(
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
            transaction.status === 'REFUNDED'
              ? { result: undefined }
              : finalFor(contract, transaction),
          ...(contract === FINAL_ANSWER_CONTRACT ? { confirmed: { inDoubt } } : {}),
        },
      );
      await confirmCall(orderId, 'compensate', transactionId, opening);
      // An ObligationFinal is economic-service's answer to the refund too, but
      // only REFUNDED proves no authorisation or settlement of it can land:
      // those left unanswered on it are answered then, and only then.
      if (answer === undefined) {
        await asSystemFor(orderId, (order) =>
          deps.orders.confirmSagaCallsOn(
            { id: order.id, organizationId: order.buyerOrganizationId },
            ['authoriseSettlement', 'settle'],
            transactionId,
          ),
        );
      }
      return answer;
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
     * or null from an economic-service older than the identity. An
     * {@link ObligationFinal} when the obligation can no longer be disputed.
     */
    async disputeObligation(
      orderId: string,
      transactionId: string,
      disputeId: string,
      reason: string,
      inDoubt = false,
      contract?: string,
    ): Promise<string | ObligationFinal | null> {
      // Before the call: a call that fails may still have committed.
      await openRelease(orderId, disputeId);
      return economicStep<string | ObligationFinal | null>(
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
          // Disputed by another's words can still move, and so can HELD or
          // PENDING_SETTLEMENT: a late filing can land on those.
          answer: (transaction) =>
            transaction.status === 'DISPUTED' && sameText(transaction.disputeReason, reason)
              ? { result: transaction.disputeId ?? null }
              : finalFor(contract, transaction),
          ...(contract === FINAL_ANSWER_CONTRACT ? { confirmed: { inDoubt } } : {}),
        },
      );
    },

    /**
     * Reopens the transaction so a dispute decided for the supplier can settle.
     *
     * With `economicDisputeId`, only that dispute: economic-service refuses the
     * resolution, under its row lock, once the transaction holds another — one
     * raised since the dispute decided here was taken, after that one was
     * resolved there (Codex on #318 round 2, N1). The refusal stands: the saga
     * waits with the funds held and the alert on, for an operator (FU-080). In a
     * terminal status there is nothing left to release ({@link ObligationFinal}), and
     * the saga's next call reads that status and says what follows.
     *
     * Confirmed on every way this answers, including a retry answered from the
     * step's record. The record, opened when economic-service was told of the
     * dispute and again by every attempt here, stays open whether or not a saga
     * is left to make this call (FU-104). An attempt after an earlier one confirmed
     * is open until it answers itself, and an earlier attempt's late confirmation
     * cannot close it.
     */
    async resolveObligationDispute(
      orderId: string,
      transactionId: string,
      disputeId: string,
      resolution: string,
      economicDisputeId?: string,
      contract?: string,
    ): Promise<ObligationFinal | void> {
      const opening = await openRelease(orderId, disputeId);
      const answer = await economicStep<ObligationFinal | void>(
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
          // Out of the dispute: back in the settlement queue (or since
          // settled), or back in HELD — where economic-service returns an
          // escrowed obligation never authorised, a dispute raised before
          // the buyer confirmed receipt (D-083). A resolution is the only way
          // out of DISPUTED to either, so with this dispute's identity on it,
          // or this resolution's words, it is this resolution's effect. With
          // the dispute's identity, out of THAT dispute — by
          // whoever resolved it, since economic-service's resolution only
          // releases the transaction and the order's decision is what moves
          // the money (Q-138). Without it, carrying this resolution's words
          // (`resolutionOf`) — never in place of the identity.
          answer: (transaction) => {
            const released =
              (transaction.status === 'HELD' ||
                transaction.status === 'PENDING_SETTLEMENT' ||
                transaction.status === 'SETTLED') &&
              transaction.disputedAt !== null;
            const ours =
              economicDisputeId === undefined
                ? sameText(resolutionOf(transaction), resolution)
                : transaction.disputeId === economicDisputeId;
            return released && ours ? { result: undefined } : finalFor(contract, transaction);
          },
        },
      );
      await confirmCall(orderId, 'resolveObligationDispute', disputeId, opening);
      return answer;
    },

    /**
     * Reports a round of a dispute release economic-service has not confirmed
     * (FU-080), from an activity because the SDK logger discards a workflow's
     * words (`TemporalRuntimeLogger`) and only a worker holds the registry.
     * Touches nothing else, so it cannot fail for the reason the release did.
     */
    async noteReleaseUnconfirmed(orderId: string, round: number, failure: string): Promise<void> {
      releasesUnconfirmedTotal.inc({ service: SERVICE_NAME });
      logger.error(
        `The dispute release of order ${orderId} is unconfirmed after round ${round} ` +
          `(${failure}); its funds stay held and the saga keeps trying ` +
          '(docs/runbooks/marketplace-saga-deploy.md)',
      );
    },

    /**
     * Reports a round of another economic call whose outcome is unknown
     * (FU-103, FU-117), as `noteReleaseUnconfirmed` does for the release.
     */
    async noteEconomicCallUnconfirmed(
      orderId: string,
      operation: UnconfirmedOperation,
      round: number,
      failure: string,
    ): Promise<void> {
      economicCallsUnconfirmedTotal.inc({ service: SERVICE_NAME, operation });
      logger.error(
        `The ${operation} call of order ${orderId} is unconfirmed after round ${round} ` +
          `(${failure}); its outcome is unknown and the saga keeps trying ` +
          '(docs/runbooks/marketplace-saga-deploy.md)',
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
 * economic-service refused the create outright, so it holds nothing under the
 * order's key (#836 r1 R2): its own error body, a code it gives only before
 * any effect, under that code's own status. economic-service claims the key in
 * a committed row first, so an earlier attempt still in flight makes this one
 * `CONFLICT`, and an earlier one that committed is replayed, never refused for
 * its work. Not `NOT_FOUND`, `FORBIDDEN` or `TENANT_MISMATCH`: the replay guard
 * answers those for a key that did commit, to a caller who lost access since
 * (economic-service `shared/idempotency.ts`). Anything else — no answer, a
 * conflict, a reused key, an unknown code or status — leaves the intent open.
 */
function heldNothing(error: unknown): boolean {
  if (!isRastaError(error) || !CREATE_REFUSALS.has(error.code)) return false;
  return error.internalContext?.status === ERROR_STATUS[error.code];
}

const CREATE_REFUSALS = new Set<ErrorCode>([
  'INSUFFICIENT_BALANCE',
  'BUSINESS_RULE_VIOLATION',
  'VALIDATION_FAILED',
]);

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
 * The same words, whatever their line endings. economic-service keeps the text
 * as sent; once it keeps it with LF line endings (FU-115), this reader still
 * finds its own dispute and resolution — which is why this release, reading
 * both, must be every running worker and the rollback floor before that
 * writer ships (docs/06 § 6.8). This service keeps the four transaction texts
 * with LF line endings (PR-806 r1 F1); a text stored before that may hold CRLF.
 */
function sameText(kept: string | null | undefined, sent: string): boolean {
  const lf = (text: string) => text.replace(/\r\n?/g, '\n');
  return typeof kept === 'string' && lf(kept) === lf(sent);
}

/**
 * The words the last resolution left on the transaction.
 *
 * economic-service keeps them in `disputeResolution`, beside the objection
 * (docs/23 D-060). Before it did, the resolution was written over the
 * objection, in `disputeReason`, and that is all a transaction resolved then
 * still has: `disputeResolution` is null there, and absent altogether from an
 * economic-service older than the field. Only then is `disputeReason` read —
 * on a transaction resolved since, it is the objection, and a resolution
 * worded like it proves nothing (Codex on #322).
 */
function resolutionOf(transaction: TransactionDetailView): string | null {
  const keptApart = transaction.disputeResolution;
  if (keptApart !== null && keptApart !== undefined) return keptApart;
  // Resolved before the field: the resolution is where it was written.
  return transaction.disputeReason;
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

/** The step's own refusal, nothing before it: non-retryable, as a retry would be in doubt. */
function provenIfListed(refusal: unknown): unknown {
  return isRastaError(refusal) && PROVEN_REFUSALS.has(refusal.code)
    ? ApplicationFailure.create({
        message: refusal.message,
        type: refusal.code,
        nonRetryable: true,
        details: [REFUSED_ON_FIRST_ATTEMPT],
      })
    : refusal;
}

/** A read behind a step's reconciliation failed: retried, and never its code as the step's. */
function reconciliationReadFailed(activity: SagaActivity, failure: unknown): ApplicationFailure {
  const said = isRastaError(failure) ? failure.code : 'no answer';
  return ApplicationFailure.retryable(
    `Saga step ${activity} could not read the obligation to reconcile (${said})`,
    'RECONCILIATION_READ_FAILED',
  );
}

/**
 * Converts a platform error into one Temporal can classify.
 *
 * The `type` is the platform error code, which is what the workflow's
 * `nonRetryableErrorTypes` matches on: a business-rule refusal must not be
 * retried, because the second attempt gets the same answer and only reports
 * the failure later.
 */
function asTemporalFailure(error: unknown): Error {
  // For good, wherever a record is opened: the saga has moved past this command.
  if (error instanceof SagaCallSuperseded) {
    return ApplicationFailure.nonRetryable(error.message, 'SAGA_CALL_SUPERSEDED');
  }
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
