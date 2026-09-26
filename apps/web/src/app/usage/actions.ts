'use server';

import { redirect } from 'next/navigation';

import { currentSession } from '@/server/current-session';
import { verifyCsrf } from '@/server/csrf';
import { isSubmissionId, SUBMISSION_FIELD } from '@/server/submission';
import { parseUsageForm, recordUsage, usageFormValues } from '@/server/usage';

import type { UsageFormState } from './form-state';

/**
 * The `/usage` form's server action — the first write path in the portal.
 *
 * A server action rather than a route handler because it is the one shape
 * that works both ways: with JavaScript, React posts to it and renders the
 * returned state in place; without, the browser posts the form to the page
 * and Next runs the same function and re-renders the page with the same
 * state (`useActionState`'s `permalink`). One function, one set of tests,
 * no second "no-JS" implementation that would be the one nobody exercised.
 *
 * The order inside is the order the ADR requires (ADR-059 § 3, § 5):
 *
 *   1. the session — no session, nothing else happens;
 *   2. CSRF — refused before the body is even read into a request;
 *   3. the submission id — refused if it is not one this server minted;
 *   4. the form, in Persian, for what a form can see;
 *   5. the gateway, which is where every real decision is made.
 *
 * Nothing token-shaped is in the state this returns; the state is rendered
 * into the page and would be visible to any script on it.
 */

export async function submitUsage(
  _previous: UsageFormState,
  form: FormData,
): Promise<UsageFormState> {
  const session = await currentSession();
  if (!session) return { kind: 'REFUSED', reason: 'NO_SESSION' };

  const csrf = verifyCsrf(session, form);
  if (!csrf.ok) return { kind: 'REFUSED', reason: 'CSRF' };

  const submissionId = form.get(SUBMISSION_FIELD);
  if (!isSubmissionId(submissionId)) return { kind: 'REFUSED', reason: 'SUBMISSION' };

  const values = usageFormValues(form);
  const parsed = parseUsageForm(values, submissionId);
  if (!parsed.ok) {
    return {
      kind: 'INVALID',
      submissionId,
      values,
      fieldErrors: parsed.fieldErrors,
      message: null,
    };
  }

  const result = await recordUsage(session, parsed.request);

  if (result.kind === 'CREATED') {
    // Redirect, not state: a refreshed page must not resubmit, and a fresh
    // form must carry a fresh submission id. The record id is not sensitive
    // and the query string is the only channel that survives a redirect
    // without JavaScript.
    redirect(`/usage?created=${encodeURIComponent(result.data.id)}`);
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
    case 'NOT_FOUND':
      // The machine is not one this person may record against — an operator
      // who is not holding it, or an id from another organization. The
      // service says "absent"; the form says so on the field that named it.
      return { kind: 'NOT_FOUND', submissionId, values, correlationId: result.correlationId };
    case 'FORBIDDEN':
      return { kind: 'FORBIDDEN', correlationId: result.correlationId };
    case 'UNAVAILABLE':
      return { kind: 'FAILED', status: result.status, correlationId: result.correlationId };
    case 'UNKNOWN_OUTCOME':
      // Sent, maybe committed, not confirmed: never "nothing was saved".
      return { kind: 'UNCONFIRMED', correlationId: result.correlationId };
  }
}
