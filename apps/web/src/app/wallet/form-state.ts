import type { TopUpFormField, TopUpFormValues } from '@/lib/wallet-fields';

/**
 * What the top-up form knows after an attempt.
 *
 * `actions.ts` is a `'use server'` file and may export only async functions,
 * so the form component needs this type without importing its runtime
 * (`drivers/[id]/form-state.ts` documents the same split).
 *
 * No success state to render: a successful top-up redirects rather than
 * returning one, back to `/wallet?toppedUp=1` — a fresh read of the balance
 * this form just changed, and a refresh that cannot resubmit it.
 */
export type TopUpFormState =
  | { readonly kind: 'IDLE' }
  | {
      readonly kind: 'INVALID';
      readonly submissionId: string;
      readonly values: TopUpFormValues;
      readonly fieldErrors: Partial<Record<TopUpFormField, string>>;
      readonly message: string | null;
    }
  | { readonly kind: 'REFUSED'; readonly reason: 'NO_SESSION' | 'CSRF' | 'SUBMISSION' }
  | { readonly kind: 'FORBIDDEN'; readonly correlationId: string }
  | { readonly kind: 'FAILED'; readonly status: number; readonly correlationId: string };

export const IDLE_TOP_UP_FORM: TopUpFormState = { kind: 'IDLE' };
