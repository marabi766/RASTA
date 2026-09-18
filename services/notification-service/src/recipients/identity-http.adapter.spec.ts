import { InternalTokenService } from '@rasta/nest-common';
import { IdentityHttpRecipientAdapter } from './identity-http.adapter';
import { RecipientResolutionError } from './recipient.port';

const SECRET = 'notification_unit_test_secret_at_least_32_chars';
const tokens = new InternalTokenService(SECRET, 'rasta-internal', 300);

interface Captured {
  url: URL;
  headers: Record<string, string>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(respond: (url: URL, call: number) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    return respond(url, calls.length);
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const user = (id: string, roles: string[], status = 'ACTIVE') => ({
  id,
  username: `u-${id}`,
  email: `${id.toLowerCase()}@example.test`,
  firstName: 'First',
  lastName: 'Last',
  phone: '+98000',
  status,
  activeOrganizationId: 'ORG_A',
  roles,
});

const query = {
  organizationId: 'ORG_A',
  roles: ['FLEET_MANAGER', 'ORGANIZATION_ADMIN'],
  limit: 500,
  correlationId: 'COR_1',
};

describe('IdentityHttpRecipientAdapter', () => {
  it('calls GET /v1/users per role with a SERVICE token minted for identity and the organization', async () => {
    const { fetch, calls } = fakeFetch((url) =>
      jsonResponse({
        items:
          url.searchParams.get('role') === 'FLEET_MANAGER'
            ? [user('USR_1', ['FLEET_MANAGER'])]
            : [],
        nextCursor: null,
        hasMore: false,
      }),
    );
    const adapter = new IdentityHttpRecipientAdapter(
      { baseUrl: 'http://identity.test:3101', timeoutMs: 1000 },
      tokens,
      fetch,
    );

    const result = await adapter.resolve(query);

    expect(result).toEqual({
      recipients: [{ userId: 'USR_1', role: 'FLEET_MANAGER' }],
      truncated: false,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url.pathname).toBe('/v1/users');
    expect(calls[0]!.url.searchParams.get('role')).toBe('FLEET_MANAGER');
    expect(calls[0]!.url.searchParams.get('status')).toBe('ACTIVE');
    expect(calls[0]!.url.searchParams.get('limit')).toBe('200');
    expect(calls[1]!.url.searchParams.get('role')).toBe('ORGANIZATION_ADMIN');
    expect(calls[0]!.headers['x-correlation-id']).toBe('COR_1');
    // No unsigned tenant header; the tenant is inside the signed token.
    expect(calls[0]!.headers['x-organization-id']).toBeUndefined();
    expect(calls[0]!.headers['authorization']).toBeUndefined();

    const claims = await tokens.verify(calls[0]!.headers['x-internal-token']!, 'identity-service');
    expect(claims.callerService).toBe('notification-service');
    expect(claims.purpose).toBe('SERVICE');
    expect(claims.organizationId).toBe('ORG_A');
    // Not replayable against another service.
    await expect(
      tokens.verify(calls[0]!.headers['x-internal-token']!, 'economic-service'),
    ).rejects.toThrow();
  });

  it('retains user ids and roles only — never the email, phone or name identity returns', async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ items: [user('USR_1', ['FLEET_MANAGER'])], hasMore: false }),
    );
    const adapter = new IdentityHttpRecipientAdapter(
      { baseUrl: 'http://identity.test', timeoutMs: 1000 },
      tokens,
      fetch,
    );

    const result = await adapter.resolve({ ...query, roles: ['FLEET_MANAGER'] });

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('@example.test');
    expect(serialised).not.toContain('+98000');
    expect(serialised).not.toContain('First');
    expect(Object.keys(result.recipients[0]!).sort()).toEqual(['role', 'userId']);
  });

  it('merges a user holding several roles once, credited to the first role that matched', async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({
        items: [user('USR_1', ['FLEET_MANAGER', 'ORGANIZATION_ADMIN'])],
        hasMore: false,
      }),
    );
    const adapter = new IdentityHttpRecipientAdapter(
      { baseUrl: 'http://identity.test', timeoutMs: 1000 },
      tokens,
      fetch,
    );

    const result = await adapter.resolve(query);
    expect(result.recipients).toEqual([{ userId: 'USR_1', role: 'FLEET_MANAGER' }]);
  });

  it('follows the cursor across pages', async () => {
    const { fetch, calls } = fakeFetch((url) => {
      const cursor = url.searchParams.get('cursor');
      if (url.searchParams.get('role') !== 'FLEET_MANAGER')
        return jsonResponse({ items: [], hasMore: false });
      if (!cursor)
        return jsonResponse({
          items: [user('USR_1', ['FLEET_MANAGER'])],
          nextCursor: 'MEM_1',
          hasMore: true,
        });
      return jsonResponse({
        items: [user('USR_2', ['FLEET_MANAGER'])],
        nextCursor: null,
        hasMore: false,
      });
    });
    const adapter = new IdentityHttpRecipientAdapter(
      { baseUrl: 'http://identity.test', timeoutMs: 1000 },
      tokens,
      fetch,
    );

    const result = await adapter.resolve(query);
    expect(result.recipients.map((r) => r.userId)).toEqual(['USR_1', 'USR_2']);
    expect(calls.filter((c) => c.url.searchParams.get('cursor') === 'MEM_1')).toHaveLength(1);
  });

  it('drops a non-ACTIVE user even if identity returned it', async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({
        items: [user('USR_1', ['FLEET_MANAGER'], 'SUSPENDED'), user('USR_2', ['FLEET_MANAGER'])],
        hasMore: false,
      }),
    );
    const adapter = new IdentityHttpRecipientAdapter(
      { baseUrl: 'http://identity.test', timeoutMs: 1000 },
      tokens,
      fetch,
    );

    const result = await adapter.resolve({ ...query, roles: ['FLEET_MANAGER'] });
    expect(result.recipients.map((r) => r.userId)).toEqual(['USR_2']);
  });

  it('truncates at the ceiling and says so', async () => {
    const many = Array.from({ length: 5 }, (_, i) => user(`USR_${i}`, ['FLEET_MANAGER']));
    const { fetch } = fakeFetch(() => jsonResponse({ items: many, hasMore: false }));
    const adapter = new IdentityHttpRecipientAdapter(
      { baseUrl: 'http://identity.test', timeoutMs: 1000 },
      tokens,
      fetch,
    );

    const result = await adapter.resolve({ ...query, roles: ['FLEET_MANAGER'], limit: 3 });
    expect(result.recipients).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it.each([
    [401, 'REFUSED'],
    [403, 'REFUSED'],
    [404, 'REFUSED'],
    [500, 'REFUSED'],
    [503, 'REFUSED'],
  ])('classifies HTTP %i as %s without reading the body', async (status, reason) => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ error: { message: 'contains nobody@example.test' } }, status),
    );
    const adapter = new IdentityHttpRecipientAdapter(
      { baseUrl: 'http://identity.test', timeoutMs: 1000 },
      tokens,
      fetch,
    );

    let caught: RecipientResolutionError | undefined;
    try {
      await adapter.resolve(query);
    } catch (error) {
      caught = error as RecipientResolutionError;
    }
    expect(caught).toBeInstanceOf(RecipientResolutionError);
    expect(caught?.reason).toBe(reason);
    expect(caught?.message).toContain(String(status));
    expect(caught?.message).not.toContain('example.test');
  });

  it('classifies a connection failure as UNREACHABLE and a timeout as TIMEOUT', async () => {
    const unreachable = new IdentityHttpRecipientAdapter(
      { baseUrl: 'http://identity.test', timeoutMs: 1000 },
      tokens,
      (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    );
    await expect(unreachable.resolve(query)).rejects.toMatchObject({ reason: 'UNREACHABLE' });

    const slow = new IdentityHttpRecipientAdapter(
      { baseUrl: 'http://identity.test', timeoutMs: 20 },
      tokens,
      ((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        })) as typeof fetch,
    );
    await expect(slow.resolve(query)).rejects.toMatchObject({ reason: 'TIMEOUT' });
  });

  it('classifies a non-JSON or unexpected body as MALFORMED_RESPONSE', async () => {
    const notJson = new IdentityHttpRecipientAdapter(
      { baseUrl: 'http://identity.test', timeoutMs: 1000 },
      tokens,
      (async () => new Response('<html>', { status: 200 })) as typeof fetch,
    );
    await expect(notJson.resolve(query)).rejects.toMatchObject({ reason: 'MALFORMED_RESPONSE' });

    const wrongShape = new IdentityHttpRecipientAdapter(
      { baseUrl: 'http://identity.test', timeoutMs: 1000 },
      tokens,
      (async () => jsonResponse({ users: [] })) as typeof fetch,
    );
    await expect(wrongShape.resolve(query)).rejects.toMatchObject({ reason: 'MALFORMED_RESPONSE' });
  });
});
