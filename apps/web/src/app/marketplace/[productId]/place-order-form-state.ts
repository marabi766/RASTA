import type { UnconfirmedWriteState } from '@/lib/unconfirmed-write';
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
  | { readonly kind: 'FORBIDDEN'; readonly correlationId: string }
  /** The offer is gone, or not published — the service says 404 for both. */
  | {
      readonly kind: 'NOT_FOUND';
      readonly submissionId: string;
      readonly values: PlaceOrderFormValues;
    }
  | { readonly kind: 'FAILED'; readonly status: number; readonly correlationId: string }
  | UnconfirmedWriteState;

export const IDLE_PLACE_ORDER_FORM: PlaceOrderFormState = { kind: 'IDLE' };
