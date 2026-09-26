import type { UnconfirmedWriteState } from '@/lib/unconfirmed-write';
import type { UsageField, UsageFormValues } from '@/lib/usage-fields';

/**
 * What the `/usage` form knows after an attempt.
 *
 * A module of its own because `actions.ts` is a `'use server'` file, which
 * may export only async functions, and the form component needs this type
 * and the initial value without importing the action's runtime.
 *
 * `submissionId` travels with every state that lets the person try again:
 * a retry of the same submission carries the same id, which is what makes it
 * a retry rather than a second record (`submission.ts`).
 */
export type UsageFormState =
  | { readonly kind: 'IDLE' }
  /** The person's own values, kept so the form is not emptied under them. */
  | {
      readonly kind: 'INVALID';
      readonly submissionId: string;
      readonly values: UsageFormValues;
      readonly fieldErrors: Partial<Record<UsageField, string>>;
      /** A problem the service did not attach to a field. */
      readonly message: string | null;
    }
  /** The request could not be trusted as this person's own. */
  | { readonly kind: 'REFUSED'; readonly reason: 'NO_SESSION' | 'CSRF' | 'SUBMISSION' }
  | { readonly kind: 'FORBIDDEN'; readonly correlationId: string }
  | {
      readonly kind: 'NOT_FOUND';
      readonly submissionId: string;
      readonly values: UsageFormValues;
      readonly correlationId: string;
    }
  | { readonly kind: 'FAILED'; readonly status: number; readonly correlationId: string }
  | UnconfirmedWriteState;

export const IDLE_USAGE_FORM: UsageFormState = { kind: 'IDLE' };
