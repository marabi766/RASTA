/**
 * @jest-environment node
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InternalTokenService, RastaError, runWithContext } from '@rasta/nest-common';
import {
  IDENTITY_SERVICE,
  LiveMembershipClient,
  MAX_MEMBERSHIP_ANSWER_BYTES,
  NOT_A_MEMBER,
  NOT_A_MEMBER_MESSAGE,
  notAMember,
} from './membership';

/**
 * The fleet → identity membership question over real HTTP (task 095): a
 * loopback server stands in for identity-service and answers each case, the
 * client is the real one over the global `fetch`. Only a strict, matching 200
 * is an answer; every other outcome is `UPSTREAM_UNAVAILABLE` (503).
 */

const SECRET = 'm'.repeat(48);
const tokens = new InternalTokenService(SECRET, 'rasta-internal', 60);
const ORG = 'ORG-DEH-0001';
const USER = 'USR_01J0MEMBERSHIPTEST000000';
const AS_OF = '2026-10-24T10:00:00.000Z';

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

let server: Server;
let baseUrl: string;
let handler: Handler;
const seen: { url: string; token: string; correlationId: string | undefined }[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    seen.push({
      url: request.url ?? '',
      token: String(request.headers['x-internal-token'] ?? ''),
      correlationId: request.headers['x-correlation-id'] as string | undefined,
    });
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen.length = 0;
});

const client = (timeoutMs = 2_000) => new LiveMembershipClient({ baseUrl, timeoutMs, tokens });

function json(body: unknown, status = 200): Handler {
  return (_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
}

const answer = (overrides: Record<string, unknown> = {}) => ({
  userId: USER,
  organizationId: ORG,
  live: true,
  asOf: AS_OF,
  ...overrides,
});

async function refusal(promise: Promise<unknown>): Promise<RastaError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(RastaError);
  return error as RastaError;
}

async function expectUnavailable(promise: Promise<unknown>): Promise<void> {
  const error = await refusal(promise);
  expect({ code: error.code, status: error.status, message: error.message }).toEqual({
    code: 'UPSTREAM_UNAVAILABLE',
    status: 503,
    message: 'A required service is temporarily unavailable',
  });
  // Nothing of the exchange travels in the error: no URL, no body, no cause.
  expect(error.cause).toBeUndefined();
  expect(error.internalContext).toEqual({ service: IDENTITY_SERVICE });
}

describe('LiveMembershipClient', () => {
  it('asks GET /v1/users/{id}/live-membership under a SERVICE token signed for the organization', async () => {
    handler = json(answer());
    await runWithContext(
      {
        requestId: 'req-095',
        correlationId: 'corr-095',
        authType: 'USER',
        roles: [],
        organizationId: ORG,
        organizationIds: [ORG],
        startedAt: Date.now(),
      },
      () => client().isLiveMember(ORG, USER),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`/v1/users/${USER}/live-membership`);
    expect(seen[0]!.correlationId).toBe('corr-095');
    const claims = await tokens.verify(seen[0]!.token, IDENTITY_SERVICE);
    expect(claims).toMatchObject({
      callerService: 'fleet-service',
      purpose: 'SERVICE',
      organizationId: ORG,
    });
  });

  it('encodes the user id as one path segment', async () => {
    handler = json(answer({ userId: 'USR/../x' }));
    await client().isLiveMember(ORG, 'USR/../x');
    expect(seen[0]!.url).toBe('/v1/users/USR%2F..%2Fx/live-membership');
  });

  it('answers true for live: true and false for live: false', async () => {
    handler = json(answer());
    await expect(client().isLiveMember(ORG, USER)).resolves.toBe(true);
    handler = json(answer({ live: false }));
    await expect(client().isLiveMember(ORG, USER)).resolves.toBe(false);
  });

  it.each([403, 404, 401, 400, 500, 502, 503, 504])(
    'refuses a %s as no answer (fail closed), even one whose body says live',
    async (status) => {
      handler = json(answer(), status);
      await expectUnavailable(client().isLiveMember(ORG, USER));
    },
  );

  it('refuses an answer about another user, or about another organization', async () => {
    handler = json(answer({ userId: 'USR_SOMEBODY_ELSE' }));
    await expectUnavailable(client().isLiveMember(ORG, USER));
    handler = json(answer({ organizationId: 'ORG-DEH-0002' }));
    await expectUnavailable(client().isLiveMember(ORG, USER));
  });

  it.each([
    ['not JSON', 'live'],
    ['an empty body', ''],
    ['JSON null', 'null'],
    ['live as a string', JSON.stringify(answer({ live: 'true' }))],
    ['live missing', JSON.stringify({ userId: USER, organizationId: ORG, asOf: AS_OF })],
    ['an unknown key', JSON.stringify(answer({ roles: ['OPERATOR'] }))],
    ['asOf not an instant', JSON.stringify(answer({ asOf: 'yesterday' }))],
  ])('refuses a malformed body: %s', async (_label, body) => {
    handler = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(body);
    };
    await expectUnavailable(client().isLiveMember(ORG, USER));
  });

  it('refuses an oversized body, declared or streamed, without reading it all', async () => {
    // A valid answer padded with JSON whitespace: read whole, it would parse and
    // say live. Only the cap refuses it.
    const padded = `${JSON.stringify(answer())}${' '.repeat(MAX_MEMBERSHIP_ANSWER_BYTES)}`;
    expect(JSON.parse(padded)).toEqual(answer());
    handler = (_request, response) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(padded),
      });
      response.end(padded);
    };
    await expectUnavailable(client().isLiveMember(ORG, USER));

    // No content-length: chunked, and the cap is counted as it arrives. The
    // server would send 32 MiB of whitespace before the closing brace; the
    // client must stop at the cap, so the server never gets to the end.
    let finished = false;
    handler = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      const head = JSON.stringify(answer()).slice(0, -1);
      const chunk = ' '.repeat(64 * 1024);
      let closed = false;
      response.on('close', () => (closed = true));
      void (async () => {
        response.write(head);
        for (let sent = 0; sent < 32 * 1024 * 1024 && !closed; sent += chunk.length) {
          if (!response.write(chunk)) {
            await new Promise<void>((resolve) => {
              response.once('drain', resolve);
              response.once('close', resolve);
            });
          }
        }
        if (!closed) {
          response.end('}');
          finished = true;
        }
      })();
    };
    await expectUnavailable(client().isLiveMember(ORG, USER));
    expect(finished).toBe(false);
  });

  it('refuses a timeout as 503, not 504: nothing has been written when it is asked', async () => {
    handler = () => {
      // Never answers.
    };
    const started = Date.now();
    await expectUnavailable(client(200).isLiveMember(ORG, USER));
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('refuses a body that stalls after the headers past the deadline', async () => {
    handler = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"userId":');
    };
    await expectUnavailable(client(200).isLiveMember(ORG, USER));
  });

  it('refuses a transport failure (nothing listening)', async () => {
    const closed = new LiveMembershipClient({
      baseUrl: 'http://127.0.0.1:9',
      timeoutMs: 2_000,
      tokens,
    });
    await expectUnavailable(closed.isLiveMember(ORG, USER));
  });
});

/**
 * PR 405 review 1, F2: a redirect is not an answer. Real `fetch`, two loopback
 * servers — identity's stand-in, which redirects, and another origin (another
 * port), which would answer exactly what was asked with `live: true` and
 * records every request that reaches it.
 */
describe('a redirect from identity (or a proxy in front of it)', () => {
  let elsewhere: Server;
  let elsewhereUrl: string;
  const reached: { url: string; token: string }[] = [];

  beforeAll(async () => {
    elsewhere = createServer((request, response) => {
      reached.push({
        url: request.url ?? '',
        token: String(request.headers['x-internal-token'] ?? ''),
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer()));
    });
    await new Promise<void>((resolve) => elsewhere.listen(0, '127.0.0.1', resolve));
    elsewhereUrl = `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    elsewhere.closeAllConnections();
    await new Promise<void>((resolve) => elsewhere.close(() => resolve()));
  });

  beforeEach(() => {
    reached.length = 0;
  });

  const redirecting =
    (status: number): Handler =>
    (request, response) => {
      response.writeHead(status, {
        location: `${elsewhereUrl}${request.url ?? '/'}`,
        'content-type': 'application/json',
      });
      // The redirect's own body says live too: it is not read either.
      response.end(JSON.stringify(answer()));
    };

  it('the other host really would say live: true (the stand-in is sound)', async () => {
    const direct = new LiveMembershipClient({ baseUrl: elsewhereUrl, timeoutMs: 2_000, tokens });
    await expect(direct.isLiveMember(ORG, USER)).resolves.toBe(true);
    expect(reached).toHaveLength(1);
  });

  it.each([301, 302, 303, 307, 308])(
    'a %s is refused as 503 after exactly one request: the other host is never asked, the token never leaves',
    async (status) => {
      handler = redirecting(status);
      await expectUnavailable(client().isLiveMember(ORG, USER));
      expect(seen).toHaveLength(1);
      expect(reached).toEqual([]);
    },
  );

  it('is refused the same way to a relative Location on identity itself', async () => {
    handler = (request, response) => {
      if (request.url?.startsWith('/moved')) return json(answer())(request, response);
      response.writeHead(302, { location: `/moved${request.url ?? ''}` });
      response.end();
    };
    await expectUnavailable(client().isLiveMember(ORG, USER));
    expect(seen).toHaveLength(1);
  });

  it('a fetch that followed one anyway is refused: its answer came from somewhere else', async () => {
    const followed = new LiveMembershipClient({
      baseUrl,
      timeoutMs: 2_000,
      tokens,
      fetch: (async () => {
        const response = new Response(JSON.stringify(answer()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
        Object.defineProperty(response, 'redirected', { value: true });
        return response;
      }) as typeof fetch,
    });
    await expectUnavailable(followed.isLiveMember(ORG, USER));
  });

  it('asks fetch not to follow: redirect is manual on every request', async () => {
    let init: RequestInit | undefined;
    const recording = new LiveMembershipClient({
      baseUrl,
      timeoutMs: 2_000,
      tokens,
      fetch: (async (_input: unknown, given?: RequestInit) => {
        init = given;
        return new Response(JSON.stringify(answer()), { status: 200 });
      }) as typeof fetch,
    });
    await recording.isLiveMember(ORG, USER);
    expect(init?.redirect).toBe('manual');
  });
});

describe('notAMember', () => {
  it('is a 422 with the closed reason on userId, the same for every way of not being a member', () => {
    const error = notAMember();
    expect(error.status).toBe(422);
    expect(error.code).toBe('BUSINESS_RULE_VIOLATION');
    expect(error.message).toBe(NOT_A_MEMBER_MESSAGE);
    expect(error.details).toEqual([
      { path: 'userId', message: NOT_A_MEMBER_MESSAGE, code: NOT_A_MEMBER },
    ]);
  });
});
