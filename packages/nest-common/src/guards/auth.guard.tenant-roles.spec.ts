import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { AuthGuard, type AuthState, type MalformedOrganizationRoles } from './auth.guard';
import { RolesGuard } from './roles.guard';
import type { TokenVerifier, UserClaims } from '../auth/token-verifier';
import { AUDITOR_SELF_SERVICE_KEY, REQUIRED_ROLES_KEY } from '../decorators';
import { runWithContext, getContext } from '../context/request-context';
import { RastaError } from '../errors/rasta-error';
import { parseOrganizationRoles, rolesForRequest } from '../auth/tenant-roles';

/**
 * ADR-060 — a user's roles belong to the organization they were granted in.
 *
 * Each `it` below is one line of the ADR's Compliance list for the guard, in
 * the ADR's own order, followed by the oversight-role rule `RolesGuard`
 * applies on top.
 *
 * The finding this closes: roles were one flat realm list, carried into every
 * organization the caller could name. An organization admin in A who was an
 * ordinary member of B sent `X-Organization-Id: B` and was an admin there.
 */

const ORG_A = 'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9YA';
const ORG_B = 'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9YB';
const ORG_C = 'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9YC';

function claims(overrides: Partial<UserClaims> = {}): UserClaims {
  return {
    sub: 'keycloak-subject',
    rastaUserId: 'USR_01JBQ8Z4K7M2N5P8R1T3V6X9Y2',
    organizationId: ORG_A,
    organizationIds: [ORG_A, ORG_B],
    // What an old token carried: the realm list, valid everywhere.
    roles: ['ORGANIZATION_ADMIN', 'DRIVER'],
    organizationRoles: [`${ORG_A}:ORGANIZATION_ADMIN`, `${ORG_B}:DRIVER`],
    username: 'dehyari.admin',
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

function reflectorFor(metadata: Record<string, unknown> = {}): Reflector {
  return {
    getAllAndOverride: (key: string) => metadata[key],
  } as unknown as Reflector;
}

function executionFor(headers: Record<string, string | undefined>): ExecutionContext {
  const request: { headers: typeof headers; rastaAuth?: AuthState } = { headers };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;
}

const anonymous = {
  correlationId: 'COR_1',
  requestId: 'REQ_1',
  roles: [],
  organizationIds: [],
  authType: 'ANONYMOUS' as const,
  startedAt: 0,
};

/**
 * Authenticates `token` with `header`, then runs `RolesGuard` for an endpoint
 * with `metadata`. Resolves with the context the handler would see, or the
 * error the caller would get.
 */
async function request(
  token: UserClaims,
  header: string | undefined,
  metadata: Record<string, unknown> = {},
  onMalformed?: (malformed: MalformedOrganizationRoles) => void,
): Promise<{
  roles?: string[];
  organizationId?: string;
  organizationIds?: string[];
  error?: unknown;
}> {
  const verifier = {
    verifyUserToken: async (): Promise<UserClaims> => token,
  } as unknown as TokenVerifier;
  const auth = new AuthGuard(reflectorFor(), {
    serviceName: 'test-service',
    tokenVerifier: verifier,
    ...(onMalformed ? { onMalformedOrganizationRoles: onMalformed } : {}),
  });
  const roles = new RolesGuard(reflectorFor(metadata));
  const execution = executionFor({
    authorization: 'Bearer user-token',
    ...(header ? { 'x-organization-id': header } : {}),
  });

  return runWithContext(anonymous, async () => {
    try {
      await auth.canActivate(execution);
      roles.canActivate(execution);
      const context = getContext();
      return {
        roles: [...context.roles].sort(),
        organizationId: context.organizationId,
        organizationIds: [...context.organizationIds],
      };
    } catch (error) {
      return { error };
    }
  });
}

const adminOnly = { [REQUIRED_ROLES_KEY]: ['ORGANIZATION_ADMIN'] };

function codeOf(error: unknown): string | undefined {
  return error instanceof RastaError ? error.code : undefined;
}

describe('AuthGuard — roles bound to the organization (ADR-060 § 4)', () => {
  it('admin in A, ordinary member in B: the admin endpoint answers in A and refuses in B', async () => {
    const inA = await request(claims(), ORG_A, adminOnly);
    expect(inA.error).toBeUndefined();
    expect(inA.roles).toEqual(['ORGANIZATION_ADMIN']);

    // The finding itself. The realm list still says ORGANIZATION_ADMIN.
    const inB = await request(claims(), ORG_B, adminOnly);
    expect(codeOf(inB.error)).toBe('INSUFFICIENT_ROLE');

    const rolesInB = await request(claims(), ORG_B);
    expect(rolesInB.roles).toEqual(['DRIVER']);
  });

  it('refuses a membership with no role in org_roles as TENANT_MISMATCH, not "no roles"', async () => {
    const token = claims({ organizationRoles: [`${ORG_A}:ORGANIZATION_ADMIN`] });
    const outcome = await request(token, ORG_B);
    expect(codeOf(outcome.error)).toBe('TENANT_MISMATCH');
  });

  it('refuses an active organization that is not a membership, with and without the header', async () => {
    // Finding 4: the membership was revoked, the token's active organization
    // was not, and both shortcuts used to admit it.
    const token = claims({ organizationId: ORG_C });
    expect(codeOf((await request(token, undefined)).error)).toBe('TENANT_MISMATCH');
    expect(codeOf((await request(token, ORG_C)).error)).toBe('TENANT_MISMATCH');
  });

  it('with no org_roles claim at all, grants only SYSTEM_ADMIN and never other realm roles', async () => {
    const plain = await request(
      claims({ roles: ['ORGANIZATION_ADMIN'], organizationRoles: [], organizationId: undefined }),
      undefined,
    );
    expect(plain.error).toBeUndefined();
    expect(plain.roles).toEqual([]);

    const operator = await request(
      claims({
        roles: ['SYSTEM_ADMIN', 'UNION_ADMIN'],
        organizationRoles: [],
        organizationId: undefined,
      }),
      undefined,
    );
    expect(operator.roles).toEqual(['SYSTEM_ADMIN']);
  });

  it('drops a malformed pair, reads the rest, and reports how many were dropped', async () => {
    const seen: MalformedOrganizationRoles[] = [];
    const token = claims({
      organizationRoles: [
        `${ORG_A}:ORGANIZATION_ADMIN`,
        `${ORG_A}:ORGANIZATION_ADMIN:EXTRA`,
        `${ORG_A}:NOT_A_ROLE`,
        `:DRIVER`,
        `${ORG_A}: DRIVER`,
        `${ORG_A}`,
      ],
    });
    const outcome = await request(token, ORG_A, {}, (malformed) => seen.push(malformed));
    expect(outcome.roles).toEqual(['ORGANIZATION_ADMIN']);
    expect(seen).toEqual([{ userId: 'USR_01JBQ8Z4K7M2N5P8R1T3V6X9Y2', dropped: 5 }]);
  });

  it('gives UNION_ADMIN in the realm but not in org_roles for that organization no role there', async () => {
    const token = claims({
      roles: ['UNION_ADMIN'],
      organizationRoles: [`${ORG_A}:UNION_ADMIN`, `${ORG_B}:DRIVER`],
    });
    expect((await request(token, ORG_A)).roles).toEqual(['UNION_ADMIN']);
    // Carried with X-Organization-Id into B, it is not carried at all.
    expect((await request(token, ORG_B)).roles).toEqual(['DRIVER']);
  });

  it('keeps SYSTEM_ADMIN in every organization it resolves to', async () => {
    const token = claims({
      roles: ['SYSTEM_ADMIN'],
      organizationRoles: [`${ORG_A}:DRIVER`, `${ORG_B}:DRIVER`],
    });
    expect((await request(token, ORG_B)).roles).toEqual(['DRIVER', 'SYSTEM_ADMIN']);
  });

  it('carries the token memberships only, never the active organization merged in', async () => {
    const outcome = await request(claims(), ORG_B);
    expect(outcome.organizationId).toBe(ORG_B);
    expect(outcome.organizationIds).toEqual([ORG_A, ORG_B]);
  });
});

describe('RolesGuard — the oversight role is refused unless a handler names it', () => {
  const auditorInA = claims({
    roles: [],
    organizationRoles: [`${ORG_A}:AUDITOR`, `${ORG_A}:FLEET_MANAGER`, `${ORG_B}:DRIVER`],
  });

  it('refuses an auditor on a handler with no @Roles, which admits any other caller', async () => {
    expect(codeOf((await request(auditorInA, ORG_A)).error)).toBe('INSUFFICIENT_ROLE');
  });

  it('does not let another role in the same organization rescue it', async () => {
    const outcome = await request(auditorInA, ORG_A, {
      [REQUIRED_ROLES_KEY]: ['FLEET_MANAGER'],
    });
    expect(codeOf(outcome.error)).toBe('INSUFFICIENT_ROLE');
  });

  it('does not let SYSTEM_ADMIN rescue it either', async () => {
    const outcome = await request(
      claims({ roles: ['SYSTEM_ADMIN'], organizationRoles: [`${ORG_A}:AUDITOR`] }),
      ORG_A,
      adminOnly,
    );
    expect(codeOf(outcome.error)).toBe('INSUFFICIENT_ROLE');
  });

  it('admits it where @Roles names AUDITOR', async () => {
    const outcome = await request(auditorInA, ORG_A, {
      [REQUIRED_ROLES_KEY]: ['AUDITOR', 'UNION_ADMIN'],
    });
    expect(outcome.error).toBeUndefined();
  });

  it('admits it on a self-service handler', async () => {
    const outcome = await request(auditorInA, ORG_A, {
      [AUDITOR_SELF_SERVICE_KEY]: { allowed: true, reason: 'reads the caller’s own profile' },
    });
    expect(outcome.error).toBeUndefined();
  });

  it('applies only where the role is held: acting for B, the same person is a driver', async () => {
    const outcome = await request(auditorInA, ORG_B, { [REQUIRED_ROLES_KEY]: ['DRIVER'] });
    expect(outcome.error).toBeUndefined();
  });
});

describe('parseOrganizationRoles / rolesForRequest', () => {
  it('groups roles by organization and ignores duplicates', () => {
    const parsed = parseOrganizationRoles([
      `${ORG_A}:DRIVER`,
      `${ORG_A}:DRIVER`,
      `${ORG_A}:OPERATOR`,
      `${ORG_B}:SUPPLIER`,
    ]);
    expect(parsed.byOrganization.get(ORG_A)).toEqual(['DRIVER', 'OPERATOR']);
    expect(parsed.byOrganization.get(ORG_B)).toEqual(['SUPPLIER']);
    expect(parsed.dropped).toBe(0);
  });

  it('counts a non-string value as dropped', () => {
    expect(parseOrganizationRoles([42, null, `${ORG_A}:DRIVER`]).dropped).toBe(2);
  });

  it('keeps only the global realm roles when no organization resolved', () => {
    const parsed = parseOrganizationRoles([`${ORG_A}:DRIVER`]);
    expect(rolesForRequest(undefined, parsed, ['SYSTEM_ADMIN', 'UNION_ADMIN'])).toEqual([
      'SYSTEM_ADMIN',
    ]);
  });
});
