import { inspect } from 'node:util';
import { RedirectRefusedError } from './internal-fetch';
import { InternalHttpClient, InternalTokenService } from './internal-http-client';

const SECRET = 'internal-http-client-spec-secret-0123456789';

function transport(response: () => Response = () => new Response('{}')) {
  return jest.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => response());
}

describe('InternalHttpClient', () => {
  it('mints with exactly the arguments the grant names', async () => {
    const issue = jest.fn(async () => 'minted');
    const client = new InternalHttpClient({ issue }, transport());

    await client.authorize({
      from: 'a',
      to: 'b-service',
      purpose: 'SERVICE',
      organizationId: 'ORG',
    });
    await client.authorize({ from: 'a', to: 'b-service', purpose: 'SERVICE' });
    await client.authorize({
      from: 'a',
      to: 'b-service',
      purpose: 'SERVICE',
      organizationId: undefined,
    });
    await client.authorize({ from: 'api-gateway', to: 'b-service', purpose: 'RELAY' });

    expect(issue.mock.calls).toEqual([
      ['a', 'b-service', 'SERVICE', 'ORG'],
      ['a', 'b-service', 'SERVICE'],
      ['a', 'b-service', 'SERVICE', undefined],
      ['api-gateway', 'b-service', 'RELAY'],
    ]);
    // Arity is kept: a platform read passes no fourth argument at all.
    expect((issue.mock.calls as unknown[][])[1]).toHaveLength(3);
  });

  it('mints at authorize, once, and reuses the token for every request it sends', async () => {
    const issue = jest.fn(async () => 'minted-once');
    const fetchImpl = transport();
    const sender = await new InternalHttpClient({ issue }, fetchImpl).authorize({
      from: 'notification-service',
      to: 'identity-service',
      purpose: 'SERVICE',
      organizationId: 'ORG',
    });
    expect(issue).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();

    await sender.send('http://identity.test/v1/users?page=1', { method: 'GET' });
    await sender.send(new URL('http://identity.test/v1/users?page=2'), { method: 'GET' });

    expect(issue).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls).toEqual([
      [
        'http://identity.test/v1/users?page=1',
        { method: 'GET', headers: { 'x-internal-token': 'minted-once' }, redirect: 'manual' },
      ],
      [
        new URL('http://identity.test/v1/users?page=2'),
        { method: 'GET', headers: { 'x-internal-token': 'minted-once' }, redirect: 'manual' },
      ],
    ]);
  });

  it('keeps the method, body, signal and other headers of the request', async () => {
    const fetchImpl = transport();
    const signal = new AbortController().signal;
    const sender = await new InternalHttpClient({ issue: async () => 't' }, fetchImpl).authorize({
      from: 'marketplace-service',
      to: 'economic-service',
      purpose: 'SERVICE',
      organizationId: 'ORG',
    });
    await sender.send('http://economic.test/v1/x', {
      method: 'POST',
      body: '{"amount":"7.50"}',
      signal,
      headers: { 'content-type': 'application/json', 'idempotency-key': 'K-1' },
    });
    expect(fetchImpl.mock.calls[0]).toEqual([
      'http://economic.test/v1/x',
      {
        method: 'POST',
        body: '{"amount":"7.50"}',
        signal,
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'K-1',
          'x-internal-token': 't',
        },
        redirect: 'manual',
      },
    ]);
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBe(signal);
  });

  describe('replaces a caller-provided internal header', () => {
    const grant = { from: 'api-gateway', to: 'x-service', purpose: 'RELAY' } as const;

    it.each(['x-internal-token', 'X-Internal-Token', 'X-INTERNAL-TOKEN', 'x-INTERNAL-token'])(
      'in a record, spelled %s',
      async (name) => {
        const fetchImpl = transport();
        const sender = await new InternalHttpClient(
          { issue: async () => 'real' },
          fetchImpl,
        ).authorize(grant);
        await sender.send('http://x.test', { headers: { accept: '*/*', [name]: 'forged' } });
        const sent = fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>;
        expect(sent).toEqual({ accept: '*/*', 'x-internal-token': 'real' });
        expect(new Headers(sent).get('x-internal-token')).toBe('real');
      },
    );

    it('in a null-prototype record', async () => {
      const fetchImpl = transport();
      const headers = Object.assign(Object.create(null) as Record<string, string>, {
        'X-Internal-Token': 'forged',
      });
      const sender = await new InternalHttpClient(
        { issue: async () => 'real' },
        fetchImpl,
      ).authorize(grant);
      await sender.send('http://x.test', { headers });
      expect(fetchImpl.mock.calls[0]?.[1]?.headers).toEqual({ 'x-internal-token': 'real' });
    });

    it('in an array of pairs', async () => {
      const fetchImpl = transport();
      const sender = await new InternalHttpClient(
        { issue: async () => 'real' },
        fetchImpl,
      ).authorize(grant);
      await sender.send('http://x.test', {
        headers: [
          ['accept', '*/*'],
          ['X-Internal-Token', 'forged'],
          ['x-internal-token', 'forged-again'],
        ],
      });
      const sent = fetchImpl.mock.calls[0]?.[1]?.headers as [string, string][];
      expect(sent).toEqual([
        ['accept', '*/*'],
        ['x-internal-token', 'real'],
      ]);
      expect(new Headers(sent).get('x-internal-token')).toBe('real');
    });

    it('in a Headers instance, without touching the caller’s object', async () => {
      const fetchImpl = transport();
      const original = new Headers({ accept: '*/*', 'X-Internal-Token': 'forged' });
      const sender = await new InternalHttpClient(
        { issue: async () => 'real' },
        fetchImpl,
      ).authorize(grant);
      await sender.send('http://x.test', { headers: original });
      const sent = fetchImpl.mock.calls[0]?.[1]?.headers as Headers;
      expect(sent).toBeInstanceOf(Headers);
      expect(sent.get('x-internal-token')).toBe('real');
      expect(sent.get('accept')).toBe('*/*');
      expect(original.get('x-internal-token')).toBe('forged');
    });

    it('in any other iterable of pairs', async () => {
      const fetchImpl = transport();
      const sender = await new InternalHttpClient(
        { issue: async () => 'real' },
        fetchImpl,
      ).authorize(grant);
      const pairs = new Map([['X-Internal-Token', 'forged']]);
      await sender.send('http://x.test', { headers: pairs as unknown as Headers });
      const sent = fetchImpl.mock.calls[0]?.[1]?.headers as Headers;
      expect(sent.get('x-internal-token')).toBe('real');
    });
  });

  it('refuses a redirect like internalFetch and discloses no token, URL or Location', async () => {
    const fetchImpl = transport(
      () =>
        new Response('redirect-body', {
          status: 302,
          headers: { location: 'http://elsewhere.test/collect' },
        }),
    );
    const sender = await new InternalHttpClient(
      { issue: async () => 'secret-token' },
      fetchImpl,
    ).authorize({ from: 'a', to: 'b-service', purpose: 'SERVICE', organizationId: 'ORG' });
    const refusal = sender.send('http://b.test/v1/private?q=1', { method: 'GET' });
    await expect(refusal).rejects.toBeInstanceOf(RedirectRefusedError);
    const error = (await refusal.then(
      () => undefined,
      (caught: unknown) => caught,
    )) as Error;
    const disclosed = `${error.message} ${error.stack ?? ''} ${inspect(error)}`;
    for (const secret of ['secret-token', 'b.test', 'elsewhere.test', 'redirect-body']) {
      expect(disclosed).not.toContain(secret);
    }
  });

  it('never exposes the token on the sender', async () => {
    const sender = await new InternalHttpClient(
      { issue: async () => 'secret-token' },
      transport(),
    ).authorize({ from: 'a', to: 'b-service', purpose: 'SERVICE' });
    expect(Object.keys(sender)).toEqual(['send']);
    expect(JSON.stringify(sender)).not.toContain('secret-token');
    expect(inspect(sender, { showHidden: true, depth: 5 })).not.toContain('secret-token');
  });

  it('propagates an issuance failure from authorize, before anything is sent', async () => {
    const fetchImpl = transport();
    const client = new InternalHttpClient(
      {
        issue: async () => {
          throw new Error('signing key unavailable');
        },
      },
      fetchImpl,
    );
    await expect(
      client.authorize({ from: 'a', to: 'b-service', purpose: 'SERVICE' }),
    ).rejects.toThrow('signing key unavailable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses the global fetch of the moment a request is sent when none is injected', async () => {
    const original = globalThis.fetch;
    const sender = await new InternalHttpClient({ issue: async () => 't' }).authorize({
      from: 'a',
      to: 'b-service',
      purpose: 'SERVICE',
    });
    const replaced = transport();
    globalThis.fetch = replaced as unknown as typeof fetch;
    try {
      await sender.send('http://b.test', { method: 'GET' });
    } finally {
      globalThis.fetch = original;
    }
    expect(replaced).toHaveBeenCalledTimes(1);
  });

  it('signs a SERVICE token for the tenant and a RELAY token for none, verified for real', async () => {
    const tokens = new InternalTokenService(SECRET, 'rasta-internal', 60);
    const fetchImpl = transport();
    const client = new InternalHttpClient(tokens, fetchImpl);

    await (
      await client.authorize({
        from: 'a-service',
        to: 'b-service',
        purpose: 'SERVICE',
        organizationId: 'ORG_A',
      })
    ).send('http://b.test', {});
    await (
      await client.authorize({ from: 'api-gateway', to: 'b-service', purpose: 'RELAY' })
    ).send('http://b.test', {});

    const sent = fetchImpl.mock.calls.map(
      ([, init]) => (init?.headers as Record<string, string>)['x-internal-token'] as string,
    );
    await expect(tokens.verify(sent[0] as string, 'b-service')).resolves.toMatchObject({
      callerService: 'a-service',
      purpose: 'SERVICE',
      organizationId: 'ORG_A',
    });
    const relay = await tokens.verify(sent[1] as string, 'b-service');
    expect(relay).toMatchObject({ callerService: 'api-gateway', purpose: 'RELAY' });
    expect(relay).not.toHaveProperty('organizationId');
    // Audience-scoped: the same token is refused by any other service.
    await expect(tokens.verify(sent[0] as string, 'c-service')).rejects.toThrow(
      'Token is not valid',
    );
  });
});
