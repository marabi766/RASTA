import type { ReservationView } from './dto';

type Status = ReservationView['status'];

/**
 * The reservation lifecycle (ADR-056 § 3):
 *
 *                ReserveStock                 IssueStock
 *     (none)  ───────────────►  ACTIVE  ─────────────────►  CONSUMED
 *                                  │
 *                                  │ ReleaseReservation, or its expiresAt passed
 *                                  ▼
 *                           RELEASED / EXPIRED
 *
 * Every end is final. The database keeps the same machine (`tg_stock_reservation_guard`); this
 * table is what the commands consult, so a refusal is a clean 409 rather than a trigger's 500.
 */
export const RESERVATION_TRANSITIONS: Readonly<Record<Status, readonly Status[]>> = {
  ACTIVE: ['CONSUMED', 'RELEASED', 'EXPIRED'],
  CONSUMED: [],
  RELEASED: [],
  EXPIRED: [],
};

export function canMove(from: Status, to: Status): boolean {
  return RESERVATION_TRANSITIONS[from].includes(to);
}
