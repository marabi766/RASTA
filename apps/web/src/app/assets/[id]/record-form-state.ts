import type { UnconfirmedWriteState } from '@/lib/unconfirmed-write';

/**
 * What one of the two record forms — a policy, an inspection — knows after an
 * attempt.
 *
 * The same family as `LifecycleFormState`, without the baseline: a record is
 * not made against a version or a status, so there is nothing a person was
 * "shown" to refuse a post against. A module of its own because
 * `record-actions.ts` is a `'use server'` file and may export only async
 * functions.
 *
 * Success has no state to render: the action redirects to a fresh read of the
 * dossier (a signed `?flash=`), which is also what makes a refresh unable to
 * resubmit.
 */
export type RecordFormState<V, F extends string> =
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
   * The machine is no longer visible to this person: it was another
   * organization's, or has moved, between the render and the submit. The
   * platform answers "absent" and "not yours" the same way, so this says no
   * more than that.
   */
  | { readonly kind: 'NOT_FOUND'; readonly correlationId: string }
  /** The post could not be trusted as this person's own. */
  | { readonly kind: 'REFUSED'; readonly reason: 'NO_SESSION' | 'CSRF' | 'SUBMISSION' }
  | { readonly kind: 'FORBIDDEN'; readonly correlationId: string }
  | { readonly kind: 'FAILED'; readonly status: number; readonly correlationId: string }
  | UnconfirmedWriteState;

export const IDLE_RECORD_FORM = { kind: 'IDLE' } as const;
