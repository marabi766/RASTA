import type { BidCommand } from '@/lib/bid-fields';
import type { BidFormValues } from '@/lib/bid-input';
import type { SessionRefusal } from '@/lib/session-refusal';
import type { ReplayStamp } from '@/lib/unresolved-bid';

/**
 * What one bid command's form knows after an attempt — the statement forms'
 * states (`app/contracts/[id]/statement-form-state.ts`), for submitting,
 * replacing and withdrawing a bid. A module of its own because the actions
 * file is `'use server'` and may export only async functions.
 *
 * No success case: a confirmed command redirects to the tender with a signed,
 * short-lived confirmation (`server/flash.ts`).
 */
export type BidFormState =
  | { readonly kind: 'IDLE' }
  | {
      readonly kind: 'INVALID';
      readonly command: BidCommand;
      readonly submissionId: string;
      /** What was typed, so the form draws it again; null for a withdrawal. */
      readonly values: BidFormValues | null;
      readonly fieldErrors: Partial<Record<string, string>>;
      /** A refusal the service did not attach to a field, in fixed words (`lib/bid-fields.ts`). */
      readonly message: string | null;
    }
  | {
      readonly kind: 'REFUSED';
      /**
       * `NO_SESSION`: ended. `SESSION_UNAVAILABLE`: none usable right now, may
       * come back. `REPLAY`: the form's replay deadline has passed or its stamp
       * is not this form's. `COMMAND`: the stamp cannot carry this command.
       * Nothing was sent in any of them.
       */
      readonly reason: SessionRefusal | 'CSRF' | 'SUBMISSION' | 'REPLAY' | 'COMMAND';
    }
  /** Not sent: the submission could not be remembered in this browser (`lib/unresolved-bid.ts`). */
  | { readonly kind: 'STORAGE_UNAVAILABLE' }
  /** Not sent: another command on this tender's bid, its outcome unknown, holds the slot. */
  | { readonly kind: 'HELD' }
  | {
      readonly kind: 'FORBIDDEN';
      readonly correlationId: string;
      readonly reasons: readonly string[];
    }
  /** Gone, or never visible to this caller — the service says 404 for both. */
  | { readonly kind: 'NOT_FOUND' }
  /**
   * Sent, maybe committed, not confirmed. The correlation id, the submission
   * id, the values and the stamp are always the *original* request's; a retry
   * leaves only a note. `values` is what the first send carried, held in this
   * page's memory only — never in storage — and null for a withdrawal (its
   * body is the stamp's) and for a record restored after a reload, which is
   * view-only (`restored`): the content is not kept, and the page's read of
   * the bid says what the service holds.
   */
  | {
      readonly kind: 'UNCONFIRMED';
      readonly command: BidCommand;
      readonly correlationId: string | null;
      readonly submissionId: string;
      readonly values: BidFormValues | null;
      readonly replay: ReplayStamp | null;
      readonly retryRefused?: true;
      readonly retryUnknown?: true;
      readonly sessionEnded?: true;
      readonly viewOnly?: true;
      readonly replayExpired?: true;
      readonly restored?: true;
    };

export type UnconfirmedBid = Extract<BidFormState, { kind: 'UNCONFIRMED' }>;

export const IDLE_BID_FORM: BidFormState = { kind: 'IDLE' };

function original(unconfirmed: UnconfirmedBid): UnconfirmedBid {
  return {
    kind: 'UNCONFIRMED',
    command: unconfirmed.command,
    correlationId: unconfirmed.correlationId,
    submissionId: unconfirmed.submissionId,
    values: unconfirmed.values,
    replay: unconfirmed.replay,
    ...(unconfirmed.viewOnly ? { viewOnly: true as const } : {}),
    ...(unconfirmed.restored ? { restored: true as const } : {}),
  };
}

/** The same unresolved command after another retry: the original request, and only the latest note. */
export function withRetryNote(
  unconfirmed: UnconfirmedBid,
  note: 'retryRefused' | 'retryUnknown' | 'sessionEnded',
): UnconfirmedBid {
  return { ...original(unconfirmed), [note]: true };
}

/** The same unresolved command once its replay deadline has passed: view-only for good. */
export function pastReplayDeadline(unconfirmed: UnconfirmedBid): UnconfirmedBid {
  return { ...original(unconfirmed), replay: null, viewOnly: true, replayExpired: true };
}

/**
 * What a retry of an unconfirmed command came to: a refusal of the retry
 * proves nothing about the first request — a replacement that took is refused
 * `409` the second time — so only an ended session and a passed deadline say
 * something definite.
 */
export function afterRetry(previous: UnconfirmedBid, state: BidFormState): UnconfirmedBid {
  if (state.kind === 'REFUSED') {
    if (state.reason === 'NO_SESSION') return withRetryNote(previous, 'sessionEnded');
    if (state.reason === 'SESSION_UNAVAILABLE') return withRetryNote(previous, 'retryUnknown');
    if (state.reason === 'REPLAY') return pastReplayDeadline(previous);
  }
  return withRetryNote(previous, state.kind === 'UNCONFIRMED' ? 'retryUnknown' : 'retryRefused');
}
