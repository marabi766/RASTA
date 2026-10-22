import {
  InternalTokenService,
  RastaError,
  createSystemContext,
  runWithContext,
} from '@rasta/nest-common';
import { ERROR_CODES } from '@rasta/contracts';
import { randomBytes } from 'node:crypto';
import {
  ECONOMIC_SERVICE,
  MAX_OBLIGATION_BYTES,
  ObligationSourceClient,
  isObligationNotFound,
} from './obligation-source.client';

/** economic-service's answer (#340's `StatementObligationView`) for a statement settled in full. */
const fact = {
  obligationId: 'TXN_1',
  statementId: 'STM_1',
  status: 'SETTLED',
  amountMinor: '9223372036854775807',
  currency: 'IRR',
  payerOrganizationId: 'ORG_OWNER',
  beneficiaryOrganizationId: 'ORG_WINNER',
  settlementId: 'STL_1',
  settledAt: '2026-10-17T10:00:00.000Z',
  settledAmountMinor: '9223372036854775807',
  fullySettled: true,
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

function client(fetchImpl: typeof fetch, timeoutMs = 1000, baseUrl = 'http://economic.test/') {
  return new ObligationSourceClient({ baseUrl, timeoutMs, tokens, fetch: fetchImpl });
}

describe('ObligationSourceClient', () => {
  it('asks economic-service for the statement’s obligation, with a token signed for the employer and no Authorization', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = jest.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      return json(200, fact);
    });

    const answer = await client(fetchImpl as unknown as typeof fetch).obligation(
      'ORG_OWNER',
      'STM_1',
    );

    expect(answer).toEqual(fact);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(
      'http://economic.test/v1/internal/obligations/by-source/STATEMENT/STM_1',
    );
    const claims = await tokens.verify(seen[0]!.headers['x-internal-token']!, ECONOMIC_SERVICE);
    // The organization travels in the signature, never in a header (ADR-035).
    expect(claims).toMatchObject({
      callerService: 'contract-service',
      organizationId: 'ORG_OWNER',
    });
    const names = Object.keys(seen[0]!.headers).map((h) => h.toLowerCase());
    expect(names).not.toContain('x-organization-id');
    // economic's AuthGuard takes the internal path only without Authorization (#340).
    expect(names).not.toContain('authorization');
  });

  it('keeps the amounts as the exact decimal strings economic sent', async () => {
    const answer = await client((async () =>
      json(200, fact)) as unknown as typeof fetch).obligation('ORG_OWNER', 'STM_1');
    expect(answer?.amountMinor).toBe('9223372036854775807');
    expect(answer?.settledAmountMinor).toBe('9223372036854775807');
  });

  it('reads an unsettled obligation as such: nulls where nothing settled it', async () => {
    const pending = {
      ...fact,
      status: 'PENDING_SETTLEMENT',
      settlementId: null,
      settledAt: null,
      settledAmountMinor: null,
      fullySettled: false,
    };
    const answer = await client((async () =>
      json(200, pending)) as unknown as typeof fetch).obligation('ORG_OWNER', 'STM_1');
    expect(answer).toEqual(pending);
  });

  it('encodes the statement id in the path', async () => {
    const fetchImpl = jest.fn(async () => json(200, fact));
    await client(fetchImpl as unknown as typeof fetch).obligation('ORG_OWNER', 'a/b c');
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toContain(
      '/by-source/STATEMENT/a%2Fb%20c',
    );
  });

  it('forwards the correlation id of the event being handled, and only a plain one', async () => {
    const run = async (correlationId: string) => {
      const fetchImpl = jest.fn(async (_url: string, _init: RequestInit) => json(200, fact));
      await runWithContext(
        createSystemContext({
          correlationId,
          organizationId: 'ORG_OWNER',
          callerService: 'contract-service',
        }),
        () => client(fetchImpl as unknown as typeof fetch).obligation('ORG_OWNER', 'STM_1'),
      );
      return (fetchImpl.mock.calls[0]![1].headers as Record<string, string>)['x-correlation-id'];
    };
    expect(await run('corr-123')).toBe('corr-123');
    expect(await run('bad id\r\nx-evil: 1')).toBeUndefined();
  });

  describe('answers null only when economic says there is no such obligation', () => {
    it('404 with economic’s own "Obligation not found"', async () => {
      const fetchImpl = async () =>
        json(404, { code: 'NOT_FOUND', message: 'Obligation not found' });
      expect(
        await client(fetchImpl as unknown as typeof fetch).obligation('ORG_OWNER', 'STM_1'),
      ).toBeNull();
    });

    it.each([
      [
        'a route-level 404 (Nest’s own message)',
        { code: 'NOT_FOUND', message: 'Cannot GET /v1/internal/obligations/by-source/STATEMENT/x' },
      ],
      ['another resource not found', { code: 'NOT_FOUND', message: 'Transaction not found' }],
      ['a proxy’s HTML 404', 'not json'],
      ['an unrelated body', { error: 'nope' }],
    ])('is unavailable, not absent, for %s', async (_label, body) => {
      const fetchImpl = async () =>
        typeof body === 'string' ? new Response(body, { status: 404 }) : json(404, body);
      await expect(
        client(fetchImpl as unknown as typeof fetch).obligation('ORG_OWNER', 'STM_1'),
      ).rejects.toMatchObject({ code: ERROR_CODES.UPSTREAM_UNAVAILABLE });
    });
  });

  describe('fails closed: anything else is "could not be asked", never "paid" and never "not paid"', () => {
    it.each([401, 403, 500, 502, 503])('status %i', async (status) => {
      const fetchImpl = async () => json(status, { code: 'X', message: 'secret internal detail' });
      const error = await client(fetchImpl as unknown as typeof fetch)
        .obligation('ORG_OWNER', 'STM_1')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RastaError);
      expect(error).toMatchObject({ code: ERROR_CODES.UPSTREAM_UNAVAILABLE });
      // Nothing of the failure reaches an error that ends up in a DLQ header.
      expect(String((error as Error).message)).not.toContain('secret');
      expect(String((error as Error).message)).not.toContain('economic.test');
    });

    it('a transport error, with its cause (which may quote the URL) left off', async () => {
      const fetchImpl = async () => {
        throw new TypeError('fetch failed: http://economic.test/v1/internal/obligations');
      };
      const error = (await client(fetchImpl as unknown as typeof fetch)
        .obligation('ORG_OWNER', 'STM_1')
        .catch((e: unknown) => e)) as RastaError;
      expect(error.code).toBe(ERROR_CODES.UPSTREAM_UNAVAILABLE);
      expect(error.cause).toBeUndefined();
    });

    it('an answer that is not JSON', async () => {
      const fetchImpl = async () => new Response('<html>', { status: 200 });
      await expect(
        client(fetchImpl as unknown as typeof fetch).obligation('ORG_OWNER', 'STM_1'),
      ).rejects.toMatchObject({ code: ERROR_CODES.UPSTREAM_UNAVAILABLE });
    });

    it.each([
      ['an amount that is a number', { ...fact, amountMinor: 1 }],
      ['an amount with a sign', { ...fact, amountMinor: '-1' }],
      ['no fullySettled', { ...fact, fullySettled: undefined }],
      ['fullySettled as text', { ...fact, fullySettled: 'true' }],
      ['no obligation id', { ...fact, obligationId: undefined }],
      ['a settledAt that is no instant', { ...fact, settledAt: 'yesterday' }],
      ['an empty object', {}],
    ])('an answer with %s', async (_label, body) => {
      const fetchImpl = async () => json(200, body);
      await expect(
        client(fetchImpl as unknown as typeof fetch).obligation('ORG_OWNER', 'STM_1'),
      ).rejects.toMatchObject({ code: ERROR_CODES.UPSTREAM_UNAVAILABLE });
    });

    it('an answer larger than any obligation view can be, declared or not', async () => {
      const big = 'x'.repeat(MAX_OBLIGATION_BYTES + 1);
      await expect(
        client(
          (async () => new Response(big, { status: 200 })) as unknown as typeof fetch,
        ).obligation('ORG_OWNER', 'STM_1'),
      ).rejects.toMatchObject({ code: ERROR_CODES.UPSTREAM_UNAVAILABLE });
      await expect(
        client(
          (async () =>
            new Response('{}', {
              status: 200,
              headers: { 'content-length': String(MAX_OBLIGATION_BYTES + 1) },
            })) as unknown as typeof fetch,
        ).obligation('ORG_OWNER', 'STM_1'),
      ).rejects.toMatchObject({ code: ERROR_CODES.UPSTREAM_UNAVAILABLE });
    });

    it('no answer in time is a timeout, not an absence', async () => {
      const fetchImpl = (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      await expect(
        client(fetchImpl as unknown as typeof fetch, 20).obligation('ORG_OWNER', 'STM_1'),
      ).rejects.toMatchObject({ code: ERROR_CODES.UPSTREAM_TIMEOUT });
    });
  });
});

describe('isObligationNotFound', () => {
  it('recognises only economic’s own not-found body about an obligation', () => {
    expect(isObligationNotFound({ code: 'NOT_FOUND', message: 'Obligation not found' })).toBe(true);
    expect(isObligationNotFound({ code: 'NOT_FOUND', message: 'Statement not found' })).toBe(false);
    expect(isObligationNotFound({ code: 'FORBIDDEN', message: 'Obligation not found' })).toBe(
      false,
    );
    expect(isObligationNotFound(null)).toBe(false);
  });
});
