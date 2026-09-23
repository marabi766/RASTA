import type {
  RevokeMembershipField,
  RevokeMembershipFormValues,
  UpdateMemberRolesField,
  UpdateMemberRolesFormValues,
  UpdateOrganizationField,
  UpdateOrganizationFormValues,
} from '@/lib/organization-fields';

/**
 * What each `/organizations` form knows after an attempt.
 *
 * A module of its own for the reason `usage/form-state.ts` and
 * `drivers/form-state.ts` are: `actions.ts` is a `'use server'` file, which
 * may export only async functions, and the form components need these types
 * and their initial values without importing the actions' runtime.
 *
 * Three forms, three states, one shape — the same outcomes every write in this
 * portal can end in.
 *
 * None of them has a "saved" case. Success redirects (`actions.ts`), so the
 * form instance that would render it no longer exists; the page turns the
 * flag in the query into the confirmation instead. A success state here would
 * be a state nothing can ever reach.
 */

interface RefusedState {
  readonly kind: 'REFUSED';
  readonly reason: 'NO_SESSION' | 'CSRF' | 'SUBMISSION';
}

interface ForbiddenState {
  readonly kind: 'FORBIDDEN';
  readonly correlationId: string;
}

interface FailedState {
  readonly kind: 'FAILED';
  readonly status: number;
  readonly correlationId: string;
}

// ---------------------------------------------------------------------------

export type UpdateOrganizationFormState =
  | { readonly kind: 'IDLE' }
  | {
      readonly kind: 'INVALID';
      readonly submissionId: string;
      readonly values: UpdateOrganizationFormValues;
      readonly fieldErrors: Partial<Record<UpdateOrganizationField, string>>;
      readonly message: string | null;
    }
  | RefusedState
  | ForbiddenState
  | FailedState;

export const IDLE_UPDATE_ORGANIZATION_FORM: UpdateOrganizationFormState = { kind: 'IDLE' };

// ---------------------------------------------------------------------------

export type UpdateMemberRolesFormState =
  | { readonly kind: 'IDLE' }
  | {
      readonly kind: 'INVALID';
      readonly submissionId: string;
      readonly values: UpdateMemberRolesFormValues;
      readonly fieldErrors: Partial<Record<UpdateMemberRolesField, string>>;
      readonly message: string | null;
    }
  | RefusedState
  /**
   * The grant the ladder refused (`docs/24` Q-60) lands here. It is a normal
   * outcome, not an error: an administrator can legitimately try to give
   * somebody a role above their own, and the honest answer is that they may
   * not — not a stack trace and not a silent no-op.
   */
  | ForbiddenState
  | { readonly kind: 'NOT_FOUND' }
  | FailedState;

export const IDLE_UPDATE_MEMBER_ROLES_FORM: UpdateMemberRolesFormState = { kind: 'IDLE' };

// ---------------------------------------------------------------------------

export type RevokeMembershipFormState =
  | { readonly kind: 'IDLE' }
  | {
      readonly kind: 'INVALID';
      readonly submissionId: string;
      readonly values: RevokeMembershipFormValues;
      readonly fieldErrors: Partial<Record<RevokeMembershipField, string>>;
      readonly message: string | null;
    }
  | RefusedState
  | ForbiddenState
  | { readonly kind: 'NOT_FOUND' }
  | FailedState;

export const IDLE_REVOKE_MEMBERSHIP_FORM: RevokeMembershipFormState = { kind: 'IDLE' };
