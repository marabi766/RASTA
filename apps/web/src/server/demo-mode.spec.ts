/**
 * @jest-environment node
 */
import { fetchDemoMode } from './demo-mode';
import type { WebSession } from './session';

/** The flag is the provider's own (Q-14): never a constant, never inferred from a failed read. */

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

async function withAnswer(body: unknown, status: number): Promise<boolean> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  try {
    return await fetchDemoMode(SESSION);
  } finally {
    globalThis.fetch = original;
  }
}

const provider = (simulated: boolean) => ({ provider: 'p', simulated, notice: 'n' });

describe('fetchDemoMode', () => {
  it('is true when the provider says it is simulated', async () => {
    await expect(withAnswer(provider(true), 200)).resolves.toBe(true);
  });

  it('is false when the provider says it is not', async () => {
    await expect(withAnswer(provider(false), 200)).resolves.toBe(false);
  });

  it('is false when the provider could not be read', async () => {
    await expect(withAnswer({}, 503)).resolves.toBe(false);
    await expect(withAnswer({ nope: 1 }, 200)).resolves.toBe(false);
  });
});
