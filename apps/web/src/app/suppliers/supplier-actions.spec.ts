/**
 * @jest-environment node
 */
import { BASELINE_FIELD } from '@/lib/form-fields';
import { STALE_MESSAGE, type SupplierCommand, type SupplierNotice } from '@/lib/supplier-commands';
import { CSRF_FIELD } from '@/server/csrf';
import { readFlash } from '@/server/flash';
import { SUBMISSION_FIELD, mintSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';
import { sealSupplierBaseline } from '@/server/supplier-commands';
import { withForgedMac } from '@/test/forged-token';

import { IDLE_SUPPLIER_FORM } from './supplier-form-state';

/**
 * The six supplier forms' write path. Mirrors `lifecycle-actions.spec.ts`: the
 * order is the assertion, each refusal proves nothing was sent, and what a
 * command acts on — the supplier and, for a decision, the qualification — comes
 * from the signed baseline and from nowhere the browser can write.
 */

const currentSession = jest.fn();
const registerSupplier = jest.fn();
const submitQualification = jest.fn();
const approveQualification = jest.fn();
const rejectQualification = jest.fn();
const suspendSupplier = jest.fn();
const reinstateSupplier = jest.fn();
const redirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock('@/server/current-session', () => ({
  currentSession: () => currentSession(),
  missingSessionReason: async () => 'NO_SESSION',
}));
jest.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));
jest.mock('@/server/supplier-commands', () => {
  const actual = jest.requireActual('@/server/supplier-commands');
  return {
    ...actual,
    registerSupplier: (...args: unknown[]) => registerSupplier(...args),
    submitQualification: (...args: unknown[]) => submitQualification(...args),
    approveQualification: (...args: unknown[]) => approveQualification(...args),
    rejectQualification: (...args: unknown[]) => rejectQualification(...args),
    suspendSupplier: (...args: unknown[]) => suspendSupplier(...args),
    reinstateSupplier: (...args: unknown[]) => reinstateSupplier(...args),
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
const actions = require('./supplier-actions') as typeof import('./supplier-actions');

const SESSION = {
  subject: 'user-1',
  username: 'operator',
  organizationId: 'ORG-UNION',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
} satisfies WebSession;

const SUPPLIER_ID = 'SUP_01J00000000000000000000000';
const OTHER_SUPPLIER_ID = 'SUP_01J00000000000000000000099';
const QUALIFICATION_ID = 'QUA_01J00000000000000000000000';

interface Case {
  readonly command: SupplierCommand;
  readonly qualificationId: string | null;
  readonly submit: (supplierId: string, form: FormData) => Promise<unknown>;
  readonly send: jest.Mock;
  /** What a valid post of this form carries. */
  readonly valid: Record<string, string>;
  readonly notice: SupplierNotice;
  /** What the gateway call must have received after the session. */
  readonly args: readonly unknown[];
  /** The one field a typo in it must come back on. */
  readonly invalid: Record<string, string>;
  readonly invalidField: string;
}

const CASES: readonly Case[] = [
  {
    command: 'SUBMIT_QUALIFICATION',
    qualificationId: null,
    submit: (id, form) => actions.submitQualificationRequest(id, IDLE_SUPPLIER_FORM, form),
    send: submitQualification,
    valid: {
      capability: 'WORKSHOP_SERVICE',
      statement: 'مجهز به دستگاه بالانس',
      evidenceDocumentId_0: 'DOC_1',
      evidenceLabel_0: 'پروانه کسب',
    },
    notice: 'submitted',
    args: [
      SUPPLIER_ID,
      {
        capability: 'WORKSHOP_SERVICE',
        statement: 'مجهز به دستگاه بالانس',
        evidence: [{ documentId: 'DOC_1', label: 'پروانه کسب' }],
      },
    ],
    invalid: { capability: '' },
    invalidField: 'capability',
  },
  {
    command: 'APPROVE_QUALIFICATION',
    qualificationId: QUALIFICATION_ID,
    submit: (id, form) => actions.submitApproveQualification(id, IDLE_SUPPLIER_FORM, form),
    send: approveQualification,
    valid: { note: 'مستندات کامل بود' },
    notice: 'approved',
    args: [SUPPLIER_ID, QUALIFICATION_ID, { note: 'مستندات کامل بود' }],
    invalid: { note: 'x'.repeat(2001) },
    invalidField: 'note',
  },
  {
    command: 'REJECT_QUALIFICATION',
    qualificationId: QUALIFICATION_ID,
    submit: (id, form) => actions.submitRejectQualification(id, IDLE_SUPPLIER_FORM, form),
    send: rejectQualification,
    valid: { reason: 'سند پیوست خوانا نیست' },
    notice: 'rejected',
    args: [SUPPLIER_ID, QUALIFICATION_ID, { reason: 'سند پیوست خوانا نیست' }],
    invalid: { reason: 'کوتاه' },
    invalidField: 'reason',
  },
  {
    command: 'SUSPEND',
    qualificationId: null,
    submit: (id, form) => actions.submitSuspendSupplier(id, IDLE_SUPPLIER_FORM, form),
    send: suspendSupplier,
    valid: { reason: 'شکایت تکراری مشتریان' },
    notice: 'suspended',
    args: [SUPPLIER_ID, { reason: 'شکایت تکراری مشتریان' }],
    invalid: { reason: '' },
    invalidField: 'reason',
  },
  {
    command: 'REINSTATE',
    qualificationId: null,
    submit: (id, form) => actions.submitReinstateSupplier(id, IDLE_SUPPLIER_FORM, form),
    send: reinstateSupplier,
    valid: { reason: 'شکایت‌ها بررسی و رفع شد' },
    notice: 'reinstated',
    args: [SUPPLIER_ID, { reason: 'شکایت‌ها بررسی و رفع شد' }],
    invalid: { reason: '' },
    invalidField: 'reason',
  },
];

function baselineFor(
  testCase: Case,
  over: Partial<Parameters<typeof sealSupplierBaseline>[1]> = {},
  session: WebSession = SESSION,
): string {
  return sealSupplierBaseline(session, {
    supplierId: SUPPLIER_ID,
    command: testCase.command,
    qualificationId: testCase.qualificationId,
    ...over,
  });
}

function formData(
  testCase: Case,
  fields: Record<string, string> = testCase.valid,
  options: {
    csrf?: string | null;
    submission?: string | null;
    /** `undefined`: the one this server signed for this command and supplier. */
    baseline?: string | null;
  } = {},
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

const ALL_SENDS = [
  registerSupplier,
  submitQualification,
  approveQualification,
  rejectQualification,
  suspendSupplier,
  reinstateSupplier,
];
const sent = () => ALL_SENDS.flatMap((m) => m.mock.calls);

beforeEach(() => {
  currentSession.mockResolvedValue(SESSION);
  for (const send of ALL_SENDS) {
    send.mockReset();
    send.mockResolvedValue({
      kind: 'CREATED',
      data: { id: SUPPLIER_ID },
      correlationId: 'corr-sample',
    });
  }
  redirect.mockClear();
});

describe.each(CASES)('$command', (testCase) => {
  describe('what is refused before anything is sent', () => {
    it('refuses a post with no session', async () => {
      currentSession.mockResolvedValue(null);
      expect(await testCase.submit(SUPPLIER_ID, formData(testCase))).toEqual({
        kind: 'REFUSED',
        reason: 'NO_SESSION',
      });
      expect(sent()).toHaveLength(0);
    });

    it.each([null, 'someone-elses'])('refuses CSRF token %j', async (csrf) => {
      expect(await testCase.submit(SUPPLIER_ID, formData(testCase, undefined, { csrf }))).toEqual({
        kind: 'REFUSED',
        reason: 'CSRF',
      });
      expect(sent()).toHaveLength(0);
    });

    it.each([null, 'sub_AAAAAAAAAAAAAAAAAAAA'])('refuses submission id %j', async (submission) => {
      expect(
        await testCase.submit(SUPPLIER_ID, formData(testCase, undefined, { submission })),
      ).toEqual({ kind: 'REFUSED', reason: 'SUBMISSION' });
      expect(sent()).toHaveLength(0);
    });

    it('refuses a post with no baseline, a forged one and one from an earlier login', async () => {
      const forged = withForgedMac(baselineFor(testCase));
      const earlier = baselineFor(testCase, {}, { ...SESSION, csrfToken: 'an-earlier-login-csrf' });
      for (const baseline of [null, 'not-a-token', forged, earlier]) {
        expect(
          await testCase.submit(SUPPLIER_ID, formData(testCase, undefined, { baseline })),
        ).toEqual({ kind: 'REFUSED', reason: 'BASELINE' });
      }
      expect(sent()).toHaveLength(0);
    });

    it('refuses a baseline minted for another command', async () => {
      const other = CASES.find((c) => c.command !== testCase.command)!;
      expect(
        await testCase.submit(
          SUPPLIER_ID,
          formData(testCase, undefined, { baseline: baselineFor(other) }),
        ),
      ).toEqual({ kind: 'REFUSED', reason: 'BASELINE' });
      expect(sent()).toHaveLength(0);
    });

    it("refuses another supplier's genuine baseline posted in this supplier's form", async () => {
      const foreign = baselineFor(testCase, { supplierId: OTHER_SUPPLIER_ID });
      expect(
        await testCase.submit(SUPPLIER_ID, formData(testCase, undefined, { baseline: foreign })),
      ).toEqual({ kind: 'REFUSED', reason: 'BASELINE' });
      expect(sent()).toHaveLength(0);
    });

    it('refuses a decision with no qualification and any other command with one', async () => {
      const wrong = baselineFor(testCase, {
        qualificationId: testCase.qualificationId === null ? QUALIFICATION_ID : null,
      });
      expect(
        await testCase.submit(SUPPLIER_ID, formData(testCase, undefined, { baseline: wrong })),
      ).toEqual({ kind: 'REFUSED', reason: 'BASELINE' });
      expect(sent()).toHaveLength(0);
    });

    it('keeps what was typed and says which field when the form is invalid — nothing is sent', async () => {
      const state = (await testCase.submit(SUPPLIER_ID, formData(testCase, testCase.invalid))) as {
        kind: string;
        fieldErrors: Record<string, string>;
        values: unknown;
      };
      expect(state.kind).toBe('INVALID');
      expect(Object.keys(state.fieldErrors)).toContain(testCase.invalidField);
      expect(sent()).toHaveLength(0);
    });
  });

  describe('what is sent', () => {
    it('sends the form to the gateway with the supplier and qualification from the baseline, and no key', async () => {
      const url = await redirectedTo(testCase.submit(SUPPLIER_ID, formData(testCase)));

      expect(testCase.send).toHaveBeenCalledTimes(1);
      const [session, ...rest] = testCase.send.mock.calls[0]!;
      expect(session).toEqual(SESSION);
      expect(rest).toEqual(testCase.args);
      // No submission id travels with the call: the endpoint takes no Idempotency-Key.
      expect(testCase.send.mock.calls[0]).toHaveLength(1 + testCase.args.length);

      expect(url.pathname).toBe(`/suppliers/${SUPPLIER_ID}`);
      const flash = url.searchParams.get('flash');
      expect(readFlash(SESSION, flash, SUPPLIER_ID, [testCase.notice])).toBe(testCase.notice);
      // A flash minted for this supplier is no confirmation for another one.
      expect(readFlash(SESSION, flash, OTHER_SUPPLIER_ID, [testCase.notice])).toBeUndefined();
    });

    it('ignores a supplier or qualification id written into the form', async () => {
      const fields = {
        ...testCase.valid,
        supplierId: OTHER_SUPPLIER_ID,
        id: OTHER_SUPPLIER_ID,
        qualificationId: 'QUA_FORGED',
      };
      await redirectedTo(testCase.submit(SUPPLIER_ID, formData(testCase, fields)));
      expect(testCase.send.mock.calls[0]!.slice(1)).toEqual(testCase.args);
    });
  });

  describe('what comes back', () => {
    const run = () => testCase.submit(SUPPLIER_ID, formData(testCase));

    it('says what the service refused, in a field or in a message, keeping the typed values', async () => {
      testCase.send.mockResolvedValue({
        kind: 'INVALID',
        fieldErrors: { [testCase.invalidField]: 'پیام ثابت' },
        message: 'پیام فرم',
        correlationId: 'corr-422',
      });
      const state = (await run()) as Record<string, unknown>;
      expect(state).toMatchObject({
        kind: 'INVALID',
        fieldErrors: { [testCase.invalidField]: 'پیام ثابت' },
        message: 'پیام فرم',
      });
      expect(state['submissionId']).toEqual(expect.stringMatching(/^sub_/));
    });

    it('sends a stale record to a fresh read with the stale notice — never a retry, never typed values', async () => {
      testCase.send.mockResolvedValue({
        kind: 'INVALID',
        fieldErrors: {},
        message: STALE_MESSAGE,
        correlationId: 'corr-422',
      });
      const url = await redirectedTo(run());
      expect(url.pathname).toBe(`/suppliers/${SUPPLIER_ID}`);
      expect(readFlash(SESSION, url.searchParams.get('flash'), SUPPLIER_ID, ['stale'])).toBe(
        'stale',
      );
      expect(testCase.send).toHaveBeenCalledTimes(1);
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
    ])('answers %j with %j and sends exactly once', async (result, expected) => {
      testCase.send.mockResolvedValue(result);
      expect(await run()).toEqual(expected);
      expect(testCase.send).toHaveBeenCalledTimes(1);
    });
  });
});

describe('REGISTER', () => {
  const VALID = { displayName: 'تعمیرگاه البرز', capabilities: 'WORKSHOP_SERVICE' };

  function registerForm(
    fields: Record<string, string | string[]> = VALID,
    options: { csrf?: string | null; submission?: string | null } = {},
  ): FormData {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      for (const one of Array.isArray(value) ? value : [value]) form.append(key, one);
    }
    const csrf = options.csrf === undefined ? SESSION.csrfToken : options.csrf;
    if (csrf !== null) form.set(CSRF_FIELD, csrf);
    const submission =
      options.submission === undefined ? mintSubmissionId(SESSION) : options.submission;
    if (submission !== null) form.set(SUBMISSION_FIELD, submission);
    return form;
  }

  const submit = (form: FormData) =>
    actions.submitRegisterSupplier(IDLE_SUPPLIER_FORM as never, form);

  it('refuses no session, a bad CSRF token and a foreign submission id before sending', async () => {
    currentSession.mockResolvedValue(null);
    expect(await submit(registerForm())).toEqual({ kind: 'REFUSED', reason: 'NO_SESSION' });
    currentSession.mockResolvedValue(SESSION);
    expect(await submit(registerForm(VALID, { csrf: 'x' }))).toEqual({
      kind: 'REFUSED',
      reason: 'CSRF',
    });
    expect(await submit(registerForm(VALID, { submission: 'sub_AAAAAAAAAAAAAAAAAAAA' }))).toEqual({
      kind: 'REFUSED',
      reason: 'SUBMISSION',
    });
    expect(sent()).toHaveLength(0);
  });

  it('keeps what was typed and names the fields when the form is invalid', async () => {
    const state = (await submit(registerForm({ displayName: 'ا' }))) as {
      kind: string;
      fieldErrors: Record<string, string>;
      values: { displayName: string };
    };
    expect(state.kind).toBe('INVALID');
    expect(Object.keys(state.fieldErrors).sort()).toEqual(['capabilities', 'displayName']);
    expect(state.values.displayName).toBe('ا');
    expect(sent()).toHaveLength(0);
  });

  it('sends the name and every ticked capability, with no organization and no key, then shows the new supplier', async () => {
    registerSupplier.mockResolvedValue({
      kind: 'CREATED',
      data: { id: SUPPLIER_ID },
      correlationId: 'corr',
    });
    const url = await redirectedTo(
      submit(
        registerForm({
          displayName: 'تعمیرگاه البرز',
          capabilities: ['WORKSHOP_SERVICE', 'GOODS_SUPPLY'],
          organizationId: 'ORG-FORGED',
        }),
      ),
    );
    expect(registerSupplier.mock.calls[0]).toEqual([
      SESSION,
      { displayName: 'تعمیرگاه البرز', capabilities: ['WORKSHOP_SERVICE', 'GOODS_SUPPLY'] },
    ]);
    expect(url.pathname).toBe(`/suppliers/${SUPPLIER_ID}`);
    expect(readFlash(SESSION, url.searchParams.get('flash'), SUPPLIER_ID, ['registered'])).toBe(
      'registered',
    );
  });

  it('keeps the form for a second registration (409) and does not retry', async () => {
    registerSupplier.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: {},
      message: 'این سازمان پیش از این پرونده تامین‌کننده دارد',
      correlationId: 'corr-409',
    });
    const state = await submit(registerForm());
    expect(state).toMatchObject({ kind: 'INVALID', message: expect.stringContaining('پرونده') });
    expect(registerSupplier).toHaveBeenCalledTimes(1);
  });
});
