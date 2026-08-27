import { decodeJwt } from 'jose';
import { InternalTokenService, runWithContext } from '@rasta/nest-common';
import { ProxyService } from './proxy.service';
import type { ServiceUrls } from '../config/routes';

/**
 * What the gateway puts on the wire when it forwards a request.
 *
 * The internal token is the security-critical part. It says two things at
 * once — which hop this is, and on whose authority it acts — and conflating
 * them is what broke self-registration behind the gateway (D-007). The
 * gateway relays; it never acts as itself.
 */

const SECRET = 'a-test-internal-secret-of-at-least-32-chars';
const internalTokens = new InternalTokenService(SECRET, 'rasta-internal', 300);

const urls = { IDENTITY_SERVICE_URL: 'http://identity.test:3101' } as unknown as ServiceUrls;

function proxy(): ProxyService {
  return new ProxyService(urls, internalTokens, {
    timeoutMs: 1000,
    failureThreshold: 5,
    resetAfterMs: 1000,
  });
}

/** Forwards one request against a stubbed fetch and returns the sent headers. */
async function forwardAndCaptureHeaders(context: {
  userId?: string;
  roles: string[];
  authType: 'USER' | 'ANONYMOUS';
}): Promise<Record<string, string>> {
  let sent: Record<string, string> = {};

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent = init.headers as Record<string, string>;
    return new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;

  try {
    await runWithContext(
      {
        correlationId: 'COR_1',
        requestId: 'REQ_1',
        startedAt: Date.now(),
        ...context,
      },
      () =>
        proxy().forward({
          service: 'identity',
          method: 'POST',
          path: '/v1/registration-requests',
          query: '',
          headers: {},
          body: { nationalId: '1234567890' },
        }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  return sent;
}

describe('ProxyService — the internal token it mints', () => {
  it('marks an anonymous forward as a relay, not a service call', async () => {
    // Without this the downstream reads the gateway hop proof as a
    // service-to-service call and refuses every public endpoint (D-007).
    const headers = await forwardAndCaptureHeaders({ roles: [], authType: 'ANONYMOUS' });
    const claims = decodeJwt(headers['x-internal-token']);

    expect(claims['purpose']).toBe('RELAY');
  });

  it('marks an authenticated forward as a relay too', async () => {
    // The gateway has no authority of its own on any request. Keeping this
    // unconditional means no future route can accidentally mint a token that
    // satisfies @AllowService downstream (ADR-020).
    const headers = await forwardAndCaptureHeaders({
      userId: 'USR_1',
      roles: ['ORGANIZATION_ADMIN'],
      authType: 'USER',
    });
    const claims = decodeJwt(headers['x-internal-token']);

    expect(claims['purpose']).toBe('RELAY');
  });

  it('scopes the token to the service it is calling', async () => {
    const headers = await forwardAndCaptureHeaders({ roles: [], authType: 'ANONYMOUS' });
    const claims = decodeJwt(headers['x-internal-token']);

    expect(claims.aud).toBe('identity-service');
    expect(claims.sub).toBe('api-gateway');
  });

  it('sends no user headers for an anonymous request', async () => {
    // An anonymous caller must not arrive downstream wearing somebody's
    // identity because a previous request left it behind.
    const headers = await forwardAndCaptureHeaders({ roles: [], authType: 'ANONYMOUS' });

    expect(headers['x-user-id']).toBeUndefined();
    expect(headers['x-user-roles']).toBeUndefined();
    expect(headers['x-organization-id']).toBeUndefined();
  });
});
