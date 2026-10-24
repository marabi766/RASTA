import type { AccessChange } from './access-change';

/**
 * `iat` is whole seconds: a token issued at 12:00:00.900 says 12:00:00. One
 * second more on every cutoff, so a truncated `iat` never reads as "after".
 */
export const IAT_RESOLUTION_MS = 1_000;

/**
 * The times every decision is made with, from configuration (ADR-060,
 * gateway revocation list addendum § 2).
 *
 *   - `graceMs`: a token issued up to this long after a cutoff is still
 *     treated as issued before it — the verifier's clock tolerance (the
 *     identity-service and Keycloak clocks may differ by that much), plus the
 *     propagation allowance (Keycloak may mint from the attributes a narrowing
 *     replaced for that long after identity-service's write returned, D-064),
 *     plus the `iat` truncation. Equality refuses. Identity writes Keycloak
 *     before it stamps the cutoff, so under those two bounds every token
 *     carrying what the change took away is refused by the cutoff alone, for
 *     its whole life; the role restriction is defence in depth.
 *   - `retentionMs`: how long a pair's state is kept after the change that set
 *     it. A token issued at the latest refused instant (`cutoff + grace`)
 *     lives the maximum lifetime and is accepted the verifier's tolerance past
 *     its `exp`; the state outlives every such token.
 */
export interface RevocationTiming {
  maxTokenLifetimeMs: number;
  clockToleranceMs: number;
  propagationMs: number;
  graceMs: number;
  retentionMs: number;
}

/**
 * Every argument is required: an allowance left out would shorten grace and
 * retention, the unsafe direction (`KEYCLOAK_ATTRIBUTE_PROPAGATION_SECONDS`).
 */
export function revocationTiming(
  maxTokenLifetimeSeconds: number,
  clockToleranceSeconds: number,
  propagationSeconds: number,
): RevocationTiming {
  const maxTokenLifetimeMs = maxTokenLifetimeSeconds * 1000;
  const clockToleranceMs = clockToleranceSeconds * 1000;
  const propagationMs = propagationSeconds * 1000;
  const graceMs = clockToleranceMs + propagationMs + IAT_RESOLUTION_MS;
  return {
    maxTokenLifetimeMs,
    clockToleranceMs,
    propagationMs,
    graceMs,
    retentionMs: graceMs + maxTokenLifetimeMs + clockToleranceMs,
  };
}

/** What the list says about one token for one pair. */
export type ListVerdict =
  | 'allow'
  /** Issued at or before the pair's latest cutoff (plus grace). */
  | 'revoked'
  /** Issued after it, but carrying a role the pair no longer holds. */
  | 'stale_roles'
  /** An event the list could not apply, or could not store, is within its window: nothing is decided. */
  | 'held';

export interface TokenFacts {
  userId: string;
  organizationId: string;
  issuedAtMs: number;
  /** The roles the token grants in `organizationId`, global ones excluded. */
  tenantRoles: readonly string[];
}

/**
 * How many memberships of one pair the list keeps apart. Identity allows one
 * live membership per pair (`ux_membership_live_user_org`), so more than one
 * within a window means a revoke and a re-add; more than this many is not a
 * pattern the list guesses at — the change is `full`, and held.
 */
export const MAX_MEMBERSHIPS_PER_PAIR = 8;

/** One membership of a pair, as far as its own stream has been read. */
interface MembershipState {
  /** The highest `streamSeq` applied. */
  seq: number;
  /** The roles stated at `seq`; none once ended. */
  roles: readonly string[];
  /** Revoked or expired: never grants again, whatever arrives after. */
  ended: boolean;
}

interface PairState {
  /** The latest revocation's `occurredAt`; absent while only grants are known. */
  cutoffMs?: number;
  /** Every membership of the pair seen within the window, by id. */
  memberships: ReadonlyMap<string, MembershipState>;
  /** What a token may carry: the roles every membership not seen ended agrees on. */
  roles: readonly string[];
  /** Only ever moves later; a replayed older event cannot pull it in or push it out. */
  expiresAtMs: number;
}

/**
 * The revocation list of one gateway replica (addendum § 1 and § 3).
 *
 * In memory, rebuilt from the identity topic on every start (`RevocationFeed`):
 * nothing to lose but the process, and nothing shared between replicas that
 * could disagree. Every method is synchronous, so an event is applied whole
 * between two requests — the "latest cutoff wins" rule needs no lock.
 */
export class RevocationList {
  private readonly pairs = new Map<string, PairState>();
  private holdUntilMs = Number.NEGATIVE_INFINITY;

  constructor(
    readonly timing: RevocationTiming,
    private readonly maxEntries: number,
  ) {}

  get size(): number {
    return this.pairs.size;
  }

  /** Whether an unapplied event still holds every pair (`hold`). */
  isHeld(nowMs: number): boolean {
    return nowMs <= this.holdUntilMs;
  }

  /**
   * Applies one change. Idempotent and order-independent:
   *
   *   - the cutoff is the latest revocation's `occurredAt`, so a duplicate or
   *     an older replay leaves it where it is — wall time, because it is
   *     compared with a token's `iat`, and only ever made later;
   *   - a membership's roles are those of the highest `streamSeq` of its
   *     stream applied — commit order, whatever either producer's clock
   *     said (PR #381 r1 F2) — and at an equal position the intersection,
   *     the narrower reading;
   *   - a membership seen revoked or expired is ended for good: no event of
   *     its stream, earlier or later, restores a role to it;
   *   - the pair's roles are the intersection over its memberships not seen
   *     ended. Identity allows one live membership per pair, and a new one
   *     only once the old one is deleted, so every event of an ended
   *     membership precedes the next one's creation; two not seen ended mean
   *     one end has not been read yet, and which is not known;
   *   - the expiry only moves later, so a replay cannot restart the window.
   *
   * A change whose window has already passed is not stored: every token it
   * could concern has expired. `full` when a revocation cannot be stored
   * because the list is at its bound, or when any change would make a pair
   * keep more than `MAX_MEMBERSHIPS_PER_PAIR` apart: the caller holds every
   * pair instead of dropping it. A grant for a pair the list holds nothing
   * for, at the bound, is dropped — no state admits everything a grant's
   * would, so that can only refuse for longer, never admit a revoked one.
   */
  apply(change: AccessChange, nowMs: number): 'applied' | 'expired' | 'full' {
    const expiresAtMs = change.atMs + this.timing.retentionMs;
    if (expiresAtMs < nowMs) return 'expired';

    const key = pairKey(change.userId, change.organizationId);
    let current = this.pairs.get(key);
    if (current && current.expiresAtMs < nowMs) {
      this.pairs.delete(key);
      current = undefined;
    }

    if (!current) {
      if (this.pairs.size >= this.maxEntries) this.prune(nowMs);
      if (this.pairs.size >= this.maxEntries) return change.kind === 'revoke' ? 'full' : 'applied';
    }

    const memberships = new Map(current?.memberships);
    const before = memberships.get(change.membershipId);
    if (!before && memberships.size >= MAX_MEMBERSHIPS_PER_PAIR) return 'full';
    memberships.set(change.membershipId, advance(before, change));

    const cutoffMs =
      change.kind === 'revoke'
        ? Math.max(current?.cutoffMs ?? change.atMs, change.atMs)
        : current?.cutoffMs;

    this.pairs.set(key, {
      ...(cutoffMs !== undefined ? { cutoffMs } : {}),
      memberships,
      roles: agreedRoles(memberships.values()),
      expiresAtMs: Math.max(current?.expiresAtMs ?? expiresAtMs, expiresAtMs),
    });
    return 'applied';
  }

  /**
   * Holds every pair until `atMs`'s window has passed: an event at `atMs` that
   * could not be applied (or stored) may have revoked any of them, and every
   * token issued before it has expired once the window is over (addendum § 5).
   */
  hold(atMs: number): void {
    this.holdUntilMs = Math.max(this.holdUntilMs, atMs + this.timing.retentionMs);
  }

  evaluate(token: TokenFacts, nowMs: number): ListVerdict {
    if (this.isHeld(nowMs)) return 'held';

    const key = pairKey(token.userId, token.organizationId);
    const state = this.pairs.get(key);
    if (!state) return 'allow';
    if (state.expiresAtMs < nowMs) {
      this.pairs.delete(key);
      return 'allow';
    }

    if (state.cutoffMs !== undefined && token.issuedAtMs <= state.cutoffMs + this.timing.graceMs) {
      return 'revoked';
    }
    if (token.tenantRoles.some((role) => !state.roles.includes(role))) return 'stale_roles';
    return 'allow';
  }

  /** Drops every pair whose window has passed. */
  prune(nowMs: number): void {
    for (const [key, state] of this.pairs) {
      if (state.expiresAtMs < nowMs) this.pairs.delete(key);
    }
  }
}

/** One membership's state once `change`, an event of its own stream, is applied. */
function advance(before: MembershipState | undefined, change: AccessChange): MembershipState {
  const ended = (before?.ended ?? false) || change.ends;
  let seq = change.seq;
  let roles: readonly string[] = change.roles;
  if (before && change.seq < before.seq) {
    seq = before.seq;
    roles = before.roles;
  } else if (before && change.seq === before.seq) {
    roles = before.roles.filter((role) => change.roles.includes(role));
  }
  return { seq, roles: ended ? [] : [...roles], ended };
}

/** The roles every membership not seen ended holds; none when every one has ended. */
function agreedRoles(memberships: Iterable<MembershipState>): string[] {
  let agreed: string[] | undefined;
  for (const membership of memberships) {
    if (membership.ended) continue;
    agreed = (agreed ?? [...membership.roles]).filter((role) => membership.roles.includes(role));
  }
  return agreed ?? [];
}

/** One key per pair, unambiguous whatever either id contains. */
function pairKey(userId: string, organizationId: string): string {
  return JSON.stringify([userId, organizationId]);
}
