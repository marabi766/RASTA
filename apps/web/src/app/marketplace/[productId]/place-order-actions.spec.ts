/**
 * @jest-environment node
 */
import { CSRF_FIELD } from '@/server/csrf';
import { SUBMISSION_FIELD, mintSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';

import { IDLE_PLACE_ORDER_FORM } from './place-order-form-state';

/**
 * The place-order form's one write path — the same order-of-checks suite as
 * `wallet/actions.spec.ts`: session, CSRF, submission id, each proven to call
 * nothing on its own, then what the service's answers become.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const currentSession = jest.fn();
const placeOrder = jest.fn();
const redirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

const missingSessionReason = jest.fn();
jest.mock('@/server/current-session', () => ({
  currentSession: () => currentSession(),
  missingSessionReason: () => missingSessionReason(),
}));
jest.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));
jest.mock('@/server/place-order', () => {
  const actual = jest.requireActual('@/server/place-order');
  return { ...actual, placeOrder: (...args: unknown[]) => placeOrder(...args) };
});

const actions =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./place-order-actions') as typeof import('./place-order-actions');
const { submitPlaceOrder } = actions;

const SESSION = {
  subject: 'user-1',
  username: 'buyer',
  organizationId: 'ORG-DEH-0001',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
} satisfies WebSession;

const GOOD = { offerId: 'OFR_SEED_AGGREGATE_D2', quantity: '3' };

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
  currentSession.mockResolvedValue(SESSION);
  missingSessionReason.mockReset();
  missingSessionReason.mockResolvedValue('NO_SESSION');
  placeOrder.mockReset();
  placeOrder.mockResolvedValue({
    kind: 'CREATED',
    data: { id: 'ORD_1' },
    correlationId: 'corr-sample',
  });
  redirect.mockClear();
});

describe('placing an order — the full order of checks', () => {
  it('refuses a post with no session, and calls nothing', async () => {
    currentSession.mockResolvedValue(null);
    expect(await submitPlaceOrder(IDLE_PLACE_ORDER_FORM, formData(GOOD))).toEqual({
      kind: 'REFUSED',
      reason: 'NO_SESSION',
    });
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('refuses a post whose session is only unavailable as SESSION_UNAVAILABLE, not "ended"', async () => {
    currentSession.mockResolvedValue(null);
    missingSessionReason.mockResolvedValue('SESSION_UNAVAILABLE');
    expect(await submitPlaceOrder(IDLE_PLACE_ORDER_FORM, formData(GOOD))).toEqual({
      kind: 'REFUSED',
      reason: 'SESSION_UNAVAILABLE',
    });
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('refuses a post with no CSRF token, and calls nothing', async () => {
    expect(await submitPlaceOrder(IDLE_PLACE_ORDER_FORM, formData(GOOD, { csrf: null }))).toEqual({
      kind: 'REFUSED',
      reason: 'CSRF',
    });
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('refuses a submission id this server did not mint, and calls nothing', async () => {
    const notMinted = [
      'chosen-by-the-client',
      `sub_${'A'.repeat(38)}`,
      mintSubmissionId({ ...SESSION, subject: 'someone-else' }),
      mintSubmissionId({ ...SESSION, csrfToken: 'the-token-before-re-login' }),
    ];
    for (const submission of notMinted) {
      expect(await submitPlaceOrder(IDLE_PLACE_ORDER_FORM, formData(GOOD, { submission }))).toEqual(
        { kind: 'REFUSED', reason: 'SUBMISSION' },
      );
    }
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('checks CSRF before the submission id', async () => {
    const state = await submitPlaceOrder(
      IDLE_PLACE_ORDER_FORM,
      formData(GOOD, { csrf: 'wrong', submission: 'also-wrong' }),
    );
    expect(state).toEqual({ kind: 'REFUSED', reason: 'CSRF' });
  });

  it('does not call the service for a form that fails its own rules', async () => {
    const state = await submitPlaceOrder(
      IDLE_PLACE_ORDER_FORM,
      formData({ offerId: '', quantity: '0' }),
    );
    expect(state).toMatchObject({
      kind: 'INVALID',
      fieldErrors: { offerId: expect.any(String), quantity: expect.any(String) },
    });
    expect(placeOrder).not.toHaveBeenCalled();
  });
});

describe('placing an order — what the service answers', () => {
  it('sends the one-line body under the submission id the form carried, then goes to the order', async () => {
    const submission = mintSubmissionId(SESSION);
    await expect(
      submitPlaceOrder(IDLE_PLACE_ORDER_FORM, formData(GOOD, { submission })),
    ).rejects.toThrow(/NEXT_REDIRECT/);

    expect(placeOrder).toHaveBeenCalledWith(
      SESSION,
      { lines: [{ offerId: 'OFR_SEED_AGGREGATE_D2', quantity: 3 }] },
      submission,
    );
    expect(redirect).toHaveBeenCalledWith('/orders/ORD_1?placed=1');
  });

  it('sends a double submit under one key — the double-submit case', async () => {
    const submission = mintSubmissionId(SESSION);
    for (let i = 0; i < 2; i += 1) {
      await expect(
        submitPlaceOrder(IDLE_PLACE_ORDER_FORM, formData(GOOD, { submission })),
      ).rejects.toThrow(/NEXT_REDIRECT/);
    }
    expect(placeOrder.mock.calls.map((args) => args[2])).toEqual([submission, submission]);
  });

  it('encodes the order id it was handed into the redirect', async () => {
    placeOrder.mockResolvedValue({ kind: 'CREATED', data: { id: 'a/b?c' }, correlationId: 'c' });
    await expect(submitPlaceOrder(IDLE_PLACE_ORDER_FORM, formData(GOOD))).rejects.toThrow(
      /NEXT_REDIRECT/,
    );
    expect(redirect).toHaveBeenCalledWith('/orders/a%2Fb%3Fc?placed=1');
  });

  it('keeps what was typed when the service refuses it, under the same submission id', async () => {
    placeOrder.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: {},
      message: 'سفارش با شرایط کنونی این پیشنهاد جور نیست',
      correlationId: 'c',
    });
    const submission = mintSubmissionId(SESSION);
    const state = await submitPlaceOrder(IDLE_PLACE_ORDER_FORM, formData(GOOD, { submission }));
    expect(state).toMatchObject({
      kind: 'INVALID',
      submissionId: submission,
      values: { offerId: GOOD.offerId, quantity: '3' },
      message: 'سفارش با شرایط کنونی این پیشنهاد جور نیست',
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('answers an offer that is gone as its own outcome and keeps the choice', async () => {
    placeOrder.mockResolvedValue({ kind: 'NOT_FOUND', correlationId: 'c' });
    expect(await submitPlaceOrder(IDLE_PLACE_ORDER_FORM, formData(GOOD))).toMatchObject({
      kind: 'NOT_FOUND',
      values: { offerId: GOOD.offerId },
    });
  });

  it('carries the correlation id of a forbidden attempt', async () => {
    placeOrder.mockResolvedValue({ kind: 'FORBIDDEN', correlationId: 'COR_1' });
    expect(await submitPlaceOrder(IDLE_PLACE_ORDER_FORM, formData(GOOD))).toEqual({
      kind: 'FORBIDDEN',
      correlationId: 'COR_1',
    });
  });

  it.each(['UNKNOWN_OUTCOME', 'IN_PROGRESS'])(
    'never says nothing was ordered after %s, and keeps the values and the submission id',
    async (kind) => {
      placeOrder.mockResolvedValue({ kind, retryAfterSeconds: 1, correlationId: 'COR_3' });
      const submission = mintSubmissionId(SESSION);
      expect(await submitPlaceOrder(IDLE_PLACE_ORDER_FORM, formData(GOOD, { submission }))).toEqual(
        {
          kind: 'UNCONFIRMED',
          correlationId: 'COR_3',
          submissionId: submission,
          values: GOOD,
        },
      );
    },
  );

  // F2: the quantity kept for a retry is the count that was sent, not the text typed.
  it.each([
    ['leading zeros', '00000000000000003'],
    ['Persian digits', '۰۰۳'],
    ['padding', ' 3 '],
  ])('keeps the quantity that was sent, not the text typed (%s)', async (_name, typed) => {
    placeOrder.mockResolvedValue({ kind: 'UNKNOWN_OUTCOME', correlationId: 'COR_Z' });
    const submission = mintSubmissionId(SESSION);
    const state = await submitPlaceOrder(
      IDLE_PLACE_ORDER_FORM,
      formData({ ...GOOD, quantity: typed }, { submission }),
    );

    expect(placeOrder.mock.calls[0]?.[1]).toEqual({
      lines: [{ offerId: GOOD.offerId, quantity: 3 }],
    });
    expect(state).toEqual({
      kind: 'UNCONFIRMED',
      correlationId: 'COR_Z',
      submissionId: submission,
      values: { offerId: GOOD.offerId, quantity: '3' },
    });
  });

  it('retries an uncertain order with the same body and the same submission id, then goes to the order', async () => {
    const submission = mintSubmissionId(SESSION);
    placeOrder.mockResolvedValueOnce({ kind: 'UNKNOWN_OUTCOME', correlationId: 'COR_4' });
    const first = await submitPlaceOrder(IDLE_PLACE_ORDER_FORM, formData(GOOD, { submission }));
    expect(first).toMatchObject({ kind: 'UNCONFIRMED' });
    if (first.kind !== 'UNCONFIRMED') return;

    // The retry posts exactly what the state kept: the form's hidden fields.
    const retry = formData(first.values, { submission: first.submissionId });
    await expect(submitPlaceOrder(first, retry)).rejects.toThrow(/NEXT_REDIRECT/);

    expect(placeOrder).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = placeOrder.mock.calls as [unknown[], unknown[]];
    expect(secondCall[1]).toEqual(firstCall[1]);
    expect(secondCall[2]).toBe(submission);
    expect(firstCall[2]).toBe(submission);
  });

  // Order commits, recording the idempotency response fails (UNCONFIRMED); the
  // record expires and the offer is withdrawn: pricing refuses the retry before
  // the order-key check. A refusal proves nothing about the first request.
  it.each([
    ['NOT_FOUND', { kind: 'NOT_FOUND' }],
    ['a 409 refusal', { kind: 'INVALID', fieldErrors: {}, message: 'CONFLICT' }],
    ['a 422 refusal', { kind: 'INVALID', fieldErrors: { quantity: 'x' }, message: 'm' }],
    ['FORBIDDEN', { kind: 'FORBIDDEN' }],
  ])('keeps an unconfirmed order unconfirmed when its retry gets %s', async (_name, answer) => {
    const submission = mintSubmissionId(SESSION);
    placeOrder.mockResolvedValueOnce({ kind: 'UNKNOWN_OUTCOME', correlationId: 'COR_5' });
    const first = await submitPlaceOrder(IDLE_PLACE_ORDER_FORM, formData(GOOD, { submission }));
    if (first.kind !== 'UNCONFIRMED') throw new Error('expected UNCONFIRMED');

    placeOrder.mockResolvedValueOnce({ ...answer, correlationId: 'COR_6' });
    const retry = await submitPlaceOrder(first, formData(first.values, { submission }));

    expect(retry).toEqual({
      kind: 'UNCONFIRMED',
      correlationId: 'COR_5',
      submissionId: submission,
      values: GOOD,
      retryRefused: true,
    });
    // And it stays so through a second refused retry.
    placeOrder.mockResolvedValueOnce({ kind: 'NOT_FOUND', correlationId: 'COR_7' });
    expect(await submitPlaceOrder(retry, formData(first.values, { submission }))).toEqual(retry);
  });

  it('keeps an unconfirmed order unconfirmed when the retry is refused before the service', async () => {
    const submission = mintSubmissionId(SESSION);
    placeOrder.mockResolvedValueOnce({ kind: 'UNKNOWN_OUTCOME', correlationId: 'COR_5' });
    const first = await submitPlaceOrder(IDLE_PLACE_ORDER_FORM, formData(GOOD, { submission }));
    if (first.kind !== 'UNCONFIRMED') throw new Error('expected UNCONFIRMED');
    const form = formData(first.values, { submission, csrf: 'not-the-token' });

    expect(await submitPlaceOrder(first, form)).toEqual({ ...first, retryRefused: true });
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  describe('a retry that finds no session', () => {
    async function unconfirmed() {
      const submission = mintSubmissionId(SESSION);
      placeOrder.mockResolvedValueOnce({ kind: 'UNKNOWN_OUTCOME', correlationId: 'COR_6' });
      const first = await submitPlaceOrder(IDLE_PLACE_ORDER_FORM, formData(GOOD, { submission }));
      if (first.kind !== 'UNCONFIRMED') throw new Error('expected UNCONFIRMED');
      currentSession.mockResolvedValue(null);
      return { first, form: formData(first.values, { submission }) };
    }

    it('says the session ended — authoritatively — when it has (NO_SESSION)', async () => {
      const { first, form } = await unconfirmed();
      missingSessionReason.mockResolvedValue('NO_SESSION');
      expect(await submitPlaceOrder(first, form)).toEqual({ ...first, sessionEnded: true });
      expect(placeOrder).toHaveBeenCalledTimes(1);
    });

    it('stays unknown, with its retry, when the refresh is only unavailable (SESSION_UNAVAILABLE)', async () => {
      const { first, form } = await unconfirmed();
      missingSessionReason.mockResolvedValue('SESSION_UNAVAILABLE');
      const state = await submitPlaceOrder(first, form);
      expect(state).toEqual({ ...first, retryUnknown: true });
      expect(state).not.toHaveProperty('sessionEnded');
      expect(placeOrder).toHaveBeenCalledTimes(1);
    });
  });

  // The gateway answers these before the service acts. The portal cannot tell
  // them from "maybe" (`placeOrder`: every UNAVAILABLE is unconfirmed), and
  // whichever it is, the retry's own correlation id must not replace the
  // original request's — that is the id the person is told to quote.
  it.each([401, 405, 429])(
    'keeps the original correlation id, key and values when the retry is answered %i',
    async (status) => {
      const submission = mintSubmissionId(SESSION);
      placeOrder.mockResolvedValueOnce({ kind: 'UNKNOWN_OUTCOME', correlationId: 'COR_FIRST' });
      const first = await submitPlaceOrder(IDLE_PLACE_ORDER_FORM, formData(GOOD, { submission }));
      if (first.kind !== 'UNCONFIRMED') throw new Error('expected UNCONFIRMED');

      const realPlaceOrder = jest.requireActual('@/server/place-order').placeOrder;
      placeOrder.mockImplementation(realPlaceOrder);
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ code: 'REFUSED' }), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
      try {
        const retry = await submitPlaceOrder(first, formData(first.values, { submission }));

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(retry).toEqual({
          kind: 'UNCONFIRMED',
          correlationId: 'COR_FIRST',
          submissionId: submission,
          values: GOOD,
          retryUnknown: true,
        });
      } finally {
        fetchSpy.mockRestore();
      }
    },
  );

  it('shows only the latest note after a second retry, never both', async () => {
    const submission = mintSubmissionId(SESSION);
    placeOrder.mockResolvedValueOnce({ kind: 'UNKNOWN_OUTCOME', correlationId: 'COR_FIRST' });
    const first = await submitPlaceOrder(IDLE_PLACE_ORDER_FORM, formData(GOOD, { submission }));
    if (first.kind !== 'UNCONFIRMED') throw new Error('expected UNCONFIRMED');

    placeOrder.mockResolvedValueOnce({ kind: 'UNKNOWN_OUTCOME', correlationId: 'COR_2' });
    const unknown = await submitPlaceOrder(first, formData(first.values, { submission }));
    expect(unknown).toMatchObject({ correlationId: 'COR_FIRST', retryUnknown: true });

    placeOrder.mockResolvedValueOnce({ kind: 'NOT_FOUND', correlationId: 'COR_3' });
    const refused = await submitPlaceOrder(unknown, formData(first.values, { submission }));
    expect(refused).toEqual({ ...first, retryRefused: true });
    expect(refused).not.toHaveProperty('retryUnknown');
  });

  it('lets a successful retry replace the unconfirmed state', async () => {
    const submission = mintSubmissionId(SESSION);
    placeOrder.mockResolvedValueOnce({ kind: 'UNKNOWN_OUTCOME', correlationId: 'COR_5' });
    const first = await submitPlaceOrder(IDLE_PLACE_ORDER_FORM, formData(GOOD, { submission }));
    if (first.kind !== 'UNCONFIRMED') throw new Error('expected UNCONFIRMED');
    await expect(submitPlaceOrder(first, formData(first.values, { submission }))).rejects.toThrow(
      /NEXT_REDIRECT/,
    );
  });
});
