import { isRastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import { loadConstructionEnv, type ConstructionEnv } from '../config/env';
import {
  ProjectAccess,
  assertNotAuditor,
  assertNotServiceCaller,
  assertOwnProject,
} from './access';

/**
 * Authorization, written from the refused caller's side: who is refused and
 * with which code. Roles come from configuration (Q-69), so each case builds
 * the access object from an environment rather than from a constant.
 */

const ORG = 'ORG-A';

function env(overrides: NodeJS.ProcessEnv = {}): ConstructionEnv {
  return loadConstructionEnv({
    KAFKA_BROKERS: 'localhost:9092',
    OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
    OIDC_JWKS_URI: 'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
    OIDC_AUDIENCE: 'rasta-api',
    INTERNAL_TOKEN_SECRET: 'a-throwaway-value-used-only-by-this-spec-32',
    DATABASE_URL: 'postgresql://u:p@localhost:5433/rasta_construction?schema=public',
    ...overrides,
  });
}

function context(overrides: Partial<RequestContext>): RequestContext {
  return {
    requestId: 'req-1',
    correlationId: 'corr-1',
    authType: 'USER',
    roles: [],
    startedAt: 0,
    organizationId: ORG,
    userId: 'USR_1',
    ...overrides,
  } as RequestContext;
}

function codeOf(access: ProjectAccess, overrides: Partial<RequestContext>, kind: 'write' | 'read') {
  return runWithContext(context(overrides), () => {
    try {
      if (kind === 'write') access.assertCanWrite();
      else access.assertCanRead();
      return 'NO_ERROR';
    } catch (error) {
      return isRastaError(error) ? error.code : `NOT_A_PLATFORM_ERROR: ${String(error)}`;
    }
  });
}

describe('with the default configuration', () => {
  const access = new ProjectAccess(env());

  it('lets ORGANIZATION_ADMIN write and read in its own organization', () => {
    expect(codeOf(access, { roles: ['ORGANIZATION_ADMIN'] }, 'write')).toBe('NO_ERROR');
    expect(codeOf(access, { roles: ['ORGANIZATION_ADMIN'] }, 'read')).toBe('NO_ERROR');
  });

  it('returns the organization the request acts for, and the actor', () => {
    const result = runWithContext(context({ roles: ['ORGANIZATION_ADMIN'] }), () =>
      access.assertCanWrite(),
    );
    expect(result).toEqual({ organizationId: ORG, actor: 'USR_1' });
  });

  it.each(['FLEET_MANAGER', 'DRIVER', 'OPERATOR', 'PROCUREMENT_USER', 'SUPPLIER', 'CONTRACTOR'])(
    'refuses %s with INSUFFICIENT_ROLE, for writing and for reading',
    (role) => {
      expect(codeOf(access, { roles: [role] }, 'write')).toBe('INSUFFICIENT_ROLE');
      expect(codeOf(access, { roles: [role] }, 'read')).toBe('INSUFFICIENT_ROLE');
    },
  );

  it('refuses UNION_ADMIN: platform scope is not a project role (ADR-060)', () => {
    expect(codeOf(access, { roles: ['UNION_ADMIN'] }, 'write')).toBe('INSUFFICIENT_ROLE');
  });

  it('accepts SYSTEM_ADMIN acting for a selected organization', () => {
    expect(codeOf(access, { roles: ['SYSTEM_ADMIN'] }, 'write')).toBe('NO_ERROR');
  });

  it('refuses SYSTEM_ADMIN with no selected organization, with a reason rather than a 500', () => {
    expect(codeOf(access, { roles: ['SYSTEM_ADMIN'], organizationId: undefined }, 'write')).toBe(
      'FORBIDDEN',
    );
  });

  it('refuses a request that names no actor', () => {
    expect(codeOf(access, { roles: ['ORGANIZATION_ADMIN'], userId: undefined }, 'write')).toBe(
      'FORBIDDEN',
    );
  });

  it('refuses the oversight role even alongside a granted role', () => {
    expect(codeOf(access, { roles: ['ORGANIZATION_ADMIN', 'AUDITOR'] }, 'read')).toBe('FORBIDDEN');
    expect(codeOf(access, { roles: ['SYSTEM_ADMIN', 'AUDITOR'] }, 'write')).toBe('FORBIDDEN');
  });

  it('refuses a service token outright', () => {
    expect(codeOf(access, { authType: 'SERVICE', roles: ['ORGANIZATION_ADMIN'] }, 'read')).toBe(
      'FORBIDDEN',
    );
  });
});

describe('with configured roles', () => {
  const access = new ProjectAccess(
    env({
      CONSTRUCTION_PROJECT_ROLES: 'PROCUREMENT_USER',
      CONSTRUCTION_PROJECT_READER_ROLES: 'FLEET_MANAGER',
    }),
  );

  it('grants exactly the configured writers, and no longer the default', () => {
    expect(codeOf(access, { roles: ['PROCUREMENT_USER'] }, 'write')).toBe('NO_ERROR');
    expect(codeOf(access, { roles: ['ORGANIZATION_ADMIN'] }, 'write')).toBe('INSUFFICIENT_ROLE');
  });

  it('lets a reader read and never write', () => {
    expect(codeOf(access, { roles: ['FLEET_MANAGER'] }, 'read')).toBe('NO_ERROR');
    expect(codeOf(access, { roles: ['FLEET_MANAGER'] }, 'write')).toBe('INSUFFICIENT_ROLE');
  });

  it('lets a writer read', () => {
    expect(codeOf(access, { roles: ['PROCUREMENT_USER'] }, 'read')).toBe('NO_ERROR');
  });
});

describe('the row-level check', () => {
  it('answers 404 for a project of another organization, never 403', () => {
    try {
      assertOwnProject({ id: 'PRJ_1', organizationId: 'ORG-B' }, ORG);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(isRastaError(error) && error.code).toBe('NOT_FOUND');
    }
  });

  it('passes the caller’s own project', () => {
    expect(() => assertOwnProject({ id: 'PRJ_1', organizationId: ORG }, ORG)).not.toThrow();
  });
});

describe('the standalone refusals', () => {
  it('refuse only what they name', () => {
    runWithContext(context({ roles: ['ORGANIZATION_ADMIN'] }), () => {
      expect(() => assertNotAuditor()).not.toThrow();
      expect(() => assertNotServiceCaller()).not.toThrow();
    });
  });
});
