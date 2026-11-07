'use server';

import { redirect } from 'next/navigation';
import {
  CONFIRM_DUPLICATE_FIELD,
  CONFIRM_DUPLICATE_VALUE,
  RELEASE_FIELD,
} from '@/app/projects/form-state';

import { currentSession, missingSessionReason } from '@/server/current-session';
import { verifyCsrf } from '@/server/csrf';
import { FLASH_PARAM } from '@/lib/form-fields';
import { mintFlash } from '@/server/flash';
import { isBoundSubmissionId, SUBMISSION_FIELD } from '@/server/submission';
import {
  parseRegisterAssetForm,
  registerAsset,
  registerAssetFormValues,
} from '@/server/asset-commands';

import { assetRegistrationRequest } from '@/server/create-request';
import { keepUnconfirmedWith } from '@/server/unconfirmed-retry';
import type { RegisterAssetFormState } from './form-state';
import { pageContext } from '@/server/page-context';
import { withContext } from '@/lib/page-context';

/**
 * The `/assets` registration form's server action.
 *
 * Same order as every write in this portal (ADR-059 § 3, § 5): session, then
 * CSRF, then the submission id, then the form, then the gateway. Each refusal
 * is decided before the next step runs, so a refused post never reaches the
 * gateway — which is what the spec beside this file asserts.
 */

export async function submitRegisterAsset(
  previous: RegisterAssetFormState,
  form: FormData,
): Promise<RegisterAssetFormState> {
  return keepUnconfirmedWith(
    previous,
    form,
    () => attemptRegisterAsset(form),
    (correlationId, state, held) => ({
      kind: 'UNCONFIRMED',
      correlationId,
      releaseToken:
        'releaseToken' in state
          ? state.releaseToken
          : 'releaseToken' in held
            ? held.releaseToken
            : undefined,
    }),
  );
}

async function attemptRegisterAsset(form: FormData): Promise<RegisterAssetFormState> {
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

  const restored = await assetRegistrationRequest.restore(session);
  if (restored.kind !== 'IDLE') return restored;

  const values = assetRegistrationRequest.values(registerAssetFormValues(form));
  const parsed = parseRegisterAssetForm(values);
  if (!parsed.ok) {
    return {
      kind: 'INVALID',
      submissionId,
      values,
      fieldErrors: parsed.fieldErrors,
      message: null,
    };
  }

  const sent = await assetRegistrationRequest.send(
    session,
    submissionId,
    values,
    parsed.request,
    () => registerAsset(session, parsed.request, submissionId),
  );
  if (sent.kind !== 'RESULT') return sent;
  const result = sent.result;

  if (result.kind === 'CREATED') {
    // Redirect, not state: a refreshed page must not resubmit, and a fresh
    // form must carry a fresh submission id.
    redirect(
      withContext(
        pageContext(session),
        `/assets/${encodeURIComponent(result.data.id)}?${FLASH_PARAM}=${mintFlash(session, result.data.id, 'created')}`,
      ),
    );
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
      // asset-service never answers 404 for this endpoint — there is no
      // referenced resource to be absent — but the type is shared across
      // every write, so it is handled rather than assumed away.
      return { kind: 'FAILED', status: 404, correlationId: result.correlationId };
    case 'UNAVAILABLE':
      return { kind: 'FAILED', status: result.status, correlationId: result.correlationId };
    case 'IN_PROGRESS':
    case 'UNKNOWN_OUTCOME':
      // Sent, maybe committed, not confirmed: never "nothing was saved". In
      // progress is the same unknown: the first request with this submission id
      // is still being processed (409 + Retry-After, #193), and sending the same
      // form again after the wait is answered with its result.
      return { kind: 'UNCONFIRMED', correlationId: result.correlationId };
  }
}

/** Reconciliation only: compare-and-delete of the signed record, never a domain write. */
export async function releaseUnresolvedAssetRegistration(form: FormData): Promise<void> {
  const session = await currentSession();
  if (!session) redirect('/login?returnTo=/assets');
  if (!verifyCsrf(session, form).ok) redirect('/assets');
  if (form.get(CONFIRM_DUPLICATE_FIELD) !== CONFIRM_DUPLICATE_VALUE) redirect('/assets');
  await assetRegistrationRequest.release(session, form.get(RELEASE_FIELD));
  redirect('/assets');
}
