import { RastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import { TEST_ORG_A, TEST_USER_A } from '@rasta/testing';
import { PLATFORM_ROLES, type PlatformRole } from './dto';
import {
  DEFAULT_GRANTS,
  DEFAULT_ROLE_GRANT_POLICY,
  ROLE_SCOPES,
  UNGRANTABLE_ROLES,
  assertMayGrantRoles,
  assertMayManageMembershipRoles,
  assertRolesMayBeRequested,
  grantableRoles,
} from './role-grants';

/**
 * The ladder as a function, and the shape of the table it reads.
 *
 * The attack itself is in `role-escalation.spec.ts`, against the running
 * controller — that is what proves the hole is closed. What is here is the
 * part that is easier to get wrong quietly: the table agreeing with `docs/09`,
 * and the invariants that must survive somebody editing it.
 */

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    correlationId: 'CORR_1',
    requestId: 'REQ_1',
    organizationId: TEST_ORG_A,
    organizationIds: [TEST_ORG_A],
    userId: TEST_USER_A,
    roles: ['ORGANIZATION_ADMIN'],
    authType: 'USER',
    startedAt: 0,
    ...overrides,
  };
}

describe('the scope table mirrors docs/09', () => {
  it('gives every platform role a scope', () => {
    // A role added to `PLATFORM_ROLES` without a scope is a role with no
    // documented place in the RBAC table. `satisfies` catches it at compile
    // time; this catches it if the annotation is ever loosened.
    for (const role of PLATFORM_ROLES) {
      expect(ROLE_SCOPES[role]).toBeDefined();
    }
  });

  it('keeps an organization administrator inside organization scope', () => {
    for (const role of DEFAULT_GRANTS.ORGANIZATION_ADMIN) {
      expect(ROLE_SCOPES[role]).toBe('ORGANIZATION');
    }
  });

  it('lets a union administrator grant its own platform role and nothing else above organization scope', () => {
    const platform = DEFAULT_GRANTS.UNION_ADMIN.filter((role) => ROLE_SCOPES[role] === 'PLATFORM');
    expect(platform).toEqual(['UNION_ADMIN']);
  });

  it('lets no tenant-side administrator grant a supplier-organization or province role (Q-60)', () => {
    // The open half of Q-60: nothing in the product document says who appoints
    // a supplier, a workshop, a contractor or a provincial auditor. Until it
    // does, neither an organization nor a union administrator does — the
    // narrow reading, and the one that can be widened without a migration.
    for (const grants of [DEFAULT_GRANTS.UNION_ADMIN, DEFAULT_GRANTS.ORGANIZATION_ADMIN]) {
      for (const role of grants) {
        expect(['SUPPLIER_ORG', 'PROVINCE']).not.toContain(ROLE_SCOPES[role]);
      }
    }
  });

  it('leaves those roles with the platform operator, who is the only caller left', () => {
    // Stated rather than implied: `SYSTEM_ADMIN`'s default is "everything the
    // API grants at all", so these four land there by construction. If that is
    // the wrong home for them, Q-60 is where the answer goes — and this test
    // is what will fail when it changes.
    for (const role of ['SUPPLIER', 'WORKSHOP', 'CONTRACTOR', 'AUDITOR'] as const) {
      expect(DEFAULT_GRANTS.SYSTEM_ADMIN).toContain(role);
    }
  });
});

describe('grantableRoles', () => {
  it('gives an organization administrator the five organization roles', () => {
    expect(grantableRoles(['ORGANIZATION_ADMIN'], DEFAULT_ROLE_GRANT_POLICY)).toEqual([
      'ORGANIZATION_ADMIN',
      'FLEET_MANAGER',
      'DRIVER',
      'OPERATOR',
      'PROCUREMENT_USER',
    ]);
  });

  it('gives a caller holding two roles the union of both', () => {
    const union = grantableRoles(['ORGANIZATION_ADMIN', 'UNION_ADMIN'], DEFAULT_ROLE_GRANT_POLICY);
    expect(union).toContain('UNION_ADMIN');
    expect(union).toContain('DRIVER');
  });

  it('gives a caller with no acting role nothing', () => {
    expect(grantableRoles(['DRIVER', 'OPERATOR'], DEFAULT_ROLE_GRANT_POLICY)).toEqual([]);
  });

  it('never returns an ungrantable role, whatever the policy says', () => {
    // Defence in depth for the configuration: `roleListEnv` refuses the value
    // at startup, and this refuses it again at the decision. A deployment that
    // finds a way to write it still cannot grant it.
    const reckless = {
      bySystemAdmin: PLATFORM_ROLES,
      byUnionAdmin: PLATFORM_ROLES,
      byOrganizationAdmin: PLATFORM_ROLES,
    };

    for (const actor of ['SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN']) {
      expect(grantableRoles([actor], reckless)).not.toContain('SYSTEM_ADMIN');
    }
  });

  it('returns roles in the platform order, not the order they were configured', () => {
    const shuffled = {
      ...DEFAULT_ROLE_GRANT_POLICY,
      byOrganizationAdmin: ['DRIVER', 'ORGANIZATION_ADMIN', 'FLEET_MANAGER'] as PlatformRole[],
    };
    expect(grantableRoles(['ORGANIZATION_ADMIN'], shuffled)).toEqual([
      'ORGANIZATION_ADMIN',
      'FLEET_MANAGER',
      'DRIVER',
    ]);
  });
});

describe('assertMayGrantRoles', () => {
  const grant = (roles: PlatformRole[], actorRoles: string[]) =>
    runWithContext(context({ roles: actorRoles }), () =>
      assertMayGrantRoles(roles, DEFAULT_ROLE_GRANT_POLICY),
    );

  it('allows a grant inside the ladder', () => {
    expect(() => grant(['FLEET_MANAGER', 'DRIVER'], ['ORGANIZATION_ADMIN'])).not.toThrow();
  });

  it('refuses SYSTEM_ADMIN with INSUFFICIENT_ROLE', () => {
    try {
      grant(['SYSTEM_ADMIN'], ['ORGANIZATION_ADMIN']);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(RastaError);
      expect((error as RastaError).code).toBe('INSUFFICIENT_ROLE');
    }
  });

  it('checks the whole set, so a permitted role does not carry a forbidden one', () => {
    expect(() => grant(['DRIVER', 'UNION_ADMIN'], ['ORGANIZATION_ADMIN'])).toThrow(RastaError);
  });

  it('refuses a service token outright rather than giving it every role', () => {
    expect(() =>
      runWithContext(context({ authType: 'SERVICE', roles: ['SERVICE'], userId: undefined }), () =>
        assertMayGrantRoles(['DRIVER'], DEFAULT_ROLE_GRANT_POLICY),
      ),
    ).toThrow(RastaError);
  });

  it('refuses an anonymous caller', () => {
    expect(() =>
      runWithContext(context({ authType: 'ANONYMOUS', roles: [], userId: undefined }), () =>
        assertMayGrantRoles(['DRIVER'], DEFAULT_ROLE_GRANT_POLICY),
      ),
    ).toThrow(RastaError);
  });

  it('keeps the refused role names out of the message a caller would see', () => {
    try {
      grant(['SYSTEM_ADMIN'], ['ORGANIZATION_ADMIN']);
    } catch (error) {
      expect((error as RastaError).message).not.toContain('SYSTEM_ADMIN');
    }
  });
});

describe('assertMayManageMembershipRoles', () => {
  const manage = (current: string[], actorRoles = ['ORGANIZATION_ADMIN']) =>
    runWithContext(context({ roles: actorRoles }), () =>
      assertMayManageMembershipRoles(current, DEFAULT_ROLE_GRANT_POLICY),
    );

  it('allows administering a membership whose roles are inside the ladder', () => {
    expect(() => manage(['FLEET_MANAGER', 'DRIVER'])).not.toThrow();
  });

  it('allows administering a peer administrator', () => {
    expect(() => manage(['ORGANIZATION_ADMIN'])).not.toThrow();
  });

  it('refuses an organization administrator touching a platform operator membership', () => {
    expect(() => manage(['SYSTEM_ADMIN'])).toThrow(RastaError);
  });

  it('refuses when a role above the ladder sits beside one below it', () => {
    expect(() => manage(['DRIVER', 'UNION_ADMIN'])).toThrow(RastaError);
  });

  it('lets a union administrator manage an organization administrator', () => {
    expect(() => manage(['ORGANIZATION_ADMIN'], ['UNION_ADMIN'])).not.toThrow();
  });

  it('tolerates a role the platform no longer defines, rather than deadlocking the row', () => {
    // A membership seeded before a role was renamed holds a string that is not
    // in `PLATFORM_ROLES` at all. It is not in anybody's ladder either, so the
    // row can only be administered by widening the configuration — which is
    // the conservative direction, and the one an operator can act on.
    expect(() => manage(['LEGACY_ROLE'])).toThrow(RastaError);
  });
});

describe('assertRolesMayBeRequested', () => {
  it('accepts anything that could in principle be granted', () => {
    const requestable = PLATFORM_ROLES.filter((role) => !UNGRANTABLE_ROLES.includes(role));
    expect(() => assertRolesMayBeRequested(requestable)).not.toThrow();
  });

  it('refuses a role nobody can ever grant, with no caller to measure against', () => {
    // No `runWithContext`: the registration endpoint is `@Public`, so this must
    // decide without a context at all.
    expect(() => assertRolesMayBeRequested(['SYSTEM_ADMIN'])).toThrow(RastaError);
  });
});
