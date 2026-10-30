import { inspect } from 'node:util';
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
  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
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
      recipients: [{ userId: 'USR_1', role: 'FLEET_MANAGER', email: 'usr_1@example.test' }],
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

  /**
   * This test used to assert that **no** address survived parsing, and
   * widening it rather than deleting it is the point.
   *
   * The invariant was never "the address is dropped". It is **nothing is kept
   * that no code path needs** — and NTF-004 gave the address a use: the email
   * channel has to know where to write, and the resolution snapshot has to
   * record where it wrote. What has no use is still dropped, and that is what
   * is asserted here: no phone, because Q-15 has no answer and there is no SMS
   * adapter, and no names, because a notification addresses a person by their
   * address and not by their identity record.
   */
  it('retains the address, the id and the role — and nothing else identity returns', async () => {
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
    expect(serialised).not.toContain('+98000');
    expect(serialised).not.toContain('First');
    expect(serialised).not.toContain('Last');
    expect(serialised).not.toContain('u-USR_1');
    expect(Object.keys(result.recipients[0]!).sort()).toEqual(['email', 'role', 'userId']);
    expect(result.recipients[0]!.email).toBe('usr_1@example.test');
  });

  it('keeps a recipient who has no address, rather than dropping them', async () => {
    // A person without an address is still a recipient: they get their in-app
    // notification, and the email delivery is suppressed with a reason. The
    // opposite — dropping them here — would make one incomplete identity
    // record silently remove somebody from a notification they are entitled
    // to, and nothing downstream could tell that had happened.
    const { email: _omitted, ...withoutEmail } = user('USR_2', ['FLEET_MANAGER']);
    const { fetch } = fakeFetch(() => jsonResponse({ items: [withoutEmail], hasMore: false }));
    const adapter = new IdentityHttpRecipientAdapter(
      { baseUrl: 'http://identity.test', timeoutMs: 1000 },
      tokens,
      fetch,
    );

    const result = await adapter.resolve({ ...query, roles: ['FLEET_MANAGER'] });

    expect(result.recipients).toEqual([{ userId: 'USR_2', role: 'FLEET_MANAGER', email: null }]);
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
    expect(result.recipients).toEqual([
      { userId: 'USR_1', role: 'FLEET_MANAGER', email: 'usr_1@example.test' },
    ]);
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
      ((_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
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

  describe('one deadline covers the body too (#502 r1 F1)', () => {
    /** Headers at once; then one chunk of a page, and the rest never comes. */
    const stalledPage = (): Response =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"items":['));
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    /** Headers now, one chunk, and the rest never comes; `cancelled()` says whether it was given up. */
    const stalledWatched = (status: number) => {
      let cancelled = false;
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"items":['));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status },
      );
      return { response, cancelled: () => cancelled };
    };

    it('fails a body that stalls after the headers as TIMEOUT, within the deadline, with the signal aborted', async () => {
      const signals: AbortSignal[] = [];
      const adapter = new IdentityHttpRecipientAdapter(
        { baseUrl: 'http://identity.test', timeoutMs: 30 },
        tokens,
        (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          signals.push(init!.signal!);
          // Not wired to the signal, like a transport that ignores the abort.
          return stalledPage();
        }) as typeof fetch,
      );
      const started = Date.now();

      await expect(adapter.resolve(query)).rejects.toMatchObject({
        name: 'RecipientResolutionError',
        reason: 'TIMEOUT',
      });

      expect(Date.now() - started).toBeLessThan(2_000);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(true);
    });

    it('fails a body that trickles for ever as TIMEOUT, with the signal aborted', async () => {
      let trickle: NodeJS.Timeout | undefined;
      let signal: AbortSignal | undefined;
      const adapter = new IdentityHttpRecipientAdapter(
        { baseUrl: 'http://identity.test', timeoutMs: 40 },
        tokens,
        (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          signal = init?.signal ?? undefined;
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              trickle = setInterval(() => controller.enqueue(new TextEncoder().encode(' ')), 5);
              // What undici does with the request's signal once the body is flowing.
              init?.signal?.addEventListener('abort', () => {
                clearInterval(trickle);
                controller.error(init.signal!.reason);
              });
            },
            cancel() {
              clearInterval(trickle);
            },
          });
          return new Response(body, { status: 200 });
        }) as typeof fetch,
      );
      try {
        await expect(adapter.resolve(query)).rejects.toMatchObject({ reason: 'TIMEOUT' });
      } finally {
        clearInterval(trickle);
      }
      expect(signal?.aborted).toBe(true);
    });

    it('a stalled body leaves nothing behind: the next resolution on the same adapter answers', async () => {
      let call = 0;
      const adapter = new IdentityHttpRecipientAdapter(
        { baseUrl: 'http://identity.test', timeoutMs: 30 },
        tokens,
        (async () => {
          call += 1;
          return call === 1
            ? stalledPage()
            : jsonResponse({ items: [user('USR_1', ['FLEET_MANAGER'])], hasMore: false });
        }) as typeof fetch,
      );

      await expect(adapter.resolve({ ...query, roles: ['FLEET_MANAGER'] })).rejects.toMatchObject({
        reason: 'TIMEOUT',
      });
      await expect(adapter.resolve({ ...query, roles: ['FLEET_MANAGER'] })).resolves.toMatchObject({
        recipients: [{ userId: 'USR_1' }],
      });
    });

    it('a body that ends in time is read in full', async () => {
      const ok = new IdentityHttpRecipientAdapter(
        { baseUrl: 'http://identity.test', timeoutMs: 1000 },
        tokens,
        (async () =>
          jsonResponse({
            items: [user('USR_1', ['FLEET_MANAGER'])],
            hasMore: false,
          })) as typeof fetch,
      );
      await expect(ok.resolve({ ...query, roles: ['FLEET_MANAGER'] })).resolves.toMatchObject({
        recipients: [{ userId: 'USR_1' }],
      });
    });

    // #507 r1 F1: a refusal's body is never awaited, and never left to a peer that stalls.
    it.each([
      [401, 'REFUSED'],
      [403, 'REFUSED'],
      [404, 'REFUSED'],
      [500, 'REFUSED'],
      [503, 'REFUSED'],
      // A redirect is refused by the transport itself, as a failure to reach.
      [302, 'UNREACHABLE'],
    ])(
      'a %s with a stalled body is %s at once, its body cancelled and its request aborted, on every retry',
      async (status, reason) => {
        const watched = Array.from({ length: 3 }, () => stalledWatched(status));
        const signals: AbortSignal[] = [];
        let next = 0;
        const adapter = new IdentityHttpRecipientAdapter(
          { baseUrl: 'http://identity.test', timeoutMs: 30_000 },
          tokens,
          (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            signals.push(init!.signal!);
            return watched[next++]!.response;
          }) as typeof fetch,
        );

        for (let attempt = 0; attempt < 3; attempt += 1) {
          const started = Date.now();
          await expect(adapter.resolve(query)).rejects.toMatchObject({ reason });
          expect(Date.now() - started).toBeLessThan(5_000);
          expect(watched[attempt]!.cancelled()).toBe(true);
          expect(signals[attempt]!.aborted).toBe(true);
        }
      },
    );
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

  it('refuses an unreadable base URL with a fixed text, never the URL (#385 r5)', async () => {
    // `new URL(path, base)` keeps the base on `.base`; an uncaught throw prints it.
    const { fetch, calls } = fakeFetch(() => jsonResponse({ items: [], hasMore: false }));
    // Built from the two sentinels, not written as one literal URL.
    const [user, password] = ['private-sentinel-79', 'JZ97-another-secret'];
    const adapter = new IdentityHttpRecipientAdapter(
      { baseUrl: `http://${user}:${password}@identity:bad`, timeoutMs: 1000 },
      tokens,
      fetch,
    );
    const error = await adapter.resolve(query).then(
      () => undefined,
      (thrown: unknown) => thrown as Error,
    );
    expect(error?.message).toBe(
      'IDENTITY_SERVICE_URL cannot be read as a URL; its value is not repeated',
    );
    const printed = [
      error?.stack,
      JSON.stringify(error, Object.getOwnPropertyNames(error)),
      inspect(error, { showHidden: true, depth: 10 }),
    ].join('\n');
    expect(printed).not.toMatch(/sentinel|jz97|another-secret/i);
    expect(calls).toHaveLength(0);
  });
});
