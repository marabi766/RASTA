import type { ResolutionFailureReason } from '../observability/metrics';

/**
 * The port through which recipients are resolved (ADR-054 § 1).
 *
 * Recipient addresses are never on the wire — `identity/events.ts` forbids
 * it and this service depends on that — so the only source of "who is a
 * FLEET_MANAGER in organization X right now" is identity-service's
 * authenticated API. This interface is what the resolution worker sees; the
 * HTTP adapter is the one implementation, and the integration tests
 * substitute a fake to prove the retry path without a real identity outage.
 */

export interface RecipientCandidate {
  readonly userId: string;
  /** The role that made this user a recipient — the first listed role that matched. */
  readonly role: string;
}

export interface RecipientResolution {
  readonly recipients: readonly RecipientCandidate[];
  /** True when more matched than `limit` allowed and the list was cut. */
  readonly truncated: boolean;
}

export interface RecipientQuery {
  readonly organizationId: string;
  readonly roles: readonly string[];
  /** Hard ceiling on the merged list (`NOTIFICATION_MAX_RECIPIENTS_PER_INTENT`). */
  readonly limit: number;
  readonly correlationId: string;
}

export interface RecipientPort {
  /**
   * Resolves every active member of `organizationId` holding any of `roles`.
   *
   * Rejects with {@link RecipientResolutionError} — and nothing else — when
   * the answer could not be obtained. The worker treats every such rejection
   * as "try again later"; an intent is never lost to identity being away.
   */
  resolve(query: RecipientQuery): Promise<RecipientResolution>;
}

export const RECIPIENT_PORT = Symbol('NOTIFICATION_RECIPIENT_PORT');

/**
 * The single failure type the port emits. `reason` is a bounded class for the
 * metric and the intent row; the message carries no response body and no
 * address (S-09).
 */
export class RecipientResolutionError extends Error {
  constructor(
    readonly reason: ResolutionFailureReason,
    detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = 'RecipientResolutionError';
  }
}
