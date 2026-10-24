/**
 * @jest-environment node
 */
import { REPLAY_FIELD } from '@/lib/form-fields';
import { CSRF_FIELD } from '@/server/csrf';
import { mintCreateStamp, PROJECT_CREATE_UNRESOLVED } from '@/server/project-create-replay';
import {
  readUnresolved,
  releaseToken,
  reserveUnresolved,
  useUnresolvedStore,
  type UnresolvedRead,
} from '@/server/unresolved-request';
import {
  memoryUnresolvedStore,
  UnresolvedStoreUnavailable,
  type UnresolvedStore,
} from '@/server/unresolved-request-store';
import { readFlash } from '@/server/flash';
import { SUBMISSION_FIELD, isBoundSubmissionId, mintSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';

import {
  CONFIRM_DUPLICATE_FIELD,
  CONFIRM_DUPLICATE_VALUE,
  IDLE_CREATE_PROJECT_FORM,
  RELEASE_FIELD,
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
  useUnresolvedStore(memoryUnresolvedStore());
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
  const created = { kind: 'CREATED', data: { id: PROJECT_ID }, correlationId: 'c' };

  async function held(): Promise<UnresolvedRead> {
    return readUnresolved(SESSION, scope);
  }
  const heldRequest = async () => {
    const read = await held();
    if (read.kind !== 'PENDING') throw new Error(`expected a held request, got ${read.kind}`);
    return read.request;
  };

  async function sendAndLose(fields = VALID) {
    createProject.mockResolvedValue(unconfirmed);
    const form = formData(fields);
    expect(await submit(form)).toMatchObject({ kind: 'UNCONFIRMED' });
    return form;
  }

  /** A store that records what it was asked to keep, to prove no body reaches it. */
  function spyStore(): { store: UnresolvedStore; reserved: unknown[] } {
    const inner = memoryUnresolvedStore();
    const reserved: unknown[] = [];
    return {
      reserved,
      store: {
        ...inner,
        reserve: async (input) => {
          reserved.push(input.fresh);
          return inner.reserve(input);
        },
      },
    };
  }

  it.each([
    ['UNKNOWN_OUTCOME', { kind: 'UNKNOWN_OUTCOME', correlationId: 'c' }],
    ['a 5xx', { kind: 'UNAVAILABLE', status: 502, correlationId: 'c' }],
    ['IN_PROGRESS', { kind: 'IN_PROGRESS', retryAfterSeconds: 1, correlationId: 'c' }],
  ])('is kept after %s: key, signed stamp, deadline — and no body', async (_name, result) => {
    const spy = spyStore();
    useUnresolvedStore(spy.store);
    createProject.mockResolvedValue(result);
    const form = formData();
    await submit(form);
    const kept = await heldRequest();
    expect(kept).toMatchObject({
      key: form.get(SUBMISSION_FIELD),
      ref: form.get(REPLAY_FIELD),
      inFlight: false,
    });
    expect(kept.deadline).toBeGreaterThan(Date.now());
    expect(JSON.stringify(spy.reserved)).not.toContain('بازسازی');
  });

  it.each([
    ['a proven refusal', { kind: 'UNAVAILABLE', status: 429, correlationId: 'c' }],
    ['a forbidden', { kind: 'FORBIDDEN', correlationId: 'c' }],
    ['a service refusal', { kind: 'INVALID', fieldErrors: {}, message: 'm', correlationId: 'c' }],
  ])('is not made by %s', async (_name, result) => {
    createProject.mockResolvedValue(result);
    await submit(formData());
    expect(await held()).toEqual({ kind: 'NONE' });
  });

  it('is not made by a request that never left the portal: the next valid submit, even with other values, goes through', async () => {
    createProject.mockResolvedValue({
      kind: 'UNAVAILABLE',
      status: 503,
      correlationId: 'refused',
      neverSent: true,
    });
    expect(await submit(formData())).toMatchObject({ kind: 'FAILED', status: 503 });
    expect(await held()).toEqual({ kind: 'NONE' });

    createProject.mockResolvedValue(created);
    await submit(formData({ ...VALID, title: 'عنوان دیگر' })).catch(() => undefined);
    expect(createProject).toHaveBeenCalledTimes(2);
  });

  it('keeps an earlier unresolved request when the retry then never leaves the portal', async () => {
    const first = await sendAndLose();
    createProject.mockResolvedValue({
      kind: 'UNAVAILABLE',
      status: 503,
      correlationId: 'refused',
      neverSent: true,
    });
    await submit(first);
    expect((await heldRequest()).key).toBe(first.get(SUBMISSION_FIELD));
  });

  it('keeps an earlier unresolved request when the retry is refused (e.g. by authorization before replay)', async () => {
    const first = await sendAndLose();
    createProject.mockResolvedValue({ kind: 'FORBIDDEN', correlationId: 'denied' });
    expect(await submit(first)).toMatchObject({ kind: 'FORBIDDEN' });
    expect((await heldRequest()).key).toBe(first.get(SUBMISSION_FIELD));
    // And the held request is still the only one that may go out.
    createProject.mockClear();
    expect(await submit(formData())).toMatchObject({ kind: 'HELD', reason: 'OTHER_REQUEST' });
    expect(createProject).not.toHaveBeenCalled();
  });

  it('survives a LOST RESPONSE: no cookie, no client state — a reload still finds it and rebuilds the pinned form', async () => {
    const first = await sendAndLose();
    // The next page request carries nothing from the action's response; the
    // page reads the server's record.
    const request = await heldRequest();
    expect(request.key).toBe(first.get(SUBMISSION_FIELD));
    expect(request.ref).toBe(first.get(REPLAY_FIELD));
    createProject.mockClear();
    // The reload drew a fresh form (new key) over the same values.
    expect(await submit(formData())).toMatchObject({ kind: 'HELD', reason: 'OTHER_REQUEST' });
    expect(createProject).not.toHaveBeenCalled();
  });

  it('resends the SAME request: same key, same body, and a created answer clears it', async () => {
    const first = await sendAndLose();
    createProject.mockResolvedValue(created);
    await submit(first).catch(() => undefined);
    expect(createProject.mock.calls[1]![2]).toBe(first.get(SUBMISSION_FIELD));
    expect(createProject.mock.calls[1]![1]).toEqual(createProject.mock.calls[0]![1]);
    expect(await held()).toEqual({ kind: 'NONE' });
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
    expect((await held()).kind).toBe('PENDING');
  });

  describe('two dispatches of one scope are never in flight at once', () => {
    function slowCreate() {
      let finish!: (result: unknown) => void;
      createProject.mockImplementationOnce(() => new Promise((resolve) => void (finish = resolve)));
      return (result: unknown) => finish(result);
    }
    const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

    it('the same key pressed twice: the second is HELD IN_PROGRESS and sends nothing', async () => {
      const finish = slowCreate();
      const form = formData();
      const firstPress = submit(form).catch((e: Error) => e.message);
      await tick();
      expect(await held()).toMatchObject({ kind: 'PENDING', request: { inFlight: true } });
      expect(await submit(form)).toMatchObject({ kind: 'HELD', reason: 'IN_PROGRESS' });
      expect(createProject).toHaveBeenCalledTimes(1);
      finish(created);
      expect(await firstPress).toMatch(/NEXT_REDIRECT/);
      expect(await held()).toEqual({ kind: 'NONE' });
    });

    it('two tabs with K1 and K2: only one dispatches, the other is held; K1 created leaves nothing of K2', async () => {
      const finish = slowCreate();
      const tab1 = formData();
      const tab2 = formData();
      const first = submit(tab1).catch((e: Error) => e.message);
      await tick();
      expect(await submit(tab2)).toMatchObject({ kind: 'HELD' });
      expect(createProject).toHaveBeenCalledTimes(1);
      finish(created);
      await first;
      // K1's confirmed answer deleted only its own record, and K2 never made one.
      expect(await held()).toEqual({ kind: 'NONE' });
      createProject.mockResolvedValue(created);
      await submit(tab2).catch(() => undefined);
      expect(createProject).toHaveBeenCalledTimes(2);
      expect(createProject.mock.calls[1]![2]).toBe(tab2.get(SUBMISSION_FIELD));
    });
  });

  describe('when the store cannot be trusted', () => {
    const broken = (): UnresolvedStore => {
      const fail = async () => {
        throw new UnresolvedStoreUnavailable(new Error('ECONNREFUSED'));
      };
      return { reserve: fail, read: fail, settle: fail, release: fail, purge: fail };
    };

    it('sends nothing, says the pending requests cannot be checked, and holds no record', async () => {
      useUnresolvedStore(broken());
      expect(await submit(formData())).toMatchObject({ kind: 'NOT_CHECKED' });
      expect(createProject).not.toHaveBeenCalled();
      useUnresolvedStore(memoryUnresolvedStore());
      expect(await held()).toEqual({ kind: 'NONE' });
      createProject.mockResolvedValue(created);
      await submit(formData()).catch(() => undefined);
      expect(createProject).toHaveBeenCalledTimes(1);
    });

    it('a read that fails is UNAVAILABLE, never "no hold"', async () => {
      useUnresolvedStore(broken());
      expect(await held()).toEqual({ kind: 'UNAVAILABLE' });
    });

    it('an answer lost AFTER the dispatch still ends unconfirmed, and the lease makes it unresolved', async () => {
      const inner = memoryUnresolvedStore();
      useUnresolvedStore({
        ...inner,
        settle: async () => {
          throw new UnresolvedStoreUnavailable(new Error('gone'));
        },
      });
      createProject.mockResolvedValue(unconfirmed);
      expect(await submit(formData())).toMatchObject({ kind: 'UNCONFIRMED' });
      useUnresolvedStore(inner);
      expect((await held()).kind).toBe('PENDING');
    });
  });

  it('refuses a new scope before dispatch when the login holds 50 pending requests', async () => {
    for (let n = 0; n < 50; n += 1) {
      const out = await reserveUnresolved(
        SESSION,
        { purpose: 'filler', target: `T${n}` },
        {
          key: `k${n}`,
          digest: 'd',
          ref: null,
          issuedAt: Date.now(),
          deadline: null,
          windowMs: null,
          retry: false,
        },
      );
      expect(out.kind).toBe('RESERVED');
    }
    expect(await submit(formData())).toMatchObject({ kind: 'CAPACITY' });
    expect(createProject).not.toHaveBeenCalled();
  });

  describe('send as new', () => {
    const release = async (
      fields: Record<string, string>,
      csrf: string | null = SESSION.csrfToken,
    ) => {
      const form = new FormData();
      if (csrf !== null) form.set(CSRF_FIELD, csrf);
      for (const [name, value] of Object.entries(fields)) form.set(name, value);
      return releaseUnresolvedCreate(form).catch((error: Error) => error.message);
    };
    const tokenFor = async () => releaseToken(SESSION, scope, await heldRequest());

    it('does nothing without the confirmation that names the duplicate risk', async () => {
      await sendAndLose();
      const token = await tokenFor();
      expect(await release({ [RELEASE_FIELD]: token })).toBe('NEXT_REDIRECT:/projects');
      expect(await release({ [RELEASE_FIELD]: token, [CONFIRM_DUPLICATE_FIELD]: 'no' })).toBe(
        'NEXT_REDIRECT:/projects',
      );
      expect((await held()).kind).toBe('PENDING');
    });

    it('does nothing without the CSRF token', async () => {
      await sendAndLose();
      await release(
        { [RELEASE_FIELD]: await tokenFor(), [CONFIRM_DUPLICATE_FIELD]: CONFIRM_DUPLICATE_VALUE },
        null,
      );
      expect((await held()).kind).toBe('PENDING');
    });

    it('with the confirmation and the current record’s name forgets it, and a fresh key is then sent', async () => {
      await sendAndLose();
      await release({
        [RELEASE_FIELD]: await tokenFor(),
        [CONFIRM_DUPLICATE_FIELD]: CONFIRM_DUPLICATE_VALUE,
      });
      expect(await held()).toEqual({ kind: 'NONE' });
      createProject.mockClear();
      createProject.mockResolvedValue(created);
      await submit(formData()).catch(() => undefined);
      expect(createProject).toHaveBeenCalledTimes(1);
    });

    it('refuses a form drawn for an earlier record: a newer unresolved request stays', async () => {
      await sendAndLose();
      const stale = await tokenFor();
      await release({ [RELEASE_FIELD]: stale, [CONFIRM_DUPLICATE_FIELD]: CONFIRM_DUPLICATE_VALUE });
      const second = await sendAndLose({ ...VALID, title: 'عنوان دوم' });
      expect(
        await release({
          [RELEASE_FIELD]: stale,
          [CONFIRM_DUPLICATE_FIELD]: CONFIRM_DUPLICATE_VALUE,
        }),
      ).toBe('NEXT_REDIRECT:/projects?release=STALE');
      expect((await heldRequest()).key).toBe(second.get(SUBMISSION_FIELD));
    });

    it.each([null, 'garbage'])('refuses the release name %j', async (name) => {
      await sendAndLose();
      const fields: Record<string, string> = { [CONFIRM_DUPLICATE_FIELD]: CONFIRM_DUPLICATE_VALUE };
      if (name !== null) fields[RELEASE_FIELD] = name;
      expect(await release(fields)).toBe('NEXT_REDIRECT:/projects?release=STALE');
      expect((await held()).kind).toBe('PENDING');
    });
  });

  describe('who sees it', () => {
    it.each([
      ['another person', { ...SESSION, subject: 'user-2' }],
      ['the same person after a new login', { ...SESSION, csrfToken: 'a-later-login' }],
      ['the same person acting for another organization', { ...SESSION, organizationId: 'ORG-2' }],
    ])('is not seen by %s', async (_name, other) => {
      await sendAndLose();
      expect(await readUnresolved(other, scope)).toEqual({ kind: 'NONE' });
      expect((await held()).kind).toBe('PENDING');
    });
  });
});
