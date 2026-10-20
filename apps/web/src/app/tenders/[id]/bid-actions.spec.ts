/**
 * @jest-environment node
 */
import { CSRF_FIELD } from '@/server/csrf';
import { SUBMISSION_FIELD, mintSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';
import { readFlash } from '@/server/flash';
import { mintBidStamp, type BidTarget } from '@/server/bid-replay';
import { REPLAY_FIELD } from '@/lib/form-fields';
import {
  BID_CODE_TEXT,
  BID_REFUSAL_TEXT,
  PRICE_FIELD,
  answerField,
  criterionField,
} from '@/lib/bid-fields';
import { BID_ID, RECEIPT, REVISED, TENDER_ID, WITHDRAWN } from '@/test/bid-fixtures';

import { IDLE_BID_FORM, type BidFormState, type UnconfirmedBid } from './bid-form-state';

/**
 * The bid commands' write path — the order of checks every portal write keeps,
 * then what each answer becomes, then the unconfirmed path: a retry sends the
 * same key and the same body, and nothing a retry is answered with but a
 * confirmation settles the first request. Against a fake construction-service
 * behind the real gateway client, so what is asserted is what would be sent.
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

const { submitBidCommand } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./bid-actions') as typeof import('./bid-actions');

const SESSION = {
  subject: 'user-1',
  username: 'contractor',
  organizationId: 'ORG-CON-0001',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
} satisfies WebSession;

const SUBMIT: BidTarget = {
  tenderId: TENDER_ID,
  command: 'SUBMIT',
  bidId: null,
  expectedRevision: null,
};
const REVISE: BidTarget = {
  tenderId: TENDER_ID,
  command: 'REVISE',
  bidId: BID_ID,
  expectedRevision: 1,
};
const WITHDRAW: BidTarget = {
  tenderId: TENDER_ID,
  command: 'WITHDRAW',
  bidId: BID_ID,
  expectedRevision: 1,
};

const CONTENT_FIELDS = {
  [PRICE_FIELD]: '۴٬۲۰۰٬۰۰۰٬۰۰۰',
  [criterionField(0)]: 'technical',
  [answerField(0)]: 'روش اجرا',
  [criterionField(1)]: 'compliance',
  [answerField(1)]: '',
};

const CONTENT = {
  priceMinor: '4200000000',
  answers: [{ criterionCode: 'technical', response: 'روش اجرا' }],
};

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly key: string | null;
  readonly body: unknown;
}

let sent: Sent[] = [];
let answer: (body: Record<string, unknown>) => Response;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-correlation-id': `corr-${sent.length}`,
      ...headers,
    },
  });
}

function problem(status: number, code: string, reason?: string): Response {
  return json(status, {
    code,
    message: 'An English sentence never shown',
    correlationId: `corr-${sent.length}`,
    ...(reason ? { details: [{ path: 'bid', code: reason, message: 'English' }] } : {}),
  });
}

function form(
  fields: Record<string, string>,
  target: BidTarget | null,
  options: { csrf?: string | null; submission?: string } = {},
): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  const csrf = options.csrf === undefined ? SESSION.csrfToken : options.csrf;
  if (csrf !== null) data.set(CSRF_FIELD, csrf);
  const submission = options.submission ?? mintSubmissionId(SESSION);
  data.set(SUBMISSION_FIELD, submission);
  if (target) data.set(REPLAY_FIELD, mintBidStamp(SESSION, target, submission).token);
  return data;
}

beforeEach(() => {
  sent = [];
  currentSession.mockResolvedValue(SESSION);
  missingSessionReason.mockResolvedValue('NO_SESSION');
  redirect.mockClear();
  answer = () => json(201, RECEIPT);
  jest.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: RequestInit) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    sent.push({
      url,
      method: init.method ?? 'GET',
      key: new Headers(init.headers).get('idempotency-key'),
      body,
    });
    return answer(body);
  }) as unknown as typeof fetch);
});

afterEach(() => jest.restoreAllMocks());

const send = (data: FormData, previous: BidFormState = IDLE_BID_FORM, tenderId = TENDER_ID) =>
  submitBidCommand(tenderId, previous, data);

describe('the order of checks — nothing is sent until every one passes', () => {
  it('no session: ended, or only unavailable for now', async () => {
    currentSession.mockResolvedValue(null);
    expect(await send(form(CONTENT_FIELDS, SUBMIT))).toEqual({
      kind: 'REFUSED',
      reason: 'NO_SESSION',
    });
    missingSessionReason.mockResolvedValue('SESSION_UNAVAILABLE');
    expect(await send(form(CONTENT_FIELDS, SUBMIT))).toEqual({
      kind: 'REFUSED',
      reason: 'SESSION_UNAVAILABLE',
    });
    expect(sent).toHaveLength(0);
  });

  it('a missing CSRF token, a submission id this server did not mint', async () => {
    expect(await send(form(CONTENT_FIELDS, SUBMIT, { csrf: null }))).toEqual({
      kind: 'REFUSED',
      reason: 'CSRF',
    });
    expect(
      await send(form(CONTENT_FIELDS, SUBMIT, { submission: 'sub_chosen_by_the_client' })),
    ).toEqual({ kind: 'REFUSED', reason: 'SUBMISSION' });
    expect(sent).toHaveLength(0);
  });

  it('no stamp, or a stamp for another tender', async () => {
    expect(await send(form(CONTENT_FIELDS, null))).toEqual({ kind: 'REFUSED', reason: 'REPLAY' });
    expect(await send(form(CONTENT_FIELDS, SUBMIT), IDLE_BID_FORM, 'TND_OTHER')).toEqual({
      kind: 'REFUSED',
      reason: 'REPLAY',
    });
    expect(sent).toHaveLength(0);
  });

  it('a content that does not parse is put back on the form, unsent', async () => {
    const state = await send(form({ ...CONTENT_FIELDS, [PRICE_FIELD]: '1.5' }, SUBMIT));
    expect(state).toMatchObject({
      kind: 'INVALID',
      command: 'SUBMIT',
      fieldErrors: { [PRICE_FIELD]: expect.any(String) },
      values: { priceMinor: '1.5' },
    });
    expect(sent).toHaveLength(0);
  });
});

describe('a submission', () => {
  it('posts the parsed content with its key, and comes back with a confirmation it earned', async () => {
    const data = form(CONTENT_FIELDS, SUBMIT);
    await expect(send(data)).rejects.toThrow('NEXT_REDIRECT');
    expect(sent).toEqual([
      {
        url: `http://gateway.test:3000/v1/tenders/${TENDER_ID}/bids`,
        method: 'POST',
        key: data.get(SUBMISSION_FIELD),
        body: { content: CONTENT },
      },
    ]);
    const url = new URL(redirect.mock.calls[0]![0], 'http://portal.test');
    expect(url.pathname).toBe(`/tenders/${TENDER_ID}`);
    expect(url.searchParams.get('view')).toBe('open');
    expect(readFlash(SESSION, url.searchParams.get('flash'), TENDER_ID, ['SUBMIT'])).toBe('SUBMIT');
  });

  it('the deadline and the qualification are refused in fixed words, the typed content kept', async () => {
    for (const reason of ['BID_WINDOW_CLOSED', 'BIDDER_NOT_ELIGIBLE']) {
      answer = () => problem(422, 'BUSINESS_RULE_VIOLATION', reason);
      const state = await send(form(CONTENT_FIELDS, SUBMIT));
      expect(state).toMatchObject({
        kind: 'INVALID',
        message: BID_REFUSAL_TEXT[reason],
        values: { priceMinor: '۴٬۲۰۰٬۰۰۰٬۰۰۰' },
      });
      expect(JSON.stringify(state)).not.toContain('English');
    }
  });

  it('a second bid of the organization is said as such', async () => {
    answer = () => problem(409, 'ALREADY_EXISTS');
    expect(await send(form(CONTENT_FIELDS, SUBMIT))).toMatchObject({
      kind: 'INVALID',
      message: BID_CODE_TEXT.ALREADY_EXISTS,
    });
  });

  it('a tender the organization may not bid on is NOT_FOUND', async () => {
    answer = () => problem(404, 'NOT_FOUND');
    expect(await send(form(CONTENT_FIELDS, SUBMIT))).toEqual({ kind: 'NOT_FOUND' });
  });
});

describe('a replacement and a withdrawal', () => {
  it('a replacement puts the revision the page signed — whatever the form posts', async () => {
    answer = () => json(200, { ...REVISED, revision: 2 });
    const data = form({ ...CONTENT_FIELDS, expectedRevision: '99', bidId: 'BID_OTHER' }, REVISE);
    await expect(send(data)).rejects.toThrow('NEXT_REDIRECT');
    expect(sent).toEqual([
      {
        url: `http://gateway.test:3000/v1/tenders/${TENDER_ID}/bids/${BID_ID}`,
        method: 'PUT',
        key: data.get(SUBMISSION_FIELD),
        body: { expectedRevision: 1, content: CONTENT },
      },
    ]);
  });

  it('a withdrawal sends the revision only, and reads no content', async () => {
    answer = () => json(200, WITHDRAWN);
    await expect(send(form({ [PRICE_FIELD]: 'ignored' }, WITHDRAW))).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    expect(sent).toEqual([
      {
        url: `http://gateway.test:3000/v1/tenders/${TENDER_ID}/bids/${BID_ID}/withdraw`,
        method: 'POST',
        key: expect.any(String),
        body: { expectedRevision: 1 },
      },
    ]);
  });

  it('a stale form — drawn at revision 1, the bid now at 2 — is refused in fixed words', async () => {
    answer = (body) =>
      body.expectedRevision !== 2 ? problem(409, 'OPTIMISTIC_LOCK_FAILED') : json(200, REVISED);
    expect(await send(form(CONTENT_FIELDS, REVISE))).toMatchObject({
      kind: 'INVALID',
      message: BID_CODE_TEXT.OPTIMISTIC_LOCK_FAILED,
    });
  });
});

describe('unconfirmed', () => {
  it('a 504 is unconfirmed, with the content that was sent and the stamp', async () => {
    answer = () => problem(504, 'UPSTREAM_TIMEOUT');
    const data = form(CONTENT_FIELDS, SUBMIT);
    const state = await send(data);
    expect(state).toMatchObject({
      kind: 'UNCONFIRMED',
      command: 'SUBMIT',
      submissionId: data.get(SUBMISSION_FIELD),
      values: { priceMinor: '۴٬۲۰۰٬۰۰۰٬۰۰۰' },
      replay: { token: data.get(REPLAY_FIELD) },
    });
  });

  it('a retry sends the same key and body; a refusal of it proves nothing', async () => {
    answer = () => problem(504, 'UPSTREAM_TIMEOUT');
    const data = form(CONTENT_FIELDS, SUBMIT);
    const first = (await send(data)) as UnconfirmedBid;
    answer = () => problem(409, 'ALREADY_EXISTS');
    const second = await send(data, first);
    expect(sent[1]).toEqual(sent[0]);
    expect(second).toMatchObject({
      kind: 'UNCONFIRMED',
      correlationId: first.correlationId,
      retryRefused: true,
    });
  });

  it('a replacement or a withdrawal, unconfirmed, is view-only from the start and never sent again', async () => {
    for (const [target, fields] of [
      [REVISE, CONTENT_FIELDS],
      [WITHDRAW, {}],
    ] as const) {
      sent = [];
      answer = () => problem(504, 'UPSTREAM_TIMEOUT');
      const data = form(fields, target);
      const first = (await send(data)) as UnconfirmedBid;
      expect(first).toMatchObject({
        kind: 'UNCONFIRMED',
        command: target.command,
        replay: null,
        viewOnly: true,
        unrepeatable: true,
      });
      // Whatever the form posts again — the same key, a valid stamp — nothing is sent.
      expect(await send(data, first)).toEqual(first);
      expect(sent).toHaveLength(1);
    }
  });

  it('a retry whose session ended says so; a passed deadline makes it view-only', async () => {
    answer = () => problem(504, 'UPSTREAM_TIMEOUT');
    const first = (await send(form(CONTENT_FIELDS, SUBMIT))) as UnconfirmedBid;
    currentSession.mockResolvedValue(null);
    expect(await send(form(CONTENT_FIELDS, SUBMIT), first)).toMatchObject({ sessionEnded: true });
    currentSession.mockResolvedValue(SESSION);
    expect(await send(form(CONTENT_FIELDS, null), first)).toMatchObject({
      viewOnly: true,
      replayExpired: true,
      replay: null,
    });
  });
});
