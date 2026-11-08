/**
 * @jest-environment node
 *
 * Server code, tested in the environment it runs in. The portal's default is
 * jsdom, which is right for components and wrong here: this file is about
 * `fetch`, `Response` and `node:crypto`, and a browser-shaped environment
 * would be testing a different runtime than the one that serves the request.
 */
import {
  GatewayOriginError,
  GatewayOutcomeUnknownError,
  GatewayRequestError,
  callGateway,
  callGatewayWrite,
  type GatewayCall,
  gatewayUrl,
  GatewayNeverSentError,
  neverSent,
  parseRetryAfter,
} from './gateway';
import { tenantCredential } from './session-organization';
import { actingAccessToken } from '@/test/session-token';

const ORG = 'ORG-DEH-0001';
const TOKEN = actingAccessToken(ORG);
const CREDENTIAL = tenantCredential({ accessToken: TOKEN, organizationId: ORG });

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
      credential: CREDENTIAL,
      fetchImpl: impl,
      correlationId: 'COR_1',
    }).then((result) => {
      expect(result.data).toEqual({ id: 'USR_1' });
      expect(result.correlationId).toBe('COR_1');

      const headers = calls[0]!.init.headers as Record<string, string>;
      expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
      // Every call names the organization the session is pinned to (audit F2).
      expect(headers['x-organization-id']).toBe(ORG);
      expect(headers['x-correlation-id']).toBe('COR_1');
      // A tenant's data cached by the framework between two people's requests
      // is the worst bug this file could have.
      expect(calls[0]!.init.cache).toBe('no-store');
    });
  });

  it('sends the replay deadline beside the key, as one canonical integer (D-065)', async () => {
    const { impl, calls } = fakeFetch(new Response('{}', { status: 201 }));
    await callGatewayWrite({
      baseUrl: GATEWAY,
      path: '/v1/projects',
      method: 'POST',
      body: {},
      credential: CREDENTIAL,
      idempotencyKey: 'key-0001',
      replayDeadline: 1_900_000_000_123,
      fetchImpl: impl,
    });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('key-0001');
    expect(headers['idempotency-replay-deadline']).toBe('1900000000123');
  });

  it('sends no deadline header unless one is given', async () => {
    const { impl, calls } = fakeFetch(new Response('{}', { status: 201 }));
    await callGatewayWrite({
      baseUrl: GATEWAY,
      path: '/v1/projects',
      method: 'POST',
      body: {},
      credential: CREDENTIAL,
      idempotencyKey: 'key-0001',
      fetchImpl: impl,
    });
    expect(calls[0]!.init.headers as Record<string, string>).not.toHaveProperty(
      'idempotency-replay-deadline',
    );
  });

  it.each([
    ['without a key', undefined, 1_900_000_000_123],
    ['zero', 'k', 0],
    ['negative', 'k', -5],
    ['fractional', 'k', 1.5],
    ['unsafe', 'k', 2 ** 53],
    ['not a number', 'k', Number.NaN],
  ])('refuses before fetching a deadline that is %s', async (_n, key, deadline) => {
    const { impl, calls } = fakeFetch(new Response('{}', { status: 201 }));
    await expect(
      callGatewayWrite({
        baseUrl: GATEWAY,
        path: '/v1/projects',
        method: 'POST',
        body: {},
        credential: CREDENTIAL,
        idempotencyKey: key,
        replayDeadline: deadline,
        fetchImpl: impl,
      }),
    ).rejects.toThrow(/replay deadline/);
    expect(calls).toHaveLength(0);
  });

  it('mints a correlation id when the caller has none', async () => {
    const { impl } = fakeFetch(new Response('{}', { status: 200 }));
    const result = await callGateway({
      baseUrl: GATEWAY,
      path: '/v1/users/me',
      credential: CREDENTIAL,
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
        credential: CREDENTIAL,
        fetchImpl: impl,
        correlationId: 'COR_2',
      }),
    ).rejects.toMatchObject({ status: 503, correlationId: 'COR_2' });

    await expect(
      callGateway({
        baseUrl: GATEWAY,
        path: '/v1/users/me',
        credential: CREDENTIAL,
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
        credential: CREDENTIAL,
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
      callGateway({
        baseUrl: GATEWAY,
        path: '/v1/users/me',
        credential: CREDENTIAL,
        fetchImpl: impl,
      }),
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
        credential: CREDENTIAL,
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
      callGateway({
        baseUrl: GATEWAY,
        path: '/v1/users/me',
        credential: CREDENTIAL,
        fetchImpl: impl,
      }),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe('a read keeps today’s outcome; a write learns the outcome is unknown (Codex #106)', () => {
  const rejecting = (error: unknown) =>
    (async () => {
      throw error;
    }) as unknown as typeof fetch;

  it('marks a failure after dispatch as outcome-unknown, still a 503 GatewayRequestError', async () => {
    const error = await callGateway({
      baseUrl: GATEWAY,
      path: '/v1/drivers',
      credential: CREDENTIAL,
      fetchImpl: rejecting(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GatewayRequestError);
    expect(error).toBeInstanceOf(GatewayOutcomeUnknownError);
    expect(error).toMatchObject({ status: 503, reason: 'TRANSPORT' });
  });

  it('marks an unreadable 2xx as outcome-unknown, still a 502 GatewayRequestError', async () => {
    const error = await callGateway({
      baseUrl: GATEWAY,
      path: '/v1/drivers',
      credential: CREDENTIAL,
      fetchImpl: (async () =>
        new Response('not json', {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GatewayOutcomeUnknownError);
    expect(error).toMatchObject({ status: 502, reason: 'UNREADABLE_BODY' });
  });

  it('keeps a failure before anything was sent a plain 503', async () => {
    const error = await callGateway({
      baseUrl: GATEWAY,
      path: '/v1/drivers',
      credential: CREDENTIAL,
      fetchImpl: rejecting(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GatewayRequestError);
    expect(error).not.toBeInstanceOf(GatewayOutcomeUnknownError);
    expect(error).toBeInstanceOf(GatewayNeverSentError);
    expect(error).toMatchObject({ status: 503 });
  });

  it('finds a never-sent code however deep undici nests it', () => {
    expect(neverSent({ cause: { cause: { code: 'EAI_AGAIN' } } })).toBe(true);
    expect(neverSent({ cause: { code: 'ECONNRESET' } })).toBe(false);
    expect(neverSent(new DOMException('aborted', 'TimeoutError'))).toBe(false);
    expect(neverSent(undefined)).toBe(false);
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
    const response = await callGatewayWrite({
      baseUrl: GATEWAY,
      path: '/v1/memberships/MBR_1/revoke',
      method: 'POST',
      body: { reason: 'پایان همکاری' },
      credential: CREDENTIAL,
      fetchImpl: noBody(204),
    });

    expect(response.data).toBeUndefined();
    expect(response.correlationId).toEqual(expect.any(String));
  });

  it('takes no success heard after the deadline: a late 204 is an unknown outcome (PR #722 r2 F2)', async () => {
    let now = 1_000;
    const clock = jest.spyOn(performance, 'now').mockImplementation(() => now);
    const late = (async () => {
      now += 60_000;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    try {
      const error = await callGateway({
        baseUrl: GATEWAY,
        path: '/v1/memberships/MBR_1/revoke',
        method: 'POST',
        credential: CREDENTIAL,
        timeoutMs: 100,
        fetchImpl: late,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GatewayOutcomeUnknownError);
      expect(error).toMatchObject({ reason: 'TRANSPORT' });
    } finally {
      clock.mockRestore();
    }
  });

  it('takes no success whose parsing crossed the deadline (PR #722 r2 F2)', async () => {
    let now = 1_000;
    const clock = jest.spyOn(performance, 'now').mockImplementation(() => now);
    const nativeParse = JSON.parse.bind(JSON);
    const crossing = jest.spyOn(JSON, 'parse').mockImplementation(((text: string) => {
      now += 60_000;
      return nativeParse(text) as unknown;
    }) as typeof JSON.parse);
    try {
      const error = await callGateway({
        baseUrl: GATEWAY,
        path: '/v1/assets',
        credential: CREDENTIAL,
        timeoutMs: 100,
        fetchImpl: (async () =>
          new Response('{"id":"A"}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })) as unknown as typeof fetch,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GatewayOutcomeUnknownError);
    } finally {
      crossing.mockRestore();
      clock.mockRestore();
    }
  });

  it('reads an explicitly empty 200 the same way', async () => {
    const response = await callGatewayWrite({
      baseUrl: GATEWAY,
      path: '/v1/memberships/MBR_1/revoke',
      method: 'POST',
      credential: CREDENTIAL,
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

    const response = await callGatewayWrite<{ id: string }>({
      baseUrl: GATEWAY,
      path: '/v1/memberships/MBR_1/roles',
      method: 'POST',
      credential: CREDENTIAL,
      fetchImpl: withBody,
    });

    expect(response.data).toEqual({ id: 'MBR_1' });
  });
});

describe('Retry-After (round 1 on PR 171)', () => {
  it('reads delay-seconds, the only form the platform sends', () => {
    expect(parseRetryAfter('1')).toBe(1);
    expect(parseRetryAfter(' 30 ')).toBe(30);
  });

  it('is null when absent, a date, or anything else', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT')).toBeNull();
    expect(parseRetryAfter('-1')).toBeNull();
    expect(parseRetryAfter('1.5')).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
  });
});

describe('FU-219 gateway runtime boundary', () => {
  /** The read entry, typed to accept what these tests hand it on purpose. */
  const readEntry = callGateway as typeof callGatewayWrite;
  const request = (fetchImpl: typeof fetch): GatewayCall => ({
    baseUrl: GATEWAY,
    path: '/v1/x',
    credential: CREDENTIAL,
    fetchImpl,
  });
  it.each([
    'baseUrl',
    'path',
    'credential',
    'correlationId',
    'method',
    'body',
    'idempotencyKey',
    'replayDeadline',
    'fetchImpl',
    'timeoutMs',
  ])('refuses an accessor on %s without invoking it', async (key) => {
    const transport = jest.fn();
    const call = request(transport);
    const getter = jest.fn(() => {
      Object.assign(call, { method: 'POST' });
      return undefined;
    });
    Object.defineProperty(call, key, { get: getter });
    for (const send of [readEntry, callGatewayWrite])
      await expect(send(call)).rejects.toThrow(/own data properties/);
    expect(getter).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([
    ['method POST', { method: 'POST' }, /read sends only GET/],
    ['method PUT', { method: 'PUT' }, /read sends only GET/],
    ['method PATCH', { method: 'PATCH' }, /read sends only GET/],
    ['method DELETE', { method: 'DELETE' }, /read sends only GET/],
    ['method get', { method: 'get' }, /read sends only GET/],
    ['method " GET"', { method: ' GET' }, /read sends only GET/],
    ['a String object GET', { method: new String('GET') }, /read sends only GET/],
    ['a body, even undefined', { body: undefined }, /read refuses write properties/],
    ['an idempotency key, even undefined', { idempotencyKey: undefined }, /read refuses write/],
    ['a replay deadline, even undefined', { replayDeadline: undefined }, /read refuses write/],
  ])('refuses %s at the read entry', async (_label, properties, refusal) => {
    const transport = jest.fn();
    await expect(
      readEntry({ ...request(transport), ...properties } as GatewayCall),
    ).rejects.toThrow(refusal);
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([undefined, 'GET', 'HEAD', 'post'])(
    'refuses a write entry call whose method is %s',
    async (method) => {
      const transport = jest.fn();
      const call = method === undefined ? request(transport) : { ...request(transport), method };
      await expect(callGatewayWrite(call as GatewayCall)).rejects.toThrow(
        /write needs a write method/,
      );
      expect(transport).not.toHaveBeenCalled();
    },
  );
  it('uses only captured own data, including non-enumerable fields', async () => {
    const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
      async () => new Response('{}'),
    );
    const call = request(transport);
    Object.setPrototypeOf(call, { method: 'POST', body: 'inherited' });
    await readEntry(call);
    expect(transport.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', body: undefined });
    Object.defineProperty(call, 'method', { value: 'POST' });
    await expect(readEntry(call)).rejects.toThrow(/read sends only GET/);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('captures a proxy descriptor snapshot once and keeps its method through body serialization', async () => {
    const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
      async () => new Response('{}'),
    );
    const call = { ...request(transport), method: 'POST' as const, body: {} };
    call.body = {
      toJSON: () => {
        Object.assign(call, { method: 'DELETE' });
        return {};
      },
    };
    const descriptors = jest.fn(Reflect.getOwnPropertyDescriptor);
    const proxy = new Proxy(call, {
      getOwnPropertyDescriptor: descriptors,
      get() {
        throw new Error('must not read caller values');
      },
    });
    await callGatewayWrite(proxy);
    expect(transport.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
    expect(descriptors).toHaveBeenCalledTimes(Reflect.ownKeys(call).length);
  });
  it.each([
    ['correlationId', 'string'],
    ['idempotencyKey', 'string'],
    ['replayDeadline', 'number'],
    ['timeoutMs', 'number'],
    ['fetchImpl', 'function'],
  ])('refuses a %s that is not a %s, running none of its code', async (key, type) => {
    const transport = jest.fn();
    const toString = jest.fn(() => 'k');
    const value = { toString, valueOf: toString };
    const call = { ...request(transport), method: 'POST', [key]: value } as GatewayCall;
    await expect(callGatewayWrite(call)).rejects.toThrow(`${key} must be a ${type}`);
    expect(toString).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
  it('refuses missing own required fields and unknown properties', async () => {
    const transport = jest.fn();
    for (const call of [
      Object.create(request(transport)),
      { ...request(transport), surprise: true },
      { ...request(transport), [Symbol('method')]: 'POST' },
    ])
      await expect(readEntry(call)).rejects.toThrow(/own data|unclassified/);
    expect(transport).not.toHaveBeenCalled();
  });

  /** Runs `work` with `properties` on Object.prototype, removed before any assertion. */
  async function polluted<R>(properties: Record<string, unknown>, work: () => Promise<R>) {
    for (const [key, value] of Object.entries(properties))
      Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true });
    try {
      return await work().then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    } finally {
      for (const key of Object.keys(properties)) delete (Object.prototype as never)[key];
    }
  }
  const INHERITED = {
    method: 'POST',
    body: 'inherited',
    idempotencyKey: 'inherited-key',
    replayDeadline: 1,
    timeoutMs: 1,
  };

  it('reads a plain read literal as GET when Object.prototype carries write fields (PR-949 r1 F2)', async () => {
    const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
      async () => new Response('{}'),
    );
    const inheritedFetch = jest.fn();
    const outcome = await polluted({ ...INHERITED, fetchImpl: inheritedFetch }, () =>
      callGateway({
        baseUrl: GATEWAY,
        path: '/v1/x',
        credential: CREDENTIAL,
        fetchImpl: transport,
      }),
    );
    expect(outcome).toEqual({ value: expect.anything() });
    expect(inheritedFetch).not.toHaveBeenCalled();
    const init = transport.mock.calls[0]![1]!;
    expect(init.method).toBe('GET');
    expect(Object.hasOwn(init, 'body') && init.body).toBe(undefined);
    expect(Object.keys(init.headers as object).sort()).toEqual(
      ['accept', 'authorization', 'x-correlation-id', 'x-organization-id'].sort(),
    );
  });

  it('never takes an inherited fetchImpl: the call goes to the default transport', async () => {
    const global = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('{}'));
    const inheritedFetch = jest.fn();
    try {
      await polluted({ fetchImpl: inheritedFetch }, () =>
        callGateway({ baseUrl: GATEWAY, path: '/v1/x', credential: CREDENTIAL }),
      );
      expect(inheritedFetch).not.toHaveBeenCalled();
      expect(global).toHaveBeenCalledTimes(1);
      expect(global.mock.calls[0]![1]!.method).toBe('GET');
    } finally {
      global.mockRestore();
    }
  });

  it('a write takes neither its method nor its key from Object.prototype', async () => {
    const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
      async () => new Response('{}'),
    );
    const base = { baseUrl: GATEWAY, path: '/v1/x', credential: CREDENTIAL, fetchImpl: transport };
    const refused = await polluted({ method: 'DELETE' }, () => callGatewayWrite(base));
    expect(refused).toEqual({
      error: expect.objectContaining({
        message: expect.stringMatching(/write needs a write method/),
      }),
    });
    expect(transport).not.toHaveBeenCalled();
    await polluted({ ...INHERITED, method: 'DELETE' }, () =>
      callGatewayWrite({ ...base, method: 'PUT' }),
    );
    const init = transport.mock.calls[0]![1]!;
    expect(init.method).toBe('PUT');
    expect(Object.hasOwn(init, 'body') && init.body).toBe(undefined);
    expect(Object.keys(init.headers as object)).not.toContain('idempotency-key');
    expect(Object.keys(init.headers as object)).not.toContain('idempotency-replay-deadline');
  });
});
