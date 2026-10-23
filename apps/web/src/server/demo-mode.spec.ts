/**
 * @jest-environment node
 */
import { demoModeOf, type DemoMode } from '@/lib/demo-mode';
import { fetchDemoMode } from './demo-mode';
import type { WebSession } from './session';

/** The flag is the provider's own (Q-14): never a constant, and a failed read is UNKNOWN, never "not simulated". */

const SESSION: WebSession = {
  subject: 'USR_1',
  username: 'manager',
  organizationId: 'ORG_1',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: 2_000_000_000,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf',
  issuedAt: 1_900_000_000,
};

beforeEach(() => {
  Object.assign(process.env, {
    API_GATEWAY_URL: 'http://gateway.test:3000',
    OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
    OIDC_CLIENT_ID: 'rasta-web',
    WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
    WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
  });
});

/** What each call asked for: the path, and the bearer it carried. */
let asked: { url: string; authorization: string | null }[] = [];

async function withFetch(answer: () => Promise<Response>): Promise<DemoMode> {
  const original = globalThis.fetch;
  asked = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
    });
    return answer();
  }) as typeof fetch;
  try {
    return await fetchDemoMode(SESSION);
  } finally {
    globalThis.fetch = original;
  }
}

const withAnswer = (body: unknown, status: number) =>
  withFetch(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );

describe('fetchDemoMode', () => {
  it('is SIMULATED when the provider says it is simulated', async () => {
    await expect(withAnswer({ simulated: true }, 200)).resolves.toBe('SIMULATED');
  });

  it('is REAL when the provider says it is not', async () => {
    await expect(withAnswer({ simulated: false }, 200)).resolves.toBe('REAL');
  });

  it('asks the disclosure every member may read, with the session’s own bearer — not the administrators’ provider read', async () => {
    await withAnswer({ simulated: true }, 200);
    expect(asked).toEqual([
      {
        url: 'http://gateway.test:3000/v1/wallets/provider/disclosure',
        authorization: 'Bearer access-token-value',
      },
    ]);
  });

  it.each([
    ['refused', {}, 403],
    ['not found', {}, 404],
    ['unavailable', {}, 503],
    ['malformed', { nope: 1 }, 200],
    ['a flag of the wrong type', { simulated: 'true' }, 200],
  ])('is UNKNOWN, never REAL, when the read was %s', async (_how, body, status) => {
    await expect(withAnswer(body, status)).resolves.toBe('UNKNOWN');
  });

  it('is UNKNOWN when the gateway cannot be reached or does not answer in time', async () => {
    await expect(
      withFetch(async () => {
        throw new TypeError('fetch failed');
      }),
    ).resolves.toBe('UNKNOWN');
    await expect(
      withFetch(async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      }),
    ).resolves.toBe('UNKNOWN');
    await expect(withFetch(async () => new Response('not json', { status: 200 }))).resolves.toBe(
      'UNKNOWN',
    );
  });
});

describe('demoModeOf, the wallet’s read of the same flag', () => {
  it.each([
    [{ kind: 'OK', data: { simulated: true } }, 'SIMULATED'],
    [{ kind: 'OK', data: { simulated: false } }, 'REAL'],
    [{ kind: 'FORBIDDEN' }, 'UNKNOWN'],
    [{ kind: 'NOT_FOUND' }, 'UNKNOWN'],
    [{ kind: 'UNAVAILABLE', status: 503, correlationId: 'C' }, 'UNKNOWN'],
    [{ kind: 'MALFORMED', correlationId: 'C' }, 'UNKNOWN'],
  ] as const)('%j is %s', (read, mode) => {
    expect(demoModeOf(read)).toBe(mode);
  });
});
