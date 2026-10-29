import { randomBytes } from 'node:crypto';
import { InternalTokenService, runWithContext } from '@rasta/nest-common';
import { ProxyService } from './proxy.service';
import type { ServiceUrls } from '../config/routes';

/**
 * A caller cannot choose the internal token the gateway forwards. Whatever
 * internal-token header arrives from outside — any letter case, a repeated
 * header joined into one value — exactly one leaves, and it is the gateway's
 * own RELAY token for the called service (PR #423 follow-up 1: the sender in
 * nest-common sets it, after the gateway's forwardable headers).
 */

const internalTokens = new InternalTokenService(
  randomBytes(32).toString('hex'),
  'rasta-internal',
  300,
);
const urls = { IDENTITY_SERVICE_URL: 'http://identity.test:3101' } as unknown as ServiceUrls;

async function forwardWith(
  requestHeaders: Record<string, string | string[]>,
): Promise<Record<string, string>> {
  let sent: Record<string, string> = {};
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent = init.headers as Record<string, string>;
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  try {
    await runWithContext(
      {
        correlationId: 'COR_1',
        requestId: 'REQ_1',
        startedAt: Date.now(),
        organizationIds: [],
        roles: [],
        authType: 'ANONYMOUS',
      },
      () =>
        new ProxyService(urls, internalTokens, {
          timeoutMs: 1000,
          failureThreshold: 5,
          resetAfterMs: 1000,
        }).forward({
          service: 'identity',
          method: 'GET',
          path: '/v1/users/me',
          query: '',
          headers: requestHeaders,
          body: undefined,
        }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  return sent;
}

describe('ProxyService — a caller-provided internal token never travels', () => {
  it.each<[string, Record<string, string | string[]>]>([
    ['lower case', { 'x-internal-token': 'FORGED' }],
    ['mixed case', { 'X-Internal-Token': 'FORGED' }],
    ['upper case', { 'X-INTERNAL-TOKEN': 'FORGED' }],
    ['a repeated header', { 'x-internal-token': ['FORGED', 'FORGED-2'] }],
    ['two spellings at once', { 'X-Internal-Token': 'FORGED', 'x-INTERNAL-token': 'FORGED-2' }],
  ])('replaces one sent in %s with the gateway’s own RELAY token', async (_case, headers) => {
    const sent = await forwardWith(headers);

    const internal = Object.entries(sent).filter(
      ([name]) => name.toLowerCase() === 'x-internal-token',
    );
    expect(internal).toHaveLength(1);
    const [[name, token]] = internal as [[string, string]];
    expect(name).toBe('x-internal-token');
    expect(token).not.toContain('FORGED');

    const claims = await internalTokens.verify(token, 'identity-service');
    expect(claims).toMatchObject({ callerService: 'api-gateway', purpose: 'RELAY' });
    expect(claims).not.toHaveProperty('organizationId');
  });

  it('a minted token signed for another tenant, sent by the caller, is replaced too', async () => {
    const stolen = await internalTokens.issue(
      'fleet-service',
      'identity-service',
      'SERVICE',
      'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9YA',
    );
    const sent = await forwardWith({ 'X-Internal-Token': stolen });
    expect(sent['x-internal-token']).not.toBe(stolen);
    await expect(
      internalTokens.verify(sent['x-internal-token'] as string, 'identity-service'),
    ).resolves.toMatchObject({
      purpose: 'RELAY',
    });
  });
});
