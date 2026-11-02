/**
 * @jest-environment node
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { REDIRECT_CASES, withRedirectProbe, type RedirectProbe } from '@rasta/testing';
import { z } from 'zod';

import { actingAccessToken } from '@/test/session-token';

import { CredentialRedirectRefusedError } from './credential-fetch';
import {
  callGateway,
  GatewayNeverSentError,
  GatewayOutcomeUnknownError,
  GatewayRequestError,
} from './gateway';
import { revokeMembership } from './members';
import { endpointsFor, exchangeCode, OidcError, refreshTokens } from './oidc';
import { processRefreshCoordinator } from './refresh-coordinator';
import { sealSession, type WebSession } from './session';
import { REJECTION_GRACE_MS, renewSession } from './session-refresh';
import { issueDisputeCommand } from './transactions';
import { writeThroughGateway } from './write';

/**
 * Q-155: no credential-bearing request this portal sends follows a redirect.
 *
 * Real HTTP, two origins (`withRedirectProbe`): the first answers every status
 * Fetch would follow, same-origin and cross-origin, and the redirect target
 * would answer with a body the caller accepts. The target must receive nothing
 * — no bearer token, no write body or key, no authorization code, PKCE verifier
 * or refresh token — and the caller must land on its existing fixed failure:
 * a write is unconfirmed (`UNKNOWN_OUTCOME`, never `neverSent` or a refusal), a
 * token request is `TOKEN_REQUEST_FAILED` (never `INVALID_GRANT`). No log line
 * and no surfaced error names the credential, either origin, the Location or
 * the redirect's body.
 */

const ENV = {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
};
beforeEach(() => {
  Object.assign(process.env, ENV);
});

const ACCESS_TOKEN = actingAccessToken('ORG_01J8');
const REFRESH_TOKEN = 'refresh-sentinel-5b1e';
const CODE = 'code-sentinel-c0de';
const VERIFIER = 'verifier-sentinel-9a7d';
const BODY_TEXT = 'body-sentinel-reason';
const REDIRECT_BODY = 'redirect-body-must-not-be-trusted';
const SENTINELS = [
  ACCESS_TOKEN,
  REFRESH_TOKEN,
  CODE,
  VERIFIER,
  BODY_TEXT,
  REDIRECT_BODY,
  '127.0.0.1',
  'redirect-target',
];

function session(overrides: Partial<WebSession> = {}): WebSession {
  return {
    subject: 'USR_01J8',
    username: 'dehyar',
    organizationId: 'ORG_01J8',
    accessToken: ACCESS_TOKEN,
    accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
    refreshToken: REFRESH_TOKEN,
    csrfToken: 'csrf',
    issuedAt: Math.floor(Date.now() / 1000) - 60,
    ...overrides,
  };
}

/** Everything the console and the process streams received while `work` ran. */
async function withCapturedOutput<T>(work: () => Promise<T>): Promise<{ result: T; logs: string }> {
  const lines: string[] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) =>
    jest.spyOn(console, name).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    }),
  );
  const streams = [process.stdout, process.stderr].map((stream) =>
    jest.spyOn(stream, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }),
  );
  try {
    return { result: await work(), logs: lines.join('\n') };
  } finally {
    for (const spy of [...spies, ...streams]) spy.mockRestore();
  }
}

/** Neither the logs nor anything the caller can surface names a sentinel. */
function expectNothingDisclosed(surfaced: unknown, logs: string): void {
  const error = surfaced as { message?: unknown; stack?: unknown; cause?: unknown } | null;
  const text = [
    logs,
    JSON.stringify(surfaced),
    String(error?.message),
    String(error?.stack),
    String(error?.cause),
  ].join('\n');
  for (const sentinel of SENTINELS) expect(text).not.toContain(sentinel);
}

/** The writer reads the gateway from its environment; this sends that URL to the probe. */
const toProbe = (probe: RedirectProbe): typeof fetch =>
  ((input: string | URL | Request, init?: RequestInit) =>
    probe.fetch(String(input).replace(ENV.API_GATEWAY_URL, probe.baseUrl), init)) as typeof fetch;

const settled = <T>(promise: Promise<T>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error('a redirect must not be an answer');
    },
    (error: unknown) => error,
  );

describe('gateway calls carry the bearer token to the gateway only', () => {
  const bodies: string[] = [];
  const onRequest = (_request: unknown, body: string) => void bodies.push(body);
  beforeEach(() => {
    bodies.length = 0;
  });

  describe.each(REDIRECT_CASES)('$status, sameOrigin=$sameOrigin', ({ status, sameOrigin }) => {
    it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const)(
      '%s is refused unconfirmed; the target receives nothing',
      async (method) => {
        await withRedirectProbe(
          { status, sameOrigin, body: { id: 'X' }, onRequest },
          async (probe) => {
            const write = method !== 'GET';
            const { result: error, logs } = await withCapturedOutput(() =>
              settled(
                callGateway({
                  baseUrl: probe.baseUrl,
                  path: '/v1/memberships/MEM_1/revoke',
                  accessToken: ACCESS_TOKEN,
                  method,
                  correlationId: 'corr-1',
                  ...(write
                    ? {
                        body: { reason: BODY_TEXT },
                        idempotencyKey: 'submission-1',
                        replayDeadline: 4_102_444_800_000,
                      }
                    : {}),
                  fetchImpl: probe.fetch,
                }),
              ),
            );
            // The existing "sent, no judgeable answer" failure: unknown, never "never sent".
            expect(error).toBeInstanceOf(GatewayOutcomeUnknownError);
            expect(error).not.toBeInstanceOf(GatewayNeverSentError);
            expect(error).toMatchObject({
              status: 503,
              reason: 'TRANSPORT',
              correlationId: 'corr-1',
            });
            expect(probe.target).toEqual([]);
            // Sent once, as given: credentials, correlation and replay identity intact.
            expect(probe.sent).toHaveLength(1);
            expect(probe.sent[0]?.method).toBe(method);
            expect(probe.sent[0]?.headers).toMatchObject({
              authorization: `Bearer ${ACCESS_TOKEN}`,
              'x-correlation-id': 'corr-1',
              ...(write
                ? {
                    'idempotency-key': 'submission-1',
                    'idempotency-replay-deadline': '4102444800000',
                  }
                : {}),
            });
            expect(bodies).toEqual([write ? JSON.stringify({ reason: BODY_TEXT }) : '']);
            expectNothingDisclosed(error, logs);
          },
        );
      },
    );

    it('a membership revocation (z.unknown()) is UNKNOWN_OUTCOME, never CREATED', async () => {
      await withRedirectProbe({ status, sameOrigin, body: { revoked: true } }, async (probe) => {
        const { result, logs } = await withCapturedOutput(() =>
          revokeMembership(
            session(),
            { membershipId: 'MEM_1', reason: BODY_TEXT },
            'submission-1',
            toProbe(probe),
          ),
        );
        expect(result).toEqual({ kind: 'UNKNOWN_OUTCOME', correlationId: expect.any(String) });
        expect(probe.target).toEqual([]);
        expect(probe.sent).toHaveLength(1);
        expectNothingDisclosed(result, logs);
      });
    });

    it('a dispute on a transaction (money path) is UNKNOWN_OUTCOME, never CREATED', async () => {
      await withRedirectProbe(
        { status, sameOrigin, body: { id: 'TX_1', status: 'DISPUTED' } },
        async (probe) => {
          const { result, logs } = await withCapturedOutput(() =>
            issueDisputeCommand(
              session(),
              'TX_1',
              { command: 'DISPUTE', body: { reason: BODY_TEXT } },
              'submission-1',
              toProbe(probe),
            ),
          );
          expect(result).toEqual({ kind: 'UNKNOWN_OUTCOME', correlationId: expect.any(String) });
          expect(probe.target).toEqual([]);
          expectNothingDisclosed(result, logs);
        },
      );
    });
  });

  it('303 to a successful GET (the reviewer case) never confirms a revocation', async () => {
    await withRedirectProbe({ status: 303, sameOrigin: true, body: {} }, async (probe) => {
      const result = await revokeMembership(
        session(),
        { membershipId: 'MEM_1', reason: BODY_TEXT },
        'submission-1',
        toProbe(probe),
      );
      expect(result.kind).toBe('UNKNOWN_OUTCOME');
      expect(probe.target).toEqual([]);
    });
  });

  it('recovery resends the same key, body and replay deadline, and no retry is added', async () => {
    await withRedirectProbe(
      { status: 307, body: { id: 'TX_1', status: 'DISPUTED' }, onRequest },
      async (probe) => {
        const write = () =>
          writeThroughGateway(session(), {
            path: '/v1/transactions/TX_1/dispute',
            body: { reason: BODY_TEXT },
            submissionId: 'submission-1',
            replayDeadline: 4_102_444_800_000,
            schema: z.unknown(),
            mapping: { paths: {}, messages: {} },
            fetchImpl: toProbe(probe),
          });
        expect((await write()).kind).toBe('UNKNOWN_OUTCOME');
        // One exchange per submission: the refusal itself sends nothing more.
        expect(probe.sent).toHaveLength(1);
        probe.recover();
        expect((await write()).kind).toBe('CREATED');
        expect(probe.sent).toHaveLength(2);
        const identity = probe.sent.map(({ headers }) => [
          headers['idempotency-key'],
          headers['idempotency-replay-deadline'],
        ]);
        expect(identity).toEqual([
          ['submission-1', '4102444800000'],
          ['submission-1', '4102444800000'],
        ]);
        expect(bodies).toEqual([
          JSON.stringify({ reason: BODY_TEXT }),
          JSON.stringify({ reason: BODY_TEXT }),
        ]);
        expect(probe.target).toEqual([]);
      },
    );
  });
});

describe('non-redirect statuses keep their meaning', () => {
  let server: Server;
  let baseUrl: string;
  let answer: { status: number; headers?: Record<string, string>; body?: string };
  beforeAll(async () => {
    server = createServer((req, res) => {
      req.resume();
      res.writeHead(answer.status, answer.headers).end(answer.body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const call = (method: 'GET' | 'POST' = 'GET') =>
    callGateway<unknown>({ baseUrl, path: '/v1/x', accessToken: ACCESS_TOKEN, method });

  it('304 is the platform status it always was: a GatewayRequestError(304), not an unknown', async () => {
    answer = { status: 304, headers: { etag: '"v1"' } };
    const error = await settled(call());
    expect(error).toBeInstanceOf(GatewayRequestError);
    expect(error).not.toBeInstanceOf(GatewayOutcomeUnknownError);
    expect((error as GatewayRequestError).status).toBe(304);
  });

  it('201 with a Location is a success whose body is read', async () => {
    answer = {
      status: 201,
      headers: { location: '/v1/x/1', 'content-type': 'application/json' },
      body: '{"id":"1"}',
    };
    expect((await call('POST')).data).toEqual({ id: '1' });
  });

  it.each([300, 305, 399])(
    '%i is not navigated: a GatewayRequestError with that status',
    async (status) => {
      answer = { status, headers: { location: '/elsewhere' } };
      const error = await settled(call());
      expect(error).not.toBeInstanceOf(GatewayOutcomeUnknownError);
      expect((error as GatewayRequestError).status).toBe(status);
    },
  );
});

describe('gateway request shape is unchanged', () => {
  it('sends the same headers, cache and deadline signal, with redirects manual', async () => {
    const seen: RequestInit[] = [];
    await callGateway({
      baseUrl: 'http://gateway.test:3000',
      path: '/v1/x',
      accessToken: ACCESS_TOKEN,
      method: 'POST',
      body: { a: 1 },
      correlationId: 'corr-1',
      idempotencyKey: 'submission-1',
      replayDeadline: 4_102_444_800_000,
      fetchImpl: (async (_input: unknown, init?: RequestInit) => {
        seen.push(init ?? {});
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
    expect(seen).toEqual([
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${ACCESS_TOKEN}`,
          'x-correlation-id': 'corr-1',
          'content-type': 'application/json',
          'idempotency-key': 'submission-1',
          'idempotency-replay-deadline': '4102444800000',
        },
        body: '{"a":1}',
        cache: 'no-store',
        signal: expect.any(AbortSignal),
        redirect: 'manual',
      },
    ]);
  });
});

describe('token requests carry the code, verifier or refresh token to the token endpoint only', () => {
  const TOKENS = {
    access_token: 'followed-access',
    refresh_token: 'followed-refresh',
    id_token: 'followed-id',
    expires_in: 300,
    token_type: 'Bearer',
  };
  const bodies: string[] = [];
  const onRequest = (_request: unknown, body: string) => void bodies.push(body);
  beforeEach(() => {
    bodies.length = 0;
  });

  const grants = {
    'authorization code': (probe: RedirectProbe) =>
      exchangeCode(
        {
          endpoints: endpointsFor(`${probe.baseUrl}/realms/rasta`),
          clientId: 'rasta-web',
          redirectUri: 'http://localhost:3200/auth/callback',
          code: CODE,
          verifier: VERIFIER,
        },
        probe.fetch,
      ),
    'refresh token': (probe: RedirectProbe) =>
      refreshTokens(
        {
          endpoints: endpointsFor(`${probe.baseUrl}/realms/rasta`),
          clientId: 'rasta-web',
          refreshToken: REFRESH_TOKEN,
        },
        probe.fetch,
      ),
  };

  describe.each(REDIRECT_CASES)('$status, sameOrigin=$sameOrigin', ({ status, sameOrigin }) => {
    it.each(Object.keys(grants) as (keyof typeof grants)[])(
      '%s: TOKEN_REQUEST_FAILED; nothing reaches the target',
      async (grant) => {
        // Following would read either real tokens or a terminal invalid_grant from the target.
        for (const [body, targetStatus] of [
          [TOKENS, 200],
          [{ error: 'invalid_grant' }, 400],
        ] as const) {
          bodies.length = 0;
          await withRedirectProbe(
            { status, sameOrigin, body, targetStatus, onRequest },
            async (probe) => {
              const { result: error, logs } = await withCapturedOutput(() =>
                settled(grants[grant](probe)),
              );
              expect(error).toBeInstanceOf(OidcError);
              expect((error as OidcError).reason).toBe('TOKEN_REQUEST_FAILED');
              expect((error as Error).message).toBe(
                'TOKEN_REQUEST_FAILED: the identity provider answered with a redirect',
              );
              expect(probe.target).toEqual([]);
              expect(probe.sent).toHaveLength(1);
              // It was sent, once, to the token endpoint and nowhere else.
              const form = new URLSearchParams(bodies[0]);
              if (grant === 'refresh token') expect(form.get('refresh_token')).toBe(REFRESH_TOKEN);
              else expect([form.get('code'), form.get('code_verifier')]).toEqual([CODE, VERIFIER]);
              expectNothingDisclosed(error, logs);
            },
          );
        }
      },
    );
  });

  it('the transport refusal itself is not forwarded as the cause', async () => {
    await withRedirectProbe({ status: 308, body: TOKENS }, async (probe) => {
      const error = await settled(grants['refresh token'](probe));
      expect((error as Error).cause).toBeUndefined();
      expect(error).not.toBeInstanceOf(CredentialRedirectRefusedError);
    });
  });
});

describe('a redirected refresh keeps the session and sends nothing expired onward', () => {
  // One coordinator per case, as in a process: a remembered rejection would end the session.
  let coordinator = processRefreshCoordinator();
  beforeEach(() => {
    coordinator = processRefreshCoordinator();
  });
  const renewal = (probe: RedirectProbe, overrides: Partial<WebSession>, now: number) =>
    renewSession(sealSession(session(overrides), ENV.WEB_SESSION_SECRET), {
      env: {
        OIDC_ISSUER_URL: `${probe.baseUrl}/realms/rasta`,
        OIDC_CLIENT_ID: 'rasta-web',
        WEB_SESSION_SECRET: ENV.WEB_SESSION_SECRET,
        WEB_SESSION_MAX_AGE_SECONDS: 12 * 60 * 60,
      },
      coordinator,
      now,
    });

  it.each(REDIRECT_CASES)(
    '$status sameOrigin=$sameOrigin: REFUSED, never ENDED, even past the rejection grace',
    async ({ status, sameOrigin }) => {
      await withRedirectProbe(
        { status, sameOrigin, body: { error: 'invalid_grant' }, targetStatus: 400 },
        async (probe) => {
          const nowSeconds = Math.floor(Date.now() / 1000);
          // Expiring soon, still valid: usable now, nothing refreshed.
          const expiring = { accessTokenExpiresAt: nowSeconds + 20 };
          expect(await renewal(probe, expiring, Date.now())).toEqual({
            kind: 'REFUSED',
            usable: true,
          });
          // Already expired: the session stays, but its token is not used for this request.
          const expired = { accessTokenExpiresAt: nowSeconds - 1 };
          expect(await renewal(probe, expired, Date.now())).toEqual({
            kind: 'REFUSED',
            usable: false,
          });
          // A redirect is never remembered as a rejection: no ENDED after the grace.
          const later = Date.now() + REJECTION_GRACE_MS + 1_000;
          expect(await renewal(probe, expired, later)).toEqual({ kind: 'REFUSED', usable: false });
          expect(probe.target).toEqual([]);
        },
      );
    },
  );
});
