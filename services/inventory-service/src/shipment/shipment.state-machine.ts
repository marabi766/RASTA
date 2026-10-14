import type { ShipmentStatus } from './dto';

/**
 * The shipment lifecycle (ADR-056 plan step 8; Q-114):
 *
 *                CreateShipment            DispatchShipment              DeliverShipment
 *     (none)  ─────────────────► CREATED ─────────────────► DISPATCHED ─────────────────► DELIVERED
 *
 * One way, once each; DELIVERED is final. Every move is the origin warehouse owner's (plan step
 * 10); the consignee reads. The database keeps the same machine (`tg_shipment_guard`); this table
 * is what the commands consult, so a refusal is a clean 409 rather than a trigger's 500.
 */
export const SHIPMENT_TRANSITIONS: Readonly<Record<ShipmentStatus, readonly ShipmentStatus[]>> = {
  CREATED: ['DISPATCHED'],
  DISPATCHED: ['DELIVERED'],
  DELIVERED: [],
};

export function canMove(from: ShipmentStatus, to: ShipmentStatus): boolean {
  return SHIPMENT_TRANSITIONS[from].includes(to);
}

/** A shipment's position in its own history: the `version` each status carries. */
export const SHIPMENT_VERSION_OF: Readonly<Record<ShipmentStatus, 1 | 2 | 3>> = {
  CREATED: 1,
  DISPATCHED: 2,
  DELIVERED: 3,
};
