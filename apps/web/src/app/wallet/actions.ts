'use server';

import { redirect } from 'next/navigation';

import { currentSession } from '@/server/current-session';
import { verifyCsrf } from '@/server/csrf';
import { isSubmissionId, SUBMISSION_FIELD } from '@/server/submission';
import { parseTopUpForm, topUpFormValues, topUpWallet } from '@/server/wallet';

import type { TopUpFormState } from './form-state';

/**
 * `/wallet`'s one server action.
 *
 * Same order as every write in this portal (ADR-059 § 3, § 5): session, CSRF,
 * submission id, the form, the gateway. `walletId` is bound rather than a
 * form field — the page already read the caller's own wallet, and a hidden
 * field a person could edit is not how a wallet id should travel.
 */
export async function submitTopUp(
  walletId: string,
  _previous: TopUpFormState,
  form: FormData,
): Promise<TopUpFormState> {
  const session = await currentSession();
  if (!session) return { kind: 'REFUSED', reason: 'NO_SESSION' };

  const csrf = verifyCsrf(session, form);
  if (!csrf.ok) return { kind: 'REFUSED', reason: 'CSRF' };

  const submissionId = form.get(SUBMISSION_FIELD);
  if (!isSubmissionId(submissionId)) return { kind: 'REFUSED', reason: 'SUBMISSION' };

  const values = topUpFormValues(form);
  const parsed = parseTopUpForm(values);
  if (!parsed.ok) {
    return {
      kind: 'INVALID',
      submissionId,
      values,
      fieldErrors: parsed.fieldErrors,
      message: null,
    };
  }

  const result = await topUpWallet(session, walletId, parsed.request, submissionId);

  if (result.kind === 'CREATED') {
    redirect('/wallet?toppedUp=1');
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
    case 'MALFORMED':
      return { kind: 'FAILED', status: 502, correlationId: result.correlationId };
  }
}
