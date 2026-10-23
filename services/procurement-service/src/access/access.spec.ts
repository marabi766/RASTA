import { isRastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import { loadProcurementEnv, type ProcurementEnv } from '../config/env';
import { ProcurementAccess, assertOwnedBy } from './access';

/**
 * Authorization, written from the refused caller's side: who is refused and with which code. The
 * roles come from configuration (ADR-070 § 2), so each case builds the access object from an
 * environment rather than from a constant.
 */

const ORG = 'ORG-A';

function env(overrides: NodeJS.ProcessEnv = {}): ProcurementEnv {
  return loadProcurementEnv({
    KAFKA_BROKERS: 'localhost:9092',
    OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
    OIDC_JWKS_URI: 'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
    OIDC_AUDIENCE: 'rasta-api',
    INTERNAL_TOKEN_SECRET: ['only', 'this', 'spec', 'reads', 'it'].join('-').padEnd(40, '-'),
    DATABASE_URL: 'postgresql://u:p@localhost:5433/rasta_procurement?schema=public',
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

function outcome(access: ProcurementAccess, overrides: Partial<RequestContext>) {
  return runWithContext(context(overrides), () => {
    try {
      return { acting: access.assertBuyer() };
    } catch (error) {
      if (!isRastaError(error)) throw error;
      return { code: error.code };
    }
  });
}

describe('ProcurementAccess.assertBuyer', () => {
  const access = new ProcurementAccess(env());

  it.each([['PROCUREMENT_USER'], ['ORGANIZATION_ADMIN']])(
    'lets %s of the buyer’s own organization act, for that organization only',
    (role) => {
      expect(outcome(access, { roles: [role] })).toEqual({ acting: { organizationId: ORG } });
    },
  );

  it.each([
    ['a role the configuration does not grant', { roles: ['FLEET_MANAGER'] }, 'INSUFFICIENT_ROLE'],
    ['no role at all', { roles: [] }, 'INSUFFICIENT_ROLE'],
    [
      'the oversight role, even beside a demand role',
      { roles: ['AUDITOR', 'PROCUREMENT_USER'] },
      'FORBIDDEN',
    ],
    [
      'the platform administrator, whatever organization it selected',
      { roles: ['SYSTEM_ADMIN', 'ORGANIZATION_ADMIN'] },
      'FORBIDDEN',
    ],
    ['a service token', { authType: 'SERVICE', roles: ['PROCUREMENT_USER'] }, 'FORBIDDEN'],
    [
      'a demand role acting for no organization',
      { roles: ['PROCUREMENT_USER'], organizationId: undefined },
      'FORBIDDEN',
    ],
  ] as const)('refuses %s', (_label, overrides, code) => {
    expect(outcome(access, overrides as Partial<RequestContext>)).toEqual({ code });
  });

  it('follows the configuration: a narrowed list refuses the role it dropped', () => {
    const narrowed = new ProcurementAccess(env({ PROCUREMENT_DEMAND_ROLES: 'ORGANIZATION_ADMIN' }));
    expect(outcome(narrowed, { roles: ['PROCUREMENT_USER'] })).toEqual({
      code: 'INSUFFICIENT_ROLE',
    });
    expect(outcome(narrowed, { roles: ['ORGANIZATION_ADMIN'] })).toEqual({
      acting: { organizationId: ORG },
    });
  });
});

describe('ProcurementAccess.assertRfqIssuer (cancelling an aggregation, ADR-070 plan PR 2)', () => {
  const issuer = (access: ProcurementAccess, overrides: Partial<RequestContext>) =>
    runWithContext(context(overrides), () => {
      try {
        return { acting: access.assertRfqIssuer() };
      } catch (error) {
        if (!isRastaError(error)) throw error;
        return { code: error.code };
      }
    });
  const access = new ProcurementAccess(env());

  it('lets the buyer’s ORGANIZATION_ADMIN act by default, and not its PROCUREMENT_USER (docs/09: rfq:read only)', () => {
    expect(issuer(access, { roles: ['ORGANIZATION_ADMIN'] })).toEqual({
      acting: { organizationId: ORG },
    });
    expect(issuer(access, { roles: ['PROCUREMENT_USER'] })).toEqual({ code: 'INSUFFICIENT_ROLE' });
  });

  it.each([
    ['the oversight role', { roles: ['AUDITOR', 'ORGANIZATION_ADMIN'] }, 'FORBIDDEN'],
    ['the platform administrator', { roles: ['SYSTEM_ADMIN', 'ORGANIZATION_ADMIN'] }, 'FORBIDDEN'],
    ['a service token', { authType: 'SERVICE', roles: ['ORGANIZATION_ADMIN'] }, 'FORBIDDEN'],
    [
      'an issuer role acting for no organization',
      { roles: ['ORGANIZATION_ADMIN'], organizationId: undefined },
      'FORBIDDEN',
    ],
  ] as const)('refuses %s', (_label, overrides, code) => {
    expect(issuer(access, overrides as Partial<RequestContext>)).toEqual({ code });
  });

  it('follows its own configuration, apart from the demand roles', () => {
    const configured = new ProcurementAccess(
      env({ PROCUREMENT_RFQ_ISSUER_ROLES: 'PROCUREMENT_USER' }),
    );
    expect(issuer(configured, { roles: ['PROCUREMENT_USER'] })).toEqual({
      acting: { organizationId: ORG },
    });
    expect(issuer(configured, { roles: ['ORGANIZATION_ADMIN'] })).toEqual({
      code: 'INSUFFICIENT_ROLE',
    });
  });
});

describe('ProcurementAccess on an RFQ (ADR-070 § 3, § 10; plan PR 6)', () => {
  const access = new ProcurementAccess(env());
  const attempt = <T>(overrides: Partial<RequestContext>, act: () => T) =>
    runWithContext(context(overrides), () => {
      try {
        return { value: act() };
      } catch (error) {
        if (!isRastaError(error)) throw error;
        return { code: error.code };
      }
    });

  it.each([
    ['the oversight role', { roles: ['AUDITOR', 'SUPPLIER'] }],
    [
      'the platform administrator, even beside a supplier role',
      { roles: ['SYSTEM_ADMIN', 'SUPPLIER'] },
    ],
    ['a service token', { authType: 'SERVICE', roles: ['SUPPLIER'] }],
    ['a person acting for no organization', { roles: ['SUPPLIER'], organizationId: undefined }],
  ] as const)('refuses %s before anything is read, on either side', (_label, overrides) => {
    const asked = overrides as Partial<RequestContext>;
    expect(attempt(asked, () => access.assertRfqCaller())).toEqual({ code: 'FORBIDDEN' });
    expect(attempt(asked, () => access.assertRfqSupplierReader())).toEqual({ code: 'FORBIDDEN' });
  });

  it('judges the buyer’s role once its RFQ is found: commands by the issuer roles, reads by those and the demand roles', () => {
    const judged = (roles: string[], grant: 'read' | 'command') =>
      attempt({ roles }, () => {
        const caller = access.assertRfqCaller();
        access.assertRfqBuyerRole(caller, grant);
        return caller.organizationId;
      });
    expect(judged(['ORGANIZATION_ADMIN'], 'command')).toEqual({ value: ORG });
    expect(judged(['PROCUREMENT_USER'], 'command')).toEqual({ code: 'INSUFFICIENT_ROLE' });
    expect(judged(['PROCUREMENT_USER'], 'read')).toEqual({ value: ORG });
    expect(judged(['SUPPLIER'], 'read')).toEqual({ code: 'INSUFFICIENT_ROLE' });
  });

  it('reads as an invited supplier by PROCUREMENT_SUPPLIER_ROLES only, from configuration', () => {
    const supplierSide = (target: ProcurementAccess, roles: string[]) =>
      attempt({ roles }, () => target.mayReadAsSupplier(target.assertRfqCaller()));
    expect(supplierSide(access, ['SUPPLIER'])).toEqual({ value: true });
    expect(supplierSide(access, ['ORGANIZATION_ADMIN'])).toEqual({ value: false });
    expect(
      attempt({ roles: ['ORGANIZATION_ADMIN'] }, () => access.assertRfqSupplierReader()),
    ).toEqual({ code: 'INSUFFICIENT_ROLE' });
    expect(attempt({ roles: ['SUPPLIER'] }, () => access.assertRfqSupplierReader())).toEqual({
      value: { organizationId: ORG },
    });
    const configured = new ProcurementAccess(env({ PROCUREMENT_SUPPLIER_ROLES: 'WORKSHOP' }));
    expect(supplierSide(configured, ['SUPPLIER'])).toEqual({ value: false });
    expect(supplierSide(configured, ['WORKSHOP'])).toEqual({ value: true });
  });

  it('lists the buyer’s RFQs by the read roles, judged first', () => {
    expect(attempt({ roles: ['PROCUREMENT_USER'] }, () => access.assertRfqBuyerReader())).toEqual({
      value: { organizationId: ORG },
    });
    expect(attempt({ roles: ['SUPPLIER'] }, () => access.assertRfqBuyerReader())).toEqual({
      code: 'INSUFFICIENT_ROLE',
    });
  });
});

describe('assertOwnedBy', () => {
  it('passes the buyer’s own row and answers 404 — never 403 — for another organization’s', () => {
    expect(() =>
      assertOwnedBy({ id: 'DMD_1', organizationId: ORG }, { organizationId: ORG }, 'DemandRequest'),
    ).not.toThrow();
    try {
      assertOwnedBy(
        { id: 'DMD_1', organizationId: 'ORG-B' },
        { organizationId: ORG },
        'DemandRequest',
      );
      throw new Error('not refused');
    } catch (error) {
      expect(isRastaError(error) && error.code).toBe('NOT_FOUND');
    }
  });
});
