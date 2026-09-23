import type {
  AssignDriverField,
  AssignDriverFormValues,
  ChangeStatusField,
  ChangeStatusFormValues,
  EndAssignmentField,
  EndAssignmentFormValues,
  UpdateDriverField,
  UpdateDriverFormValues,
} from '@/lib/driver-fields';

/**
 * What each of this page's four forms knows after an attempt.
 *
 * One module for all four, for the reason `usage/form-state.ts` gives:
 * `actions.ts` is a `'use server'` file and may export only async functions,
 * so the form components need these types without importing its runtime.
 *
 * None of the four has a success state to render: `usage/actions.ts`
 * redirects rather than returning one, and these do too — the detail page is
 * where the person already is, so success sends them back to a fresh read of
 * it (`?updated=1`), which is also what makes a refresh unable to resubmit.
 */

/** The refusals every write on this page can hit, in the same shape. */
export type WriteRefusal = {
  readonly kind: 'REFUSED';
  readonly reason: 'NO_SESSION' | 'CSRF' | 'SUBMISSION';
};

export type UpdateDriverFormState =
  | { readonly kind: 'IDLE' }
  | {
      readonly kind: 'INVALID';
      readonly submissionId: string;
      readonly values: UpdateDriverFormValues;
      readonly fieldErrors: Partial<Record<UpdateDriverField, string>>;
      readonly message: string | null;
    }
  | WriteRefusal
  | { readonly kind: 'FORBIDDEN'; readonly correlationId: string }
  | { readonly kind: 'FAILED'; readonly status: number; readonly correlationId: string };

export const IDLE_UPDATE_DRIVER_FORM: UpdateDriverFormState = { kind: 'IDLE' };

export type ChangeStatusFormState =
  | { readonly kind: 'IDLE' }
  | {
      readonly kind: 'INVALID';
      readonly submissionId: string;
      readonly values: ChangeStatusFormValues;
      readonly fieldErrors: Partial<Record<ChangeStatusField, string>>;
      readonly message: string | null;
    }
  | WriteRefusal
  | { readonly kind: 'FORBIDDEN'; readonly correlationId: string }
  | { readonly kind: 'FAILED'; readonly status: number; readonly correlationId: string };

export const IDLE_CHANGE_STATUS_FORM: ChangeStatusFormState = { kind: 'IDLE' };

export type AssignFormState =
  | { readonly kind: 'IDLE' }
  | {
      readonly kind: 'INVALID';
      readonly submissionId: string;
      readonly values: AssignDriverFormValues;
      readonly fieldErrors: Partial<Record<AssignDriverField, string>>;
      readonly message: string | null;
    }
  | WriteRefusal
  | { readonly kind: 'FORBIDDEN'; readonly correlationId: string }
  | {
      readonly kind: 'NOT_FOUND';
      readonly submissionId: string;
      readonly values: AssignDriverFormValues;
      readonly correlationId: string;
    }
  | { readonly kind: 'FAILED'; readonly status: number; readonly correlationId: string };

export const IDLE_ASSIGN_FORM: AssignFormState = { kind: 'IDLE' };

export type EndAssignmentFormState =
  | { readonly kind: 'IDLE' }
  | {
      readonly kind: 'INVALID';
      readonly submissionId: string;
      readonly values: EndAssignmentFormValues;
      readonly fieldErrors: Partial<Record<EndAssignmentField, string>>;
      readonly message: string | null;
    }
  | WriteRefusal
  | { readonly kind: 'FORBIDDEN'; readonly correlationId: string }
  | { readonly kind: 'FAILED'; readonly status: number; readonly correlationId: string };

export const IDLE_END_ASSIGNMENT_FORM: EndAssignmentFormState = { kind: 'IDLE' };
