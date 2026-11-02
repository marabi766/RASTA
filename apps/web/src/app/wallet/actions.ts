'use server';

import { redirect } from 'next/navigation';

import { MONEY_EFFECTS, demoModeOf } from '@/lib/demo-mode';
import { currentSession, missingSessionReason } from '@/server/current-session';
import { verifyCsrf } from '@/server/csrf';
import type { WebSession } from '@/server/session';
import { isBoundSubmissionId, SUBMISSION_FIELD } from '@/server/submission';
import { mayDispatch } from '@/server/money-gate';
import {
  fetchPaymentProvider,
  parseTopUpForm,
  topUpFormValues,
  topUpWallet,
} from '@/server/wallet';

import type { TopUpFormState } from './form-state';

/**
 * `/wallet`'s one server action.
 *
 * Same order as every write in this portal (ADR-059 § 3, § 5): session, CSRF,
 * submission id, the form, the gateway. Before the gateway, the provider is
 * read again by the read the page drew the form from — the administrators'
 * provider read — and nothing is sent unless it answers (`mayDispatch`). `walletId` is bound rather than a
 * form field — the page already read the caller's own wallet, and a hidden
 * field a person could edit is not how a wallet id should travel.
 */
export async function submitTopUp(
  walletId: string,
  _previous: TopUpFormState,
  form: FormData,
): Promise<TopUpFormState> {
  const session = await currentSession();
  if (!session) return { kind: 'REFUSED', reason: await missingSessionReason() };

  const csrf = verifyCsrf(session, form);
  if (!csrf.ok) return { kind: 'REFUSED', reason: 'CSRF' };

  const submissionId = form.get(SUBMISSION_FIELD);
  if (!isBoundSubmissionId(submissionId, session)) return { kind: 'REFUSED', reason: 'SUBMISSION' };

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

  const provider = async (s: WebSession) => demoModeOf(await fetchPaymentProvider(s));
  if (!(await mayDispatch(session, MONEY_EFFECTS.walletTopUp, provider))) {
    return { kind: 'REFUSED', reason: 'PROVIDER_UNKNOWN' };
  }

  const result = await topUpWallet(session, walletId, parsed.request, submissionId);

  if (result.kind === 'CREATED') {
    // Nothing on the page reads a confirmation flag, so none is carried (PR 405 review 2, F2):
    // the balance it reads again is the confirmation.
    redirect('/wallet');
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
    case 'IN_PROGRESS':
    case 'UNKNOWN_OUTCOME':
      // Sent, maybe committed, not confirmed: never "nothing was saved". In
      // progress is the same unknown: another request with this submission id
      // is still in flight (only the report form offers a timed retry).
      return { kind: 'UNCONFIRMED', correlationId: result.correlationId };
  }
}
