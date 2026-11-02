/**
 * @jest-environment node
 */
import { CredentialRedirectRefusedError, credentialFetch } from './credential-fetch';

/**
 * The transport's own edges; `credential-redirects.spec.ts` proves its callers
 * over real HTTP. The same cases as nest-common's `internal-fetch.spec.ts`.
 */
const answering = (response: Response) =>
  jest.fn<Promise<Response>, Parameters<typeof fetch>>(async () => response);

describe('credentialFetch', () => {
  it.each([301, 302, 303, 307, 308])(
    'refuses %i before parsing, including a redirect without Location',
    async (status) => {
      const response = new Response('redirect-body', { status });
      const text = jest.spyOn(response, 'text');
      const json = jest.spyOn(response, 'json');
      const transport = answering(response);
      const refusal = credentialFetch(
        'http://source.test',
        { headers: { authorization: 'Bearer token' } },
        transport,
      );
      await expect(refusal).rejects.toBeInstanceOf(CredentialRedirectRefusedError);
      await expect(refusal).rejects.toThrow(/^Credential-bearing redirect refused$/);
      expect(transport.mock.calls).toEqual([
        ['http://source.test', { headers: { authorization: 'Bearer token' }, redirect: 'manual' }],
      ]);
      expect(text).not.toHaveBeenCalled();
      expect(json).not.toHaveBeenCalled();
      expect(response.bodyUsed).toBe(true);
    },
  );

  it.each([200, 201, 204, 300, 304, 305, 399, 400, 401, 403, 404, 409, 422, 500, 503])(
    'returns non-redirect %i as it came, the request unchanged',
    async (status) => {
      const response = new Response(null, { status, headers: { location: '/created/1' } });
      const transport = answering(response);
      const init = { method: 'POST', body: '{}', headers: { authorization: 'Bearer token' } };
      expect(await credentialFetch('http://source.test', init, transport)).toBe(response);
      expect(transport.mock.calls).toEqual([
        ['http://source.test', { ...init, redirect: 'manual' }],
      ]);
    },
  );

  it('overrides an untyped attempt to enable redirect following', async () => {
    const transport = answering(new Response('{}'));
    await credentialFetch('http://source.test', { redirect: 'follow' } as RequestInit, transport);
    expect(transport.mock.calls).toEqual([['http://source.test', { redirect: 'manual' }]]);
  });

  it('refuses even when stream cancellation never completes', async () => {
    const cancel = jest.fn(() => new Promise<void>(() => undefined));
    const response = { status: 302, body: { cancel } } as unknown as Response;
    await expect(
      credentialFetch('http://source.test', {}, async () => response),
    ).rejects.toBeInstanceOf(CredentialRedirectRefusedError);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
