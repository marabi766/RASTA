/**
 * @jest-environment node
 */
import { CSRF_FIELD } from '@/server/csrf';
import { readFlash } from '@/server/flash';
import { SUBMISSION_FIELD, isBoundSubmissionId, mintSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';

import { CREATE_INTENT_FIELD, EDIT_AS_NEW_INTENT, IDLE_CREATE_PROJECT_FORM } from './form-state';

/**
 * The create form's write path: the order is the assertion (session, CSRF,
 * submission id, form, gateway), each refusal proves nothing was sent, and the
 * submission id travels as the call's Idempotency-Key.
 */

const currentSession = jest.fn();
const createProject = jest.fn();
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
  return { ...actual, createProject: (...args: unknown[]) => createProject(...args) };
});

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { submitCreateProject } = require('./actions') as typeof import('./actions');

const SESSION = {
  subject: 'user-1',
  username: 'owner',
  organizationId: 'ORG-OWNER',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
} satisfies WebSession;

const PROJECT_ID = 'PRJ_01J00000000000000000000000';
const VALID = {
  title: 'بازسازی پل',
  operationType: 'خاکبرداری',
  locationDescription: 'کیلومتر ۱۲ جاده',
  scopeOfWork: 'شرح کار پروژه',
  estimatedCost: '۱٬۵۰۰٬۰۰۰',
};

function formData(
  fields: Record<string, string> = VALID,
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

const submit = (form: FormData) => submitCreateProject(IDLE_CREATE_PROJECT_FORM, form);

beforeEach(() => {
  currentSession.mockResolvedValue(SESSION);
  createProject.mockReset();
  createProject.mockResolvedValue({
    kind: 'CREATED',
    data: { id: PROJECT_ID },
    correlationId: 'corr-sample',
  });
  redirect.mockClear();
});

describe('what is refused before anything is sent', () => {
  it('refuses a post with no session', async () => {
    currentSession.mockResolvedValue(null);
    expect(await submit(formData())).toEqual({ kind: 'REFUSED', reason: 'NO_SESSION' });
    expect(createProject).not.toHaveBeenCalled();
  });

  it.each([null, 'someone-elses'])('refuses CSRF token %j', async (csrf) => {
    expect(await submit(formData(VALID, { csrf }))).toEqual({ kind: 'REFUSED', reason: 'CSRF' });
    expect(createProject).not.toHaveBeenCalled();
  });

  it.each([null, 'sub_AAAAAAAAAAAAAAAAAAAA', 'not-an-id'])(
    'refuses submission id %j',
    async (submission) => {
      expect(await submit(formData(VALID, { submission }))).toEqual({
        kind: 'REFUSED',
        reason: 'SUBMISSION',
      });
      expect(createProject).not.toHaveBeenCalled();
    },
  );

  it('refuses another login’s submission id', async () => {
    const earlier = mintSubmissionId({ ...SESSION, csrfToken: 'an-earlier-login' });
    expect(await submit(formData(VALID, { submission: earlier }))).toEqual({
      kind: 'REFUSED',
      reason: 'SUBMISSION',
    });
    expect(createProject).not.toHaveBeenCalled();
  });

  it('keeps what was typed and names the fields when the form is invalid — nothing is sent', async () => {
    const state = (await submit(formData({ ...VALID, title: 'ا', estimatedCost: 'abc' }))) as {
      kind: string;
      fieldErrors: Record<string, string>;
      values: { title: string; estimatedCost: string };
      submissionId: string;
    };
    expect(state.kind).toBe('INVALID');
    expect(Object.keys(state.fieldErrors).sort()).toEqual(['estimatedCost', 'title']);
    expect(state.values.title).toBe('ا');
    expect(state.values.estimatedCost).toBe('abc');
    expect(state.submissionId).toEqual(expect.stringMatching(/^sub_/));
    expect(createProject).not.toHaveBeenCalled();
  });
});

describe('what is sent', () => {
  it('sends the body and the submission id as the key, then shows the new project', async () => {
    const submission = mintSubmissionId(SESSION);
    let url: URL | null = null;
    try {
      await submit(formData(VALID, { submission }));
    } catch (error) {
      url = new URL(
        /^NEXT_REDIRECT:(.*)$/.exec((error as Error).message)![1]!,
        'http://localhost:3200',
      );
    }
    expect(createProject).toHaveBeenCalledTimes(1);
    const [session, body, key] = createProject.mock.calls[0]!;
    expect(session).toEqual(SESSION);
    expect(body).toEqual({
      title: 'بازسازی پل',
      operationType: 'خاکبرداری',
      locationDescription: 'کیلومتر ۱۲ جاده',
      scopeOfWork: 'شرح کار پروژه',
      estimatedCostMinor: '1500000',
    });
    expect(key).toBe(submission);
    expect(isBoundSubmissionId(key, SESSION)).toBe(true);

    expect(url!.pathname).toBe(`/projects/${PROJECT_ID}`);
    const flash = url!.searchParams.get('flash');
    expect(readFlash(SESSION, flash, PROJECT_ID, ['created'])).toBe('created');
    expect(readFlash(SESSION, flash, 'PRJ_OTHER', ['created'])).toBeUndefined();
  });

  it('ignores an organization, a status or an area written into the form', async () => {
    await submit(
      formData({ ...VALID, organizationId: 'ORG-FORGED', status: 'APPROVED', area: '{}' }),
    ).catch(() => undefined);
    expect(Object.keys(createProject.mock.calls[0]![1] as object).sort()).toEqual([
      'estimatedCostMinor',
      'locationDescription',
      'operationType',
      'scopeOfWork',
      'title',
    ]);
  });

  it('leaves the estimate out when it is empty', async () => {
    await submit(formData({ ...VALID, estimatedCost: '' })).catch(() => undefined);
    expect(createProject.mock.calls[0]![1]).not.toHaveProperty('estimatedCostMinor');
  });

  it('sends nothing, and mints a new id, when the person asks to edit and send as new', async () => {
    const form = formData();
    form.set(CREATE_INTENT_FIELD, EDIT_AS_NEW_INTENT);
    const state = (await submit(form)) as { kind: string; submissionId: string; values: unknown };
    expect(state.kind).toBe('EDITING');
    expect(state.submissionId).not.toBe(form.get(SUBMISSION_FIELD));
    expect(isBoundSubmissionId(state.submissionId, SESSION)).toBe(true);
    expect(state.values).toMatchObject({ title: 'بازسازی پل' });
    expect(createProject).not.toHaveBeenCalled();
  });
});

describe('what comes back', () => {
  it('says what the service refused, keeping the typed values and the same id', async () => {
    createProject.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: { operationType: 'پیام ثابت' },
      message: 'پیام فرم',
      correlationId: 'corr-400',
    });
    const form = formData();
    const state = await submit(form);
    expect(state).toMatchObject({
      kind: 'INVALID',
      submissionId: form.get(SUBMISSION_FIELD),
      fieldErrors: { operationType: 'پیام ثابت' },
      message: 'پیام فرم',
      values: { title: 'بازسازی پل' },
    });
  });

  it.each([
    [
      { kind: 'FORBIDDEN', correlationId: 'c1' },
      { kind: 'FORBIDDEN', correlationId: 'c1' },
    ],
    [
      { kind: 'NOT_FOUND', correlationId: 'c2' },
      { kind: 'FAILED', status: 404, correlationId: 'c2' },
    ],
    [
      { kind: 'UNAVAILABLE', status: 503, correlationId: 'c3' },
      { kind: 'FAILED', status: 503, correlationId: 'c3' },
    ],
    [
      { kind: 'UNKNOWN_OUTCOME', correlationId: 'c4' },
      { kind: 'UNCONFIRMED', correlationId: 'c4' },
    ],
  ])('answers %j with %j and sends exactly once', async (result, expected) => {
    createProject.mockResolvedValue(result);
    expect(await submit(formData())).toEqual(expected);
    expect(createProject).toHaveBeenCalledTimes(1);
  });

  it('keeps the values and the id of a request still being processed, for a retry after the wait', async () => {
    createProject.mockResolvedValue({
      kind: 'IN_PROGRESS',
      retryAfterSeconds: 2,
      correlationId: 'c5',
    });
    const form = formData();
    expect(await submit(form)).toMatchObject({
      kind: 'IN_PROGRESS',
      submissionId: form.get(SUBMISSION_FIELD),
      retryAfterSeconds: 2,
      correlationId: 'c5',
      values: { title: 'بازسازی پل' },
    });
    // The retry is the same form again, and sends the same key.
    createProject.mockResolvedValue({
      kind: 'CREATED',
      data: { id: PROJECT_ID },
      correlationId: 'c6',
    });
    await submit(form).catch(() => undefined);
    expect(createProject.mock.calls[1]![2]).toBe(form.get(SUBMISSION_FIELD));
  });
});
