/**
 * @jest-environment node
 */
import type { RecordNotice } from '@/lib/asset-record-fields';
import { BASELINE_FIELD } from '@/lib/form-fields';
import { sealAssetRecordBaseline, type AssetRecordKind } from '@/server/asset-records';
import { CSRF_FIELD } from '@/server/csrf';
import { readFlash } from '@/server/flash';
import { SUBMISSION_FIELD, mintSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';

import { IDLE_RECORD_FORM } from './record-form-state';

/**
 * The two record forms' write path (EXP-002 slice 6). Mirrors
 * `lifecycle-actions.spec.ts`: the order is the assertion, each refusal proves
 * nothing was sent, and the asset a record goes to is the page's own — bound by
 * the form, named by the baseline the page signed for that form — and never a
 * field of it.
 */

const currentSession = jest.fn();
const recordInsurancePolicy = jest.fn();
const recordInspection = jest.fn();
const redirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock('@/server/current-session', () => ({ currentSession: () => currentSession() }));
jest.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));
jest.mock('@/server/asset-records', () => {
  const actual = jest.requireActual('@/server/asset-records');
  return {
    ...actual,
    recordInsurancePolicy: (...args: unknown[]) => recordInsurancePolicy(...args),
    recordInspection: (...args: unknown[]) => recordInspection(...args),
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
const actions = require('./record-actions') as typeof import('./record-actions');

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

interface Case {
  readonly name: string;
  readonly record: AssetRecordKind;
  readonly submit: (assetId: string, form: FormData) => Promise<unknown>;
  readonly send: jest.Mock;
  /** What a valid post of this form carries. */
  readonly valid: Record<string, string>;
  /** The body the service takes for `valid`. */
  readonly body: Record<string, unknown>;
  readonly notice: RecordNotice;
}

const CASES: readonly Case[] = [
  {
    name: 'record a policy',
    record: 'policy',
    submit: (assetId, form) => actions.submitRecordPolicy(assetId, IDLE_RECORD_FORM, form),
    send: recordInsurancePolicy,
    valid: {
      policyNumber: 'POL-1405-77',
      insurerName: 'بیمه ایران',
      coverage: 'THIRD_PARTY',
      premium: '۱۲۰٬۰۰۰٬۰۰۰',
      insuredValue: '',
      validFrom: '2026-10-01',
      validTo: '2027-10-01',
    },
    body: {
      policyNumber: 'POL-1405-77',
      insurerName: 'بیمه ایران',
      coverage: 'THIRD_PARTY',
      premiumMinor: '120000000',
      validFrom: '2026-09-30T20:30:00.000Z',
      validTo: '2027-09-30T20:30:00.000Z',
    },
    notice: 'policyRecorded',
  },
  {
    name: 'record an inspection',
    record: 'inspection',
    submit: (assetId, form) => actions.submitRecordInspection(assetId, IDLE_RECORD_FORM, form),
    send: recordInspection,
    valid: {
      certificateNo: 'INSP-4471',
      centerName: 'مرکز معاینه فنی شمال',
      inspectedAt: '2026-09-20',
      validTo: '2027-09-20',
      result: 'PASSED',
      notes: '',
    },
    body: {
      centerName: 'مرکز معاینه فنی شمال',
      certificateNo: 'INSP-4471',
      inspectedAt: '2026-09-19T20:30:00.000Z',
      result: 'PASSED',
      validTo: '2027-09-19T20:30:00.000Z',
    },
    notice: 'inspectionRecorded',
  },
];

/** What the page signs beside a form: this session, `assetId` (the page's by default), this form. */
const baselineFor = (testCase: Case, assetId: string = ASSET_ID): string =>
  sealAssetRecordBaseline(SESSION, { assetId, record: testCase.record });

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
  for (const send of [recordInsurancePolicy, recordInspection]) {
    send.mockReset();
    send.mockResolvedValue({
      kind: 'CREATED',
      data: { id: 'REC_1' },
      correlationId: 'corr-sample',
    });
  }
  redirect.mockClear();
});

const sent = () => [recordInsurancePolicy, recordInspection].flatMap((m) => m.mock.calls);

describe.each(CASES)('$name', (testCase) => {
  const submit = (form: FormData) => testCase.submit(ASSET_ID, form);

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

    it('checks the session, then CSRF, then the submission id, then the form, in that order', async () => {
      // Everything wrong at once: the first check names the refusal.
      const everything = formData(
        testCase,
        { policyNumber: '', certificateNo: '' },
        {
          csrf: 'wrong',
          submission: 'wrong',
        },
      );
      expect(await submit(everything)).toEqual({ kind: 'REFUSED', reason: 'CSRF' });
      currentSession.mockResolvedValue(null);
      expect(await submit(everything)).toEqual({ kind: 'REFUSED', reason: 'NO_SESSION' });
      currentSession.mockResolvedValue(SESSION);
      const badSubmission = formData(
        testCase,
        { policyNumber: '', certificateNo: '' },
        {
          submission: 'wrong',
        },
      );
      expect(await submit(badSubmission)).toEqual({ kind: 'REFUSED', reason: 'SUBMISSION' });
      const badBaseline = formData(
        testCase,
        { policyNumber: '', certificateNo: '' },
        { baseline: 'wrong' },
      );
      // The baseline before the form: an invalid form with a bad baseline is refused, not parsed.
      expect(await submit(badBaseline)).toEqual({ kind: 'REFUSED', reason: 'BASELINE' });
      expect(sent()).toHaveLength(0);
    });

    it('refuses a baseline that is missing, forged, somebody else’s, from an earlier login or minted for the other form', async () => {
      const other = CASES.find((candidate) => candidate.record !== testCase.record)!;
      const genuine = baselineFor(testCase);
      for (const baseline of [
        null,
        'chosen-by-the-client',
        `${genuine.slice(0, -2)}AA`,
        sealAssetRecordBaseline(
          { ...SESSION, subject: 'someone-else' },
          { assetId: ASSET_ID, record: testCase.record },
        ),
        sealAssetRecordBaseline(
          { ...SESSION, csrfToken: 'the-token-before-re-login' },
          { assetId: ASSET_ID, record: testCase.record },
        ),
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
      // The other machine's page gave this person a real baseline; posted in this
      // page's form it does not act here.
      expect(
        await submit(
          formData(testCase, undefined, { baseline: baselineFor(testCase, OTHER_ASSET_ID) }),
        ),
      ).toEqual({ kind: 'REFUSED', reason: 'BASELINE' });
      // The bound id is sent by the browser: rewritten to another asset, it no
      // longer matches what the page signed.
      expect(await testCase.submit(OTHER_ASSET_ID, formData(testCase))).toEqual({
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
        id: OTHER_ASSET_ID,
        asset: OTHER_ASSET_ID,
      });
      await redirectedTo(submit(tampered));

      expect(testCase.send).toHaveBeenCalledTimes(1);
      const args = testCase.send.mock.calls[0]!;
      expect(args[0]).toBe(SESSION);
      expect(args[1]).toBe(ASSET_ID);
      expect(JSON.stringify(args)).not.toContain(OTHER_ASSET_ID);
    });

    it('binds each page’s action to its own asset: two assets of one session each get their own record', async () => {
      await redirectedTo(testCase.submit(ASSET_ID, formData(testCase)));
      await redirectedTo(
        testCase.submit(
          OTHER_ASSET_ID,
          formData(testCase, undefined, { baseline: baselineFor(testCase, OTHER_ASSET_ID) }),
        ),
      );
      expect(testCase.send.mock.calls.map((call) => call[1])).toEqual([ASSET_ID, OTHER_ASSET_ID]);
    });

    it('sends the body the service takes, and nothing the person typed beyond the form’s own fields', async () => {
      await redirectedTo(
        submit(
          formData(testCase, { ...testCase.valid, role: 'SYSTEM_ADMIN', documentId: 'DOC_1' }),
        ),
      );
      expect(testCase.send.mock.calls[0]![2]).toEqual(testCase.body);
      expect(JSON.stringify(testCase.send.mock.calls[0])).not.toMatch(/SYSTEM_ADMIN|DOC_1/);
    });

    it('sends the submission id the form carried, as the replay key', async () => {
      const submission = mintSubmissionId(SESSION);
      await redirectedTo(submit(formData(testCase, undefined, { submission })));
      expect(testCase.send.mock.calls[0]![3]).toBe(submission);
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
  });

  describe('a double submit', () => {
    it('carries the same submission id both times, so the service answers the second with the first’s result', async () => {
      const submission = mintSubmissionId(SESSION);
      await redirectedTo(submit(formData(testCase, undefined, { submission })));
      await redirectedTo(submit(formData(testCase, undefined, { submission })));

      expect(testCase.send).toHaveBeenCalledTimes(2);
      const [first, second] = testCase.send.mock.calls;
      expect(first![3]).toBe(submission);
      expect(second![3]).toBe(submission);
      expect(second![2]).toEqual(first![2]);
      expect(second![1]).toBe(first![1]);
    });

    it('keeps the same submission id when it comes back with something to read', async () => {
      testCase.send.mockResolvedValue({
        kind: 'INVALID',
        fieldErrors: {},
        message: 'پیام',
        correlationId: 'corr-422',
      });
      const submission = mintSubmissionId(SESSION);
      expect(await submit(formData(testCase, undefined, { submission }))).toMatchObject({
        kind: 'INVALID',
        submissionId: submission,
        values: expect.objectContaining(testCase.valid),
        message: 'پیام',
      });
    });

    it.each([
      ['UNKNOWN_OUTCOME', { kind: 'UNKNOWN_OUTCOME', correlationId: 'c4' }],
      ['IN_PROGRESS', { kind: 'IN_PROGRESS', retryAfterSeconds: 1, correlationId: 'c4' }],
    ])(
      'says it does not know, never "nothing was saved", on %s — and the form can be sent again as it is',
      async (_name, result) => {
        testCase.send.mockResolvedValue(result);
        expect(await submit(formData(testCase))).toEqual({
          kind: 'UNCONFIRMED',
          correlationId: 'c4',
        });
        expect(redirect).not.toHaveBeenCalled();
      },
    );
  });

  describe('what the service answers', () => {
    it.each([
      [
        'FORBIDDEN',
        { kind: 'FORBIDDEN', correlationId: 'c1' },
        { kind: 'FORBIDDEN', correlationId: 'c1' },
      ],
      [
        'NOT_FOUND',
        { kind: 'NOT_FOUND', correlationId: 'c2' },
        { kind: 'NOT_FOUND', correlationId: 'c2' },
      ],
      [
        'UNAVAILABLE',
        { kind: 'UNAVAILABLE', status: 503, correlationId: 'c3' },
        { kind: 'FAILED', status: 503, correlationId: 'c3' },
      ],
    ])('says %s without claiming more than it knows', async (_name, result, state) => {
      testCase.send.mockResolvedValue(result);
      expect(await submit(formData(testCase))).toEqual(state);
      expect(redirect).not.toHaveBeenCalled();
    });

    it('answers a 404 for another organization’s asset exactly as for a missing one', async () => {
      testCase.send.mockResolvedValue({ kind: 'NOT_FOUND', correlationId: 'same-shape' });
      const ofAnotherTenant = await testCase.submit(ASSET_ID, formData(testCase));
      testCase.send.mockResolvedValue({ kind: 'NOT_FOUND', correlationId: 'same-shape' });
      const missing = 'AST_01J00000000000000000000123';
      const ofNothing = await testCase.submit(
        missing,
        formData(testCase, undefined, { baseline: baselineFor(testCase, missing) }),
      );
      expect(ofAnotherTenant).toEqual(ofNothing);
      expect(ofNothing).toMatchObject({ kind: 'NOT_FOUND' });
    });
  });
});

describe('record a policy: what the form itself catches', () => {
  const policy = CASES[0]!;
  const submit = (form: FormData) => policy.submit(ASSET_ID, form);

  it.each([
    ['no policy number', { policyNumber: ' ' }, 'policyNumber'],
    ['a short policy number', { policyNumber: 'ab' }, 'policyNumber'],
    ['no insurer', { insurerName: '' }, 'insurerName'],
    ['no coverage', { coverage: '' }, 'coverage'],
    ['a coverage the service has not got', { coverage: 'FIRE' }, 'coverage'],
    ['no start date', { validFrom: '' }, 'validFrom'],
    ['an impossible date', { validTo: '2027-02-31' }, 'validTo'],
    ['an end before the start', { validTo: '2026-09-01' }, 'validTo'],
    ['an end equal to the start', { validTo: '2026-10-01' }, 'validTo'],
    ['an amount that is not a number', { premium: 'abc' }, 'premium'],
    ['a negative amount', { insuredValue: '-5' }, 'insuredValue'],
  ])('does not call the service for %s', async (_name, change, field) => {
    expect(await submit(formData(policy, { ...policy.valid, ...change }))).toMatchObject({
      kind: 'INVALID',
      fieldErrors: { [field]: expect.any(String) },
    });
    expect(policy.send).not.toHaveBeenCalled();
  });

  it('keeps what was typed, and the submission id', async () => {
    const submission = mintSubmissionId(SESSION);
    const typed = { ...policy.valid, policyNumber: 'x' };
    expect(await submit(formData(policy, typed, { submission }))).toMatchObject({
      kind: 'INVALID',
      submissionId: submission,
      values: typed,
    });
  });
});

describe('record an inspection: what the form itself catches', () => {
  const inspection = CASES[1]!;
  const submit = (form: FormData) => inspection.submit(ASSET_ID, form);

  it.each([
    ['no certificate number', { certificateNo: '' }, 'certificateNo'],
    ['a short certificate number', { certificateNo: 'ab' }, 'certificateNo'],
    ['a one-letter centre', { centerName: 'م' }, 'centerName'],
    ['no result', { result: '' }, 'result'],
    ['a result the service has not got', { result: 'MAYBE' }, 'result'],
    ['no inspection date', { inspectedAt: '' }, 'inspectedAt'],
    ['an end before the inspection', { validTo: '2026-01-01' }, 'validTo'],
    ['notes over 1000 characters', { notes: 'ن'.repeat(1001) }, 'notes'],
    [
      'a certificate number carrying U+202E',
      { certificateNo: `INS-${String.fromCodePoint(0x202e)}1234` },
      'certificateNo',
    ],
    [
      'notes carrying U+061C',
      { notes: `لاستیک${String.fromCodePoint(0x061c)}ها فرسوده‌اند` },
      'notes',
    ],
    ['notes carrying U+2068', { notes: `یادداشت ${String.fromCodePoint(0x2068)}کوتاه` }, 'notes'],
  ])('does not call the service for %s', async (_name, change, field) => {
    expect(await submit(formData(inspection, { ...inspection.valid, ...change }))).toMatchObject({
      kind: 'INVALID',
      fieldErrors: { [field]: expect.any(String) },
    });
    expect(inspection.send).not.toHaveBeenCalled();
  });

  it('still sends notes written in Persian with ZWNJ', async () => {
    const notes = 'لاستیک\u200cها باید تا ماه بعد عوض شوند';
    await redirectedTo(submit(formData(inspection, { ...inspection.valid, notes })));
    expect(inspection.send.mock.calls[0]![2]).toMatchObject({ notes });
  });

  it('leaves a blank centre and blank notes out of the body', async () => {
    await redirectedTo(
      submit(formData(inspection, { ...inspection.valid, centerName: '  ', notes: '' })),
    );
    const body = inspection.send.mock.calls[0]![2] as Record<string, unknown>;
    expect(body).not.toHaveProperty('centerName');
    expect(body).not.toHaveProperty('notes');
  });
});
