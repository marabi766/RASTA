import type { ContractCommand, ContractField } from '@/lib/contract-command-fields';
import type { CommandInput, ContractFormValues } from '@/lib/contract-command-input';
import type { SessionRefusal } from '@/lib/session-refusal';
import type { ReplayStamp } from '@/lib/unresolved-contract-command';

/**
 * What one contract command's form knows after an attempt — the statement
 * forms' states (`statement-form-state.ts`), for signing and cancelling the
 * contract, proposing and signing an amendment and planning and changing a
 * milestone. A module of its own because the actions file is `'use server'`
 * and may export only async functions.
 *
 * No success case: a confirmed command redirects to the contract with a
 * signed, short-lived confirmation (`server/flash.ts`).
 */
export type ContractFormState =
  | { readonly kind: 'IDLE' }
  | {
      readonly kind: 'INVALID';
      readonly command: ContractCommand;
      readonly submissionId: string;
      /** What was typed, so the form draws it again. */
      readonly values: ContractFormValues;
      readonly fieldErrors: Partial<Record<ContractField, string>>;
      /** A refusal the service did not attach to a field, in fixed words (`contract-command-fields.ts`). */
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
  /** Not sent: the submission could not be remembered in this browser. */
  | { readonly kind: 'STORAGE_UNAVAILABLE' }
  /**
   * Not sent: another command on this object — sent from this browser, its
   * outcome still unknown — holds the slot. Its record and its retry are left
   * untouched; this form waits until it is resolved.
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
   * id, the input and the stamp are always the *original* request's; a retry
   * leaves only a note (`retryRefused`, `retryUnknown`, `sessionEnded`).
   * `viewOnly` is a limit: from another login, past the replay deadline, or a
   * marker — the same request may not be sent again. `replayExpired`: the
   * server refused the re-send because that deadline had passed.
   */
  | {
      readonly kind: 'UNCONFIRMED';
      readonly command: ContractCommand;
      readonly correlationId: string | null;
      readonly submissionId: string;
      /** What was typed, as sent; null for a signature. */
      readonly input: CommandInput;
      readonly replay: ReplayStamp | null;
      readonly retryRefused?: true;
      readonly retryUnknown?: true;
      readonly sessionEnded?: true;
      readonly viewOnly?: true;
      readonly replayExpired?: true;
      readonly marker?: true;
    };

export type UnconfirmedContractCommand = Extract<ContractFormState, { kind: 'UNCONFIRMED' }>;

export const IDLE_CONTRACT_FORM: ContractFormState = { kind: 'IDLE' };

function original(unconfirmed: UnconfirmedContractCommand): UnconfirmedContractCommand {
  return {
    kind: 'UNCONFIRMED',
    command: unconfirmed.command,
    correlationId: unconfirmed.correlationId,
    submissionId: unconfirmed.submissionId,
    input: unconfirmed.input,
    replay: unconfirmed.replay,
    ...(unconfirmed.viewOnly ? { viewOnly: true as const } : {}),
    ...(unconfirmed.marker ? { marker: true as const } : {}),
  };
}

/** The same unresolved command after another retry: the original request, and only the latest note. */
export function withRetryNote(
  unconfirmed: UnconfirmedContractCommand,
  note: 'retryRefused' | 'retryUnknown' | 'sessionEnded',
): UnconfirmedContractCommand {
  return { ...original(unconfirmed), [note]: true };
}

/** The same unresolved command once its replay deadline has passed: view-only for good. */
export function pastReplayDeadline(
  unconfirmed: UnconfirmedContractCommand,
): UnconfirmedContractCommand {
  return { ...original(unconfirmed), replay: null, viewOnly: true, replayExpired: true };
}

/**
 * What a retry of an unconfirmed command came to: a refusal of the retry
 * proves nothing about the first request; only an ended session (`NO_SESSION`)
 * and a passed deadline (`REPLAY`, nothing sent) say something definite.
 */
export function afterRetry(
  previous: UnconfirmedContractCommand,
  state: ContractFormState,
): UnconfirmedContractCommand {
  if (state.kind === 'REFUSED') {
    if (state.reason === 'NO_SESSION') return withRetryNote(previous, 'sessionEnded');
    if (state.reason === 'SESSION_UNAVAILABLE') return withRetryNote(previous, 'retryUnknown');
    if (state.reason === 'REPLAY') return pastReplayDeadline(previous);
  }
  return withRetryNote(previous, state.kind === 'UNCONFIRMED' ? 'retryUnknown' : 'retryRefused');
}
