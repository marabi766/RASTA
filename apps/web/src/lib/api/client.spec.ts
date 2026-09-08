import { z } from 'zod';
import { ApiClient, type SessionSnapshot } from './client';
import { ApiFailure, CLIENT_ERROR_CODES } from './errors';

/**
 * The request boundary, tested at the boundary.
 *
 * Everything here asserts on what actually left the browser — the URL and the
 * headers `fetch` was called with — rather than on the client's internal state.
 * A guarantee about the wire has to be checked on the wire.
 */

const BASE = 'http://localhost:3000';
const SCHEMA = z.object({ items: z.array(z.object({ id: z.string() })) });

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function makeClient(
  session: SessionSnapshot | null,
  fetchImpl: jest.Mock,
  correlationId = 'cid-fixed',
): ApiClient {
  return new ApiClient({
    baseUrl: BASE,
    session: () => session,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    newCorrelationId: () => correlationId,
  });
}

const SESSION: SessionSnapshot = {
  accessToken: 'token-abc',
  organizationId: 'org_one',
  organizationIds: ['org_one', 'org_two'],
};

describe('every live request goes to the gateway with the right headers', () => {
  it('targets the gateway origin and sends auth, tenant and correlation headers', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ items: [{ id: 'a' }] }));
    const client = makeClient(SESSION, fetchImpl);

    await client.request({ path: '/v1/products', schema: SCHEMA, query: { sort: 'PRICE_ASC' } });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];

    expect(new URL(url).origin).toBe(BASE);
    expect(new URL(url).pathname).toBe('/v1/products');
    expect(new URL(url).searchParams.get('sort')).toBe('PRICE_ASC');

    const headers = init.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer token-abc');
    expect(headers.get('x-organization-id')).toBe('org_one');
    expect(headers.get('x-correlation-id')).toBe('cid-fixed');
    expect(init.credentials).toBe('omit');
  });

  it('never sends a service port, even when a caller asks for an absolute URL', async () => {
    const fetchImpl = jest.fn();
    const client = makeClient(SESSION, fetchImpl);

    await expect(
      client.request({
        // A direct service address — the exact bypass ADR-009 exists to prevent.
        path: 'http://localhost:3106/v1/products' as `/v1/${string}`,
        schema: SCHEMA,
      }),
    ).rejects.toMatchObject({ code: CLIENT_ERROR_CODES.NON_GATEWAY_TARGET });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a path that escapes the version prefix', async () => {
    const fetchImpl = jest.fn();
    const client = makeClient(SESSION, fetchImpl);

    await expect(
      client.request({ path: '/v1/../internal/metrics' as `/v1/${string}`, schema: SCHEMA }),
    ).rejects.toMatchObject({ code: CLIENT_ERROR_CODES.NON_GATEWAY_TARGET });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('omits the tenant header entirely when no organization is selected', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ items: [] }));
    const client = makeClient({ ...SESSION, organizationId: null }, fetchImpl);

    await client.request({ path: '/v1/organizations', schema: SCHEMA });

    const headers = (fetchImpl.mock.calls[0]![1] as RequestInit).headers as Headers;
    expect(headers.has('x-organization-id')).toBe(false);
  });
});

describe('tenant selection is checked before anything is sent', () => {
  it('refuses an organization outside the token membership set without a request', async () => {
    const fetchImpl = jest.fn();
    const client = makeClient({ ...SESSION, organizationId: 'org_someone_else' }, fetchImpl);

    await expect(client.request({ path: '/v1/products', schema: SCHEMA })).rejects.toMatchObject({
      code: CLIENT_ERROR_CODES.TENANT_NOT_IN_MEMBERSHIPS,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('still treats the server as the authority — a 403 TENANT_MISMATCH surfaces as such', async () => {
    // The client-side check is UX only. When the gateway disagrees with a
    // selection this client accepted, the gateway wins.
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(
        {
          code: 'TENANT_MISMATCH',
          message: 'not your tenant',
          correlationId: 'cid-server',
          timestamp: new Date().toISOString(),
        },
        { status: 403 },
      ),
    );
    const client = makeClient(SESSION, fetchImpl);

    await expect(client.request({ path: '/v1/products', schema: SCHEMA })).rejects.toMatchObject({
      code: 'TENANT_MISMATCH',
      status: 403,
      correlationId: 'cid-server',
    });
  });
});

describe('unauthenticated callers', () => {
  it('does not send a request without a session', async () => {
    const fetchImpl = jest.fn();
    const client = makeClient(null, fetchImpl);

    await expect(client.request({ path: '/v1/products', schema: SCHEMA })).rejects.toMatchObject({
      code: CLIENT_ERROR_CODES.NO_SESSION,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('platform error envelope', () => {
  const cases: Array<[number, string]> = [
    [401, 'UNAUTHENTICATED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [422, 'BUSINESS_RULE_VIOLATION'],
    [429, 'RATE_LIMIT_EXCEEDED'],
    [503, 'UPSTREAM_UNAVAILABLE'],
  ];

  it.each(cases)('maps %s to a distinct Persian message', async (status, code) => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(
        {
          code,
          message: 'english upstream text',
          correlationId: 'cid-server',
          timestamp: new Date().toISOString(),
        },
        { status },
      ),
    );

    const client = makeClient(SESSION, fetchImpl);
    const failure = await client
      .request({ path: '/v1/products', schema: SCHEMA })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiFailure);
    const typed = failure as ApiFailure;
    expect(typed.code).toBe(code);
    expect(typed.status).toBe(status);
    // Persian copy, not the upstream string.
    expect(typed.message).not.toContain('english upstream text');
    expect(typed.message).toMatch(/[؀-ۿ]/);
  });

  it('gives distinct copy to the two different 403s', async () => {
    const messageFor = async (code: string): Promise<string> => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { code, message: 'x', correlationId: 'c', timestamp: new Date().toISOString() },
            { status: 403 },
          ),
        );
      const failure = (await makeClient(SESSION, fetchImpl)
        .request({ path: '/v1/products', schema: SCHEMA })
        .catch((error: unknown) => error)) as ApiFailure;
      return failure.message;
    };

    expect(await messageFor('FORBIDDEN')).not.toBe(await messageFor('TENANT_MISMATCH'));
  });

  it('does not let a non-envelope body put its own text on screen', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(new Response('<html>upstream proxy error</html>', { status: 503 }));

    const failure = (await makeClient(SESSION, fetchImpl)
      .request({ path: '/v1/products', schema: SCHEMA })
      .catch((error: unknown) => error)) as ApiFailure;

    expect(failure.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(failure.message).not.toContain('upstream proxy error');
    expect(failure.correlationId).toBe('cid-fixed');
  });

  it('reports a malformed 200 rather than rendering it', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ items: [{ wrong: true }] }));

    const failure = (await makeClient(SESSION, fetchImpl)
      .request({ path: '/v1/products', schema: SCHEMA })
      .catch((error: unknown) => error)) as ApiFailure;

    expect(failure.code).toBe(CLIENT_ERROR_CODES.MALFORMED_RESPONSE);
  });

  it('reports a transport failure without inventing a status', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const failure = (await makeClient(SESSION, fetchImpl)
      .request({ path: '/v1/products', schema: SCHEMA })
      .catch((error: unknown) => error)) as ApiFailure;

    expect(failure.code).toBe(CLIENT_ERROR_CODES.NETWORK_UNAVAILABLE);
    expect(failure.status).toBeNull();
    expect(failure.retryable).toBe(true);
  });

  it('prefers the correlation id the gateway echoed back', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-correlation-id': 'cid-from-gateway' },
      }),
    );

    const result = await makeClient(SESSION, fetchImpl).request({
      path: '/v1/products',
      schema: SCHEMA,
    });

    expect(result.correlationId).toBe('cid-from-gateway');
  });

  it('marks a 403 as not worth retrying and a 429 as worth retrying', async () => {
    const failureFor = async (status: number, code: string): Promise<ApiFailure> => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { code, message: 'x', correlationId: 'c', timestamp: new Date().toISOString() },
            { status },
          ),
        );
      return (await makeClient(SESSION, fetchImpl)
        .request({ path: '/v1/products', schema: SCHEMA })
        .catch((error: unknown) => error)) as ApiFailure;
    };

    expect((await failureFor(403, 'FORBIDDEN')).retryable).toBe(false);
    expect((await failureFor(429, 'RATE_LIMIT_EXCEEDED')).retryable).toBe(true);
  });
});
