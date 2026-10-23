'use server';

import { redirect } from 'next/navigation';

import { FLASH_PARAM, REPLAY_FIELD } from '@/lib/form-fields';
import { isProvenRefusalStatus, parseCreateForm, projectFormValues } from '@/lib/project-commands';
import { verifyCsrf } from '@/server/csrf';
import { currentSession, missingSessionReason } from '@/server/current-session';
import { mintFlash } from '@/server/flash';
import { createProject } from '@/server/project-commands';
import { checkCreateStamp, mintCreateSubmission } from '@/server/project-create-replay';
import { isBoundSubmissionId, SUBMISSION_FIELD } from '@/server/submission';

import { CREATE_INTENT_FIELD, EDIT_AS_NEW_INTENT, type CreateProjectFormState } from './form-state';

/**
 * The `/projects` create form's server action.
 *
 * Same order as every write in this portal (ADR-059 § 3, § 5): session, then
 * CSRF, then the submission id, then the form, then the gateway. Each refusal
 * is decided before the next step runs, so a refused post never reaches the
 * gateway — which is what the spec beside this file asserts.
 */

export async function submitCreateProject(
  _previous: CreateProjectFormState,
  form: FormData,
): Promise<CreateProjectFormState> {
  const session = await currentSession();
  if (!session) return { kind: 'REFUSED', reason: await missingSessionReason() };

  const csrf = verifyCsrf(session, form);
  if (!csrf.ok) return { kind: 'REFUSED', reason: 'CSRF' };

  const submissionId = form.get(SUBMISSION_FIELD);
  // Bound to this session: a well-formed id this server never issued, another
  // person's id, and an id from an earlier login are all refused here, before
  // anything is sent.
  if (!isBoundSubmissionId(submissionId, session)) {
    return { kind: 'REFUSED', reason: 'SUBMISSION' };
  }

  const values = projectFormValues(form);

  // "Edit and send as new" while the first submission is in flight: nothing is
  // sent. The values come back editable under a new bound id, so the edited
  // form is a new request; the first keeps its own id and its own outcome.
  if (form.get(CREATE_INTENT_FIELD) === EDIT_AS_NEW_INTENT) {
    const fresh = mintCreateSubmission(session);
    return { kind: 'EDITING', submissionId: fresh.id, replay: fresh.replay, values };
  }

  // Until when this request may be sent under its key: the signed stamp the page
  // drew the form with. Past it the service no longer remembers the key, and a
  // send would be a second create of a request that may have committed.
  const replay = form.get(REPLAY_FIELD);
  const sendable = checkCreateStamp(session, replay, submissionId);
  if (sendable === null || typeof replay !== 'string') {
    return { kind: 'REFUSED', reason: 'SUBMISSION' };
  }
  if (sendable === 'EXPIRED') return { kind: 'EXPIRED', values };

  const parsed = parseCreateForm(values);
  if (!parsed.ok) {
    return {
      kind: 'INVALID',
      submissionId,
      replay,
      values,
      fieldErrors: parsed.fieldErrors,
      message: null,
    };
  }

  const result = await createProject(session, parsed.body, submissionId);

  if (result.kind === 'CREATED') {
    // Redirect, not state: a refreshed page must not resubmit, and a fresh
    // form must carry a fresh submission id.
    redirect(
      `/projects/${encodeURIComponent(result.data.id)}?${FLASH_PARAM}=${mintFlash(session, result.data.id, 'created')}`,
    );
  }

  switch (result.kind) {
    case 'INVALID':
      return {
        kind: 'INVALID',
        submissionId,
        replay,
        values,
        fieldErrors: result.fieldErrors,
        message: result.message,
      };
    case 'FORBIDDEN':
      return { kind: 'FORBIDDEN', correlationId: result.correlationId };
    case 'NOT_FOUND':
      // construction-service never answers 404 for this endpoint — there is no
      // referenced resource to be absent — but the type is shared across every
      // write, so it is handled rather than assumed away.
      return { kind: 'FAILED', status: 404, correlationId: result.correlationId };
    case 'UNAVAILABLE':
      // Only a 4xx proves nothing was created; a 5xx may follow the commit.
      if (!isProvenRefusalStatus(result.status)) {
        return { kind: 'UNCONFIRMED', correlationId: result.correlationId };
      }
      return { kind: 'FAILED', status: result.status, correlationId: result.correlationId };
    case 'UNKNOWN_OUTCOME':
      // Sent, maybe committed, not confirmed: never "nothing was saved".
      return { kind: 'UNCONFIRMED', correlationId: result.correlationId };
    case 'IN_PROGRESS':
      // The first submission of this form is still being processed — a double
      // press, or a create slower than the service waits for. Same values, same
      // submission id: sent again after the wait, it is answered with that first
      // request's result, never a second project.
      return {
        kind: 'IN_PROGRESS',
        submissionId,
        replay,
        values,
        retryAfterSeconds: result.retryAfterSeconds,
        correlationId: result.correlationId,
      };
  }
}
