import {
  InternalTokenService,
  RastaError,
  runWithContext,
  createSystemContext,
} from '@rasta/nest-common';
import { ERROR_CODES } from '@rasta/contracts';
import { randomBytes } from 'node:crypto';
import {
  AwardSourceClient,
  CONSTRUCTION_SERVICE,
  MAX_AWARD_BYTES,
  isAwardNotFound,
  readCapped,
} from './award-source.client';

const fact = {
  tenderId: 'TND_1',
  status: 'AWARDED',
  bidId: 'BID_1',
  bidderOrganizationId: 'ORG_WINNER',
  amountMinor: '4500000000',
  matrixDigest: 'a'.repeat(64),
  awardedAt: '2026-10-03T09:30:00.000Z',
  awardedBy: 'USR_1',
};

const json = (status: number, body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

/** Minted per run, never written down (AGENTS.md S-01). */
const secret = randomBytes(24).toString('hex');
const tokens = new InternalTokenService(secret, 'rasta-internal', 300);

function client(fetchImpl: typeof fetch, timeoutMs = 1000, baseUrl = 'http://construction.test/') {
  return new AwardSourceClient({ baseUrl, timeoutMs, tokens, fetch: fetchImpl });
}

const unavailable = (code: string) => expect.objectContaining({ code });

describe('AwardSourceClient', () => {
  it('asks construction-service for the tender’s award, with a token signed for the owner organization', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = jest.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      return json(200, fact);
    });

    const answer = await client(fetchImpl as unknown as typeof fetch).award('ORG_OWNER', 'TND_1');

    expect(answer).toEqual(fact);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('http://construction.test/v1/tenders/TND_1/award');
    const claims = await tokens.verify(seen[0]!.headers['x-internal-token']!, CONSTRUCTION_SERVICE);
    // The organization travels in the signature, never in a header (ADR-035).
    expect(claims).toMatchObject({
      callerService: 'contract-service',
      organizationId: 'ORG_OWNER',
    });
    expect(Object.keys(seen[0]!.headers).map((h) => h.toLowerCase())).not.toContain(
      'x-organization-id',
    );
  });

  it('encodes the tender id in the path', async () => {
    const fetchImpl = jest.fn(async () => json(200, fact));
    await client(fetchImpl as unknown as typeof fetch).award('ORG_OWNER', 'a/b c');
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toContain(
      '/v1/tenders/a%2Fb%20c/award',
    );
  });

  it('forwards the correlation id of the event being handled', async () => {
    const fetchImpl = jest.fn(async (_url: string, _init: RequestInit) => json(200, fact));
    const context = createSystemContext({
      correlationId: 'corr-123',
      organizationId: 'ORG_OWNER',
      callerService: 'contract-service',
    });
    await runWithContext(context, () =>
      client(fetchImpl as unknown as typeof fetch).award('ORG_OWNER', 'TND_1'),
    );
    const headers = fetchImpl.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['x-correlation-id']).toBe('corr-123');
  });

  it('does not forward a correlation id that is not plain identifier characters', async () => {
    const fetchImpl = jest.fn(async (_url: string, _init: RequestInit) => json(200, fact));
    const context = createSystemContext({
      correlationId: 'bad id\r\nx-evil: 1',
      organizationId: 'ORG_OWNER',
      callerService: 'contract-service',
    });
    await runWithContext(context, () =>
      client(fetchImpl as unknown as typeof fetch).award('ORG_OWNER', 'TND_1'),
    );
    const headers = fetchImpl.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['x-correlation-id']).toBeUndefined();
  });

  describe('answers null only when the owner says there is no such award', () => {
    it.each(['Tender not found', 'TenderAward not found'])('404 with %p', async (message) => {
      const fetchImpl = async () => json(404, { code: 'NOT_FOUND', message });
      expect(
        await client(fetchImpl as unknown as typeof fetch).award('ORG_OWNER', 'TND_1'),
      ).toBeNull();
    });

    it.each([
      [
        'a route-level 404 (Nest’s own message)',
        { code: 'NOT_FOUND', message: 'Cannot GET /v1/tenders/x/award' },
      ],
      ['another resource not found', { code: 'NOT_FOUND', message: 'Project not found' }],
      ['a proxy’s HTML 404', 'not json'],
      ['an unrelated body', { error: 'nope' }],
    ])('is unavailable, not absent, for %s', async (_label, body) => {
      const fetchImpl = async () =>
        typeof body === 'string' ? new Response(body, { status: 404 }) : json(404, body);
      await expect(
        client(fetchImpl as unknown as typeof fetch).award('ORG_OWNER', 'TND_1'),
      ).rejects.toMatchObject({ code: ERROR_CODES.UPSTREAM_UNAVAILABLE });
    });
  });

  describe('fails closed: anything else is "could not be asked", never "no"', () => {
    it.each([401, 403, 500, 502, 503])('status %i', async (status) => {
      const fetchImpl = async () => json(status, { code: 'X', message: 'secret internal detail' });
      const error = await client(fetchImpl as unknown as typeof fetch)
        .award('ORG_OWNER', 'TND_1')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RastaError);
      expect(error).toEqual(unavailable(ERROR_CODES.UPSTREAM_UNAVAILABLE));
      // Nothing of the failure reaches an error that ends up in a DLQ header.
      expect(String((error as Error).message)).not.toContain('secret');
      expect(String((error as Error).message)).not.toContain('construction.test');
    });

    it('a transport error, with its cause (which may quote the URL) left off', async () => {
      const fetchImpl = async () => {
        throw new TypeError('fetch failed: http://construction.test/v1/tenders/TND_1/award');
      };
      const error = (await client(fetchImpl as unknown as typeof fetch)
        .award('ORG_OWNER', 'TND_1')
        .catch((e: unknown) => e)) as RastaError;
      expect(error.code).toBe(ERROR_CODES.UPSTREAM_UNAVAILABLE);
      expect(error.cause).toBeUndefined();
    });

    it('an answer that is not JSON', async () => {
      const fetchImpl = async () => new Response('<html>', { status: 200 });
      await expect(
        client(fetchImpl as unknown as typeof fetch).award('ORG_OWNER', 'TND_1'),
      ).rejects.toMatchObject({ code: ERROR_CODES.UPSTREAM_UNAVAILABLE });
    });

    it.each([
      ['an amount that is a number', { ...fact, amountMinor: 4500000000 }],
      ['no amount', { ...fact, amountMinor: undefined }],
      ['a digest that is not hex', { ...fact, matrixDigest: 'zz' }],
      ['an empty object', {}],
    ])('an answer with %s', async (_label, body) => {
      const fetchImpl = async () => json(200, body);
      await expect(
        client(fetchImpl as unknown as typeof fetch).award('ORG_OWNER', 'TND_1'),
      ).rejects.toMatchObject({ code: ERROR_CODES.UPSTREAM_UNAVAILABLE });
    });

    it('an answer larger than any award can be, declared or not', async () => {
      const big = 'x'.repeat(MAX_AWARD_BYTES + 1);
      await expect(
        client((async () => new Response(big, { status: 200 })) as unknown as typeof fetch).award(
          'ORG_OWNER',
          'TND_1',
        ),
      ).rejects.toMatchObject({ code: ERROR_CODES.UPSTREAM_UNAVAILABLE });
      await expect(
        client(
          (async () =>
            new Response('{}', {
              status: 200,
              headers: { 'content-length': String(MAX_AWARD_BYTES + 1) },
            })) as unknown as typeof fetch,
        ).award('ORG_OWNER', 'TND_1'),
      ).rejects.toMatchObject({ code: ERROR_CODES.UPSTREAM_UNAVAILABLE });
    });

    it('no answer in time is a timeout, not an absence', async () => {
      const fetchImpl = (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      await expect(
        client(fetchImpl as unknown as typeof fetch, 20).award('ORG_OWNER', 'TND_1'),
      ).rejects.toMatchObject({ code: ERROR_CODES.UPSTREAM_TIMEOUT });
    });
  });
});

describe('readCapped', () => {
  it('reads a body within the limit', async () => {
    expect(await readCapped(new Response('hello'), 10)).toBe('hello');
  });

  it('reads an empty body as empty text', async () => {
    expect(await readCapped(new Response(null), 10)).toBe('');
  });

  it('stops, and answers null, once the body passes the limit', async () => {
    expect(await readCapped(new Response('0123456789ABC'), 10)).toBeNull();
  });
});

describe('isAwardNotFound', () => {
  it('recognises only the platform’s own not-found body about a tender or an award', () => {
    expect(isAwardNotFound({ code: 'NOT_FOUND', message: 'Tender not found' })).toBe(true);
    expect(isAwardNotFound({ code: 'NOT_FOUND', message: 'TenderAward not found' })).toBe(true);
    expect(isAwardNotFound({ code: 'NOT_FOUND', message: 'Bid not found' })).toBe(false);
    expect(isAwardNotFound({ code: 'FORBIDDEN', message: 'Tender not found' })).toBe(false);
    expect(isAwardNotFound(null)).toBe(false);
  });
});
