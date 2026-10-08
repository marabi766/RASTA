/**
 * @jest-environment node
 */
import { BASELINE_FIELD } from '@/lib/form-fields';
import { sealAvailabilityBaseline } from '@/server/fleet-availability';
import { CSRF_FIELD } from '@/server/csrf';
import { readFlash } from '@/server/flash';
import { SUBMISSION_FIELD, mintSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';
import { withForgedMac } from '@/test/forged-token';

import { IDLE_AVAILABILITY_FORM } from './availability-form-state';

/**
 * The two availability forms' write path (EXP-002 slice 7): declare, and revoke
 * one declaration. Mirrors `record-actions.spec.ts`: the order is the assertion,
 * each refusal proves nothing was sent, and the machine — and, for a revoke, the
 * window — is the page's own, bound by the form and named by the baseline the
 * page signed, never a field of it.
 */

const currentSession = jest.fn();
const declareAvailability = jest.fn();
const revokeAvailability = jest.fn();
const redirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock('@/server/current-session', () => ({ currentSession: () => currentSession() }));
jest.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));
jest.mock('@/server/fleet-availability', () => {
  const actual = jest.requireActual('@/server/fleet-availability');
  return {
    ...actual,
    declareAvailability: (...args: unknown[]) => declareAvailability(...args),
    revokeAvailability: (...args: unknown[]) => revokeAvailability(...args),
  };
});

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const actions = require('./availability-actions') as typeof import('./availability-actions');

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

const ASSET_ID = 'AST_01J00000000000000000000000';
const OTHER_ASSET_ID = 'AST_01J00000000000000000000099';
const WINDOW_ID = 'AVW_01J00000000000000000000000';
const OTHER_WINDOW_ID = 'AVW_01J00000000000000000000099';

interface Case {
  readonly name: string;
  readonly command: 'declare' | 'revoke';
  readonly submit: (assetId: string, windowId: string, form: FormData) => Promise<unknown>;
  readonly send: jest.Mock;
  readonly valid: Record<string, string>;
  readonly notice: string;
}

const CASES: readonly Case[] = [
  {
    name: 'declare availability',
    command: 'declare',
    submit: (assetId, _windowId, form) =>
      actions.submitDeclareAvailability(assetId, IDLE_AVAILABILITY_FORM, form),
    send: declareAvailability,
    valid: { available: 'false', reason: 'رزرو برای پروژهٔ راه‌سازی', fromAt: '', toAt: '' },
    notice: 'availabilityDeclared',
  },
  {
    name: 'revoke a declaration',
    command: 'revoke',
    submit: (assetId, windowId, form) =>
      actions.submitRevokeAvailability(assetId, windowId, IDLE_AVAILABILITY_FORM, form),
    send: revokeAvailability,
    valid: {},
    notice: 'availabilityRevoked',
  },
];

const baselineFor = (
  testCase: Case,
  assetId: string = ASSET_ID,
  windowId: string = WINDOW_ID,
  session: WebSession = SESSION,
): string =>
  sealAvailabilityBaseline(
    session,
    testCase.command === 'revoke'
      ? { assetId, command: 'revoke', windowId }
      : { assetId, command: 'declare' },
  );

function formData(
  testCase: Case,
  fields: Record<string, string> = testCase.valid,
  options: { csrf?: string | null; submission?: string | null; baseline?: string | null } = {},
): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const csrf = options.csrf === undefined ? SESSION.csrfToken : options.csrf;
  if (csrf !== null) form.set(CSRF_FIELD, csrf);
  const submission =
    options.submission === undefined ? mintSubmissionId(SESSION) : options.submission;
  if (submission !== null) form.set(SUBMISSION_FIELD, submission);
  const baseline = options.baseline === undefined ? baselineFor(testCase) : options.baseline;
  if (baseline !== null) form.set(BASELINE_FIELD, baseline);
  return form;
}

const redirectedTo = async (promise: Promise<unknown>): Promise<URL> => {
  const error = await promise.then(
    () => {
      throw new Error('expected a redirect');
    },
    (caught: Error) => caught,
  );
  const match = /^NEXT_REDIRECT:(.*)$/.exec(error.message);
  if (!match) throw error;
  return new URL(match[1]!, 'http://localhost:3200');
};

beforeEach(() => {
  currentSession.mockResolvedValue(SESSION);
  for (const send of [declareAvailability, revokeAvailability]) {
    send.mockReset();
    send.mockResolvedValue({
      kind: 'CREATED',
      data: { id: 'AVW_1' },
      correlationId: 'corr-sample',
    });
  }
  redirect.mockClear();
});

const sent = () => [declareAvailability, revokeAvailability].flatMap((m) => m.mock.calls);

describe.each(CASES)('$name', (testCase) => {
  const submit = (form: FormData, assetId = ASSET_ID, windowId = WINDOW_ID) =>
    testCase.submit(assetId, windowId, form);

  describe('what is refused before anything is sent', () => {
    it('refuses a post with no session', async () => {
      currentSession.mockResolvedValue(null);
      expect(await submit(formData(testCase))).toEqual({ kind: 'REFUSED', reason: 'NO_SESSION' });
      expect(sent()).toHaveLength(0);
    });

    it.each([null, 'someone-elses'])('refuses CSRF token %j', async (csrf) => {
      expect(await submit(formData(testCase, undefined, { csrf }))).toEqual({
        kind: 'REFUSED',
        reason: 'CSRF',
      });
      expect(sent()).toHaveLength(0);
    });

    it('refuses a submission id the client chose, one never issued, and one minted for somebody else', async () => {
      for (const submission of [
        null,
        'chosen-by-the-client',
        `sub_${'A'.repeat(38)}`,
        mintSubmissionId({ ...SESSION, subject: 'someone-else' }),
        mintSubmissionId({ ...SESSION, csrfToken: 'the-token-before-re-login' }),
      ]) {
        expect(await submit(formData(testCase, undefined, { submission }))).toEqual({
          kind: 'REFUSED',
          reason: 'SUBMISSION',
        });
      }
      expect(sent()).toHaveLength(0);
    });

    it('checks the session, then CSRF, then the submission id, then the baseline, then the form — in that order', async () => {
      const broken = { reason: '', available: '' };
      expect(
        await submit(formData(testCase, broken, { csrf: 'wrong', submission: 'wrong' })),
      ).toEqual({ kind: 'REFUSED', reason: 'CSRF' });
      currentSession.mockResolvedValue(null);
      expect(await submit(formData(testCase, broken, { csrf: 'wrong' }))).toEqual({
        kind: 'REFUSED',
        reason: 'NO_SESSION',
      });
      currentSession.mockResolvedValue(SESSION);
      expect(await submit(formData(testCase, broken, { submission: 'wrong' }))).toEqual({
        kind: 'REFUSED',
        reason: 'SUBMISSION',
      });
      expect(await submit(formData(testCase, broken, { baseline: 'wrong' }))).toEqual({
        kind: 'REFUSED',
        reason: 'BASELINE',
      });
      expect(sent()).toHaveLength(0);
    });

    it('refuses a baseline that is missing, forged, somebody else’s, from an earlier login or minted for the other command', async () => {
      const other = CASES.find((candidate) => candidate.command !== testCase.command)!;
      const genuine = baselineFor(testCase);
      for (const baseline of [
        null,
        'chosen-by-the-client',
        withForgedMac(genuine),
        baselineFor(testCase, ASSET_ID, WINDOW_ID, { ...SESSION, subject: 'someone-else' }),
        baselineFor(testCase, ASSET_ID, WINDOW_ID, {
          ...SESSION,
          csrfToken: 'the-token-before-re-login',
        }),
        baselineFor(other),
      ]) {
        expect(await submit(formData(testCase, undefined, { baseline }))).toEqual({
          kind: 'REFUSED',
          reason: 'BASELINE',
        });
      }
      expect(sent()).toHaveLength(0);
    });

    it('refuses another asset’s genuine baseline, and an action bound to another asset than the baseline names', async () => {
      expect(
        await submit(
          formData(testCase, undefined, { baseline: baselineFor(testCase, OTHER_ASSET_ID) }),
        ),
      ).toEqual({ kind: 'REFUSED', reason: 'BASELINE' });
      expect(await submit(formData(testCase), OTHER_ASSET_ID)).toEqual({
        kind: 'REFUSED',
        reason: 'BASELINE',
      });
      expect(sent()).toHaveLength(0);
    });
  });

  describe('what is sent, and to which asset', () => {
    it('sends to the page’s own asset, however the form is rewritten', async () => {
      const tampered = formData(testCase, {
        ...testCase.valid,
        assetId: OTHER_ASSET_ID,
        id: OTHER_WINDOW_ID,
        windowId: OTHER_WINDOW_ID,
      });
      await redirectedTo(submit(tampered));

      expect(testCase.send).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(testCase.send.mock.calls[0])).not.toMatch(
        /AST_01J00000000000000000000099|AVW_01J00000000000000000000099/,
      );
    });

    it('lands on a fresh read of the asset, with a flash only this session can read for this asset', async () => {
      const target = await redirectedTo(submit(formData(testCase)));
      expect(target.pathname).toBe(`/assets/${ASSET_ID}`);
      const flash = target.searchParams.get('flash');
      expect(readFlash(SESSION, flash, ASSET_ID, [testCase.notice])).toBe(testCase.notice);
      expect(readFlash(SESSION, flash, OTHER_ASSET_ID, [testCase.notice])).toBeUndefined();
      expect(
        readFlash({ ...SESSION, subject: 'someone-else' }, flash, ASSET_ID, [testCase.notice]),
      ).toBeUndefined();
    });

    it.each([
      [
        { kind: 'FORBIDDEN', correlationId: 'c1' },
        { kind: 'FORBIDDEN', correlationId: 'c1' },
      ],
      [
        { kind: 'NOT_FOUND', correlationId: 'c2' },
        { kind: 'NOT_FOUND', correlationId: 'c2' },
      ],
      [
        { kind: 'UNAVAILABLE', status: 503, correlationId: 'c3' },
        { kind: 'FAILED', status: 503, correlationId: 'c3' },
      ],
      [
        { kind: 'UNKNOWN_OUTCOME', correlationId: 'c4' },
        { kind: 'UNCONFIRMED', correlationId: 'c4' },
      ],
      [
        { kind: 'IN_PROGRESS', retryAfterSeconds: 1, correlationId: 'c5' },
        { kind: 'UNCONFIRMED', correlationId: 'c5' },
      ],
    ])(
      'says %j as %j — never "nothing was saved" for a send that may have landed',
      async (answer, expected) => {
        testCase.send.mockResolvedValue(answer);
        expect(await submit(formData(testCase))).toEqual(expected);
      },
    );

    it('answers another organization’s machine or window with the same state as a missing one', async () => {
      // Both come back from the service as one 404; the portal adds nothing to tell them apart.
      testCase.send.mockResolvedValue({ kind: 'NOT_FOUND', correlationId: 'corr-x' });
      const state = await submit(formData(testCase));
      expect(state).toEqual({ kind: 'NOT_FOUND', correlationId: 'corr-x' });
    });
  });
});

describe('declare availability: the form', () => {
  const declareCase = CASES[0]!;
  const submit = (form: FormData) => declareCase.submit(ASSET_ID, WINDOW_ID, form);

  it.each([
    ['no choice', { available: '' }, 'available'],
    ['no reason', { reason: '' }, 'reason'],
    ['an end that is not after the start', { fromAt: '2026-10-10', toAt: '2026-10-10' }, 'toAt'],
  ])('sends nothing for %s, and says which field', async (_name, over, field) => {
    const state = await submit(formData(declareCase, { ...declareCase.valid, ...over }));
    expect(state).toMatchObject({ kind: 'INVALID' });
    expect(Object.keys((state as { fieldErrors: object }).fieldErrors)).toEqual([field]);
    expect(sent()).toHaveLength(0);
  });

  it('keeps what the person typed, and the submission id, on the invalid form', async () => {
    const submission = mintSubmissionId(SESSION);
    const state = await submit(
      formData(
        declareCase,
        { ...declareCase.valid, reason: '', toAt: '2026-10-20' },
        { submission },
      ),
    );
    expect(state).toMatchObject({
      kind: 'INVALID',
      submissionId: submission,
      values: { available: 'false', toAt: '2026-10-20' },
    });
  });

  it('sends the page’s asset, the body the service takes, and the submission as the replay key', async () => {
    const submission = mintSubmissionId(SESSION);
    await redirectedTo(
      submit(
        formData(
          declareCase,
          {
            available: 'true',
            reason: 'آماده به کار',
            fromAt: '2026-10-10',
            toAt: '',
            role: 'SYSTEM_ADMIN',
          },
          { submission },
        ),
      ),
    );
    const [session, assetId, body, key] = declareAvailability.mock.calls[0]!;
    expect(session).toBe(SESSION);
    expect(assetId).toBe(ASSET_ID);
    expect(body).toEqual({
      available: true,
      reason: 'آماده به کار',
      fromAt: '2026-10-09T20:30:00.000Z',
    });
    expect(key).toBe(submission);
    expect(JSON.stringify(declareAvailability.mock.calls[0])).not.toContain('SYSTEM_ADMIN');
  });

  it('places the service’s field errors on the form, with its own words', async () => {
    declareAvailability.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: { reason: 'جملهٔ سرویس' },
      message: null,
      correlationId: 'c',
    });
    expect(await submit(formData(declareCase))).toMatchObject({
      kind: 'INVALID',
      fieldErrors: { reason: 'جملهٔ سرویس' },
    });
  });
});

describe('revoke a declaration', () => {
  const revokeCase = CASES[1]!;

  it('sends the window the page named — from the baseline, bound by the action — and the submission', async () => {
    const submission = mintSubmissionId(SESSION);
    await redirectedTo(
      revokeCase.submit(ASSET_ID, WINDOW_ID, formData(revokeCase, {}, { submission })),
    );
    expect(revokeAvailability).toHaveBeenCalledTimes(1);
    const [session, windowId, key] = revokeAvailability.mock.calls[0]!;
    expect([session, windowId, key]).toEqual([SESSION, WINDOW_ID, submission]);
  });

  it('refuses a revoke for a window the baseline does not name, though the asset is right', async () => {
    // The browser can rewrite the id bound to the action; the signed baseline is what it must match.
    expect(await revokeCase.submit(ASSET_ID, OTHER_WINDOW_ID, formData(revokeCase))).toEqual({
      kind: 'REFUSED',
      reason: 'BASELINE',
    });
    expect(
      await revokeCase.submit(
        ASSET_ID,
        WINDOW_ID,
        formData(revokeCase, {}, { baseline: baselineFor(revokeCase, ASSET_ID, OTHER_WINDOW_ID) }),
      ),
    ).toEqual({ kind: 'REFUSED', reason: 'BASELINE' });
    expect(sent()).toHaveLength(0);
  });

  it('says it in the service’s sentence when the declaration was already withdrawn — a replay is a refusal', async () => {
    revokeAvailability.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: {},
      message: 'این اعلام پیش‌تر باطل شده است.',
      correlationId: 'c',
    });
    expect(await revokeCase.submit(ASSET_ID, WINDOW_ID, formData(revokeCase))).toMatchObject({
      kind: 'INVALID',
      message: 'این اعلام پیش‌تر باطل شده است.',
    });
  });
});
