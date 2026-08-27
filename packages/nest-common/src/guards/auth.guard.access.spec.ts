import { randomBytes } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { AuthGuard, type AuthGuardOptions } from './auth.guard';
import { InternalTokenService, type TokenVerifier, type UserClaims } from '../auth/token-verifier';
import { IS_PUBLIC_KEY, ALLOW_SERVICE_KEY } from '../decorators';
import { runWithContext, tryGetContext } from '../context/request-context';
import { RastaError } from '../errors/rasta-error';

/**
 * Who may reach an endpoint, and on whose authority.
 *
 * These tests exist because the answer was wrong in production: the gateway
 * attaches an internal token to *every* forwarded request, including one from
 * a caller with no credentials at all, and the guard read that token as a
 * service-to-service call. Self-registration — the only door a new user can
 * walk through — answered 403 behind the gateway while working when called
 * directly (D-007).
 *
 * The repair has to hold both ends at once, so every case below is asserted
 * together: a relayed anonymous request reaches a public endpoint, and nothing
 * else gets any easier to reach.
 */

// Generated per run rather than written down. Nothing here should depend on a
// particular secret, and a literal that looks like one trips the secret
// scanner in CI for no benefit.
const SECRET = randomBytes(32).toString('hex');
const ISSUER = 'rasta-internal';
const THIS_SERVICE = 'identity-service';

interface Endpoint {
  publicReason?: string;
  allowService?: string[];
}

/** A Reflector that answers for one endpoint fixture. */
function reflectorFor(endpoint: Endpoint): Reflector {
  return {
    getAllAndOverride: (key: string) => {
      if (key === IS_PUBLIC_KEY) {
        return endpoint.publicReason ? { public: true, reason: endpoint.publicReason } : undefined;
      }
      if (key === ALLOW_SERVICE_KEY) return endpoint.allowService;
      return undefined;
    },
  } as unknown as Reflector;
}

function executionFor(headers: Record<string, string | undefined>): ExecutionContext {
  const request = { headers };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;
}

/** A verifier that accepts exactly one token string, so no network is needed. */
function verifierAccepting(token: string): TokenVerifier {
  return {
    verifyUserToken: async (candidate: string): Promise<UserClaims> => {
      if (candidate !== token) throw new RastaError('TOKEN_INVALID', 'Token is not valid');
      return {
        sub: 'keycloak-subject',
        rastaUserId: 'USR_01JBQ8Z4K7M2N5P8R1T3V6X9Y2',
        organizationId: 'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9YA',
        organizationIds: ['ORG_01JBQ8Z4K7M2N5P8R1T3V6X9YA'],
        roles: ['ORGANIZATION_ADMIN'],
        username: 'dehyari.admin',
        expiresAt: Date.now() + 60_000,
      };
    },
  } as unknown as TokenVerifier;
}

const internalTokens = new InternalTokenService(SECRET, ISSUER, 300);

function guardFor(endpoint: Endpoint, tokenVerifier: TokenVerifier): AuthGuard {
  const options: AuthGuardOptions = {
    serviceName: THIS_SERVICE,
    tokenVerifier,
    internalTokens,
  };
  return new AuthGuard(reflectorFor(endpoint), options);
}

/** Runs the guard inside a request context, as the middleware would. */
async function activate(
  endpoint: Endpoint,
  headers: Record<string, string | undefined>,
): Promise<{ allowed: boolean; authType?: string; callerService?: string }> {
  return runWithContext(
    {
      correlationId: 'COR_1',
      requestId: 'REQ_1',
      roles: [],
      authType: 'ANONYMOUS',
      startedAt: Date.now(),
    },
    async () => {
      const guard = guardFor(endpoint, verifierAccepting('user-token'));
      const allowed = await guard.canActivate(executionFor(headers));
      const context = tryGetContext();
      return { allowed, authType: context?.authType, callerService: context?.callerService };
    },
  );
}

// The two endpoint shapes the platform actually has today, plus the internal
// shape ADR-020 reserves for service-to-service calls.
const PUBLIC_ENDPOINT: Endpoint = { publicReason: 'Self-registration' };
const PROTECTED_ENDPOINT: Endpoint = {};
const INTERNAL_ENDPOINT: Endpoint = { allowService: ['fleet-service'] };
const INTERNAL_ENDPOINT_ANY_SERVICE: Endpoint = { allowService: [] };

function relayToken(target = THIS_SERVICE): Promise<string> {
  return internalTokens.issue('api-gateway', target, 'RELAY');
}

function serviceToken(caller = 'fleet-service', target = THIS_SERVICE): Promise<string> {
  return internalTokens.issue(caller, target, 'SERVICE');
}

describe('AuthGuard — anonymous access through the gateway (D-007)', () => {
  it('lets a relayed anonymous request reach a public endpoint', async () => {
    // The regression itself: POST /v1/registration-requests arriving via the
    // gateway with no credentials of its own.
    const result = await activate(PUBLIC_ENDPOINT, { 'x-internal-token': await relayToken() });

    expect(result.allowed).toBe(true);
    expect(result.authType).toBe('ANONYMOUS');
  });

  it('still lets a direct anonymous request reach a public endpoint', async () => {
    // Calling the service with no gateway hop at all must keep working — that
    // was the workaround while D-007 was open.
    const result = await activate(PUBLIC_ENDPOINT, {});

    expect(result.allowed).toBe(true);
    expect(result.authType).toBe('ANONYMOUS');
  });

  it('does not let a relayed anonymous request reach a protected endpoint', async () => {
    // The other half of the fix. A relay token is proof of a hop, never a
    // credential, so it must not open anything @Public does not already open.
    await expect(
      activate(PROTECTED_ENDPOINT, { 'x-internal-token': await relayToken() }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('does not let a relay token satisfy @AllowService', async () => {
    // A relay token names the gateway, and the gateway never acts on its own
    // authority. Were this to pass, anything able to reach the gateway could
    // reach every internal endpoint behind it.
    await expect(
      activate(INTERNAL_ENDPOINT_ANY_SERVICE, { 'x-internal-token': await relayToken() }),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe('AuthGuard — service-to-service authentication (ADR-020)', () => {
  it('admits a permitted service to an endpoint that names it', async () => {
    const result = await activate(INTERNAL_ENDPOINT, {
      'x-internal-token': await serviceToken('fleet-service'),
    });

    expect(result.allowed).toBe(true);
    expect(result.authType).toBe('SERVICE');
    expect(result.callerService).toBe('fleet-service');
  });

  it('refuses a service the endpoint does not name', async () => {
    await expect(
      activate(INTERNAL_ENDPOINT, {
        'x-internal-token': await serviceToken('marketplace-service'),
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('refuses a valid service token on an endpoint with no @AllowService', async () => {
    // Zero Trust: a token proves who is calling, never that the call is
    // allowed. The callee decides.
    await expect(
      activate(PROTECTED_ENDPOINT, { 'x-internal-token': await serviceToken() }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('refuses a valid service token on a public endpoint with no @AllowService', async () => {
    // @Public opens an endpoint to anonymous humans; it does not hand a
    // service the authority to act as itself there. Marking an endpoint public
    // must never become a shortcut past @AllowService.
    await expect(
      activate(PUBLIC_ENDPOINT, { 'x-internal-token': await serviceToken() }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('refuses a forged internal token', async () => {
    const forged = new InternalTokenService(randomBytes(32).toString('hex'), ISSUER, 300);
    await expect(
      activate(INTERNAL_ENDPOINT, {
        'x-internal-token': await forged.issue('fleet-service', THIS_SERVICE, 'SERVICE'),
      }),
    ).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('refuses a malformed internal token', async () => {
    await expect(
      activate(INTERNAL_ENDPOINT, { 'x-internal-token': 'not-a-jwt' }),
    ).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('refuses a relay token minted for a different service', async () => {
    // Scoping is what stops a token leaked from one hop being replayed at
    // another (ADR-020).
    await expect(
      activate(PUBLIC_ENDPOINT, { 'x-internal-token': await relayToken('economic-service') }),
    ).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('reads a token minted before the purpose claim existed as a service call', async () => {
    // Backwards compatibility must fail closed: an absent claim means SERVICE,
    // which still requires @AllowService — not RELAY, which would not.
    const legacy = await internalTokens.issue('fleet-service', THIS_SERVICE);
    const claims = await internalTokens.verify(legacy, THIS_SERVICE);

    expect(claims.purpose).toBe('SERVICE');
  });
});

describe('AuthGuard — authenticated users are unaffected', () => {
  it('authenticates a user token relayed with an internal token', async () => {
    // The ordinary gateway path: both tokens present. The user token names the
    // actor and wins; the internal token is only hop proof.
    const result = await activate(PROTECTED_ENDPOINT, {
      authorization: 'Bearer user-token',
      'x-internal-token': await relayToken(),
    });

    expect(result.allowed).toBe(true);
    expect(result.authType).toBe('USER');
  });

  it('authenticates a user token on a public endpoint rather than downgrading it', async () => {
    const result = await activate(PUBLIC_ENDPOINT, {
      authorization: 'Bearer user-token',
      'x-internal-token': await relayToken(),
    });

    expect(result.allowed).toBe(true);
    expect(result.authType).toBe('USER');
  });

  it('refuses an invalid user token even when a valid relay token accompanies it', async () => {
    // The internal token must not become a fallback that rescues a bad user
    // token — that would turn a hop proof into a credential.
    await expect(
      activate(PROTECTED_ENDPOINT, {
        authorization: 'Bearer forged-token',
        'x-internal-token': await relayToken(),
      }),
    ).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('refuses an anonymous request to a protected endpoint with no tokens at all', async () => {
    await expect(activate(PROTECTED_ENDPOINT, {})).rejects.toMatchObject({ status: 401 });
  });
});
