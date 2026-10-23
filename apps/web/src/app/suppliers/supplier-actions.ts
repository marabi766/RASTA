'use server';

import {
  approveFormValues,
  parseApproveForm,
  parseRegisterForm,
  parseRejectForm,
  parseReinstateForm,
  parseSubmitForm,
  parseSuspendForm,
  reasonFormValues,
  registerFormValues,
  rejectFormValues,
  submitFormValues,
  type ApproveField,
  type ApproveFormValues,
  type ReasonField,
  type ReasonFormValues,
  type RegisterField,
  type RegisterFormValues,
  type RejectField,
  type RejectFormValues,
  type SubmitField,
  type SubmitFormValues,
} from '@/lib/supplier-commands';
import {
  approveQualification,
  rejectQualification,
  reinstateSupplier,
  submitQualification,
  suspendSupplier,
} from '@/server/supplier-commands';

import type { SupplierFormState } from './supplier-form-state';
import { runOnSupplier, runRegister } from './supplier-runner';

/**
 * The six supplier commands. They run through `supplier-runner.ts`.
 *
 * None of them reads a supplier id or a qualification id from the form. The
 * supplier is the page's own, bound to the action by the form
 * (`action.bind(null, supplierId)`); the qualification of a decision comes from
 * the baseline the page signed for **that command** (`REFUSED/BASELINE` for any
 * other). Whether the command is allowed is not decided here: supplier-service
 * decides — role, the supplier's own organization, the state — and its refusal
 * is said in fixed words.
 */

type State<V, F extends string> = SupplierFormState<V, F>;

export async function submitRegisterSupplier(
  _previous: State<RegisterFormValues, RegisterField>,
  form: FormData,
): Promise<State<RegisterFormValues, RegisterField>> {
  return runRegister({ valuesOf: registerFormValues, parse: parseRegisterForm }, form);
}

export async function submitQualificationRequest(
  supplierId: string,
  _previous: State<SubmitFormValues, SubmitField>,
  form: FormData,
): Promise<State<SubmitFormValues, SubmitField>> {
  return runOnSupplier(
    {
      command: 'SUBMIT_QUALIFICATION',
      notice: 'submitted',
      valuesOf: submitFormValues,
      parse: parseSubmitForm,
      send: (session, baseline, body) => submitQualification(session, baseline.supplierId, body),
    },
    supplierId,
    form,
  );
}

/** A decision names its qualification only through the baseline. */
const qualificationOf = (baseline: { qualificationId: string | null }): string =>
  baseline.qualificationId ?? '';

/** Never empty for REINSTATE: the runner refuses a baseline without its episode. */
const episodeOf = (baseline: { suspensionId: string | null }): string =>
  baseline.suspensionId ?? '';

export async function submitApproveQualification(
  supplierId: string,
  _previous: State<ApproveFormValues, ApproveField>,
  form: FormData,
): Promise<State<ApproveFormValues, ApproveField>> {
  return runOnSupplier(
    {
      command: 'APPROVE_QUALIFICATION',
      notice: 'approved',
      valuesOf: approveFormValues,
      parse: parseApproveForm,
      send: (session, baseline, body) =>
        approveQualification(session, baseline.supplierId, qualificationOf(baseline), body),
    },
    supplierId,
    form,
  );
}

export async function submitRejectQualification(
  supplierId: string,
  _previous: State<RejectFormValues, RejectField>,
  form: FormData,
): Promise<State<RejectFormValues, RejectField>> {
  return runOnSupplier(
    {
      command: 'REJECT_QUALIFICATION',
      notice: 'rejected',
      valuesOf: rejectFormValues,
      parse: parseRejectForm,
      send: (session, baseline, body) =>
        rejectQualification(session, baseline.supplierId, qualificationOf(baseline), body),
    },
    supplierId,
    form,
  );
}

export async function submitSuspendSupplier(
  supplierId: string,
  _previous: State<ReasonFormValues, ReasonField>,
  form: FormData,
): Promise<State<ReasonFormValues, ReasonField>> {
  return runOnSupplier(
    {
      command: 'SUSPEND',
      notice: 'suspended',
      valuesOf: reasonFormValues,
      parse: parseSuspendForm,
      // The newest episode the page showed, as signed; the service refuses the
      // suspension if a newer one was recorded since.
      send: (session, baseline, body) =>
        suspendSupplier(session, baseline.supplierId, {
          ...body,
          latestSuspensionId: baseline.suspensionId,
        }),
    },
    supplierId,
    form,
  );
}

export async function submitReinstateSupplier(
  supplierId: string,
  _previous: State<ReasonFormValues, ReasonField>,
  form: FormData,
): Promise<State<ReasonFormValues, ReasonField>> {
  return runOnSupplier(
    {
      command: 'REINSTATE',
      notice: 'reinstated',
      valuesOf: reasonFormValues,
      parse: parseReinstateForm,
      // The open episode the page showed, as signed; the service refuses the
      // lifting if another episode is open now.
      send: (session, baseline, body) =>
        reinstateSupplier(session, baseline.supplierId, {
          ...body,
          suspensionId: episodeOf(baseline),
        }),
    },
    supplierId,
    form,
  );
}
