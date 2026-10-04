import { KeycloakAdminClient } from './keycloak.client';

/**
 * The one Keycloak write the platform attributes go through.
 *
 * On Keycloak 26 the admin `PUT /users/:id` changes the fields its body
 * carries, and a body with `attributes` erases every attribute it omits — the
 * user's email and names included (measured on 26.0.8, ADR-060 § 5). So the
 * write reads the user, and sends back exactly the profile fields, the
 * attributes it does not own, and the four it does: never a field it does not
 * own, so a concurrent change to one is never undone. The same interleaving
 * against a real Keycloak: `test/keycloak-live/`.
 */
describe('KeycloakAdminClient.replacePlatformAttributes', () => {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const stored = {
    id: 'kc-1',
    username: 'someone',
    email: 'someone@example.test',
    firstName: 'Some',
    lastName: 'One',
    // Not the projector's. A projection read these a moment before an
    // administrator or the user changed them; sending them back would undo it.
    enabled: false,
    emailVerified: true,
    requiredActions: ['UPDATE_PASSWORD'],
    federationLink: 'ldap-1',
    totp: false,
    notBefore: 0,
    access: { manage: true },
    createdTimestamp: 1_790_000_000_000,
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

  it('writes the profile fields, the attributes it does not own, and every platform attribute', async () => {
    await client().replacePlatformAttributes('kc-1', {
      rasta_user_id: ['USR_1'],
      organization_ids: ['ORG-A'],
      organization_roles: ['ORG-A:DRIVER'],
      active_organization_id: [],
    });

    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.url).toBe('http://keycloak.test/admin/realms/rasta/users/kc-1');
    expect(put?.body).toEqual({
      // Sent only because Keycloak erases them from a body with `attributes`.
      email: 'someone@example.test',
      firstName: 'Some',
      lastName: 'One',
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

  it('never sends a field it does not own, whatever the read returned', async () => {
    await client().replacePlatformAttributes('kc-1', {
      rasta_user_id: ['USR_1'],
      organization_ids: [],
      organization_roles: [],
      active_organization_id: [],
    });

    const body = calls.find((call) => call.method === 'PUT')?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['attributes', 'email', 'firstName', 'lastName']);
  });

  it('leaves out a profile field the user does not have, rather than inventing one', async () => {
    const { email: _none, ...withoutEmail } = stored;
    const originalGet = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      (init?.method ?? 'GET') === 'GET' && !String(input).endsWith('/token')
        ? new Response(JSON.stringify(withoutEmail))
        : originalGet(input, init)) as typeof fetch;

    await client().replacePlatformAttributes('kc-1', {
      rasta_user_id: ['USR_1'],
      organization_ids: [],
      organization_roles: [],
      active_organization_id: [],
    });

    const body = calls.find((call) => call.method === 'PUT')?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('email');
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

/**
 * The lookup an approval makes after `createUser` answered 409, and reconcile
 * makes for each user without an account: by exact username, reading only
 * what a decision needs — the id, whether it is enabled, its platform
 * attributes.
 */
describe('KeycloakAdminClient.findAccountByUsername', () => {
  const urls: string[] = [];
  let answer: Response;
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    urls.length = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/token')) {
        return new Response(JSON.stringify({ access_token: 'admin-token', expires_in: 300 }));
      }
      urls.push(url);
      return answer;
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const client = (enabled = true) =>
    new KeycloakAdminClient({
      baseUrl: 'http://keycloak.test',
      realm: 'rasta',
      clientId: 'rasta-backend',
      clientSecret: 'client-secret-for-tests',
      enabled,
    });

  it('asks for the exact username and returns only the account it names', async () => {
    answer = new Response(
      JSON.stringify([
        { id: 'kc-long', username: 'applicant-two', enabled: true, attributes: {} },
        {
          id: 'kc-1',
          username: 'applicant',
          enabled: false,
          attributes: { rasta_user_id: ['USR_1'], organization_roles: ['ORG_A:DRIVER'] },
        },
      ]),
    );
    await expect(client().findAccountByUsername('Applicant')).resolves.toEqual({
      id: 'kc-1',
      enabled: false,
      attributes: {
        rasta_user_id: ['USR_1'],
        organization_ids: [],
        organization_roles: ['ORG_A:DRIVER'],
        active_organization_id: [],
      },
    });
    expect(urls).toEqual([
      'http://keycloak.test/admin/realms/rasta/users?username=Applicant&exact=true',
    ]);
  });

  it('answers null when there is none', async () => {
    answer = new Response(JSON.stringify([]));
    await expect(client().findAccountByUsername('nobody')).resolves.toBeNull();
  });

  it('reports an unreachable Keycloak as upstream unavailable', async () => {
    answer = new Response(null, { status: 503 });
    await expect(client().findAccountByUsername('applicant')).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });

  it('calls nothing when Keycloak sync is off', async () => {
    await expect(client(false).findAccountByUsername('applicant')).resolves.toBeNull();
    expect(urls).toEqual([]);
  });
});
