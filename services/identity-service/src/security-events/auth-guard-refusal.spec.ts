import { randomBytes } from 'node:crypto';
import type { ArgumentsHost, ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { ERROR_CODES } from '@rasta/contracts';
import {
  AllExceptionsFilter,
  AuthGuard,
  InternalTokenService,
  RastaError,
  runWithContext,
  type AuthGuardOptions,
  type RequestContext,
  type UserTenantMismatch,
} from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
import { markAuthGuardTenantMismatch, withAuthGuardRefusalAudit } from './auth-guard-refusal';
import { markRefusal, refusalSiteOf, trustedAttributionOf, REFUSAL_SITES } from './refusal-sites';

/**
 * identity-service's marking of the platform `AuthGuard`'s own tenant refusal
 * (AUD-004 Phase C10) — the ninth site, and the first whose decider is the auth
 * guard.
 *
 * Two things are proved here, because the phase rests on both:
 *
 *  1. **Only that refusal is marked**, and only with attribution the shared
 *     guard verified. Nothing is ever taken from the header, the token, the
 *     URL or the error's own context, and a refusal that cannot be attributed
 *     exactly is left unmarked rather than attributed approximately.
 *  2. **Marking changes nothing observable.** The same request, put to a guard
 *     configured exactly as production configures it and to a bare platform
 *     guard, yields the same error and the same HTTP response from the
 *     platform filter. The only difference is the out-of-band `WeakMap` mark.
 */

const SECRET = randomBytes(32).toString('hex');
const THIS_SERVICE = 'identity-service';

const ORG_ACTIVE = 'ORG_ACTIVE_A';
const ORG_SECOND = 'ORG_SECOND_B';
/** Attacker-chosen, and never a membership. */
const ORG_HEADER_SENTINEL = 'ORG_HEADER_SENTINEL';
const USER_ID = 'USR_VERIFIED';
const SUBJECT = 'kc-subject-sentinel';
const TOKEN = 'user-token-sentinel';

interface Claims {
  sub: string;
  rastaUserId?: string;
  organizationId?: string;
  organizationIds: string[];
  roles: string[];
  username?: string;
  expiresAt: number;
}

const claimsFor = (overrides: Partial<Claims> = {}): Claims => ({
  sub: SUBJECT,
  rastaUserId: USER_ID,
  organizationId: ORG_ACTIVE,
  organizationIds: [ORG_ACTIVE, ORG_SECOND],
  roles: ['FLEET_MANAGER', 'ORGANIZATION_ADMIN'],
  username: 'dehyari.admin',
  expiresAt: Date.now() + 60_000,
  ...overrides,
});

const reflector = { getAllAndOverride: () => undefined } as unknown as Reflector;

function executionFor(headers: Record<string, string | undefined>): ExecutionContext {
  const request = { headers };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;
}

/** The platform options this service builds, minus the audit observation. */
function platformOptions(claims: Claims): AuthGuardOptions {
  return {
    serviceName: THIS_SERVICE,
    internalTokens: new InternalTokenService(SECRET, 'rasta-internal', 300),
    tokenVerifier: {
      verifyUserToken: async (candidate: string) => {
        if (candidate !== TOKEN) throw new RastaError('TOKEN_INVALID', 'Token is not valid');
        return claims;
      },
      // JUSTIFIED-ANY: the guard depends on the concrete TokenVerifier class and
      // this stub implements only the method it calls.
    } as any,
  };
}

const requestContext = (): RequestContext => ({
  correlationId: 'COR_C10_1',
  requestId: 'REQ_C10_1',
  // Exactly what the middleware establishes before the guard runs: anonymous,
  // because the context is upgraded only once the tenant resolves.
  organizationIds: [],
  roles: [],
  authType: 'ANONYMOUS',
  method: 'GET',
  path: `/v1/users/me?probe=${ORG_HEADER_SENTINEL}`,
  startedAt: 0,
});

interface Attempt {
  allowed?: boolean;
  error?: unknown;
}

/** Runs a guard inside a request context, as the middleware would. */
async function attempt(
  options: AuthGuardOptions,
  headers: Record<string, string>,
): Promise<Attempt> {
  const guard = new AuthGuard(reflector, options);
  return runWithContext(requestContext(), async () => {
    try {
      return { allowed: await guard.canActivate(executionFor(headers)) };
    } catch (error) {
      return { error };
    }
  });
}

const mismatchHeaders = {
  authorization: `Bearer ${TOKEN}`,
  'x-organization-id': ORG_HEADER_SENTINEL,
};

/** What the platform exception filter sends for `error`, minus its timestamp. */
function platformHttpResponse(
  error: unknown,
  context: RequestContext,
): { status?: number; body?: Record<string, unknown> } {
  const sent: { status?: number; body?: Record<string, unknown> } = {};
  const response = {
    status: (code: number) => {
      sent.status = code;
      return response;
    },
    json: (body: unknown) => {
      const { timestamp: _timestamp, ...rest } = body as Record<string, unknown>;
      sent.body = rest;
    },
  };
  const request = { method: context.method, url: context.path };
  const host = {
    getType: () => 'http',
    getArgs: () => [request, response],
    getArgByIndex: (index: number) => [request, response][index],
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
      getNext: () => undefined,
    }),
  } as unknown as ArgumentsHost;
  const logger = { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() };
  runWithContext(context, () =>
    new AllExceptionsFilter(logger as unknown as Logger).catch(error, host),
  );
  return sent;
}

describe('markAuthGuardTenantMismatch', () => {
  const refusalFor = (overrides: Partial<UserTenantMismatch> = {}): UserTenantMismatch => ({
    error: RastaError.tenantMismatch(ORG_HEADER_SENTINEL, [ORG_ACTIVE, ORG_SECOND]),
    userId: USER_ID,
    activeOrganizationId: ORG_ACTIVE,
    roles: ['FLEET_MANAGER'],
    ...overrides,
  });

  it('marks the refusal as the auth guard site, with the verified actor and active tenant', () => {
    const refusal = refusalFor();

    markAuthGuardTenantMismatch(refusal);

    expect(refusalSiteOf(refusal.error)).toBe(REFUSAL_SITES.AUTH_TENANT_MISMATCH);
    expect(trustedAttributionOf(refusal.error)).toEqual({
      userId: USER_ID,
      organizationId: ORG_ACTIVE,
      roles: ['FLEET_MANAGER'],
    });
  });

  it('records the tenant the caller acts for, never the one the header asked for', () => {
    const refusal = refusalFor();

    markAuthGuardTenantMismatch(refusal);

    const attribution = trustedAttributionOf(refusal.error);
    expect(attribution?.organizationId).toBe(ORG_ACTIVE);
    expect(JSON.stringify(attribution)).not.toContain(ORG_HEADER_SENTINEL);
    // The other membership is in the token but is not what this request acted for.
    expect(JSON.stringify(attribution)).not.toContain(ORG_SECOND);
  });

  it.each<[string, Partial<UserTenantMismatch>]>([
    ['a token with no active organization', { activeOrganizationId: undefined }],
    ['a blank active organization', { activeOrganizationId: '   ' }],
    ['no verified user id', { userId: '' }],
    ['a blank user id', { userId: '  ' }],
  ])('fails closed and marks nothing for %s', (_label, overrides) => {
    // Refused either way — this only decides whether evidence is kept. An
    // unattributable tenant probe is not filed under "no tenant" beside
    // legitimate platform-wide work.
    const refusal = refusalFor(overrides);

    markAuthGuardTenantMismatch(refusal);

    expect(refusalSiteOf(refusal.error)).toBeUndefined();
    expect(trustedAttributionOf(refusal.error)).toBeUndefined();
  });

  it.each<[string, UserTenantMismatch]>([
    [
      'a FORBIDDEN from the same guard',
      {
        error: RastaError.forbidden(),
        userId: USER_ID,
        activeOrganizationId: ORG_ACTIVE,
        roles: [],
      },
    ],
    [
      'a service tenant refusal',
      {
        error: RastaError.serviceTenantContextInvalid('HEADER_CLAIM_MISMATCH'),
        userId: USER_ID,
        activeOrganizationId: ORG_ACTIVE,
        roles: [],
      },
    ],
    [
      'an INSUFFICIENT_ROLE',
      {
        error: RastaError.insufficientRole(['UNION_ADMIN'], []),
        userId: USER_ID,
        activeOrganizationId: ORG_ACTIVE,
        roles: [],
      },
    ],
    [
      'a 401',
      {
        error: RastaError.unauthenticated(),
        userId: USER_ID,
        activeOrganizationId: ORG_ACTIVE,
        roles: [],
      },
    ],
    [
      'a plain Error',
      {
        error: new Error('boom') as unknown as RastaError,
        userId: USER_ID,
        activeOrganizationId: ORG_ACTIVE,
        roles: [],
      },
    ],
  ])('marks nothing for %s', (_label, refusal) => {
    markAuthGuardTenantMismatch(refusal);

    expect(refusalSiteOf(refusal.error)).toBeUndefined();
  });

  it('marks nothing when the roles are not a list', () => {
    const refusal = refusalFor({ roles: undefined as unknown as string[] });

    markAuthGuardTenantMismatch(refusal);

    expect(refusalSiteOf(refusal.error)).toBeUndefined();
  });

  it('never marks twice, and never over another decider’s mark', () => {
    // The domain's own TENANT_MISMATCH, already marked at its throw site.
    const domainRefusal = markRefusal(
      RastaError.tenantMismatch(ORG_HEADER_SENTINEL, []),
      'SWITCH_ACTIVE_ORGANIZATION',
    );

    markAuthGuardTenantMismatch(refusalFor({ error: domainRefusal }));

    expect(refusalSiteOf(domainRefusal)).toBe(REFUSAL_SITES.SWITCH_ACTIVE_ORGANIZATION);
    expect(trustedAttributionOf(domainRefusal)).toBeUndefined();

    // And its own mark is idempotent: a second call cannot re-attribute.
    const guardRefusal = refusalFor();
    markAuthGuardTenantMismatch(guardRefusal);
    markAuthGuardTenantMismatch({ ...guardRefusal, userId: 'USR_SOMEONE_ELSE' });

    expect(trustedAttributionOf(guardRefusal.error)?.userId).toBe(USER_ID);
  });

  it('throws nothing, whatever it is handed', () => {
    expect(() =>
      markAuthGuardTenantMismatch(undefined as unknown as UserTenantMismatch),
    ).not.toThrow();
    expect(() => markAuthGuardTenantMismatch({} as unknown as UserTenantMismatch)).not.toThrow();
  });
});

describe('withAuthGuardRefusalAudit', () => {
  it('adds the observation and changes nothing else', () => {
    const base = platformOptions(claimsFor());
    const wrapped = withAuthGuardRefusalAudit(base);

    expect(wrapped.serviceName).toBe(base.serviceName);
    expect(wrapped.tokenVerifier).toBe(base.tokenVerifier);
    expect(wrapped.internalTokens).toBe(base.internalTokens);
    expect(wrapped.onUserTenantMismatch).toBe(markAuthGuardTenantMismatch);
    // The caller's own options object is not mutated: another service sharing
    // a base configuration does not silently acquire identity's audit policy.
    expect(base.onUserTenantMismatch).toBeUndefined();
  });
});

describe('the configured guard, against the bare platform guard', () => {
  it('refuses the mismatch identically, and marks only identity’s error', async () => {
    const claims = claimsFor();
    const mine = await attempt(withAuthGuardRefusalAudit(platformOptions(claims)), mismatchHeaders);
    const plain = await attempt(platformOptions(claims), mismatchHeaders);

    const marked = mine.error as RastaError;
    const unmarked = plain.error as RastaError;

    expect(mine.allowed).toBeUndefined();
    expect(plain.allowed).toBeUndefined();
    expect(marked).toBeInstanceOf(RastaError);
    expect(marked.constructor).toBe(unmarked.constructor);
    expect(marked.status).toBe(403);
    expect([marked.status, marked.code, marked.message]).toEqual([
      unmarked.status,
      unmarked.code,
      unmarked.message,
    ]);
    expect(marked.internalContext).toEqual(unmarked.internalContext);
    expect(Object.keys(marked).sort()).toEqual(Object.keys(unmarked).sort());
    expect(JSON.stringify(marked)).toBe(JSON.stringify(unmarked));

    // The only difference is out of band.
    expect(refusalSiteOf(marked)).toBe(REFUSAL_SITES.AUTH_TENANT_MISMATCH);
    expect(refusalSiteOf(unmarked)).toBeUndefined();
    expect(trustedAttributionOf(unmarked)).toBeUndefined();
  });

  it('sends exactly the same HTTP response, and the established refusal', async () => {
    const claims = claimsFor();
    const context = requestContext();
    const mine = (
      await attempt(withAuthGuardRefusalAudit(platformOptions(claims)), mismatchHeaders)
    ).error;
    const plain = (await attempt(platformOptions(claims), mismatchHeaders)).error;

    const forMine = platformHttpResponse(mine, context);

    expect(forMine).toEqual(platformHttpResponse(plain, context));
    expect(forMine).toEqual({
      status: 403,
      body: {
        code: ERROR_CODES.TENANT_MISMATCH,
        message: 'You are not a member of the requested organization',
        correlationId: context.correlationId,
        path: context.path,
      },
    });
  });

  it('attributes the mark to the verified token, with nothing from the request', async () => {
    const { error } = await attempt(
      withAuthGuardRefusalAudit(platformOptions(claimsFor())),
      mismatchHeaders,
    );

    expect(trustedAttributionOf(error)).toEqual({
      userId: USER_ID,
      organizationId: ORG_ACTIVE,
      roles: ['FLEET_MANAGER', 'ORGANIZATION_ADMIN'],
    });
    const serialised = JSON.stringify(trustedAttributionOf(error));
    for (const leaked of [ORG_HEADER_SENTINEL, ORG_SECOND, TOKEN, SUBJECT, '/v1/users/me']) {
      expect(serialised).not.toContain(leaked);
    }
  });

  it('falls back to the IdP subject as the actor when the token carries no platform id', async () => {
    const { error } = await attempt(
      withAuthGuardRefusalAudit(platformOptions(claimsFor({ rastaUserId: undefined }))),
      mismatchHeaders,
    );

    expect(trustedAttributionOf(error)?.userId).toBe(SUBJECT);
  });

  it('marks nothing when the verified token has no active organization', async () => {
    const { error } = await attempt(
      withAuthGuardRefusalAudit(
        platformOptions(claimsFor({ organizationId: undefined, organizationIds: [ORG_SECOND] })),
      ),
      mismatchHeaders,
    );

    expect((error as RastaError).code).toBe(ERROR_CODES.TENANT_MISMATCH);
    expect(refusalSiteOf(error)).toBeUndefined();
  });

  it.each<[string, Record<string, string>]>([
    ['a header naming the active organization', { 'x-organization-id': ORG_ACTIVE }],
    ['a header naming another membership', { 'x-organization-id': ORG_SECOND }],
    ['no header at all', {}],
  ])('admits %s and marks nothing', async (_label, headers) => {
    const { allowed } = await attempt(withAuthGuardRefusalAudit(platformOptions(claimsFor())), {
      authorization: `Bearer ${TOKEN}`,
      ...headers,
    });

    expect(allowed).toBe(true);
  });

  it('marks nothing for an unverifiable token, whatever the header says', async () => {
    const { error } = await attempt(withAuthGuardRefusalAudit(platformOptions(claimsFor())), {
      authorization: 'Bearer forged',
      'x-organization-id': ORG_HEADER_SENTINEL,
    });

    expect((error as RastaError).code).toBe('TOKEN_INVALID');
    expect(refusalSiteOf(error)).toBeUndefined();
  });

  it('marks nothing for an anonymous request carrying only the header', async () => {
    const { error } = await attempt(withAuthGuardRefusalAudit(platformOptions(claimsFor())), {
      'x-organization-id': ORG_HEADER_SENTINEL,
    });

    expect((error as RastaError).status).toBe(401);
    expect(refusalSiteOf(error)).toBeUndefined();
  });

  it('marks each refusal separately, so two callers never share one mark', async () => {
    const first = await attempt(
      withAuthGuardRefusalAudit(platformOptions(claimsFor())),
      mismatchHeaders,
    );
    const second = await attempt(
      withAuthGuardRefusalAudit(
        platformOptions(claimsFor({ rastaUserId: 'USR_OTHER', organizationId: ORG_SECOND })),
      ),
      mismatchHeaders,
    );

    expect(first.error).not.toBe(second.error);
    expect(trustedAttributionOf(first.error)?.userId).toBe(USER_ID);
    expect(trustedAttributionOf(second.error)?.userId).toBe('USR_OTHER');
    expect(trustedAttributionOf(second.error)?.organizationId).toBe(ORG_SECOND);
  });
});
