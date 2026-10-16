import { RastaError } from '@rasta/nest-common';

/**
 * The return request's lifecycle, as data (ADR-048 § 3).
 *
 * ADR-048 plans `REQUESTED → AUTHORIZED → IN_TRANSIT → RECEIVED → INSPECTED → RESOLVED`, with
 * `REJECTED` or `CANCELLED` before `RESOLVED` "only per Policy and with Audit". This version holds
 * the commercial half: a request is `REQUESTED`, then `AUTHORIZED`, `REJECTED` or `CANCELLED`. The
 * physical states are inventory-service's facts, arrive as its events, and widen this table in the
 * next change — the database trigger (`return_request_guard`) says exactly the same thing, so a
 * write path that forgets this file is still refused.
 *
 * What is **not** here is as load-bearing as what is:
 *
 * - `REJECTED` and `CANCELLED` have no outgoing edge: a decided or withdrawn request is over, and a
 *   replayed command cannot reopen it.
 * - `AUTHORIZED → REJECTED` does not exist: authorizing is a decision the supplier cannot take
 *   back (Q-132, temporary decision); the buyer may still withdraw it before goods move.
 * - Nothing here, or anywhere in this service, moves money. A refund is economic-service's, and no
 *   status of a return is a refund (ADR-048 § 3).
 */
export const RETURN_STATUSES = ['REQUESTED', 'AUTHORIZED', 'REJECTED', 'CANCELLED'] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

export const RETURN_TRANSITIONS: Readonly<Record<ReturnStatus, readonly ReturnStatus[]>> = {
  REQUESTED: ['AUTHORIZED', 'REJECTED', 'CANCELLED'],
  AUTHORIZED: ['CANCELLED'],
  REJECTED: [],
  CANCELLED: [],
} as const;

export const RETURN_TERMINAL_STATUSES: readonly ReturnStatus[] = ['REJECTED', 'CANCELLED'];

export function canMoveReturn(from: ReturnStatus, to: ReturnStatus): boolean {
  return RETURN_TRANSITIONS[from].includes(to);
}

/**
 * The version a request has after a move: its position in its own history, one per status reached.
 * `CANCELLED` is the one status reachable at two depths.
 */
export function versionAfter(to: ReturnStatus, from: ReturnStatus): number {
  switch (to) {
    case 'REQUESTED':
      return 1;
    case 'AUTHORIZED':
    case 'REJECTED':
      return 2;
    case 'CANCELLED':
      return from === 'AUTHORIZED' ? 3 : 2;
  }
}

/**
 * Refuses an illegal move with the platform's business-rule code (`422`: the request is
 * well-formed and the caller may make it — the return is simply not where the command means
 * anything, and a retry would not help).
 */
export function assertReturnTransition(
  returnRequestId: string,
  from: ReturnStatus,
  to: ReturnStatus,
): void {
  if (canMoveReturn(from, to)) return;
  throw RastaError.businessRule(
    RETURN_TERMINAL_STATUSES.includes(from)
      ? `Return request ${returnRequestId} is already ${from} and cannot change further`
      : `Return request ${returnRequestId} cannot move from ${from} to ${to}`,
    { returnRequestId, from, to },
  );
}
