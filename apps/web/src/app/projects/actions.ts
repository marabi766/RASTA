'use server';

import { redirect } from 'next/navigation';

import { FLASH_PARAM, REPLAY_FIELD } from '@/lib/form-fields';
import { isProvenRefusalStatus, parseCreateForm, projectFormValues } from '@/lib/project-commands';
import { verifyCsrf } from '@/server/csrf';
import { currentSession, missingSessionReason } from '@/server/current-session';
import { mintFlash } from '@/server/flash';
import { createProject } from '@/server/project-commands';
import {
  checkCreateStamp,
  createBodyDigest,
  createStampTerms,
  PROJECT_CREATE_UNRESOLVED,
} from '@/server/project-create-replay';
import { isBoundSubmissionId, SUBMISSION_FIELD } from '@/server/submission';
import {
  releaseUnresolved,
  reserveUnresolved,
  settleUnresolved,
} from '@/server/unresolved-request';

import {
  CONFIRM_DUPLICATE_FIELD,
  CONFIRM_DUPLICATE_VALUE,
  RELEASE_FIELD,
  type CreateProjectFormState,
} from './form-state';

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

  // Reserved BEFORE the dispatch, in one atomic step on the server
  // (`server/unresolved-request.ts`): an earlier request of this scope that is
  // unresolved, or in flight in another tab, holds this one back — the only
  // request that may go out is that very one, its key and its body, and only
  // one at a time. The store unreachable is not "no hold": nothing is sent.
  const terms = createStampTerms(session, replay, submissionId);
  if (terms === null) return { kind: 'REFUSED', reason: 'SUBMISSION' };
  const reserved = await reserveUnresolved(session, PROJECT_CREATE_UNRESOLVED, {
    key: submissionId,
    digest: createBodyDigest(session, parsed.body),
    ref: replay,
    issuedAt: terms.issuedAt,
    deadline: terms.deadline,
    windowMs: terms.windowMs,
  });
  switch (reserved.kind) {
    case 'UNAVAILABLE':
      return { kind: 'NOT_CHECKED', values };
    case 'CAPACITY':
      return { kind: 'CAPACITY', values };
    case 'EXPIRED':
      return { kind: 'EXPIRED', values };
    case 'HELD':
      return {
        kind: 'HELD',
        reason: reserved.reason === 'RECONCILE_ONLY' ? 'OTHER_REQUEST' : reserved.reason,
        values,
      };
    case 'RESERVED':
      break;
  }
  const { attempt } = reserved;

  let result;
  try {
    result = await createProject(session, parsed.body, submissionId);
  } catch (error) {
    // Anything unexpected after the request may have gone out: unresolved.
    await settleUnresolved(attempt, 'UNRESOLVED');
    throw error;
  }

  if (result.kind === 'CREATED') {
    await settleUnresolved(attempt, 'CONFIRMED');
    // Redirect, not state: a refreshed page must not resubmit, and a fresh
    // form must carry a fresh submission id.
    redirect(
      `/projects/${encodeURIComponent(result.data.id)}?${FLASH_PARAM}=${mintFlash(session, result.data.id, 'created')}`,
    );
  }

  switch (result.kind) {
    case 'INVALID':
      await settleUnresolved(attempt, 'REFUSED');
      return {
        kind: 'INVALID',
        submissionId,
        replay,
        values,
        fieldErrors: result.fieldErrors,
        message: result.message,
      };
    case 'FORBIDDEN':
      await settleUnresolved(attempt, 'REFUSED');
      return { kind: 'FORBIDDEN', correlationId: result.correlationId };
    case 'NOT_FOUND':
      // construction-service never answers 404 for this endpoint — there is no
      // referenced resource to be absent — but the type is shared across every
      // write, so it is handled rather than assumed away.
      await settleUnresolved(attempt, 'REFUSED');
      return { kind: 'FAILED', status: 404, correlationId: result.correlationId };
    case 'UNAVAILABLE':
      // The request provably never left this portal: nothing was created, and
      // the hold this attempt made goes (or, for a retry, goes back).
      if (result.neverSent) {
        await settleUnresolved(attempt, 'NEVER_SENT');
        return { kind: 'FAILED', status: result.status, correlationId: result.correlationId };
      }
      // Only a 4xx proves nothing was created; a 5xx may follow the commit.
      if (!isProvenRefusalStatus(result.status)) {
        await settleUnresolved(attempt, 'UNRESOLVED');
        return { kind: 'UNCONFIRMED', correlationId: result.correlationId };
      }
      await settleUnresolved(attempt, 'REFUSED');
      return { kind: 'FAILED', status: result.status, correlationId: result.correlationId };
    case 'UNKNOWN_OUTCOME':
      // Sent, maybe committed, not confirmed: never "nothing was saved".
      await settleUnresolved(attempt, 'UNRESOLVED');
      return { kind: 'UNCONFIRMED', correlationId: result.correlationId };
    case 'IN_PROGRESS':
      // The first submission of this form is still being processed — a double
      // press, or a create slower than the service waits for. Same values, same
      // submission id: sent again after the wait, it is answered with that first
      // request's result, never a second project.
      await settleUnresolved(attempt, 'UNRESOLVED');
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

/**
 * "Send as new": lets go of the unresolved create so the next form carries a
 * fresh key. Only with the confirmation that names the risk — the person checked
 * the **full** project list (a filtered one proves nothing: and not even the
 * full one, which is capped and permission-filtered, proves the first request
 * did not happen) and accepts that a second project may result. The form names
 * the record it was drawn for; if that is no longer the current one nothing
 * changes. Without the confirmation nothing changes either.
 */
export async function releaseUnresolvedCreate(form: FormData): Promise<void> {
  const session = await currentSession();
  if (!session) redirect('/login?returnTo=/projects');
  if (!verifyCsrf(session, form).ok) redirect('/projects');
  if (form.get(CONFIRM_DUPLICATE_FIELD) !== CONFIRM_DUPLICATE_VALUE) redirect('/projects');
  const outcome = await releaseUnresolved(
    session,
    PROJECT_CREATE_UNRESOLVED,
    form.get(RELEASE_FIELD),
  );
  redirect(
    outcome === 'RELEASED' || outcome === 'GONE' ? '/projects' : `/projects?release=${outcome}`,
  );
}
