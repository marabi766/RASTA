import {
  ActivityFailure,
  continueAsNew,
  workflowInfo,
  type ActivityOptions,
  ApplicationFailure,
  CancellationScope,
  condition,
  defineQuery,
  defineSignal,
  isCancellation,
  patched,
  proxyActivities,
  setHandler,
  sleep,
} from '@temporalio/workflow';
import type {
  AuthorisationResult,
  DisputedObligation,
  ObligationFinal,
  OrderActivities,
  SagaOrderView,
  SettledResult,
  UnconfirmedOperation,
} from './activities';
import {
  FINAL_ANSWER_CONTRACT,
  OWNER_STATE_IS_FINAL,
  PROVEN_REFUSALS,
  REFUSED_ON_FIRST_ATTEMPT,
} from './economic-refusal';

export { PROVEN_REFUSALS };

/**
 * `OrderSagaWorkflow` — the platform's first real Temporal workflow (ADR-039).
 *
 * ## Why this one, when ADR-027 and ADR-031 both declined Temporal
 *
 * Both declined it correctly. Maintenance due-dates are derived on read;
 * settlement is a single `BEGIN … COMMIT`. Neither has state that outlives a
 * process. An order does: it waits days for a supplier to deliver and then
 * days for a buyer to confirm, and something has to hold that wait across
 * restarts and then compensate in reverse order if it ends badly.
 *
 * ## The order row decides; a signal only says "look now"
 *
 * Every party command commits to the database first and signals second
 * (ADR-039 § 3). This workflow used to act on the signals themselves, as
 * in-memory flags, which made it wrong in both directions. A signal that was
 * lost — Temporal unreachable after the commit — left a committed command
 * unobserved for good. A signal that should not have arrived — once, a
 * replayed request aimed at another tenant's order — was acted on as if a
 * party had issued it.
 *
 * Now every decision is taken on a fresh read of the order (`readOrder`).
 * A signal wakes the workflow early, and a timer wakes it anyway every
 * `recheckIntervalHours`; what it then does depends only on what the order
 * says. Signal arguments are ignored, and every reason passed on to
 * economic-service is read from the order and its dispute.
 *
 * ## Determinism
 *
 * Nothing in this file reads a clock, a random number, a database or a socket.
 * Temporal re-executes workflow code on every replay, and any of those would
 * make the replay disagree with the original run. Time comes from `sleep()`
 * and `condition()`, which Temporal records, and from `Date.now()`, which in
 * a workflow is Temporal's recorded time of the current workflow task, not
 * the host's clock; everything else is an activity.
 *
 * ## A dispute settled before receipt resumes the order (D-083)
 *
 * An operator's SETTLE returns a disputed order to where the dispute found
 * it. Raised after receipt, that is RECEIPT_CONFIRMED and the saga settles.
 * Raised before — FUNDS_HELD, CONFIRMED, AWAITING_RECEIPT_CONFIRMATION — the
 * saga leaves its dispute wait for that status's own wait, first telling
 * economic-service the dispute is decided (which returns the obligation to
 * HELD, not to the settlement queue), and settles only after the buyer's
 * confirmation, as for an order never disputed. Its reminder deadlines are
 * the ones it had: a dispute does not buy a fresh window
 * (`DISPUTE_RESUME_PATCH`).
 *
 * ## The saga does not end with a release unconfirmed (FU-080)
 *
 * While economic-service has not confirmed a decided dispute's resolution, the
 * obligation stays DISPUTED and the funds held. So when the call fails — its
 * attempts exhausted, or refused — the saga stays, in a durable wait that calls
 * again under the same idempotency key with a bounded backoff, reports each
 * round for the alert, and takes an operator's `retryDisputeRelease` signal. It
 * moves nothing else meanwhile, so no receipt can settle past it
 * (`waitForConfirmation`).
 *
 * ## One boundary for the other economic calls (FU-103)
 *
 * `confirmedCall` puts another economic call in the same wait. Only an answer
 * that proves the call changed nothing (`PROVEN_REFUSALS`) takes the path it
 * always took; anything else — a 5xx, a timeout, a lost response, a code nobody
 * listed — says nothing about the money, so the saga stays and asks again under
 * the same key. `siblingCall` does the same for the dispute filing and the refund
 * (FU-117). The hold still records FAILED on an empty lookup, as it always did.
 *
 * A code speaks for one attempt, never for the attempts before it. So the proof
 * is the activity's own refusal on the first attempt this run scheduled, which it
 * marks; once any attempt went unconfirmed, no code ends the wait. Only the
 * obligation as economic-service has it does: the call's effect there, or a
 * terminal status no late request can move (`ObligationFinal`). HELD is neither,
 * as an earlier request can still commit, so the saga stays. A read refused while
 * a call is unconfirmed waits too (`read`).
 *
 * ## Authorisation answers to the order, not to the saga's last read (D-138)
 *
 * A read here is already old when the activity it leads to runs: a dispute can
 * commit in between, or during a retry. So this file decides nothing about whether
 * an authorisation may go out. The activity decides, on every attempt, with the
 * order's row held for as long as the send takes. When the order does not allow it,
 * nothing is sent and the answer says so (`AuthorisationFenced`). The saga then
 * follows the order as it would after any read, keeping the doubt if an earlier
 * attempt may have sent it (`AUTHORISATION_FENCE_PATCH`).
 *
 * ## Owed work outlives every exit (FU-117)
 *
 * What the saga owes stays recorded (`owedWork`) until done or reconciled: no refused
 * read, lookup or local step ends the saga meanwhile. The owner's terminal status is
 * an answer: money back with the buyer, or never held, lets a cancellation finish;
 * anything else stays for a person (`staysForReconciliation`), never a false one.
 *
 * ## What expiry does NOT do
 *
 * There is no timer that confirms receipt, cancels an order, or moves money
 * (ADR-043, Q-11). A window elapsing records a reminder and the workflow goes
 * back to waiting. An unconfirmed order waits indefinitely, on purpose:
 * automatic confirmation would release money without the buyer's consent, and
 * the platform is not entitled to infer that consent from silence.
 */

export const orderConfirmed = defineSignal('orderConfirmed');
export const orderFulfilled = defineSignal('orderFulfilled');
export const receiptConfirmed = defineSignal('receiptConfirmed');
export const orderDisputed = defineSignal<[string]>('orderDisputed');
export const orderCancelled = defineSignal<[string]>('orderCancelled');
export const disputeResolved = defineSignal<['SETTLE' | 'REFUND']>('disputeResolved');
/** An operator's: whichever economic call is unconfirmed is tried now, not at the next backoff. */
export const retryDisputeRelease = defineSignal('retryDisputeRelease');

export const orderSagaStatus = defineQuery<SagaStatus>('status');

export interface SagaStatus {
  phase: string;
  /**
   * Steps that are part of the documented saga but have no implementation.
   *
   * `docs/08` § 8.4 step 3 is `inventory.reserveStock`. inventory-service does
   * not exist, so the step is named and marked deferred rather than deleted —
   * deleting it would mean someone has to rediscover that it was ever required
   * (ADR-041 § 2).
   */
  deferredSteps: string[];
  remindersRecorded: number;
  settlementAttempts: number;
}

export interface OrderSagaInput {
  orderId: string;
  /** Days before an unfulfilled order is counted overdue. */
  fulfillmentWindowDays: number;
  /** Days before an unconfirmed delivery is counted overdue. */
  receiptWindowDays: number;
  /** Days between reminders once a window has elapsed. */
  reminderIntervalDays: number;
  /**
   * Hours between re-reads of a waiting order, signal or no signal
   * (`MARKETPLACE_SAGA_RECHECK_HOURS`). Optional only so that a saga started
   * by a client older than this field still runs.
   */
  recheckIntervalHours?: number;
  /** Internal lower threshold for deterministic rollover tests; never raises production limits. */
  historyEventThreshold?: number;
  resume?: SagaResume;
}

/**
 * The dispute filing or the refund in its wait (FU-117), with what the
 * next run cannot read back: a refund's lookup would find the obligation REFUNDED
 * and stop, and the order may have left the dispute being filed.
 */
export interface UnconfirmedSibling {
  operation: UnconfirmedOperation;
  rounds: number;
  transactionId?: string;
  disputeId?: string;
  reason?: string;
}

/** An authorisation in its wait for confirmation, for the next run to go on counting. */
export interface UnconfirmedCall {
  operation: UnconfirmedOperation;
  rounds: number;
  /**
   * The saga left the wait to follow a moved order, the call still unconfirmed.
   * A later return to the call goes on from here, not as a first send.
   */
  movedOn?: boolean;
}

export interface SagaResume {
  status: SagaStatus;
  mirroredDispute?: string;
  mirroredEconomicDispute?: string;
  waitingIn: SagaOrderView['status'];
  nextReminderAt?: number;
  /**
   * The other windows' deadlines (`reminderDue`), so a rollover during a
   * dispute does not buy the resumed order a fresh window (D-083). Absent from
   * a run continued before D-083.
   */
  reminderDue?: [SagaOrderView['status'], number][];
  activitySequence: number;
  /** Rounds of an unconfirmed release so far, when rolled over inside its wait. */
  releaseRounds?: number;
  /** The authorisation in its wait, when rolled over there or since (FU-103). */
  unconfirmedCall?: UnconfirmedCall;
  /** The other call in its wait, when rolled over there (FU-117). */
  siblingCall?: UnconfirmedSibling;
  /** Work owed outside any call's wait, when rolled over with it (`owedWork`, FU-117). */
  outstandingWork?: OutstandingWork;
}

/** A call or local step the saga has yet to see through. */
export interface OutstandingWork {
  operation: UnconfirmedOperation;
  rounds: number;
  /** No hold of this saga can be on its way, so an empty lookup may close a cancellation. */
  noHold?: boolean;
}

/**
 * Calls to economic-service: three attempts, and a business refusal is final.
 *
 * A business rule does not become true on a second attempt; retrying only
 * reports the same refusal later. A tenant mismatch is the same.
 */
const ECONOMIC_OPTIONS = {
  startToCloseTimeout: '30 seconds',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumAttempts: 3,
    nonRetryableErrorTypes: [
      'BUSINESS_RULE_VIOLATION',
      'VALIDATION_FAILED',
      'TENANT_MISMATCH',
      'FORBIDDEN',
      'NOT_FOUND',
    ],
  },
} satisfies ActivityOptions;
const legacyEconomic = proxyActivities<OrderActivities>(ECONOMIC_OPTIONS);

/**
 * Reads, and writes to this service's own database: retried until they answer.
 *
 * Each of these is idempotent — a read, or a step that records its outcome
 * under its own key and answers a retry from that record, wherever the order
 * has moved since (D-053). Retrying them costs nothing.
 * Giving up on them is what cost money: a local write that failed after an
 * economic step succeeded used to be treated as though the economic step had
 * failed, and the saga then recorded the opposite of what had happened. A
 * local outage now delays the saga; it never decides anything. A refusal by
 * the state machine is still final, because it is not an outage.
 */
const LOCAL_OPTIONS = {
  startToCloseTimeout: '30 seconds',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumInterval: '5 minutes',
    nonRetryableErrorTypes: [
      'BUSINESS_RULE_VIOLATION',
      'VALIDATION_FAILED',
      'TENANT_MISMATCH',
      'FORBIDDEN',
      'NOT_FOUND',
    ],
  },
} satisfies ActivityOptions;
const legacyLocal = proxyActivities<OrderActivities>(LOCAL_OPTIONS);

/**
 * The `patched()` marker of D-083's changes to the waits: a window keeps its
 * deadline across a dispute instead of starting again, the dispute wait also
 * ends on a new dispute, and a resumed pre-receipt wait first releases the
 * mirrored dispute (`mirrorResumed`). A history recorded before it — including
 * one a previous-release worker wrote for an order resumed during the rollout
 * — replays its old commands exactly; a run past it records the marker at its
 * first guarded point.
 */
export const DISPUTE_RESUME_PATCH = 'dispute-settle-resumes-order';

/**
 * The `patched()` marker of the release wait (FU-080). Asked only once the
 * release has failed: a saga whose release succeeds records nothing, and a
 * history in which the failure ended the run replays that end.
 */
export const RELEASE_WAIT_PATCH = 'dispute-release-durable-wait-v1';

/**
 * The same, for every other economic call the saga waits on (FU-103). Asked only
 * once the outcome is unknown: a history in which that ended the run replays
 * that end.
 */
export const ECONOMIC_WAIT_PATCH = 'economic-call-durable-wait-v1';

/**
 * The same, for the dispute filing and the refund (FU-117). Not the
 * marker above: a history carrying that one from an authorisation may end at one
 * of these calls, and must replay that end.
 */
export const SIBLING_WAIT_PATCH = 'economic-sibling-call-durable-wait-v1';

/**
 * Owed work surviving every exit (FU-117). Asked only where a history without it
 * ended the run, or where a settlement has just gone unconfirmed, so each of those
 * histories replays its end and its doubt-free filing; and right before scheduling
 * any call that may answer `ObligationFinal` (`finalAnswers`).
 */
export const OWED_WORK_PATCH = 'saga-owed-work-durable-v1';

/**
 * The `patched()` marker of `AuthorisationFenced` (D-138). Asked only when an
 * activity answers it: a saga never fenced records nothing. It marks a history no
 * earlier protocol can read, since such a build takes the answer as "authorised".
 * So does the answer itself, before any workflow task has asked this: the drain
 * gate reads recorded results too (`resultProtocol`).
 */
export const AUTHORISATION_FENCE_PATCH = 'authorisation-order-fence-v1';

/** What the status query shows while each call waits. */
const UNCONFIRMED_PHASE: Record<UnconfirmedOperation, string> = {
  readOrder: 'ORDER_UNREADABLE',
  authoriseSettlement: 'AUTHORISATION_UNCONFIRMED',
  settle: 'SETTLEMENT_UNCONFIRMED',
  disputeObligation: 'DISPUTE_UNCONFIRMED',
  compensate: 'COMPENSATION_UNCONFIRMED',
};

/** The order status each call waits at, for the rollover to name. */
const UNCONFIRMED_AT: Record<UnconfirmedOperation, OrderStatus> = {
  // Replaced by the status last read (`owedWork`).
  readOrder: 'FUNDS_HELD',
  authoriseSettlement: 'RECEIPT_CONFIRMED',
  settle: 'RECEIPT_CONFIRMED',
  disputeObligation: 'DISPUTED',
  compensate: 'CANCELLING',
};

/**
 * Between release rounds: doubling from a minute, an hour at most. Never zero,
 * which `condition()` would record as an SDK marker the drain gate refuses.
 */
export function releaseBackoffMs(round: number): number {
  return Math.min(HOUR, 60_000 * 2 ** Math.min(Math.max(round - 1, 0), 6));
}

/** `docs/08` § 8.4 gives settlement five attempts before a human is needed. */
const SETTLEMENT_ATTEMPTS = 5;

/** The env default, for a saga started by a client that did not pass one. */
const DEFAULT_RECHECK_HOURS = 24;

// Conservative checkpoints below Temporal defaults: 51,200 events / 50 MiB
// hard limits, 10,240 events / 10 MiB warnings. Also honor the server suggestion.
export const SAGA_HISTORY_EVENTS = 2000;
export const SAGA_HISTORY_BYTES = 2 * 1024 * 1024;
const ROLLOVER_PATCH = 'order-saga-durable-rollover-v1';

export function shouldRollSaga(
  info: { continueAsNewSuggested: boolean; historyLength: number; historySize: number },
  eventThreshold = SAGA_HISTORY_EVENTS,
): boolean {
  return (
    info.continueAsNewSuggested ||
    info.historyLength >= eventThreshold ||
    info.historySize >= SAGA_HISTORY_BYTES
  );
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type OrderStatus = SagaOrderView['status'];

export async function orderSaga(input: OrderSagaInput): Promise<string> {
  const { orderId } = input;
  const recheckMs = (input.recheckIntervalHours ?? DEFAULT_RECHECK_HOURS) * HOUR;

  let activitySequence = input.resume?.activitySequence ?? 0;
  let durable = Boolean(input.resume);
  if (!Number.isSafeInteger(activitySequence) || activitySequence < 0) {
    throw ApplicationFailure.nonRetryable('Invalid saga activity sequence', 'SAGA_INCONSISTENT');
  }
  const eventThreshold = input.historyEventThreshold ?? SAGA_HISTORY_EVENTS;
  if (
    !Number.isSafeInteger(eventThreshold) ||
    eventThreshold < 16 ||
    eventThreshold > SAGA_HISTORY_EVENTS
  ) {
    throw ApplicationFailure.nonRetryable('Invalid saga history threshold', 'SAGA_INCONSISTENT');
  }
  function activities(options: ActivityOptions, legacy: OrderActivities): OrderActivities {
    return new Proxy(legacy, {
      get(target, property: string) {
        return (...args: unknown[]): Promise<unknown> => {
          // Checking again permits a pre-change run to adopt the patch once
          // replay reaches new work, without changing historical commands.
          durable = patched(ROLLOVER_PATCH) || durable;
          if (!durable) {
            const original = Reflect.get(target, property) as (
              ...values: unknown[]
            ) => Promise<unknown>;
            return original(...args);
          }
          if (!Number.isSafeInteger(activitySequence + 1)) {
            throw ApplicationFailure.nonRetryable(
              'Saga activity sequence exhausted',
              'SAGA_INCONSISTENT',
            );
          }
          activitySequence += 1;
          const scheduled = proxyActivities<
            Record<string, (...values: unknown[]) => Promise<unknown>>
          >({
            ...options,
            heartbeatTimeout: '10 seconds',
            activityId: `saga-step-${activitySequence}`,
          });
          return scheduled[property](...args);
        };
      },
    });
  }
  const {
    createObligation,
    authoriseSettlement,
    settle,
    compensate,
    disputeObligation,
    resolveObligationDispute,
    findObligation: askEconomic,
  } = activities(ECONOMIC_OPTIONS, legacyEconomic);
  const {
    readOrder,
    findObligation,
    markFundsHeld,
    markFailed,
    markSettling,
    markSettlementFailed,
    markObligationDisputed,
    markCompleted,
    markCancelled,
    recordReminder,
    noteReleaseUnconfirmed,
    noteEconomicCallUnconfirmed,
  } = activities(LOCAL_OPTIONS, legacyLocal);

  const status: SagaStatus = input.resume?.status ?? {
    phase: 'PLACING',
    deferredSteps: ['RESERVE_STOCK', 'NOTIFY_SUPPLIER'],
    remindersRecorded: 0,
    settlementAttempts: 0,
  };

  // Every signal means the same thing: something committed, look now. What
  // it names, and whatever it carries, is not trusted — the order is.
  let nudged = false;
  const look = (): void => {
    nudged = true;
  };
  setHandler(orderSagaStatus, () => status);
  setHandler(orderConfirmed, look);
  setHandler(orderFulfilled, look);
  setHandler(receiptConfirmed, look);
  setHandler(orderDisputed, look);
  setHandler(orderCancelled, look);
  setHandler(disputeResolved, look);
  let retryNudged = false;
  setHandler(retryDisputeRelease, () => {
    retryNudged = true;
  });

  // When each windowed wait is next due a reminder, in workflow time — kept
  // when the order leaves that status for a dispute, so a resumed order waits
  // out what remained of its window rather than a new one (D-083). A rollover
  // carries them on.
  const reminderDue = new Map<OrderStatus, number>(input.resume?.reminderDue);
  if (input.resume?.nextReminderAt !== undefined) {
    reminderDue.set(input.resume.waitingIn, input.resume.nextReminderAt);
  }

  // The dispute economic-service has been told about and not yet told is
  // resolved. An id, not a flag: a second dispute on the same order is a
  // different dispute, and is mirrored under its own key.
  let mirroredDispute: string | undefined = input.resume?.mirroredDispute;
  // economic-service's identity of that same dispute, when it gave one. The
  // resolution names it, so it decides that dispute and not one raised there
  // since (Codex on #318 round 2, N1). Undefined for a dispute mirrored by a
  // step recorded before economic-service had identities: resolved unnamed.
  let mirroredEconomicDispute: string | undefined = input.resume?.mirroredEconomicDispute;
  let releaseRounds = input.resume?.releaseRounds ?? 0;
  let unconfirmed: UnconfirmedCall | undefined = input.resume?.unconfirmedCall;
  let sibling: UnconfirmedSibling | undefined = input.resume?.siblingCall;
  let outstanding: OutstandingWork | undefined = input.resume?.outstandingWork;
  // Proof that no hold of this saga is on its way. A run continued without it knows nothing.
  let noHold = !input.resume || outstanding?.noHold === true;
  // The last status read. Past the first read, the saga may be all that can still refund.
  let lastRead = input.resume?.waitingIn;
  const readWork = { operation: 'readOrder' as const, rounds: 0 };
  // In memory, and asked where it is used: a settlement that failed in a history
  // without the marker is in doubt too, once the saga is live.
  let settleFailed = false;

  /** From here on the work is owed, across a rollover too, and every later call is in doubt. */
  const owe = (operation: UnconfirmedOperation): OutstandingWork => {
    outstanding = { operation, rounds: outstanding?.rounds ?? 0, noHold };
    return outstanding;
  };

  /**
   * Declares that this workflow reads `ObligationFinal`. Asked as the last thing before
   * scheduling: the marker commits in the same task as the command, so no such answer
   * exists for a workflow a build below protocol 6 could still pick up. Replaying a
   * history without the marker, it declares nothing, and nothing compares the arguments.
   */
  const finalAnswers = (): typeof FINAL_ANSWER_CONTRACT | undefined =>
    patched(OWED_WORK_PATCH) ? FINAL_ANSWER_CONTRACT : undefined;

  /** What is owed so far, a failed settlement included. */
  const owedSoFar = (): OutstandingWork | undefined => {
    if (settleFailed && !outstanding && patched(OWED_WORK_PATCH)) owe('settle');
    return outstanding;
  };

  /** The part of a wait that says which work it is for. */
  const waitOn = (work: { operation: UnconfirmedOperation; rounds: number }) => ({
    phase: UNCONFIRMED_PHASE[work.operation],
    at: UNCONFIRMED_AT[work.operation],
    report: (round: number, failure: string) =>
      noteEconomicCallUnconfirmed(orderId, work.operation, round, failure),
    nextRound: () => (work.rounds += 1),
  });

  /** That part of a wait for the financial work still owed, if any. */
  const owedWork = () => {
    const call = sibling ?? unconfirmed ?? owedSoFar();
    if (call) return waitOn(call);
    if (mirroredDispute !== undefined) {
      return {
        phase: 'RELEASE_UNCONFIRMED',
        at: 'DISPUTED' as OrderStatus,
        report: (round: number, failure: string) => noteReleaseUnconfirmed(orderId, round, failure),
        nextRound: () => (releaseRounds += 1),
      };
    }
    return lastRead && { ...waitOn(readWork), at: lastRead };
  };

  /** What a rollover hands to the next run. */
  const resumeFrom = (waitingIn: OrderStatus, nextReminderAt?: number): SagaResume => ({
    status,
    mirroredDispute,
    mirroredEconomicDispute,
    waitingIn,
    nextReminderAt,
    reminderDue: [...reminderDue],
    activitySequence,
    ...(releaseRounds > 0 ? { releaseRounds } : {}),
    ...(unconfirmed ? { unconfirmedCall: unconfirmed } : {}),
    ...(sibling ? { siblingCall: sibling } : {}),
    ...(owedSoFar() ? { outstandingWork: outstanding } : {}),
  });

  /** The order now, with the mirrored dispute's resolution when there is one. */
  const readOnce = (): Promise<SagaOrderView> =>
    mirroredDispute === undefined ? readOrder(orderId) : readOrder(orderId, mirroredDispute);

  /** The same, except that a read refused with work owed says nothing of that work. */
  async function read(): Promise<SagaOrderView> {
    try {
      const order = await readOnce();
      lastRead = order.status;
      return order;
    } catch (error) {
      const owed = owedWork();
      if (!owed || !releaseCanWait(error)) throw error;
      // A call's own wait did this before the marker; the rest of the work did not.
      if (!sibling && !unconfirmed && !patched(OWED_WORK_PATCH)) throw error;
      return waitForConfirmation(
        { ...owed, call: readOnce, canWait: releaseCanWait },
        failureOf(error),
      );
    }
  }

  /**
   * A local step the money already depends on. Refused, it waits and asks again, or
   * the order would stay wrong with nothing left to correct it. The next run after a
   * rollover reaches the step again from the order.
   */
  async function recorded<T>(
    operation: 'settle' | 'compensate',
    step: string,
    call: () => Promise<T>,
  ): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (!releaseCanWait(error) || !patched(OWED_WORK_PATCH)) throw error;
      return waitForConfirmation(
        {
          ...waitOn(owe(operation)),
          phase: operation === 'settle' ? 'SETTLEMENT_NOT_RECORDED' : 'CANCELLATION_NOT_RECORDED',
          call,
          canWait: releaseCanWait,
        },
        `${step}: ${failureOf(error)}`,
      );
    }
  }

  /**
   * The owner says the obligation is final, and the order cannot follow: a person
   * reconciles the two. The saga stays, the alert on, until the order is no longer
   * `stillThere`; it never finishes the order itself. The next run gets here again by
   * asking the owner.
   */
  async function staysForReconciliation(
    operation: UnconfirmedOperation,
    owner: ObligationFinal,
    stillThere: (order: SagaOrderView) => boolean,
  ): Promise<void> {
    const code = 'OBLIGATION_ALREADY_FINAL';
    const words = `The obligation is ${owner.status} (funds ${owner.funds}) and the order cannot follow it`;
    // Only a build with this marker gets such an answer to act on.
    if (!patched(OWED_WORK_PATCH)) throw ApplicationFailure.nonRetryable(words, code);
    await waitForConfirmation(
      {
        ...waitOn(owe(operation)),
        phase: 'OBLIGATION_RECONCILIATION',
        call: async () => {
          nudged = false;
          if (stillThere(await readOnce())) throw ApplicationFailure.nonRetryable(words, code);
        },
        canWait: (error) =>
          releaseCanWait(error) || (error instanceof ApplicationFailure && error.type === code),
        wakes: () => nudged,
      },
      `${code}: ${words}`,
    );
  }

  /**
   * Tells economic-service that the dispute it holds is decided, with that
   * dispute's own resolution — read by its id, since a party may have raised
   * the next one before the saga looked.
   *
   * `true` when it had to wait for the release (`waitForConfirmation`): `order` is
   * then old news, and a caller about to act on it reads the order again.
   */
  async function mirrorResolution(order: SagaOrderView, fallback: string): Promise<boolean> {
    if (!mirroredDispute) return false;
    // A read recorded before `mirroredDispute` was part of it has only the
    // most recent dispute, which then was this one.
    const resolution = order.mirroredDispute?.resolution ?? order.dispute?.resolution ?? fallback;
    const transactionId = heldTransaction(order);
    const disputeId = mirroredDispute;
    const economicDisputeId = mirroredEconomicDispute;
    const release = (): Promise<unknown> =>
      resolveObligationDispute(
        orderId,
        transactionId,
        disputeId,
        resolution,
        economicDisputeId,
        finalAnswers(),
      );
    let waited = false;
    try {
      await release();
    } catch (error) {
      if (!releaseCanWait(error) || !patched(RELEASE_WAIT_PATCH)) throw error;
      await waitForConfirmation(
        {
          phase: 'RELEASE_UNCONFIRMED',
          at: order.status,
          call: release,
          // A refusal waits like an outage: the release is no more confirmed,
          // and a person has to see it.
          canWait: releaseCanWait,
          report: (round, failure) => noteReleaseUnconfirmed(orderId, round, failure),
          nextRound: () => (releaseRounds += 1),
        },
        failureOf(error),
      );
      waited = true;
    }
    mirroredDispute = undefined;
    mirroredEconomicDispute = undefined;
    releaseRounds = 0;
    return waited;
  }

  /**
   * Holds the saga until economic-service confirms a call — the one wait of
   * every economic call that waits. Every round sends the same words under the
   * same idempotency key (`idempotencyKeyFor`), so a call that did commit is
   * answered, not repeated — past the key's expiry, from the obligation itself
   * (`economicStep`). Nothing else runs meanwhile; the caller decides from a
   * fresh read afterwards.
   *
   * The history stays bounded by rolling over, and the next run starts by
   * calling again.
   */
  async function waitForConfirmation<T>(
    wait: {
      phase: string;
      at: OrderStatus;
      call: () => Promise<T>;
      canWait: (error: unknown) => boolean;
      report: (round: number, failure: string) => Promise<void>;
      nextRound: () => number;
      /** What else ends a backoff early. */
      wakes?: () => boolean;
    },
    firstFailure: string,
  ): Promise<T> {
    const phase = status.phase;
    status.phase = wait.phase;
    let failure = firstFailure;
    let backedOff = false;
    for (;;) {
      const round = wait.nextRound();
      await wait.report(round, failure);
      // Not before this run's first backoff: the next run starts by calling, so
      // runs started past the threshold would otherwise call with none at all.
      if (backedOff && shouldRollSaga(workflowInfo(), eventThreshold)) {
        await continueAsNew<typeof orderSaga>({ ...input, resume: resumeFrom(wait.at) });
      }
      const backoffMs = releaseBackoffMs(round);
      await condition(() => retryNudged || (wait.wakes?.() ?? false), backoffMs);
      backedOff = true;
      // Cleared before the call: a signal during it may be about a fix the call
      // did not see, and it must wake the next wait rather than be swallowed.
      retryNudged = false;
      try {
        const answer = await wait.call();
        status.phase = phase;
        return answer;
      } catch (error) {
        if (!wait.canWait(error)) {
          status.phase = phase;
          throw error;
        }
        failure = failureOf(error);
      }
    }
  }

  /**
   * An economic call that ends the saga only on proof it changed nothing
   * (`outcomeUnknown`); on anything else it waits for confirmation. `later` is
   * what each round sends, for a call that may no longer be wanted by then. A
   * call answered first time adds no command of its own. `unconfirmed` stays set on the way
   * out: the caller knows whether what came back was an answer about the call.
   */
  async function confirmedCall<T>(
    operation: UnconfirmedOperation,
    at: OrderStatus,
    call: () => Promise<T>,
    later: () => Promise<T>,
    wakes: () => boolean,
  ): Promise<T> {
    // Read at each failure: the first one may be what puts the call in doubt.
    const canWait = (error: unknown): boolean =>
      outcomeUnknown(error, unconfirmed !== undefined || owedSoFar() !== undefined);
    try {
      return await call();
    } catch (error) {
      if (!canWait(error) || !patched(ECONOMIC_WAIT_PATCH)) throw error;
      const pending: UnconfirmedCall = { operation, rounds: unconfirmed?.rounds ?? 0 };
      unconfirmed = pending;
      return await waitForConfirmation(
        {
          phase: UNCONFIRMED_PHASE[operation],
          at,
          call: later,
          canWait,
          wakes,
          report: (round, failure) =>
            noteEconomicCallUnconfirmed(orderId, operation, round, failure),
          nextRound: () => (pending.rounds += 1),
        },
        failureOf(error),
      );
    }
  }

  /**
   * A call the saga stays on until it is answered, whatever the order has become:
   * nothing goes on until economic-service answers it. An unconfirmed
   * authorisation the saga moved on from counts as doubt here too, so a code alone
   * does not end the saga on the way. `waited` tells the caller its order is old
   * news. A call answered first time adds no command of its own.
   */
  async function siblingCall<T>(
    carried: Omit<UnconfirmedSibling, 'rounds'>,
    call: (inDoubt: boolean) => Promise<T>,
  ): Promise<{ answer: T; waited: boolean }> {
    const inDoubt = (): boolean =>
      unconfirmed !== undefined || sibling !== undefined || owedSoFar() !== undefined;
    const canWait = (error: unknown): boolean => outcomeUnknown(error, inDoubt());
    let answer: T;
    let waited = false;
    try {
      answer = await call(inDoubt());
    } catch (error) {
      if (!canWait(error) || !patched(SIBLING_WAIT_PATCH)) throw error;
      const pending: UnconfirmedSibling = sibling ?? { ...carried, rounds: 0 };
      sibling = pending;
      answer = await waitForConfirmation(
        {
          phase: UNCONFIRMED_PHASE[pending.operation],
          at: UNCONFIRMED_AT[pending.operation],
          call: () => call(true),
          canWait,
          report: (round, failure) =>
            noteEconomicCallUnconfirmed(orderId, pending.operation, round, failure),
          nextRound: () => (pending.rounds += 1),
        },
        failureOf(error),
      );
      waited = true;
    }
    sibling = undefined;
    return { answer, waited };
  }

  /**
   * economic-service is told too, so a direct settlement command there is refused
   * independently of anything this service does (ADR-040 § 5). Sent until answered
   * even if the order has moved on: filed unseen, the obligation would stay DISPUTED
   * with nothing to release it, so the saga has to know it and mirror the decision.
   * `waited` as `siblingCall` says. `final` when the owner's obligation can no longer
   * be disputed: nothing is mirrored, as there is nothing to release.
   */
  async function fileDispute(
    transactionId: string,
    disputeId: string,
    reason: string,
  ): Promise<{ waited: boolean; final?: ObligationFinal }> {
    const { answer, waited } = await siblingCall(
      { operation: 'disputeObligation', transactionId, disputeId, reason },
      (inDoubt) =>
        disputeObligation(orderId, transactionId, disputeId, reason, inDoubt, finalAnswers()),
    );
    if (isFinal(answer)) return { waited, final: answer };
    mirroredDispute = disputeId;
    // Null from an economic-service without identities; undefined from a step
    // recorded before this one answered with it.
    mirroredEconomicDispute = answer ?? undefined;
    return { waited };
  }

  /**
   * An order an operator's SETTLE returned to a status before receipt (D-083):
   * economic-service is told the dispute it holds is decided before the saga
   * waits there again, which returns the obligation to HELD — never to the
   * settlement queue, since nothing has authorised it. Without it the
   * obligation would stay DISPUTED while the order went on, and the buyer's
   * next dispute or cancellation would find the two services disagreeing.
   *
   * Nothing when no dispute is mirrored: an order never disputed, or one whose
   * dispute was raised and decided before the saga looked, which
   * economic-service never heard of.
   *
   * Behind `DISPUTE_RESUME_PATCH`, because a worker of the previous release
   * can meet a resumed order too: during a rollout a new API pod resumes it
   * while an old worker runs its next task, and that history waits at the
   * pre-receipt status with no call here. Replayed by this code, the call must
   * not appear — so where the history has no marker, the saga skips it while
   * it replays. The wait it then enters asks again at every wake-up
   * (`waitWhile`): the first one past the replay releases the dispute, before
   * any authorisation. `workflows.replay.spec.ts` replays such a history;
   * `workflows.spec.ts` replays one and then goes on live.
   */
  async function mirrorResumed(order: SagaOrderView): Promise<boolean> {
    if (mirroredDispute === undefined || !patched(DISPUTE_RESUME_PATCH)) return false;
    // Time passed in a release wait: `order` is old news, so the next wait looks at once.
    const waited = await mirrorResolution(order, 'Dispute resolved: SETTLE');
    if (waited) nudged = true;
    return waited;
  }

  /**
   * The order takes the dispute economic-service holds (D-053). The dispute
   * it files counts as mirrored at once: economic-service told the saga about
   * it, not the other way round. Named here rather than when the saga next
   * reads the order DISPUTED, because an operator may decide it before that
   * read, and the saga must still mirror that decision back (Codex on #318
   * round 1, finding 1). Unnamed, the saga read RECEIPT_CONFIRMED, found the
   * obligation still DISPUTED, and filed a second dispute over it.
   *
   * The step records economic-service's identity of the dispute beside the
   * order's, and the decision is mirrored naming it: if that dispute was
   * resolved there and another raised before the step ran, the order took
   * stale words, and economic-service refuses to let a decision about them
   * clear the new one (Codex on #318 round 2, N1).
   */
  async function takeObligationDispute(obligation: DisputedObligation): Promise<void> {
    const taken = await recorded('settle', 'markObligationDisputed', () =>
      markObligationDisputed(orderId, obligation.reason, obligation.economicDisputeId ?? null),
    );
    if (taken.disputeId) {
      mirroredDispute = taken.disputeId;
      // Absent from a step recorded before the identity existed.
      mirroredEconomicDispute = taken.economicDisputeId ?? undefined;
    }
  }

  /**
   * Waits for the order to leave `waitingIn`, re-reading it on every signal
   * and at least every `recheckMs`.
   *
   * With a `window`, a reminder is recorded each time the window elapses
   * (ADR-043): the window decides when to *notice*, never what to *do*.
   */
  async function waitWhile(
    waitingIn: OrderStatus,
    window?: { firstDays: number; thenDays: number },
    /**
     * For the dispute wait: the dispute it waits on. Past the marker, the wait
     * ends when the order holds another — one settled back and raised again
     * before the saga looked (D-083) — so that one is mirrored too.
     */
    disputeId?: string,
  ): Promise<SagaOrderView> {
    let windowElapsed = false;
    // The deadline a rollover hands to the next run (`SagaResume`).
    let nextReminderAt =
      input.resume?.waitingIn === waitingIn ? input.resume.nextReminderAt : undefined;
    let windowScope: CancellationScope | undefined;
    const sleepFor = (ms: number): void => {
      const scope = new CancellationScope();
      windowScope = scope;
      scope
        .run(() => sleep(ms))
        .then(
          () => {
            windowElapsed = true;
          },
          (error: unknown) => {
            if (!isCancellation(error)) throw error;
          },
        );
    };
    // Since D-083 a window is a deadline, kept across a dispute; a history
    // recorded before the change replays the old timers (`armWindow`).
    const keepsDeadlines = window !== undefined && patched(DISPUTE_RESUME_PATCH);
    const armWindow = (days: number, resumeAt?: number): void => {
      if (!keepsDeadlines) {
        // new Date is Temporal's deterministic workflow clock; no host clock I/O.
        nextReminderAt = resumeAt ?? new Date().getTime() + days * DAY;
        // Memory only, so no command changes: a dispute after the replay ends
        // resumes to this deadline, not to a fresh window or a passed one.
        reminderDue.set(waitingIn, nextReminderAt);
        sleepFor(durable ? Math.max(0, nextReminderAt - new Date().getTime()) : days * DAY);
        return;
      }
      armUntil(Date.now() + days * DAY);
    };
    const armUntil = (dueAt: number): void => {
      nextReminderAt = dueAt;
      reminderDue.set(waitingIn, dueAt);
      const remaining = dueAt - Date.now();
      // Due while the order was disputed: the reminder is recorded at the
      // first look, not after another full window.
      if (remaining <= 0) windowElapsed = true;
      else sleepFor(remaining);
    };

    if (window) {
      const due = keepsDeadlines ? reminderDue.get(waitingIn) : undefined;
      if (due === undefined) armWindow(window.firstDays, nextReminderAt);
      else armUntil(due);
    }
    try {
      for (;;) {
        if (patched(ROLLOVER_PATCH)) {
          const info = workflowInfo();
          if (shouldRollSaga(info, eventThreshold)) {
            // No activity or async signal handler is in flight here. Financial
            // effects are already recorded by their owner before this checkpoint.
            await continueAsNew<typeof orderSaga>({
              ...input,
              resume: resumeFrom(waitingIn, nextReminderAt),
            });
          }
        }
        await condition(() => nudged || windowElapsed, recheckMs);
        // Cleared before the read, not after: a signal that arrives while the
        // read is in flight may be about a commit the read did not see, and it
        // must wake the next wait rather than be swallowed.
        nudged = false;
        const order = await read();
        if (order.status !== waitingIn) return order;
        // Decided again at every wake-up, not once on entry: a wait entered
        // while replaying a history recorded without the marker answers
        // `false` only while it replays, and must not carry the old behaviour
        // into live execution (review of #625 round 1, R1). Replayed, each
        // call answers `false` again and adds no command.
        if (waitingIn === 'DISPUTED') {
          if (order.dispute?.id !== disputeId && patched(DISPUTE_RESUME_PATCH)) return order;
        } else if (await mirrorResumed(order)) {
          continue;
        }

        if (window && windowElapsed) {
          windowElapsed = false;
          try {
            await recordReminder(orderId);
            status.remindersRecorded += 1;
          } catch (error) {
            const owed = owedWork();
            if (!owed || !releaseCanWait(error) || !patched(OWED_WORK_PATCH)) throw error;
            // A reminder moves no money, so it holds nothing up: the next window records one.
            await owed.report(owed.nextRound(), `recordReminder: ${failureOf(error)}`);
          }
          armWindow(window.thenDays);
        }
      }
    } finally {
      windowScope?.cancel();
    }
  }

  /**
   * Places the hold, and establishes whether it happened when the call cannot
   * say.
   *
   * A timeout, a lost response or an exhausted retry does not mean nothing
   * moved: economic-service may have committed the hold. Only
   * economic-service knows, and it keeps at most one obligation per order, so
   * the saga asks before concluding anything. This is the difference between
   * an order recorded `FAILED` with its buyer's money held and nothing to
   * release it, and an order that carries on.
   */
  async function placeHold(): Promise<
    { held: true; transactionId: string } | { held: false; reason: string }
  > {
    try {
      const held = await createObligation(orderId);
      return { held: true, transactionId: held.transactionId };
    } catch (error) {
      // Unanswered, a late request can still commit. Closing that gap is `placeHold`'s
      // own wait (#812); until then only a run continued from here refuses the empty lookup.
      if (outcomeUnknown(error, false)) noHold = false;
      const found = await findOwnObligation();
      if (found) return { held: true, transactionId: found };
      return { held: false, reason: describe(error) };
    }
  }

  /**
   * The order's obligation as economic-service holds it, or null if it holds
   * none — adopted only on the terms the saga records it with.
   *
   * A transaction naming this order on any other terms is somebody else's
   * (review of #334 round 1, F1). The saga stops: it adopts nothing, records
   * nothing on the order, authorises, settles and refunds nothing, and
   * whatever is held stays held for a person — failing the order or
   * refunding instead would be deciding about money it cannot account for.
   *
   * The order's own obligation in any status but HELD is not adopted either
   * (review of #334 round 2, F1): the saga stops the same way, naming the
   * status and what it says of the funds — returned, paid out, never held,
   * or not proven held — so a person decides from that, not from a
   * FUNDS_HELD the order would otherwise have recorded.
   */
  async function findOwnObligation(): Promise<string | null> {
    const found = await findObligation(orderId);
    if (found && 'notHeld' in found) {
      status.phase = 'OBLIGATION_NOT_HELD';
      throw ApplicationFailure.nonRetryable(
        `economic-service holds order ${orderId}'s obligation as ${found.status}, which does not ` +
          `prove its funds are held (funds ${found.funds}); it is not adopted, and nothing is ` +
          'recorded on the order',
        'OBLIGATION_NOT_HELD',
        { transactionId: found.transactionId, status: found.status, funds: found.funds },
      );
    }
    if (found && 'mismatch' in found) {
      status.phase = 'OBLIGATION_MISMATCH';
      throw ApplicationFailure.nonRetryable(
        `economic-service holds a transaction for order ${orderId} on terms the order did not set ` +
          `(${found.differ.join(', ')}); it is not adopted, and funds remain held for a human decision`,
        'OBLIGATION_TERMS_MISMATCH',
        found.transactionIds,
      );
    }
    return found?.transactionId ?? null;
  }

  /**
   * The transaction a cancelled order with none recorded must refund; null when there
   * is nothing to refund. Refused, unreadable, or naming an obligation the saga cannot
   * act on, it stays and asks again. Only money back with the buyer or never held
   * closes the order unrefunded, and an empty lookup only with no hold of this saga on
   * its way (`noHold`).
   */
  async function obligationToRefund(): Promise<string | null> {
    const ask = async (): Promise<string | null> => {
      const found = await findOwnObligation();
      if (found === null && input.resume && !noHold && patched(OWED_WORK_PATCH)) {
        throw ApplicationFailure.nonRetryable(
          `An empty lookup does not show that a hold of order ${orderId} will not commit`,
          'OBLIGATION_LOOKUP_UNPROVEN',
        );
      }
      return found;
    };
    try {
      return await ask();
    } catch (error) {
      if (!lookupCanWait(error) || !patched(OWED_WORK_PATCH)) throw error;
      if (ownerHoldsNothing(error)) return null;
      return await waitForConfirmation(
        {
          ...waitOn(owe('compensate')),
          phase: status.phase === 'COMPENSATING' ? UNCONFIRMED_PHASE.compensate : status.phase,
          call: () =>
            ask().catch((failure: unknown) => {
              if (ownerHoldsNothing(failure)) return null;
              throw failure;
            }),
          canWait: lookupCanWait,
        },
        failureOf(error),
      );
    }
  }

  /**
   * Settles an order whose receipt is confirmed. `true` once `COMPLETED`;
   * `false` when a dispute got in first and the order must be read again.
   */
  async function settleOrder(transactionId: string): Promise<boolean> {
    status.phase = 'SETTLING';
    const attemptFailed = (): Promise<OrderStatus> =>
      recorded('settle', 'markSettlementFailed', () => markSettlementFailed(orderId));
    // Disputed in economic-service after the saga's own authorisation, and
    // found so by a retry once the stored answer had expired: the order takes
    // the dispute and the saga reads it again (D-053). An activity recorded
    // before this answer existed returns undefined — authorised.
    //
    // Unconfirmed, each round reads the order first, which saves the activity's
    // work: the activity decides whether anything is sent (D-138). A dispute seen
    // by this read still does not move the saga until economic-service answers,
    // here to a read: from
    // that answer on it can dispute or refund the obligation authorised or not,
    // and a dispute settled back brings the saga here again, under the same key.
    const send = (): Promise<AuthorisationResult> =>
      authoriseSettlement(orderId, transactionId, owedSoFar() !== undefined, finalAnswers());
    const askAgain = async (): Promise<AuthorisationResult | 'MOVED'> => {
      nudged = false;
      const now = await readOnce();
      if (now.status === 'RECEIPT_CONFIRMED' || now.status === 'SETTLING') {
        return authoriseSettlement(orderId, transactionId, true, finalAnswers());
      }
      await askEconomic(orderId);
      return 'MOVED';
    };
    const authorisation = await confirmedCall<AuthorisationResult | 'MOVED'>(
      'authoriseSettlement',
      'RECEIPT_CONFIRMED',
      unconfirmed ? askAgain : send,
      askAgain,
      // A dispute is filed as soon as it is raised, not at the next backoff.
      () => nudged,
    );
    if (authorisation === 'MOVED') {
      // Not an answer about the call: the doubt goes with the saga.
      if (unconfirmed) unconfirmed.movedOn = true;
      return false;
    }
    if (authorisation && 'fenced' in authorisation && patched(AUTHORISATION_FENCE_PATCH)) {
      // Nothing was sent. The activity has already asked economic-service if an
      // earlier attempt may have, and any doubt goes with the saga: when the order
      // comes back here, the next send goes out as a later round.
      if (authorisation.inDoubt) unconfirmed ??= { operation: 'authoriseSettlement', rounds: 0 };
      if (unconfirmed) unconfirmed.movedOn = true;
      return false;
    }
    unconfirmed = undefined;
    if (isFinal(authorisation)) {
      await staysForReconciliation(
        'authoriseSettlement',
        authorisation,
        (now) => now.status === 'RECEIPT_CONFIRMED' || now.status === 'SETTLING',
      );
      return false;
    }
    if (authorisation && 'disputed' in authorisation) {
      await takeObligationDispute(authorisation);
      return false;
    }

    for (let attempt = 1; attempt <= SETTLEMENT_ATTEMPTS; attempt += 1) {
      status.settlementAttempts = attempt;

      // A dispute can commit between the read that brought the saga here and
      // this call. It yields instead of being refused, and the saga goes back
      // to the dispute. A refused `markSettling` used to count as a failed
      // settlement attempt, and `markSettlementFailed` then moved the order
      // `DISPUTED -> RECEIPT_CONFIRMED` — erasing the dispute.
      const moved = await recorded('settle', 'markSettling', () => markSettling(orderId));
      if (moved !== 'SETTLING') return false;

      let settled: SettledResult | DisputedObligation;
      try {
        settled = await settle(orderId, transactionId);
      } catch (error) {
        // Nothing says this attempt did not commit, or will not: whatever the saga
        // sends next, a filing or a refund, goes as in doubt.
        settleFailed = true;
        await attemptFailed();
        if (attempt === SETTLEMENT_ATTEMPTS) {
          // CONSTRAINT (`docs/08` § 8.4): no automatic financial compensation
          // after this point. The funds stay held and a human decides. Undoing
          // a payment the platform is not sure failed is a larger risk than
          // the failure itself.
          status.phase = 'SETTLEMENT_EXHAUSTED';
          throw ApplicationFailure.nonRetryable(
            'Settlement did not succeed and needs a human decision; funds remain held',
            'SETTLEMENT_EXHAUSTED',
            describe(error),
          );
        }
        // Deterministic backoff between attempts, from Temporal's own clock.
        // The key is the same on every attempt, so an attempt whose reply was
        // lost is answered on the next one by economic-service's replay.
        await sleep(`${attempt * 30} seconds`);
        continue;
      }

      if ('disputed' in settled) {
        // Disputed in economic-service since it was authorised (D-053). No
        // attempt can settle it until an operator decides: this one ends, and
        // the order takes the dispute instead of the next attempt.
        await attemptFailed();
        await takeObligationDispute(settled);
        return false;
      }
      const settlement = settled;

      // The money has moved. Recording it is not part of the settlement and
      // cannot fail it: it shared a `catch` with `settle()` once, and a local
      // write failing after a successful settlement recorded the order as a
      // failed settlement with "funds remain held".
      try {
        await recorded('settle', 'markCompleted', () => markCompleted(orderId, settlement));
      } catch (error) {
        // The wait's own rollover, or a cancellation: not the step's failure.
        if (!(error instanceof ActivityFailure)) throw error;
        status.phase = 'SETTLED_NOT_RECORDED';
        throw ApplicationFailure.nonRetryable(
          `Settlement ${settlement.settlementId} succeeded but the order could not record it`,
          'SETTLED_NOT_RECORDED',
          describe(error),
        );
      }
      status.phase = 'COMPLETED';
      return true;
    }
    return false;
  }

  // ---- 1. The obligation and the escrow, in one call ----------------------
  //
  // Not two: creating the obligation and holding the money separately leaves a
  // window in which the buyer can spend what they have just committed.
  // A filing the last run could not confirm comes first, whatever the order has
  // become since: the read below already depends on what it mirrors.
  if (sibling?.operation === 'disputeObligation') {
    await fileDispute(
      sibling.transactionId as string,
      sibling.disputeId as string,
      sibling.reason as string,
    );
  }

  let order = await read();
  if (input.resume && order.status === 'PENDING') {
    throw ApplicationFailure.nonRetryable(
      'A resumed saga cannot repeat initial hold placement',
      'SAGA_INCONSISTENT',
    );
  }

  if (order.status === 'PENDING') {
    status.phase = 'CREATING_OBLIGATION';
    const hold = await placeHold();

    if (!hold.held) {
      // economic-service holds nothing for this order. The order failed —
      // unless the buyer cancelled first, in which case it was cancelled, and
      // with nothing held there is nothing to refund.
      status.phase = 'FAILED';
      if ((await markFailed(orderId, hold.reason)) === 'FAILED') return 'FAILED';
    } else {
      // The hold is recorded on the order whatever else has happened. If the
      // buyer cancelled while it was being placed, this returns CANCELLING
      // and the loop below refunds it.
      await markFundsHeld(orderId, hold.transactionId);
    }
    order = await read();
  }

  // A run that rolled over in the wait goes back to it before following the
  // order, whatever the order has become since.
  if (unconfirmed && !unconfirmed.movedOn) {
    if (await settleOrder(heldTransaction(order))) return 'COMPLETED';
    order = await read();
  }

  // ---- 2. Follow the order until it ends ----------------------------------
  for (;;) {
    switch (order.status) {
      case 'FUNDS_HELD':
        status.phase = 'AWAITING_CONFIRMATION';
        await mirrorResumed(order);
        order = await waitWhile('FUNDS_HELD', {
          firstDays: input.fulfillmentWindowDays,
          thenDays: input.reminderIntervalDays,
        });
        break;

      case 'CONFIRMED':
        status.phase = 'AWAITING_FULFILMENT';
        await mirrorResumed(order);
        order = await waitWhile('CONFIRMED', {
          firstDays: input.fulfillmentWindowDays,
          thenDays: input.reminderIntervalDays,
        });
        break;

      // The wait that has no timeout. Expiry records a reminder and waits again.
      case 'AWAITING_RECEIPT_CONFIRMATION':
        status.phase = 'AWAITING_RECEIPT_CONFIRMATION';
        await mirrorResumed(order);
        order = await waitWhile('AWAITING_RECEIPT_CONFIRMATION', {
          firstDays: input.receiptWindowDays,
          thenDays: input.reminderIntervalDays,
        });
        break;

      // A dispute stops everything until somebody decides.
      case 'DISPUTED':
        status.phase = 'DISPUTED';
        if (!order.dispute) {
          // raiseDispute writes the row in the same transaction as the status.
          throw ApplicationFailure.nonRetryable(
            `Order ${orderId} is DISPUTED with no dispute recorded`,
            'SAGA_INCONSISTENT',
          );
        }
        if (mirroredDispute !== order.dispute.id) {
          // The dispute economic-service holds was decided and a party raised
          // this one before the saga looked: economic-service hears of the
          // decision first, or it would refuse this dispute as already there.
          if (await mirrorResolution(order, 'Dispute resolved: SETTLE')) {
            order = await read();
            break;
          }
          const disputeId = order.dispute.id;
          const filed = await fileDispute(heldTransaction(order), disputeId, order.dispute.reason);
          if (filed.waited || filed.final) {
            order = await read();
            // The decision is still the operator's, whose REFUND or SETTLE this answers.
            if (filed.final && order.status === 'DISPUTED' && order.dispute?.id === disputeId) {
              await staysForReconciliation(
                'disputeObligation',
                filed.final,
                (now) => now.status === 'DISPUTED' && now.dispute?.id === disputeId,
              );
              order = await read();
            }
            break;
          }
        }
        // No window. A dispute that expired into anything would be worse than
        // one that waits: money would move because nobody looked. Since D-083
        // a dispute settled back before receipt can be raised again before the
        // saga looks, with the order DISPUTED throughout: the wait ends on a
        // new dispute too, and this case mirrors the decision and then it. A
        // history recorded before the change kept waiting there; it replays
        // the same way, and the wait decides at each wake-up (`waitWhile`).
        order = await waitWhile('DISPUTED', undefined, order.dispute.id);
        break;

      case 'RECEIPT_CONFIRMED':
      case 'SETTLING':
        // The resolution is mirrored back, or economic-service would still
        // refuse to settle a transaction it believes is disputed.
        if (await mirrorResolution(order, 'Dispute resolved: SETTLE')) {
          order = await read();
          break;
        }
        if (await settleOrder(heldTransaction(order))) return 'COMPLETED';
        order = await read();
        break;

      // ---- Compensation ---------------------------------------------------
      case 'CANCELLING': {
        if (await mirrorResolution(order, 'Dispute resolved: REFUND')) {
          order = await read();
          break;
        }
        status.phase = 'COMPENSATING';
        const reason = order.cancellationReason ?? 'Cancelled';
        // An order cancelled before its hold was recorded may still have one:
        // economic-service is asked rather than assumed, as in step 1.
        // Refunded unconfirmed and rolled over, the lookup would find it REFUNDED
        // and stop: the next run keeps the transaction it was refunding.
        const carried = sibling?.operation === 'compensate' ? sibling.transactionId : undefined;
        const transactionId =
          order.economicTransactionId ?? carried ?? (await obligationToRefund());
        // Nothing moves a CANCELLING order but this saga (`ORDER_TRANSITIONS`), so
        // the refund does not stop being wanted, and `markCancelled` follows its answer.
        if (transactionId) {
          const { answer } = await siblingCall<ObligationFinal | void>(
            { operation: 'compensate', transactionId },
            (inDoubt) => compensate(orderId, transactionId, reason, inDoubt, finalAnswers()),
          );
          if (isFinal(answer) && !leftNothingToRefund(answer.funds)) {
            await staysForReconciliation(
              'compensate',
              answer,
              (now) => now.status === 'CANCELLING',
            );
            order = await read();
            break;
          }
        }
        await recorded('compensate', 'markCancelled', () => markCancelled(orderId, reason));
        status.phase = 'CANCELLED';
        return 'CANCELLED';
      }

      case 'COMPLETED':
      case 'CANCELLED':
      case 'FAILED':
        status.phase = order.status;
        return order.status;

      default:
        // PENDING after step 1 — the saga cannot place a hold it has already
        // resolved. Stop for a human rather than guess.
        throw ApplicationFailure.nonRetryable(
          `The order saga found order ${orderId} ${order.status} after placing its hold`,
          'SAGA_INCONSISTENT',
        );
    }
  }
}

/** The owner's answer that the obligation is final, rather than the call's own. */
function isFinal(answer: unknown): answer is ObligationFinal {
  return typeof answer === 'object' && answer !== null && 'final' in answer;
}

/** Back with the buyer or never held. Anything else, or anything unknown, is for a person. */
function leftNothingToRefund(funds: string): boolean {
  return funds === 'RETURNED' || funds === 'NEVER_HELD';
}

/** The lookup found its own obligation terminal, with no money left to refund. */
function ownerHoldsNothing(error: unknown): boolean {
  if (!(error instanceof ApplicationFailure) || error.type !== 'OBLIGATION_NOT_HELD') return false;
  const found = error.details?.[0] as { status?: string; funds?: string } | undefined;
  // CREATED is NEVER_HELD too, but it can still be held.
  return found?.status !== 'CREATED' && leftNothingToRefund(found?.funds ?? '');
}

/** A lookup that failed as a call, or found what the saga cannot act on. */
function lookupCanWait(error: unknown): boolean {
  return (
    releaseCanWait(error) ||
    (error instanceof ApplicationFailure &&
      ['OBLIGATION_NOT_HELD', 'OBLIGATION_TERMS_MISMATCH', 'OBLIGATION_LOOKUP_UNPROVEN'].includes(
        error.type ?? '',
      ))
  );
}

/** A release that failed as a call: not a cancellation, nor the saga's own stop. */
function releaseCanWait(error: unknown): boolean {
  return error instanceof ActivityFailure && !isCancellation(error);
}

/**
 * A failed call that does not prove it changed nothing. The proof is what the
 * activity marked, never a code alone, which may be a local read's or a later
 * attempt's. In doubt (`inDoubt`, an earlier attempt went unconfirmed), only the
 * obligation's own state is proof.
 */
export function outcomeUnknown(error: unknown, inDoubt: boolean): boolean {
  if (!releaseCanWait(error)) return false;
  const cause = (error as ActivityFailure).cause;
  if (!(cause instanceof ApplicationFailure)) return true;
  const proof: unknown = cause.details?.[0];
  if (proof === OWNER_STATE_IS_FINAL) return false;
  return inDoubt || proof !== REFUSED_ON_FIRST_ATTEMPT || !PROVEN_REFUSALS.has(cause.type ?? '');
}

/** The obligation an order past `PENDING` holds. The row constraint guarantees one. */
function heldTransaction(order: SagaOrderView): string {
  if (order.economicTransactionId) return order.economicTransactionId;
  throw ApplicationFailure.nonRetryable(
    `Order is ${order.status} with no economic transaction recorded`,
    'SAGA_INCONSISTENT',
  );
}

/** A failed call as the operator reads it: the code, when it has one, and the words. */
function failureOf(error: unknown): string {
  const cause = error instanceof ActivityFailure ? error.cause : undefined;
  const code = cause instanceof ApplicationFailure ? cause.type : undefined;
  return code ? `${code}: ${describe(error)}` : describe(error);
}

function describe(error: unknown): string {
  // An activity's failure is wrapped: the refusal economic-service gave is the
  // cause, and "Activity task failed" says nothing about it.
  if (error instanceof ActivityFailure && error.cause instanceof Error) return error.cause.message;
  if (error instanceof Error) return error.message;
  return 'The financial service refused the operation';
}
