import { isRastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import { loadAnalyticsEnv, type AnalyticsEnv } from '../config/env';
import { DashboardAccess } from './access';

/**
 * Authorization of the tenant dashboards, written from the refused caller's side: who is
 * refused and with which code. The readers come from configuration, so each case builds the
 * access object from an environment rather than from a constant.
 */

const ORG = 'ORG-A';

function env(overrides: NodeJS.ProcessEnv = {}): AnalyticsEnv {
  return loadAnalyticsEnv({
    NODE_ENV: 'test',
    KAFKA_BROKERS: 'localhost:9092',
    KAFKA_ALLOW_PLAINTEXT: 'true',
    OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
    OIDC_JWKS_URI: 'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
    OIDC_AUDIENCE: 'rasta-api',
    INTERNAL_TOKEN_SECRET: 'a-throwaway-value-used-only-by-this-spec-32',
    DATABASE_URL: 'postgresql://u:p@localhost:5433/rasta_analytics?schema=public',
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

function outcome(access: DashboardAccess, overrides: Partial<RequestContext>): string {
  return runWithContext(context(overrides), () => {
    try {
      return `READS ${access.assertCanReadFleet()}`;
    } catch (error) {
      return isRastaError(error) ? error.code : `NOT_A_PLATFORM_ERROR: ${String(error)}`;
    }
  });
}

describe('with the default configuration', () => {
  const access = new DashboardAccess(env());

  it.each(['ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'SYSTEM_ADMIN'])(
    'lets %s read its own organization’s fleet dashboard',
    (role) => {
      expect(outcome(access, { roles: [role] })).toBe(`READS ${ORG}`);
    },
  );

  it.each(['DRIVER', 'OPERATOR', 'PROCUREMENT_USER', 'SUPPLIER', 'CONTRACTOR', 'UNION_ADMIN'])(
    'refuses %s with INSUFFICIENT_ROLE',
    (role) => {
      expect(outcome(access, { roles: [role] })).toBe('INSUFFICIENT_ROLE');
    },
  );

  it('refuses the oversight role even beside a reader role (docs/09 § 9.3)', () => {
    expect(outcome(access, { roles: ['AUDITOR'] })).toBe('FORBIDDEN');
    expect(outcome(access, { roles: ['FLEET_MANAGER', 'AUDITOR'] })).toBe('FORBIDDEN');
  });

  it('refuses a service-to-service caller', () => {
    expect(outcome(access, { authType: 'SERVICE', roles: ['SYSTEM_ADMIN'] })).toBe('FORBIDDEN');
  });

  it('refuses a SYSTEM_ADMIN that selected no organization, rather than reading every one', () => {
    expect(outcome(access, { roles: ['SYSTEM_ADMIN'], organizationId: undefined })).toBe(
      'FORBIDDEN',
    );
  });
});

describe('at boot', () => {
  it('refuses to start with a role the platform does not have', () => {
    expect(
      () =>
        new DashboardAccess(env({ ANALYTICS_FLEET_DASHBOARD_ROLES: 'FLEET_MANAGER,FLEET_BOSS' })),
    ).toThrow(/Unknown role in ANALYTICS_FLEET_DASHBOARD_ROLES: FLEET_BOSS/);
  });
});

describe('with another configuration', () => {
  it('reads only the configured roles, plus SYSTEM_ADMIN', () => {
    const access = new DashboardAccess(env({ ANALYTICS_FLEET_DASHBOARD_ROLES: 'FLEET_MANAGER' }));
    expect(outcome(access, { roles: ['FLEET_MANAGER'] })).toBe(`READS ${ORG}`);
    expect(outcome(access, { roles: ['ORGANIZATION_ADMIN'] })).toBe('INSUFFICIENT_ROLE');
    expect(outcome(access, { roles: ['SYSTEM_ADMIN'] })).toBe(`READS ${ORG}`);
  });
});
