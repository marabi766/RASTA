/**
 * @jest-environment node
 */
import { CSRF_FIELD } from '@/server/csrf';
import { SUBMISSION_FIELD, mintSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';

import WalletPage from './page';
import {
  CONFIRM_DUPLICATE_FIELD,
  CONFIRM_DUPLICATE_VALUE,
  RELEASE_FIELD,
  IDLE_TOP_UP_FORM,
} from './form-state';
import { restoreTopUp, topUpScope } from '@/server/top-up-request';
import {
  purgeUnresolved,
  releaseUnresolved,
  useUnresolvedStore,
} from '@/server/unresolved-request';
import {
  memoryUnresolvedStore,
  UnresolvedStoreUnavailable,
} from '@/server/unresolved-request-store';
import { actingAccessToken } from '@/test/session-token';

/**
 * `/wallet`'s one write path — the same order-of-checks suite as
 * `drivers/[id]/actions.spec.ts`: session, CSRF, submission id, each proven
 * to call nothing on its own, plus the double-submit/retry-reuse case.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const currentSession = jest.fn();
const topUpWallet = jest.fn();
const mayDispatch = jest.fn();
let snapshotOverride: string | undefined;
jest.mock('@/server/top-up-request', () => {
  const actual = jest.requireActual('@/server/top-up-request');
  return {
    ...actual,
    topUpSnapshot: (...args: unknown[]) => snapshotOverride ?? actual.topUpSnapshot(...args),
  };
});
const redirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock('@/server/current-session', () => ({
  currentSession: () => currentSession(),
  missingSessionReason: async () => 'NO_SESSION',
}));
jest.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));
// The provider gate is open here: what it refuses, against a fake gateway, is
// `app/money-actions-gate.spec.ts`.
jest.mock('@/server/money-gate', () => ({
  mayDispatch: (...args: unknown[]) => mayDispatch(...args),
}));
jest.mock('@/server/wallet', () => {
  const actual = jest.requireActual('@/server/wallet');
  return {
    ...actual,
    topUpWallet: (...args: unknown[]) => topUpWallet(...args),
    fetchWallet: async () => ({ kind: 'OK', data: { id: 'WLT_1' } }),
    fetchHolds: async () => ({ kind: 'OK', data: {} }),
    fetchTransactions: async () => ({ kind: 'OK', data: {} }),
    fetchPaymentProvider: async () => ({ kind: 'OK', data: {} }),
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const actions = require('./actions') as typeof import('./actions');
const { submitTopUp, releaseUnresolvedTopUp } = actions;

const SESSION = {
  subject: 'user-1',
  username: 'manager',
  organizationId: 'ORG-DEH-0001',
  accessToken: actingAccessToken('ORG-DEH-0001'),
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
  const submission =
    options.submission === undefined ? mintSubmissionId(SESSION) : options.submission;
  if (submission !== null) form.set(SUBMISSION_FIELD, submission);
  return form;
}

beforeEach(() => {
  snapshotOverride = undefined;
  useUnresolvedStore(memoryUnresolvedStore());
  mayDispatch.mockReset().mockResolvedValue(true);
  currentSession.mockResolvedValue(SESSION);
  topUpWallet.mockReset().mockResolvedValue({
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

  it('refuses every id that is not one this server minted for this session, and calls nothing', async () => {
    const notMinted = [
      // Right prefix, right length, right alphabet — and nobody's MAC: what a
      // shape check alone waves through.
      `sub_${'A'.repeat(38)}`,
      `sub_${'Zz9_-'.repeat(8)}ab`,
      // The original, unbound format.
      `sub_${'B'.repeat(20)}`,
      // Somebody else's, and one from an earlier login.
      mintSubmissionId({ ...SESSION, subject: 'someone-else' }),
      mintSubmissionId({ ...SESSION, csrfToken: 'the-token-before-re-login' }),
    ];
    for (const submission of notMinted) {
      expect(
        await submitTopUp(
          WALLET_ID,
          IDLE_TOP_UP_FORM,
          formData({ amountMinor: '1000000' }, { submission }),
        ),
      ).toEqual({ kind: 'REFUSED', reason: 'SUBMISSION' });
    }
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

  it('redirects to /wallet — with no flag the page never read — after a successful top-up', async () => {
    await expect(
      submitTopUp(WALLET_ID, IDLE_TOP_UP_FORM, formData({ amountMinor: '1000000' })),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirect).toHaveBeenCalledWith('/wallet');
  });

  it('sends one submission twice under one reference — the double-submit case', async () => {
    const submission = mintSubmissionId(SESSION);
    const form = () => formData({ amountMinor: '1000000' }, { submission });

    await expect(submitTopUp(WALLET_ID, IDLE_TOP_UP_FORM, form())).rejects.toThrow(/NEXT_REDIRECT/);
    await expect(submitTopUp(WALLET_ID, IDLE_TOP_UP_FORM, form())).rejects.toThrow(/NEXT_REDIRECT/);

    const ids = topUpWallet.mock.calls.map((args) => args[3]);
    expect(ids).toEqual([submission, submission]);
  });

  it('keeps the first correlation, key and amount on an unconfirmed retry without resending (FU-173/FU-190)', async () => {
    // The first answer was lost. Reconciliation-only policy withholds the retry;
    // #880's boundary keeps its first correlation, held key and held values.
    topUpWallet.mockReset();
    topUpWallet
      .mockResolvedValueOnce({ kind: 'UNKNOWN_OUTCOME', correlationId: 'corr-first' })
      .mockResolvedValueOnce({
        kind: 'UNAVAILABLE',
        status: 429,
        code: 'RATE_LIMIT_EXCEEDED',
        correlationId: 'corr-retry',
      });
    const form = formData({ amountMinor: '1000000' });
    const first = await submitTopUp(WALLET_ID, IDLE_TOP_UP_FORM, form);
    expect(first).toEqual({
      kind: 'UNCONFIRMED',
      correlationId: 'corr-first',
      submissionId: form.get(SUBMISSION_FIELD),
      values: { amountMinor: '1000000' },
    });
    expect(await submitTopUp(WALLET_ID, first, form)).toEqual(first);
    expect(topUpWallet).toHaveBeenCalledTimes(1);
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

describe('FU-190: the server holds an ambiguous top-up across reloads', () => {
  it.each(['UNKNOWN_OUTCOME', 'IN_PROGRESS', 'UNAVAILABLE'])(
    'restores key, amount and held state after %s, even with forged IDLE and edited values',
    async (kind) => {
      topUpWallet.mockResolvedValue({ kind, status: 503, correlationId: 'LOST' });
      const submission = mintSubmissionId(SESSION);
      await submitTopUp(
        WALLET_ID,
        IDLE_TOP_UP_FORM,
        formData({ amountMinor: '1,000' }, { submission }),
      );
      const reloaded = await restoreTopUp(SESSION, WALLET_ID);
      expect(reloaded).toEqual({
        kind: 'HELD',
        releaseToken: expect.any(String),
        submissionId: submission,
        values: { amountMinor: '1000' },
      });
      expect(
        await submitTopUp(WALLET_ID, IDLE_TOP_UP_FORM, formData({ amountMinor: '2000' })),
      ).toEqual(reloaded);
      expect(
        await submitTopUp(
          WALLET_ID,
          IDLE_TOP_UP_FORM,
          formData({ amountMinor: '2000' }, { submission }),
        ),
      ).toEqual(reloaded);
      expect(topUpWallet).toHaveBeenCalledTimes(1);
    },
  );

  it('the actual page reload passes the held key, amount and state to the form', async () => {
    topUpWallet.mockResolvedValue({ kind: 'UNKNOWN_OUTCOME', correlationId: 'LOST' });
    await submitTopUp(WALLET_ID, IDLE_TOP_UP_FORM, formData({ amountMinor: '1000' }));
    const page = await WalletPage({ searchParams: Promise.resolve({}) });
    expect(page.props.children.props.topUpState).toEqual(await restoreTopUp(SESSION, WALLET_ID));
    expect(page.props.children.props.submissionId).toBe(
      page.props.children.props.topUpState.submissionId,
    );
  });

  it.each([
    ['1000', '2000'],
    ['2000', '1000'],
    ['1000', '1000'],
  ])(
    'reserves atomically for both orders and identical keys/bodies: %s / %s',
    async (firstAmount, secondAmount) => {
      let gates = 0;
      let open!: () => void;
      const ready = new Promise<boolean>((resolve) => {
        open = () => resolve(true);
      });
      mayDispatch.mockImplementation(() => {
        if (++gates === 2) open();
        return ready;
      });
      topUpWallet.mockResolvedValue({ kind: 'UNKNOWN_OUTCOME', correlationId: 'LOST' });
      const submission = mintSubmissionId(SESSION);
      const answers = await Promise.all([
        submitTopUp(
          WALLET_ID,
          IDLE_TOP_UP_FORM,
          formData({ amountMinor: firstAmount }, { submission }),
        ),
        submitTopUp(
          WALLET_ID,
          IDLE_TOP_UP_FORM,
          formData({ amountMinor: secondAmount }, { submission }),
        ),
      ]);
      expect(gates).toBe(2);
      expect(topUpWallet).toHaveBeenCalledTimes(1);
      expect(answers.map(({ kind }) => kind).sort()).toEqual(['HELD', 'UNCONFIRMED']);
    },
  );

  it('holds a second tab while the first dispatch is still running', async () => {
    let finish!: (result: unknown) => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    topUpWallet.mockImplementationOnce(() => {
      began();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const first = submitTopUp(WALLET_ID, IDLE_TOP_UP_FORM, formData({ amountMinor: '1000' }));
    // Wait until the real atomic reservation has completed and the send has begun.
    await started;
    const held = await restoreTopUp(SESSION, WALLET_ID);
    expect(held.kind).toBe('HELD');
    expect(
      await submitTopUp(WALLET_ID, IDLE_TOP_UP_FORM, formData({ amountMinor: '3000' })),
    ).toEqual(held);
    expect(topUpWallet).toHaveBeenCalledTimes(1);
    finish({ kind: 'UNKNOWN_OUTCOME', correlationId: 'LOST' });
    await first;
    expect(await restoreTopUp(SESSION, WALLET_ID)).toEqual(held);
  });

  it('keeps the hold after an unexpected exception and isolates organization and person', async () => {
    topUpWallet.mockRejectedValueOnce(new Error('lost response'));
    await expect(
      submitTopUp(WALLET_ID, IDLE_TOP_UP_FORM, formData({ amountMinor: '1000' })),
    ).rejects.toThrow('lost response');
    expect((await restoreTopUp(SESSION, WALLET_ID)).kind).toBe('HELD');
    for (const other of [
      { ...SESSION, subject: 'other' },
      { ...SESSION, organizationId: 'ORG_OTHER', accessToken: actingAccessToken('ORG_OTHER') },
    ])
      expect((await restoreTopUp(other, WALLET_ID)).kind).toBe('IDLE');
    expect((await restoreTopUp(SESSION, 'WLT_OTHER')).kind).toBe('IDLE');
  });

  it('keeps the original amount past an aged lease and two days, without replaying the key', async () => {
    let now = Date.now();
    useUnresolvedStore(memoryUnresolvedStore(() => now));
    topUpWallet.mockResolvedValue({ kind: 'UNKNOWN_OUTCOME', correlationId: 'LOST' });
    const form = formData({ amountMinor: '1000' });
    await submitTopUp(WALLET_ID, IDLE_TOP_UP_FORM, form);
    now += 2 * 24 * 60 * 60 * 1000;
    expect(await restoreTopUp(SESSION, WALLET_ID)).toMatchObject({
      kind: 'HELD',
      values: { amountMinor: '1000' },
    });
    expect(await submitTopUp(WALLET_ID, IDLE_TOP_UP_FORM, form)).toMatchObject({ kind: 'HELD' });
    expect(topUpWallet).toHaveBeenCalledTimes(1);
  });

  // prettier-ignore
  it.each(['SNAPSHOT_UNREADABLE', 'CORRUPT_RECORD'] as const)('refuses %s and an unavailable reservation without sending', async (reason) => {
    const store = memoryUnresolvedStore();
    useUnresolvedStore(store);
    topUpWallet.mockResolvedValue({ kind: 'UNKNOWN_OUTCOME', correlationId: 'LOST' });
    await submitTopUp(WALLET_ID, IDLE_TOP_UP_FORM, formData({ amountMinor: '1000' }));
    for (const [key, raw] of store.records)
      store.records.set(
        key,
        JSON.stringify({
          ...JSON.parse(raw),
          ...(reason === 'CORRUPT_RECORD' ? { state: 'BROKEN' } : { ref: 'corrupt' }),
        }),
      );
    expect(await restoreTopUp(SESSION, WALLET_ID)).toEqual({
      kind: 'NOT_CHECKED',
      reason,
      submissionId: '',
      ...(reason === 'SNAPSHOT_UNREADABLE' ? { releaseToken: expect.any(String) } : {}),
    });
    expect(
      await submitTopUp(WALLET_ID, IDLE_TOP_UP_FORM, formData({ amountMinor: '2000' })),
    ).toMatchObject({ kind: 'NOT_CHECKED' });
    expect(topUpWallet).toHaveBeenCalledTimes(1);
    useUnresolvedStore(memoryUnresolvedStore());
    const unavailable = memoryUnresolvedStore();
    jest.spyOn(unavailable, 'reserve').mockRejectedValue(new UnresolvedStoreUnavailable());
    useUnresolvedStore(unavailable);
    topUpWallet.mockClear();
    expect(
      await submitTopUp(WALLET_ID, IDLE_TOP_UP_FORM, formData({ amountMinor: '1000' })),
    ).toMatchObject({ kind: 'NOT_CHECKED' });
    expect(topUpWallet).not.toHaveBeenCalled();
  });

  it('fails closed when the shared store cannot be read, without dispatching', async () => {
    const store = memoryUnresolvedStore();
    jest.spyOn(store, 'read').mockRejectedValue(new UnresolvedStoreUnavailable());
    useUnresolvedStore(store);
    expect(await restoreTopUp(SESSION, WALLET_ID)).toEqual({
      kind: 'NOT_CHECKED',
      reason: 'STORE_UNAVAILABLE',
      submissionId: '',
    });
    expect(
      await submitTopUp(WALLET_ID, IDLE_TOP_UP_FORM, formData({ amountMinor: '1000' })),
    ).toMatchObject({ kind: 'NOT_CHECKED' });
    expect(topUpWallet).not.toHaveBeenCalled();
  });
});

// prettier-ignore
describe('F1: explicit reconciliation for every held top-up', () => {
  it.each(['UNRESOLVED', 'AGED', 'LOST_CONFIRMATION', 'CORRUPT'])(
    'offers and releases %s only after duplicate-risk confirmation', async (cause) => {
      let now = Date.now();
      const store = memoryUnresolvedStore(() => now);
      useUnresolvedStore(store);
      if (cause === 'LOST_CONFIRMATION' || cause === 'AGED')
        jest.spyOn(store, 'settle').mockRejectedValueOnce(new UnresolvedStoreUnavailable());
      topUpWallet.mockResolvedValue({
        kind: cause === 'LOST_CONFIRMATION' ? 'CREATED' : 'UNKNOWN_OUTCOME', correlationId: 'LOST',
      });
      await submitTopUp(WALLET_ID, IDLE_TOP_UP_FORM, formData({ amountMinor: '1000' })).catch((error) => {
        if (!String(error).includes('NEXT_REDIRECT')) throw error;
      });
      if (cause === 'AGED' || cause === 'LOST_CONFIRMATION') now += 3600000;
      if (cause === 'CORRUPT') for (const [key, raw] of store.records)
        store.records.set(key, JSON.stringify({ ...JSON.parse(raw), ref: 'unopenable' }));
      const session = cause === 'FORMER' ? {
        ...SESSION, organizationId: 'ORG_OTHER', accessToken: actingAccessToken('ORG_OTHER'),
        formerOrganizationId: SESSION.organizationId,
      } : SESSION;
      currentSession.mockResolvedValue(session);
      const held = await restoreTopUp(session, WALLET_ID);
      expect(held.kind).toBe(cause === 'FORMER' || cause === 'CORRUPT' ? 'NOT_CHECKED' : 'HELD');
      if (held.kind !== 'HELD' && held.kind !== 'NOT_CHECKED') throw new Error('missing hold');
      expect(held.releaseToken).toEqual(expect.any(String));
      const form = formData({ [RELEASE_FIELD]: held.releaseToken! });
      const release = () => expect(releaseUnresolvedTopUp(WALLET_ID, form)).rejects.toThrow('NEXT_REDIRECT:/wallet');
      await release();
      expect((await restoreTopUp(session, WALLET_ID)).kind).toBe(held.kind);
      form.set(CONFIRM_DUPLICATE_FIELD, CONFIRM_DUPLICATE_VALUE);
      await expect(releaseUnresolvedTopUp('WLT_OTHER', form)).rejects.toThrow('NEXT_REDIRECT:/wallet');
      await release();
      if (cause === 'AGED' || cause === 'LOST_CONFIRMATION') {
        expect((await restoreTopUp(session, WALLET_ID)).kind).toBe('HELD');
        await release();
      }
      expect((await restoreTopUp(session, WALLET_ID)).kind).toBe('IDLE');
    },
  );
});

describe('FU-209 person/org/wallet holds', () => {
  it.each(['re-login', 'second-device', 'logout'])(
    'survives %s; isolates person, org and wallet',
    async (event) => {
      topUpWallet.mockResolvedValue({ kind: 'UNKNOWN_OUTCOME', correlationId: 'lost' });
      await submitTopUp(WALLET_ID, IDLE_TOP_UP_FORM, formData({ amountMinor: '1000' }));
      if (event === 'logout') expect(await purgeUnresolved(SESSION)).toBe(true);
      const original = await restoreTopUp(SESSION, WALLET_ID);
      expect(original.kind).toBe('HELD');
      for (const csrfToken of [event === 'logout' ? SESSION.csrfToken : event]) {
        const next = { ...SESSION, csrfToken };
        currentSession.mockResolvedValue(next);
        const held = await restoreTopUp(next, WALLET_ID);
        expect(held).toMatchObject({ ...original, releaseToken: expect.any(String) });
        const data = formData(
          { amountMinor: '2000' },
          { csrf: csrfToken, submission: mintSubmissionId(next) },
        );
        expect(await submitTopUp(WALLET_ID, IDLE_TOP_UP_FORM, data)).toMatchObject({
          kind: 'HELD',
        });
        expect(await purgeUnresolved(next)).toBe(true);
        expect((await restoreTopUp(next, WALLET_ID)).kind).toBe('HELD');
      }
      if (!('releaseToken' in original)) throw new Error('missing hold');
      for (const other of [
        { ...SESSION, subject: 'other-person' },
        {
          ...SESSION,
          organizationId: 'OTHER',
          accessToken: actingAccessToken('OTHER'),
          formerOrganizationId: SESSION.organizationId,
        },
      ]) {
        expect((await restoreTopUp(other, WALLET_ID)).kind).toBe('IDLE');
        expect(await releaseUnresolved(other, topUpScope(WALLET_ID), original.releaseToken)).toBe(
          'STALE',
        );
      }
      expect((await restoreTopUp(SESSION, 'OTHER_WALLET')).kind).toBe('IDLE');
      expect((await restoreTopUp(SESSION, WALLET_ID)).kind).toBe('HELD');
      expect(topUpWallet).toHaveBeenCalledTimes(1);
      const next = { ...SESSION, csrfToken: 'fresh-login' };
      const held = await restoreTopUp(next, WALLET_ID);
      if (!('releaseToken' in held)) throw new Error('missing hold');
      expect(await releaseUnresolved(next, topUpScope(WALLET_ID), original.releaseToken)).toBe(
        'STALE',
      );
      expect(await releaseUnresolved(next, topUpScope(WALLET_ID), held.releaseToken)).toBe(
        'RELEASED',
      );
    },
  );
});

describe('FU-217 release feedback', () => {
  it.each(['IN_PROGRESS', 'STALE', 'UNAVAILABLE', 'RELEASED', 'GONE'] as const)(
    'redirects with %s',
    async (outcome) => {
      const store = memoryUnresolvedStore();
      useUnresolvedStore(store);
      topUpWallet.mockResolvedValue({ kind: 'UNKNOWN_OUTCOME', correlationId: 'lost' });
      await submitTopUp(WALLET_ID, IDLE_TOP_UP_FORM, formData({ amountMinor: '1000' }));
      const held = await restoreTopUp(SESSION, WALLET_ID);
      if (!('releaseToken' in held)) throw new Error('missing hold');
      if (outcome === 'UNAVAILABLE')
        jest.spyOn(store, 'release').mockRejectedValue(new UnresolvedStoreUnavailable());
      else jest.spyOn(store, 'release').mockResolvedValue(outcome);
      await expect(
        releaseUnresolvedTopUp(
          WALLET_ID,
          formData({
            release: held.releaseToken!,
            confirmDuplicate: 'yes',
          }),
        ),
      ).rejects.toThrow(`release=${outcome}`);
    },
  );
});

describe('FU-210 top-up pre-dispatch refusals', () => {
  it.each(['CAPACITY', 'SNAPSHOT_TOO_LARGE'] as const)('%s sends nothing', async (reason) => {
    const store = memoryUnresolvedStore();
    useUnresolvedStore(store);
    if (reason === 'CAPACITY') jest.spyOn(store, 'reserve').mockResolvedValue({ kind: 'CAPACITY' });
    else snapshotOverride = 'x'.repeat(801);
    expect(
      await submitTopUp(WALLET_ID, IDLE_TOP_UP_FORM, formData({ amountMinor: '1000' })),
    ).toMatchObject({ kind: 'NOT_CHECKED', reason });
    expect(topUpWallet).not.toHaveBeenCalled();
  });
});
