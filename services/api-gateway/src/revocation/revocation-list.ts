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
 *     identity-service and Keycloak clocks may differ by that much) plus the
 *     `iat` truncation. Equality refuses.
 *   - `retentionMs`: how long a pair's state is kept after the change that set
 *     it. A token issued at the latest refused instant (`cutoff + grace`)
 *     lives the maximum lifetime and is accepted the verifier's tolerance past
 *     its `exp`; the state outlives every such token.
 */
export interface RevocationTiming {
  maxTokenLifetimeMs: number;
  clockToleranceMs: number;
  graceMs: number;
  retentionMs: number;
}

export function revocationTiming(
  maxTokenLifetimeSeconds: number,
  clockToleranceSeconds: number,
): RevocationTiming {
  const maxTokenLifetimeMs = maxTokenLifetimeSeconds * 1000;
  const clockToleranceMs = clockToleranceSeconds * 1000;
  const graceMs = clockToleranceMs + IAT_RESOLUTION_MS;
  return {
    maxTokenLifetimeMs,
    clockToleranceMs,
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

interface PairState {
  /** The latest revocation's `occurredAt`; absent while only grants are known. */
  cutoffMs?: number;
  /** The roles stated by the latest event, and that event's `occurredAt`. */
  roles: readonly string[];
  stateAtMs: number;
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
   *   - the cutoff is the latest revocation's, so a duplicate or an older
   *     replay leaves it where it is;
   *   - the roles are the latest event's — and at an equal instant the
   *     intersection, the narrower reading;
   *   - the expiry only moves later, so a replay cannot restart the window.
   *
   * A change whose window has already passed is not stored: every token it
   * could concern has expired. `full` when a revocation cannot be stored
   * because the list is at its bound: the caller holds every pair instead
   * of dropping it. A grant that cannot be stored is dropped — that can only
   * refuse a re-granted pair for longer, never admit a revoked one.
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
      this.pairs.set(key, {
        ...(change.kind === 'revoke' ? { cutoffMs: change.atMs } : {}),
        roles: [...change.roles],
        stateAtMs: change.atMs,
        expiresAtMs,
      });
      return 'applied';
    }

    const cutoffMs =
      change.kind === 'revoke'
        ? Math.max(current.cutoffMs ?? change.atMs, change.atMs)
        : current.cutoffMs;
    let roles = current.roles;
    let stateAtMs = current.stateAtMs;
    if (change.atMs > current.stateAtMs) {
      roles = [...change.roles];
      stateAtMs = change.atMs;
    } else if (change.atMs === current.stateAtMs) {
      roles = current.roles.filter((role) => change.roles.includes(role));
    }

    this.pairs.set(key, {
      ...(cutoffMs !== undefined ? { cutoffMs } : {}),
      roles,
      stateAtMs,
      expiresAtMs: Math.max(current.expiresAtMs, expiresAtMs),
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

/** One key per pair, unambiguous whatever either id contains. */
function pairKey(userId: string, organizationId: string): string {
  return JSON.stringify([userId, organizationId]);
}
