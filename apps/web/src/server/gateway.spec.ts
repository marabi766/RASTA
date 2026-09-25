/**
 * @jest-environment node
 *
 * Server code, tested in the environment it runs in. The portal's default is
 * jsdom, which is right for components and wrong here: this file is about
 * `fetch`, `Response` and `node:crypto`, and a browser-shaped environment
 * would be testing a different runtime than the one that serves the request.
 */
import { GatewayOriginError, GatewayRequestError, callGateway, gatewayUrl } from './gateway';

/**
 * ADR-058 § 3 said the browser talks only to the API Gateway, and added that
 * the rule would be closed by a test rather than a sentence in a README.
 *
 * This is that test. It matters because every platform control — JWT
 * verification, tenant resolution, rate limiting, correlation, the circuit
 * breaker — lives in the gateway, and a call that went straight to a service
 * port would run with none of them and would look completely normal while
 * doing it.
 */

const GATEWAY = 'http://gateway.test:3000';

describe('the portal may call the gateway and nothing else', () => {
  it('builds a URL for a gateway path', () => {
    expect(gatewayUrl(GATEWAY, '/v1/users/me')).toBe('http://gateway.test:3000/v1/users/me');
  });

  it('refuses a service port, which is the mistake it exists for', () => {
    // `localhost:3106` is marketplace-service. A page that fetched it directly
    // would work in development and bypass every control in production.
    expect(() => gatewayUrl(GATEWAY, 'http://localhost:3106/v1/orders')).toThrow(
      GatewayOriginError,
    );
  });

  it('refuses another host entirely', () => {
    expect(() => gatewayUrl(GATEWAY, 'https://evil.test/v1/users/me')).toThrow(GatewayOriginError);
    expect(() => gatewayUrl(GATEWAY, '//evil.test/v1/users/me')).toThrow(GatewayOriginError);
  });

  it('refuses the same host on another port', () => {
    // The origin includes the port, and a different port is a different
    // service — which is the whole point.
    expect(() => gatewayUrl(GATEWAY, 'http://gateway.test:3106/v1/orders')).toThrow(
      GatewayOriginError,
    );
  });

  it('keeps a base path when the gateway is mounted under one', () => {
    expect(gatewayUrl('https://api.test/rasta/', 'v1/assets')).toBe(
      'https://api.test/rasta/v1/assets',
    );
    expect(() => gatewayUrl('https://api.test/rasta/', '/elsewhere/v1/assets')).toThrow(
      GatewayOriginError,
    );
  });
});

describe('what goes on the wire', () => {
  function fakeFetch(response: Response) {
    const calls: { url: string; init: RequestInit }[] = [];
    const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return response;
    }) as typeof fetch;
    return { impl, calls };
  }

  it('carries the bearer token and a correlation id, and never caches', () => {
    const { impl, calls } = fakeFetch(
      new Response(JSON.stringify({ id: 'USR_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    return callGateway<{ id: string }>({
      baseUrl: GATEWAY,
      path: '/v1/users/me',
      accessToken: 'token-value',
      fetchImpl: impl,
      correlationId: 'COR_1',
    }).then((result) => {
      expect(result.data).toEqual({ id: 'USR_1' });
      expect(result.correlationId).toBe('COR_1');

      const headers = calls[0]!.init.headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer token-value');
      expect(headers['x-correlation-id']).toBe('COR_1');
      // A tenant's data cached by the framework between two people's requests
      // is the worst bug this file could have.
      expect(calls[0]!.init.cache).toBe('no-store');
    });
  });

  it('mints a correlation id when the caller has none', async () => {
    const { impl } = fakeFetch(new Response('{}', { status: 200 }));
    const result = await callGateway({
      baseUrl: GATEWAY,
      path: '/v1/users/me',
      accessToken: 't',
      fetchImpl: impl,
    });
    expect(result.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reports a refusal by status and correlation id, and reads nothing from the body', async () => {
    // The body can carry a tenant's data and this error is rendered to a
    // person. docs/16 § 16.11 puts the correlation id in the error state
    // precisely so support can find the rest without the page showing it.
    const { impl } = fakeFetch(
      new Response(JSON.stringify({ secret: 'another tenant’s data' }), { status: 503 }),
    );

    await expect(
      callGateway({
        baseUrl: GATEWAY,
        path: '/v1/users/me',
        accessToken: 't',
        fetchImpl: impl,
        correlationId: 'COR_2',
      }),
    ).rejects.toMatchObject({ status: 503, correlationId: 'COR_2' });

    await expect(
      callGateway({
        baseUrl: GATEWAY,
        path: '/v1/users/me',
        accessToken: 't',
        fetchImpl: impl,
      }),
    ).rejects.toBeInstanceOf(GatewayRequestError);
  });

  it('refuses before it fetches when the path is not the gateway', async () => {
    const { impl, calls } = fakeFetch(new Response('{}', { status: 200 }));
    await expect(
      callGateway({
        baseUrl: GATEWAY,
        path: 'https://evil.test/steal',
        accessToken: 'token-value',
        fetchImpl: impl,
      }),
    ).rejects.toBeInstanceOf(GatewayOriginError);
    // The token did not leave the process.
    expect(calls).toHaveLength(0);
  });
});

describe('a transport failure never escapes as a bare throw', () => {
  it('turns a rejected fetch into a safe UNAVAILABLE outcome', async () => {
    const impl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    await expect(
      callGateway({ baseUrl: GATEWAY, path: '/v1/users/me', accessToken: 't', fetchImpl: impl }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('gives up on a call that never answers, rather than hanging on it forever', async () => {
    // A stand-in for what `fetch` actually does when its `signal` fires: it
    // rejects with an `AbortError`, it does not simply never resolve.
    const impl = ((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
      })) as unknown as typeof fetch;

    await expect(
      callGateway({
        baseUrl: GATEWAY,
        path: '/v1/users/me',
        accessToken: 't',
        fetchImpl: impl,
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('treats a malformed body on a 2xx as an outage rather than an unhandled rejection', async () => {
    const impl = (async () =>
      new Response('not json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    await expect(
      callGateway({ baseUrl: GATEWAY, path: '/v1/users/me', accessToken: 't', fetchImpl: impl }),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe('a success with no body', () => {
  /**
   * `POST /v1/memberships/:id/revoke` is `@HttpCode(204)`, and so is every
   * other endpoint whose result is the absence of something. Parsing an empty
   * body as JSON throws, and the throw would arrive *after* the service had
   * already done the work — the write reported as failed, the person retrying
   * something that already happened.
   */
  const noBody = (status: number, headers: Record<string, string> = {}) =>
    (async () => new Response(null, { status, headers })) as unknown as typeof fetch;

  it('reads a 204 as a success carrying nothing', async () => {
    const response = await callGateway({
      baseUrl: GATEWAY,
      path: '/v1/memberships/MBR_1/revoke',
      method: 'POST',
      body: { reason: 'پایان همکاری' },
      accessToken: 'token',
      fetchImpl: noBody(204),
    });

    expect(response.data).toBeUndefined();
    expect(response.correlationId).toEqual(expect.any(String));
  });

  it('reads an explicitly empty 200 the same way', async () => {
    const response = await callGateway({
      baseUrl: GATEWAY,
      path: '/v1/memberships/MBR_1/revoke',
      method: 'POST',
      accessToken: 'token',
      fetchImpl: noBody(200, { 'content-length': '0' }),
    });

    expect(response.data).toBeUndefined();
  });

  it('still parses a body when there is one', async () => {
    const withBody = (async () =>
      new Response(JSON.stringify({ id: 'MBR_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const response = await callGateway<{ id: string }>({
      baseUrl: GATEWAY,
      path: '/v1/memberships/MBR_1/roles',
      method: 'POST',
      accessToken: 'token',
      fetchImpl: withBody,
    });

    expect(response.data).toEqual({ id: 'MBR_1' });
  });
});
