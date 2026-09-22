import type { CreateDriverField, CreateDriverFormValues } from '@/lib/driver-fields';

/**
 * What the `/drivers` registration form knows after an attempt.
 *
 * A module of its own for the reason `usage/form-state.ts` is: `actions.ts`
 * is a `'use server'` file, which may export only async functions, and the
 * form component needs this type and the initial value without importing the
 * action's runtime.
 */
export type CreateDriverFormState =
  | { readonly kind: 'IDLE' }
  /** The person's own values, kept so the form is not emptied under them. */
  | {
      readonly kind: 'INVALID';
      readonly submissionId: string;
      readonly values: CreateDriverFormValues;
      readonly fieldErrors: Partial<Record<CreateDriverField, string>>;
      /** A problem the service did not attach to a field. */
      readonly message: string | null;
    }
  /** The request could not be trusted as this person's own. */
  | { readonly kind: 'REFUSED'; readonly reason: 'NO_SESSION' | 'CSRF' | 'SUBMISSION' }
  | { readonly kind: 'FORBIDDEN'; readonly correlationId: string }
  | { readonly kind: 'FAILED'; readonly status: number; readonly correlationId: string };

export const IDLE_CREATE_DRIVER_FORM: CreateDriverFormState = { kind: 'IDLE' };
