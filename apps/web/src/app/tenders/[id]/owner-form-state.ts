import type { SessionRefusal } from '@/lib/session-refusal';
import type { OwnerCommand } from '@/lib/tender-owner-fields';
import type { ReplayStamp } from '@/lib/unresolved-tender-command';

/**
 * What one owner command's form knows after an attempt — the bid forms'
 * states (`bid-form-state.ts`), for publishing, deciding the publication's
 * step and the two-person opening. A module of its own because the actions
 * file is `'use server'`. No success case: a confirmed command redirects with
 * a signed confirmation (`server/flash.ts`).
 */
export type OwnerFormState =
  | { readonly kind: 'IDLE' }
  | {
      readonly kind: 'INVALID';
      readonly command: OwnerCommand;
      readonly submissionId: string;
      /** A rejection's reason as typed; null for every other command. */
      readonly reason: string | null;
      readonly fieldErrors: Partial<Record<string, string>>;
      /** A refusal the service did not attach to a field, in fixed words. */
      readonly message: string | null;
    }
  | {
      readonly kind: 'REFUSED';
      readonly reason: SessionRefusal | 'CSRF' | 'SUBMISSION' | 'REPLAY' | 'COMMAND';
    }
  | { readonly kind: 'STORAGE_UNAVAILABLE' }
  /** Not sent: another owner command on this tender, its outcome unknown, holds the slot. */
  | { readonly kind: 'HELD' }
  | {
      readonly kind: 'FORBIDDEN';
      readonly command: OwnerCommand;
      readonly correlationId: string;
      readonly reasons: readonly string[];
    }
  | { readonly kind: 'NOT_FOUND' }
  /**
   * Sent, maybe committed, not confirmed. `reason` is a rejection's reason as
   * first sent, held in this page's memory only; null for every other command
   * and for a record restored after a reload, which is view-only (`restored`).
   */
  | {
      readonly kind: 'UNCONFIRMED';
      readonly command: OwnerCommand;
      readonly correlationId: string | null;
      readonly submissionId: string;
      readonly reason: string | null;
      readonly replay: ReplayStamp | null;
      readonly retryRefused?: true;
      readonly retryUnknown?: true;
      readonly sessionEnded?: true;
      readonly viewOnly?: true;
      readonly replayExpired?: true;
      readonly restored?: true;
    };

export type UnconfirmedOwnerCommand = Extract<OwnerFormState, { kind: 'UNCONFIRMED' }>;

export const IDLE_OWNER_FORM: OwnerFormState = { kind: 'IDLE' };

function original(unconfirmed: UnconfirmedOwnerCommand): UnconfirmedOwnerCommand {
  return {
    kind: 'UNCONFIRMED',
    command: unconfirmed.command,
    correlationId: unconfirmed.correlationId,
    submissionId: unconfirmed.submissionId,
    reason: unconfirmed.reason,
    replay: unconfirmed.replay,
    ...(unconfirmed.viewOnly ? { viewOnly: true as const } : {}),
    ...(unconfirmed.restored ? { restored: true as const } : {}),
  };
}

export function withRetryNote(
  unconfirmed: UnconfirmedOwnerCommand,
  note: 'retryRefused' | 'retryUnknown' | 'sessionEnded',
): UnconfirmedOwnerCommand {
  return { ...original(unconfirmed), [note]: true };
}

export function pastReplayDeadline(unconfirmed: UnconfirmedOwnerCommand): UnconfirmedOwnerCommand {
  return { ...original(unconfirmed), replay: null, viewOnly: true, replayExpired: true };
}

/**
 * What a retry of an unconfirmed command came to: its refusal proves nothing
 * about the first request (a publication that took is refused `409` the second
 * time); only an ended session and a passed deadline say something definite.
 */
export function afterRetry(
  previous: UnconfirmedOwnerCommand,
  state: OwnerFormState,
): UnconfirmedOwnerCommand {
  if (state.kind === 'REFUSED') {
    if (state.reason === 'NO_SESSION') return withRetryNote(previous, 'sessionEnded');
    if (state.reason === 'SESSION_UNAVAILABLE') return withRetryNote(previous, 'retryUnknown');
    if (state.reason === 'REPLAY') return pastReplayDeadline(previous);
  }
  return withRetryNote(previous, state.kind === 'UNCONFIRMED' ? 'retryUnknown' : 'retryRefused');
}
