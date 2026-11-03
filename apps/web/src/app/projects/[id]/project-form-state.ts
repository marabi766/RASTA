import type { SessionRefusal } from '@/lib/session-refusal';
import type { UnconfirmedWriteState } from '@/lib/unconfirmed-write';

/**
 * What one of the project command forms knows after an attempt.
 *
 * One shape for every command on a project and for an authority's decision:
 * their outcomes are the same family and differ only in which fields they keep.
 * A module of its own because `project-actions.ts` is a `'use server'` file and
 * may export only async functions.
 *
 * Success has no state to render: the action redirects to a fresh read (a
 * signed `?flash=`), which is also what makes a refresh unable to resubmit.
 * There is no "in progress, retry" state either: none of these calls takes an
 * Idempotency-Key, so a lost answer is `UNCONFIRMED` and the person looks first.
 */
export type ProjectFormState<V, F extends string> =
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
  /** The project or step is not visible to this person (absent and "not yours" read the same). */
  | { readonly kind: 'NOT_FOUND'; readonly correlationId: string }
  /** The post could not be trusted as this person's own. */
  | {
      readonly kind: 'REFUSED';
      readonly reason: SessionRefusal | 'CSRF' | 'SUBMISSION' | 'BASELINE';
    }
  | { readonly kind: 'FORBIDDEN'; readonly correlationId: string }
  /** Refused before it could act (the gateway or the service was unavailable): nothing was written. */
  | { readonly kind: 'FAILED'; readonly status: number; readonly correlationId: string }
  | UnconfirmedWriteState;

export const IDLE_PROJECT_FORM = { kind: 'IDLE' } as const;
