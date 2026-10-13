import { isRastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import { loadInventoryEnv, type InventoryEnv } from '../config/env';
import { InventoryAccess } from './access';

/**
 * Authorization, written from the refused caller's side: who is refused and with which code.
 * The operator and reader roles come from configuration (Q-103), so each case builds the access
 * object from an environment rather than from a constant.
 */

const ORG = 'ORG-A';

function env(overrides: NodeJS.ProcessEnv = {}): InventoryEnv {
  return loadInventoryEnv({
    KAFKA_BROKERS: 'localhost:9092',
    OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
    OIDC_JWKS_URI: 'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
    OIDC_AUDIENCE: 'rasta-api',
    INTERNAL_TOKEN_SECRET: 'a-throwaway-value-used-only-by-this-spec-32',
    DATABASE_URL: 'postgresql://u:p@localhost:5433/rasta_inventory?schema=public',
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
    organizationIds: [ORG],
    userId: 'USR_1',
    platformUserId: true,
    ...overrides,
  } as RequestContext;
}

function attempt<T>(fn: () => T, overrides: Partial<RequestContext>): T | string {
  return runWithContext(context(overrides), () => {
    try {
      return fn();
    } catch (error) {
      return isRastaError(error) ? error.code : `NOT_A_PLATFORM_ERROR: ${String(error)}`;
    }
  });
}

describe('with the default configuration (Q-103)', () => {
  const access = new InventoryAccess(env());

  it('lets ORGANIZATION_ADMIN operate and read for its own organization', () => {
    expect(attempt(() => access.assertOperator(), { roles: ['ORGANIZATION_ADMIN'] })).toEqual({
      organizationId: ORG,
      userId: 'USR_1',
    });
    expect(attempt(() => access.assertReader(), { roles: ['ORGANIZATION_ADMIN'] })).toEqual({
      organizationId: ORG,
    });
  });

  it('refuses a role the configuration does not name', () => {
    for (const role of ['UNION_ADMIN', 'SUPPLIER', 'CONTRACTOR', 'PROCUREMENT_USER']) {
      expect([role, attempt(() => access.assertOperator(), { roles: [role] })]).toEqual([
        role,
        'INSUFFICIENT_ROLE',
      ]);
      expect([role, attempt(() => access.assertReader(), { roles: [role] })]).toEqual([
        role,
        'INSUFFICIENT_ROLE',
      ]);
    }
  });

  it('refuses the oversight role even beside a granted one', () => {
    const roles = ['ORGANIZATION_ADMIN', 'AUDITOR'];
    expect(attempt(() => access.assertOperator(), { roles })).toBe('FORBIDDEN');
    expect(attempt(() => access.assertReader(), { roles })).toBe('FORBIDDEN');
  });

  it('refuses the platform administrator, who does not keep stock for an organization', () => {
    const roles = ['SYSTEM_ADMIN', 'ORGANIZATION_ADMIN'];
    expect(attempt(() => access.assertOperator(), { roles })).toBe('FORBIDDEN');
    expect(attempt(() => access.assertReader(), { roles })).toBe('FORBIDDEN');
  });

  it('refuses a service token: no service calls inventory in PR 1', () => {
    const service = { authType: 'SERVICE' as const, roles: ['ORGANIZATION_ADMIN'] };
    expect(attempt(() => access.assertOperator(), service)).toBe('FORBIDDEN');
    expect(attempt(() => access.assertReader(), service)).toBe('FORBIDDEN');
  });

  it('refuses a caller acting for no organization', () => {
    const none = { roles: ['ORGANIZATION_ADMIN'], organizationId: undefined };
    expect(attempt(() => access.assertOperator(), none)).toBe('FORBIDDEN');
    expect(attempt(() => access.assertReader(), none)).toBe('FORBIDDEN');
  });

  it('requires a platform user id of an operator, whose id is stamped on every row', () => {
    expect(
      attempt(() => access.assertOperator(), {
        roles: ['ORGANIZATION_ADMIN'],
        platformUserId: false,
      }),
    ).toBe('FORBIDDEN');
  });
});

describe('with configured roles', () => {
  const access = new InventoryAccess(
    env({ INVENTORY_OPERATOR_ROLES: 'UNION_ADMIN', INVENTORY_READER_ROLES: 'PROCUREMENT_USER' }),
  );

  it('lets a reader read and not write', () => {
    expect(attempt(() => access.assertReader(), { roles: ['PROCUREMENT_USER'] })).toEqual({
      organizationId: ORG,
    });
    expect(attempt(() => access.assertOperator(), { roles: ['PROCUREMENT_USER'] })).toBe(
      'INSUFFICIENT_ROLE',
    );
  });

  it('lets an operator read what it writes', () => {
    expect(attempt(() => access.assertReader(), { roles: ['UNION_ADMIN'] })).toEqual({
      organizationId: ORG,
    });
  });

  it('no longer grants the default role', () => {
    expect(attempt(() => access.assertReader(), { roles: ['ORGANIZATION_ADMIN'] })).toBe(
      'INSUFFICIENT_ROLE',
    );
  });
});
