/**
 * The ordering rule of the fleet-composition projection (ADR-071 § 3-الف, revision 2), as a
 * pure function — ahead of RUN-001 PR 4, which adds the consumer, the tables and the
 * migration around it. Nothing calls this yet; it is here so the rule the ADR states is
 * executable and its convergence claim is tested now (`asset-current.spec.ts`).
 *
 * ## Commit order exists; arrival order does not
 *
 * asset-service numbers every event of an asset (`streamSeq`, ADR-051 B3) in the transaction
 * that commits it, but its outbox may publish a later row while an earlier one is in backoff.
 * So a transfer B→C (seq 11) can arrive before A→B (seq 10), and an activation before the
 * creation that alone carries the asset's type. Neither is a contradiction.
 *
 * ## Each field takes the highest sequence that stated it
 *
 *   - the owner: from `ASSET_CREATED` and `ASSET_TRANSFERRED` only. Another event's tenant is
 *     never compared with the row's owner — it may rightly be the owner of a transfer that has
 *     not arrived yet. With no ownership event known, the owner is provisional: the tenant of
 *     the highest-sequenced status event, replaced by any ownership event, old or new;
 *   - the status: from the creation, the three status events and a transfer, which states
 *     REGISTERED — asset-service resets the status in the transfer's own transaction and sends no
 *     status event for it (review of #335 round 3, F1);
 *   - the type: from the creation alone, and immutable.
 *
 * Ownership history is a set of statements "generation g belonged to X", one per side of each
 * ownership event, so it does not depend on arrival order either.
 *
 * ## A contradiction is two statements that cannot both be true
 *
 * Two owners for one generation; a second type; or two ownership events whose sequence and
 * generation disagree. Any of these leaves the state unchanged and is dead-lettered as
 * `BUSINESS_RULE_VIOLATION` — whichever of the two arrives second.
 */

/** One asset event, reduced to what this projection reads. */
export type AssetEvent =
  | {
      readonly kind: 'CREATED';
      readonly seq: number;
      readonly tenant: string;
      readonly type: string;
      readonly status: string;
    }
  | {
      readonly kind: 'TRANSFERRED';
      readonly seq: number;
      readonly tenant: string;
      readonly from: string;
      readonly to: string;
      readonly generation: number;
    }
  | {
      readonly kind: 'STATUS';
      readonly seq: number;
      readonly tenant: string;
      readonly status: string;
    }
  | { readonly kind: 'OTHER'; readonly seq: number; readonly tenant: string };

/** "Generation g belonged to `organizationId`", from one side of an ownership event. */
export interface OwnershipStatement {
  readonly organizationId: string;
  readonly generation: number;
  readonly kind: 'START' | 'END';
}

export interface AssetCurrent {
  readonly organizationId: string;
  /** False while the owner is only the tenant of a non-ownership event. */
  readonly ownerKnown: boolean;
  readonly ownerSeq: number;
  readonly ownerGeneration: number | null;
  readonly status: string | null;
  readonly statusSeq: number;
  readonly type: string | null;
}

export interface AssetState {
  readonly current: AssetCurrent | null;
  readonly ownership: readonly OwnershipStatement[];
  /** `(seq, generation)` of every ownership event applied, for the consistency check. */
  readonly ownershipEvents: readonly { readonly seq: number; readonly generation: number }[];
}

export const EMPTY_ASSET_STATE: AssetState = { current: null, ownership: [], ownershipEvents: [] };

export type AssetOutcome =
  | { readonly outcome: 'APPLIED'; readonly state: AssetState }
  | { readonly outcome: 'INVALID' | 'CONTRADICTION'; readonly reason: string };

export function applyAssetEvent(state: AssetState, event: AssetEvent): AssetOutcome {
  if (!Number.isSafeInteger(event.seq) || event.seq < 1) {
    return { outcome: 'INVALID', reason: 'an event with no stream sequence has no place in it' };
  }
  if (event.kind === 'TRANSFERRED') {
    if (event.tenant !== event.to) {
      return { outcome: 'INVALID', reason: 'a transfer is published under its destination' };
    }
    if (event.from === event.to) {
      return { outcome: 'INVALID', reason: 'a transfer names two organizations' };
    }
    if (!Number.isSafeInteger(event.generation) || event.generation < 1) {
      return { outcome: 'INVALID', reason: 'a transfer starts generation 1 or later' };
    }
  }

  const statements = ownershipStatementsOf(event);
  const position = ownershipPositionOf(event);

  const conflict =
    conflictingOwner(state.ownership, statements) ??
    conflictingType(state.current, event) ??
    (position && conflictingOrder(state.ownershipEvents, position));
  if (conflict) return { outcome: 'CONTRADICTION', reason: conflict };

  const known = new Set(state.ownership.map(statementKey));
  const ownership = [...state.ownership, ...statements.filter((s) => !known.has(statementKey(s)))];
  const ownershipEvents =
    position && !state.ownershipEvents.some((e) => e.seq === position.seq)
      ? [...state.ownershipEvents, position]
      : state.ownershipEvents;

  return {
    outcome: 'APPLIED',
    state: { current: nextCurrent(state.current, event), ownership, ownershipEvents },
  };
}

function nextCurrent(held: AssetCurrent | null, event: AssetEvent): AssetCurrent | null {
  // An event that states none of these fields changes nothing, not even a provisional owner:
  // whether it arrived before or after the row existed must not matter.
  if (event.kind === 'OTHER') return held;

  let current: AssetCurrent = held ?? {
    organizationId: event.tenant,
    ownerKnown: false,
    ownerSeq: 0,
    ownerGeneration: null,
    status: null,
    statusSeq: 0,
    type: null,
  };

  if (event.kind === 'CREATED' || event.kind === 'TRANSFERRED') {
    // Any ownership statement outranks a provisional owner, whatever their sequences.
    if (!current.ownerKnown || event.seq > current.ownerSeq) {
      current = {
        ...current,
        organizationId: event.kind === 'CREATED' ? event.tenant : event.to,
        ownerKnown: true,
        ownerSeq: event.seq,
        ownerGeneration: event.kind === 'CREATED' ? 0 : event.generation,
      };
    }
  } else if (!current.ownerKnown && event.seq > current.ownerSeq) {
    current = { ...current, organizationId: event.tenant, ownerSeq: event.seq };
  }

  if (event.kind !== 'OTHER' && event.seq > current.statusSeq) {
    current = { ...current, status: statusOf(event), statusSeq: event.seq };
  }

  if (event.kind === 'CREATED' && current.type === null) {
    current = { ...current, type: event.type };
  }

  return current;
}

/** The status the producer holds after a transfer: the new owner re-commissions it (ADR-071). */
export const STATUS_AFTER_TRANSFER = 'REGISTERED';

function statusOf(event: Exclude<AssetEvent, { kind: 'OTHER' }>): string {
  return event.kind === 'TRANSFERRED' ? STATUS_AFTER_TRANSFER : event.status;
}

function ownershipStatementsOf(event: AssetEvent): OwnershipStatement[] {
  if (event.kind === 'CREATED') {
    return [{ organizationId: event.tenant, generation: 0, kind: 'START' }];
  }
  if (event.kind === 'TRANSFERRED') {
    return [
      { organizationId: event.from, generation: event.generation - 1, kind: 'END' },
      { organizationId: event.to, generation: event.generation, kind: 'START' },
    ];
  }
  return [];
}

function ownershipPositionOf(event: AssetEvent): { seq: number; generation: number } | null {
  if (event.kind === 'CREATED') return { seq: event.seq, generation: 0 };
  if (event.kind === 'TRANSFERRED') return { seq: event.seq, generation: event.generation };
  return null;
}

function conflictingOwner(
  held: readonly OwnershipStatement[],
  stated: readonly OwnershipStatement[],
): string | null {
  for (const statement of stated) {
    const other = held.find(
      (h) => h.generation === statement.generation && h.organizationId !== statement.organizationId,
    );
    if (other) {
      return `generation ${statement.generation} is stated to belong to two organizations`;
    }
  }
  return null;
}

function conflictingType(held: AssetCurrent | null, event: AssetEvent): string | null {
  if (event.kind !== 'CREATED' || !held || held.type === null || held.type === event.type) {
    return null;
  }
  return 'the asset type is immutable and was stated differently';
}

function conflictingOrder(
  held: readonly { seq: number; generation: number }[],
  position: { seq: number; generation: number },
): string | null {
  const disagreeing = held.find(
    (h) =>
      (h.seq === position.seq && h.generation !== position.generation) ||
      (h.seq < position.seq && h.generation >= position.generation) ||
      (h.seq > position.seq && h.generation <= position.generation),
  );
  return disagreeing ? 'stream sequence and ownership generation disagree' : null;
}

function statementKey(statement: OwnershipStatement): string {
  return `${statement.generation}:${statement.kind}`;
}
