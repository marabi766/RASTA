/**
 * @jest-environment node
 */
import { BASELINE_FIELD, REPLAY_FIELD } from '@/lib/form-fields';
import { STALE_MESSAGE } from '@/lib/project-commands';
import {
  NEED_NOTHING_CHANGED_MESSAGE,
  type NeedCommand,
  type NeedNotice,
} from '@/lib/project-need-commands';
import { CSRF_FIELD } from '@/server/csrf';
import { readFlash } from '@/server/flash';
import {
  mintNeedSubmission,
  needCreateScope,
  needEditDigests,
  needStampTerms,
  sealNeedBaseline,
  type NeedBaseline,
} from '@/server/project-need-commands';
import type { ReleaseSubject } from '@/server/release-feedback';
import { signPayload } from '@/server/signed-payload';
import { SUBMISSION_FIELD, mintSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';
import { readUnresolved, releaseToken, useUnresolvedStore } from '@/server/unresolved-request';
import {
  memoryUnresolvedStore,
  UnresolvedStoreUnavailable,
} from '@/server/unresolved-request-store';
import { withForgedMac } from '@/test/forged-token';
import { feedbackFor } from '@/test/release-query';
import { actingAccessToken } from '@/test/session-token';

import { IDLE_ADD_NEED_FORM } from './need-form-state';
import { IDLE_PROJECT_FORM } from './project-form-state';

/**
 * The need commands' write path. Mirrors `project-actions.spec.ts`: the order is
 * the assertion, each refusal proves nothing was sent, and what a command acts on
 * — the need and the version — comes from the signed baseline and from nowhere the
 * browser can write. Adding is keyed and checked on its own below.
 */

const currentSession = jest.fn();
const addNeed = jest.fn();
const updateNeed = jest.fn();
const submitNeed = jest.fn();
const withdrawNeed = jest.fn();
const redirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock('@/server/current-session', () => ({
  currentSession: () => currentSession(),
  missingSessionReason: async () => 'NO_SESSION',
}));
jest.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));
jest.mock('@/server/project-need-commands', () => {
  const actual = jest.requireActual('@/server/project-need-commands');
  return {
    ...actual,
    addNeed: (...args: unknown[]) => addNeed(...args),
    updateNeed: (...args: unknown[]) => updateNeed(...args),
    submitNeed: (...args: unknown[]) => submitNeed(...args),
    withdrawNeed: (...args: unknown[]) => withdrawNeed(...args),
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
const actions = {
  ...(require('./need-actions') as typeof import('./need-actions')),
  ...(require('./need-add-actions') as typeof import('./need-add-actions')),
};
/* eslint-enable @typescript-eslint/no-require-imports */

const SESSION = {
  subject: 'user-1',
  username: 'owner',
  organizationId: 'ORG-OWNER',
  accessToken: actingAccessToken('ORG-OWNER', ['ORGANIZATION_ADMIN']),
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
} satisfies WebSession;

const PROJECT_ID = 'PRJ_01J00000000000000000000000';
const OTHER_PROJECT_ID = 'PRJ_01J00000000000000000000099';
const NEED_ID = 'NED_01J00000000000000000000000';
const OTHER_NEED_ID = 'NED_01J00000000000000000000099';
const VERSION = 3;
/** The project's version when the page was drawn: the editing episode (F2). */
const PROJECT_VERSION = 9;
const FENCE = { expectedVersion: VERSION, expectedProjectVersion: PROJECT_VERSION };

const INITIAL = {
  title: 'بتن آماده',
  description: 'بتن با مقاومت بالا',
  quantity: '25',
  unit: 'متر مکعب',
  estimatedCost: '1500000',
};

interface Case {
  readonly command: NeedCommand;
  readonly baseline: Partial<NeedBaseline>;
  readonly submit: (form: FormData) => Promise<unknown>;
  readonly send: jest.Mock;
  readonly valid: Record<string, string>;
  readonly notice: NeedNotice;
  /** What the gateway call must have received after the session, project and need. */
  readonly args: readonly unknown[];
  readonly invalid: Record<string, string> | null;
  readonly invalidField: string | null;
}

const CASES: readonly Case[] = [
  {
    command: 'edit',
    baseline: { digests: needEditDigests(INITIAL) },
    submit: (form) => actions.submitEditNeed(PROJECT_ID, NEED_ID, IDLE_PROJECT_FORM, form),
    send: updateNeed,
    valid: { ...INITIAL, title: 'بتن آماده شمالی' },
    notice: 'needUpdated',
    args: [{ title: 'بتن آماده شمالی' }, FENCE],
    invalid: { ...INITIAL, title: 'ا' },
    invalidField: 'title',
  },
  {
    command: 'submit',
    baseline: {},
    submit: (form) => actions.submitSubmitNeed(PROJECT_ID, NEED_ID, IDLE_PROJECT_FORM, form),
    send: submitNeed,
    valid: {},
    notice: 'needSubmitted',
    args: [FENCE],
    invalid: null,
    invalidField: null,
  },
  {
    command: 'withdraw',
    baseline: {},
    submit: (form) => actions.submitWithdrawNeed(PROJECT_ID, NEED_ID, IDLE_PROJECT_FORM, form),
    send: withdrawNeed,
    valid: { reason: 'دیگر لازم نیست' },
    notice: 'needWithdrawn',
    args: [{ reason: 'دیگر لازم نیست' }, FENCE],
    invalid: { reason: 'کوتاه' },
    invalidField: 'reason',
  },
];

function baselineFor(
  testCase: Case,
  over: Partial<NeedBaseline> = {},
  session: WebSession = SESSION,
): string {
  return sealNeedBaseline(session, {
    needId: NEED_ID,
    projectId: PROJECT_ID,
    command: testCase.command,
    version: VERSION,
    projectVersion: PROJECT_VERSION,
    status: 'DRAFT',
    digests: null,
    ...testCase.baseline,
    ...over,
  });
}

function formData(
  testCase: Case,
  fields: Record<string, string> = testCase.valid,
  options: {
    csrf?: string | null;
    submission?: string | null;
    /** `undefined`: the one this server signed for this command and need. */
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

const ALL_SENDS = [addNeed, updateNeed, submitNeed, withdrawNeed];
const sent = () => ALL_SENDS.flatMap((m) => m.mock.calls);

beforeEach(() => {
  currentSession.mockResolvedValue(SESSION);
  for (const send of ALL_SENDS) {
    send.mockReset();
    send.mockResolvedValue({
      kind: 'CREATED',
      data: { id: NEED_ID },
      correlationId: 'corr-sample',
    });
  }
  redirect.mockClear();
  useUnresolvedStore(memoryUnresolvedStore());
});

describe.each(CASES)('$command', (testCase) => {
  describe('what is refused before anything is sent', () => {
    it('refuses a post with no session', async () => {
      currentSession.mockResolvedValue(null);
      expect(await testCase.submit(formData(testCase))).toEqual({
        kind: 'REFUSED',
        reason: 'NO_SESSION',
      });
      expect(sent()).toHaveLength(0);
    });

    it.each([null, 'someone-elses'])('refuses CSRF token %j', async (csrf) => {
      expect(await testCase.submit(formData(testCase, undefined, { csrf }))).toEqual({
        kind: 'REFUSED',
        reason: 'CSRF',
      });
      expect(sent()).toHaveLength(0);
    });

    it.each([null, 'sub_AAAAAAAAAAAAAAAAAAAA'])('refuses submission id %j', async (submission) => {
      expect(await testCase.submit(formData(testCase, undefined, { submission }))).toEqual({
        kind: 'REFUSED',
        reason: 'SUBMISSION',
      });
      expect(sent()).toHaveLength(0);
    });

    it('refuses a post with no baseline, a forged one and one from an earlier login', async () => {
      const forged = withForgedMac(baselineFor(testCase));
      const earlier = baselineFor(testCase, {}, { ...SESSION, csrfToken: 'an-earlier-login-csrf' });
      for (const baseline of [null, 'not-a-token', forged, earlier]) {
        expect(await testCase.submit(formData(testCase, undefined, { baseline }))).toEqual({
          kind: 'REFUSED',
          reason: 'BASELINE',
        });
      }
      expect(sent()).toHaveLength(0);
    });

    it('refuses a baseline minted for another command', async () => {
      const other = CASES.find((c) => c.command !== testCase.command)!;
      expect(
        await testCase.submit(formData(testCase, undefined, { baseline: baselineFor(other) })),
      ).toEqual({ kind: 'REFUSED', reason: 'BASELINE' });
      expect(sent()).toHaveLength(0);
    });

    it("refuses another need's or another project's genuine baseline posted in this form", async () => {
      for (const over of [{ needId: OTHER_NEED_ID }, { projectId: OTHER_PROJECT_ID }]) {
        const foreign = baselineFor(testCase, over);
        expect(await testCase.submit(formData(testCase, undefined, { baseline: foreign }))).toEqual(
          { kind: 'REFUSED', reason: 'BASELINE' },
        );
      }
      expect(sent()).toHaveLength(0);
    });

    if (testCase.invalid && testCase.invalidField) {
      const invalid = testCase.invalid;
      const invalidField = testCase.invalidField;
      it('keeps what was typed and says which field when the form is invalid — nothing is sent', async () => {
        const state = (await testCase.submit(formData(testCase, invalid))) as {
          kind: string;
          fieldErrors: Record<string, string>;
          submissionId: string;
        };
        expect(state.kind).toBe('INVALID');
        expect(Object.keys(state.fieldErrors)).toContain(invalidField);
        expect(state.submissionId).toEqual(expect.stringMatching(/^sub_/));
        expect(sent()).toHaveLength(0);
      });
    }
  });

  describe('what is sent', () => {
    it('sends the form to the gateway with the need and version from the baseline, and no key', async () => {
      const url = await redirectedTo(testCase.submit(formData(testCase)));

      expect(testCase.send).toHaveBeenCalledTimes(1);
      const [session, projectId, needId, ...rest] = testCase.send.mock.calls[0]!;
      expect(session).toEqual(SESSION);
      expect([projectId, needId]).toEqual([PROJECT_ID, NEED_ID]);
      expect(rest).toEqual(testCase.args);
      // No submission id travels with the call: the endpoint takes no Idempotency-Key.
      expect(testCase.send.mock.calls[0]).toHaveLength(3 + testCase.args.length);

      expect(url.pathname).toBe(`/projects/${PROJECT_ID}`);
      const flash = url.searchParams.get('flash');
      expect(readFlash(SESSION, flash, PROJECT_ID, [testCase.notice])).toBe(testCase.notice);
      // A flash minted for this project is no confirmation for another one.
      expect(readFlash(SESSION, flash, OTHER_PROJECT_ID, [testCase.notice])).toBeUndefined();
    });

    it('ignores a project, need or version written into the form', async () => {
      const fields = {
        ...testCase.valid,
        id: OTHER_NEED_ID,
        needId: OTHER_NEED_ID,
        projectId: OTHER_PROJECT_ID,
        expectedVersion: '99',
        version: '99',
        expectedProjectVersion: '99',
        projectVersion: '99',
        organizationId: 'ORG-FORGED',
      };
      await redirectedTo(testCase.submit(formData(testCase, fields)));
      expect(testCase.send.mock.calls[0]!.slice(1)).toEqual([
        PROJECT_ID,
        NEED_ID,
        ...testCase.args,
      ]);
    });

    it('is fenced to the editing episode it was drawn in: the project version comes from its baseline (F2)', async () => {
      // Drawn at project version 4; an approval round since moved the project on and left the need's
      // version alone. The form still sends 4, and construction-service refuses it under the project
      // lock (409 OPTIMISTIC_LOCK_FAILED, said as stale) — the old confirmation cannot act now.
      const earlier = baselineFor(testCase, { projectVersion: 4 });
      testCase.send.mockResolvedValue({
        kind: 'INVALID',
        fieldErrors: {},
        message: STALE_MESSAGE,
        correlationId: 'corr-409',
      });
      const url = await redirectedTo(
        testCase.submit(formData(testCase, undefined, { baseline: earlier })),
      );
      expect(testCase.send.mock.calls[0]!.at(-1)).toEqual({
        expectedVersion: VERSION,
        expectedProjectVersion: 4,
      });
      expect(readFlash(SESSION, url.searchParams.get('flash'), PROJECT_ID, ['stale'])).toBe(
        'stale',
      );
      expect(testCase.send).toHaveBeenCalledTimes(1);
    });

    it('refuses a baseline that names no project version — it could not be fenced (F2, fail closed)', async () => {
      const unfenced = signPayload(
        SESSION,
        'project-need-baseline',
        {
          needId: NEED_ID,
          projectId: PROJECT_ID,
          command: testCase.command,
          version: VERSION,
          status: 'DRAFT',
          digests: testCase.baseline.digests ?? null,
        },
        60,
      );
      expect(await testCase.submit(formData(testCase, undefined, { baseline: unfenced }))).toEqual({
        kind: 'REFUSED',
        reason: 'BASELINE',
      });
      expect(sent()).toHaveLength(0);
    });
  });

  describe('what comes back', () => {
    const run = () => testCase.submit(formData(testCase));

    it('says what the service refused, in a field or in a message, keeping the typed values', async () => {
      testCase.send.mockResolvedValue({
        kind: 'INVALID',
        fieldErrors: { title: 'پیام ثابت' },
        message: 'پیام فرم',
        correlationId: 'corr-422',
      });
      const state = (await run()) as Record<string, unknown>;
      expect(state).toMatchObject({
        kind: 'INVALID',
        fieldErrors: { title: 'پیام ثابت' },
        message: 'پیام فرم',
      });
      expect(state['submissionId']).toEqual(expect.stringMatching(/^sub_/));
    });

    it('sends a stale record to a fresh read with the stale notice — never a retry, never typed values', async () => {
      testCase.send.mockResolvedValue({
        kind: 'INVALID',
        fieldErrors: {},
        message: STALE_MESSAGE,
        correlationId: 'corr-409',
      });
      const url = await redirectedTo(run());
      expect(url.pathname).toBe(`/projects/${PROJECT_ID}`);
      expect(readFlash(SESSION, url.searchParams.get('flash'), PROJECT_ID, ['stale'])).toBe(
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
        { kind: 'UNAVAILABLE', status: 401, code: 'UNAUTHENTICATED', correlationId: 'c3' },
        { kind: 'FAILED', status: 401, correlationId: 'c3' },
      ],
      [
        { kind: 'UNAVAILABLE', status: 429, code: 'RATE_LIMIT_EXCEEDED', correlationId: 'c3' },
        { kind: 'FAILED', status: 429, correlationId: 'c3' },
      ],
      // A 4xx without a documented code proves nothing (the writer's one rule).
      [
        { kind: 'UNAVAILABLE', status: 429, correlationId: 'c3' },
        { kind: 'UNCONFIRMED', correlationId: 'c3' },
      ],
      // Provably never left the portal: nothing was changed.
      [
        { kind: 'UNAVAILABLE', status: 503, neverSent: true, correlationId: 'c3' },
        { kind: 'FAILED', status: 503, correlationId: 'c3' },
      ],
      // A 5xx may follow the commit (the answer is built by a read after it):
      // never "nothing changed".
      [
        { kind: 'UNAVAILABLE', status: 500, correlationId: 'c3' },
        { kind: 'UNCONFIRMED', correlationId: 'c3' },
      ],
      [
        { kind: 'UNAVAILABLE', status: 503, correlationId: 'c3' },
        { kind: 'UNCONFIRMED', correlationId: 'c3' },
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
      expect(await run()).toEqual(
        // An unresolved answer names the request it is about (FU-173), so a second press is held to it.
        expected.kind === 'UNCONFIRMED'
          ? { ...expected, submissionId: expect.stringMatching(/^sub_/) }
          : expected,
      );
      expect(testCase.send).toHaveBeenCalledTimes(1);
    });

    it('a second press after an unconfirmed answer stays UNCONFIRMED whatever refuses it (FU-173)', async () => {
      testCase.send.mockResolvedValue({ kind: 'UNKNOWN_OUTCOME', correlationId: 'c-first' });
      const form = formData(testCase);
      const first = (await testCase.submit(form)) as { kind: string; submissionId: string };
      expect(first).toMatchObject({ kind: 'UNCONFIRMED', correlationId: 'c-first' });
      // The same form again; this time a proven refusal (a 429 before the service saw the versions,
      // or the 409 the first press itself caused) — still not "nothing changed".
      testCase.send.mockResolvedValue({
        kind: 'UNAVAILABLE',
        status: 429,
        code: 'RATE_LIMIT_EXCEEDED',
        correlationId: 'c-second',
      });
      const again = await (testCase.command === 'edit'
        ? actions.submitEditNeed(PROJECT_ID, NEED_ID, first as never, form)
        : testCase.command === 'submit'
          ? actions.submitSubmitNeed(PROJECT_ID, NEED_ID, first as never, form)
          : actions.submitWithdrawNeed(PROJECT_ID, NEED_ID, first as never, form));
      expect(again).toMatchObject({ kind: 'UNCONFIRMED', correlationId: 'c-first' });
    });
  });
});

describe('edit', () => {
  const edit = CASES[0]!;

  it('sends only the fields that changed, and clears an optional field with null', async () => {
    await redirectedTo(
      edit.submit(
        formData(edit, { ...INITIAL, description: 'شرح تازه', quantity: '', estimatedCost: '' }),
      ),
    );
    expect(updateNeed.mock.calls[0]!.slice(3)).toEqual([
      { description: 'شرح تازه', quantity: null, estimatedCostMinor: null },
      FENCE,
    ]);
  });

  it('compares a quantity by value: 25.0 and ۲۵ are the untouched 25', async () => {
    const state = (await edit.submit(formData(edit, { ...INITIAL, quantity: '25.00' }))) as {
      kind: string;
      fieldErrors: Record<string, string>;
    };
    expect(state.kind).toBe('INVALID');
    expect(state.fieldErrors['title']).toBe(NEED_NOTHING_CHANGED_MESSAGE);
    const persian = (await edit.submit(formData(edit, { ...INITIAL, quantity: '۲۵' }))) as {
      kind: string;
    };
    expect(persian.kind).toBe('INVALID');
    expect(sent()).toHaveLength(0);
  });

  it('sends a changed quantity in its canonical form', async () => {
    await redirectedTo(edit.submit(formData(edit, { ...INITIAL, quantity: '۷٫۵۰' })));
    expect(updateNeed.mock.calls[0]![3]).toEqual({ quantity: '7.5' });
  });

  it('refuses a quantity that is zero, has five decimals, or uses a thousands separator', async () => {
    for (const quantity of ['0', '0.0', '1.23456', '1,000', 'abc', '-1']) {
      const state = (await edit.submit(formData(edit, { ...INITIAL, quantity }))) as {
        kind: string;
        fieldErrors: Record<string, string>;
      };
      expect(state.kind).toBe('INVALID');
      expect(Object.keys(state.fieldErrors)).toEqual(['quantity']);
    }
    expect(sent()).toHaveLength(0);
  });

  it('reads the estimate as rials in any digits and sends whole minor units', async () => {
    await redirectedTo(edit.submit(formData(edit, { ...INITIAL, estimatedCost: '۲٬۵۰۰٬۰۰۰' })));
    expect(updateNeed.mock.calls[0]![3]).toEqual({ estimatedCostMinor: '2500000' });
  });

  it('sends nothing when nothing changed, and says so on the first field', async () => {
    const state = (await edit.submit(formData(edit, INITIAL))) as {
      kind: string;
      fieldErrors: Record<string, string>;
    };
    expect(state.kind).toBe('INVALID');
    expect(Object.keys(state.fieldErrors)).toEqual(['title']);
    expect(sent()).toHaveLength(0);
  });

  it('treats an untouched multiline description as untouched however the browser posts its newlines', async () => {
    const stored = { ...INITIAL, description: 'بند اول\nبند دوم' };
    const baseline = baselineFor(edit, { digests: needEditDigests(stored) });
    await redirectedTo(
      edit.submit(
        formData(
          edit,
          { ...stored, title: 'بتن شمالی', description: 'بند اول\r\nبند دوم' },
          { baseline },
        ),
      ),
    );
    expect(updateNeed.mock.calls[0]![3]).toEqual({ title: 'بتن شمالی' });
  });

  it('counts a 2000-character description with LF and sends it with LF', async () => {
    const lf = `${'ا'.repeat(999)}\n${'ب'.repeat(1000)}`;
    expect(lf).toHaveLength(2000);
    await redirectedTo(
      edit.submit(formData(edit, { ...INITIAL, description: lf.replace('\n', '\r\n') })),
    );
    expect(updateNeed.mock.calls[0]![3]).toEqual({ description: lf });
  });

  it('does not re-check a field the person did not touch', async () => {
    const stored = { ...INITIAL, title: 'ا' };
    const baseline = baselineFor(edit, { digests: needEditDigests(stored) });
    await redirectedTo(
      edit.submit(formData(edit, { ...stored, description: 'شرح تازه' }, { baseline })),
    );
    expect(updateNeed.mock.calls[0]![3]).toEqual({ description: 'شرح تازه' });
  });
});

// ---------------------------------------------------------------------------
// Adding: the keyed create
// ---------------------------------------------------------------------------

describe('add', () => {
  const VALID = {
    title: 'بتن آماده',
    description: 'بتن با مقاومت بالا',
    quantity: '۲۵٫۵۰',
    unit: 'متر مکعب',
    estimatedCost: '',
  };
  const BODY = {
    title: 'بتن آماده',
    description: 'بتن با مقاومت بالا',
    quantity: '25.5',
    unit: 'متر مکعب',
    expectedProjectVersion: PROJECT_VERSION,
  };
  const deadlineOf = (submission: { id: string; replay: string }): number =>
    needStampTerms(SESSION, submission.replay, submission.id, PROJECT_ID)!.deadline;

  function addForm(
    options: {
      fields?: Record<string, string>;
      csrf?: string | null;
      submission?: { id: string; replay: string } | { id: string; replay: null };
    } = {},
  ): FormData {
    const submission =
      options.submission ?? mintNeedSubmission(SESSION, PROJECT_ID, PROJECT_VERSION);
    const form = new FormData();
    for (const [key, value] of Object.entries(options.fields ?? VALID)) form.set(key, value);
    const csrf = options.csrf === undefined ? SESSION.csrfToken : options.csrf;
    if (csrf !== null) form.set(CSRF_FIELD, csrf);
    form.set(SUBMISSION_FIELD, submission.id);
    if (submission.replay !== null) form.set(REPLAY_FIELD, submission.replay);
    return form;
  }

  const add = (form: FormData, projectId = PROJECT_ID) =>
    actions.submitAddNeed(projectId, IDLE_ADD_NEED_FORM, form);

  describe('what is refused before anything is sent', () => {
    it('refuses a post with no session, a wrong CSRF token and a foreign submission id', async () => {
      currentSession.mockResolvedValue(null);
      expect(await add(addForm())).toEqual({ kind: 'REFUSED', reason: 'NO_SESSION' });
      currentSession.mockResolvedValue(SESSION);
      expect(await add(addForm({ csrf: 'someone-elses' }))).toEqual({
        kind: 'REFUSED',
        reason: 'CSRF',
      });
      expect(
        await add(addForm({ submission: { id: 'sub_AAAAAAAAAAAAAAAAAAAA', replay: 'x' } })),
      ).toEqual({ kind: 'REFUSED', reason: 'SUBMISSION' });
      expect(sent()).toHaveLength(0);
    });

    it('refuses a missing, forged, earlier-login or other-project stamp', async () => {
      const own = mintNeedSubmission(SESSION, PROJECT_ID, PROJECT_VERSION);
      const earlier = mintNeedSubmission(
        { ...SESSION, csrfToken: 'an-earlier-login' },
        PROJECT_ID,
        PROJECT_VERSION,
      );
      const elsewhere = mintNeedSubmission(SESSION, OTHER_PROJECT_ID, PROJECT_VERSION);
      for (const replay of [
        null,
        'not-a-token',
        withForgedMac(own.replay),
        earlier.replay,
        elsewhere.replay,
      ]) {
        expect(await add(addForm({ submission: { id: own.id, replay } }))).toEqual({
          kind: 'REFUSED',
          reason: 'SUBMISSION',
        });
      }
      // A stamp drawn for this project does not open for another.
      expect(await add(addForm({ submission: own }), OTHER_PROJECT_ID)).toEqual({
        kind: 'REFUSED',
        reason: 'SUBMISSION',
      });
      expect(sent()).toHaveLength(0);
      expect(await readUnresolved(SESSION, needCreateScope(PROJECT_ID))).toEqual({ kind: 'NONE' });
    });

    it('sends nothing past the stamp deadline and says the needs must be checked first', async () => {
      const longAgo = mintNeedSubmission(
        SESSION,
        PROJECT_ID,
        PROJECT_VERSION,
        Date.now() - 48 * 60 * 60 * 1000,
      );
      const state = await add(addForm({ submission: longAgo }));
      expect(state).toMatchObject({ kind: 'EXPIRED' });
      expect(sent()).toHaveLength(0);
      expect(await readUnresolved(SESSION, needCreateScope(PROJECT_ID))).toEqual({ kind: 'NONE' });
    });

    it('keeps what was typed and says which field when the form is invalid — nothing is sent or held', async () => {
      const fields = { ...VALID, title: 'ا', quantity: '1,000' };
      const state = (await add(addForm({ fields }))) as {
        kind: string;
        fieldErrors: Record<string, string>;
        submissionId: string;
        replay: string;
      };
      expect(state.kind).toBe('INVALID');
      expect(Object.keys(state.fieldErrors).sort()).toEqual(['quantity', 'title']);
      expect(state.replay).toEqual(expect.any(String));
      expect(sent()).toHaveLength(0);
      expect(await readUnresolved(SESSION, needCreateScope(PROJECT_ID))).toEqual({ kind: 'NONE' });
    });

    it('sends nothing when the store of unresolved requests cannot be reached', async () => {
      const broken = memoryUnresolvedStore();
      useUnresolvedStore({
        ...broken,
        reserve: async () => {
          throw new UnresolvedStoreUnavailable(new Error('down'));
        },
      });
      expect(await add(addForm())).toMatchObject({ kind: 'NOT_CHECKED' });
      expect(sent()).toHaveLength(0);
    });
  });

  describe('what is sent', () => {
    it('sends the body with its project version, under the submission id as its key, with the signed deadline', async () => {
      const submission = mintNeedSubmission(SESSION, PROJECT_ID, PROJECT_VERSION);
      const url = await redirectedTo(add(addForm({ submission })));

      expect(addNeed).toHaveBeenCalledTimes(1);
      expect(addNeed.mock.calls[0]).toEqual([
        SESSION,
        PROJECT_ID,
        BODY,
        submission.id,
        deadlineOf(submission),
      ]);
      expect(url.pathname).toBe(`/projects/${PROJECT_ID}`);
      const flash = url.searchParams.get('flash');
      expect(readFlash(SESSION, flash, PROJECT_ID, ['needAdded'])).toBe('needAdded');
      expect(readFlash(SESSION, flash, OTHER_PROJECT_ID, ['needAdded'])).toBeUndefined();
      // A confirmed add leaves nothing unresolved behind.
      expect(await readUnresolved(SESSION, needCreateScope(PROJECT_ID))).toEqual({ kind: 'NONE' });
    });

    it('leaves empty optional fields out, and a project written into the form is ignored', async () => {
      await redirectedTo(
        add(
          addForm({
            fields: {
              title: 'بتن آماده',
              description: 'شرح',
              quantity: '',
              unit: '',
              estimatedCost: '',
              projectId: OTHER_PROJECT_ID,
            },
          }),
        ),
      );
      expect(addNeed.mock.calls[0]![1]).toBe(PROJECT_ID);
      expect(addNeed.mock.calls[0]![2]).toEqual({
        title: 'بتن آماده',
        description: 'شرح',
        expectedProjectVersion: PROJECT_VERSION,
      });
    });

    it('is fenced to the editing episode its stamp was drawn in, whatever the form says (F2)', async () => {
      const earlier = mintNeedSubmission(SESSION, PROJECT_ID, 4);
      await redirectedTo(
        add(
          addForm({
            submission: earlier,
            fields: { ...VALID, expectedProjectVersion: '99', projectVersion: '99' },
          }),
        ),
      );
      expect(addNeed.mock.calls[0]![2]).toEqual({ ...BODY, expectedProjectVersion: 4 });
    });

    it('refuses a stamp that names no project version — it could not be fenced (F2, fail closed)', async () => {
      const now = Date.now();
      const id = mintSubmissionId(SESSION);
      const unfenced = signPayload(
        SESSION,
        'project-need-create-replay',
        { submissionId: id, target: PROJECT_ID, issuedAt: now, deadline: now + 600_000 },
        60,
      );
      expect(await add(addForm({ submission: { id, replay: unfenced } }))).toEqual({
        kind: 'REFUSED',
        reason: 'SUBMISSION',
      });
      expect(sent()).toHaveLength(0);
    });

    it('sends nothing when the store hands back no deadline (fail closed)', async () => {
      const store = memoryUnresolvedStore();
      useUnresolvedStore({
        ...store,
        reserve: async (...args: Parameters<typeof store.reserve>) => {
          const reply = await store.reserve(...args);
          return reply.kind === 'RESERVED'
            ? { ...reply, record: { ...reply.record, deadline: 'NONE' } }
            : reply;
        },
      } as typeof store);
      expect(await add(addForm())).toMatchObject({ kind: 'EXPIRED' });
      expect(sent()).toHaveLength(0);
    });
  });

  describe('a confirmed add, posted again (F1)', () => {
    it('carries the same signed deadline: the service, not the portal, refuses it once its key is gone', async () => {
      const submission = mintNeedSubmission(SESSION, PROJECT_ID, PROJECT_VERSION);
      await redirectedTo(add(addForm({ submission })));
      // CONFIRMED deletes the portal's record: nothing here remembers the first press.
      expect(await readUnresolved(SESSION, needCreateScope(PROJECT_ID))).toEqual({ kind: 'NONE' });

      // The same signed form again — a lost redirect, a second tab, a paused process resuming later.
      // It is dispatched with the deadline signed at issue and the same key and body, so the service
      // either replays the first answer (key still kept) or refuses it on its own clock
      // (REPLAY_WINDOW_CLOSED): never a second need.
      addNeed.mockResolvedValue({
        kind: 'UNAVAILABLE',
        status: 409,
        code: 'REPLAY_WINDOW_CLOSED',
        replayWindowClosed: true,
        correlationId: 'c-late',
      });
      expect(await add(addForm({ submission }))).toMatchObject({ kind: 'EXPIRED' });
      expect(addNeed).toHaveBeenCalledTimes(2);
      expect(addNeed.mock.calls[1]).toEqual(addNeed.mock.calls[0]);
      expect(addNeed.mock.calls[1]![4]).toBe(deadlineOf(submission));
      // A proven refusal of this attempt: nothing is held for it.
      expect(await readUnresolved(SESSION, needCreateScope(PROJECT_ID))).toEqual({ kind: 'NONE' });
    });
  });

  describe('what comes back', () => {
    it.each([
      [
        'INVALID',
        { kind: 'INVALID', fieldErrors: { title: 'x' }, message: 'm', correlationId: 'c' },
      ],
      ['FORBIDDEN', { kind: 'FORBIDDEN', correlationId: 'c' }],
      ['NOT_FOUND', { kind: 'NOT_FOUND', correlationId: 'c' }],
      [
        'a 4xx',
        { kind: 'UNAVAILABLE', status: 429, code: 'RATE_LIMIT_EXCEEDED', correlationId: 'c' },
      ],
      ['never sent', { kind: 'UNAVAILABLE', status: 503, neverSent: true, correlationId: 'c' }],
    ])(
      '%s is a proven refusal: nothing is held, the same form may be sent again',
      async (_n, result) => {
        addNeed.mockResolvedValue(result);
        const submission = mintNeedSubmission(SESSION, PROJECT_ID, PROJECT_VERSION);
        const first = (await add(addForm({ submission }))) as { kind: string };
        expect(first.kind).not.toBe('UNCONFIRMED');
        expect(await readUnresolved(SESSION, needCreateScope(PROJECT_ID))).toEqual({
          kind: 'NONE',
        });
        addNeed.mockResolvedValue({ kind: 'CREATED', data: { id: NEED_ID }, correlationId: 'c' });
        await redirectedTo(add(addForm({ submission })));
        expect(addNeed).toHaveBeenCalledTimes(2);
      },
    );

    it.each([
      [
        'a 5xx',
        { kind: 'UNAVAILABLE', status: 503, correlationId: 'c9' },
        { kind: 'UNCONFIRMED', correlationId: 'c9' },
      ],
      [
        'a lost answer',
        { kind: 'UNKNOWN_OUTCOME', correlationId: 'c9' },
        { kind: 'UNCONFIRMED', correlationId: 'c9' },
      ],
      [
        'a first request still in flight at the service',
        { kind: 'IN_PROGRESS', retryAfterSeconds: 1, correlationId: 'c9' },
        { kind: 'PROCESSING', correlationId: 'c9' },
      ],
    ])(
      '%s is unresolved: held, and never sent a second time by this portal',
      async (_name, result, expected) => {
        addNeed.mockResolvedValue(result);
        const submission = mintNeedSubmission(SESSION, PROJECT_ID, PROJECT_VERSION);
        expect(await add(addForm({ submission }))).toEqual(expected);

        const pending = await readUnresolved(SESSION, needCreateScope(PROJECT_ID));
        expect(pending).toMatchObject({ kind: 'PENDING', request: { key: submission.id } });

        // Pressing the same form again — same key, same body — is held, not sent.
        addNeed.mockResolvedValue({ kind: 'CREATED', data: { id: NEED_ID }, correlationId: 'c' });
        expect(await add(addForm({ submission }))).toMatchObject({ kind: 'HELD' });
        // Another form for the same project, and another body, are held too.
        expect(await add(addForm())).toMatchObject({ kind: 'HELD' });
        expect(
          await add(addForm({ submission, fields: { ...VALID, title: 'عنوان دیگر' } })),
        ).toMatchObject({ kind: 'HELD' });
        expect(addNeed).toHaveBeenCalledTimes(1);

        // Another project's add is its own scope.
        await redirectedTo(
          add(
            addForm({ submission: mintNeedSubmission(SESSION, OTHER_PROJECT_ID, PROJECT_VERSION) }),
            OTHER_PROJECT_ID,
          ),
        );
      },
    );

    it('a thrown error after the dispatch leaves the request unresolved', async () => {
      addNeed.mockRejectedValue(new Error('boom'));
      await expect(add(addForm())).rejects.toThrow('boom');
      expect(await readUnresolved(SESSION, needCreateScope(PROJECT_ID))).toMatchObject({
        kind: 'PENDING',
      });
    });
  });

  describe('releasing an unresolved add', () => {
    async function leaveUnresolved() {
      addNeed.mockResolvedValue({ kind: 'UNKNOWN_OUTCOME', correlationId: 'c' });
      await add(addForm());
      const pending = await readUnresolved(SESSION, needCreateScope(PROJECT_ID));
      if (pending.kind !== 'PENDING') throw new Error('expected a pending request');
      return releaseToken(SESSION, needCreateScope(PROJECT_ID), pending.request);
    }

    const releaseForm = (
      token: string,
      confirm: string | null = 'yes',
      csrf = SESSION.csrfToken,
    ) => {
      const form = new FormData();
      form.set(CSRF_FIELD, csrf);
      form.set('release', token);
      if (confirm !== null) form.set('confirmDuplicate', confirm);
      return form;
    };

    const SUBJECT: ReleaseSubject = { surface: 'project-need-creation', target: PROJECT_ID };
    const outcomeOf = (url: URL, subject = SUBJECT, idle = false) =>
      feedbackFor(SESSION, subject, url.searchParams.get('release'), idle);

    it('lets go of the request only with the confirmation, and then a new form is sent', async () => {
      const token = await leaveUnresolved();

      for (const form of [releaseForm(token, null), releaseForm(token, 'no')]) {
        const url = await redirectedTo(actions.releaseUnresolvedNeed(PROJECT_ID, form));
        expect(outcomeOf(url)).toBe('CONSENT_MISSING');
      }
      expect(await readUnresolved(SESSION, needCreateScope(PROJECT_ID))).toMatchObject({
        kind: 'PENDING',
      });

      const url = await redirectedTo(actions.releaseUnresolvedNeed(PROJECT_ID, releaseForm(token)));
      expect(url.pathname).toBe(`/projects/${PROJECT_ID}`);
      expect(url.search).toBe('');
      expect(await readUnresolved(SESSION, needCreateScope(PROJECT_ID))).toEqual({ kind: 'NONE' });

      addNeed.mockResolvedValue({ kind: 'CREATED', data: { id: NEED_ID }, correlationId: 'c' });
      await redirectedTo(add(addForm()));
    });

    it('does nothing for a wrong CSRF token, another project, or a token for an older record', async () => {
      const token = await leaveUnresolved();
      const forged = await redirectedTo(
        actions.releaseUnresolvedNeed(PROJECT_ID, releaseForm(token, 'yes', 'x')),
      );
      expect(outcomeOf(forged)).toBe('CSRF_REFUSED');
      const elsewhere = await redirectedTo(
        actions.releaseUnresolvedNeed(OTHER_PROJECT_ID, releaseForm(token)),
      );
      expect(elsewhere.pathname).toBe(`/projects/${OTHER_PROJECT_ID}`);
      expect(outcomeOf(elsewhere, { ...SUBJECT, target: OTHER_PROJECT_ID })).toBe('STALE');
      // Namespaced to its project: another project's page reads nothing from it.
      expect(outcomeOf(elsewhere)).toBeUndefined();
      expect(await readUnresolved(SESSION, needCreateScope(PROJECT_ID))).toMatchObject({
        kind: 'PENDING',
      });
    });

    it('sends a person with no session to sign in, back to the project', async () => {
      currentSession.mockResolvedValue(null);
      const url = await redirectedTo(actions.releaseUnresolvedNeed(PROJECT_ID, releaseForm('x')));
      expect(url.pathname).toBe('/login');
      expect(url.searchParams.get('returnTo')).toBe(`/projects/${PROJECT_ID}`);
    });
  });
});
