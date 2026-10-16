import type {
  DisputeCommand,
  DisputeField,
  DisputeFormValues,
} from '@/lib/transaction-dispute-fields';

/**
 * What one dispute command's form knows after an attempt.
 *
 * A module of its own for the reason every `form-state.ts` in this portal is:
 * `actions.ts` is a `'use server'` file and may export only async functions.
 *
 * No success case: a successful command redirects back to the transaction,
 * whose state has changed, with a signed, short-lived confirmation
 * (`server/flash.ts`) that only this session's own request could have earned.
 *
 * The unconfirmed case is `place-order-form-state.ts`'s, field for field: once
 * a command is sent and not confirmed, only a successful answer to a retry of
 * the **same** submission (same key, same body) ends the doubt.
 */
export type DisputeFormState =
  | { readonly kind: 'IDLE' }
  | {
      readonly kind: 'INVALID';
      readonly command: DisputeCommand;
      readonly submissionId: string;
      readonly values: DisputeFormValues;
      readonly fieldErrors: Partial<Record<DisputeField, string>>;
      /** A refusal the service did not attach to a field — most often the state moved meanwhile. */
      readonly message: string | null;
    }
  | { readonly kind: 'REFUSED'; readonly reason: 'NO_SESSION' | 'CSRF' | 'SUBMISSION' | 'COMMAND' }
  /**
   * Not sent: the submission could not be remembered in this browser, and a
   * command that may commit with no memory of its key could be repeated under a
   * new key by a reload (`lib/unresolved-dispute.ts`).
   */
  | { readonly kind: 'STORAGE_UNAVAILABLE' }
  | { readonly kind: 'FORBIDDEN'; readonly correlationId: string }
  /** Gone, or never visible to this caller — the service says 404 for both. */
  | { readonly kind: 'NOT_FOUND' }
  /**
   * Sent, maybe committed, not confirmed: a 5xx, a timeout, an in-flight 409,
   * a 2xx that did not show the transaction in the command's target state.
   * Carries the command, the values and the submission id so "send the same
   * request again" sends the same body under the same key.
   *
   * The correlation id, the submission id and the values are always the
   * *original* request's: no later answer to a retry replaces them. What a retry
   * left behind is only a note on top — `retryRefused` (answered with a
   * refusal, which proves nothing about the first request), `retryUnknown`
   * (answered with nothing that can be judged, or not answered at all),
   * `sessionEnded` (the portal said, authoritatively, that this browser's
   * session has ended: the action's own `NO_SESSION`, or `401` from
   * `/auth/session` after a call that threw). `viewOnly` is not a note but a
   * limit: kept from another login, or older than the replay window, so the
   * same request may not be sent again (`lib/unresolved-dispute.ts`).
   */
  | {
      readonly kind: 'UNCONFIRMED';
      readonly command: DisputeCommand;
      /** Null when no answer ever came back (a lost response): there is no tracking code to show. */
      readonly correlationId: string | null;
      readonly submissionId: string;
      readonly values: DisputeFormValues;
      readonly retryRefused?: true;
      readonly retryUnknown?: true;
      readonly sessionEnded?: true;
      readonly viewOnly?: true;
    };

export type UnconfirmedDispute = Extract<DisputeFormState, { kind: 'UNCONFIRMED' }>;

export const IDLE_DISPUTE_FORM: DisputeFormState = { kind: 'IDLE' };

/**
 * The same unresolved command after another retry: the original identifiers
 * and values, and only the latest note about what the retry came to.
 */
export function withRetryNote(
  unconfirmed: UnconfirmedDispute,
  note: 'retryRefused' | 'retryUnknown' | 'sessionEnded',
): UnconfirmedDispute {
  return {
    kind: 'UNCONFIRMED',
    command: unconfirmed.command,
    correlationId: unconfirmed.correlationId,
    submissionId: unconfirmed.submissionId,
    values: unconfirmed.values,
    ...(unconfirmed.viewOnly ? { viewOnly: true as const } : {}),
    [note]: true,
  };
}
