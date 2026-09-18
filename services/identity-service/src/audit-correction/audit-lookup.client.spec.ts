import { RastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import { AuditLookupClient, AUDIT_SERVICE } from './audit-lookup.client';

/**
 * The correction-target lookup (AUD-003 correction): the exact request it makes, the three
 * answers it can give, and that no failure leaks a URL, a token or a body.
 */

const TOKEN = 'internal-token-sentinel';
const ID = '01JAUDIT0000000000000001';
const AT = new Date('2026-09-12T10:00:00.000Z');
const BASE_URL = 'http://audit.internal:3115';
const BODY_SENTINEL = 'body-sentinel-ORG-SECRET';

interface Call {
  url: string;
  init: RequestInit;
}

function clientWith(respond: (call: Call) => Promise<Response>, timeoutMs = 1000) {
  const calls: Call[] = [];
  const issue = jest.fn(async () => TOKEN);
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  const client = new AuditLookupClient({
    baseUrl: `${BASE_URL}/`,
    timeoutMs,
    tokens: { issue } as never,
    fetch: fetchImpl,
  });
  return { client, calls, issue };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const context: RequestContext = {
  correlationId: 'COR-C11-1',
  requestId: 'REQ-C11-1',
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  spanId: '00f067aa0ba902b7',
  organizationId: 'ORG-ADMIN-OWN',
  organizationIds: ['ORG-ADMIN-OWN'],
  userId: 'USR-ADMIN',
  roles: ['SYSTEM_ADMIN'],
  authType: 'USER',
  startedAt: 0,
};

const inContext = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(context, fn);

async function failure(promise: Promise<unknown>): Promise<RastaError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RastaError);
    return error as RastaError;
  }
  throw new Error('expected a failure');
}

describe('AuditLookupClient', () => {
  it('asks exactly one narrow question, with a service token scoped to audit-service and no tenant', async () => {
    const { client, calls, issue } = clientWith(async () =>
      json(200, { id: ID, organizationId: 'ORG-DEH-0001', occurredAt: AT.toISOString() }),
    );

    await inContext(() => client.findTarget(ID, AT));

    // Target audit-service, purpose SERVICE, and no organization claim at all.
    expect(issue).toHaveBeenCalledWith('identity-service', AUDIT_SERVICE, 'SERVICE');
    expect(issue.mock.calls[0]).toHaveLength(3);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe(
      `${BASE_URL}/v1/internal/audit-events/${ID}?occurredAt=${encodeURIComponent(AT.toISOString())}`,
    );
    expect(call!.init.method).toBe('GET');
    const headers = call!.init.headers as Record<string, string>;
    expect(headers['x-internal-token']).toBe(TOKEN);
    expect(headers['x-correlation-id']).toBe('COR-C11-1');
    expect(headers.traceparent).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
    // Never the caller's bearer token, never the administrator's own tenant.
    expect(headers).not.toHaveProperty('authorization');
    expect(headers).not.toHaveProperty('x-organization-id');
    expect(call!.init.signal).toBeDefined();
  });

  it('encodes the id into the path rather than letting it shape the URL', async () => {
    const { client, calls } = clientWith(async () => json(404, {}));

    await inContext(() => client.findTarget('a/b?c', AT));

    expect(calls[0]!.url).toContain('/v1/internal/audit-events/a%2Fb%3Fc?occurredAt=');
  });

  it('returns the target exactly as proved, including a platform-scoped null organization', async () => {
    const { client } = clientWith(async () =>
      json(200, { id: ID, organizationId: null, occurredAt: AT.toISOString() }),
    );

    await expect(inContext(() => client.findTarget(ID, AT))).resolves.toEqual({
      id: ID,
      organizationId: null,
      occurredAt: AT,
    });
  });

  it.each([
    ['a 404', async () => json(404, { code: 'NOT_FOUND' })],
    [
      'an answer for another id',
      async () =>
        json(200, {
          id: '01JAUDIT0000000000000002',
          organizationId: null,
          occurredAt: AT.toISOString(),
        }),
    ],
    [
      'an answer at another instant',
      async () =>
        json(200, { id: ID, organizationId: null, occurredAt: '2026-09-12T10:00:00.001Z' }),
    ],
  ])('treats %s as no target at all', async (_label, respond) => {
    const { client } = clientWith(respond);

    await expect(inContext(() => client.findTarget(ID, AT))).resolves.toBeNull();
  });

  it.each([
    ['a 500', async () => json(500, { message: BODY_SENTINEL })],
    ['a 403', async () => json(403, { message: BODY_SENTINEL })],
    ['a 401', async () => json(401, { message: BODY_SENTINEL })],
    ['a 400', async () => json(400, { message: BODY_SENTINEL })],
    ['an unparseable body', async () => new Response(`<html>${BODY_SENTINEL}`, { status: 200 })],
    [
      'an answer with an undeclared field',
      async () =>
        json(200, {
          id: ID,
          organizationId: null,
          occurredAt: AT.toISOString(),
          actorId: BODY_SENTINEL,
        }),
    ],
    [
      'an answer missing the organization',
      async () => json(200, { id: ID, occurredAt: AT.toISOString() }),
    ],
    [
      'a transport failure',
      async () => {
        throw new Error(`connect ECONNREFUSED ${BASE_URL} ${TOKEN}`);
      },
    ],
  ])('turns %s into a bounded UPSTREAM_UNAVAILABLE that leaks nothing', async (_label, respond) => {
    const { client } = clientWith(respond);

    const error = await failure(inContext(() => client.findTarget(ID, AT)));

    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    const serialised = `${error.message} ${JSON.stringify(error)}`;
    for (const leaked of [BASE_URL, 'audit.internal', TOKEN, BODY_SENTINEL, ID]) {
      expect(serialised).not.toContain(leaked);
    }
  });

  it('turns a lookup that outlives its deadline into a bounded UPSTREAM_TIMEOUT', async () => {
    const { client } = clientWith(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      20,
    );

    const error = await failure(inContext(() => client.findTarget(ID, AT)));

    expect(error.code).toBe('UPSTREAM_TIMEOUT');
    expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(TOKEN);
  });

  it('forwards no correlation id or trace it cannot vouch for', async () => {
    const { client, calls } = clientWith(async () => json(404, {}));

    await runWithContext({ ...context, correlationId: 'not an id <script>', traceId: 'XYZ' }, () =>
      client.findTarget(ID, AT),
    );

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers).not.toHaveProperty('x-correlation-id');
    expect(headers).not.toHaveProperty('traceparent');
  });
});
