'use server';

import { redirect } from 'next/navigation';

import { currentSession } from '@/server/current-session';
import { verifyCsrf } from '@/server/csrf';
import { isSubmissionId, SUBMISSION_FIELD } from '@/server/submission';
import {
  changeDriverStatus,
  changeStatusFormValues,
  parseChangeStatusForm,
  parseUpdateDriverForm,
  updateDriver,
  updateDriverFormValues,
} from '@/server/drivers';
import {
  assignFormValues,
  createAssignment,
  endAssignment,
  endAssignmentFormValues,
  parseAssignForm,
  parseEndAssignmentForm,
} from '@/server/assignments';

import type {
  AssignFormState,
  ChangeStatusFormState,
  EndAssignmentFormState,
  UpdateDriverFormState,
} from './form-state';

/**
 * The `/drivers/[id]` detail page's four server actions.
 *
 * Same order as every write in this portal (ADR-059 § 3, § 5): session, CSRF,
 * submission id, the form, the gateway. What is new here, next to
 * `usage/actions.ts`, is that three of the four need to know *which* driver
 * or assignment they act on, and a `useActionState` action only ever
 * receives `(previousState, formData)` — so each is called bound
 * (`action.bind(null, driverId)`, or `.bind(null, driverId, assignmentId)`
 * for the one that ends an assignment), which is how a value the form itself
 * does not collect reaches a server action in Next.js. None of the four ids
 * is form content, so none of them can be tampered with through the form the
 * way a field can.
 */

export async function submitUpdateDriver(
  driverId: string,
  _previous: UpdateDriverFormState,
  form: FormData,
): Promise<UpdateDriverFormState> {
  const session = await currentSession();
  if (!session) return { kind: 'REFUSED', reason: 'NO_SESSION' };

  const csrf = verifyCsrf(session, form);
  if (!csrf.ok) return { kind: 'REFUSED', reason: 'CSRF' };

  const submissionId = form.get(SUBMISSION_FIELD);
  if (!isSubmissionId(submissionId)) return { kind: 'REFUSED', reason: 'SUBMISSION' };

  const values = updateDriverFormValues(form);
  const parsed = parseUpdateDriverForm(values);
  if (!parsed.ok) {
    return {
      kind: 'INVALID',
      submissionId,
      values,
      fieldErrors: parsed.fieldErrors,
      message: null,
    };
  }

  const result = await updateDriver(session, driverId, parsed.request, submissionId);

  if (result.kind === 'CREATED') {
    redirect(`/drivers/${encodeURIComponent(driverId)}?updated=1`);
  }

  switch (result.kind) {
    case 'INVALID':
      return {
        kind: 'INVALID',
        submissionId,
        values,
        fieldErrors: result.fieldErrors,
        message: result.message,
      };
    case 'FORBIDDEN':
      return { kind: 'FORBIDDEN', correlationId: result.correlationId };
    case 'NOT_FOUND':
      // The page that rendered this form already read the driver; a 404 now
      // means it was removed from view between then and this submit, which
      // this state has no field to attach that to.
      return { kind: 'FAILED', status: 404, correlationId: result.correlationId };
    case 'UNAVAILABLE':
      return { kind: 'FAILED', status: result.status, correlationId: result.correlationId };
    case 'UNKNOWN_OUTCOME':
      // Sent, maybe committed, not confirmed: never "nothing was saved".
      return { kind: 'UNCONFIRMED', correlationId: result.correlationId };
  }
}

export async function submitChangeStatus(
  driverId: string,
  _previous: ChangeStatusFormState,
  form: FormData,
): Promise<ChangeStatusFormState> {
  const session = await currentSession();
  if (!session) return { kind: 'REFUSED', reason: 'NO_SESSION' };

  const csrf = verifyCsrf(session, form);
  if (!csrf.ok) return { kind: 'REFUSED', reason: 'CSRF' };

  const submissionId = form.get(SUBMISSION_FIELD);
  if (!isSubmissionId(submissionId)) return { kind: 'REFUSED', reason: 'SUBMISSION' };

  const values = changeStatusFormValues(form);
  const parsed = parseChangeStatusForm(values);
  if (!parsed.ok) {
    return {
      kind: 'INVALID',
      submissionId,
      values,
      fieldErrors: parsed.fieldErrors,
      message: null,
    };
  }

  const result = await changeDriverStatus(session, driverId, parsed.request, submissionId);

  if (result.kind === 'CREATED') {
    redirect(`/drivers/${encodeURIComponent(driverId)}?statusChanged=1`);
  }

  switch (result.kind) {
    case 'INVALID':
      return {
        kind: 'INVALID',
        submissionId,
        values,
        fieldErrors: result.fieldErrors,
        message: result.message,
      };
    case 'FORBIDDEN':
      return { kind: 'FORBIDDEN', correlationId: result.correlationId };
    case 'NOT_FOUND':
      return { kind: 'FAILED', status: 404, correlationId: result.correlationId };
    case 'UNAVAILABLE':
      return { kind: 'FAILED', status: result.status, correlationId: result.correlationId };
    case 'UNKNOWN_OUTCOME':
      // Sent, maybe committed, not confirmed: never "nothing was saved".
      return { kind: 'UNCONFIRMED', correlationId: result.correlationId };
  }
}

export async function submitAssign(
  driverId: string,
  _previous: AssignFormState,
  form: FormData,
): Promise<AssignFormState> {
  const session = await currentSession();
  if (!session) return { kind: 'REFUSED', reason: 'NO_SESSION' };

  const csrf = verifyCsrf(session, form);
  if (!csrf.ok) return { kind: 'REFUSED', reason: 'CSRF' };

  const submissionId = form.get(SUBMISSION_FIELD);
  if (!isSubmissionId(submissionId)) return { kind: 'REFUSED', reason: 'SUBMISSION' };

  const values = assignFormValues(form);
  const parsed = parseAssignForm(values, driverId);
  if (!parsed.ok) {
    return {
      kind: 'INVALID',
      submissionId,
      values,
      fieldErrors: parsed.fieldErrors,
      message: null,
    };
  }

  const result = await createAssignment(session, parsed.request, submissionId);

  if (result.kind === 'CREATED') {
    redirect(`/drivers/${encodeURIComponent(driverId)}?assigned=1`);
  }

  switch (result.kind) {
    case 'INVALID':
      return {
        kind: 'INVALID',
        submissionId,
        values,
        fieldErrors: result.fieldErrors,
        message: result.message,
      };
    case 'FORBIDDEN':
      return { kind: 'FORBIDDEN', correlationId: result.correlationId };
    case 'NOT_FOUND':
      // The machine named is not one this tenant can dispatch — another
      // organization's id, or a typo. The service says "absent"; the form
      // says so on the field that named it.
      return { kind: 'NOT_FOUND', submissionId, values, correlationId: result.correlationId };
    case 'UNAVAILABLE':
      return { kind: 'FAILED', status: result.status, correlationId: result.correlationId };
    case 'UNKNOWN_OUTCOME':
      // Sent, maybe committed, not confirmed: never "nothing was saved".
      return { kind: 'UNCONFIRMED', correlationId: result.correlationId };
  }
}

export async function submitEndAssignment(
  driverId: string,
  assignmentId: string,
  _previous: EndAssignmentFormState,
  form: FormData,
): Promise<EndAssignmentFormState> {
  const session = await currentSession();
  if (!session) return { kind: 'REFUSED', reason: 'NO_SESSION' };

  const csrf = verifyCsrf(session, form);
  if (!csrf.ok) return { kind: 'REFUSED', reason: 'CSRF' };

  const submissionId = form.get(SUBMISSION_FIELD);
  if (!isSubmissionId(submissionId)) return { kind: 'REFUSED', reason: 'SUBMISSION' };

  const values = endAssignmentFormValues(form);
  const parsed = parseEndAssignmentForm(values);
  if (!parsed.ok) {
    return {
      kind: 'INVALID',
      submissionId,
      values,
      fieldErrors: parsed.fieldErrors,
      message: null,
    };
  }

  const result = await endAssignment(session, assignmentId, parsed.request, submissionId);

  if (result.kind === 'CREATED') {
    redirect(`/drivers/${encodeURIComponent(driverId)}?ended=1`);
  }

  switch (result.kind) {
    case 'INVALID':
      return {
        kind: 'INVALID',
        submissionId,
        values,
        fieldErrors: result.fieldErrors,
        message: result.message,
      };
    case 'FORBIDDEN':
      return { kind: 'FORBIDDEN', correlationId: result.correlationId };
    case 'NOT_FOUND':
      return { kind: 'FAILED', status: 404, correlationId: result.correlationId };
    case 'UNAVAILABLE':
      return { kind: 'FAILED', status: result.status, correlationId: result.correlationId };
    case 'UNKNOWN_OUTCOME':
      // Sent, maybe committed, not confirmed: never "nothing was saved".
      return { kind: 'UNCONFIRMED', correlationId: result.correlationId };
  }
}
