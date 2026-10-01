import type { UnconfirmedWriteState } from '@/lib/unconfirmed-write';

/**
 * What one of the three request-command forms knows after an attempt.
 *
 * One shape for assign, approve and cancel, because their outcomes are the same
 * family and differ only in which fields they keep. A module of its own for the
 * reason `../form-state.ts` is: `actions.ts` is a `'use server'` file and may
 * export only async functions.
 */
export type RequestCommandFormState<V, F extends string> =
  | { readonly kind: 'IDLE' }
  /** The person's own values, kept so the form is not emptied under them. */
  | {
      readonly kind: 'INVALID';
      readonly submissionId: string;
      readonly values: V;
      readonly fieldErrors: Partial<Record<F, string>>;
      /** A problem the service did not attach to a field. */
      readonly message: string | null;
    }
  /**
   * The request is not visible to this person: it does not exist, or it is
   * another organization's. The platform answers both the same way. Null when
   * the id in the form was not shaped like a request's and nothing was sent.
   */
  | { readonly kind: 'NOT_FOUND'; readonly correlationId: string | null }
  /** The post could not be trusted as this person's own. */
  | { readonly kind: 'REFUSED'; readonly reason: 'NO_SESSION' | 'CSRF' | 'SUBMISSION' }
  | { readonly kind: 'FORBIDDEN'; readonly correlationId: string }
  | { readonly kind: 'FAILED'; readonly status: number; readonly correlationId: string }
  | UnconfirmedWriteState;

export const IDLE_COMMAND_FORM = { kind: 'IDLE' } as const;
