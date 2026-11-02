import type {
  InventoryBody,
  InventoryCommand,
  InventoryFormValues,
} from '@/lib/inventory-commands';
import type { SessionRefusal } from '@/lib/session-refusal';
import type { ReplayStamp } from '@/lib/unresolved-inventory';

/**
 * What one inventory command's form knows after an attempt — the return
 * forms' states (`app/returns/return-form-state.ts`), for the warehouse,
 * stock and shipment commands. A module of its own because the actions file is
 * `'use server'` and may export only async functions.
 *
 * No success case: a confirmed command redirects to the warehouse or the
 * shipment with a signed, short-lived confirmation (`server/flash.ts`).
 */
export type InventoryFormState =
  | { readonly kind: 'IDLE' }
  | {
      readonly kind: 'INVALID';
      readonly command: InventoryCommand;
      readonly submissionId: string;
      /** A typed command's values as typed, so the form draws them again; null otherwise. */
      readonly values: InventoryFormValues | null;
      readonly fieldErrors: Partial<Record<string, string>>;
      /** A refusal the service did not attach to a field, in fixed words (`lib/inventory-commands.ts`). */
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
  /** Not sent: the submission could not be remembered in this browser (`lib/unresolved-inventory.ts`). */
  | { readonly kind: 'STORAGE_UNAVAILABLE' }
  /**
   * Not sent: another command in the same slot — sent from this browser, its
   * outcome still unknown — holds it. Its record and its retry are left
   * untouched; this form waits until it is resolved.
   */
  | { readonly kind: 'HELD' }
  | { readonly kind: 'FORBIDDEN'; readonly correlationId: string }
  /** Gone, or never visible to this caller — the service says 404 for both. */
  | { readonly kind: 'NOT_FOUND' }
  /**
   * Sent, maybe committed, not confirmed. The correlation id, the submission
   * id, the body and the stamp are always the *original* request's; a retry
   * leaves only a note (`retryRefused`, `retryUnknown`, `sessionEnded`).
   * `viewOnly` is a limit: from another login, past the replay deadline, or a
   * marker — the same request may not be sent again. `replayExpired`: the
   * server refused the re-send because that deadline had passed.
   */
  | {
      readonly kind: 'UNCONFIRMED';
      readonly command: InventoryCommand;
      readonly correlationId: string | null;
      readonly submissionId: string;
      /** A typed command's body as sent; null for a shipment move. */
      readonly body: InventoryBody | null;
      readonly replay: ReplayStamp | null;
      readonly retryRefused?: true;
      readonly retryUnknown?: true;
      readonly sessionEnded?: true;
      readonly viewOnly?: true;
      readonly replayExpired?: true;
      readonly marker?: true;
    };

export type UnconfirmedInventory = Extract<InventoryFormState, { kind: 'UNCONFIRMED' }>;

export const IDLE_INVENTORY_FORM: InventoryFormState = { kind: 'IDLE' };

function original(unconfirmed: UnconfirmedInventory): UnconfirmedInventory {
  return {
    kind: 'UNCONFIRMED',
    command: unconfirmed.command,
    correlationId: unconfirmed.correlationId,
    submissionId: unconfirmed.submissionId,
    body: unconfirmed.body,
    replay: unconfirmed.replay,
    ...(unconfirmed.viewOnly ? { viewOnly: true as const } : {}),
    ...(unconfirmed.marker ? { marker: true as const } : {}),
  };
}

/** The same unresolved command after another retry: the original request, and only the latest note. */
export function withRetryNote(
  unconfirmed: UnconfirmedInventory,
  note: 'retryRefused' | 'retryUnknown' | 'sessionEnded',
): UnconfirmedInventory {
  return { ...original(unconfirmed), [note]: true };
}

/** The same unresolved command once its replay deadline has passed: view-only for good. */
export function pastReplayDeadline(unconfirmed: UnconfirmedInventory): UnconfirmedInventory {
  return { ...original(unconfirmed), replay: null, viewOnly: true, replayExpired: true };
}

/**
 * What a retry of an unconfirmed command came to: a refusal of the retry
 * proves nothing about the first request; only an ended session (`NO_SESSION`)
 * and a passed deadline (`REPLAY`, nothing sent) say something definite.
 */
export function afterRetry(
  previous: UnconfirmedInventory,
  state: InventoryFormState,
): UnconfirmedInventory {
  if (state.kind === 'REFUSED') {
    if (state.reason === 'NO_SESSION') return withRetryNote(previous, 'sessionEnded');
    if (state.reason === 'SESSION_UNAVAILABLE') return withRetryNote(previous, 'retryUnknown');
    if (state.reason === 'REPLAY') return pastReplayDeadline(previous);
  }
  return withRetryNote(previous, state.kind === 'UNCONFIRMED' ? 'retryUnknown' : 'retryRefused');
}
