import type { PlaceOrderField, PlaceOrderFormValues } from '@/lib/place-order-fields';

/**
 * What the place-order form knows after an attempt.
 *
 * A module of its own for the reason every `form-state.ts` in this portal is:
 * `place-order-actions.ts` is a `'use server'` file and may export only async
 * functions.
 *
 * No success case: a placed order redirects to the order, whose page is the
 * confirmation. After a redirect there is no form left to render "done" in.
 */
export type PlaceOrderFormState =
  | { readonly kind: 'IDLE' }
  | {
      readonly kind: 'INVALID';
      readonly submissionId: string;
      readonly values: PlaceOrderFormValues;
      readonly fieldErrors: Partial<Record<PlaceOrderField, string>>;
      /** A refusal the service did not attach to a field — most often a business rule. */
      readonly message: string | null;
    }
  | { readonly kind: 'REFUSED'; readonly reason: 'NO_SESSION' | 'CSRF' | 'SUBMISSION' }
  /** Nothing was sent: this browser could not keep a record of the order, so it could not be placed safely. */
  | { readonly kind: 'STORAGE_UNAVAILABLE' }
  | { readonly kind: 'FORBIDDEN'; readonly correlationId: string }
  /** The offer is gone, or not published — the service says 404 for both. */
  | {
      readonly kind: 'NOT_FOUND';
      readonly submissionId: string;
      readonly values: PlaceOrderFormValues;
    }
  /**
   * Sent, maybe committed, not confirmed: a 5xx, a timeout, an in-flight 409.
   * Carries the values and the submission id so "retry the same request" sends
   * the same body under the same key; only "start a new order" mints another.
   *
   * Once unconfirmed, only a successful answer to a retry of the same submission
   * ends the doubt. `retryRefused` is set when a retry was answered with a
   * refusal: that proves nothing about the first request, so the state stays.
   *
   * The correlation id, the submission id and the values are always the
   * *original* request's: no later answer to a retry replaces them. What a retry
   * left behind is only a note on top — `retryRefused` (answered with a
   * refusal), `retryUnknown` (answered with nothing that can be judged, or a
   * status the portal cannot tell from "maybe"), `sessionEnded` (the portal's
   * own gate refused the call, so no answer came back at all). `viewOnly` is a
   * restored order whose submission id this login can no longer send.
   */
  | {
      readonly kind: 'UNCONFIRMED';
      /** Null when no answer ever came back (a lost response, a reload mid-send): there is no tracking code to show. */
      readonly correlationId: string | null;
      readonly submissionId: string;
      readonly values: PlaceOrderFormValues;
      readonly retryRefused?: true;
      readonly retryUnknown?: true;
      readonly sessionEnded?: true;
      readonly viewOnly?: true;
    };

export type UnconfirmedPlaceOrder = Extract<PlaceOrderFormState, { kind: 'UNCONFIRMED' }>;

export const IDLE_PLACE_ORDER_FORM: PlaceOrderFormState = { kind: 'IDLE' };

/**
 * The same unresolved order after another retry: the original identifiers and
 * values, and only the latest note about what the retry came to.
 */
export function withRetryNote(
  order: UnconfirmedPlaceOrder,
  note: 'retryRefused' | 'retryUnknown' | 'sessionEnded',
): UnconfirmedPlaceOrder {
  return {
    kind: 'UNCONFIRMED',
    correlationId: order.correlationId,
    submissionId: order.submissionId,
    values: order.values,
    [note]: true,
  };
}
