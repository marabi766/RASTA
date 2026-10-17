import type { SessionRefusal } from '@/lib/session-refusal';
import type { StatementCommand, StatementLineValues } from '@/lib/statement-fields';
import type { ReplayStamp, SentLine } from '@/lib/unresolved-statement';

/**
 * What one statement command's form knows after an attempt — the dispute
 * form's states (`app/transactions/[id]/form-state.ts`), for drafting,
 * submitting and deciding a statement. A module of its own because the actions
 * file is `'use server'` and may export only async functions.
 *
 * No success case: a confirmed command redirects to the statement with a
 * signed, short-lived confirmation (`server/flash.ts`).
 */
export type StatementFormState =
  | { readonly kind: 'IDLE' }
  | {
      readonly kind: 'INVALID';
      readonly command: StatementCommand;
      readonly submissionId: string;
      /** A draft's rows as typed, so the form draws them again; empty otherwise. */
      readonly rows: readonly StatementLineValues[];
      readonly fieldErrors: Partial<Record<string, string>>;
      /** A refusal the service did not attach to a field, in fixed words (`statement-fields.ts`). */
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
  /** Not sent: the submission could not be remembered in this browser (`lib/unresolved-statement.ts`). */
  | { readonly kind: 'STORAGE_UNAVAILABLE' }
  /**
   * Not sent: another command on this statement — sent from this browser, its
   * outcome still unknown — holds the slot (PR 332 review 1). Its record and
   * its retry are left untouched; this form waits until it is resolved.
   */
  | { readonly kind: 'HELD' }
  | {
      readonly kind: 'FORBIDDEN';
      readonly correlationId: string;
      /** The refusal's closed reasons, said in fixed words — separation of duties among them. */
      readonly reasons: readonly string[];
    }
  /** Gone, or never visible to this caller — the service says 404 for both. */
  | { readonly kind: 'NOT_FOUND' }
  /**
   * Sent, maybe committed, not confirmed. The correlation id, the submission
   * id, the lines and the stamp are always the *original* request's; a retry
   * leaves only a note (`retryRefused`, `retryUnknown`, `sessionEnded`).
   * `viewOnly` is a limit: from another login, past the replay deadline, or a
   * marker — the same request may not be sent again. `replayExpired`: the
   * server refused the re-send because that deadline had passed.
   */
  | {
      readonly kind: 'UNCONFIRMED';
      readonly command: StatementCommand;
      readonly correlationId: string | null;
      readonly submissionId: string;
      /** A draft's lines as sent; empty for every other command. */
      readonly lines: readonly SentLine[];
      readonly replay: ReplayStamp | null;
      readonly retryRefused?: true;
      readonly retryUnknown?: true;
      readonly sessionEnded?: true;
      readonly viewOnly?: true;
      readonly replayExpired?: true;
      readonly marker?: true;
    };

export type UnconfirmedStatement = Extract<StatementFormState, { kind: 'UNCONFIRMED' }>;

export const IDLE_STATEMENT_FORM: StatementFormState = { kind: 'IDLE' };

function original(unconfirmed: UnconfirmedStatement): UnconfirmedStatement {
  return {
    kind: 'UNCONFIRMED',
    command: unconfirmed.command,
    correlationId: unconfirmed.correlationId,
    submissionId: unconfirmed.submissionId,
    lines: unconfirmed.lines,
    replay: unconfirmed.replay,
    ...(unconfirmed.viewOnly ? { viewOnly: true as const } : {}),
    ...(unconfirmed.marker ? { marker: true as const } : {}),
  };
}

/** The same unresolved command after another retry: the original request, and only the latest note. */
export function withRetryNote(
  unconfirmed: UnconfirmedStatement,
  note: 'retryRefused' | 'retryUnknown' | 'sessionEnded',
): UnconfirmedStatement {
  return { ...original(unconfirmed), [note]: true };
}

/** The same unresolved command once its replay deadline has passed: view-only for good. */
export function pastReplayDeadline(unconfirmed: UnconfirmedStatement): UnconfirmedStatement {
  return { ...original(unconfirmed), replay: null, viewOnly: true, replayExpired: true };
}

/**
 * What a retry of an unconfirmed command came to: a refusal of the retry
 * proves nothing about the first request; only an ended session (`NO_SESSION`)
 * and a passed deadline (`REPLAY`, nothing sent) say something definite.
 */
export function afterRetry(
  previous: UnconfirmedStatement,
  state: StatementFormState,
): UnconfirmedStatement {
  if (state.kind === 'REFUSED') {
    if (state.reason === 'NO_SESSION') return withRetryNote(previous, 'sessionEnded');
    if (state.reason === 'SESSION_UNAVAILABLE') return withRetryNote(previous, 'retryUnknown');
    if (state.reason === 'REPLAY') return pastReplayDeadline(previous);
  }
  return withRetryNote(previous, state.kind === 'UNCONFIRMED' ? 'retryUnknown' : 'retryRefused');
}
