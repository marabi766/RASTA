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

import { keepUnconfirmed } from '@/server/unconfirmed-retry';
import { restoreTopUp, topUpScope, topUpSnapshot } from '@/server/top-up-request';
import {
  releaseUnresolved,
  reserveUnresolved,
  requestDigest,
  settleUnresolved,
} from '@/server/unresolved-request';
import { pageHref } from '@/server/page-context';
import { isProvenRefusal } from '@/server/write';

import {
  CONFIRM_DUPLICATE_FIELD,
  CONFIRM_DUPLICATE_VALUE,
  RELEASE_FIELD,
  type TopUpFormState,
} from './form-state';

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
  previous: TopUpFormState,
  form: FormData,
): Promise<TopUpFormState> {
  return keepUnconfirmed(previous, form, () => attemptTopUp(walletId, form));
}

async function attemptTopUp(walletId: string, form: FormData): Promise<TopUpFormState> {
  const session = await currentSession();
  if (!session) return { kind: 'REFUSED', reason: await missingSessionReason() };

  const csrf = verifyCsrf(session, form);
  if (!csrf.ok) return { kind: 'REFUSED', reason: 'CSRF' };

  const submissionId = form.get(SUBMISSION_FIELD);
  if (!isBoundSubmissionId(submissionId, session)) return { kind: 'REFUSED', reason: 'SUBMISSION' };

  const restored = await restoreTopUp(session, walletId);
  if (restored.kind !== 'IDLE') return restored;

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

  const scope = topUpScope(walletId);
  const ref = topUpSnapshot(session, walletId, submissionId, parsed.request.amountMinor);
  if (ref.length > 800) return { kind: 'NOT_CHECKED', reason: 'SNAPSHOT_TOO_LARGE' };
  const reserved = await reserveUnresolved(session, scope, {
    key: submissionId,
    digest: requestDigest(session, scope.purpose, parsed.request),
    ref,
    issuedAt: Date.now(),
    deadline: null,
    windowMs: null,
  });
  if (reserved.kind === 'CAPACITY') return { kind: 'NOT_CHECKED', reason: 'CAPACITY' };
  if (reserved.kind !== 'RESERVED')
    return restoreTopUp(session, walletId).then((state) =>
      state.kind === 'IDLE' ? { kind: 'NOT_CHECKED', reason: 'STORE_UNAVAILABLE' } : state,
    );
  let result;
  try {
    result = await topUpWallet(session, walletId, parsed.request, submissionId);
  } catch (error) {
    await settleUnresolved(reserved.attempt, 'UNRESOLVED');
    throw error;
  }
  const ambiguous =
    result.kind === 'UNKNOWN_OUTCOME' ||
    result.kind === 'IN_PROGRESS' ||
    (result.kind === 'UNAVAILABLE' &&
      !result.neverSent &&
      !isProvenRefusal(result.status, result.code));
  await settleUnresolved(
    reserved.attempt,
    result.kind === 'CREATED' ? 'CONFIRMED' : ambiguous ? 'UNRESOLVED' : 'REFUSED',
  );
  if (ambiguous)
    return {
      kind: 'UNCONFIRMED',
      correlationId: result.correlationId,
      submissionId,
      values: { amountMinor: parsed.request.amountMinor },
    };

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

/** Explicit reconciliation only; the signed record id prevents a stale tab releasing a newer hold. */
export async function releaseUnresolvedTopUp(walletId: string, form: FormData): Promise<void> {
  const session = await currentSession();
  if (!session) redirect('/login?returnTo=/wallet');
  if (!verifyCsrf(session, form).ok) redirect('/wallet');
  if (form.get(CONFIRM_DUPLICATE_FIELD) !== CONFIRM_DUPLICATE_VALUE) redirect('/wallet');
  const outcome = await releaseUnresolved(session, topUpScope(walletId), form.get(RELEASE_FIELD));
  redirect(pageHref(session, '/wallet', { release: outcome }));
}
