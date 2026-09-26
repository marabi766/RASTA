/**
 * @jest-environment node
 */
import { CSRF_FIELD } from '@/server/csrf';
import { SUBMISSION_FIELD, newSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';

import { IDLE_TOP_UP_FORM } from './form-state';

/**
 * `/wallet`'s one write path — the same order-of-checks suite as
 * `drivers/[id]/actions.spec.ts`: session, CSRF, submission id, each proven
 * to call nothing on its own, plus the double-submit/retry-reuse case.
 */

const currentSession = jest.fn();
const topUpWallet = jest.fn();
const redirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock('@/server/current-session', () => ({ currentSession: () => currentSession() }));
jest.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));
jest.mock('@/server/wallet', () => {
  const actual = jest.requireActual('@/server/wallet');
  return { ...actual, topUpWallet: (...args: unknown[]) => topUpWallet(...args) };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const actions = require('./actions') as typeof import('./actions');
const { submitTopUp } = actions;

const SESSION = {
  subject: 'user-1',
  username: 'manager',
  organizationId: 'ORG-DEH-0001',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
} satisfies WebSession;

const WALLET_ID = 'WLT_1';

function formData(
  fields: Record<string, string>,
  options: { csrf?: string | null; submission?: string | null } = {},
): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const csrf = options.csrf === undefined ? SESSION.csrfToken : options.csrf;
  if (csrf !== null) form.set(CSRF_FIELD, csrf);
  const submission = options.submission === undefined ? newSubmissionId() : options.submission;
  if (submission !== null) form.set(SUBMISSION_FIELD, submission);
  return form;
}

beforeEach(() => {
  currentSession.mockResolvedValue(SESSION);
  topUpWallet.mockResolvedValue({
    kind: 'CREATED',
    data: { paymentIntentId: 'PI_1', transactionId: 'TXN_1' },
    correlationId: 'corr-sample',
  });
  redirect.mockClear();
});

describe('topping up — the full order of checks', () => {
  it('refuses a post with no session, and calls nothing', async () => {
    currentSession.mockResolvedValue(null);
    const state = await submitTopUp(WALLET_ID, IDLE_TOP_UP_FORM, formData({}));
    expect(state).toEqual({ kind: 'REFUSED', reason: 'NO_SESSION' });
    expect(topUpWallet).not.toHaveBeenCalled();
  });

  it('refuses a post with no CSRF token, and calls nothing', async () => {
    const state = await submitTopUp(
      WALLET_ID,
      IDLE_TOP_UP_FORM,
      formData({ amountMinor: '1000000' }, { csrf: null }),
    );
    expect(state).toEqual({ kind: 'REFUSED', reason: 'CSRF' });
    expect(topUpWallet).not.toHaveBeenCalled();
  });

  it('refuses a submission id this server did not mint, and calls nothing', async () => {
    const state = await submitTopUp(
      WALLET_ID,
      IDLE_TOP_UP_FORM,
      formData({ amountMinor: '1000000' }, { submission: 'chosen-by-the-client' }),
    );
    expect(state).toEqual({ kind: 'REFUSED', reason: 'SUBMISSION' });
    expect(topUpWallet).not.toHaveBeenCalled();
  });

  it('checks CSRF before the submission id', async () => {
    const state = await submitTopUp(
      WALLET_ID,
      IDLE_TOP_UP_FORM,
      formData({ amountMinor: '1000000' }, { csrf: 'wrong', submission: 'also-wrong' }),
    );
    expect(state).toEqual({ kind: 'REFUSED', reason: 'CSRF' });
  });

  it('does not call the service for a blank amount', async () => {
    const state = await submitTopUp(WALLET_ID, IDLE_TOP_UP_FORM, formData({ amountMinor: '' }));
    expect(state).toMatchObject({ kind: 'INVALID' });
    expect(topUpWallet).not.toHaveBeenCalled();
  });

  it('sends the bound wallet id and the parsed minor-unit amount, not one read from a hidden field', async () => {
    await expect(
      submitTopUp(WALLET_ID, IDLE_TOP_UP_FORM, formData({ amountMinor: '1,000,000' })),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    expect(topUpWallet).toHaveBeenCalledWith(
      SESSION,
      WALLET_ID,
      { amountMinor: '1000000' },
      expect.any(String),
    );
  });

  it('redirects to /wallet with ?toppedUp=1 after a successful top-up', async () => {
    await expect(
      submitTopUp(WALLET_ID, IDLE_TOP_UP_FORM, formData({ amountMinor: '1000000' })),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirect).toHaveBeenCalledWith('/wallet?toppedUp=1');
  });

  it('sends one submission twice under one reference — the double-submit case', async () => {
    const submission = newSubmissionId();
    const form = () => formData({ amountMinor: '1000000' }, { submission });

    await expect(submitTopUp(WALLET_ID, IDLE_TOP_UP_FORM, form())).rejects.toThrow(/NEXT_REDIRECT/);
    await expect(submitTopUp(WALLET_ID, IDLE_TOP_UP_FORM, form())).rejects.toThrow(/NEXT_REDIRECT/);

    const ids = topUpWallet.mock.calls.map((args) => args[3]);
    expect(ids).toEqual([submission, submission]);
  });

  it('returns the service refusal as a banner', async () => {
    topUpWallet.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: {},
      message: 'مبلغ باید بیشتر از صفر باشد',
      correlationId: 'corr-sample',
    });
    const state = await submitTopUp(
      WALLET_ID,
      IDLE_TOP_UP_FORM,
      formData({ amountMinor: '1000000' }),
    );
    expect(state).toMatchObject({ kind: 'INVALID', message: 'مبلغ باید بیشتر از صفر باشد' });
    expect(redirect).not.toHaveBeenCalled();
  });
});
