import { RastaError, type AuthState } from '@rasta/nest-common';
import type { RevocationFeed } from './revocation-feed';
import type { RevocationList } from './revocation-list';
import {
  REVOCATION_REFUSAL_REASONS,
  revocationRefusalsTotal,
  type RevocationRefusalReason,
} from './revocation.metrics';

/**
 * One fixed text per refusal. None says which change, when, by whom or why
 * — not even whether it was a role or the membership (addendum § 8).
 */
const REVOKED_MESSAGE =
  'This token no longer grants access in this organization; sign in again to get a current one';
const UNEVALUABLE_MESSAGE = 'Token is not valid';
const UNBOUND_MESSAGE = 'This account cannot act for an organization';
const UNAVAILABLE_MESSAGE = 'Service temporarily unavailable';

export interface HeaderSink {
  setHeader(name: string, value: string): unknown;
}

/**
 * The gateway's decision on one request, before anything else costs or
 * reaches a service (addendum § 6 and § 7).
 *
 * Only a user token that resolved an organization names a pair. An anonymous
 * request, a service token and a user acting for no organization name none
 * and are not evaluated: there is no membership of theirs a revocation could
 * have ended. Every other request is answered from the list, or refused:
 *
 *   - no platform id (`rasta_uid`): the list is keyed by it          → 403 FORBIDDEN
 *   - no `iat`, an `iat` past the clock tolerance, or a lifetime
 *     (`exp - iat`) above the supported maximum                       → 401 TOKEN_INVALID
 *   - the list cannot be vouched for (feed not current, or held)      → 503 UPSTREAM_UNAVAILABLE
 *   - issued at or before the cutoff, or carrying a removed role      → 401 TOKEN_REVOKED
 */
export class RevocationGate {
  private constructor(
    private readonly enforced:
      | { list: RevocationList; feed: RevocationFeed; retryAfterSeconds: number; now: () => number }
      | undefined,
  ) {}

  /**
   * ADR-060 § 7 as it stands: no list, the 905-second window. Chosen
   * explicitly (`GATEWAY_REVOCATION_LIST=off`), never by omission outside
   * development and test.
   */
  static off(): RevocationGate {
    return new RevocationGate(undefined);
  }

  static enforce(
    list: RevocationList,
    feed: RevocationFeed,
    options: { retryAfterSeconds: number; now?: () => number },
  ): RevocationGate {
    return new RevocationGate({
      list,
      feed,
      retryAfterSeconds: options.retryAfterSeconds,
      now: options.now ?? Date.now,
    });
  }

  /**
   * Readiness, from what is true of this replica alone: caught up once since
   * it started, and still reading. A replica that is not is taken out of
   * rotation while the others serve (addendum § 4).
   *
   * Staleness and a hold are not readiness: every replica shares a broker
   * and reads the same messages, so both reach all of them at once, and
   * taking them all out of rotation would also stop the requests that name
   * no pair. Those are refused with 503 instead, and shown as degraded.
   */
  isReady(): boolean {
    if (!this.enforced) return true;
    return this.enforced.feed.hasCaughtUp() && !this.enforced.feed.hasFailed();
  }

  /** Whether every pair is being refused right now: the list cannot be vouched for. */
  isRefusingEveryPair(): boolean {
    if (!this.enforced) return false;
    const now = this.enforced.now();
    return !this.enforced.feed.isCurrent(now) || this.enforced.list.isHeld(now);
  }

  /** Throws the refusal, or returns when the request may proceed. */
  check(auth: AuthState | undefined, response: HeaderSink): void {
    const enforced = this.enforced;
    if (!enforced) return;
    // The AuthGuard sets a state on every request it lets through, anonymous
    // ones included: none here is a wiring fault, and is not read as "nobody".
    if (!auth) {
      throw refuse(
        REVOCATION_REFUSAL_REASONS.TOKEN_UNEVALUABLE,
        new RastaError('TOKEN_INVALID', UNEVALUABLE_MESSAGE),
      );
    }
    if (auth.authType !== 'USER' || !auth.organizationId) return;

    if (!auth.platformUserId || !auth.userId) {
      throw refuse(
        REVOCATION_REFUSAL_REASONS.UNBOUND_IDENTITY,
        RastaError.forbidden(UNBOUND_MESSAGE),
      );
    }

    const now = enforced.now();
    const timing = enforced.list.timing;
    const issuedAtMs = auth.token?.issuedAt;
    if (
      !auth.token ||
      issuedAtMs === undefined ||
      issuedAtMs > now + timing.clockToleranceMs ||
      auth.token.expiresAt - issuedAtMs > timing.maxTokenLifetimeMs
    ) {
      throw refuse(
        REVOCATION_REFUSAL_REASONS.TOKEN_UNEVALUABLE,
        new RastaError('TOKEN_INVALID', UNEVALUABLE_MESSAGE),
      );
    }

    const verdict = enforced.feed.isCurrent(now)
      ? enforced.list.evaluate(
          {
            userId: auth.userId,
            organizationId: auth.organizationId,
            issuedAtMs,
            tenantRoles: auth.token.tenantRoles,
          },
          now,
        )
      : 'held';

    if (verdict === 'allow') return;
    if (verdict === 'held') {
      response.setHeader('Retry-After', String(enforced.retryAfterSeconds));
      throw refuse(
        REVOCATION_REFUSAL_REASONS.UNAVAILABLE,
        new RastaError('UPSTREAM_UNAVAILABLE', UNAVAILABLE_MESSAGE),
      );
    }
    throw refuse(
      verdict === 'revoked'
        ? REVOCATION_REFUSAL_REASONS.REVOKED
        : REVOCATION_REFUSAL_REASONS.STALE_ROLES,
      new RastaError('TOKEN_REVOKED', REVOKED_MESSAGE),
    );
  }
}

function refuse(reason: RevocationRefusalReason, error: RastaError): RastaError {
  revocationRefusalsTotal.inc({ reason });
  return error;
}
