import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { AuthGuard, type AuthGuardOptions, type UserTenantMismatch } from './auth.guard';
import { InternalTokenService, type TokenVerifier, type UserClaims } from '../auth/token-verifier';
import { IS_PUBLIC_KEY, ALLOW_SERVICE_KEY } from '../decorators';
import { runWithContext } from '../context/request-context';
import { RastaError } from '../errors/rasta-error';

/**
 * The guard's one observation seam: `onUserTenantMismatch`.
 *
 * It exists because the refusal it reports is thrown *before* the guard assigns
 * `request.rastaAuth` or upgrades the request context, so nothing downstream
 * can learn who was refused without re-verifying the token or trusting the
 * header — and a service that wants to keep that refusal as audit evidence must
 * not do either.
 *
 * What these tests hold to is therefore narrow and exact: the seam fires for
 * that one decision and no other, it is given only verified values, and
 * whatever it does — nothing, throwing, rejecting — the authorization outcome
 * and the error the caller receives are untouched.
 */

const SECRET = randomBytes(32).toString('hex');
const ISSUER = 'rasta-internal';
const THIS_SERVICE = 'identity-service';

const ORG_A = 'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9YA';
const ORG_B = 'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9YB';
/** Never a membership: the organization an attacker asks for. */
const ORG_FOREIGN = 'ORG_FOREIGN_HEADER_SENTINEL';
const USER_ID = 'USR_01JBQ8Z4K7M2N5P8R1T3V6X9Y2';
const SUBJECT = 'keycloak-subject';

const internalTokens = new InternalTokenService(SECRET, ISSUER, 300);

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

/** A verifier that accepts one token string and answers with `claims`. */
function verifierFor(token: string, claims: UserClaims): TokenVerifier {
  return {
    verifyUserToken: async (candidate: string): Promise<UserClaims> => {
      if (candidate !== token) throw new RastaError('TOKEN_INVALID', 'Token is not valid');
      return claims;
    },
  } as unknown as TokenVerifier;
}

const memberOfA = (overrides: Partial<UserClaims> = {}): UserClaims => ({
  sub: SUBJECT,
  rastaUserId: USER_ID,
  organizationId: ORG_A,
  organizationIds: [ORG_A, ORG_B],
  roles: ['FLEET_MANAGER', 'ORGANIZATION_ADMIN'],
  username: 'dehyari.admin',
  expiresAt: Date.now() + 60_000,
  ...overrides,
});

interface Attempt {
  seen: UserTenantMismatch[];
  error?: unknown;
  allowed?: boolean;
}

/**
 * Runs the guard the way the middleware does, with an observer attached unless
 * `observe` is null — which is how every other service is configured.
 */
async function attempt(
  headers: Record<string, string | undefined>,
  options: {
    endpoint?: Endpoint;
    claims?: UserClaims;
    observe?: ((refusal: UserTenantMismatch) => void) | null;
  } = {},
): Promise<Attempt> {
  const seen: UserTenantMismatch[] = [];
  const claims = options.claims ?? memberOfA();
  const observer = options.observe;

  const guardOptions: AuthGuardOptions = {
    serviceName: THIS_SERVICE,
    tokenVerifier: verifierFor('user-token', claims),
    internalTokens,
    ...(observer === null
      ? {}
      : {
          // The observer's own return value is passed straight through, so a
          // case that hands back a rejected promise really does hand one to
          // the guard rather than to this wrapper.
          onUserTenantMismatch: ((refusal: UserTenantMismatch): unknown => {
            seen.push(refusal);
            return observer?.(refusal);
          }) as (refusal: UserTenantMismatch) => void,
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

const bearer = { authorization: 'Bearer user-token' };

describe('AuthGuard — observing its own user-token tenant refusal', () => {
  it('reports exactly one refusal, with the verified caller and nothing else', async () => {
    const { seen, error } = await attempt({ ...bearer, 'x-organization-id': ORG_FOREIGN });

    expect(seen).toHaveLength(1);
    const refusal = seen[0]!;

    // The identical object the caller is refused with — not a copy, so an
    // observer can mark *this* refusal.
    expect(refusal.error).toBe(error);
    expect(refusal.error).toBeInstanceOf(RastaError);
    expect(refusal.error.code).toBe('TENANT_MISMATCH');

    // Trusted attribution, and only trusted attribution.
    expect(refusal.userId).toBe(USER_ID);
    expect(refusal.activeOrganizationId).toBe(ORG_A);
    expect(refusal.roles).toEqual(['FLEET_MANAGER', 'ORGANIZATION_ADMIN']);
    expect(Object.keys(refusal).sort()).toEqual([
      'activeOrganizationId',
      'error',
      'roles',
      'userId',
    ]);
  });

  it('never hands over the requested organization, the token, the memberships or the claims', () => {
    return attempt({ ...bearer, 'x-organization-id': ORG_FOREIGN }).then(({ seen }) => {
      const refusal = seen[0]!;
      const { error: _error, ...attribution } = refusal;
      const serialised = JSON.stringify(attribution);

      // The rejected header is the whole point: it is attacker-chosen.
      expect(serialised).not.toContain(ORG_FOREIGN);
      // The second membership is in the claims but is not attribution.
      expect(serialised).not.toContain(ORG_B);
      expect(serialised).not.toContain('user-token');
      expect(serialised).not.toContain(SUBJECT);
      // `internalContext` is reachable only through the error, which the
      // observer needs by identity; the attribution itself carries none of it.
      expect(refusal.error.internalContext).toEqual({
        requested: ORG_FOREIGN,
        allowed: [ORG_A, ORG_A, ORG_B],
      });
    });
  });

  it('falls back to the IdP subject when the token carries no platform id', async () => {
    const { seen } = await attempt(
      { ...bearer, 'x-organization-id': ORG_FOREIGN },
      { claims: memberOfA({ rastaUserId: undefined }) },
    );

    expect(seen[0]!.userId).toBe(SUBJECT);
  });

  it('reports a token with no active organization as having none, rather than inventing one', async () => {
    // The guard states what it verified. Whether an unattributable refusal is
    // worth recording is the observing service's decision, not the guard's.
    const { seen, error } = await attempt(
      { ...bearer, 'x-organization-id': ORG_FOREIGN },
      { claims: memberOfA({ organizationId: undefined, organizationIds: [ORG_B] }) },
    );

    expect((error as RastaError).code).toBe('TENANT_MISMATCH');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.activeOrganizationId).toBeUndefined();
  });

  describe('does not fire for anything that is not that refusal', () => {
    it('an accepted selection of another membership', async () => {
      const { seen, allowed } = await attempt({ ...bearer, 'x-organization-id': ORG_B });

      expect(allowed).toBe(true);
      expect(seen).toHaveLength(0);
    });

    it('an accepted request with no header at all', async () => {
      const { seen, allowed } = await attempt(bearer);

      expect(allowed).toBe(true);
      expect(seen).toHaveLength(0);
    });

    it('an accepted header naming the active organization itself', async () => {
      const { seen, allowed } = await attempt({ ...bearer, 'x-organization-id': ORG_A });

      expect(allowed).toBe(true);
      expect(seen).toHaveLength(0);
    });

    it('a missing token, even with a mismatched header', async () => {
      const { seen, error } = await attempt({ 'x-organization-id': ORG_FOREIGN });

      expect((error as RastaError).status).toBe(401);
      expect(seen).toHaveLength(0);
    });

    it('an invalid token, even with a mismatched header', async () => {
      const { seen, error } = await attempt({
        authorization: 'Bearer forged-token',
        'x-organization-id': ORG_FOREIGN,
      });

      expect((error as RastaError).code).toBe('TOKEN_INVALID');
      expect(seen).toHaveLength(0);
    });

    it('an expired token, even with a mismatched header', async () => {
      const expired = {
        verifyUserToken: async (): Promise<UserClaims> => {
          throw new RastaError('TOKEN_EXPIRED', 'Token has expired');
        },
      } as unknown as TokenVerifier;
      const seen: UserTenantMismatch[] = [];
      const guard = new AuthGuard(reflectorFor({}), {
        serviceName: THIS_SERVICE,
        tokenVerifier: expired,
        internalTokens,
        onUserTenantMismatch: (refusal) => seen.push(refusal),
      });

      await expect(
        guard.canActivate(executionFor({ ...bearer, 'x-organization-id': ORG_FOREIGN })),
      ).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
      expect(seen).toHaveLength(0);
    });

    it('an anonymous request to a public endpoint carrying a mismatched header', async () => {
      const { seen, allowed } = await attempt(
        { 'x-organization-id': ORG_FOREIGN },
        { endpoint: { publicReason: 'Self-registration' } },
      );

      expect(allowed).toBe(true);
      expect(seen).toHaveLength(0);
    });

    it('a relayed anonymous request to a public endpoint with a mismatched header', async () => {
      const { seen, allowed } = await attempt(
        {
          'x-internal-token': await internalTokens.issue('api-gateway', THIS_SERVICE, 'RELAY'),
          'x-organization-id': ORG_FOREIGN,
        },
        { endpoint: { publicReason: 'Self-registration' } },
      );

      expect(allowed).toBe(true);
      expect(seen).toHaveLength(0);
    });

    it("a service token's SERVICE_TENANT_CONTEXT_INVALID, which is the other tenant refusal", async () => {
      const { seen, error } = await attempt(
        {
          'x-internal-token': await internalTokens.issue(
            'fleet-service',
            THIS_SERVICE,
            'SERVICE',
            ORG_A,
          ),
          'x-organization-id': ORG_FOREIGN,
        },
        { endpoint: { allowService: ['fleet-service'] } },
      );

      expect((error as RastaError).code).toBe('SERVICE_TENANT_CONTEXT_INVALID');
      expect((error as RastaError).status).toBe(403);
      expect(seen).toHaveLength(0);
    });

    it('a service token refused with FORBIDDEN by @AllowService', async () => {
      const { seen, error } = await attempt(
        {
          'x-internal-token': await internalTokens.issue(
            'notification-service',
            THIS_SERVICE,
            'SERVICE',
            ORG_A,
          ),
          'x-organization-id': ORG_FOREIGN,
        },
        { endpoint: { allowService: ['fleet-service'] } },
      );

      expect((error as RastaError).code).toBe('FORBIDDEN');
      expect(seen).toHaveLength(0);
    });

    it('a user token accompanied by a relay token, accepted', async () => {
      const { seen, allowed } = await attempt({
        ...bearer,
        'x-internal-token': await internalTokens.issue('api-gateway', THIS_SERVICE, 'RELAY'),
        'x-organization-id': ORG_B,
      });

      expect(allowed).toBe(true);
      expect(seen).toHaveLength(0);
    });
  });

  describe('cannot affect the refusal', () => {
    /** The same request, decided by a guard with no observer at all. */
    const unobserved = () =>
      attempt({ ...bearer, 'x-organization-id': ORG_FOREIGN }, { observe: null });

    it('an absent seam leaves the refusal exactly as it was', async () => {
      const withSeam = await attempt({ ...bearer, 'x-organization-id': ORG_FOREIGN });
      const without = await unobserved();

      const observed = withSeam.error as RastaError;
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
    });

    it('a throwing observer is swallowed and the identical error is still thrown', async () => {
      const thrown = new Error('observer exploded');
      const { seen, error } = await attempt(
        { ...bearer, 'x-organization-id': ORG_FOREIGN },
        {
          observe: () => {
            throw thrown;
          },
        },
      );

      expect(error).not.toBe(thrown);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.error).toBe(error);
      const refusal = error as RastaError;
      expect(refusal.code).toBe('TENANT_MISMATCH');
      expect(JSON.stringify(refusal)).toBe(
        JSON.stringify(((await unobserved()).error as RastaError) ?? {}),
      );
    });

    it('a rejecting async observer is swallowed, with no unhandled rejection', async () => {
      const unhandled: unknown[] = [];
      const listener = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', listener);
      try {
        const { error } = await attempt(
          { ...bearer, 'x-organization-id': ORG_FOREIGN },
          {
            // An observer typed `void` may still be `async`: TypeScript allows
            // it, so the guard has to survive it.
            observe: (() => Promise.reject(new Error('async observer failed'))) as unknown as (
              refusal: UserTenantMismatch,
            ) => void,
          },
        );

        expect((error as RastaError).code).toBe('TENANT_MISMATCH');
        // Let the microtask queue drain, so a missing `.catch` would surface.
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', listener);
      }
    });

    it('an observer that accepts a membership anyway does not admit the request', async () => {
      // The seam returns nothing and is called after the decision. There is no
      // value it could return that would turn a refusal into an admission.
      const { allowed, error } = await attempt(
        { ...bearer, 'x-organization-id': ORG_FOREIGN },
        { observe: () => undefined },
      );

      expect(allowed).toBeUndefined();
      expect((error as RastaError).status).toBe(403);
    });
  });

  it('keeps the shared package free of any service-specific dependency (A-03)', () => {
    // The seam is generic: it names no service, no audit concept and no site.
    // If this file ever imports one, the shared package has taken on a
    // service's policy and every other service inherits it.
    const source = readFileSync(join(__dirname, 'auth.guard.ts'), 'utf8');
    const imports = source
      .split('\n')
      .filter((line) => line.trimStart().startsWith('import '))
      .join('\n');

    expect(imports).not.toMatch(/identity|audit|refusal|security-event/i);
  });
});
