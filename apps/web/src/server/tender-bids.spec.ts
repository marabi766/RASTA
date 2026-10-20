/**
 * @jest-environment node
 */
import { BID_REFUSAL_FALLBACK, BID_REFUSAL_TEXT, PRICE_FIELD, answerField } from '@/lib/bid-fields';
import {
  BIDDER,
  BID_ID,
  CLOSES,
  DURING,
  OPENS,
  OPEN_TENDER,
  RECEIPT,
  REVISED,
  TENDER_ID,
  WITHDRAWN,
  tokenFor,
} from '@/test/bid-fixtures';

import {
  bidderCallerOf,
  bidOffers,
  bidRequest,
  bidWindowAt,
  canBid,
  fetchOwnBid,
  issueBidCommand,
  type BidBinding,
} from './tender-bids';
import type { ReadResult } from './assets';
import type { WebSession } from './session';

/**
 * The bid module: what it reads, who it offers each form to — the copy of
 * construction-service's checks pinned by `tender-bids.contract.spec.ts` —
 * what each form sends, and what every answer becomes.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const SESSION = { accessToken: 'access-token-value' } as WebSession;
const SUBMISSION = 'sub_AAAAAAAAAAAAAAAAAAAA';
const CONTENT = {
  priceMinor: '4200000000',
  answers: [{ criterionCode: 'technical', response: 'روش اجرا با ماشین‌آلات خودی' }],
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-correlation-id': 'corr-1', ...headers },
  });
}

function problem(status: number, code: string, details?: { path: string; code: string }[]) {
  return jsonResponse(status, {
    code,
    message: 'An English sentence the page must never show',
    correlationId: 'corr-1',
    ...(details ? { details: details.map((d) => ({ ...d, message: 'English again' })) } : {}),
  });
}

const contractor = bidderCallerOf(tokenFor(BIDDER, ['CONTRACTOR']));
const tender: ReadResult<typeof OPEN_TENDER> = { kind: 'OK', data: OPEN_TENDER };
const own = (data: typeof RECEIPT): ReadResult<typeof RECEIPT> => ({ kind: 'OK', data });
const NO_BID: ReadResult<typeof RECEIPT> = { kind: 'NOT_FOUND' };

afterEach(() => jest.restoreAllMocks());

describe('reading one’s own bid', () => {
  it('reads …/bids/mine and keeps the receipt, never content', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation((async () =>
      jsonResponse(200, {
        ...RECEIPT,
        content: { priceMinor: '1' },
      })) as unknown as typeof fetch);
    const read = await fetchOwnBid(SESSION, TENDER_ID);
    expect(read).toEqual({ kind: 'OK', data: RECEIPT });
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      `http://gateway.test:3000/v1/tenders/${TENDER_ID}/bids/mine`,
    );
  });

  it('no bid of this organization, and a tender that does not exist, are the same NOT_FOUND', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((async () => problem(404, 'NOT_FOUND')) as unknown as typeof fetch);
    expect(await fetchOwnBid(SESSION, TENDER_ID)).toEqual({ kind: 'NOT_FOUND' });
  });

  it('a receipt for another tender is malformed, not this bid', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((async () =>
        jsonResponse(200, { ...RECEIPT, tenderId: 'TND_OTHER' })) as unknown as typeof fetch);
    expect(await fetchOwnBid(SESSION, TENDER_ID)).toMatchObject({ kind: 'MALFORMED' });
  });
});

describe('who is a bidder — assertCanBid', () => {
  it('a CONTRACTOR acting for an organization', () => {
    expect(canBid(contractor)).toBe(true);
  });

  it('never with the platform administrator or the oversight role, even alongside CONTRACTOR', () => {
    expect(canBid(bidderCallerOf(tokenFor(BIDDER, ['CONTRACTOR', 'AUDITOR'])))).toBe(false);
    expect(
      canBid(bidderCallerOf(tokenFor(BIDDER, ['CONTRACTOR'], { realm: ['SYSTEM_ADMIN'] }))),
    ).toBe(false);
  });

  it('not without CONTRACTOR, and not from a token that cannot be read', () => {
    expect(canBid(bidderCallerOf(tokenFor(BIDDER, ['ORGANIZATION_ADMIN'])))).toBe(false);
    expect(canBid(bidderCallerOf('not-a-token'))).toBe(false);
  });

  it('a person without a platform user id still bids: the actor falls back to the subject', () => {
    expect(canBid(bidderCallerOf(tokenFor(BIDDER, ['CONTRACTOR'], { uid: false })))).toBe(true);
  });
});

describe('the window — [bidOpeningAt, bidClosingAt)', () => {
  it('not open before the opening, open from it, closed at the closing instant', () => {
    expect(bidWindowAt(OPEN_TENDER, OPENS - 1)).toBe('NOT_OPEN');
    expect(bidWindowAt(OPEN_TENDER, OPENS)).toBe('OPEN');
    expect(bidWindowAt(OPEN_TENDER, CLOSES - 1)).toBe('OPEN');
    expect(bidWindowAt(OPEN_TENDER, CLOSES)).toBe('CLOSED');
  });
});

describe('which forms are offered', () => {
  it('a submission when the organization has no bid, inside the window', () => {
    expect(bidOffers(contractor, tender, NO_BID, DURING)).toEqual({
      offers: [{ command: 'SUBMIT' }],
      note: null,
    });
  });

  it('a replacement and a withdrawal of a SUBMITTED bid, bound to its revision', () => {
    expect(bidOffers(contractor, tender, own(REVISED), DURING).offers).toEqual([
      { command: 'REVISE', bidId: BID_ID, expectedRevision: 2 },
      { command: 'WITHDRAW', bidId: BID_ID, expectedRevision: 2 },
    ]);
  });

  it('nothing for a withdrawn bid', () => {
    expect(bidOffers(contractor, tender, own(WITHDRAWN), DURING)).toEqual({
      offers: [],
      note: null,
    });
  });

  it('nothing before the opening or after the deadline, with a note saying which', () => {
    expect(bidOffers(contractor, tender, NO_BID, OPENS - 1)).toEqual({
      offers: [],
      note: 'NOT_OPEN',
    });
    expect(bidOffers(contractor, tender, own(RECEIPT), CLOSES)).toEqual({
      offers: [],
      note: 'CLOSED',
    });
  });

  it('nothing while the bid could not be read: whether one exists is unknown', () => {
    expect(
      bidOffers(
        contractor,
        tender,
        { kind: 'UNAVAILABLE', status: 503, correlationId: 'c' },
        DURING,
      ),
    ).toEqual({ offers: [], note: 'UNREAD' });
    expect(
      bidOffers(contractor, tender, { kind: 'MALFORMED', correlationId: 'c' }, DURING),
    ).toEqual({ offers: [], note: 'UNREAD' });
    expect(bidOffers(contractor, tender, { kind: 'FORBIDDEN' }, DURING)).toEqual({
      offers: [],
      note: 'REFUSED',
    });
  });

  it('nothing to a caller that is no bidder, or on a tender the bidder’s door does not show', () => {
    const owner = bidderCallerOf(tokenFor('ORG-DEH-0001', ['ORGANIZATION_ADMIN']));
    expect(bidOffers(owner, tender, null, DURING).offers).toEqual([]);
    expect(bidOffers(contractor, { kind: 'NOT_FOUND' }, own(RECEIPT), DURING).offers).toEqual([]);
  });
});

describe('what each command sends — the bid and the revision from the stamp', () => {
  const submit: BidBinding = { command: 'SUBMIT', bidId: null, expectedRevision: null };
  const revise: BidBinding = { command: 'REVISE', bidId: BID_ID, expectedRevision: 2 };
  const withdraw: BidBinding = { command: 'WITHDRAW', bidId: BID_ID, expectedRevision: 2 };

  it('a submission posts the content to the tender’s bids', () => {
    expect(bidRequest(TENDER_ID, submit, CONTENT)).toEqual({
      method: 'POST',
      path: `/v1/tenders/${TENDER_ID}/bids`,
      body: { content: CONTENT },
    });
  });

  it('a replacement puts the revision shown and the content', () => {
    expect(bidRequest(TENDER_ID, revise, CONTENT)).toEqual({
      method: 'PUT',
      path: `/v1/tenders/${TENDER_ID}/bids/${BID_ID}`,
      body: { expectedRevision: 2, content: CONTENT },
    });
  });

  it('a withdrawal posts the revision shown, and no content', () => {
    expect(bidRequest(TENDER_ID, withdraw, null)).toEqual({
      method: 'POST',
      path: `/v1/tenders/${TENDER_ID}/bids/${BID_ID}/withdraw`,
      body: { expectedRevision: 2 },
    });
  });

  it('a binding that cannot carry its command carries nothing', () => {
    expect(bidRequest(TENDER_ID, { ...submit, bidId: BID_ID }, CONTENT)).toBeNull();
    expect(bidRequest(TENDER_ID, submit, null)).toBeNull();
    expect(bidRequest(TENDER_ID, { ...revise, expectedRevision: null }, CONTENT)).toBeNull();
    expect(bidRequest(TENDER_ID, revise, null)).toBeNull();
    expect(bidRequest(TENDER_ID, withdraw, CONTENT)).toBeNull();
  });
});

describe('what every answer becomes', () => {
  const send = (binding: BidBinding, fetchImpl: jest.Mock, rows: number[] = [0]) => {
    const request = bidRequest(
      TENDER_ID,
      binding,
      binding.command === 'WITHDRAW' ? null : CONTENT,
    )!;
    return issueBidCommand(
      SESSION,
      TENDER_ID,
      binding,
      request,
      rows,
      SUBMISSION,
      fetchImpl as unknown as typeof fetch,
    );
  };
  const submit: BidBinding = { command: 'SUBMIT', bidId: null, expectedRevision: null };
  const revise: BidBinding = { command: 'REVISE', bidId: BID_ID, expectedRevision: 1 };
  const withdraw: BidBinding = { command: 'WITHDRAW', bidId: BID_ID, expectedRevision: 1 };

  it('sends every command with its key; a PUT for the replacement', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(201, RECEIPT));
    expect(await send(submit, fetchImpl)).toMatchObject({ kind: 'CREATED', data: RECEIPT });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://gateway.test:3000/v1/tenders/${TENDER_ID}/bids`);
    expect(new Headers(init.headers).get('idempotency-key')).toBe(SUBMISSION);
    expect(JSON.parse(String(init.body))).toEqual({ content: CONTENT });

    const put = jest.fn(async () => jsonResponse(200, REVISED));
    expect(await send(revise, put)).toMatchObject({ kind: 'CREATED' });
    const [, putInit] = put.mock.calls[0] as unknown as [string, RequestInit];
    expect(putInit.method).toBe('PUT');
    expect(new Headers(putInit.headers).get('idempotency-key')).toBe(SUBMISSION);
  });

  it('confirms only the answer that shows the command took', async () => {
    // A receipt that is not the new bid's first revision is not a submission's.
    expect(
      await send(
        submit,
        jest.fn(async () => jsonResponse(201, REVISED)),
      ),
    ).toMatchObject({
      kind: 'UNKNOWN_OUTCOME',
    });
    // A replacement must come back one revision on.
    expect(
      await send(
        revise,
        jest.fn(async () => jsonResponse(200, RECEIPT)),
      ),
    ).toMatchObject({
      kind: 'UNKNOWN_OUTCOME',
    });
    // A withdrawal must come back withdrawn, at the revision it was drawn on.
    expect(
      await send(
        withdraw,
        jest.fn(async () => jsonResponse(200, RECEIPT)),
      ),
    ).toMatchObject({
      kind: 'UNKNOWN_OUTCOME',
    });
    expect(
      await send(
        withdraw,
        jest.fn(async () => jsonResponse(200, WITHDRAWN)),
      ),
    ).toMatchObject({
      kind: 'CREATED',
    });
  });

  it('the deadline and the qualification are said in fixed words, never the service’s', async () => {
    for (const reason of ['BID_WINDOW_CLOSED', 'BID_WINDOW_NOT_OPEN', 'BIDDER_NOT_ELIGIBLE']) {
      const refused = await send(
        submit,
        jest.fn(async () =>
          problem(422, 'BUSINESS_RULE_VIOLATION', [{ path: 'bid', code: reason }]),
        ),
      );
      expect(refused).toMatchObject({ kind: 'INVALID', message: BID_REFUSAL_TEXT[reason] });
      expect(JSON.stringify(refused)).not.toContain('English');
    }
  });

  it('a second bid, a stale form and an unknown refusal each have their fixed sentence', async () => {
    const second = await send(
      submit,
      jest.fn(async () => problem(409, 'ALREADY_EXISTS')),
    );
    expect(second.kind === 'INVALID' && second.message).toMatch(/پیش‌تر برای این مناقصه پیشنهاد/);
    const stale = await send(
      revise,
      jest.fn(async () => problem(409, 'OPTIMISTIC_LOCK_FAILED')),
    );
    expect(stale.kind === 'INVALID' && stale.message).toMatch(/تغییر کرده است/);
    const odd = await send(
      submit,
      jest.fn(async () => problem(422, 'SOMETHING_NEW')),
    );
    expect(odd).toMatchObject({ kind: 'INVALID', message: BID_REFUSAL_FALLBACK });
  });

  it('places a field error on the form row it came from', async () => {
    const refused = await send(
      submit,
      jest.fn(async () =>
        problem(400, 'VALIDATION_FAILED', [
          { path: 'content.answers.0.response', code: 'too_big' },
          { path: 'content.priceMinor', code: 'custom' },
        ]),
      ),
      [1],
    );
    expect(refused).toMatchObject({
      kind: 'INVALID',
      fieldErrors: { [answerField(1)]: expect.any(String), [PRICE_FIELD]: expect.any(String) },
    });
  });

  it('a 5xx, a 504 and an in-flight 409 are unconfirmed, never "nothing happened"', async () => {
    expect(
      await send(
        submit,
        jest.fn(async () => problem(503, 'UPSTREAM_UNAVAILABLE')),
      ),
    ).toMatchObject({ kind: 'UNKNOWN_OUTCOME' });
    expect(
      await send(
        submit,
        jest.fn(async () => problem(504, 'UPSTREAM_TIMEOUT')),
      ),
    ).toMatchObject({
      kind: 'UNKNOWN_OUTCOME',
    });
    expect(
      await send(
        submit,
        jest.fn(async () =>
          jsonResponse(
            409,
            { code: 'CONFLICT', message: 'x', correlationId: 'c' },
            { 'retry-after': '1' },
          ),
        ),
      ),
    ).toMatchObject({ kind: 'IN_PROGRESS' });
  });

  it('a tender this organization may not bid on is NOT_FOUND', async () => {
    expect(
      await send(
        submit,
        jest.fn(async () => problem(404, 'NOT_FOUND')),
      ),
    ).toMatchObject({
      kind: 'NOT_FOUND',
    });
  });
});
