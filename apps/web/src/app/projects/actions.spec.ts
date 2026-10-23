/**
 * @jest-environment node
 */
import { REPLAY_FIELD } from '@/lib/form-fields';
import { CSRF_FIELD } from '@/server/csrf';
import { mintCreateStamp, PROJECT_CREATE_UNRESOLVED } from '@/server/project-create-replay';
import { readUnresolved } from '@/server/unresolved-request';
import { readFlash } from '@/server/flash';
import { SUBMISSION_FIELD, isBoundSubmissionId, mintSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';

import {
  CONFIRM_DUPLICATE_FIELD,
  CONFIRM_DUPLICATE_VALUE,
  IDLE_CREATE_PROJECT_FORM,
} from './form-state';

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
// A cookie jar the action writes and the next request reads, as a browser would.
const jar = new Map<string, string>();
jest.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
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

const { releaseUnresolvedCreate, submitCreateProject } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./actions') as typeof import('./actions');

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
  options: {
    csrf?: string | null;
    submission?: string | null;
    /** `undefined`: the stamp this server signs for the submission id; a number: issued at that time. */
    replay?: string | null | number;
  } = {},
): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const csrf = options.csrf === undefined ? SESSION.csrfToken : options.csrf;
  if (csrf !== null) form.set(CSRF_FIELD, csrf);
  const submission =
    options.submission === undefined ? mintSubmissionId(SESSION) : options.submission;
  if (submission !== null) form.set(SUBMISSION_FIELD, submission);
  const replay =
    options.replay === undefined || typeof options.replay === 'number'
      ? mintCreateStamp(SESSION, submission ?? '', options.replay)
      : options.replay;
  if (replay !== null) form.set(REPLAY_FIELD, replay);
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
  jar.clear();
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

  it.each([null, 'garbage', 'AAAA.BBBB'])('refuses replay stamp %j', async (replay) => {
    expect(await submit(formData(VALID, { replay }))).toEqual({
      kind: 'REFUSED',
      reason: 'SUBMISSION',
    });
    expect(createProject).not.toHaveBeenCalled();
  });

  it('refuses a stamp signed for another submission id', async () => {
    const other = mintCreateStamp(SESSION, mintSubmissionId(SESSION));
    expect(await submit(formData(VALID, { replay: other }))).toEqual({
      kind: 'REFUSED',
      reason: 'SUBMISSION',
    });
    expect(createProject).not.toHaveBeenCalled();
  });

  it('refuses a stamp from another login', async () => {
    const submission = mintSubmissionId(SESSION);
    const earlier = mintCreateStamp({ ...SESSION, csrfToken: 'an-earlier-login' }, submission);
    expect(await submit(formData(VALID, { submission, replay: earlier }))).toEqual({
      kind: 'REFUSED',
      reason: 'SUBMISSION',
    });
    expect(createProject).not.toHaveBeenCalled();
  });

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

  it('sends a multiline scope with LF however the browser posted its newlines, 5000 characters included', async () => {
    const lf = `${'ا'.repeat(2499)}\n${'ب'.repeat(2500)}`;
    await submit(formData({ ...VALID, scopeOfWork: lf.replace('\n', '\r\n') })).catch(
      () => undefined,
    );
    expect(createProject.mock.calls[0]![1]).toMatchObject({ scopeOfWork: lf });
  });

  it('leaves the estimate out when it is empty', async () => {
    await submit(formData({ ...VALID, estimatedCost: '' })).catch(() => undefined);
    expect(createProject.mock.calls[0]![1]).not.toHaveProperty('estimatedCostMinor');
  });
});

describe('a form left open past the service’s idempotency retention', () => {
  // WEB_CONSTRUCTION_IDEMPOTENCY_TTL_HOURS=1 less the 10-minute margin: 50 minutes.
  const MINUTE = 60_000;

  it('is not sent after the window — it says to check the project list, and no create runs', async () => {
    const state = await submit(formData(VALID, { replay: Date.now() - 51 * MINUTE }));
    expect(state).toMatchObject({ kind: 'EXPIRED', values: { title: 'بازسازی پل' } });
    expect(createProject).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('is still sent just inside the window, with the same key', async () => {
    const submission = mintSubmissionId(SESSION);
    await submit(formData(VALID, { submission, replay: Date.now() - 49 * MINUTE })).catch(
      () => undefined,
    );
    expect(createProject).toHaveBeenCalledTimes(1);
    expect(createProject.mock.calls[0]![2]).toBe(submission);
  });

  it('is not sent after the window on a retry of an in-progress answer either', async () => {
    const submission = mintSubmissionId(SESSION);
    const stamp = mintCreateStamp(SESSION, submission, Date.now() - 51 * MINUTE);
    createProject.mockResolvedValue({
      kind: 'IN_PROGRESS',
      retryAfterSeconds: 1,
      correlationId: 'c',
    });
    expect(await submit(formData(VALID, { submission, replay: stamp }))).toMatchObject({
      kind: 'EXPIRED',
    });
    expect(createProject).not.toHaveBeenCalled();
  });

  it('carries its stamp on to a form shown again', async () => {
    const invalid = (await submit(formData({ ...VALID, title: 'ا' }))) as { replay: string };
    expect(invalid.replay).toEqual(expect.stringMatching(/\./));
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
      { kind: 'UNAVAILABLE', status: 429, correlationId: 'c3' },
      { kind: 'FAILED', status: 429, correlationId: 'c3' },
    ],
    // A 5xx may follow the commit: never "nothing was saved".
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

describe('an unresolved create outlives the form that sent it', () => {
  const unconfirmed = { kind: 'UNKNOWN_OUTCOME', correlationId: 'lost' };
  const scope = PROJECT_CREATE_UNRESOLVED;

  async function sendAndLose(fields = VALID) {
    createProject.mockResolvedValue(unconfirmed);
    const form = formData(fields);
    expect(await submit(form)).toMatchObject({ kind: 'UNCONFIRMED' });
    return form;
  }

  it.each([
    ['UNKNOWN_OUTCOME', { kind: 'UNKNOWN_OUTCOME', correlationId: 'c' }],
    ['a 5xx', { kind: 'UNAVAILABLE', status: 502, correlationId: 'c' }],
    ['IN_PROGRESS', { kind: 'IN_PROGRESS', retryAfterSeconds: 1, correlationId: 'c' }],
  ])('is remembered after %s: key, body digest and the signed deadline', async (_name, result) => {
    createProject.mockResolvedValue(result);
    const form = formData();
    await submit(form);
    const kept = await readUnresolved(SESSION, scope);
    expect(kept).toMatchObject({ key: form.get(SUBMISSION_FIELD), ref: form.get(REPLAY_FIELD) });
    expect(kept!.deadline).toBeGreaterThan(Date.now());
    // The body itself is not in the cookie, only a digest of it.
    expect(JSON.stringify([...jar.values()])).not.toContain('بازسازی');
  });

  it.each([
    ['a proven refusal', { kind: 'UNAVAILABLE', status: 429, correlationId: 'c' }],
    ['a forbidden', { kind: 'FORBIDDEN', correlationId: 'c' }],
  ])('is not made by %s', async (_name, result) => {
    createProject.mockResolvedValue(result);
    await submit(formData());
    expect(await readUnresolved(SESSION, scope)).toBeNull();
  });

  it('keeps the old key after a reload: a form with a fresh key is held, nothing is sent', async () => {
    const first = await sendAndLose();
    createProject.mockClear();
    // The reload drew a fresh form (new key) over the same values.
    const again = await submit(formData());
    expect(again).toMatchObject({ kind: 'HELD', reason: 'OTHER_REQUEST' });
    expect(createProject).not.toHaveBeenCalled();
    expect((await readUnresolved(SESSION, scope))!.key).toBe(first.get(SUBMISSION_FIELD));
  });

  it('resends the SAME request: same key, same body, and a created answer clears it', async () => {
    const first = await sendAndLose();
    createProject.mockResolvedValue({
      kind: 'CREATED',
      data: { id: PROJECT_ID },
      correlationId: 'c',
    });
    await submit(first).catch(() => undefined);
    expect(createProject.mock.calls[1]![2]).toBe(first.get(SUBMISSION_FIELD));
    expect(createProject.mock.calls[1]![1]).toEqual(createProject.mock.calls[0]![1]);
    expect(await readUnresolved(SESSION, scope)).toBeNull();
  });

  it('refuses other values under the remembered key', async () => {
    const first = await sendAndLose();
    createProject.mockClear();
    first.set('title', 'عنوان دیگر');
    expect(await submit(first)).toMatchObject({ kind: 'HELD', reason: 'CHANGED_BODY' });
    expect(createProject).not.toHaveBeenCalled();
  });

  it('is not sent past its deadline, and stays remembered', async () => {
    createProject.mockResolvedValue(unconfirmed);
    // Drawn 40 minutes ago: ten minutes of the 50-minute window are left.
    const form = formData(VALID, { replay: Date.now() - 40 * 60_000 });
    await submit(form);
    createProject.mockClear();
    const real = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(real + 15 * 60_000);
    try {
      expect(await submit(form)).toMatchObject({ kind: 'EXPIRED' });
    } finally {
      jest.restoreAllMocks();
    }
    expect(createProject).not.toHaveBeenCalled();
    expect(await readUnresolved(SESSION, scope)).not.toBeNull();
  });

  describe('send as new', () => {
    const release = (fields: Record<string, string>) => {
      const form = new FormData();
      form.set(CSRF_FIELD, SESSION.csrfToken);
      for (const [name, value] of Object.entries(fields)) form.set(name, value);
      return releaseUnresolvedCreate(form).catch((error: Error) => error.message);
    };

    it('does nothing without the confirmation that names the duplicate risk', async () => {
      await sendAndLose();
      expect(await release({})).toBe('NEXT_REDIRECT:/projects');
      expect(await release({ [CONFIRM_DUPLICATE_FIELD]: 'no' })).toBe('NEXT_REDIRECT:/projects');
      expect(await readUnresolved(SESSION, scope)).not.toBeNull();
    });

    it('does nothing without the CSRF token', async () => {
      await sendAndLose();
      const form = new FormData();
      form.set(CONFIRM_DUPLICATE_FIELD, CONFIRM_DUPLICATE_VALUE);
      await releaseUnresolvedCreate(form).catch(() => undefined);
      expect(await readUnresolved(SESSION, scope)).not.toBeNull();
    });

    it('with the confirmation forgets it, and a fresh key is then sent', async () => {
      await sendAndLose();
      await release({ [CONFIRM_DUPLICATE_FIELD]: CONFIRM_DUPLICATE_VALUE });
      expect(await readUnresolved(SESSION, scope)).toBeNull();
      createProject.mockClear();
      createProject.mockResolvedValue({
        kind: 'CREATED',
        data: { id: PROJECT_ID },
        correlationId: 'c',
      });
      await submit(formData()).catch(() => undefined);
      expect(createProject).toHaveBeenCalledTimes(1);
    });
  });

  describe('who sees it', () => {
    it.each([
      ['another person', { ...SESSION, subject: 'user-2' }],
      ['the same person after a new login', { ...SESSION, csrfToken: 'a-later-login' }],
      ['the same person acting for another organization', { ...SESSION, organizationId: 'ORG-2' }],
    ])('is not seen by %s', async (_name, other) => {
      await sendAndLose();
      expect(await readUnresolved(other, scope)).toBeNull();
      expect(await readUnresolved(SESSION, scope)).not.toBeNull();
    });
  });
});
