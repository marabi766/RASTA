import { RastaError } from '@rasta/nest-common';
import type { TransactionStatus } from '../generated/prisma';

/**
 * The transaction lifecycle, as an explicit state machine.
 *
 * `AGENTS.md` A-11 offers two acceptable forms for a multi-step process:
 * a Temporal workflow, or an explicit state machine. This is the second
 * (ADR-031), and it is a table rather than a chain of `if`s so that the whole
 * set of legal moves can be read at once — and so that a move nobody
 * anticipated is refused by default instead of falling through to "allowed".
 *
 * ```
 *   CREATED ─────► HELD ──────────► PENDING_SETTLEMENT ─────► SETTLED
 *      │             │       ▲               │  ▲
 *      │             │       └───────────────┼──┘   (dispute resolved)
 *      │             ▼                       ▼
 *      │          REFUNDED               DISPUTED ──► REFUNDED
 *      │
 *      ├──► PENDING_SETTLEMENT     (an obligation with no escrow — ADR-032)
 *      ├──► CANCELLED
 *      └──► FAILED
 * ```
 *
 * ## The two rules that are controls rather than conveniences
 *
 * **A disputed transaction never moves.** `DISPUTED` has no edge to `SETTLED`.
 * Settlement can only resume by way of an explicit human resolution back to
 * `PENDING_SETTLEMENT`, which is the product document's requirement that a
 * registered objection stops settlement completely (docs/10 § 10.5). There is
 * no automatic resolution and no timeout that resolves one.
 *
 * **Settlement is reachable only from `PENDING_SETTLEMENT`.** Which is only
 * reachable when the authorising fact has arrived — receipt confirmed, or the
 * owner approved the work. That is the "تسویه بدون تأیید دریافت غیرممکن است"
 * test in docs/10 § 10.12, expressed as a missing edge rather than as a check
 * somebody has to remember to write.
 */

/** What can happen to a transaction. Named for the act, not for the state. */
export type TransactionEvent =
  | 'HOLD_PLACED'
  | 'AUTHORISE_SETTLEMENT'
  | 'SETTLE'
  | 'REFUND'
  | 'CANCEL'
  | 'FAIL'
  | 'DISPUTE'
  | 'RESOLVE_DISPUTE';

const TRANSITIONS: Record<
  TransactionStatus,
  Partial<Record<TransactionEvent, TransactionStatus>>
> = {
  CREATED: {
    HOLD_PLACED: 'HELD',
    // An obligation recorded from an approval has no escrow behind it
    // (ADR-032): the work is already done and the amount is already owed.
    AUTHORISE_SETTLEMENT: 'PENDING_SETTLEMENT',
    CANCEL: 'CANCELLED',
    FAIL: 'FAILED',
  },
  HELD: {
    AUTHORISE_SETTLEMENT: 'PENDING_SETTLEMENT',
    REFUND: 'REFUNDED',
    DISPUTE: 'DISPUTED',
  },
  PENDING_SETTLEMENT: {
    SETTLE: 'SETTLED',
    DISPUTE: 'DISPUTED',
    REFUND: 'REFUNDED',
  },
  DISPUTED: {
    // Back to the queue, by an explicit human decision. Never automatic.
    RESOLVE_DISPUTE: 'PENDING_SETTLEMENT',
    REFUND: 'REFUNDED',
  },
  SETTLED: {},
  REFUNDED: {},
  CANCELLED: {},
  FAILED: {},
};

/** Terminal states. Nothing leaves them, by any route. */
export const TERMINAL_STATUSES: readonly TransactionStatus[] = [
  'SETTLED',
  'REFUNDED',
  'CANCELLED',
  'FAILED',
];

export function isTerminal(status: TransactionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(from: TransactionStatus, event: TransactionEvent): boolean {
  return TRANSITIONS[from][event] !== undefined;
}

/**
 * The state after `event`, or a refusal.
 *
 * Refuses with `INVALID_STATE_TRANSITION` (409) — the platform code that
 * exists for exactly this, so a client can branch on it without reading the
 * message (`packages/contracts/src/common/errors.ts`).
 *
 * The message names the state and the event rather than describing the rule,
 * because "cannot settle a DISPUTED transaction" tells an operator what
 * happened and "settlement requires prior authorisation" does not.
 */
export function nextStatus(
  /**
   * Carried for the caller's benefit rather than used in the decision.
   *
   * The state machine is a pure function of `(from, event)` — which is what
   * makes it exhaustively testable — but a refusal that does not name the
   * transaction sends an operator hunting through logs to find out which one.
   * It reaches the client through `internalContext`, never the response body.
   */
  transactionId: string,
  from: TransactionStatus,
  event: TransactionEvent,
): TransactionStatus {
  const to = TRANSITIONS[from][event];
  if (!to) {
    throw new RastaError(
      'INVALID_STATE_TRANSITION',
      `A ${from} transaction cannot ${describe(event)}`,
      { internalContext: { transactionId, from, event } },
    );
  }
  return to;
}

function describe(event: TransactionEvent): string {
  switch (event) {
    case 'HOLD_PLACED':
      return 'have funds held against it';
    case 'AUTHORISE_SETTLEMENT':
      return 'be authorised for settlement';
    case 'SETTLE':
      return 'be settled';
    case 'REFUND':
      return 'be refunded';
    case 'CANCEL':
      return 'be cancelled';
    case 'FAIL':
      return 'be marked failed';
    case 'DISPUTE':
      return 'be disputed';
    case 'RESOLVE_DISPUTE':
      return 'have a dispute resolved';
  }
}

/**
 * Whether a transaction of this type ever attracts commission.
 *
 * A top-up does not: money entering a wallet is not a service the platform
 * brokered, and charging a rate on it would be inventing a fee the product
 * document does not describe. Every other type is *eligible* — whether any
 * commission is actually charged depends entirely on whether an active rule
 * matches, and with none the answer is zero (ADR-023).
 */
export function attractsCommission(transactionType: string): boolean {
  return transactionType !== 'WALLET_TOP_UP';
}
