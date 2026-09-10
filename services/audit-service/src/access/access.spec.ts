import { isRastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import {
  assertNotAuditor,
  assertNotServiceCaller,
  AUDIT_READER_ROLES,
  resolveCallerAuthority,
} from './access';

/**
 * The authorization matrix of ADR-053 § 10, asserted role by role.
 *
 * Written from the refusal side, because that is where this service's rules
 * are: the store is closed and two roles are cut out of it. The sharpest cases
 * in the file are the ones that surprise a reader — `AUDITOR`, which the name
 * suggests belongs here and does not, and a valid service token, which
 * authenticates perfectly and is still refused.
 */

const UNION = 'ORG-UNION';

function context(overrides: Partial<RequestContext>): RequestContext {
  return {
    requestId: 'req-1',
    correlationId: 'corr-1',
    authType: 'USER',
    roles: [],
    startedAt: 0,
    ...overrides,
  } as RequestContext;
}

function as<T>(overrides: Partial<RequestContext>, fn: () => T): T {
  return runWithContext(context(overrides), fn);
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (isRastaError(error)) return error.code;
    return `NOT_A_PLATFORM_ERROR: ${String(error)}`;
  }
  return 'NO_ERROR';
}

describe('the roles the controller may be reached with', () => {
  it('names exactly SYSTEM_ADMIN and UNION_ADMIN', () => {
    expect([...AUDIT_READER_ROLES]).toEqual(['SYSTEM_ADMIN', 'UNION_ADMIN']);
  });

  it('never names AUDITOR', () => {
    // The static half of the three-layer defence, asserted on the constant the
    // `@Roles` decorator is spread from, so it cannot drift from the decorator.
    expect([...AUDIT_READER_ROLES]).not.toContain('AUDITOR');
  });
});

describe('assertNotAuditor', () => {
  it('refuses a caller holding AUDITOR', () => {
    expect(codeOf(() => as({ roles: ['AUDITOR'] }, assertNotAuditor))).toBe('FORBIDDEN');
  });

  it('refuses AUDITOR even when it arrives beside a role that would be allowed', () => {
    // The layer that survives an editing mistake elsewhere: a token carrying
    // both is refused on the AUDITOR row, not admitted on the other one.
    expect(codeOf(() => as({ roles: ['SYSTEM_ADMIN', 'AUDITOR'] }, assertNotAuditor))).toBe(
      'FORBIDDEN',
    );
  });

  it('allows a caller without it', () => {
    expect(codeOf(() => as({ roles: ['SYSTEM_ADMIN'] }, assertNotAuditor))).toBe('NO_ERROR');
  });
});

describe('assertNotServiceCaller', () => {
  it('refuses a service token however many roles it claims', () => {
    expect(
      codeOf(() => as({ authType: 'SERVICE', roles: ['SYSTEM_ADMIN'] }, assertNotServiceCaller)),
    ).toBe('FORBIDDEN');
  });

  it('allows a user token', () => {
    expect(codeOf(() => as({ authType: 'USER', roles: [] }, assertNotServiceCaller))).toBe(
      'NO_ERROR',
    );
  });
});

describe('resolveCallerAuthority', () => {
  it('gives SYSTEM_ADMIN platform authority with no root', () => {
    expect(as({ roles: ['SYSTEM_ADMIN'] }, resolveCallerAuthority)).toEqual({ kind: 'PLATFORM' });
  });

  it('gives SYSTEM_ADMIN platform authority even when it also holds a tenant', () => {
    expect(as({ roles: ['SYSTEM_ADMIN'], organizationId: UNION }, resolveCallerAuthority)).toEqual({
      kind: 'PLATFORM',
    });
  });

  it('gives UNION_ADMIN subtree authority rooted at its active organization', () => {
    expect(as({ roles: ['UNION_ADMIN'], organizationId: UNION }, resolveCallerAuthority)).toEqual({
      kind: 'SUBTREE',
      rootOrganizationId: UNION,
    });
  });

  it('prefers the wider authority when a token carries both roles', () => {
    // Resolving to the narrower one would deny reads the matrix allows without
    // making anything safer.
    expect(
      as({ roles: ['UNION_ADMIN', 'SYSTEM_ADMIN'], organizationId: UNION }, resolveCallerAuthority),
    ).toEqual({ kind: 'PLATFORM' });
  });

  it('refuses a UNION_ADMIN whose token names no active organization', () => {
    // A union administrator with no tenant has no subtree. Refused as a 403
    // rather than the bare Error `getOrganizationId()` would raise, which would
    // surface as a 500 and read as a service defect.
    expect(codeOf(() => as({ roles: ['UNION_ADMIN'] }, resolveCallerAuthority))).toBe('FORBIDDEN');
  });

  it('refuses AUDITOR before anything else is considered', () => {
    expect(
      codeOf(() => as({ roles: ['AUDITOR'], organizationId: UNION }, resolveCallerAuthority)),
    ).toBe('FORBIDDEN');
  });

  it('refuses ORGANIZATION_ADMIN', () => {
    // Least privilege while "owner of the record" is ambiguous (ADR-053 § 11).
    expect(
      codeOf(() =>
        as({ roles: ['ORGANIZATION_ADMIN'], organizationId: UNION }, resolveCallerAuthority),
      ),
    ).toBe('FORBIDDEN');
  });

  it('refuses a service token that claims an allowed role', () => {
    expect(
      codeOf(() =>
        as(
          { authType: 'SERVICE', roles: ['SYSTEM_ADMIN'], organizationId: UNION },
          resolveCallerAuthority,
        ),
      ),
    ).toBe('FORBIDDEN');
  });

  it.each([['FLEET_MANAGER'], ['PROCUREMENT_USER'], ['DRIVER'], ['SUPPLIER'], ['OPERATOR']])(
    'refuses %s, which no rule mentions',
    (role) => {
      expect(
        codeOf(() => as({ roles: [role], organizationId: UNION }, resolveCallerAuthority)),
      ).toBe('FORBIDDEN');
    },
  );

  it('refuses a caller with no roles at all', () => {
    expect(codeOf(() => as({ roles: [], organizationId: UNION }, resolveCallerAuthority))).toBe(
      'FORBIDDEN',
    );
  });
});
