/**
 * @jest-environment node
 */
import { BASELINE_FIELD } from '@/lib/form-fields';
import {
  INBOX_FLASH_SUBJECT,
  STALE_MESSAGE,
  type ProjectCommand,
  type ProjectNotice,
} from '@/lib/project-commands';
import { CSRF_FIELD } from '@/server/csrf';
import { readFlash } from '@/server/flash';
import { editDigests, sealProjectBaseline, type ProjectBaseline } from '@/server/project-commands';
import { SUBMISSION_FIELD, mintSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';
import { withForgedMac } from '@/test/forged-token';

import { IDLE_PROJECT_FORM, type ProjectFormState } from './project-form-state';
import type { ProjectPlace } from './project-runner';
import { actingAccessToken } from '@/test/session-token';

/**
 * The project commands' write path. Mirrors `lifecycle-actions.spec.ts`: the
 * order is the assertion, each refusal proves nothing was sent, and what a
 * command acts on — the project, or the approval step of a decision, and the
 * version — comes from the signed baseline and from nowhere the browser can write.
 */

const currentSession = jest.fn();
const updateProject = jest.fn();
const requestApproval = jest.fn();
const startProject = jest.fn();
const completeProject = jest.fn();
const cancelProject = jest.fn();
const grantApproval = jest.fn();
const rejectApproval = jest.fn();
const redirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock('@/server/current-session', () => ({
  currentSession: () => currentSession(),
  missingSessionReason: async () => 'NO_SESSION',
}));
jest.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));
jest.mock('@/server/project-commands', () => {
  const actual = jest.requireActual('@/server/project-commands');
  return {
    ...actual,
    updateProject: (...args: unknown[]) => updateProject(...args),
    requestApproval: (...args: unknown[]) => requestApproval(...args),
    startProject: (...args: unknown[]) => startProject(...args),
    completeProject: (...args: unknown[]) => completeProject(...args),
    cancelProject: (...args: unknown[]) => cancelProject(...args),
    grantApproval: (...args: unknown[]) => grantApproval(...args),
    rejectApproval: (...args: unknown[]) => rejectApproval(...args),
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
const actions = require('./project-actions') as typeof import('./project-actions');

const REAL_SENDS = jest.requireActual(
  '@/server/project-commands',
) as typeof import('@/server/project-commands');

const SESSION = {
  subject: 'user-1',
  username: 'owner',
  organizationId: 'ORG-OWNER',
  accessToken: actingAccessToken('ORG-OWNER'),
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
} satisfies WebSession;

const PROJECT_ID = 'PRJ_01J00000000000000000000000';
const OTHER_PROJECT_ID = 'PRJ_01J00000000000000000000099';
const APPROVAL_ID = 'APR_01J00000000000000000000000';
const VERSION = 3;

const INITIAL = {
  title: 'بازسازی پل',
  operationType: 'خاکبرداری',
  locationDescription: 'کیلومتر ۱۲ جاده',
  scopeOfWork: 'شرح کار پروژه',
  estimatedCost: '1500000',
};

interface Case {
  readonly command: ProjectCommand;
  /** What the form is bound to: a project, or an approval step. */
  readonly targetId: string;
  readonly baseline: Partial<ProjectBaseline>;
  readonly submit: (
    place: ProjectPlace,
    form: FormData,
    previous?: ProjectFormState<never, never>,
  ) => Promise<unknown>;
  /** The real gateway call `send` stands in for (`@/server/project-commands`). */
  readonly real:
    | 'updateProject'
    | 'requestApproval'
    | 'startProject'
    | 'completeProject'
    | 'cancelProject'
    | 'grantApproval'
    | 'rejectApproval';
  readonly send: jest.Mock;
  readonly valid: Record<string, string>;
  readonly notice: ProjectNotice;
  /** What the gateway call must have received after the session. */
  readonly args: readonly unknown[];
  readonly invalid: Record<string, string> | null;
  readonly invalidField: string | null;
}

const CASES: readonly Case[] = [
  {
    command: 'edit',
    targetId: PROJECT_ID,
    baseline: { digests: editDigests(INITIAL) },
    submit: (place, form, previous = IDLE_PROJECT_FORM) =>
      actions.submitEditProject(PROJECT_ID, place, previous, form),
    send: updateProject,
    real: 'updateProject',
    valid: { ...INITIAL, title: 'بازسازی پل شمالی' },
    notice: 'updated',
    args: [PROJECT_ID, { title: 'بازسازی پل شمالی' }, VERSION],
    invalid: { ...INITIAL, title: 'ا' },
    invalidField: 'title',
  },
  {
    command: 'requestApproval',
    targetId: PROJECT_ID,
    baseline: {},
    submit: (place, form, previous = IDLE_PROJECT_FORM) =>
      actions.submitRequestApproval(PROJECT_ID, place, previous, form),
    send: requestApproval,
    real: 'requestApproval',
    valid: {},
    notice: 'approvalRequested',
    args: [PROJECT_ID, VERSION],
    invalid: null,
    invalidField: null,
  },
  {
    command: 'start',
    targetId: PROJECT_ID,
    baseline: { status: 'APPROVED' },
    submit: (place, form, previous = IDLE_PROJECT_FORM) =>
      actions.submitStartProject(PROJECT_ID, place, previous, form),
    send: startProject,
    real: 'startProject',
    valid: {},
    notice: 'started',
    args: [PROJECT_ID, VERSION],
    invalid: null,
    invalidField: null,
  },
  {
    command: 'complete',
    targetId: PROJECT_ID,
    baseline: { status: 'IN_PROGRESS' },
    submit: (place, form, previous = IDLE_PROJECT_FORM) =>
      actions.submitCompleteProject(PROJECT_ID, place, previous, form),
    send: completeProject,
    real: 'completeProject',
    valid: {},
    notice: 'completionRequested',
    args: [PROJECT_ID, VERSION],
    invalid: null,
    invalidField: null,
  },
  {
    command: 'cancel',
    targetId: PROJECT_ID,
    baseline: {},
    submit: (place, form, previous = IDLE_PROJECT_FORM) =>
      actions.submitCancelProject(PROJECT_ID, place, previous, form),
    send: cancelProject,
    real: 'cancelProject',
    valid: { reason: 'بودجه تأمین نشد', confirm: 'yes' },
    notice: 'cancelled',
    args: [PROJECT_ID, { reason: 'بودجه تأمین نشد' }, VERSION],
    invalid: { reason: 'بودجه تأمین نشد', confirm: '' },
    invalidField: 'confirm',
  },
  {
    command: 'grant',
    targetId: APPROVAL_ID,
    baseline: { status: 'PENDING' },
    submit: (place, form, previous = IDLE_PROJECT_FORM) =>
      actions.submitGrantApproval(APPROVAL_ID, place, previous, form),
    send: grantApproval,
    real: 'grantApproval',
    valid: { decisionNumber: '۱۲۳/ب', conditions: 'با رعایت حریم' },
    notice: 'granted',
    args: [APPROVAL_ID, { decisionNumber: '۱۲۳/ب', conditions: 'با رعایت حریم' }, VERSION],
    invalid: { decisionNumber: 'x'.repeat(101) },
    invalidField: 'decisionNumber',
  },
  {
    command: 'reject',
    targetId: APPROVAL_ID,
    baseline: { status: 'PENDING' },
    submit: (place, form, previous = IDLE_PROJECT_FORM) =>
      actions.submitRejectApproval(APPROVAL_ID, place, previous, form),
    send: rejectApproval,
    real: 'rejectApproval',
    valid: { reason: 'برآورد با نقشه نمی‌خواند' },
    notice: 'rejected',
    args: [APPROVAL_ID, { reason: 'برآورد با نقشه نمی‌خواند' }, VERSION],
    invalid: { reason: 'کوتاه' },
    invalidField: 'reason',
  },
];

function baselineFor(
  testCase: Case,
  over: Partial<ProjectBaseline> = {},
  session: WebSession = SESSION,
): string {
  return sealProjectBaseline(session, {
    targetId: testCase.targetId,
    projectId: PROJECT_ID,
    command: testCase.command,
    version: VERSION,
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
    /** `undefined`: the one this server signed for this command and target. */
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
  updateProject,
  requestApproval,
  startProject,
  completeProject,
  cancelProject,
  grantApproval,
  rejectApproval,
];
const sent = () => ALL_SENDS.flatMap((m) => m.mock.calls);

beforeEach(() => {
  currentSession.mockResolvedValue(SESSION);
  for (const send of ALL_SENDS) {
    send.mockReset();
    send.mockResolvedValue({
      kind: 'CREATED',
      data: { id: PROJECT_ID },
      correlationId: 'corr-sample',
    });
  }
  redirect.mockClear();
});

describe.each(CASES)('$command', (testCase) => {
  const submit = (form: FormData, place: ProjectPlace = 'project') => testCase.submit(place, form);

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

    it.each([null, 'sub_AAAAAAAAAAAAAAAAAAAA'])('refuses submission id %j', async (submission) => {
      expect(await submit(formData(testCase, undefined, { submission }))).toEqual({
        kind: 'REFUSED',
        reason: 'SUBMISSION',
      });
      expect(sent()).toHaveLength(0);
    });

    it('refuses a post with no baseline, a forged one and one from an earlier login', async () => {
      const forged = withForgedMac(baselineFor(testCase));
      const earlier = baselineFor(testCase, {}, { ...SESSION, csrfToken: 'an-earlier-login-csrf' });
      for (const baseline of [null, 'not-a-token', forged, earlier]) {
        expect(await submit(formData(testCase, undefined, { baseline }))).toEqual({
          kind: 'REFUSED',
          reason: 'BASELINE',
        });
      }
      expect(sent()).toHaveLength(0);
    });

    it('refuses a baseline minted for another command', async () => {
      const other = CASES.find(
        (c) => c.command !== testCase.command && c.targetId === testCase.targetId,
      )!;
      expect(await submit(formData(testCase, undefined, { baseline: baselineFor(other) }))).toEqual(
        {
          kind: 'REFUSED',
          reason: 'BASELINE',
        },
      );
      expect(sent()).toHaveLength(0);
    });

    it("refuses another target's genuine baseline posted in this target's form", async () => {
      const foreign = baselineFor(testCase, { targetId: OTHER_PROJECT_ID });
      expect(await submit(formData(testCase, undefined, { baseline: foreign }))).toEqual({
        kind: 'REFUSED',
        reason: 'BASELINE',
      });
      expect(sent()).toHaveLength(0);
    });

    it('refuses a place the page does not have', async () => {
      expect(await submit(formData(testCase), 'elsewhere' as ProjectPlace)).toEqual({
        kind: 'REFUSED',
        reason: 'BASELINE',
      });
      expect(sent()).toHaveLength(0);
    });

    if (testCase.invalid && testCase.invalidField) {
      const invalid = testCase.invalid;
      const invalidField = testCase.invalidField;
      it('keeps what was typed and says which field when the form is invalid — nothing is sent', async () => {
        const state = (await submit(formData(testCase, invalid))) as {
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
    it('sends the form to the gateway with the target and version from the baseline, and no key', async () => {
      const url = await redirectedTo(submit(formData(testCase)));

      expect(testCase.send).toHaveBeenCalledTimes(1);
      const [session, ...rest] = testCase.send.mock.calls[0]!;
      expect(session).toEqual(SESSION);
      expect(rest).toEqual(testCase.args);
      // No submission id travels with the call: the endpoint takes no Idempotency-Key.
      expect(testCase.send.mock.calls[0]).toHaveLength(1 + testCase.args.length);

      expect(url.pathname).toBe(`/projects/${PROJECT_ID}`);
      const flash = url.searchParams.get('flash');
      expect(readFlash(SESSION, flash, PROJECT_ID, [testCase.notice])).toBe(testCase.notice);
      // A flash minted for this project is no confirmation for another one.
      expect(readFlash(SESSION, flash, OTHER_PROJECT_ID, [testCase.notice])).toBeUndefined();
    });

    it('lands on the list, with a confirmation for the inbox, when the form was drawn there', async () => {
      const url = await redirectedTo(submit(formData(testCase), 'inbox'));
      expect(url.pathname).toBe('/projects');
      const flash = url.searchParams.get('flash');
      expect(readFlash(SESSION, flash, INBOX_FLASH_SUBJECT, [testCase.notice])).toBe(
        testCase.notice,
      );
      expect(readFlash(SESSION, flash, PROJECT_ID, [testCase.notice])).toBeUndefined();
    });

    it('ignores a project, approval or version written into the form', async () => {
      const fields = {
        ...testCase.valid,
        id: OTHER_PROJECT_ID,
        projectId: OTHER_PROJECT_ID,
        approvalId: 'APR_FORGED',
        expectedVersion: '99',
        version: '99',
        organizationId: 'ORG-FORGED',
      };
      await redirectedTo(submit(formData(testCase, fields)));
      expect(testCase.send.mock.calls[0]!.slice(1)).toEqual(testCase.args);
    });
  });

  describe('what comes back', () => {
    const run = () => submit(formData(testCase));

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
      // A 4xx without a documented code proves nothing (PR-830 r1 F1).
      [
        { kind: 'UNAVAILABLE', status: 429, correlationId: 'c3' },
        { kind: 'UNCONFIRMED', correlationId: 'c3', submissionId: expect.any(String) },
      ],
      // A 5xx may follow the commit (the answer is built by a read after it):
      // never "nothing changed".
      [
        { kind: 'UNAVAILABLE', status: 500, correlationId: 'c3' },
        { kind: 'UNCONFIRMED', correlationId: 'c3', submissionId: expect.any(String) },
      ],
      [
        { kind: 'UNAVAILABLE', status: 502, correlationId: 'c3' },
        { kind: 'UNCONFIRMED', correlationId: 'c3', submissionId: expect.any(String) },
      ],
      [
        { kind: 'UNAVAILABLE', status: 503, correlationId: 'c3' },
        { kind: 'UNCONFIRMED', correlationId: 'c3', submissionId: expect.any(String) },
      ],
      [
        { kind: 'UNKNOWN_OUTCOME', correlationId: 'c4' },
        { kind: 'UNCONFIRMED', correlationId: 'c4', submissionId: expect.any(String) },
      ],
      [
        { kind: 'IN_PROGRESS', retryAfterSeconds: 1, correlationId: 'c5' },
        { kind: 'UNCONFIRMED', correlationId: 'c5', submissionId: expect.any(String) },
      ],
    ])('answers %j with %j and sends exactly once', async (result, expected) => {
      testCase.send.mockResolvedValue(result);
      expect(await run()).toEqual(expected);
      expect(testCase.send).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * FU-173 (PR-830 r2 F1): the first send's answer is lost, the same form is sent
 * again, and the retry is refused before construction-service sees it — a `429`
 * from the gateway's rate limit — or by the version the first send itself moved.
 * Neither says what happened to the first send, so the form stays UNCONFIRMED.
 * Through the real writer: only `fetch` is stubbed.
 */
describe.each(CASES)('$command: a retry of an unconfirmed send', (testCase) => {
  const problem = (status: number, code: string) =>
    new Response(JSON.stringify({ code, message: code }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  let answers: Response[] = [];

  beforeEach(() => {
    answers = [];
    testCase.send.mockImplementation((...args: unknown[]) =>
      (REAL_SENDS[testCase.real] as (...a: unknown[]) => Promise<unknown>)(...args),
    );
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const next = answers.shift();
      if (!next) throw new Error('unexpected request');
      return next;
    });
  });
  afterEach(() => jest.restoreAllMocks());

  /** First send: the gateway timed out upstream (`504`): UNCONFIRMED. Then the same form again. */
  async function sendTwice(retryAnswer: Response) {
    const form = formData(testCase);
    answers.push(problem(504, 'UPSTREAM_TIMEOUT'), retryAnswer);
    const first = (await testCase.submit('project', form)) as ProjectFormState<never, never>;
    expect(first).toEqual({
      kind: 'UNCONFIRMED',
      correlationId: expect.any(String),
      submissionId: form.get(SUBMISSION_FIELD),
    });
    return { first, second: testCase.submit('project', form, first) };
  }

  it('a 429 on the retry keeps the first send UNCONFIRMED — never "nothing changed"', async () => {
    const { first, second } = await sendTwice(problem(429, 'RATE_LIMIT_EXCEEDED'));
    expect(await second).toEqual(first);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('a stale version on the retry is UNCONFIRMED too, not a notice that nothing was written', async () => {
    const { first, second } = await sendTwice(problem(409, 'OPTIMISTIC_LOCK_FAILED'));
    expect(await second).toEqual(first);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('control: the same 429 on a first send is the documented refusal', async () => {
    answers.push(problem(429, 'RATE_LIMIT_EXCEEDED'));
    expect(await testCase.submit('project', formData(testCase))).toEqual({
      kind: 'FAILED',
      status: 429,
      correlationId: expect.any(String),
    });
  });

  it('a success on the retry is the confirmation: it redirects', async () => {
    testCase.send.mockResolvedValue({
      kind: 'CREATED',
      data: { id: PROJECT_ID },
      correlationId: 'c',
    });
    const form = formData(testCase);
    const previous = {
      kind: 'UNCONFIRMED',
      correlationId: 'COR-FIRST',
      submissionId: String(form.get(SUBMISSION_FIELD)),
    } as const;
    await redirectedTo(testCase.submit('project', form, previous));
  });
});

describe('edit', () => {
  const edit = CASES[0]!;

  it('sends only the fields that changed, and clears the estimate with null', async () => {
    await redirectedTo(
      edit.submit(
        'project',
        formData(edit, { ...INITIAL, scopeOfWork: 'شرح تازه', estimatedCost: '' }),
      ),
    );
    expect(updateProject.mock.calls[0]!.slice(1)).toEqual([
      PROJECT_ID,
      { scopeOfWork: 'شرح تازه', estimatedCostMinor: null },
      VERSION,
    ]);
  });

  it('reads the estimate as rials in any digits and sends whole minor units', async () => {
    await redirectedTo(
      edit.submit('project', formData(edit, { ...INITIAL, estimatedCost: '۲٬۵۰۰٬۰۰۰' })),
    );
    expect(updateProject.mock.calls[0]![2]).toEqual({ estimatedCostMinor: '2500000' });
  });

  it('sends nothing when nothing changed, and says so on the first field', async () => {
    const state = (await edit.submit('project', formData(edit, INITIAL))) as {
      kind: string;
      fieldErrors: Record<string, string>;
    };
    expect(state.kind).toBe('INVALID');
    expect(Object.keys(state.fieldErrors)).toEqual(['title']);
    expect(sent()).toHaveLength(0);
  });

  it('treats an untouched multiline scope as untouched however the browser posts its newlines', async () => {
    // Stored by the API with LF; a browser posts the textarea back with CRLF.
    const stored = { ...INITIAL, scopeOfWork: 'بند اول\nبند دوم' };
    const baseline = baselineFor(edit, { digests: editDigests(stored) });
    await redirectedTo(
      edit.submit(
        'project',
        formData(
          edit,
          { ...stored, title: 'بازسازی پل شمالی', scopeOfWork: 'بند اول\r\nبند دوم' },
          { baseline },
        ),
      ),
    );
    expect(updateProject.mock.calls[0]![2]).toEqual({ title: 'بازسازی پل شمالی' });
  });

  it('sends a changed multiline scope with LF, and counts a 5000-character one with LF', async () => {
    const lf = `${'ا'.repeat(2499)}\n${'ب'.repeat(2500)}`;
    expect(lf).toHaveLength(5000);
    await redirectedTo(
      edit.submit('project', formData(edit, { ...INITIAL, scopeOfWork: lf.replace('\n', '\r\n') })),
    );
    expect(updateProject.mock.calls[0]![2]).toEqual({ scopeOfWork: lf });
  });

  it('does not re-check a field the person did not touch', async () => {
    // The stored title is one character; the person edits only the scope.
    const stored = { ...INITIAL, title: 'ا' };
    const baseline = baselineFor(edit, { digests: editDigests(stored) });
    await redirectedTo(
      edit.submit('project', formData(edit, { ...stored, scopeOfWork: 'شرح تازه' }, { baseline })),
    );
    expect(updateProject.mock.calls[0]![2]).toEqual({ scopeOfWork: 'شرح تازه' });
  });
});
