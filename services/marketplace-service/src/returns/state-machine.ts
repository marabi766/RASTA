import { RastaError } from '@rasta/nest-common';

/**
 * The return request's lifecycle, as data (ADR-048 § 3).
 *
 * ADR-048 plans `REQUESTED → AUTHORIZED → IN_TRANSIT → RECEIVED → INSPECTED → RESOLVED`, with
 * `REJECTED` or `CANCELLED` before `RESOLVED` "only per Policy and with Audit". The commercial half
 * is decided here by the parties: a request is `REQUESTED`, then `AUTHORIZED`, `REJECTED` or
 * `CANCELLED`. The physical half is inventory-service's: its `RETURN_SHIPMENT_*` events, checked
 * against the request, move an `AUTHORIZED` request on through `IN_TRANSIT`, `RECEIVED`,
 * `INSPECTED` and `RESOLVED` (`return-mirror.consumer.ts`, RUN-005 PR 3) — no command of either
 * party does. The database trigger (`return_request_guard`) says exactly the same thing, so a
 * write path that forgets this file is still refused.
 *
 * What is **not** here is as load-bearing as what is:
 *
 * - `REJECTED`, `CANCELLED` and `RESOLVED` have no outgoing edge: a decided, withdrawn or resolved
 *   request is over, and a replayed command or event cannot reopen it.
 * - `AUTHORIZED → REJECTED` does not exist: authorizing is a decision the supplier cannot take
 *   back (Q-132, temporary decision); the buyer may still withdraw it before goods move.
 * - Nothing leaves a physical state but the next one: once goods are on the road the buyer cannot
 *   cancel (Q-133 (5)), and nothing skips a step.
 * - Nothing here, or anywhere in this service, moves money. A refund is economic-service's, and no
 *   status of a return is a refund (ADR-048 § 3) — `RESOLVED` included.
 */
export const RETURN_STATUSES = [
  'REQUESTED',
  'AUTHORIZED',
  'REJECTED',
  'CANCELLED',
  'IN_TRANSIT',
  'RECEIVED',
  'INSPECTED',
  'RESOLVED',
] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

/** The physical states, in order: each is reached only from the one before it. */
export const PHYSICAL_RETURN_STATUSES = [
  'IN_TRANSIT',
  'RECEIVED',
  'INSPECTED',
  'RESOLVED',
] as const;
export type PhysicalReturnStatus = (typeof PHYSICAL_RETURN_STATUSES)[number];

export const RETURN_TRANSITIONS: Readonly<Record<ReturnStatus, readonly ReturnStatus[]>> = {
  REQUESTED: ['AUTHORIZED', 'REJECTED', 'CANCELLED'],
  AUTHORIZED: ['CANCELLED', 'IN_TRANSIT'],
  REJECTED: [],
  CANCELLED: [],
  IN_TRANSIT: ['RECEIVED'],
  RECEIVED: ['INSPECTED'],
  INSPECTED: ['RESOLVED'],
  RESOLVED: [],
} as const;

export const RETURN_TERMINAL_STATUSES: readonly ReturnStatus[] = [
  'REJECTED',
  'CANCELLED',
  'RESOLVED',
];

/**
 * The statuses whose lines still take units of the order line they return: every request that was
 * not refused or withdrawn. Goods on the road, received or resolved were returned, so they are
 * not returnable a second time.
 */
export const RETURN_STATUSES_HOLDING_UNITS: readonly ReturnStatus[] = RETURN_STATUSES.filter(
  (status) => status !== 'REJECTED' && status !== 'CANCELLED',
);

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
    case 'IN_TRANSIT':
      return 3;
    case 'RECEIVED':
      return 4;
    case 'INSPECTED':
      return 5;
    case 'RESOLVED':
      return 6;
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
