'use server';

import { redirect } from 'next/navigation';
import { currentSession, missingSessionReason } from '@/server/current-session';
import { verifyCsrf } from '@/server/csrf';
import { settleRelease } from '@/server/release-feedback';
import { isBoundSubmissionId, SUBMISSION_FIELD } from '@/server/submission';
import { createDriver, createDriverFormValues, parseCreateDriverForm } from '@/server/drivers';

import { driverCreationRequest } from '@/server/create-request';
import { keepUnconfirmedWith } from '@/server/unconfirmed-retry';
import type { CreateDriverFormState } from './form-state';

/**
 * The `/drivers` registration form's server action.
 *
 * Same order as `usage/actions.ts` (ADR-059 § 3, § 5), because it is the same
 * rule every write in this portal follows: session, then CSRF, then the
 * submission id, then the form, then the gateway.
 */

export async function submitCreateDriver(
  previous: CreateDriverFormState,
  form: FormData,
): Promise<CreateDriverFormState> {
  return keepUnconfirmedWith(
    previous,
    form,
    () => attemptCreateDriver(form),
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

async function attemptCreateDriver(form: FormData): Promise<CreateDriverFormState> {
  const session = await currentSession();
  if (!session) return { kind: 'REFUSED', reason: await missingSessionReason() };

  const csrf = verifyCsrf(session, form);
  if (!csrf.ok) return { kind: 'REFUSED', reason: 'CSRF' };

  const submissionId = form.get(SUBMISSION_FIELD);
  if (!isBoundSubmissionId(submissionId, session)) return { kind: 'REFUSED', reason: 'SUBMISSION' };

  const restored = await driverCreationRequest.restore(session);
  if (restored.kind !== 'IDLE') return restored;

  const values = driverCreationRequest.values(createDriverFormValues(form));
  const parsed = parseCreateDriverForm(values);
  if (!parsed.ok) {
    return {
      kind: 'INVALID',
      submissionId,
      values,
      fieldErrors: parsed.fieldErrors,
      message: null,
    };
  }

  const sent = await driverCreationRequest.send(session, submissionId, values, parsed.request, () =>
    createDriver(session, parsed.request, submissionId),
  );
  if (sent.kind !== 'RESULT') return sent;
  const result = sent.result;

  if (result.kind === 'CREATED') {
    // Redirect, not state: a refreshed page must not resubmit, and a fresh
    // form must carry a fresh submission id.
    redirect(`/drivers/${encodeURIComponent(result.data.id)}`);
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
      // fleet-service never answers 404 for this endpoint — there is no
      // referenced resource to be absent — but the type is shared across
      // every write, so it is handled rather than assumed away.
      return { kind: 'FAILED', status: 404, correlationId: result.correlationId };
    case 'UNAVAILABLE':
      return { kind: 'FAILED', status: result.status, correlationId: result.correlationId };
    case 'IN_PROGRESS':
    case 'UNKNOWN_OUTCOME':
      // Sent, maybe committed, not confirmed: never "nothing was saved". In
      // progress is the same unknown: another request with this submission id
      // is still in flight (only the report form offers a timed retry).
      return { kind: 'UNCONFIRMED', correlationId: result.correlationId };
  }
}

/** Reconciliation only: compare-and-delete of the signed record, never a domain write. */
export async function releaseUnresolvedDriverCreation(form: FormData): Promise<void> {
  const session = await currentSession();
  if (!session) redirect('/login?returnTo=/drivers');
  return settleRelease({
    session,
    form,
    back: '/drivers',
    subject: { surface: 'driver-creation' },
    release: driverCreationRequest.release,
    quietSuccess: true,
  });
}
