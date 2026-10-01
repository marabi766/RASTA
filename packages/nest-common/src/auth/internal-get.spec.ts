import { internalGet, type InternalGetOptions } from './internal-get';

function options(fetchImpl: typeof fetch, timeoutMs = 200): InternalGetOptions {
  return {
    from: 'fleet-service',
    to: 'asset-service',
    baseUrl: 'http://asset.internal/',
    timeoutMs,
    tokens: { issue: jest.fn(async () => 'signed-token') },
    fetch: fetchImpl,
  };
}

describe('internalGet', () => {
  it('sends a service token signed with the organization and returns status and JSON', async () => {
    const fetchImpl = jest.fn(async () => new Response('{"a":1}', { status: 200 }));
    const opts = options(fetchImpl as unknown as typeof fetch);

    const result = await internalGet(opts, '/v1/internal/assets/AST_1/snapshot', 'ORG_A');

    expect(result).toEqual({ status: 200, body: { a: 1 } });
    expect(opts.tokens.issue).toHaveBeenCalledWith(
      'fleet-service',
      'asset-service',
      'SERVICE',
      'ORG_A',
    );
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://asset.internal/v1/internal/assets/AST_1/snapshot');
    expect((init.headers as Record<string, string>)['x-internal-token']).toBe('signed-token');
  });

  it('returns a non-JSON body as undefined and leaves the status to the caller', async () => {
    const opts = options((async () => new Response('<html>', { status: 502 })) as typeof fetch);
    await expect(internalGet(opts, '/x', 'ORG_A')).resolves.toEqual({
      status: 502,
      body: undefined,
    });
  });

  it('maps a transport failure to UPSTREAM_UNAVAILABLE without quoting the cause', async () => {
    const opts = options((async () => {
      throw new Error('connect ECONNREFUSED http://secret-host');
    }) as typeof fetch);
    const error = await internalGet(opts, '/x', 'ORG_A').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(JSON.stringify(error)).not.toContain('secret-host');
  });

  it('maps a missed deadline to UPSTREAM_TIMEOUT', async () => {
    const opts = options(
      ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof fetch,
      20,
    );
    await expect(internalGet(opts, '/x', 'ORG_A')).rejects.toMatchObject({
      code: 'UPSTREAM_TIMEOUT',
    });
  });
});
