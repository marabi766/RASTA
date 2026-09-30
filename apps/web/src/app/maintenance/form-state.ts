import type { UnconfirmedWriteState } from '@/lib/unconfirmed-write';
import type { ReportRequestField, ReportRequestFormValues } from '@/lib/maintenance-fields';

/**
 * What the `/maintenance` report form knows after an attempt.
 *
 * A module of its own for the reason `drivers/form-state.ts` is: `actions.ts`
 * is a `'use server'` file, which may export only async functions, and the
 * form component needs this type and the initial value without importing the
 * action's runtime.
 */
export type ReportRequestFormState =
  | { readonly kind: 'IDLE' }
  /** The person's own values, kept so the form is not emptied under them. */
  | {
      readonly kind: 'INVALID';
      readonly submissionId: string;
      readonly values: ReportRequestFormValues;
      readonly fieldErrors: Partial<Record<ReportRequestField, string>>;
      /** A problem the service did not attach to a field. */
      readonly message: string | null;
    }
  /**
   * The machine is not visible to this person: it does not exist, or it is
   * another organization's. The platform answers both the same way, so this
   * says no more than that — and keeps what was typed.
   */
  | {
      readonly kind: 'NOT_FOUND';
      readonly submissionId: string;
      readonly values: ReportRequestFormValues;
      readonly correlationId: string;
    }
  /** The request could not be trusted as this person's own. */
  | { readonly kind: 'REFUSED'; readonly reason: 'NO_SESSION' | 'CSRF' | 'SUBMISSION' }
  | { readonly kind: 'FORBIDDEN'; readonly correlationId: string }
  | { readonly kind: 'FAILED'; readonly status: number; readonly correlationId: string }
  | UnconfirmedWriteState;

export const IDLE_REPORT_REQUEST_FORM: ReportRequestFormState = { kind: 'IDLE' };
