import { RastaError } from '@rasta/nest-common';

/**
 * The maintenance lifecycles, as explicit transition tables.
 *
 * Tables rather than chains of `if`, for the same reason asset-service and
 * fleet-service use them (AGENTS.md A-11): the legal moves become a thing you
 * can read, test and point at in a review, and a move nobody thought about is
 * *absent* — and therefore refused — instead of falling through an `else`.
 *
 * Two machines, because there are two aggregates and they can disagree
 * legitimately. A repair order can be cancelled — the workshop turned the job
 * down — while the request stays OPEN and waits to be referred elsewhere.
 *
 *   MaintenanceRequest
 *
 *     OPEN ──► IN_PROGRESS ──► COMPLETED ──► APPROVED
 *       │            │              │
 *       └────────────┴──────────────┴──► CANCELLED
 *
 *   RepairOrder
 *
 *     OPEN ──► IN_PROGRESS ──► COMPLETED
 *       │            │
 *       └────────────┴──► CANCELLED
 *
 * `APPROVED` is terminal and is the product document's mandatory control:
 * settlement is impossible before it (docs/17, ADR-028). A request cannot be
 * cancelled after approval — that would leave economic-service holding an
 * authorization for work the platform now says never happened.
 */

export const REQUEST_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'COMPLETED',
  'APPROVED',
  'CANCELLED',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

const REQUEST_TRANSITIONS: Record<RequestStatus, readonly RequestStatus[]> = {
  OPEN: ['IN_PROGRESS', 'CANCELLED'],
  // A repair can be abandoned mid-way — the machine turns out to be beyond
  // economical repair. The costs already recorded stay; they were really
  // incurred.
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  // Completed work can still be cancelled, and deliberately so: this is the
  // owner *rejecting* it. The alternative — forcing approval of work they
  // dispute — would make the approval control meaningless.
  COMPLETED: ['APPROVED', 'CANCELLED'],
  APPROVED: [],
  CANCELLED: [],
};

/** Statuses in which a request is still live, and so blocks a duplicate. */
export const OPEN_REQUEST_STATUSES: readonly RequestStatus[] = ['OPEN', 'IN_PROGRESS'];

/** Statuses in which the machine is withdrawn from service. */
export const WITHDRAWN_REQUEST_STATUSES: readonly RequestStatus[] = ['IN_PROGRESS'];

export function canTransitionRequest(from: RequestStatus, to: RequestStatus): boolean {
  return REQUEST_TRANSITIONS[from].includes(to);
}

export function assertRequestTransition(from: string, to: string): void {
  const source = from as RequestStatus;
  const target = to as RequestStatus;

  if (source === target) {
    throw RastaError.invalidStateTransition(
      'MaintenanceRequest',
      from,
      to,
      `This maintenance request is already ${from}`,
    );
  }

  if (canTransitionRequest(source, target)) return;

  throw RastaError.invalidStateTransition(
    'MaintenanceRequest',
    from,
    to,
    source === 'APPROVED'
      ? 'An approved maintenance request is final; it authorises settlement and cannot be reopened'
      : source === 'CANCELLED'
        ? 'A cancelled maintenance request is final; raise a new one'
        : `A maintenance request cannot move from ${from} to ${to}`,
  );
}

// ---------------------------------------------------------------------------
// Repair order
// ---------------------------------------------------------------------------

export const REPAIR_ORDER_STATUSES = ['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;
export type RepairOrderStatus = (typeof REPAIR_ORDER_STATUSES)[number];

const REPAIR_ORDER_TRANSITIONS: Record<RepairOrderStatus, readonly RepairOrderStatus[]> = {
  OPEN: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

/** Statuses in which a repair order still holds the request. */
export const LIVE_REPAIR_ORDER_STATUSES: readonly RepairOrderStatus[] = [
  'OPEN',
  'IN_PROGRESS',
  'COMPLETED',
];

/** Statuses in which cost may still be recorded against a repair order. */
export const COSTABLE_REPAIR_ORDER_STATUSES: readonly RepairOrderStatus[] = ['OPEN', 'IN_PROGRESS'];

export function canTransitionRepairOrder(from: RepairOrderStatus, to: RepairOrderStatus): boolean {
  return REPAIR_ORDER_TRANSITIONS[from].includes(to);
}

export function assertRepairOrderTransition(from: string, to: string): void {
  const source = from as RepairOrderStatus;
  const target = to as RepairOrderStatus;

  if (source === target) {
    throw RastaError.invalidStateTransition(
      'RepairOrder',
      from,
      to,
      `This repair order is already ${from}`,
    );
  }

  if (canTransitionRepairOrder(source, target)) return;

  throw RastaError.invalidStateTransition(
    'RepairOrder',
    from,
    to,
    source === 'COMPLETED'
      ? 'A completed repair order is final; its cost has already been reported'
      : source === 'CANCELLED'
        ? 'A cancelled repair order is final; refer the request to another workshop'
        : `A repair order cannot move from ${from} to ${to}`,
  );
}

/**
 * Asset states in which a machine may take on new maintenance work.
 *
 * Its own list rather than an import from asset-service: importing across a
 * service boundary is forbidden (AGENTS.md A-02), and the two answer different
 * questions. asset-service asks "may this machine be dispatched"; maintenance
 * asks "is its last reported state one where a repair still means something".
 *
 * `OUT_OF_SERVICE` is present on purpose, and it is the difference between the
 * two lists: a machine withdrawn from service is precisely the one most likely
 * to need repairing, and refusing to record work on it would leave the repair
 * that brings it back with nowhere to go. `DECOMMISSIONED` is absent — that
 * one is terminal in asset-service and has no way back.
 */
export const MAINTAINABLE_ASSET_STATUSES: readonly string[] = [
  'REGISTERED',
  'ACTIVE',
  'IDLE',
  'ASSIGNED',
  'IN_MAINTENANCE',
  'OUT_OF_SERVICE',
];
