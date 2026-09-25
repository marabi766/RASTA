import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { SignJWT } from 'jose';
import { AuthGuard, type AuthGuardOptions, type ServiceAuthorizationRefusal } from './auth.guard';
import { InternalTokenService, type TokenVerifier, type UserClaims } from '../auth/token-verifier';
import { IS_PUBLIC_KEY, ALLOW_SERVICE_KEY } from '../decorators';
import { runWithContext } from '../context/request-context';
import { RastaError } from '../errors/rasta-error';

/**
 * The guard's second observation seam: `onServiceAuthorizationRefusal`.
 *
 * A verified service token refused with `FORBIDDEN` — the endpoint carries no
 * `@AllowService`, or its allowlist excludes the caller — is thrown before
 * `request.rastaAuth` is assigned and before the request context is upgraded,
 * exactly like the user-token tenant refusal. Without the seam, a service that
 * wants that refusal as evidence would have to re-verify the internal token or
 * read a header to learn who was refused, and must do neither.
 *
 * Held to the same narrow promises as `onUserTenantMismatch`: it fires for
 * those two decisions and no other, it is given only values the guard verified
 * itself, and nothing it does can change the authorization outcome or the
 * error the caller receives.
 */

const SECRET = randomBytes(32).toString('hex');
const ISSUER = 'rasta-internal';
const THIS_SERVICE = 'identity-service';

const ORG_SIGNED = 'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9YA';
/** Never signed: what an unsigned `X-Organization-Id` header may claim. */
const ORG_HEADER = 'ORG_UNSIGNED_HEADER_SENTINEL';
const CALLER = 'fleet-service';

const internalTokens = new InternalTokenService(SECRET, ISSUER, 300);
/** Same issuer and audience, a different key: a forged token. */
const forger = new InternalTokenService(randomBytes(32).toString('hex'), ISSUER, 300);

interface Endpoint {
  publicReason?: string;
  allowService?: string[];
}

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

const userClaims: UserClaims = {
  sub: 'kc-subject',
  rastaUserId: 'USR_01JBQ8Z4K7M2N5P8R1T3V6X9Y2',
  organizationId: ORG_SIGNED,
  organizationIds: [ORG_SIGNED],
  roles: ['FLEET_MANAGER'],
  organizationRoles: [`${ORG_SIGNED}:FLEET_MANAGER`],
  username: 'fleet.manager',
  expiresAt: Date.now() + 60_000,
};

const tokenVerifier = {
  verifyUserToken: async (candidate: string): Promise<UserClaims> => {
    if (candidate !== 'user-token') throw new RastaError('TOKEN_INVALID', 'Token is not valid');
    return userClaims;
  },
} as unknown as TokenVerifier;

interface Attempt {
  seen: ServiceAuthorizationRefusal[];
  error?: unknown;
  allowed?: boolean;
}

/**
 * Runs the guard as the middleware does, with an observer attached unless
 * `observe` is null — which is how every service that does not opt in is
 * configured.
 */
async function attempt(
  headers: Record<string, string | undefined>,
  options: {
    endpoint?: Endpoint;
    observe?: ((refusal: ServiceAuthorizationRefusal) => void) | null;
  } = {},
): Promise<Attempt> {
  const seen: ServiceAuthorizationRefusal[] = [];
  const observer = options.observe;

  const guardOptions: AuthGuardOptions = {
    serviceName: THIS_SERVICE,
    tokenVerifier,
    internalTokens,
    ...(observer === null
      ? {}
      : {
          // The observer's own return value passes straight through, so a
          // rejected promise really does reach the guard.
          onServiceAuthorizationRefusal: ((refusal: ServiceAuthorizationRefusal): unknown => {
            seen.push(refusal);
            return observer?.(refusal);
          }) as (refusal: ServiceAuthorizationRefusal) => void,
        }),
  };

  const guard = new AuthGuard(reflectorFor(options.endpoint ?? {}), guardOptions);

  return runWithContext(
    {
      correlationId: 'COR_1',
      requestId: 'REQ_1',
      roles: [],
      organizationIds: [],
      authType: 'ANONYMOUS',
      startedAt: Date.now(),
    },
    async () => {
      try {
        return { seen, allowed: await guard.canActivate(executionFor(headers)) };
      } catch (error) {
        return { seen, error };
      }
    },
  );
}

const serviceHeaders = async (
  caller = CALLER,
  /** `null` mints a platform-wide token with no signed tenant. */
  organizationId: string | null = ORG_SIGNED,
  extra: Record<string, string> = {},
): Promise<Record<string, string>> => ({
  'x-internal-token': await internalTokens.issue(
    caller,
    THIS_SERVICE,
    'SERVICE',
    organizationId ?? undefined,
  ),
  ...extra,
});

describe('AuthGuard — observing its verified service authorization refusals', () => {
  describe('fires for both FORBIDDEN decisions made after internal-token verification', () => {
    it('an endpoint with no @AllowService at all', async () => {
      const { seen, error } = await attempt(await serviceHeaders());

      expect((error as RastaError).code).toBe('FORBIDDEN');
      expect((error as RastaError).status).toBe(403);
      expect(seen).toHaveLength(1);

      const refusal = seen[0]!;
      // The identical object the caller is refused with, so an observer can
      // mark *this* refusal.
      expect(refusal.error).toBe(error);
      expect(refusal.callerService).toBe(CALLER);
      expect(refusal.organizationId).toBe(ORG_SIGNED);
      expect(Object.keys(refusal).sort()).toEqual(['callerService', 'error', 'organizationId']);
      expect(Object.isFrozen(refusal)).toBe(true);
    });

    it('an @AllowService allowlist that excludes the verified caller', async () => {
      const { seen, error } = await attempt(await serviceHeaders('notification-service'), {
        endpoint: { allowService: ['fleet-service'] },
      });

      expect((error as RastaError).code).toBe('FORBIDDEN');
      expect(seen).toHaveLength(1);
      expect(seen[0]!.error).toBe(error);
      expect(seen[0]!.callerService).toBe('notification-service');
      expect(seen[0]!.organizationId).toBe(ORG_SIGNED);
    });

    it('reports a platform-wide service token as having no tenant, rather than inventing one', async () => {
      const { seen, error } = await attempt(await serviceHeaders(CALLER, null));

      expect((error as RastaError).code).toBe('FORBIDDEN');
      expect(seen).toHaveLength(1);
      expect(seen[0]!.organizationId).toBeUndefined();
    });

    it('never hands over the unsigned header, the token or the error’s own context', async () => {
      const headers = await serviceHeaders(CALLER, null, { 'x-organization-id': ORG_HEADER });
      const { seen, error } = await attempt(headers);

      // FORBIDDEN precedes the header/claim check, so the header is not even
      // compared — and it is certainly not attribution.
      expect((error as RastaError).code).toBe('FORBIDDEN');
      const { error: _error, ...attribution } = seen[0]!;
      const serialised = JSON.stringify(attribution);
      expect(serialised).not.toContain(ORG_HEADER);
      expect(serialised).not.toContain(headers['x-internal-token']!);
      expect(seen[0]!.organizationId).toBeUndefined();
    });
  });

  describe('does not fire for anything that is not that refusal', () => {
    it('an accepted service call', async () => {
      const { seen, allowed } = await attempt(await serviceHeaders(), {
        endpoint: { allowService: [CALLER] },
      });

      expect(allowed).toBe(true);
      expect(seen).toHaveLength(0);
    });

    it('an accepted service call to an endpoint open to every service', async () => {
      const { seen, allowed } = await attempt(await serviceHeaders(), {
        endpoint: { allowService: [] },
      });

      expect(allowed).toBe(true);
      expect(seen).toHaveLength(0);
    });

    it('a forged internal token', async () => {
      const { seen, error } = await attempt(
        { 'x-internal-token': await forger.issue(CALLER, THIS_SERVICE, 'SERVICE', ORG_SIGNED) },
        { endpoint: {} },
      );

      expect((error as RastaError).status).toBe(401);
      expect(seen).toHaveLength(0);
    });

    it('an expired internal token', async () => {
      // Signed with the right key, but expired well beyond the verifier's clock
      // tolerance.
      const nowSeconds = Math.floor(Date.now() / 1000);
      const token = await new SignJWT({ svc: CALLER, purpose: 'SERVICE', org_id: ORG_SIGNED })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuer(ISSUER)
        .setAudience(THIS_SERVICE)
        .setSubject(CALLER)
        .setIssuedAt(nowSeconds - 600)
        .setExpirationTime(nowSeconds - 300)
        .sign(new TextEncoder().encode(SECRET));

      const { seen, error } = await attempt({ 'x-internal-token': token });

      expect((error as RastaError).status).toBe(401);
      expect(seen).toHaveLength(0);
    });

    it('a token minted for another service', async () => {
      const { seen, error } = await attempt({
        'x-internal-token': await internalTokens.issue(CALLER, 'asset-service', 'SERVICE'),
      });

      expect((error as RastaError).status).toBe(401);
      expect(seen).toHaveLength(0);
    });

    it('a RELAY token to a non-public endpoint', async () => {
      const { seen, error } = await attempt({
        'x-internal-token': await internalTokens.issue('api-gateway', THIS_SERVICE, 'RELAY'),
      });

      expect((error as RastaError).status).toBe(401);
      expect(seen).toHaveLength(0);
    });

    it('a RELAY token to a public endpoint', async () => {
      const { seen, allowed } = await attempt(
        { 'x-internal-token': await internalTokens.issue('api-gateway', THIS_SERVICE, 'RELAY') },
        { endpoint: { publicReason: 'Self-registration' } },
      );

      expect(allowed).toBe(true);
      expect(seen).toHaveLength(0);
    });

    it("a service token's SERVICE_TENANT_CONTEXT_INVALID", async () => {
      const { seen, error } = await attempt(
        await serviceHeaders(CALLER, ORG_SIGNED, { 'x-organization-id': ORG_HEADER }),
        { endpoint: { allowService: [CALLER] } },
      );

      expect((error as RastaError).code).toBe('SERVICE_TENANT_CONTEXT_INVALID');
      expect((error as RastaError).status).toBe(403);
      expect(seen).toHaveLength(0);
    });

    it('a user-token tenant refusal', async () => {
      const { seen, error } = await attempt({
        authorization: 'Bearer user-token',
        'x-organization-id': ORG_HEADER,
      });

      expect((error as RastaError).code).toBe('TENANT_MISMATCH');
      expect(seen).toHaveLength(0);
    });

    it('an invalid user token and a missing token', async () => {
      const forged = await attempt({ authorization: 'Bearer forged' });
      const missing = await attempt({});

      expect((forged.error as RastaError).code).toBe('TOKEN_INVALID');
      expect((missing.error as RastaError).status).toBe(401);
      expect([...forged.seen, ...missing.seen]).toHaveLength(0);
    });

    it('a user token accompanied by a service token, which the user token wins', async () => {
      const { seen, allowed } = await attempt({
        authorization: 'Bearer user-token',
        ...(await serviceHeaders()),
      });

      expect(allowed).toBe(true);
      expect(seen).toHaveLength(0);
    });

    it('the user-token seam, which a service refusal never reaches', async () => {
      const userSeen: unknown[] = [];
      const guard = new AuthGuard(reflectorFor({}), {
        serviceName: THIS_SERVICE,
        tokenVerifier,
        internalTokens,
        onUserTenantMismatch: (refusal) => userSeen.push(refusal),
      });

      await expect(guard.canActivate(executionFor(await serviceHeaders()))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(userSeen).toHaveLength(0);
    });
  });

  describe('cannot affect the refusal', () => {
    const cases: [string, Endpoint][] = [
      ['no @AllowService', {}],
      ['an allowlist excluding the caller', { allowService: ['asset-service'] }],
    ];

    it.each(cases)(
      'an absent seam leaves the refusal exactly as it was: %s',
      async (_l, endpoint) => {
        const headers = await serviceHeaders();
        const observed = (await attempt(headers, { endpoint })).error as RastaError;
        const without = await attempt(headers, { endpoint, observe: null });
        const plain = without.error as RastaError;

        expect(without.seen).toHaveLength(0);
        expect(observed.constructor).toBe(plain.constructor);
        expect([observed.status, observed.code, observed.message]).toEqual([
          plain.status,
          plain.code,
          plain.message,
        ]);
        expect(observed.internalContext).toEqual(plain.internalContext);
        expect(Object.keys(observed).sort()).toEqual(Object.keys(plain).sort());
        expect(JSON.stringify(observed)).toBe(JSON.stringify(plain));
      },
    );

    it.each(cases)('a throwing observer is swallowed: %s', async (_l, endpoint) => {
      const thrown = new Error('observer exploded');
      const headers = await serviceHeaders();
      const { seen, error, allowed } = await attempt(headers, {
        endpoint,
        observe: () => {
          throw thrown;
        },
      });
      const plain = (await attempt(headers, { endpoint, observe: null })).error;

      expect(allowed).toBeUndefined();
      expect(error).not.toBe(thrown);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.error).toBe(error);
      expect((error as RastaError).code).toBe('FORBIDDEN');
      expect(JSON.stringify(error)).toBe(JSON.stringify(plain));
    });

    it.each(cases)(
      'a rejecting async observer is swallowed, with no unhandled rejection: %s',
      async (_l, endpoint) => {
        const unhandled: unknown[] = [];
        const listener = (reason: unknown): void => {
          unhandled.push(reason);
        };
        process.on('unhandledRejection', listener);
        try {
          const { error, allowed } = await attempt(await serviceHeaders(), {
            endpoint,
            observe: (() => Promise.reject(new Error('async observer failed'))) as unknown as (
              refusal: ServiceAuthorizationRefusal,
            ) => void,
          });

          expect(allowed).toBeUndefined();
          expect((error as RastaError).code).toBe('FORBIDDEN');
          await new Promise((resolve) => setTimeout(resolve, 10));
          expect(unhandled).toEqual([]);
        } finally {
          process.off('unhandledRejection', listener);
        }
      },
    );

    it('an observer cannot admit the refused call', async () => {
      const { allowed, error } = await attempt(await serviceHeaders(), {
        observe: () => true as unknown as void,
      });

      expect(allowed).toBeUndefined();
      expect((error as RastaError).status).toBe(403);
    });
  });

  it('keeps the shared package free of any service-specific dependency (A-03)', () => {
    const source = readFileSync(join(__dirname, 'auth.guard.ts'), 'utf8');
    const imports = source
      .split('\n')
      .filter((line) => line.trimStart().startsWith('import '))
      .join('\n');

    expect(imports).not.toMatch(/identity|audit|refusal|security-event/i);
  });
});
