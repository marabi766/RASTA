'use server';

import { redirect } from 'next/navigation';

import { currentSession } from '@/server/current-session';
import { verifyCsrf } from '@/server/csrf';
import { isBoundSubmissionId, mintSubmissionId, SUBMISSION_FIELD } from '@/server/submission';
import {
  parseReportRequestForm,
  reportMaintenanceRequest,
  reportRequestFormValues,
} from '@/server/maintenance-commands';

import { EDIT_AS_NEW_INTENT, REPORT_INTENT_FIELD, type ReportRequestFormState } from './form-state';

/**
 * The `/maintenance` report form's server action.
 *
 * Same order as every write in this portal (ADR-059 § 3, § 5): session, then
 * CSRF, then the submission id, then the form, then the gateway. Each refusal
 * is decided before the next step runs, so a refused post never reaches the
 * gateway — which is what the spec beside this file asserts.
 */

export async function submitReportRequest(
  _previous: ReportRequestFormState,
  form: FormData,
): Promise<ReportRequestFormState> {
  const session = await currentSession();
  if (!session) return { kind: 'REFUSED', reason: 'NO_SESSION' };

  const csrf = verifyCsrf(session, form);
  if (!csrf.ok) return { kind: 'REFUSED', reason: 'CSRF' };

  const submissionId = form.get(SUBMISSION_FIELD);
  // Bound to this session: a well-formed id this server never issued, another
  // person's id, and an id from an earlier login are all refused here, before
  // anything is sent.
  if (!isBoundSubmissionId(submissionId, session)) {
    return { kind: 'REFUSED', reason: 'SUBMISSION' };
  }

  const values = reportRequestFormValues(form);

  // "Edit and send as new" while the first submission is in flight (round 2
  // on PR 171): nothing is sent. The values come back editable under a new
  // bound id, so the edited form is a new request; the first keeps its own id
  // and its own outcome.
  if (form.get(REPORT_INTENT_FIELD) === EDIT_AS_NEW_INTENT) {
    return { kind: 'EDITING', submissionId: mintSubmissionId(session), values };
  }

  const parsed = parseReportRequestForm(values);
  if (!parsed.ok) {
    return {
      kind: 'INVALID',
      submissionId,
      values,
      fieldErrors: parsed.fieldErrors,
      message: null,
    };
  }

  const result = await reportMaintenanceRequest(session, parsed.request, submissionId);

  if (result.kind === 'CREATED') {
    // Redirect, not state: a refreshed page must not resubmit, and a fresh
    // form must carry a fresh submission id.
    redirect(`/maintenance/${encodeURIComponent(result.data.id)}?created=1`);
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
      return { kind: 'NOT_FOUND', submissionId, values, correlationId: result.correlationId };
    case 'UNAVAILABLE':
      return { kind: 'FAILED', status: result.status, correlationId: result.correlationId };
    case 'UNKNOWN_OUTCOME':
      // Sent, maybe committed, not confirmed: never "nothing was saved".
      return { kind: 'UNCONFIRMED', correlationId: result.correlationId };
    case 'IN_PROGRESS':
      // The first submission of this form is still being processed — a
      // double press, or a create slower than the service waits for. Same
      // values, same submission id: sent again after the wait, it is answered
      // with that first request's result, never a second request.
      return {
        kind: 'IN_PROGRESS',
        submissionId,
        values,
        retryAfterSeconds: result.retryAfterSeconds,
        correlationId: result.correlationId,
      };
  }
}
