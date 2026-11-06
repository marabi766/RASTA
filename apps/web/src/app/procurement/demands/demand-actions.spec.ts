/**
 * @jest-environment node
 */
import { REPLAY_FIELD } from '@/lib/form-fields';
import { CSRF_FIELD } from '@/server/csrf';
import {
  DEMAND_SUBMIT_UNRESOLVED,
  demandReplayWindowSeconds,
  mintDemandStamp,
} from '@/server/demand-replay';
import { readFlash } from '@/server/flash';
import { SUBMISSION_FIELD, mintSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';
import {
  readUnresolved,
  releaseToken,
  useUnresolvedStore,
  type UnresolvedRead,
} from '@/server/unresolved-request';
import {
  memoryUnresolvedStore,
  UnresolvedStoreUnavailable,
  type UnresolvedStore,
} from '@/server/unresolved-request-store';
import { actingAccessToken } from '@/test/session-token';

import {
  CONFIRM_DUPLICATE_FIELD,
  CONFIRM_DUPLICATE_VALUE,
  IDLE_DEMAND_FORM,
  RELEASE_FIELD,
} from './demand-form-state';

/**
 * The demand form's write path: the order is the assertion (session, CSRF,
 * submission id, signed deadline, form, reservation, gateway), each refusal
 * proves nothing was sent, the submission id travels as the Idempotency-Key, and
 * an unconfirmed submission holds the slot on the server until it is resolved or
 * knowingly released (checklist A, B 3).
 */

const currentSession = jest.fn();
const submitDemand = jest.fn();
const redirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock('@/server/current-session', () => ({
  currentSession: () => currentSession(),
  missingSessionReason: async () => 'NO_SESSION',
}));
jest.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));
jest.mock('@/server/demand-commands', () => {
  const actual = jest.requireActual('@/server/demand-commands');
  return { ...actual, submitDemand: (...args: unknown[]) => submitDemand(...args) };
});

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const { releaseUnresolvedDemand, submitDemandRequest } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./demand-actions') as typeof import('./demand-actions');

const SESSION = {
  subject: 'user-1',
  username: 'buyer',
  organizationId: 'ORG-BUYER',
  accessToken: actingAccessToken('ORG-BUYER', ['PROCUREMENT_USER']),
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
} satisfies WebSession;

const PRODUCT = 'PRD_01J00000000000000000000000';
const VALID = { productId: PRODUCT, quantity: '۱۲', note: '' };
const CREATED = { kind: 'CREATED', data: { id: 'DMR_1' }, correlationId: 'c' };
const LOST = { kind: 'UNKNOWN_OUTCOME', correlationId: 'lost' };

function formData(
  fields: Record<string, string> = VALID,
  options: {
    csrf?: string | null;
    submission?: string | null;
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
      ? mintDemandStamp(SESSION, submission ?? '', options.replay)
      : options.replay;
  if (replay !== null) form.set(REPLAY_FIELD, replay);
  return form;
}

const submit = (form: FormData) => submitDemandRequest(IDLE_DEMAND_FORM, form);
const held = (): Promise<UnresolvedRead> => readUnresolved(SESSION, DEMAND_SUBMIT_UNRESOLVED);
async function heldRequest() {
  const read = await held();
  if (read.kind !== 'PENDING') throw new Error(`expected a held request, got ${read.kind}`);
  return read.request;
}
async function sendAndLose(fields = VALID) {
  submitDemand.mockResolvedValue(LOST);
  const form = formData(fields);
  expect(await submit(form)).toMatchObject({ kind: 'UNCONFIRMED' });
  return form;
}

beforeEach(() => {
  currentSession.mockResolvedValue(SESSION);
  submitDemand.mockReset();
  submitDemand.mockResolvedValue(CREATED);
  redirect.mockClear();
  useUnresolvedStore(memoryUnresolvedStore());
});
afterEach(() => jest.restoreAllMocks());

describe('what is refused before anything is sent', () => {
  it.each([
    ['no session', () => (currentSession.mockResolvedValue(null), formData()), 'NO_SESSION'],
    ['a wrong CSRF token', () => formData(VALID, { csrf: 'forged' }), 'CSRF'],
    ['no submission id', () => formData(VALID, { submission: null, replay: 'x' }), 'SUBMISSION'],
    [
      'another login’s submission id',
      () => formData(VALID, { submission: mintSubmissionId({ ...SESSION, subject: 'user-2' }) }),
      'SUBMISSION',
    ],
    ['no stamp', () => formData(VALID, { replay: null }), 'SUBMISSION'],
    ['a forged stamp', () => formData(VALID, { replay: 'forged.token' }), 'SUBMISSION'],
    [
      'a stamp signed for another submission id',
      () => {
        const form = formData();
        form.set(REPLAY_FIELD, mintDemandStamp(SESSION, mintSubmissionId(SESSION)));
        return form;
      },
      'SUBMISSION',
    ],
  ])('refuses %s', async (_name, make, reason) => {
    expect(await submit(make())).toEqual({ kind: 'REFUSED', reason });
    expect(submitDemand).not.toHaveBeenCalled();
    expect(await held()).toEqual({ kind: 'NONE' });
  });

  it('keeps what was typed, the same key and stamp, and names the fields when the form is invalid', async () => {
    const form = formData({ productId: 'PRD_bad', quantity: '0', note: 'x' });
    const state = await submit(form);
    expect(state).toMatchObject({
      kind: 'INVALID',
      submissionId: form.get(SUBMISSION_FIELD),
      replay: form.get(REPLAY_FIELD),
      values: { productId: 'PRD_bad', quantity: '0', note: 'x' },
    });
    if (state.kind !== 'INVALID') throw new Error(state.kind);
    expect(Object.keys(state.fieldErrors).sort()).toEqual(['productId', 'quantity']);
    expect(submitDemand).not.toHaveBeenCalled();
  });

  it.each([
    ['501 code points', 'ن'.repeat(501)],
    ['a bidirectional control', `یادداشت${String.fromCodePoint(0x202e)}`],
  ])('refuses a note of %s', async (_name, note) => {
    const state = await submit(formData({ ...VALID, note }));
    expect(state).toMatchObject({ kind: 'INVALID', fieldErrors: { note: expect.any(String) } });
    expect(submitDemand).not.toHaveBeenCalled();
  });
});

describe('what is sent', () => {
  it('sends the body with the submission id as the key, then shows the new demand', async () => {
    const form = formData();
    await expect(submit(form)).rejects.toThrow('NEXT_REDIRECT:');
    expect(submitDemand).toHaveBeenCalledWith(
      SESSION,
      { productId: PRODUCT, quantity: 12 },
      form.get(SUBMISSION_FIELD),
    );
    const url = new URL(redirect.mock.calls[0]![0], 'http://portal.test');
    expect(url.pathname).toBe('/procurement/demands/DMR_1');
    expect(readFlash(SESSION, url.searchParams.get('flash'), 'DMR_1', ['submitted'])).toBe(
      'submitted',
    );
    expect(await held()).toEqual({ kind: 'NONE' });
  });

  it('never sends an organization written into the form', async () => {
    const form = formData({ ...VALID, organizationId: 'ORG-OTHER' });
    await expect(submit(form)).rejects.toThrow('NEXT_REDIRECT:');
    expect(JSON.stringify(submitDemand.mock.calls[0]![1])).not.toContain('ORG-OTHER');
  });

  it('sends a note with LF however the browser posted its newlines, and 500 code points of astral text', async () => {
    const astral = '😀'.repeat(492);
    await expect(submit(formData({ ...VALID, note: `اول\r\nدوم\r${astral}` }))).rejects.toThrow(
      'NEXT_REDIRECT:',
    );
    const body = submitDemand.mock.calls[0]![1] as { note: string };
    expect(body.note).toBe(`اول\nدوم\n${astral}`);
    expect([...body.note].length).toBe(MAX_NOTE);
  });

  it('leaves an empty note out rather than sending ""', async () => {
    await expect(submit(formData({ ...VALID, note: '   ' }))).rejects.toThrow('NEXT_REDIRECT:');
    expect(submitDemand.mock.calls[0]![1]).toEqual({ productId: PRODUCT, quantity: 12 });
  });
});

const MAX_NOTE = 500;

describe('a form left open past the service’s idempotency retention', () => {
  const window = () => demandReplayWindowSeconds() * 1000;

  it('is not sent after the window — it says to check the list, and nothing is kept', async () => {
    const state = await submit(formData(VALID, { replay: Date.now() - window() - 1000 }));
    expect(state).toMatchObject({ kind: 'EXPIRED', values: { ...VALID, quantity: '12' } });
    expect(submitDemand).not.toHaveBeenCalled();
    expect(await held()).toEqual({ kind: 'NONE' });
  });

  it('a pause after the reservation that crosses the deadline (less the skew budget) sends nothing', async () => {
    const real = Date.now();
    const inner = memoryUnresolvedStore();
    useUnresolvedStore({
      ...inner,
      reserve: async (input) => {
        const reply = await inner.reserve(input);
        jest.spyOn(Date, 'now').mockReturnValue(real + window() - 10_000);
        return reply;
      },
    });
    expect(await submit(formData(VALID, { replay: real }))).toMatchObject({ kind: 'EXPIRED' });
    expect(submitDemand).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    expect(await held()).toEqual({ kind: 'NONE' });
  });
});

describe('what comes back', () => {
  it.each([
    ['UNKNOWN_OUTCOME', LOST],
    ['a 5xx', { kind: 'UNAVAILABLE', status: 502, code: 'BAD_GATEWAY', correlationId: 'c' }],
    [
      'a 503 with a code',
      { kind: 'UNAVAILABLE', status: 503, code: 'SERVICE_UNAVAILABLE', correlationId: 'c' },
    ],
    ['a 4xx without a documented code', { kind: 'UNAVAILABLE', status: 413, correlationId: 'c' }],
  ])('%s is UNCONFIRMED — never "nothing changed" — and holds the slot', async (_name, result) => {
    submitDemand.mockResolvedValue(result);
    const form = formData();
    expect(await submit(form)).toMatchObject({ kind: 'UNCONFIRMED' });
    expect((await heldRequest()).key).toBe(form.get(SUBMISSION_FIELD));
  });

  it.each([
    [
      'a 4xx with a documented code',
      { kind: 'UNAVAILABLE', status: 413, code: 'PAYLOAD_TOO_LARGE', correlationId: 'c' },
    ],
    [
      'a request that never left',
      { kind: 'UNAVAILABLE', status: 503, neverSent: true, correlationId: 'c' },
    ],
  ])('%s is FAILED — nothing changed — and nothing is held', async (_name, result) => {
    submitDemand.mockResolvedValue(result);
    expect(await submit(formData())).toMatchObject({ kind: 'FAILED' });
    expect(await held()).toEqual({ kind: 'NONE' });
  });

  it('a refusal keeps the values, the same key and stamp, and holds nothing', async () => {
    submitDemand.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: {},
      message: 'fixed words',
      correlationId: 'c',
    });
    const form = formData();
    expect(await submit(form)).toMatchObject({
      kind: 'INVALID',
      submissionId: form.get(SUBMISSION_FIELD),
      replay: form.get(REPLAY_FIELD),
      message: 'fixed words',
    });
    expect(await held()).toEqual({ kind: 'NONE' });
  });

  it('a request still being processed keeps values and key for a retry, and holds the slot', async () => {
    submitDemand.mockResolvedValue({
      kind: 'IN_PROGRESS',
      retryAfterSeconds: 1,
      correlationId: 'c',
    });
    const form = formData();
    expect(await submit(form)).toMatchObject({
      kind: 'IN_PROGRESS',
      submissionId: form.get(SUBMISSION_FIELD),
      replay: form.get(REPLAY_FIELD),
      retryAfterSeconds: 1,
    });
    expect(await held()).toMatchObject({ kind: 'PENDING' });
  });

  it('an exception after the dispatch began leaves the request unresolved', async () => {
    submitDemand.mockRejectedValue(new Error('boom'));
    await expect(submit(formData())).rejects.toThrow('boom');
    expect(await held()).toMatchObject({ kind: 'PENDING' });
  });
});

describe('an unresolved submission outlives the form that sent it (checklist A 2)', () => {
  it('a reload’s fresh form (new key) is HELD and not sent, even with the same values', async () => {
    await sendAndLose();
    submitDemand.mockClear();
    expect(await submit(formData())).toMatchObject({ kind: 'HELD', reason: 'OTHER_REQUEST' });
    expect(submitDemand).not.toHaveBeenCalled();
  });

  it('other values under the remembered key are HELD and not sent', async () => {
    const first = await sendAndLose();
    submitDemand.mockClear();
    first.set('quantity', '13');
    expect(await submit(first)).toMatchObject({ kind: 'HELD', reason: 'CHANGED_BODY' });
    expect(submitDemand).not.toHaveBeenCalled();
  });

  it('the SAME request is resent under the same key, and a created answer clears it', async () => {
    const first = await sendAndLose();
    submitDemand.mockResolvedValue(CREATED);
    await expect(submit(first)).rejects.toThrow('NEXT_REDIRECT:');
    expect(submitDemand.mock.calls[1]![2]).toBe(first.get(SUBMISSION_FIELD));
    expect(submitDemand.mock.calls[1]![1]).toEqual(submitDemand.mock.calls[0]![1]);
    expect(await held()).toEqual({ kind: 'NONE' });
  });

  it('a refused retry proves only that attempt did nothing: the request stays held', async () => {
    const first = await sendAndLose();
    submitDemand.mockResolvedValue({ kind: 'FORBIDDEN', correlationId: 'denied' });
    expect(await submit(first)).toMatchObject({ kind: 'FORBIDDEN' });
    expect((await heldRequest()).key).toBe(first.get(SUBMISSION_FIELD));
  });

  it('is not resent past its deadline, and stays held', async () => {
    const first = formData(VALID, {
      replay: Date.now() - demandReplayWindowSeconds() * 1000 + 60_000,
    });
    submitDemand.mockResolvedValue(LOST);
    await submit(first);
    submitDemand.mockClear();
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
    expect(await submit(first)).toMatchObject({ kind: 'EXPIRED' });
    expect(submitDemand).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    expect(await held()).toMatchObject({ kind: 'PENDING' });
  });

  it('a store that cannot answer is not "nothing held": nothing is sent', async () => {
    const broken: UnresolvedStore = {
      ...memoryUnresolvedStore(),
      reserve: async () => {
        throw new UnresolvedStoreUnavailable(new Error('down'));
      },
    };
    useUnresolvedStore(broken);
    expect(await submit(formData())).toMatchObject({ kind: 'NOT_CHECKED' });
    expect(submitDemand).not.toHaveBeenCalled();
  });

  it('is held per organization: another organization of the same login is not blocked by it, nor sees it', async () => {
    await sendAndLose();
    const other = {
      ...SESSION,
      organizationId: 'ORG-SECOND',
      accessToken: actingAccessToken('ORG-SECOND', ['PROCUREMENT_USER']),
    };
    expect(await readUnresolved(other, DEMAND_SUBMIT_UNRESOLVED)).toEqual({ kind: 'NONE' });
  });
});

describe('send as new', () => {
  async function release(fields: { confirm?: boolean; token?: string | null }) {
    const form = new FormData();
    form.set(CSRF_FIELD, SESSION.csrfToken);
    if (fields.confirm !== false) form.set(CONFIRM_DUPLICATE_FIELD, CONFIRM_DUPLICATE_VALUE);
    const request = (await held()).kind === 'PENDING' ? await heldRequest() : null;
    const token =
      fields.token === undefined && request
        ? releaseToken(SESSION, DEMAND_SUBMIT_UNRESOLVED, request)
        : fields.token;
    if (token) form.set(RELEASE_FIELD, token);
    await expect(releaseUnresolvedDemand(form)).rejects.toThrow('NEXT_REDIRECT:');
    return String(redirect.mock.calls.at(-1)![0]);
  }

  it('lets go of the held request only with the confirmation and the token drawn for it', async () => {
    await sendAndLose();
    await release({ confirm: false });
    expect(await held()).toMatchObject({ kind: 'PENDING' });
    expect(await release({ token: 'forged' })).toContain('release=STALE');
    expect(await held()).toMatchObject({ kind: 'PENDING' });
    await release({});
    expect(await held()).toEqual({ kind: 'NONE' });
    // And a fresh form goes out again.
    submitDemand.mockResolvedValue(CREATED);
    await expect(submit(formData())).rejects.toThrow('NEXT_REDIRECT:');
  });

  it('a release form drawn for an earlier request does not release a newer one', async () => {
    await sendAndLose();
    const oldToken = releaseToken(SESSION, DEMAND_SUBMIT_UNRESOLVED, await heldRequest());
    await release({});
    await sendAndLose();
    expect(await release({ token: oldToken })).toContain('release=STALE');
    expect(await held()).toMatchObject({ kind: 'PENDING' });
  });
});
