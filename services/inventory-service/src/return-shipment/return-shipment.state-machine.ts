import type { ReturnShipmentStatus } from './dto';

/**
 * The return shipment's physical lifecycle (ADR-048 § 3, the physical half of
 * `REQUESTED → AUTHORIZED → IN_TRANSIT → RECEIVED → INSPECTED → RESOLVED`):
 *
 *            Dispatch              Receive               Inspect              Resolve
 *   (none) ──────────► IN_TRANSIT ────────► RECEIVED ────────────► INSPECTED ──────────► RESOLVED
 *
 * One way, once each; RESOLVED is final. There is no cancellation and no way back (Q-133: a
 * shipment that was recorded is not withdrawn here). The commercial states before IN_TRANSIT —
 * REQUESTED, AUTHORIZED, REJECTED, CANCELLED — are marketplace's and do not exist here. Every move
 * is the destination warehouse owner's operators'; the sender reads. The database keeps the same
 * machine (`tg_return_shipment_guard`); this table is what the commands consult, so a refusal is a
 * clean 409 rather than a trigger's 500.
 */
export const RETURN_SHIPMENT_TRANSITIONS: Readonly<
  Record<ReturnShipmentStatus, readonly ReturnShipmentStatus[]>
> = {
  IN_TRANSIT: ['RECEIVED'],
  RECEIVED: ['INSPECTED'],
  INSPECTED: ['RESOLVED'],
  RESOLVED: [],
};

export function canMove(from: ReturnShipmentStatus, to: ReturnShipmentStatus): boolean {
  return RETURN_SHIPMENT_TRANSITIONS[from].includes(to);
}

/** A return shipment's position in its own history: the `version` each status carries. */
export const RETURN_SHIPMENT_VERSION_OF: Readonly<Record<ReturnShipmentStatus, 1 | 2 | 3 | 4>> = {
  IN_TRANSIT: 1,
  RECEIVED: 2,
  INSPECTED: 3,
  RESOLVED: 4,
};
