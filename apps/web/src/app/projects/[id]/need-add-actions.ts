'use server';

import { redirect } from 'next/navigation';

import { FLASH_PARAM, REPLAY_FIELD } from '@/lib/form-fields';
import { withContext } from '@/lib/page-context';
import { needFormValues, parseAddNeedForm } from '@/lib/project-need-commands';
import { verifyCsrf } from '@/server/csrf';
import { currentSession, missingSessionReason } from '@/server/current-session';
import { mintFlash } from '@/server/flash';
import { pageContext } from '@/server/page-context';
import {
  addNeed,
  addNeedRequest,
  checkNeedStamp,
  needBodyDigest,
  needCreateRelease,
  needCreateScope,
  needStampTerms,
} from '@/server/project-need-commands';
import { settleRelease } from '@/server/release-feedback';
import { isBoundSubmissionId, SUBMISSION_FIELD } from '@/server/submission';
import { reserveUnresolved, settleUnresolved } from '@/server/unresolved-request';
import { MAX_CLOCK_SKEW_MS } from '@/server/unresolved-request-policy';
import { isProvenRefusal } from '@/server/write';

import { type AddNeedFormState } from './need-form-state';

/**
 * Adding a need to a project, and letting go of an unresolved add. A module of its
 * own because its retries are kept by the server-side store
 * (`server/unresolved-request.ts`, `SERVER_STORE` in `unconfirmed-retry-guard.spec.ts`),
 * like `/projects`' create, while the versioned need commands (`need-actions.ts`)
 * follow the shared previous-state rule.
 */

/**
 * Adding a need. Same order as every write in this portal (ADR-059 § 3, § 5):
 * session, CSRF, the submission id, the stamp, the form, the reservation, and only
 * then the gateway.
 *
 * The request is reserved BEFORE the dispatch, in one atomic step on the server
 * (`server/unresolved-request.ts`), and settled by what the dispatch showed. The
 * portal never sends it a second time for the person: after a lost answer only the
 * person's look at the needs — and, knowing the risk, a release — can lead to
 * another add.
 *
 * What makes a late execution impossible is not this portal: the add carries the
 * stamp's signed deadline (`Idempotency-Replay-Deadline`) and the project version
 * the stamp was drawn at (`expectedProjectVersion`), and construction-service
 * refuses — on the clock that expires its key, under the project's row lock — an
 * execution past the deadline (`REPLAY_WINDOW_CLOSED`) or in a later editing
 * episode (`OPTIMISTIC_LOCK_FAILED`). Both come from the signed stamp only.
 */
export async function submitAddNeed(
  projectId: string,
  _previous: AddNeedFormState,
  form: FormData,
): Promise<AddNeedFormState> {
  const session = await currentSession();
  if (!session) return { kind: 'REFUSED', reason: await missingSessionReason() };

  const csrf = verifyCsrf(session, form);
  if (!csrf.ok) return { kind: 'REFUSED', reason: 'CSRF' };

  const submissionId = form.get(SUBMISSION_FIELD);
  if (!isBoundSubmissionId(submissionId, session)) {
    return { kind: 'REFUSED', reason: 'SUBMISSION' };
  }

  const values = needFormValues(form);

  // Until when this request may be sent under its key: the signed stamp the page drew the form with,
  // for this project. Past it the service no longer remembers the key, and a send would be a second
  // add of a request that may have committed.
  const replay = form.get(REPLAY_FIELD);
  const sendable = checkNeedStamp(session, replay, submissionId, projectId);
  if (sendable === null || typeof replay !== 'string') {
    return { kind: 'REFUSED', reason: 'SUBMISSION' };
  }
  if (sendable === 'EXPIRED') return { kind: 'EXPIRED', values };

  const parsed = parseAddNeedForm(values);
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

  const terms = needStampTerms(session, replay, submissionId, projectId);
  if (terms === null) return { kind: 'REFUSED', reason: 'SUBMISSION' };
  // The body as it is sent and digested: the parent fence is part of it (the service hashes it too).
  const body = addNeedRequest(parsed.body, terms.projectVersion);
  const reserved = await reserveUnresolved(session, needCreateScope(projectId), {
    key: submissionId,
    digest: needBodyDigest(session, body),
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
        reason: reserved.reason === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'OTHER_REQUEST',
        values,
      };
    case 'RESERVED':
      break;
  }
  const { attempt } = reserved;
  // A refusal (or a send that never left) proves only that THIS attempt did nothing (PR-830 r1 F1): a
  // retry's earlier attempt may have added the need. `project-need-create` is `retry: false`, so the
  // store answers an existing record HELD and this is false today; it stays right if that changes.
  const refused = (state: AddNeedFormState, correlationId: string): AddNeedFormState =>
    reserved.retry ? { kind: 'UNCONFIRMED', correlationId } : state;

  // Re-checked right before the dispatch, after the reservation (UX only, D-065): a send this lets
  // through is still refused by construction-service once its own clock is past the deadline it
  // carries. No deadline is no send (fail closed).
  const deadline = reserved.deadline;
  if (deadline === null || Date.now() + MAX_CLOCK_SKEW_MS > deadline) {
    await settleUnresolved(attempt, 'REFUSED');
    return { kind: 'EXPIRED', values };
  }

  let result;
  try {
    result = await addNeed(session, projectId, body, submissionId, deadline);
  } catch (error) {
    // Anything unexpected after the request may have gone out: unresolved.
    await settleUnresolved(attempt, 'UNRESOLVED');
    throw error;
  }

  if (result.kind === 'CREATED') {
    await settleUnresolved(attempt, 'CONFIRMED');
    // Redirect, not state: a refreshed page must not resubmit, and a fresh form
    // must carry a fresh submission id.
    redirect(
      withContext(
        pageContext(session),
        `/projects/${encodeURIComponent(projectId)}?${FLASH_PARAM}=${mintFlash(session, projectId, 'needAdded')}`,
      ),
    );
  }

  switch (result.kind) {
    case 'INVALID':
      await settleUnresolved(attempt, 'REFUSED');
      return refused(
        {
          kind: 'INVALID',
          submissionId,
          replay,
          values,
          fieldErrors: result.fieldErrors,
          message: result.message,
        },
        result.correlationId,
      );
    case 'FORBIDDEN':
      await settleUnresolved(attempt, 'REFUSED');
      return refused(
        { kind: 'FORBIDDEN', correlationId: result.correlationId },
        result.correlationId,
      );
    case 'NOT_FOUND':
      await settleUnresolved(attempt, 'REFUSED');
      return refused(
        { kind: 'NOT_FOUND', correlationId: result.correlationId },
        result.correlationId,
      );
    case 'UNAVAILABLE':
      // The service's clock is past the deadline this add carried (`REPLAY_WINDOW_CLOSED`): refused
      // before it wrote anything. Proves this attempt did nothing — never that an earlier press did not —
      // so the person is told to check the needs first.
      if (result.replayWindowClosed) {
        await settleUnresolved(attempt, 'REFUSED');
        return { kind: 'EXPIRED', values };
      }
      // The request provably never left this portal: nothing was added, and the hold goes.
      if (result.neverSent) {
        await settleUnresolved(attempt, 'NEVER_SENT');
        return refused(
          { kind: 'FAILED', status: result.status, correlationId: result.correlationId },
          result.correlationId,
        );
      }
      // Only a documented 4xx proves nothing was added (the writer's one rule); a 5xx may follow the commit.
      if (!isProvenRefusal(result.status, result.code)) {
        await settleUnresolved(attempt, 'UNRESOLVED');
        return { kind: 'UNCONFIRMED', correlationId: result.correlationId };
      }
      await settleUnresolved(attempt, 'REFUSED');
      return refused(
        { kind: 'FAILED', status: result.status, correlationId: result.correlationId },
        result.correlationId,
      );
    case 'UNKNOWN_OUTCOME':
      // Sent, maybe committed, not confirmed: never "nothing was saved".
      await settleUnresolved(attempt, 'UNRESOLVED');
      return { kind: 'UNCONFIRMED', correlationId: result.correlationId };
    case 'IN_PROGRESS':
      // The service is still processing the first request. It may yet commit; it is not sent again.
      await settleUnresolved(attempt, 'UNRESOLVED');
      return { kind: 'PROCESSING', correlationId: result.correlationId };
  }
}

/**
 * "Send as new": lets go of the unresolved add so the next form carries a fresh
 * key. Only with the confirmation that names the risk — the person looked at the
 * project's needs (a page of them is not proof either) and accepts that a second
 * need may result. The form names the record it was drawn for; if that is no longer
 * the current one nothing changes. Without the confirmation nothing changes either.
 */
export async function releaseUnresolvedNeed(projectId: string, form: FormData): Promise<void> {
  const here = `/projects/${encodeURIComponent(projectId)}`;
  const session = await currentSession();
  if (!session) redirect(`/login?returnTo=${encodeURIComponent(here)}`);
  return settleRelease({
    session,
    form,
    back: here,
    // Namespaced to this project: a token minted for another project's page is read by none.
    subject: { surface: 'project-need-creation', target: projectId },
    scope: needCreateRelease(projectId),
    quietSuccess: true,
  });
}
