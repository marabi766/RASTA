'use server';

import { redirect } from 'next/navigation';

import { currentSession } from '@/server/current-session';
import { verifyCsrf } from '@/server/csrf';
import { isSubmissionId, SUBMISSION_FIELD } from '@/server/submission';
import { createDriver, createDriverFormValues, parseCreateDriverForm } from '@/server/drivers';

import type { CreateDriverFormState } from './form-state';

/**
 * The `/drivers` registration form's server action.
 *
 * Same order as `usage/actions.ts` (ADR-059 § 3, § 5), because it is the same
 * rule every write in this portal follows: session, then CSRF, then the
 * submission id, then the form, then the gateway.
 */

export async function submitCreateDriver(
  _previous: CreateDriverFormState,
  form: FormData,
): Promise<CreateDriverFormState> {
  const session = await currentSession();
  if (!session) return { kind: 'REFUSED', reason: 'NO_SESSION' };

  const csrf = verifyCsrf(session, form);
  if (!csrf.ok) return { kind: 'REFUSED', reason: 'CSRF' };

  const submissionId = form.get(SUBMISSION_FIELD);
  if (!isSubmissionId(submissionId)) return { kind: 'REFUSED', reason: 'SUBMISSION' };

  const values = createDriverFormValues(form);
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

  const result = await createDriver(session, parsed.request, submissionId);

  if (result.kind === 'CREATED') {
    // Redirect, not state: a refreshed page must not resubmit, and a fresh
    // form must carry a fresh submission id.
    redirect(`/drivers/${encodeURIComponent(result.data.id)}?created=1`);
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
    case 'MALFORMED':
      return { kind: 'FAILED', status: 502, correlationId: result.correlationId };
  }
}
