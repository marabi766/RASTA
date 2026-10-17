/**
 * @jest-environment node
 */
import { REPLAY_FIELD } from '@/lib/form-fields';
import { REASON_FIELD, RETURN_REFUSAL_TEXT, quantityField } from '@/lib/return-fields';
import { CSRF_FIELD } from '@/server/csrf';
import { readFlash } from '@/server/flash';
import { mintReturnStamp, type ReturnTarget } from '@/server/return-replay';
import type { WebSession } from '@/server/session';
import { SUBMISSION_FIELD, mintSubmissionId } from '@/server/submission';
import {
  AUTHORIZED,
  LINE_A,
  ORDER_ID,
  REQUESTED,
  RETURN_ID,
  SUPPLIER,
} from '@/test/return-fixtures';

import { IDLE_RETURN_FORM, type UnconfirmedReturn } from './return-form-state';

/**
 * The return commands' write path — the order of checks every portal write
 * keeps, then what each answer becomes, then the unconfirmed path: a retry
 * sends the same key and the same body, and nothing a retry is answered with
 * but a confirmation settles the first request. Against a fake
 * marketplace-service behind the real gateway client, so what is asserted is
 * what would be sent.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const currentSession = jest.fn();
const missingSessionReason = jest.fn();
const redirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock('@/server/current-session', () => ({
  currentSession: () => currentSession(),
  missingSessionReason: () => missingSessionReason(),
}));
jest.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));

const { submitReturnRequest, submitReturnCommand } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./return-actions') as typeof import('./return-actions');

const SESSION = {
  subject: 'user-1',
  username: 'supplier',
  organizationId: SUPPLIER,
  accessToken: 'access-token-value',
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
} satisfies WebSession;

const AUTHORIZE: ReturnTarget = { command: 'AUTHORIZE', returnId: RETURN_ID };
const REQUEST: ReturnTarget = { command: 'REQUEST', orderId: ORDER_ID };
const REASON = 'سه کیسه از شن رسیده خیس بود.';

interface Sent {
  readonly url: string;
  readonly key: string | null;
  readonly body: unknown;
}

/** What was written — every read the action makes first is kept apart, in `reads`. */
let sent: Sent[] = [];
let answer: () => Response;
let reads: string[] = [];
/** What reading the request answers: the action re-reads it before a withdrawal. */
let current: () => Response;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-correlation-id': `corr-${sent.length}` },
  });
}

function problem(status: number, code: string, message = 'An English sentence never shown') {
  return json(status, { code, message, correlationId: `corr-${sent.length}` });
}

function form(
  fields: Record<string, string>,
  target: ReturnTarget | null,
  options: { csrf?: string | null; submission?: string } = {},
): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  const csrf = options.csrf === undefined ? SESSION.csrfToken : options.csrf;
  if (csrf !== null) data.set(CSRF_FIELD, csrf);
  const submission = options.submission ?? mintSubmissionId(SESSION);
  data.set(SUBMISSION_FIELD, submission);
  if (target) data.set(REPLAY_FIELD, mintReturnStamp(SESSION, target, submission).token);
  return data;
}

const REQUEST_FIELDS = { [REASON_FIELD]: REASON, [quantityField(LINE_A)]: '۳' };

beforeEach(() => {
  sent = [];
  currentSession.mockResolvedValue(SESSION);
  missingSessionReason.mockResolvedValue('NO_SESSION');
  redirect.mockClear();
  answer = () => json(200, AUTHORIZED);
  reads = [];
  current = () => json(200, REQUESTED);
  jest.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: RequestInit) => {
    if ((init.method ?? 'GET') === 'GET') {
      reads.push(url);
      return current();
    }
    const body = init.body ? (JSON.parse(String(init.body)) as unknown) : null;
    sent.push({ url, key: new Headers(init.headers).get('idempotency-key'), body });
    return answer();
  }) as unknown as typeof fetch);
});

afterEach(() => jest.restoreAllMocks());

const decide = (data: FormData, previous = IDLE_RETURN_FORM) =>
  submitReturnCommand(RETURN_ID, previous, data);
const ask = (data: FormData, previous = IDLE_RETURN_FORM) =>
  submitReturnRequest(ORDER_ID, previous, data);

describe('the order of checks — nothing is sent until every one passes', () => {
  it('no session: ended, or only unavailable for now', async () => {
    currentSession.mockResolvedValue(null);
    expect(await decide(form({}, AUTHORIZE))).toEqual({ kind: 'REFUSED', reason: 'NO_SESSION' });
    missingSessionReason.mockResolvedValue('SESSION_UNAVAILABLE');
    expect(await decide(form({}, AUTHORIZE))).toEqual({
      kind: 'REFUSED',
      reason: 'SESSION_UNAVAILABLE',
    });
    expect(sent).toHaveLength(0);
  });

  it('a missing CSRF token, a submission id this server did not mint', async () => {
    expect(await decide(form({}, AUTHORIZE, { csrf: null }))).toEqual({
      kind: 'REFUSED',
      reason: 'CSRF',
    });
    expect(await decide(form({}, AUTHORIZE, { submission: 'sub_chosen_by_the_client' }))).toEqual({
      kind: 'REFUSED',
      reason: 'SUBMISSION',
    });
    expect(sent).toHaveLength(0);
  });

  it('no stamp, a stamp for another request, a request’s stamp on a decision — and the reverse', async () => {
    expect(await decide(form({}, null))).toEqual({ kind: 'REFUSED', reason: 'REPLAY' });
    expect(await decide(form({}, { ...AUTHORIZE, returnId: 'RET_OTHER' }))).toEqual({
      kind: 'REFUSED',
      reason: 'REPLAY',
    });
    expect(await decide(form({}, REQUEST))).toEqual({ kind: 'REFUSED', reason: 'REPLAY' });
    expect(await ask(form(REQUEST_FIELDS, AUTHORIZE))).toEqual({
      kind: 'REFUSED',
      reason: 'REPLAY',
    });
    expect(sent).toHaveLength(0);
  });
});

describe('a decision', () => {
  it('sends the command the page signed — whatever the form posts', async () => {
    const data = form({ decision: 'REJECT', command: 'CANCEL' }, AUTHORIZE);
    await expect(decide(data)).rejects.toThrow('NEXT_REDIRECT');
    expect(sent).toEqual([
      {
        url: `http://gateway.test:3000/v1/returns/${RETURN_ID}/decisions`,
        key: data.get(SUBMISSION_FIELD),
        body: { decision: 'AUTHORIZE' },
      },
    ]);
  });

  it('confirmed: to the request, with a confirmation this session earned for it', async () => {
    await expect(decide(form({}, AUTHORIZE))).rejects.toThrow('NEXT_REDIRECT');
    const url = new URL(redirect.mock.calls[0]![0], 'http://portal.test');
    expect(url.pathname).toBe(`/returns/${RETURN_ID}`);
    expect(readFlash(SESSION, url.searchParams.get('flash'), RETURN_ID, ['AUTHORIZE'])).toBe(
      'AUTHORIZE',
    );
  });

  it('a request decided meanwhile is refused in fixed words, never echoed', async () => {
    const sentence = `Return request ${RETURN_ID} is already CANCELLED and cannot change further`;
    answer = () => problem(422, 'BUSINESS_RULE_VIOLATION', sentence);
    const state = await decide(form({}, AUTHORIZE));
    expect(state).toMatchObject({ kind: 'INVALID', message: RETURN_REFUSAL_TEXT.WRONG_STATE });
    expect(JSON.stringify(state)).not.toContain(sentence);
  });

  it('the other party’s command is a refusal, with its correlation id', async () => {
    answer = () => problem(403, 'FORBIDDEN');
    expect(await decide(form({}, AUTHORIZE))).toEqual({
      kind: 'FORBIDDEN',
      correlationId: expect.any(String),
    });
  });

  it('a withdrawal posts to …/cancellation with no body of its own', async () => {
    await expect(decide(form({}, { command: 'CANCEL', returnId: RETURN_ID }))).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    expect(sent[0]).toMatchObject({
      url: `http://gateway.test:3000/v1/returns/${RETURN_ID}/cancellation`,
      body: {},
    });
  });
});

/**
 * PR 336 review 2, finding 2, PM ruling: the portal withdraws only a request
 * not yet authorized. A form drawn before the supplier authorized it, or a
 * crafted stamp, must not withdraw one that is — the action re-reads first.
 */
describe('a withdrawal, re-read before it is sent', () => {
  const CANCEL: ReturnTarget = { command: 'CANCEL', returnId: RETURN_ID };
  const REQUEST_URL = `http://gateway.test:3000/v1/returns/${RETURN_ID}`;

  it('a REQUESTED one is read, then withdrawn, then confirmed', async () => {
    answer = () => json(200, { ...REQUESTED, status: 'CANCELLED' });
    await expect(decide(form({}, CANCEL))).rejects.toThrow('NEXT_REDIRECT');
    expect(reads).toEqual([REQUEST_URL]);
    expect(sent.map((write) => write.url)).toEqual([`${REQUEST_URL}/cancellation`]);
    const url = new URL(redirect.mock.calls[0]![0], 'http://portal.test');
    expect(readFlash(SESSION, url.searchParams.get('flash'), RETURN_ID, ['CANCEL'])).toBe('CANCEL');
  });

  it('an AUTHORIZED one is refused, in fixed words, and nothing is sent — even with a validly signed stamp', async () => {
    current = () => json(200, AUTHORIZED);
    const state = await decide(form({}, CANCEL));
    expect(state).toEqual({ kind: 'REFUSED', reason: 'CANCEL_NOT_IN_PORTAL' });
    expect(reads).toEqual([REQUEST_URL]);
    expect(sent).toHaveLength(0);
  });

  it.each(['IN_TRANSIT', 'RECEIVED', 'INSPECTED', 'RESOLVED', 'REJECTED', 'SOMETHING_NEW'])(
    'nor one that is %s',
    async (status) => {
      current = () => json(200, { ...AUTHORIZED, status });
      expect(await decide(form({}, CANCEL))).toEqual({
        kind: 'REFUSED',
        reason: 'CANCEL_NOT_IN_PORTAL',
      });
      expect(sent).toHaveLength(0);
    },
  );

  it('a request that cannot be re-read is not withdrawn: refused, or not found — nothing sent', async () => {
    for (const [status, code] of [
      [503, 'SERVICE_UNAVAILABLE'],
      [403, 'FORBIDDEN'],
    ] as const) {
      current = () => problem(status, code);
      expect(await decide(form({}, CANCEL))).toEqual({
        kind: 'REFUSED',
        reason: 'CANCEL_UNCHECKED',
      });
    }
    current = () => json(200, { id: RETURN_ID });
    expect(await decide(form({}, CANCEL))).toEqual({ kind: 'REFUSED', reason: 'CANCEL_UNCHECKED' });
    current = () => problem(404, 'NOT_FOUND');
    expect(await decide(form({}, CANCEL))).toEqual({ kind: 'NOT_FOUND' });
    expect(sent).toHaveLength(0);
  });

  it('a retry of an unconfirmed withdrawal that committed meanwhile is sent again, and confirmed by the replay', async () => {
    const data = form({}, CANCEL);
    answer = () => problem(503, 'SERVICE_UNAVAILABLE');
    const first = (await decide(data)) as UnconfirmedReturn;
    expect(first.kind).toBe('UNCONFIRMED');
    current = () => json(200, { ...REQUESTED, status: 'CANCELLED' });
    answer = () => json(200, { ...REQUESTED, status: 'CANCELLED' });
    await expect(decide(data, first)).rejects.toThrow('NEXT_REDIRECT');
    expect(sent).toHaveLength(2);
    expect(sent[1]!.key).toBe(sent[0]!.key);
  });

  it('a retry refused because the request was authorized meanwhile proves nothing about the first', async () => {
    const data = form({}, CANCEL);
    answer = () => problem(503, 'SERVICE_UNAVAILABLE');
    const first = (await decide(data)) as UnconfirmedReturn;
    current = () => json(200, AUTHORIZED);
    expect(await decide(data, first)).toMatchObject({
      kind: 'UNCONFIRMED',
      submissionId: first.submissionId,
      retryRefused: true,
    });
    expect(sent).toHaveLength(1);
  });

  it('a decision is not re-read first: the service decides', async () => {
    await expect(decide(form({}, AUTHORIZE))).rejects.toThrow('NEXT_REDIRECT');
    expect(reads).toHaveLength(0);
  });
});

describe('a request', () => {
  it('an unreadable form is refused before anything is sent, the values kept', async () => {
    const state = await ask(
      form({ [REASON_FIELD]: 'کوتاه', [quantityField(LINE_A)]: '3' }, REQUEST),
    );
    expect(state).toMatchObject({
      kind: 'INVALID',
      command: 'REQUEST',
      fieldErrors: { [REASON_FIELD]: expect.any(String) },
      values: { reason: 'کوتاه' },
    });
    expect(sent).toHaveLength(0);
  });

  it('confirmed: to the new request, with its confirmation', async () => {
    answer = () => json(201, REQUESTED);
    await expect(ask(form(REQUEST_FIELDS, REQUEST))).rejects.toThrow('NEXT_REDIRECT');
    expect(sent[0]).toMatchObject({
      url: `http://gateway.test:3000/v1/orders/${ORDER_ID}/returns`,
      body: { reason: REASON, lines: [{ orderLineId: LINE_A, quantity: 3 }] },
    });
    const url = new URL(redirect.mock.calls[0]![0], 'http://portal.test');
    expect(url.pathname).toBe(`/returns/${RETURN_ID}`);
    expect(readFlash(SESSION, url.searchParams.get('flash'), RETURN_ID, ['REQUEST'])).toBe(
      'REQUEST',
    );
  });

  it('no window configured (Q-132) or one elapsed: each in its own fixed words', async () => {
    for (const [sentence, text] of [
      [
        'Returns are not open: no return window is configured (open question Q-132)',
        RETURN_REFUSAL_TEXT.WINDOW_NOT_CONFIGURED,
      ],
      [
        `The 14-day return window for order ${ORDER_ID} has elapsed`,
        RETURN_REFUSAL_TEXT.WINDOW_ELAPSED,
      ],
    ] as const) {
      answer = () => problem(422, 'BUSINESS_RULE_VIOLATION', sentence);
      expect(await ask(form(REQUEST_FIELDS, REQUEST))).toMatchObject({
        kind: 'INVALID',
        message: text,
      });
    }
  });

  describe('sent and not confirmed', () => {
    async function unconfirmed(): Promise<{ state: UnconfirmedReturn; data: FormData }> {
      answer = () => problem(503, 'UPSTREAM_UNAVAILABLE');
      const data = form(REQUEST_FIELDS, REQUEST);
      const state = (await ask(data)) as UnconfirmedReturn;
      return { state, data };
    }

    /** The unconfirmed view's form: the kept body, the kept key, the kept stamp. */
    function retryForm(state: UnconfirmedReturn): FormData {
      const data = new FormData();
      data.set(CSRF_FIELD, SESSION.csrfToken);
      data.set(SUBMISSION_FIELD, state.submissionId);
      data.set(REPLAY_FIELD, state.replay?.token ?? '');
      data.set(REASON_FIELD, state.body?.reason ?? '');
      for (const line of state.body?.lines ?? []) {
        data.set(quantityField(line.orderLineId), String(line.quantity));
      }
      return data;
    }

    it('is unconfirmed, with the body as sent, the key and the stamp', async () => {
      const { state, data } = await unconfirmed();
      expect(state).toMatchObject({
        kind: 'UNCONFIRMED',
        command: 'REQUEST',
        submissionId: data.get(SUBMISSION_FIELD),
        body: { reason: REASON, lines: [{ orderLineId: LINE_A, quantity: 3 }] },
        replay: { token: data.get(REPLAY_FIELD) },
      });
    });

    it('a retry is the same key and the same body', async () => {
      const { state } = await unconfirmed();
      answer = () => json(201, REQUESTED);
      await expect(ask(retryForm(state), state)).rejects.toThrow('NEXT_REDIRECT');
      expect(sent).toHaveLength(2);
      expect(sent[1]!.key).toBe(sent[0]!.key);
      expect(sent[1]!.body).toEqual(sent[0]!.body);
    });

    it('a refused retry proves nothing: the original request stays, with a note', async () => {
      const { state } = await unconfirmed();
      answer = () => problem(409, 'CONFLICT', 'A return has already been requested');
      expect(await ask(retryForm(state), state)).toEqual({ ...state, retryRefused: true });
    });

    it('a retry with the session ended, or only unavailable', async () => {
      const { state } = await unconfirmed();
      currentSession.mockResolvedValue(null);
      expect(await ask(retryForm(state), state)).toEqual({ ...state, sessionEnded: true });
      missingSessionReason.mockResolvedValue('SESSION_UNAVAILABLE');
      expect(await ask(retryForm(state), state)).toEqual({ ...state, retryUnknown: true });
    });

    it('a retry past the deadline is not sent, and the view becomes read-only for good', async () => {
      const { state } = await unconfirmed();
      const late = retryForm(state);
      jest.useFakeTimers({ now: Date.now() + 2 * 60 * 60 * 1000 });
      try {
        expect(await ask(late, state)).toEqual({
          ...state,
          replay: null,
          viewOnly: true,
          replayExpired: true,
        });
      } finally {
        jest.useRealTimers();
      }
      expect(sent).toHaveLength(1);
    });
  });
});
