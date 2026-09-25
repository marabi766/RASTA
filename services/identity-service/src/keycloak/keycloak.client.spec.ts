import { KeycloakAdminClient } from './keycloak.client';

/**
 * The one Keycloak write the platform attributes go through.
 *
 * On Keycloak 26 the admin `PUT /users/:id` takes its body as the whole user:
 * sent only `{ attributes }`, it erased the other platform attributes and the
 * user's email and names. So the write must read the representation, replace
 * the platform attributes in it, and send the whole thing back.
 */
describe('KeycloakAdminClient.replacePlatformAttributes', () => {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const stored = {
    id: 'kc-1',
    username: 'someone',
    email: 'someone@example.test',
    firstName: 'Some',
    lastName: 'One',
    enabled: true,
    attributes: {
      locale: ['fa'],
      organization_ids: ['ORG-OLD'],
      organization_roles: ['ORG-OLD:ORGANIZATION_ADMIN'],
      active_organization_id: ['ORG-OLD'],
      rasta_user_id: ['USR_1'],
    },
  };

  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    calls.length = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/token')) {
        return new Response(JSON.stringify({ access_token: 'admin-token', expires_in: 300 }));
      }
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === 'GET') return new Response(JSON.stringify(stored));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const client = () =>
    new KeycloakAdminClient({
      baseUrl: 'http://keycloak.test',
      realm: 'rasta',
      clientId: 'rasta-backend',
      clientSecret: 'client-secret-for-tests',
      enabled: true,
    });

  it('writes the whole representation back, with every platform attribute replaced', async () => {
    await client().replacePlatformAttributes('kc-1', {
      rasta_user_id: ['USR_1'],
      organization_ids: ['ORG-A'],
      organization_roles: ['ORG-A:DRIVER'],
      active_organization_id: [],
    });

    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.url).toBe('http://keycloak.test/admin/realms/rasta/users/kc-1');
    expect(put?.body).toEqual({
      ...stored,
      attributes: {
        // Not ours — carried over untouched.
        locale: ['fa'],
        rasta_user_id: ['USR_1'],
        organization_ids: ['ORG-A'],
        organization_roles: ['ORG-A:DRIVER'],
        // Cleared explicitly, not left behind.
        active_organization_id: [],
      },
    });
  });

  it('makes exactly one write', async () => {
    await client().replacePlatformAttributes('kc-1', {
      rasta_user_id: ['USR_1'],
      organization_ids: [],
      organization_roles: [],
      active_organization_id: [],
    });
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
  });
});
