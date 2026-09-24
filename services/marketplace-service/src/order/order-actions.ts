import type { OrderStatus } from '../generated/prisma';
import type { OrderViewerParties } from '../access/access';
import { canTransition } from './state-machine';

/**
 * Which commands the current viewer may issue on this order, right now.
 *
 * ## Why the service answers this and not the client
 *
 * A client needs it to draw a stepper: what has happened, and what this
 * particular person may do next. Nothing in `OrderView` used to say, so the
 * only way to draw one was to re-derive the rule in the client — and that
 * derivation is wrong, not merely fragile.
 *
 * The rule lives in **three** places here, and any two of them alone give the
 * wrong answer:
 *
 *  1. `ORDER_TRANSITIONS` — which status changes are legal at all;
 *  2. the per-command narrowing in `OrderService` — `confirmReceipt`,
 *     `cancel` and `resolveDispute` each pass a `from` narrower than the
 *     table;
 *  3. `access.ts` — which of the two organizations, plus the platform, may
 *     issue each command, decided against the record.
 *
 * The trap is (2), and it has two doors. `ORDER_TRANSITIONS` gives `DISPUTED`
 * two exits — `RECEIPT_CONFIRMED` and `CANCELLING` — so that a platform
 * operator resolving a dispute can send the order either way. Both are the
 * operator's alone (ADR-038). A client reading only the table would conclude the
 * **buyer** may confirm receipt while the order is disputed, and would draw
 * that button — inviting somebody to end a dispute by clicking past it, on
 * the one screen where a mistake costs the most. `confirmReceipt` refuses it,
 * and the client would have been lying about what was possible.
 *
 * So this module states each command's real precondition once, beside the
 * others, and the view carries the result.
 *
 * ## What this is not
 *
 * Not a permission check. Every command re-checks its own transition and its
 * own `assert*` when it runs, whatever a client was told (`docs/16` § ۱۶٫۱۱ —
 * hiding a control is not a control). An empty list here never stands in for
 * an authorization decision; it only means "there is nothing useful to offer".
 */

export const ORDER_ACTIONS = [
  'CONFIRM',
  'FULFILL',
  'CONFIRM_RECEIPT',
  'RAISE_DISPUTE',
  'RESOLVE_DISPUTE',
  'CANCEL',
  'REVIEW',
] as const;

export type OrderAction = (typeof ORDER_ACTIONS)[number];

/** Which party may issue a command. */
type Party = keyof OrderViewerParties;

interface CommandRule {
  readonly party: Party;
  /**
   * The status this command moves the order to, when it moves it.
   *
   * Used to ask `ORDER_TRANSITIONS` which statuses it is legal from, so this
   * module never restates the table. `null` for a command that changes no
   * status — `REVIEW` writes a separate row, and `RESOLVE_DISPUTE`'s target
   * depends on the outcome the operator picks, so both rely on `only`.
   */
  readonly to: OrderStatus | null;
  /**
   * The command's own narrowing, when `OrderService` passes a `from` list
   * stricter than the transition table — quoted from the call site so the two
   * can be compared by eye.
   */
  readonly only?: readonly OrderStatus[];
}

const COMMANDS: Readonly<Record<OrderAction, CommandRule>> = {
  /** `OrderService.confirm` — the supplier accepts. */
  CONFIRM: { party: 'supplier', to: 'CONFIRMED' },

  /** `OrderService.fulfill` — the supplier records delivery. */
  FULFILL: { party: 'supplier', to: 'AWAITING_RECEIPT_CONFIRMATION' },

  /**
   * `OrderService.confirmReceipt` — `from: ['AWAITING_RECEIPT_CONFIRMATION']`.
   *
   * The narrowing that matters: without `only`, the table would also permit
   * this from `DISPUTED`.
   */
  CONFIRM_RECEIPT: {
    party: 'buyer',
    to: 'RECEIPT_CONFIRMED',
    only: ['AWAITING_RECEIPT_CONFIRMATION'],
  },

  /** `OrderService.raiseDispute` — the buyer stops settlement. */
  RAISE_DISPUTE: { party: 'buyer', to: 'DISPUTED' },

  /** `OrderService.resolveDispute` — `from: ['DISPUTED']`, platform only. */
  RESOLVE_DISPUTE: { party: 'platform', to: null, only: ['DISPUTED'] },

  /**
   * `OrderService.cancel` — `from: ['PENDING', 'FUNDS_HELD', 'CONFIRMED',
   * 'AWAITING_RECEIPT_CONFIRMATION']`.
   *
   * The second narrowing of the same kind: the table also permits
   * `DISPUTED → CANCELLING`, for the operator's `ResolveDispute(REFUND)`.
   * Without `only`, the buyer would be offered a way out of their own dispute.
   */
  CANCEL: {
    party: 'buyer',
    to: 'CANCELLING',
    only: ['PENDING', 'FUNDS_HELD', 'CONFIRMED', 'AWAITING_RECEIPT_CONFIRMATION'],
  },

  /**
   * `OrderService.submitReview` — only a `COMPLETED` order, and `Review.orderId`
   * is `@unique`, so only once. The "once" half needs the row, not the status.
   */
  REVIEW: { party: 'buyer', to: null, only: ['COMPLETED'] },
};

/** What the decision needs from the order beyond who is asking. */
export interface OrderActionSubject {
  readonly status: OrderStatus;
  /** Whether a review already exists — `Review.orderId` is unique. */
  readonly hasReview: boolean;
}

function isLegalFrom(rule: CommandRule, status: OrderStatus): boolean {
  if (rule.only && !rule.only.includes(status)) return false;
  // No target status means the command does not move the order, so the
  // transition table has nothing to say and `only` is the whole rule.
  if (rule.to === null) return rule.only !== undefined;
  return canTransition(status, rule.to);
}

/**
 * The commands this viewer may issue on this order in its current state.
 *
 * Returned in {@link ORDER_ACTIONS} order rather than the order the rules
 * happen to be written in, so a client can rely on it and two orders in the
 * same state never render their actions differently.
 */
export function availableOrderActions(
  subject: OrderActionSubject,
  parties: OrderViewerParties,
): readonly OrderAction[] {
  return ORDER_ACTIONS.filter((action) => {
    const rule = COMMANDS[action];
    if (!parties[rule.party]) return false;
    if (!isLegalFrom(rule, subject.status)) return false;
    // Offering a second review would be offering a button that the unique
    // constraint refuses.
    if (action === 'REVIEW' && subject.hasReview) return false;
    return true;
  });
}
