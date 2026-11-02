import type { SessionRefusal } from '@/lib/session-refusal';
import type {
  DisputeCommand,
  DisputeField,
  DisputeFormValues,
} from '@/lib/transaction-dispute-fields';
import type { ReplayStamp } from '@/lib/unresolved-dispute';

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
  | {
      readonly kind: 'REFUSED';
      /**
       * `NO_SESSION`: the session has ended. `SESSION_UNAVAILABLE`: none could
       * be used right now — its refresh is unavailable and it may come back
       * (`server/session-state.ts`). `REPLAY`: the form's replay deadline has
       * passed or its stamp is not this form's (`server/dispute-replay.ts`).
       * Nothing was sent in any of them.
       */
      readonly reason: SessionRefusal | 'CSRF' | 'SUBMISSION' | 'REPLAY' | 'COMMAND';
    }
  /**
   * Not sent: the submission could not be remembered in this browser, and a
   * command that may commit with no memory of its key could be repeated under a
   * new key by a reload (`lib/unresolved-dispute.ts`).
   */
  | { readonly kind: 'STORAGE_UNAVAILABLE' }
  /**
   * Not sent: another command on this transaction, from this browser, is still
   * unresolved, or an earlier request of this kind is held
   * (`lib/unresolved-dispute.ts`). Its record is left exactly as it was.
   */
  | { readonly kind: 'HELD' }
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
   * `/auth/session` after a call that threw). A session that is only
   * unavailable for now is `retryUnknown`, not `sessionEnded`. `viewOnly` is
   * not a note but a limit: kept from another login, past the replay deadline,
   * or a marker, so the same request may not be sent again
   * (`lib/unresolved-dispute.ts`). `replayExpired` says the server refused the
   * re-send because that deadline had passed (`server/dispute-replay.ts`);
   * `marker` says the text is no longer kept at all.
   */
  | {
      readonly kind: 'UNCONFIRMED';
      readonly command: DisputeCommand;
      /** Null when no answer ever came back (a lost response): there is no tracking code to show. */
      readonly correlationId: string | null;
      readonly submissionId: string;
      readonly values: DisputeFormValues;
      /** The signed replay deadline every re-send is checked against; null once it can no longer be. */
      readonly replay: ReplayStamp | null;
      readonly retryRefused?: true;
      readonly retryUnknown?: true;
      readonly sessionEnded?: true;
      readonly viewOnly?: true;
      readonly replayExpired?: true;
      readonly marker?: true;
    };

export type UnconfirmedDispute = Extract<DisputeFormState, { kind: 'UNCONFIRMED' }>;

export const IDLE_DISPUTE_FORM: DisputeFormState = { kind: 'IDLE' };

/** The original request — identifiers, values, deadline and limits — without any note. */
function original(unconfirmed: UnconfirmedDispute): UnconfirmedDispute {
  return {
    kind: 'UNCONFIRMED',
    command: unconfirmed.command,
    correlationId: unconfirmed.correlationId,
    submissionId: unconfirmed.submissionId,
    values: unconfirmed.values,
    replay: unconfirmed.replay,
    ...(unconfirmed.viewOnly ? { viewOnly: true as const } : {}),
    ...(unconfirmed.marker ? { marker: true as const } : {}),
  };
}

/**
 * The same unresolved command after another retry: the original identifiers
 * and values, and only the latest note about what the retry came to.
 */
export function withRetryNote(
  unconfirmed: UnconfirmedDispute,
  note: 'retryRefused' | 'retryUnknown' | 'sessionEnded',
): UnconfirmedDispute {
  return { ...original(unconfirmed), [note]: true };
}

/**
 * The same unresolved command once its replay deadline has passed: view-only
 * for good, its outcome still unknown, nothing sent (PR 319 review 2, finding 2).
 */
export function pastReplayDeadline(unconfirmed: UnconfirmedDispute): UnconfirmedDispute {
  return { ...original(unconfirmed), replay: null, viewOnly: true, replayExpired: true };
}
