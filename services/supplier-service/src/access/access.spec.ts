import { isRastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import {
  assertActingAsSupplier,
  assertCanBrowseDirectory,
  assertCanDecideAbout,
  assertCanRegisterSupplier,
  assertCanReviewQualifications,
  assertNotAuditor,
  assertNotDecidingOwnCase,
  assertNotServiceCaller,
  assertSupplierReadable,
  DIRECTORY_ROLES,
  hasPlatformScope,
  PLATFORM_ROLES,
  SUPPLIER_SIDE_ROLES,
} from './access';

/**
 * Object-level authorization (AGENTS.md S-03, BOLA).
 *
 * Written from the attacker's side: for each command, who is refused and with
 * which status. The 403/404 split is asserted throughout — a stranger gets 404,
 * because refusing by name would confirm the profile exists, while somebody who
 * can already see the profile but lacks the authority gets 403.
 *
 * The most important case in the file is the last block. A person who
 * legitimately holds `UNION_ADMIN` **and** belongs to the supplier organization
 * passes every role check there is, and only the row can catch them.
 */

const SUPPLIER_ORG = 'ORG-SUPPLIER';
const OTHER_ORG = 'ORG-OTHER';

const SUPPLIER = { id: 'SUP_1', organizationId: SUPPLIER_ORG };

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

const EVERY_COMMAND: [string, () => unknown][] = [
  ['register', () => assertCanRegisterSupplier()],
  ['browse the directory', () => assertCanBrowseDirectory()],
  ['review the queue', () => assertCanReviewQualifications()],
  ['read a profile', () => assertSupplierReadable(SUPPLIER)],
  ['act as the supplier', () => assertActingAsSupplier(SUPPLIER)],
  ['decide about the supplier', () => assertCanDecideAbout(SUPPLIER)],
];

// ---------------------------------------------------------------------------

describe('the oversight role reaches nothing here', () => {
  it.each(EVERY_COMMAND)('AUDITOR cannot %s', (_label, command) => {
    // docs/09 § 9.3 makes it a product constraint: aggregate access only,
    // served by analytics-service. A supplier directory is row-level data about
    // named organizations, which is the opposite.
    expect(codeOf(() => as({ organizationId: OTHER_ORG, roles: ['AUDITOR'] }, command))).toBe(
      'FORBIDDEN',
    );
  });

  it('is refused even when it also holds a permitted role', () => {
    // The check is on the presence of AUDITOR, not on the absence of everything
    // else. A token carrying both must not be able to launder the oversight
    // role through the other one.
    expect(
      codeOf(() =>
        as({ organizationId: OTHER_ORG, roles: ['AUDITOR', 'SYSTEM_ADMIN'] }, assertNotAuditor),
      ),
    ).toBe('FORBIDDEN');
  });
});

describe('service callers get nothing in this phase', () => {
  it.each(EVERY_COMMAND)('a SERVICE token cannot %s', (_label, command) => {
    // AuthGuard already refuses a service token on an endpoint with no
    // @AllowService (ADR-020). This is the second layer, so the first
    // @AllowService added later grants exactly what it names and nothing more.
    expect(
      codeOf(() =>
        as(
          { authType: 'SERVICE', callerService: 'marketplace-service', roles: ['SERVICE'] },
          command,
        ),
      ),
    ).toBe('FORBIDDEN');
  });

  it('never gives a service caller platform scope', () => {
    // The ADR-035 lesson: a leaked internal token must not become a
    // platform-wide reader.
    expect(as({ authType: 'SERVICE', roles: ['SERVICE', 'SYSTEM_ADMIN'] }, hasPlatformScope)).toBe(
      false,
    );
  });

  it('refuses a service token on its own', () => {
    expect(
      codeOf(() => as({ authType: 'SERVICE', roles: ['SERVICE'] }, assertNotServiceCaller)),
    ).toBe('FORBIDDEN');
  });
});

describe('registering a profile', () => {
  it.each(SUPPLIER_SIDE_ROLES)('%s may register for its own organization', (role) => {
    expect(
      codeOf(() => as({ organizationId: SUPPLIER_ORG, roles: [role] }, assertCanRegisterSupplier)),
    ).toBe('NO_ERROR');
  });

  it.each(PLATFORM_ROLES)('%s may not register a supplier profile', (role) => {
    // A platform operator registering a supplier would create the very record
    // they are then asked to judge.
    expect(
      codeOf(() => as({ organizationId: OTHER_ORG, roles: [role] }, assertCanRegisterSupplier)),
    ).toBe('FORBIDDEN');
  });

  it.each(['PROCUREMENT_USER', 'FLEET_MANAGER', 'DRIVER', 'OPERATOR'])(
    '%s may not register a supplier profile',
    (role) => {
      expect(
        codeOf(() =>
          as({ organizationId: SUPPLIER_ORG, roles: [role] }, assertCanRegisterSupplier),
        ),
      ).toBe('FORBIDDEN');
    },
  );

  it('refuses a token that names no organization rather than defaulting one', () => {
    // Defaulting would invent a tenant for the profile.
    expect(codeOf(() => as({ roles: ['SUPPLIER'] }, assertCanRegisterSupplier))).not.toBe(
      'NO_ERROR',
    );
  });
});

describe('reading a private profile', () => {
  it.each(SUPPLIER_SIDE_ROLES)('%s may read its own organization profile', (role) => {
    expect(
      codeOf(() =>
        as({ organizationId: SUPPLIER_ORG, roles: [role] }, () => assertSupplierReadable(SUPPLIER)),
      ),
    ).toBe('NO_ERROR');
  });

  it.each(PLATFORM_ROLES)('%s may read any profile, in order to review it', (role) => {
    expect(
      codeOf(() =>
        as({ organizationId: OTHER_ORG, roles: [role] }, () => assertSupplierReadable(SUPPLIER)),
      ),
    ).toBe('NO_ERROR');
  });

  it('answers 404 for another tenant, never 403', () => {
    // A 403 would confirm the profile exists and that somebody else owns it,
    // which for a directory of named organizations is itself the disclosure.
    expect(
      codeOf(() =>
        as({ organizationId: OTHER_ORG, roles: ['SUPPLIER'] }, () =>
          assertSupplierReadable(SUPPLIER),
        ),
      ),
    ).toBe('NOT_FOUND');
  });

  it('answers 404 for a procurement user in another tenant too', () => {
    // A directory role may *list* this supplier and see the catalogue-safe
    // projection. The private record is a different object and stays closed.
    expect(
      codeOf(() =>
        as({ organizationId: OTHER_ORG, roles: ['PROCUREMENT_USER'] }, () =>
          assertSupplierReadable(SUPPLIER),
        ),
      ),
    ).toBe('NOT_FOUND');
  });
});

describe('the directory crosses tenants on purpose', () => {
  it.each(DIRECTORY_ROLES)('%s may browse it from any organization', (role) => {
    expect(
      codeOf(() => as({ organizationId: OTHER_ORG, roles: [role] }, assertCanBrowseDirectory)),
    ).toBe('NO_ERROR');
  });

  it.each(['DRIVER', 'OPERATOR', 'TECHNICIAN'])('%s may not browse it', (role) => {
    expect(
      codeOf(() => as({ organizationId: OTHER_ORG, roles: [role] }, assertCanBrowseDirectory)),
    ).toBe('FORBIDDEN');
  });
});

describe('acting as the supplier', () => {
  it('lets the owning organization submit a qualification', () => {
    expect(
      codeOf(() =>
        as({ organizationId: SUPPLIER_ORG, roles: ['SUPPLIER'] }, () =>
          assertActingAsSupplier(SUPPLIER),
        ),
      ),
    ).toBe('NO_ERROR');
  });

  it.each(PLATFORM_ROLES)('does not let %s submit on a supplier behalf', (role) => {
    // Platform scope exempts a *read*, never this. A submission whose
    // `submittedBy` is the person who will approve it leaves the self-approval
    // check with nothing to catch: both halves are already the same person.
    //
    // 403 rather than 404 here, and the reason is which check fires first: a
    // platform role is not a supplier-side role, so they are refused on the
    // role before the row is ever compared. They are not being told anything
    // about whether this supplier exists — they can already read it.
    expect(
      codeOf(() =>
        as({ organizationId: OTHER_ORG, roles: [role] }, () => assertActingAsSupplier(SUPPLIER)),
      ),
    ).toBe('FORBIDDEN');
  });

  it('refuses an operator who also holds a supplier-side role in another organization', () => {
    // The role check passes for this person, so the tenant comparison is what
    // stops them — and it answers 404, because from the supplier-side door they
    // are simply somebody from another organization.
    expect(
      codeOf(() =>
        as({ organizationId: OTHER_ORG, roles: ['UNION_ADMIN', 'ORGANIZATION_ADMIN'] }, () =>
          assertActingAsSupplier(SUPPLIER),
        ),
      ),
    ).toBe('NOT_FOUND');
  });

  it('answers 404 for a supplier in another tenant', () => {
    expect(
      codeOf(() =>
        as({ organizationId: OTHER_ORG, roles: ['CONTRACTOR'] }, () =>
          assertActingAsSupplier(SUPPLIER),
        ),
      ),
    ).toBe('NOT_FOUND');
  });
});

describe('deciding a qualification or a suspension', () => {
  it.each(PLATFORM_ROLES)('%s from another organization may decide', (role) => {
    expect(
      codeOf(() =>
        as({ organizationId: OTHER_ORG, roles: [role] }, () => assertCanDecideAbout(SUPPLIER)),
      ),
    ).toBe('NO_ERROR');
  });

  it.each(SUPPLIER_SIDE_ROLES)('%s may never decide, even about another organization', (role) => {
    expect(
      codeOf(() =>
        as({ organizationId: OTHER_ORG, roles: [role] }, () => assertCanDecideAbout(SUPPLIER)),
      ),
    ).toBe('FORBIDDEN');
  });

  it('refuses a supplier trying to decide its own case, on the role check first', () => {
    expect(
      codeOf(() =>
        as({ organizationId: SUPPLIER_ORG, roles: ['ORGANIZATION_ADMIN'] }, () =>
          assertCanDecideAbout(SUPPLIER),
        ),
      ),
    ).toBe('FORBIDDEN');
  });

  it('lets only a platform operator reach the review queue', () => {
    expect(
      codeOf(() =>
        as({ organizationId: OTHER_ORG, roles: ['UNION_ADMIN'] }, assertCanReviewQualifications),
      ),
    ).toBe('NO_ERROR');
    expect(
      codeOf(() =>
        as({ organizationId: SUPPLIER_ORG, roles: ['SUPPLIER'] }, assertCanReviewQualifications),
      ),
    ).toBe('FORBIDDEN');
  });
});

describe('nobody decides their own case — the check a role can never make', () => {
  it.each(PLATFORM_ROLES)('%s belonging to the supplier organization is refused', (role) => {
    // The case that matters. This person legitimately holds an operator role
    // and legitimately belongs to the supplier organization, so every role
    // check they face passes. Only the row can catch them.
    expect(
      codeOf(() =>
        as({ organizationId: SUPPLIER_ORG, roles: [role] }, () => assertCanDecideAbout(SUPPLIER)),
      ),
    ).toBe('FORBIDDEN');
  });

  it('does not exempt SYSTEM_ADMIN', () => {
    // An exemption would make the control depend on which admin role somebody
    // holds, and the point is that no role makes self-judgement acceptable.
    expect(
      codeOf(() =>
        as({ organizationId: SUPPLIER_ORG, roles: ['SYSTEM_ADMIN'] }, () =>
          assertNotDecidingOwnCase(SUPPLIER),
        ),
      ),
    ).toBe('FORBIDDEN');
  });

  it('answers 403, not 404 — they can already see this profile', () => {
    // Hiding it would be theatre. What they are told is that the decision is
    // not theirs to make.
    expect(
      codeOf(() =>
        as({ organizationId: SUPPLIER_ORG, roles: ['UNION_ADMIN'] }, () =>
          assertNotDecidingOwnCase(SUPPLIER),
        ),
      ),
    ).toBe('FORBIDDEN');
  });

  it('allows an operator from any other organization', () => {
    expect(
      codeOf(() =>
        as({ organizationId: OTHER_ORG, roles: ['UNION_ADMIN'] }, () =>
          assertNotDecidingOwnCase(SUPPLIER),
        ),
      ),
    ).toBe('NO_ERROR');
  });

  it('allows a platform operator whose token names no organization', () => {
    // A SYSTEM_ADMIN acting platform-wide has no organization to collide with,
    // and refusing them would make the control unusable for the one population
    // it is meant to serve.
    expect(
      codeOf(() => as({ roles: ['SYSTEM_ADMIN'] }, () => assertNotDecidingOwnCase(SUPPLIER))),
    ).toBe('NO_ERROR');
  });
});

describe('a supplier cannot reach its own decision by another door', () => {
  it('cannot approve through the acting-as-supplier gate', () => {
    // `assertActingAsSupplier` is the gate a supplier passes. It is never the
    // gate a decision passes: the two are separate functions and the
    // controllers wire the decision commands to `assertCanDecideAbout` only.
    const supplierSide = codeOf(() =>
      as({ organizationId: SUPPLIER_ORG, roles: ['SUPPLIER'] }, () =>
        assertActingAsSupplier(SUPPLIER),
      ),
    );
    const decision = codeOf(() =>
      as({ organizationId: SUPPLIER_ORG, roles: ['SUPPLIER'] }, () =>
        assertCanDecideAbout(SUPPLIER),
      ),
    );

    expect(supplierSide).toBe('NO_ERROR');
    expect(decision).toBe('FORBIDDEN');
  });
});
