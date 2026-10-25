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
import {
  RECONCILED_FIELD,
  RECONCILED_VALUE,
  RELEASE_FIELD,
  supplierWriteScope,
} from '@/server/supplier-unresolved';
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

/* eslint-disable @typescript-eslint/no-require-imports */
const actions = require('./supplier-actions') as typeof import('./supplier-actions');
const { readUnresolved, releaseToken, useUnresolvedStore } =
  require('@/server/unresolved-request') as typeof import('@/server/unresolved-request');
const { memoryUnresolvedStore, UnresolvedStoreUnavailable } =
  require('@/server/unresolved-request-store') as typeof import('@/server/unresolved-request-store');
/* eslint-enable @typescript-eslint/no-require-imports */

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
/** The newest episode a suspend form was drawn on, and the open one a reinstate lifts. */
const LATEST_EPISODE_ID = 'SSP_01J00000000000000000000001';
const OPEN_EPISODE_ID = 'SSP_01J00000000000000000000002';

interface Case {
  readonly command: SupplierCommand;
  readonly qualificationId: string | null;
  readonly suspensionId: string | null;
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
    suspensionId: null,
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
    suspensionId: null,
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
    suspensionId: null,
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
    suspensionId: LATEST_EPISODE_ID,
    submit: (id, form) => actions.submitSuspendSupplier(id, IDLE_SUPPLIER_FORM, form),
    send: suspendSupplier,
    valid: { reason: 'شکایت تکراری مشتریان' },
    notice: 'suspended',
    args: [SUPPLIER_ID, { reason: 'شکایت تکراری مشتریان', latestSuspensionId: LATEST_EPISODE_ID }],
    invalid: { reason: '' },
    invalidField: 'reason',
  },
  {
    command: 'REINSTATE',
    qualificationId: null,
    suspensionId: OPEN_EPISODE_ID,
    submit: (id, form) => actions.submitReinstateSupplier(id, IDLE_SUPPLIER_FORM, form),
    send: reinstateSupplier,
    valid: { reason: 'شکایت‌ها بررسی و رفع شد' },
    notice: 'reinstated',
    args: [SUPPLIER_ID, { reason: 'شکایت‌ها بررسی و رفع شد', suspensionId: OPEN_EPISODE_ID }],
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
    suspensionId: testCase.suspensionId,
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
  useUnresolvedStore(memoryUnresolvedStore());
});

afterEach(() => useUnresolvedStore(undefined));

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

    it('refuses a reinstatement naming no episode, and an episode on a command that names none', async () => {
      // Codex review of PR 366, finding 2: the episode is what the command was
      // decided on, so it comes from the signed baseline or the post is refused.
      if (testCase.command === 'SUSPEND') return; // its "none" is a real answer; below
      const wrong = baselineFor(testCase, {
        suspensionId: testCase.suspensionId === null ? 'SSP_SMUGGLED' : null,
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
        suspensionId: 'SSP_FORGED',
        latestSuspensionId: 'SSP_FORGED',
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
      // Proven unwritten: a 4xx with a documented code — "nothing changed".
      [
        { kind: 'UNAVAILABLE', status: 401, code: 'TOKEN_EXPIRED', correlationId: 'c3' },
        { kind: 'FAILED', status: 401, correlationId: 'c3' },
      ],
      [
        { kind: 'UNAVAILABLE', status: 429, code: 'RATE_LIMIT_EXCEEDED', correlationId: 'c6' },
        { kind: 'FAILED', status: 429, correlationId: 'c6' },
      ],
      // Ambiguous (Codex review of PR 366, finding 3): a 500 after a commit whose
      // read-back failed, a 503 for an upstream reset after the commit, a 502, a
      // 4xx with no code or an undocumented one — never "nothing changed".
      [
        { kind: 'UNAVAILABLE', status: 500, correlationId: 'c7' },
        { kind: 'UNCONFIRMED', correlationId: 'c7' },
      ],
      [
        { kind: 'UNAVAILABLE', status: 503, correlationId: 'c8' },
        { kind: 'UNCONFIRMED', correlationId: 'c8' },
      ],
      [
        { kind: 'UNAVAILABLE', status: 502, correlationId: 'c9' },
        { kind: 'UNCONFIRMED', correlationId: 'c9' },
      ],
      [
        { kind: 'UNAVAILABLE', status: 413, correlationId: 'c10' },
        { kind: 'UNCONFIRMED', correlationId: 'c10' },
      ],
      [
        { kind: 'UNAVAILABLE', status: 418, code: 'NOT_A_PLATFORM_CODE', correlationId: 'c11' },
        { kind: 'UNCONFIRMED', correlationId: 'c11' },
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

/**
 * An unresolved write is not forgotten (Codex review of PR 366, rounds 3 and 4).
 * supplier-service has no idempotency ledger, so after a lost answer nothing new
 * may go out for that supplier until the person says they re-read the record.
 * The record is on the server before the send: nothing lives in the response.
 */
const tokenFor = async (supplierId: string | null, session: WebSession = SESSION) => {
  const held = await readUnresolved(session, supplierWriteScope(supplierId));
  if (held.kind !== 'PENDING') throw new Error(`expected a held request, got ${held.kind}`);
  return releaseToken(session, supplierWriteScope(supplierId), held.request);
};

function reconcileForm(token: string | null, confirmed = true, csrf = SESSION.csrfToken) {
  const form = new FormData();
  form.set(CSRF_FIELD, csrf);
  if (confirmed) form.set(RECONCILED_FIELD, RECONCILED_VALUE);
  if (token !== null) form.set(RELEASE_FIELD, token);
  return form;
}

/** A store that cannot be reached, or only some of whose calls can. */
function unreachable(over: Partial<ReturnType<typeof memoryUnresolvedStore>> = {}) {
  const down = () => {
    throw new UnresolvedStoreUnavailable(new Error('ECONNREFUSED'));
  };
  return {
    read: down,
    reserve: down,
    settle: down,
    release: down,
    purge: down,
    ...over,
  } as ReturnType<typeof memoryUnresolvedStore>;
}

describe.each(CASES)('$command — an unresolved write', (testCase) => {
  const run = (form: FormData = formData(testCase)) => testCase.submit(SUPPLIER_ID, form);
  /** The first press: sent, answer ambiguous. Returns the submission id it was sent under. */
  const lose = async () => {
    const submission = mintSubmissionId(SESSION);
    testCase.send.mockResolvedValue({ kind: 'UNKNOWN_OUTCOME', correlationId: 'corr-lost' });
    expect(await run(formData(testCase, undefined, { submission }))).toEqual({
      kind: 'UNCONFIRMED',
      correlationId: 'corr-lost',
    });
    testCase.send.mockClear();
    return submission;
  };
  const reconcile = (token: string | null, confirmed = true, supplierId = SUPPLIER_ID) =>
    redirectedTo(actions.reconcileSupplierWrite(supplierId, reconcileForm(token, confirmed)));

  it('is on the server before the answer comes back: a response that never reaches the browser loses nothing', async () => {
    // The action's own reply is discarded here (the browser never got it). The
    // next press — a fresh form, a fresh submission id — must still be held.
    testCase.send.mockResolvedValue({ kind: 'UNKNOWN_OUTCOME', correlationId: 'corr-lost' });
    await run();
    testCase.send.mockClear();
    const state = (await run(formData(testCase))) as { kind: string };
    expect(state.kind).toBe('UNCONFIRMED');
    expect(sent()).toHaveLength(0);
  });

  it('leaves nothing held after a confirmed send', async () => {
    await redirectedTo(run());
    expect(await readUnresolved(SESSION, supplierWriteScope(SUPPLIER_ID))).toEqual({
      kind: 'NONE',
    });
  });

  it('is held even when the action itself dies after the send went out', async () => {
    testCase.send.mockRejectedValue(new Error('the process was cut off'));
    await expect(run()).rejects.toThrow('cut off');
    testCase.send.mockClear();
    expect(((await run(formData(testCase))) as { kind: string }).kind).toBe('UNCONFIRMED');
    expect(sent()).toHaveLength(0);
  });

  it('keeps its warning, naming the held request, when the next submission is invalid', async () => {
    const first = await lose();
    const state = await run(formData(testCase, testCase.invalid));
    expect(state).toEqual({ kind: 'UNCONFIRMED', correlationId: first });
    expect(sent()).toHaveLength(0);
  });

  it('keeps it across a fresh form: a valid post with a new submission id is not sent', async () => {
    const first = await lose();
    expect(await run(formData(testCase))).toEqual({ kind: 'UNCONFIRMED', correlationId: first });
    // The same form pressed again, same id, same body: not sent again either.
    expect(await run(formData(testCase, undefined, { submission: first }))).toEqual({
      kind: 'UNCONFIRMED',
      correlationId: first,
    });
    expect(sent()).toHaveLength(0);
  });

  it('is read back for the page, for this person, organization and login only', async () => {
    await lose();
    const scope = supplierWriteScope(SUPPLIER_ID);
    expect(await readUnresolved(SESSION, scope)).toMatchObject({
      kind: 'PENDING',
      request: { deadline: null, inFlight: false },
    });
    const none = { kind: 'NONE' };
    expect(await readUnresolved({ ...SESSION, subject: 'user-2' }, scope)).toEqual(none);
    expect(await readUnresolved({ ...SESSION, organizationId: 'ORG-OTHER' }, scope)).toEqual(none);
    expect(await readUnresolved({ ...SESSION, csrfToken: 'a-later-login' }, scope)).toEqual(none);
    expect(await readUnresolved(SESSION, supplierWriteScope(OTHER_SUPPLIER_ID))).toEqual(none);
    expect(await readUnresolved(SESSION, supplierWriteScope(null))).toEqual(none);
  });

  it('does not hold another person, who sends as usual', async () => {
    await lose();
    const other = { ...SESSION, subject: 'user-2', csrfToken: 'csrf-of-user-2' };
    currentSession.mockResolvedValue(other);
    testCase.send.mockResolvedValue({ kind: 'FORBIDDEN', correlationId: 'corr-other' });
    const form = formData(testCase, undefined, {
      csrf: other.csrfToken,
      submission: mintSubmissionId(other),
      baseline: baselineFor(testCase, {}, other),
    });
    expect(await run(form)).toEqual({ kind: 'FORBIDDEN', correlationId: 'corr-other' });
    expect(testCase.send).toHaveBeenCalledTimes(1);
  });

  it('does not hold the same command on another supplier', async () => {
    await lose();
    testCase.send.mockResolvedValue({ kind: 'FORBIDDEN', correlationId: 'corr-other' });
    const form = formData(testCase, undefined, {
      baseline: baselineFor(testCase, { supplierId: OTHER_SUPPLIER_ID }),
    });
    expect(await testCase.submit(OTHER_SUPPLIER_ID, form)).toEqual({
      kind: 'FORBIDDEN',
      correlationId: 'corr-other',
    });
  });

  it('holds every other command on the same supplier, and not the registration', async () => {
    await lose();
    const other = CASES.find((c) => c.command !== testCase.command)!;
    expect(((await other.submit(SUPPLIER_ID, formData(other))) as { kind: string }).kind).toBe(
      'UNCONFIRMED',
    );
    expect(sent()).toHaveLength(0);
    expect(await readUnresolved(SESSION, supplierWriteScope(null))).toEqual({ kind: 'NONE' });
  });

  it('is released only by a confirmed reconciliation, after which a new send is allowed', async () => {
    const first = await lose();
    const token = await tokenFor(SUPPLIER_ID);
    const url = await reconcile(token, false);
    expect(url.pathname).toBe(`/suppliers/${SUPPLIER_ID}`);
    expect(await run()).toEqual({ kind: 'UNCONFIRMED', correlationId: first });
    expect(sent()).toHaveLength(0);

    await reconcile(token);
    testCase.send.mockResolvedValue({
      kind: 'CREATED',
      data: { id: SUPPLIER_ID },
      correlationId: 'c',
    });
    await redirectedTo(run());
    expect(testCase.send).toHaveBeenCalledTimes(1);
  });

  it('is not released by a post with a wrong CSRF token, no session or no token', async () => {
    const first = await lose();
    const token = await tokenFor(SUPPLIER_ID);
    await redirectedTo(
      actions.reconcileSupplierWrite(SUPPLIER_ID, reconcileForm(token, true, 'someone-elses')),
    );
    currentSession.mockResolvedValue(null);
    await redirectedTo(actions.reconcileSupplierWrite(SUPPLIER_ID, reconcileForm(token)));
    currentSession.mockResolvedValue(SESSION);
    for (const bad of [null, 'not-a-token', withForgedMac(token)]) {
      const url = await reconcile(bad);
      expect(url.searchParams.get('release')).toBe('STALE');
    }
    expect(await run()).toEqual({ kind: 'UNCONFIRMED', correlationId: first });
  });

  it("a stale confirmation is refused: tab A's form for C1 cannot release C2", async () => {
    // C1 is lost; tab A draws the confirmation for C1. Tab B reconciles C1 and
    // sends again; that send (C2) is lost too. Tab A now submits its old form.
    const c1 = await lose();
    const tokenA = await tokenFor(SUPPLIER_ID);
    await reconcile(tokenA); // tab B
    expect(await readUnresolved(SESSION, supplierWriteScope(SUPPLIER_ID))).toEqual({
      kind: 'NONE',
    });
    const c2 = await lose();
    expect(c2).not.toBe(c1);

    const url = await reconcile(tokenA); // tab A, stale
    expect(url.searchParams.get('release')).toBe('STALE');

    // C2 is still held: a fresh command is not sent.
    expect(await run(formData(testCase))).toEqual({ kind: 'UNCONFIRMED', correlationId: c2 });
    expect(sent()).toHaveLength(0);
    // Its own confirmation (drawn for C2) does release it.
    await reconcile(await tokenFor(SUPPLIER_ID));
    expect(await readUnresolved(SESSION, supplierWriteScope(SUPPLIER_ID))).toEqual({
      kind: 'NONE',
    });
  });

  it('holds a second tab while the first send is in flight, and sends once', async () => {
    let finish: (value: unknown) => void = () => undefined;
    testCase.send.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const tabA = run(formData(testCase));
    // Let tab A reach its dispatch before tab B presses.
    await new Promise((resolve) => setImmediate(resolve));
    expect(testCase.send).toHaveBeenCalledTimes(1);

    expect(await run(formData(testCase))).toEqual({ kind: 'BUSY' });
    expect(testCase.send).toHaveBeenCalledTimes(1);
    // Tab B's reconciliation cannot release a send that is under way either.
    const token = await tokenFor(SUPPLIER_ID);
    expect((await reconcile(token)).searchParams.get('release')).toBe('IN_PROGRESS');

    finish({ kind: 'UNKNOWN_OUTCOME', correlationId: 'corr-a' });
    expect(await tabA).toEqual({ kind: 'UNCONFIRMED', correlationId: 'corr-a' });
    expect(((await run(formData(testCase))) as { kind: string }).kind).toBe('UNCONFIRMED');
    expect(testCase.send).toHaveBeenCalledTimes(1);
  });

  it('the reservation itself refuses the same key and body again, whatever the page check said', async () => {
    // The earlier check answers "nothing held"; the atomic reservation decides.
    useUnresolvedStore({
      ...memoryUnresolvedStore(),
      read: async () => ({ record: null, now: Date.now() }),
    });
    const first = mintSubmissionId(SESSION);
    testCase.send.mockResolvedValue({ kind: 'UNKNOWN_OUTCOME', correlationId: 'corr-lost' });
    await run(formData(testCase, undefined, { submission: first }));
    testCase.send.mockClear();
    expect(await run(formData(testCase, undefined, { submission: first }))).toEqual({
      kind: 'UNCONFIRMED',
      correlationId: first,
    });
    expect(sent()).toHaveLength(0);
  });

  it('sends nothing when the store cannot be reached, before or at the reservation', async () => {
    useUnresolvedStore(unreachable());
    expect(await run()).toEqual({ kind: 'NOT_CHECKED' });
    expect(sent()).toHaveLength(0);

    // The check passes, the atomic reservation does not: still nothing goes out.
    useUnresolvedStore(unreachable({ read: async () => ({ record: null, now: Date.now() }) }));
    expect(await run()).toEqual({ kind: 'NOT_CHECKED' });
    expect(sent()).toHaveLength(0);
  });

  it('answers a store full of unresolved requests without sending', async () => {
    const inner = memoryUnresolvedStore();
    useUnresolvedStore({
      ...inner,
      reserve: (input) => inner.reserve({ ...input, cap: 0 }),
    });
    expect(await run()).toEqual({ kind: 'CAPACITY' });
    expect(sent()).toHaveLength(0);
  });

  it('remembers an ambiguous 5xx, but not a proven refusal or a send that never left', async () => {
    const scope = supplierWriteScope(SUPPLIER_ID);
    const none = { kind: 'NONE' };
    testCase.send.mockResolvedValue({
      kind: 'UNAVAILABLE',
      status: 429,
      code: 'RATE_LIMIT_EXCEEDED',
      correlationId: 'c6',
    });
    expect(await run()).toMatchObject({ kind: 'FAILED' });
    expect(await readUnresolved(SESSION, scope)).toEqual(none);

    // Zero bytes sent (ECONNREFUSED): nothing can have happened — no hold, and
    // the next valid submission goes through.
    testCase.send.mockResolvedValue({
      kind: 'UNAVAILABLE',
      status: 503,
      correlationId: 'c12',
      neverSent: true,
    });
    expect(await run()).toEqual({ kind: 'FAILED', status: 503, correlationId: 'c12' });
    expect(await readUnresolved(SESSION, scope)).toEqual(none);
    testCase.send.mockClear();
    testCase.send.mockResolvedValue({
      kind: 'CREATED',
      data: { id: SUPPLIER_ID },
      correlationId: 'c',
    });
    await redirectedTo(run());
    expect(testCase.send).toHaveBeenCalledTimes(1);

    testCase.send.mockResolvedValue({ kind: 'UNAVAILABLE', status: 503, correlationId: 'c8' });
    expect(await run()).toEqual({ kind: 'UNCONFIRMED', correlationId: 'c8' });
    expect(await readUnresolved(SESSION, scope)).toMatchObject({ kind: 'PENDING' });
  });
});

describe('REGISTER — an unresolved write', () => {
  const form = (fields: Record<string, string>, submission = mintSubmissionId(SESSION)) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    data.set(CSRF_FIELD, SESSION.csrfToken);
    data.set(SUBMISSION_FIELD, submission);
    return data;
  };
  const submit = (fields: Record<string, string>, submission?: string) =>
    actions.submitRegisterSupplier(IDLE_SUPPLIER_FORM as never, form(fields, submission));
  const VALID = { displayName: 'تعمیرگاه البرز', capabilities: 'WORKSHOP_SERVICE' };

  it('keeps its warning through an invalid post and is released by reconciliation', async () => {
    const first = mintSubmissionId(SESSION);
    registerSupplier.mockResolvedValue({ kind: 'UNKNOWN_OUTCOME', correlationId: 'corr-reg' });
    expect(await submit(VALID, first)).toEqual({ kind: 'UNCONFIRMED', correlationId: 'corr-reg' });
    registerSupplier.mockClear();

    expect(await submit({ displayName: '' })).toEqual({
      kind: 'UNCONFIRMED',
      correlationId: first,
    });
    expect(await submit(VALID)).toEqual({ kind: 'UNCONFIRMED', correlationId: first });
    expect(registerSupplier).not.toHaveBeenCalled();

    const token = await tokenFor(null);
    expect(
      (await redirectedTo(actions.reconcileSupplierWrite(null, reconcileForm(token)))).pathname,
    ).toBe('/suppliers');
    registerSupplier.mockResolvedValue({
      kind: 'CREATED',
      data: { id: SUPPLIER_ID },
      correlationId: 'c',
    });
    await redirectedTo(submit(VALID));
    expect(registerSupplier).toHaveBeenCalledTimes(1);
  });

  it('is not held by a lost write on a supplier, and does not hold one', async () => {
    registerSupplier.mockResolvedValue({ kind: 'UNKNOWN_OUTCOME', correlationId: 'corr-reg' });
    await submit(VALID);
    expect(await readUnresolved(SESSION, supplierWriteScope(SUPPLIER_ID))).toEqual({
      kind: 'NONE',
    });
    expect(await readUnresolved(SESSION, supplierWriteScope(null))).toMatchObject({
      kind: 'PENDING',
    });
  });

  it('sends nothing when the store cannot be reached, and nothing for a lost response', async () => {
    registerSupplier.mockResolvedValue({ kind: 'UNKNOWN_OUTCOME', correlationId: 'corr-reg' });
    await submit(VALID); // reply discarded
    registerSupplier.mockClear();
    expect(((await submit(VALID)) as { kind: string }).kind).toBe('UNCONFIRMED');
    useUnresolvedStore(unreachable());
    expect(await submit(VALID)).toEqual({ kind: 'NOT_CHECKED' });
    expect(registerSupplier).not.toHaveBeenCalled();
  });

  it('a send that never left is not remembered', async () => {
    registerSupplier.mockResolvedValue({
      kind: 'UNAVAILABLE',
      status: 503,
      correlationId: 'c12',
      neverSent: true,
    });
    expect(await submit(VALID)).toMatchObject({ kind: 'FAILED', status: 503 });
    expect(await readUnresolved(SESSION, supplierWriteScope(null))).toEqual({ kind: 'NONE' });
    registerSupplier.mockResolvedValue({
      kind: 'CREATED',
      data: { id: SUPPLIER_ID },
      correlationId: 'c',
    });
    await redirectedTo(submit(VALID));
  });
});

describe('SUSPEND on a supplier never suspended before', () => {
  it('sends latestSuspensionId null — "none" is what the page showed, and the service checks it', async () => {
    const testCase = CASES.find((c) => c.command === 'SUSPEND')!;
    const baseline = baselineFor(testCase, { suspensionId: null });

    await redirectedTo(testCase.submit(SUPPLIER_ID, formData(testCase, undefined, { baseline })));

    expect(suspendSupplier.mock.calls[0]!.slice(1)).toEqual([
      SUPPLIER_ID,
      { reason: 'شکایت تکراری مشتریان', latestSuspensionId: null },
    ]);
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
      message: 'این سازمان پیش از این پرونده تأمین‌کننده دارد',
      correlationId: 'corr-409',
    });
    const state = await submit(registerForm());
    expect(state).toMatchObject({ kind: 'INVALID', message: expect.stringContaining('پرونده') });
    expect(registerSupplier).toHaveBeenCalledTimes(1);
  });
});
