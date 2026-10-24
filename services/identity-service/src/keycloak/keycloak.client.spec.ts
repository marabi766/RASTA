import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import {
  ACTIVATION_ATTRIBUTE,
  KeycloakAdminClient,
  KeycloakCreateUnconfirmedError,
  KeycloakWriteUnconfirmedError,
} from './keycloak.client';
import { writeNotSent, type KeycloakWriteFence } from './keycloak-write-fence';
import { provenanceOnly } from './platform-attributes';

/**
 * A fence that commits nothing, for the client alone: records each attempt
 * the client opens before a PUT (D-069), with the attempt's deadline as the
 * request's signal. `expired` makes the deadline pass before dispatch.
 */
function testFence(timeoutMs = 10_000, options: { expired?: boolean } = {}) {
  const opened: string[] = [];
  const fence: KeycloakWriteFence = async (operation) => {
    opened.push(operation);
    const signal = AbortSignal.timeout(timeoutMs);
    return {
      id: `KWA_TEST_${opened.length}`,
      signal,
      assertDispatchable() {
        if (options.expired) throw writeNotSent(operation, 'deadline');
      },
    };
  };
  return { fence, opened };
}

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
    await client().replacePlatformAttributes(
      'kc-1',
      {
        rasta_user_id: ['USR_1'],
        organization_ids: ['ORG-A'],
        organization_roles: ['ORG-A:DRIVER'],
        active_organization_id: [],
      },
      { fence: testFence().fence },
    );

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
    await client().replacePlatformAttributes(
      'kc-1',
      {
        rasta_user_id: ['USR_1'],
        organization_ids: [],
        organization_roles: [],
        active_organization_id: [],
      },
      { fence: testFence().fence },
    );

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

    await client().replacePlatformAttributes(
      'kc-1',
      {
        rasta_user_id: ['USR_1'],
        organization_ids: [],
        organization_roles: [],
        active_organization_id: [],
      },
      { fence: testFence().fence },
    );

    const body = calls.find((call) => call.method === 'PUT')?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('email');
  });

  it('makes exactly one write', async () => {
    await client().replacePlatformAttributes(
      'kc-1',
      {
        rasta_user_id: ['USR_1'],
        organization_ids: [],
        organization_roles: [],
        active_organization_id: [],
      },
      { fence: testFence().fence },
    );
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
      activation: null,
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

/**
 * The two answers #219 r3 made provable: a create Keycloak did not confirm,
 * and an activation written as one update with its marker.
 */
describe('KeycloakAdminClient: unconfirmed create and one-shot activation (#219 r3)', () => {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  let answers: Response[] = [];
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    calls.length = 0;
    answers = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/token')) {
        return new Response(JSON.stringify({ access_token: 'admin-token', expires_in: 300 }));
      }
      calls.push({
        method: init?.method ?? 'GET',
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const next = answers.shift();
      if (!next) throw new Error('unexpected Keycloak call');
      return next;
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

  const input = {
    username: 'applicant',
    email: 'applicant@example.test',
    firstName: 'A',
    lastName: 'B',
    userId: 'USR_1',
  };

  it('creates every account disabled and granting nothing but its provenance (D-069 addendum D)', async () => {
    answers = [
      new Response(null, {
        status: 201,
        headers: { location: 'http://keycloak.test/admin/realms/rasta/users/0b5c-11ef' },
      }),
    ];
    await client().createUser(input);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      body: { enabled: false, attributes: provenanceOnly('USR_1') },
    });
  });

  it("returns the id a create's Location names", async () => {
    answers = [
      new Response(null, {
        status: 201,
        headers: { location: 'http://keycloak.test/admin/realms/rasta/users/0b5c-11ef' },
      }),
    ];
    await expect(client().createUser(input)).resolves.toBe('0b5c-11ef');
  });

  it.each([
    ['no Location', {}],
    ['a Location naming no user', { location: 'http://keycloak.test/admin/realms/rasta/users/' }],
    ['a Location with another path', { location: 'http://keycloak.test/elsewhere' }],
    ['an id that is not one', { location: 'http://keycloak.test/admin/realms/rasta/users/a%2Fb' }],
  ])('reports a success with %s as unconfirmed, never as no account', async (_case, headers) => {
    answers = [new Response(null, { status: 201, headers })];
    await expect(client().createUser(input)).rejects.toBeInstanceOf(KeycloakCreateUnconfirmedError);
  });

  it('enables and marks in one update, keeping every attribute it read', async () => {
    answers = [
      new Response(
        JSON.stringify({
          id: 'kc-1',
          email: 'applicant@example.test',
          firstName: 'A',
          lastName: 'B',
          enabled: false,
          attributes: { rasta_user_id: ['USR_1'], organization_ids: ['ORG_A'], locale: ['fa'] },
        }),
      ),
      new Response(null, { status: 204 }),
    ];
    await client().activateAccount('kc-1', 'REG_1', { fence: testFence().fence });
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PUT']);
    expect(calls[1]?.body).toEqual({
      email: 'applicant@example.test',
      firstName: 'A',
      lastName: 'B',
      enabled: true,
      attributes: {
        rasta_user_id: ['USR_1'],
        organization_ids: ['ORG_A'],
        locale: ['fa'],
        [ACTIVATION_ATTRIBUTE]: ['REG_1'],
      },
    });
  });

  it('reports a failed activation as upstream unavailable', async () => {
    answers = [
      new Response(JSON.stringify({ id: 'kc-1', attributes: {} })),
      new Response(null, { status: 500 }),
    ];
    await expect(
      client().activateAccount('kc-1', 'REG_1', { fence: testFence().fence }),
    ).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });

  it('reads the activation marker back with the account', async () => {
    answers = [
      new Response(
        JSON.stringify({
          id: 'kc-1',
          enabled: false,
          attributes: { rasta_user_id: ['USR_1'], [ACTIVATION_ATTRIBUTE]: ['REG_1'] },
        }),
      ),
    ];
    await expect(client().getAccount('kc-1')).resolves.toMatchObject({
      id: 'kc-1',
      enabled: false,
      activation: 'REG_1',
    });
  });
});

/**
 * Every call to Keycloak has a deadline — the token request included — over
 * the connection, the response and its body (#219 r4). Several run while a
 * database lock is held, so a token endpoint that accepts and never answers
 * must not hold that lock without bound. A real socket, not a stubbed fetch:
 * what is proven is that `fetch` itself is cut off.
 */
describe('KeycloakAdminClient: a deadline on every call, the token request included (#219 r4)', () => {
  let server: Server;
  let baseUrl = '';
  let behaviour: 'silent' | 'stalled-body' | 'answers' = 'silent';
  const held: ServerResponse[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url?.endsWith('/token') && behaviour !== 'answers') {
        if (behaviour === 'stalled-body') {
          // Headers and half a body, then nothing.
          response.writeHead(200, { 'content-type': 'application/json' });
          response.write('{"access_token":"admin-tok');
        }
        held.push(response);
        return;
      }
      if (request.url?.endsWith('/token')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ access_token: 'admin-token', expires_in: 300 }));
        return;
      }
      // An admin call that never answers.
      held.push(response);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const response of held) response.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const client = () =>
    new KeycloakAdminClient({
      baseUrl,
      realm: 'rasta',
      clientId: 'rasta-backend',
      clientSecret: 'client-secret-for-tests',
      enabled: true,
      requestTimeoutMs: 300,
    });

  it.each(['silent', 'stalled-body'] as const)(
    'a token endpoint that is %s fails within the deadline, as upstream unavailable',
    async (mode) => {
      behaviour = mode;
      const started = Date.now();
      await expect(client().getAccount('kc-1')).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
      });
      expect(Date.now() - started).toBeLessThan(3_000);
    },
  );

  it('an admin call that never answers fails within the deadline, as upstream unavailable', async () => {
    behaviour = 'answers';
    const started = Date.now();
    await expect(client().getAccount('kc-1')).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('the secret never reaches the error', async () => {
    behaviour = 'silent';
    const error = await client()
      .getAccount('kc-1')
      .catch((caught: unknown) => caught);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(
      'client-secret-for-tests',
    );
  });
});

/**
 * D-064: a write that may have reached Keycloak is told apart from one that
 * provably did not. An aborted request is not a cancelled one, so a write past
 * its deadline, cut off mid-answer, or answered 5xx "may land"
 * (`KeycloakWriteUnconfirmedError`); a refused connection, a failure before
 * the write was sent, or a 4xx did not. A real socket, so what is classified
 * is what `fetch` itself reports.
 */
describe('KeycloakAdminClient: whether a write may have landed (D-064)', () => {
  let server: Server;
  let baseUrl = '';
  /** What the server does with the next PUT. */
  let onPut: 'hang' | 'reset' | 'reset-after-body' | number = 204;
  /** What it does with the GET before it. */
  let onGet: 'ok' | 404 | 503 = 'ok';
  const puts: string[] = [];
  const held: ServerResponse[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url?.endsWith('/token')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ access_token: 'admin-token', expires_in: 300 }));
        return;
      }
      if (request.method === 'GET') {
        if (onGet !== 'ok') {
          response.writeHead(onGet).end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: 'kc-1', email: 'a@example.test', attributes: {} }));
        return;
      }
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        puts.push(body);
        if (onPut === 'hang') held.push(response);
        else if (onPut === 'reset' || onPut === 'reset-after-body') response.socket?.destroy();
        else response.writeHead(onPut).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const response of held) response.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    puts.length = 0;
    onPut = 204;
    onGet = 'ok';
  });

  const client = (url = baseUrl) =>
    new KeycloakAdminClient({
      baseUrl: url,
      realm: 'rasta',
      clientId: 'rasta-backend',
      clientSecret: 'client-secret-for-tests',
      enabled: true,
      requestTimeoutMs: 300,
    });
  const write = (url?: string) =>
    client(url).replacePlatformAttributes('kc-1', provenanceOnly('USR_1'), {
      fence: testFence(300).fence,
    });

  it.each([
    ['its deadline passes', 'hang' as const, 'deadline'],
    ['the connection breaks after it was sent', 'reset' as const, 'connection'],
    ['Keycloak, or a proxy before it, answers 500', 500, 'server_error'],
    ['a proxy answers 502', 502, 'server_error'],
    ['a proxy answers 504', 504, 'server_error'],
  ])('unconfirmed when %s: it reached Keycloak and may land', async (_label, mode, reason) => {
    onPut = mode;
    const error = await write().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(KeycloakWriteUnconfirmedError);
    expect(error).toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      internalContext: { service: 'keycloak', reason, unconfirmed: true },
    });
    expect(puts).toHaveLength(1);
  });

  it.each([400, 403, 409])('a %s refuses the write: confirmed, not applied', async (status) => {
    onPut = status;
    const error = await write().catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(KeycloakWriteUnconfirmedError);
    expect(error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });

  it('a refused connection is confirmed: nothing was sent', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const error = await write(url).catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(KeycloakWriteUnconfirmedError);
    expect(error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });

  it('a read that fails before the write is confirmed: nothing was sent', async () => {
    onGet = 503;
    const error = await write().catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(KeycloakWriteUnconfirmedError);
    expect(puts).toHaveLength(0);
  });

  it('a 404 is "no such account", read or write', async () => {
    onGet = 404;
    await expect(write()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    onGet = 'ok';
    onPut = 404;
    await expect(write()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('disable keeps answering a 404 as upstream unavailable, as it always did', async () => {
    onPut = 404;
    await expect(client().disable('kc-1', { fence: testFence(300).fence })).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });

  it.each([
    ['disable', (c: KeycloakAdminClient) => c.disable('kc-1', { fence: testFence(300).fence })],
    [
      'activateAccount',
      (c: KeycloakAdminClient) =>
        c.activateAccount('kc-1', 'REG_1', { fence: testFence(300).fence }),
    ],
  ])('%s is classified the same way', async (_name, call) => {
    onPut = 'hang';
    await expect(call(client())).rejects.toBeInstanceOf(KeycloakWriteUnconfirmedError);
    onPut = 400;
    const refused = await call(client()).catch((caught: unknown) => caught);
    expect(refused).not.toBeInstanceOf(KeycloakWriteUnconfirmedError);
  });

  it('opens the fence after the read and before the PUT; a read that fails opens none (D-069)', async () => {
    const order: string[] = [];
    const recorded = testFence(300);
    const fence: KeycloakWriteFence = async (operation) => {
      order.push(`fence:${operation}:puts=${puts.length}`);
      return recorded.fence(operation);
    };
    await client().replacePlatformAttributes('kc-1', provenanceOnly('USR_1'), { fence });
    expect(order).toEqual(['fence:replace_attributes:puts=0']);
    expect(puts).toHaveLength(1);

    onGet = 503;
    order.length = 0;
    await expect(
      client().replacePlatformAttributes('kc-1', provenanceOnly('USR_1'), { fence }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(order).toEqual([]);
  });

  it('a deadline that passed before dispatch sends nothing, and is confirmed not applied (D-069)', async () => {
    const error = await client()
      .replacePlatformAttributes('kc-1', provenanceOnly('USR_1'), {
        fence: testFence(300, { expired: true }).fence,
      })
      .catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(KeycloakWriteUnconfirmedError);
    expect(error).toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      internalContext: { reason: 'deadline_before_dispatch' },
    });
    expect(puts).toHaveLength(0);
  });

  it('a fence that cannot be committed sends nothing (D-069)', async () => {
    const fence: KeycloakWriteFence = async () => {
      throw new Error('fence pool unavailable');
    };
    await expect(
      client().replacePlatformAttributes('kc-1', provenanceOnly('USR_1'), { fence }),
    ).rejects.toThrow('fence pool unavailable');
    expect(puts).toHaveLength(0);
  });

  it('the caller cancelling mid-flight leaves the write unconfirmed (D-069: its fence stays)', async () => {
    onPut = 'hang';
    const cancel = new AbortController();
    const recorded = testFence(5_000);
    const fence: KeycloakWriteFence = async (operation) => {
      const attempt = await recorded.fence(operation);
      return { ...attempt, signal: AbortSignal.any([attempt.signal, cancel.signal]) };
    };
    const pending = client()
      .replacePlatformAttributes('kc-1', provenanceOnly('USR_1'), { fence, cancel: cancel.signal })
      .catch((caught: unknown) => caught);
    await new Promise((resolve) => setTimeout(resolve, 50));
    cancel.abort();
    expect(await pending).toBeInstanceOf(KeycloakWriteUnconfirmedError);
    expect(puts).toHaveLength(1);
  });

  it('the secret never reaches an unconfirmed error', async () => {
    onPut = 'hang';
    const error = await write().catch((caught: unknown) => caught);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(
      'client-secret-for-tests',
    );
  });
});

describe('KeycloakAdminClient with sync disabled', () => {
  it('skips a create without logging the username, which is personal data (S-09)', async () => {
    const lines: string[] = [];
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation((message: unknown) => {
      lines.push(String(message));
    });
    try {
      const client = new KeycloakAdminClient({
        baseUrl: 'http://keycloak.test',
        realm: 'rasta',
        clientId: 'rasta-backend',
        clientSecret: 'client-secret-for-tests',
        enabled: false,
      });
      await expect(
        client.createUser({
          username: 'applicant-sentinel',
          email: 'applicant@example.test',
          firstName: 'A',
          lastName: 'B',
          userId: 'USR_1',
        }),
      ).resolves.toBeNull();
    } finally {
      debug.mockRestore();
    }
    expect(lines).toEqual(['Keycloak sync disabled; skipping createUser']);
  });
});
