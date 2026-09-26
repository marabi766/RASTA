import type { UnconfirmedWriteState } from '@/lib/unconfirmed-write';
import type { OrderCommand, OrderCommandField, OrderCommandFormValues } from '@/lib/order-fields';

/**
 * What one order command's form knows after an attempt.
 *
 * A module of its own for the reason every `form-state.ts` in this portal is:
 * `actions.ts` is a `'use server'` file and may export only async functions.
 *
 * No success case: a successful command redirects back to the order, whose
 * status and actions have changed, and the confirmation comes from the query
 * flag. After a redirect there is no form instance left to render "done" in.
 */
export type OrderCommandFormState =
  | { readonly kind: 'IDLE' }
  | {
      readonly kind: 'INVALID';
      readonly command: OrderCommand;
      readonly submissionId: string;
      readonly values: OrderCommandFormValues;
      readonly fieldErrors: Partial<Record<OrderCommandField, string>>;
      /**
       * A problem the service did not attach to a field. Most often the one
       * that matters here: the order moved while the page was open — the other
       * party acted first — and the command is no longer legal from its new
       * status. The service answers that as a business rule, and it reads here
       * as a sentence rather than as a failure.
       */
      readonly message: string | null;
    }
  | { readonly kind: 'REFUSED'; readonly reason: 'NO_SESSION' | 'CSRF' | 'SUBMISSION' | 'COMMAND' }
  | { readonly kind: 'FORBIDDEN'; readonly correlationId: string }
  /** Gone, or never visible to this caller — the service says 404 for both. */
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'FAILED'; readonly status: number; readonly correlationId: string }
  | UnconfirmedWriteState;

export const IDLE_ORDER_COMMAND_FORM: OrderCommandFormState = { kind: 'IDLE' };
