import { internalFetch } from './internal-fetch';

describe('internalFetch', () => {
  it.each([301, 302, 303, 307, 308])(
    'rejects %i before parsing, including a redirect without Location',
    async (status) => {
      const response = new Response('redirect-body', { status });
      const text = jest.spyOn(response, 'text');
      const json = jest.spyOn(response, 'json');
      const transport = jest.fn(
        async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => response,
      );
      await expect(
        internalFetch(
          'http://source.test',
          { headers: { 'x-internal-token': 'token' } },
          transport,
        ),
      ).rejects.toThrow('Internal service redirect refused');
      expect(transport).toHaveBeenCalledTimes(1);
      expect(transport.mock.calls[0]).toEqual([
        'http://source.test',
        { headers: { 'x-internal-token': 'token' }, redirect: 'manual' },
      ]);
      expect(text).not.toHaveBeenCalled();
      expect(json).not.toHaveBeenCalled();
      expect(response.bodyUsed).toBe(true);
    },
  );

  it.each([200, 201, 204, 300, 304, 305, 399, 400, 401, 403, 404, 409, 422, 500, 503])(
    'preserves non-redirect %i and the original request',
    async (status) => {
      const response = new Response(null, { status });
      const transport = jest.fn(
        async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => response,
      );
      const init = { method: 'POST', body: '{}', headers: { 'x-internal-token': 'token' } };
      expect(await internalFetch('http://source.test', init, transport)).toBe(response);
      expect(transport.mock.calls[0]).toEqual([
        'http://source.test',
        { ...init, redirect: 'manual' },
      ]);
    },
  );

  it('overrides an untyped attempt to enable redirect following', async () => {
    const transport = jest.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => new Response('{}'),
    );
    await internalFetch('http://source.test', { redirect: 'follow' } as RequestInit, transport);
    expect(transport.mock.calls[0]).toEqual(['http://source.test', { redirect: 'manual' }]);
  });
});

it('rejects a redirect even when stream cancellation never completes', async () => {
  const cancel = jest.fn(() => new Promise<void>(() => undefined));
  const response = { status: 302, body: { cancel } } as unknown as Response;
  await expect(internalFetch('http://source.test', {}, async () => response)).rejects.toThrow(
    'Internal service redirect refused',
  );
  expect(cancel).toHaveBeenCalledTimes(1);
});
