'use server';

import { redirect } from 'next/navigation';

import { FLASH_PARAM, REPLAY_FIELD } from '@/lib/form-fields';
import { isProvenRefusalStatus } from '@/lib/project-commands';
import {
  needFormValues,
  parseAddNeedForm,
  parseEditNeedForm,
  parseSubmitNeedForm,
  parseWithdrawNeedForm,
  withdrawNeedFormValues,
  type NeedField,
  type NeedFormValues,
  type WithdrawNeedField,
  type WithdrawNeedFormValues,
} from '@/lib/project-need-commands';
import { verifyCsrf } from '@/server/csrf';
import { currentSession, missingSessionReason } from '@/server/current-session';
import { mintFlash } from '@/server/flash';
import {
  addNeed,
  checkNeedStamp,
  needBodyDigest,
  needCreateScope,
  needStampTerms,
  submitNeed,
  unchangedNeedFields,
  updateNeed,
  withdrawNeed,
} from '@/server/project-need-commands';
import { isBoundSubmissionId, SUBMISSION_FIELD } from '@/server/submission';
import {
  releaseUnresolved,
  reserveUnresolved,
  settleUnresolved,
} from '@/server/unresolved-request';
import { MAX_CLOCK_SKEW_MS } from '@/server/unresolved-request-policy';

import {
  CONFIRM_DUPLICATE_NEED_FIELD,
  CONFIRM_DUPLICATE_NEED_VALUE,
  RELEASE_NEED_FIELD,
  type AddNeedFormState,
} from './need-form-state';
import { runNeedCommand } from './need-runner';
import type { ProjectFormState } from './project-form-state';

/**
 * The commands on a project's needs. Editing, submitting and withdrawing run
 * through `need-runner.ts`; adding is keyed and has its own path below.
 *
 * None of them reads a project id, a need id or a version from the form. The
 * target is the page's own, bound to the action by the form
 * (`action.bind(null, projectId, needId)`); the version comes from the baseline
 * the page signed for **that command**, and a baseline minted for another
 * command, another person, an earlier login or another need opens as nothing and
 * refuses the post before anything is parsed (`REFUSED/BASELINE`). Whether the
 * command is allowed is not decided here: construction-service decides — role,
 * tenant, the need's and the project's state — and its refusal is said in fixed
 * words.
 */

type State<V, F extends string> = ProjectFormState<V, F>;

export async function submitEditNeed(
  projectId: string,
  needId: string,
  _previous: State<NeedFormValues, NeedField>,
  form: FormData,
): Promise<State<NeedFormValues, NeedField>> {
  return runNeedCommand(
    {
      command: 'edit',
      notice: 'needUpdated',
      valuesOf: needFormValues,
      parse: (values, baseline) => parseEditNeedForm(values, unchangedNeedFields(baseline, values)),
      send: (session, baseline, body) =>
        updateNeed(session, baseline.projectId, baseline.needId, body, baseline.version),
    },
    projectId,
    needId,
    form,
  );
}

export async function submitSubmitNeed(
  projectId: string,
  needId: string,
  _previous: State<Readonly<Record<string, never>>, never>,
  form: FormData,
): Promise<State<Readonly<Record<string, never>>, never>> {
  return runNeedCommand(
    {
      command: 'submit',
      notice: 'needSubmitted',
      valuesOf: () => ({}),
      parse: parseSubmitNeedForm,
      send: (session, baseline) =>
        submitNeed(session, baseline.projectId, baseline.needId, baseline.version),
    },
    projectId,
    needId,
    form,
  );
}

export async function submitWithdrawNeed(
  projectId: string,
  needId: string,
  _previous: State<WithdrawNeedFormValues, WithdrawNeedField>,
  form: FormData,
): Promise<State<WithdrawNeedFormValues, WithdrawNeedField>> {
  return runNeedCommand(
    {
      command: 'withdraw',
      notice: 'needWithdrawn',
      valuesOf: withdrawNeedFormValues,
      parse: parseWithdrawNeedForm,
      send: (session, baseline, body) =>
        withdrawNeed(session, baseline.projectId, baseline.needId, body, baseline.version),
    },
    projectId,
    needId,
    form,
  );
}

/**
 * Adding a need. Same order as every write in this portal (ADR-059 § 3, § 5):
 * session, CSRF, the submission id, the stamp, the form, the reservation, and only
 * then the gateway.
 *
 * The request is reserved BEFORE the dispatch, in one atomic step on the server
 * (`server/unresolved-request.ts`), and settled by what the dispatch showed. It is
 * **never sent a second time**: the endpoint takes a key but no replay deadline,
 * so after a lost answer only the person's look at the needs — and, knowing the
 * risk, a release — can lead to another add.
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
  const reserved = await reserveUnresolved(session, needCreateScope(projectId), {
    key: submissionId,
    digest: needBodyDigest(session, parsed.body),
    ref: replay,
    issuedAt: terms.issuedAt,
    deadline: null,
    windowMs: null,
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

  // Re-checked right before the dispatch, after the reservation: the process may have been paused
  // between the reserve and here. `REFUSED` proves only that THIS attempt did nothing.
  if (Date.now() + MAX_CLOCK_SKEW_MS > terms.deadline) {
    await settleUnresolved(attempt, 'REFUSED');
    return { kind: 'EXPIRED', values };
  }

  let result;
  try {
    result = await addNeed(session, projectId, parsed.body, submissionId);
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
      `/projects/${encodeURIComponent(projectId)}?${FLASH_PARAM}=${mintFlash(session, projectId, 'needAdded')}`,
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
      await settleUnresolved(attempt, 'REFUSED');
      return { kind: 'NOT_FOUND', correlationId: result.correlationId };
    case 'UNAVAILABLE':
      // The request provably never left this portal: nothing was added, and the hold goes.
      if (result.neverSent) {
        await settleUnresolved(attempt, 'NEVER_SENT');
        return { kind: 'FAILED', status: result.status, correlationId: result.correlationId };
      }
      // Only a 4xx proves nothing was added; a 5xx may follow the commit.
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
  if (!verifyCsrf(session, form).ok) redirect(here);
  if (form.get(CONFIRM_DUPLICATE_NEED_FIELD) !== CONFIRM_DUPLICATE_NEED_VALUE) redirect(here);
  const outcome = await releaseUnresolved(
    session,
    needCreateScope(projectId),
    form.get(RELEASE_NEED_FIELD),
  );
  redirect(outcome === 'RELEASED' || outcome === 'GONE' ? here : `${here}?release=${outcome}`);
}
