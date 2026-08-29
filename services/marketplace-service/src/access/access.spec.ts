import { isRastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import {
  assertBuyer,
  assertDisputeResolver,
  assertNotAuditor,
  assertOfferOwner,
  assertOrderVisible,
  assertSupplier,
  hasPlatformScope,
} from './access';

/**
 * Object-level authorization (S-03, BOLA).
 *
 * Every order names two organizations, and each may do exactly one half of
 * what can be done to it. These tests are written from the attacker's side:
 * for each command, who is refused and with which status.
 *
 * The 403/404 split is deliberate and asserted throughout. A stranger gets
 * 404 — refusing by name would confirm the order exists — while a party who is
 * on the wrong side of it gets 403, because they can already see it and the
 * refusal is genuinely about authority.
 */

const BUYER = 'ORG-BUYER';
const SUPPLIER = 'ORG-SUPPLIER';
const STRANGER = 'ORG-STRANGER';

const ORDER = {
  id: 'ORD_1',
  organizationId: BUYER,
  supplierOrganizationId: SUPPLIER,
};

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

describe('the oversight role reaches nothing here', () => {
  it('is refused outright, whatever else it holds', () => {
    // A product-document constraint (`docs/09` § 9.3): aggregate access only,
    // served by analytics-service. Enforced here as well as at the gateway and
    // in every @Roles, because a rule this absolute should not depend on one
    // file staying correct.
    expect(
      codeOf(() =>
        as({ organizationId: BUYER, roles: ['AUDITOR', 'ORGANIZATION_ADMIN'] }, () =>
          assertNotAuditor(),
        ),
      ),
    ).toBe('FORBIDDEN');
  });

  it('cannot read an order it is a party to', () => {
    expect(
      codeOf(() =>
        as({ organizationId: BUYER, roles: ['AUDITOR'] }, () => assertOrderVisible(ORDER)),
      ),
    ).toBe('FORBIDDEN');
  });

  it('never counts as platform scope', () => {
    expect(as({ organizationId: BUYER, roles: ['AUDITOR'] }, () => hasPlatformScope())).toBe(false);
  });
});

describe('reading an order', () => {
  it('is permitted to the buyer', () => {
    expect(() =>
      as({ organizationId: BUYER, roles: ['ORGANIZATION_ADMIN'] }, () => assertOrderVisible(ORDER)),
    ).not.toThrow();
  });

  it('is permitted to the supplier', () => {
    expect(() =>
      as({ organizationId: SUPPLIER, roles: ['SUPPLIER'] }, () => assertOrderVisible(ORDER)),
    ).not.toThrow();
  });

  it('reports 404 to a stranger, not 403', () => {
    // 403 would confirm the order exists, which is the leak.
    expect(
      codeOf(() =>
        as({ organizationId: STRANGER, roles: ['ORGANIZATION_ADMIN'] }, () =>
          assertOrderVisible(ORDER),
        ),
      ),
    ).toBe('NOT_FOUND');
  });

  it('is permitted to a platform operator', () => {
    expect(() =>
      as({ organizationId: STRANGER, roles: ['UNION_ADMIN'] }, () => assertOrderVisible(ORDER)),
    ).not.toThrow();
  });
});

describe('confirming receipt — the command that releases money', () => {
  it('is permitted to the buying organization', () => {
    expect(() =>
      as({ organizationId: BUYER, roles: ['PROCUREMENT_USER'] }, () =>
        assertBuyer(ORDER, 'confirm receipt'),
      ),
    ).not.toThrow();
  });

  it('is refused to the supplier, who would be confirming their own delivery', () => {
    expect(
      codeOf(() =>
        as({ organizationId: SUPPLIER, roles: ['SUPPLIER'] }, () =>
          assertBuyer(ORDER, 'confirm receipt'),
        ),
      ),
    ).toBe('FORBIDDEN');
  });

  it('is refused to a platform operator, who was not there', () => {
    // Deliberately not exempt. An operator confirming receipt would be
    // asserting a delivery they cannot have witnessed (ADR-038 § 5).
    expect(
      codeOf(() =>
        as({ organizationId: STRANGER, roles: ['UNION_ADMIN'] }, () =>
          assertBuyer(ORDER, 'confirm receipt'),
        ),
      ),
    ).toBe('FORBIDDEN');
  });

  it('is refused to a role that cannot commit the organization', () => {
    expect(
      codeOf(() =>
        as({ organizationId: BUYER, roles: ['DRIVER'] }, () =>
          assertBuyer(ORDER, 'confirm receipt'),
        ),
      ),
    ).toBe('FORBIDDEN');
  });
});

describe('supplier-only commands', () => {
  it('permit the supplying organization', () => {
    expect(() =>
      as({ organizationId: SUPPLIER, roles: ['SUPPLIER'] }, () =>
        assertSupplier(ORDER, 'record fulfilment'),
      ),
    ).not.toThrow();
  });

  it('refuse the buyer, who would be recording their own delivery', () => {
    expect(
      codeOf(() =>
        as({ organizationId: BUYER, roles: ['ORGANIZATION_ADMIN', 'SUPPLIER'] }, () =>
          assertSupplier(ORDER, 'record fulfilment'),
        ),
      ),
    ).toBe('FORBIDDEN');
  });

  it('refuse a buyer role even on the right organization', () => {
    expect(
      codeOf(() =>
        as({ organizationId: SUPPLIER, roles: ['PROCUREMENT_USER'] }, () =>
          assertSupplier(ORDER, 'record fulfilment'),
        ),
      ),
    ).toBe('FORBIDDEN');
  });
});

describe('an offer belongs to the supplier that published it', () => {
  const OFFER = { id: 'OFR_1', organizationId: SUPPLIER };

  it('permits its owner to change it', () => {
    expect(() =>
      as({ organizationId: SUPPLIER, roles: ['SUPPLIER'] }, () => assertOfferOwner(OFFER)),
    ).not.toThrow();
  });

  it('reports 404 to another supplier, so the attempt confirms nothing', () => {
    expect(
      codeOf(() =>
        as({ organizationId: STRANGER, roles: ['SUPPLIER'] }, () => assertOfferOwner(OFFER)),
      ),
    ).toBe('NOT_FOUND');
  });

  it('refuses a buyer role before it looks at ownership at all', () => {
    expect(
      codeOf(() =>
        as({ organizationId: SUPPLIER, roles: ['PROCUREMENT_USER'] }, () =>
          assertOfferOwner(OFFER),
        ),
      ),
    ).toBe('FORBIDDEN');
  });
});

describe('resolving a dispute is an operator decision', () => {
  it('permits a platform role', () => {
    expect(() =>
      as({ organizationId: STRANGER, roles: ['UNION_ADMIN'] }, () => assertDisputeResolver()),
    ).not.toThrow();
  });

  it('refuses the buyer, who raised it', () => {
    expect(
      codeOf(() =>
        as({ organizationId: BUYER, roles: ['ORGANIZATION_ADMIN'] }, () => assertDisputeResolver()),
      ),
    ).toBe('FORBIDDEN');
  });

  it('refuses the supplier, who is the other party to it', () => {
    expect(
      codeOf(() =>
        as({ organizationId: SUPPLIER, roles: ['SUPPLIER'] }, () => assertDisputeResolver()),
      ),
    ).toBe('FORBIDDEN');
  });
});

describe('a service caller gets no tenant privilege from being a service', () => {
  it('is exempt from the role check and from nothing else', () => {
    // The lesson ADR-035 produced in economic-service: a service short-circuit
    // that skipped the *tenant* check turned into a cross-tenant read the
    // moment service tokens started naming an organization.
    expect(
      as(
        { authType: 'SERVICE', callerService: 'x', roles: ['SERVICE'], organizationId: BUYER },
        () => hasPlatformScope(),
      ),
    ).toBe(false);
  });

  it('is still bound to the organization its token names', () => {
    expect(
      codeOf(() =>
        as(
          {
            authType: 'SERVICE',
            callerService: 'marketplace-service',
            roles: ['SERVICE'],
            organizationId: STRANGER,
          },
          () => assertBuyer(ORDER, 'confirm receipt'),
        ),
      ),
    ).toBe('FORBIDDEN');
  });

  it('is permitted when its token names the buying organization', () => {
    expect(() =>
      as(
        {
          authType: 'SERVICE',
          callerService: 'marketplace-service',
          roles: ['SERVICE'],
          organizationId: BUYER,
        },
        () => assertBuyer(ORDER, 'confirm receipt'),
      ),
    ).not.toThrow();
  });
});
