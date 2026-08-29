import { RastaError } from '@rasta/nest-common';
import type { OrderStatus } from '../generated/prisma';

/**
 * The order lifecycle, as data (ADR-038).
 *
 * A table rather than a chain of `if`s, for the reason economic-service
 * learned on its own transaction machine: "is this transition allowed" has to
 * be answerable by reading one thing, and a rule spread across four services
 * is a rule that will disagree with itself.
 *
 * What is **not** here is as load-bearing as what is:
 *
 * - `DISPUTED` has no edge to `SETTLING`. A dispute stopping settlement is an
 *   absent edge, not a check somebody has to remember to write.
 * - `COMPLETED`, `CANCELLED` and `FAILED` have no outgoing edges at all, so a
 *   replayed command on a finished order cannot produce a second financial
 *   effect.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  PENDING: ['FUNDS_HELD', 'FAILED', 'CANCELLING'],
  FUNDS_HELD: ['CONFIRMED', 'CANCELLING', 'DISPUTED'],
  CONFIRMED: ['AWAITING_RECEIPT_CONFIRMATION', 'CANCELLING', 'DISPUTED'],
  AWAITING_RECEIPT_CONFIRMATION: ['RECEIPT_CONFIRMED', 'CANCELLING', 'DISPUTED'],
  // Back to RECEIPT_CONFIRMED when a settlement attempt fails: the order is
  // still authorised, the attempt is not.
  RECEIPT_CONFIRMED: ['SETTLING', 'DISPUTED'],
  SETTLING: ['COMPLETED', 'RECEIPT_CONFIRMED'],
  // A dispute is resolved by a platform operator, and its outcome re-enters
  // the normal path rather than jumping to an end state.
  DISPUTED: ['RECEIPT_CONFIRMED', 'CANCELLING'],
  CANCELLING: ['CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
  FAILED: [],
} as const;

/** Statuses with no way out. */
export const TERMINAL_STATUSES: readonly OrderStatus[] = ['COMPLETED', 'CANCELLED', 'FAILED'];

export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

/**
 * Refuses an illegal transition with the platform's business-rule code.
 *
 * `422` rather than `409`: the request is well-formed and the caller is
 * allowed to make it — the order is simply not in a state where it means
 * anything. A `409` would suggest retrying, which will never help.
 */
export function assertTransition(orderId: string, from: OrderStatus, to: OrderStatus): void {
  if (canTransition(from, to)) return;

  throw RastaError.businessRule(
    isTerminal(from)
      ? `Order ${orderId} is already ${from} and cannot change further`
      : `Order ${orderId} cannot move from ${from} to ${to}`,
    { orderId, from, to },
  );
}

/**
 * Whether settlement is reachable from here at all.
 *
 * Derived from the table rather than restated, so the answer cannot drift
 * from the transitions it is supposed to describe.
 */
export function canReachSettlement(status: OrderStatus): boolean {
  return canTransition(status, 'SETTLING');
}
