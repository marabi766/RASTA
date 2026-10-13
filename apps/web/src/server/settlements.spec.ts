/**
 * @jest-environment node
 */
import { fetchSettlement, fetchSettlements, SETTLEMENTS_PER_PAGE } from './settlements';
import type { WebSession } from './session';

/**
 * Reading settlements. The cases that would be silent if wrong: an amount
 * coerced to a `number`, a "next page" offered when there is none (or not
 * offered when there is), the payer/payee side sent as the wrong flag, and a
 * non-party's 404 turned into something other than "absent".
 */

const SESSION: WebSession = {
  subject: 'USR_1',
  username: 'admin',
  organizationId: 'ORG_A',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: 2_000_000_000,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf',
  issuedAt: 1_900_000_000,
};

beforeEach(() => {
  Object.assign(process.env, {
    API_GATEWAY_URL: 'http://gateway.test:3000',
    OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
    OIDC_CLIENT_ID: 'rasta-web',
    WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
    WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
  });
});

function answering(body: unknown, status = 200) {
  const urls: string[] = [];
  const impl = (async (url: RequestInfo | URL) => {
    urls.push(String(url));
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { impl, urls };
}

function withFetch<T>(handler: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

/** Past 2^53: a `number` could not hold it, and would not say so. */
const HUGE = '90071992547409931234';

const row = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `SET_${n}`,
  transactionId: 'TX_1',
  journalId: 'JRN_1',
  payerOrganizationId: 'ORG_A',
  payeeOrganizationId: 'ORG_B',
  grossAmountMinor: HUGE,
  commissionAmountMinor: '100',
  netAmountMinor: '90071992547409931134',
  currency: 'IRR',
  settledAt: '2026-09-20T08:00:00.000Z',
  settledBy: 'USR_9',
  ...overrides,
});

describe('fetchSettlements', () => {
  it('asks for the payer view with incoming=false and the payee view with incoming=true', async () => {
    const paid = answering({ items: [] });
    await withFetch(paid.impl, () => fetchSettlements(SESSION, { view: 'PAID' }));
    expect(new URL(paid.urls[0]!).searchParams.get('incoming')).toBe('false');

    const received = answering({ items: [] });
    await withFetch(received.impl, () => fetchSettlements(SESSION, { view: 'RECEIVED' }));
    expect(new URL(received.urls[0]!).searchParams.get('incoming')).toBe('true');
  });

  it('keeps amounts as the strings they arrived as', async () => {
    const { impl } = answering({ items: [row(1)] });
    const result = await withFetch(impl, () => fetchSettlements(SESSION, { view: 'PAID' }));

    if (result.kind !== 'OK') throw new Error('expected OK');
    expect(result.data.items[0]?.grossAmountMinor).toBe(HUGE);
    expect(result.data.nextCursor).toBeNull();
  });

  it('does not carry the user who settled', async () => {
    const { impl } = answering({ items: [row(1)] });
    const result = await withFetch(impl, () => fetchSettlements(SESSION, { view: 'PAID' }));
    expect(JSON.stringify(result)).not.toContain('USR_9');
  });

  it('asks for one row more than it shows, and uses the last shown row as the cursor', async () => {
    const rows = Array.from({ length: SETTLEMENTS_PER_PAGE + 1 }, (_, i) => row(i));
    const { impl, urls } = answering({ items: rows });
    const result = await withFetch(impl, () =>
      fetchSettlements(SESSION, { view: 'PAID', cursor: 'SET_PREV' }),
    );

    const params = new URL(urls[0]!).searchParams;
    expect(params.get('limit')).toBe(String(SETTLEMENTS_PER_PAGE + 1));
    expect(params.get('cursor')).toBe('SET_PREV');
    if (result.kind !== 'OK') throw new Error('expected OK');
    expect(result.data.items).toHaveLength(SETTLEMENTS_PER_PAGE);
    expect(result.data.nextCursor).toBe(`SET_${SETTLEMENTS_PER_PAGE - 1}`);
  });

  it('offers no next page when exactly a page came back', async () => {
    const rows = Array.from({ length: SETTLEMENTS_PER_PAGE }, (_, i) => row(i));
    const { impl } = answering({ items: rows });
    const result = await withFetch(impl, () => fetchSettlements(SESSION, { view: 'PAID' }));
    if (result.kind !== 'OK') throw new Error('expected OK');
    expect(result.data.nextCursor).toBeNull();
  });

  it('refuses a fractional amount as MALFORMED', async () => {
    const { impl } = answering({ items: [row(1, { netAmountMinor: '12.5' })] });
    const result = await withFetch(impl, () => fetchSettlements(SESSION, { view: 'PAID' }));
    expect(result.kind).toBe('MALFORMED');
  });

  it.each([
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [503, 'UNAVAILABLE'],
  ])('maps a %i to %s', async (status, kind) => {
    const { impl } = answering({ code: 'X', message: 'x' }, status);
    const result = await withFetch(impl, () => fetchSettlements(SESSION, { view: 'PAID' }));
    expect(result.kind).toBe(kind);
  });
});

describe('fetchSettlement', () => {
  it('reads one by id, escaping it', async () => {
    const { impl, urls } = answering(row(1));
    const result = await withFetch(impl, () => fetchSettlement(SESSION, 'a/b'));
    expect(urls[0]).toContain('/v1/settlements/a%2Fb');
    expect(result.kind).toBe('OK');
  });

  it("answers a non-party's settlement exactly as a missing one", async () => {
    const body = { code: 'NOT_FOUND', message: 'Settlement was not found' };
    const theirs = await withFetch(answering(body, 404).impl, () =>
      fetchSettlement(SESSION, 'SET_9'),
    );
    const missing = await withFetch(answering(body, 404).impl, () =>
      fetchSettlement(SESSION, 'SET_X'),
    );
    expect(theirs).toEqual(missing);
    expect(theirs).toEqual({ kind: 'NOT_FOUND' });
  });
});
