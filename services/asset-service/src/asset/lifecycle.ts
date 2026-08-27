/**
 * The asset lifecycle, as an explicit state machine.
 *
 * Written as data rather than as conditionals scattered through the service
 * (AGENTS.md A-11). Two things follow from that:
 *
 *   - "which transitions are legal?" is answerable by reading one table, and
 *     provable by a test that walks it, rather than by tracing call sites.
 *   - a transition that nobody thought about is *absent* and therefore
 *     refused, instead of falling through some `else` and silently allowed.
 *
 * Mirrors docs/03 § 3.4.
 */

export type AssetStatus =
  | 'REGISTERED'
  | 'ACTIVE'
  | 'ASSIGNED'
  | 'IDLE'
  | 'IN_MAINTENANCE'
  | 'OUT_OF_SERVICE'
  | 'DECOMMISSIONED';

/**
 * Who is allowed to cause a transition.
 *
 * `USER` — a person, through this service's API.
 * `EVENT` — another service, by publishing a domain event. fleet-service owns
 *   assignment and maintenance-service owns repair state; asset-service
 *   records the consequence rather than deciding it.
 */
export type TransitionActor = 'USER' | 'EVENT';

export interface Transition {
  from: AssetStatus;
  to: AssetStatus;
  actor: TransitionActor;
  /** Read as: "an asset may be …". Used verbatim in the refusal message. */
  description: string;
}

export const TRANSITIONS: readonly Transition[] = [
  // ---- Commissioning -------------------------------------------------------
  {
    from: 'REGISTERED',
    to: 'ACTIVE',
    actor: 'USER',
    description: 'activated once its dossier is complete',
  },

  // ---- Everyday operation --------------------------------------------------
  { from: 'ACTIVE', to: 'IDLE', actor: 'USER', description: 'marked idle' },
  { from: 'IDLE', to: 'ACTIVE', actor: 'USER', description: 'returned to active service' },

  // Assignment belongs to fleet-service, so only an event moves the asset in
  // or out of ASSIGNED. Exposing it on this API would let two services
  // disagree about who is driving what.
  { from: 'ACTIVE', to: 'ASSIGNED', actor: 'EVENT', description: 'assigned to a driver' },
  { from: 'IDLE', to: 'ASSIGNED', actor: 'EVENT', description: 'assigned to a driver' },
  { from: 'ASSIGNED', to: 'ACTIVE', actor: 'EVENT', description: 'released from assignment' },

  // ---- Maintenance ---------------------------------------------------------
  // Likewise owned by maintenance-service.
  { from: 'ACTIVE', to: 'IN_MAINTENANCE', actor: 'EVENT', description: 'taken in for repair' },
  { from: 'IDLE', to: 'IN_MAINTENANCE', actor: 'EVENT', description: 'taken in for repair' },
  { from: 'ASSIGNED', to: 'IN_MAINTENANCE', actor: 'EVENT', description: 'taken in for repair' },
  {
    from: 'IN_MAINTENANCE',
    to: 'ACTIVE',
    actor: 'EVENT',
    description: 'returned from repair',
  },

  // ---- Withdrawal ----------------------------------------------------------
  // Reachable from every in-service state, including REGISTERED: a machine can
  // turn out to be unusable before it is ever commissioned.
  {
    from: 'REGISTERED',
    to: 'OUT_OF_SERVICE',
    actor: 'USER',
    description: 'withdrawn from service',
  },
  { from: 'ACTIVE', to: 'OUT_OF_SERVICE', actor: 'USER', description: 'withdrawn from service' },
  { from: 'IDLE', to: 'OUT_OF_SERVICE', actor: 'USER', description: 'withdrawn from service' },
  {
    from: 'ASSIGNED',
    to: 'OUT_OF_SERVICE',
    actor: 'USER',
    description: 'withdrawn from service',
  },
  {
    from: 'IN_MAINTENANCE',
    to: 'OUT_OF_SERVICE',
    actor: 'USER',
    description: 'withdrawn from service',
  },
  {
    from: 'OUT_OF_SERVICE',
    to: 'ACTIVE',
    actor: 'USER',
    description: 'returned to service',
  },

  // ---- End of life ---------------------------------------------------------
  // Terminal, and deliberately has no way back. A decommissioned asset keeps
  // its row because ledger entries and audit records still point at it.
  {
    from: 'ACTIVE',
    to: 'DECOMMISSIONED',
    actor: 'USER',
    description: 'decommissioned',
  },
  { from: 'IDLE', to: 'DECOMMISSIONED', actor: 'USER', description: 'decommissioned' },
  {
    from: 'OUT_OF_SERVICE',
    to: 'DECOMMISSIONED',
    actor: 'USER',
    description: 'decommissioned',
  },
  {
    from: 'REGISTERED',
    to: 'DECOMMISSIONED',
    actor: 'USER',
    description: 'decommissioned',
  },
];

/** Statuses from which no transition leads anywhere. */
export const TERMINAL_STATUSES: readonly AssetStatus[] = ['DECOMMISSIONED'];

/** Statuses in which the asset can actually be dispatched. */
export const DISPATCHABLE_STATUSES: readonly AssetStatus[] = ['ACTIVE', 'IDLE'];

export function canTransition(from: AssetStatus, to: AssetStatus, actor: TransitionActor): boolean {
  return TRANSITIONS.some((t) => t.from === from && t.to === to && t.actor === actor);
}

/** Every state reachable from `from` by the given actor. */
export function allowedTransitions(from: AssetStatus, actor: TransitionActor): AssetStatus[] {
  return TRANSITIONS.filter((t) => t.from === from && t.actor === actor).map((t) => t.to);
}

/**
 * Explains a refusal in terms the caller can act on.
 *
 * A bare "invalid transition" leaves them guessing; naming what *is* possible
 * from here, and saying when another service owns the change, turns the error
 * into an instruction.
 */
export function explainRefusal(from: AssetStatus, to: AssetStatus, actor: TransitionActor): string {
  if (TERMINAL_STATUSES.includes(from)) {
    return `A ${from} asset cannot change status. This state is final because financial and audit records still reference the asset.`;
  }

  if (actor === 'USER' && canTransition(from, to, 'EVENT')) {
    return `Moving an asset to ${to} is not done directly — it follows from assignment or maintenance in the owning service.`;
  }

  const allowed = allowedTransitions(from, actor);
  if (allowed.length === 0) {
    return `No status change is available from ${from}.`;
  }

  return `An asset in ${from} can move to: ${allowed.join(', ')}.`;
}
