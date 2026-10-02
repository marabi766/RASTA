import type { UnconfirmedWriteState } from '@/lib/unconfirmed-write';
import type { RegisterAssetField, RegisterAssetFormValues } from '@/lib/asset-form-fields';

/**
 * What the `/assets` registration form knows after an attempt.
 *
 * A module of its own for the reason `drivers/form-state.ts` is: `actions.ts`
 * is a `'use server'` file, which may export only async functions, and the
 * form component needs this type and the initial value without importing the
 * action's runtime.
 */
export type RegisterAssetFormState =
  | { readonly kind: 'IDLE' }
  /** The person's own values, kept so the form is not emptied under them. */
  | {
      readonly kind: 'INVALID';
      readonly submissionId: string;
      readonly values: RegisterAssetFormValues;
      readonly fieldErrors: Partial<Record<RegisterAssetField, string>>;
      /** A problem the service did not attach to a field. */
      readonly message: string | null;
    }
  /** The request could not be trusted as this person's own. */
  | { readonly kind: 'REFUSED'; readonly reason: 'NO_SESSION' | 'CSRF' | 'SUBMISSION' }
  | { readonly kind: 'FORBIDDEN'; readonly correlationId: string }
  | { readonly kind: 'FAILED'; readonly status: number; readonly correlationId: string }
  | UnconfirmedWriteState;

export const IDLE_REGISTER_ASSET_FORM: RegisterAssetFormState = { kind: 'IDLE' };
