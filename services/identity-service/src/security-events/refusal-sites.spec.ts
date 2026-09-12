import { AUDIT_ACTION_PATTERN, ERROR_CODES } from '@rasta/contracts';
import { RastaError } from '@rasta/nest-common';
import { markRefusal, refusalSiteOf, rolesGuardSiteFor, REFUSAL_SITES } from './refusal-sites';

describe('refusal site allowlist (ADR-053 § 4, AUD-004 Phases C1–C6)', () => {
  it('instruments exactly five refusal sites', () => {
    expect(Object.keys(REFUSAL_SITES)).toEqual([
      'SWITCH_ACTIVE_ORGANIZATION',
      'LIST_USERS',
      'CREATE_USER',
      'ADD_MEMBERSHIP',
      'UPDATE_MEMBERSHIP_ROLES',
    ]);
  });

  it('pins the active-organization switch to its route, method, 403 and TENANT_MISMATCH', () => {
    expect(REFUSAL_SITES.SWITCH_ACTIVE_ORGANIZATION).toEqual({
      key: 'identity.switch_active_organization',
      method: 'POST',
      route: '/v1/users/me/active-organization',
      status: 403,
      errorCode: ERROR_CODES.TENANT_MISMATCH,
      decidedBy: 'IDENTITY_SERVICE',
      action: 'identity.active_organization.switch',
      resourceType: 'User',
      resource: 'ACTOR_USER',
      reason:
        'Active organization switch refused: no active membership in the requested organization',
    });
  });

  it('pins the user listing to GET /v1/users, 403 and INSUFFICIENT_ROLE, decided by the roles guard', () => {
    expect(REFUSAL_SITES.LIST_USERS).toEqual({
      key: 'identity.list_users',
      method: 'GET',
      route: '/v1/users',
      status: 403,
      errorCode: ERROR_CODES.INSUFFICIENT_ROLE,
      decidedBy: 'ROLES_GUARD',
      action: 'identity.users.list',
      resourceType: 'User',
      resource: 'ACTOR_USER',
      reason: 'User listing refused: the caller holds none of the roles this endpoint requires',
    });
  });

  it('pins the user creation to POST /v1/users, 403 and INSUFFICIENT_ROLE, decided by the roles guard', () => {
    expect(REFUSAL_SITES.CREATE_USER).toEqual({
      key: 'identity.create_user',
      method: 'POST',
      route: '/v1/users',
      status: 403,
      errorCode: ERROR_CODES.INSUFFICIENT_ROLE,
      decidedBy: 'ROLES_GUARD',
      action: 'identity.users.create',
      resourceType: 'User',
      resource: 'ACTOR_USER',
      reason: 'User creation refused: the caller holds none of the roles this endpoint requires',
    });
  });

  it('pins the membership creation to POST /v1/users/:id/memberships, 403 and INSUFFICIENT_ROLE, decided by the roles guard', () => {
    expect(REFUSAL_SITES.ADD_MEMBERSHIP).toEqual({
      key: 'identity.add_membership',
      method: 'POST',
      route: '/v1/users/:id/memberships',
      status: 403,
      errorCode: ERROR_CODES.INSUFFICIENT_ROLE,
      decidedBy: 'ROLES_GUARD',
      action: 'identity.memberships.create',
      resourceType: 'Membership',
      // The caller, never the target user named in the path.
      resource: 'ACTOR_USER',
      reason:
        'Membership creation refused: the caller holds none of the roles this endpoint requires',
    });
  });

  it('pins the membership role replacement to POST /v1/memberships/:id/roles, 403 and INSUFFICIENT_ROLE, decided by the roles guard', () => {
    expect(REFUSAL_SITES.UPDATE_MEMBERSHIP_ROLES).toEqual({
      key: 'identity.update_membership_roles',
      method: 'POST',
      route: '/v1/memberships/:id/roles',
      status: 403,
      errorCode: ERROR_CODES.INSUFFICIENT_ROLE,
      decidedBy: 'ROLES_GUARD',
      action: 'identity.memberships.roles.replace',
      resourceType: 'Membership',
      // The caller, never the membership named in the path.
      resource: 'ACTOR_USER',
      reason:
        'Membership role replacement refused: the caller holds none of the roles this endpoint requires',
    });
  });

  it('names no role, no query value and no URL in any site’s fixed evidence', () => {
    for (const site of Object.values(REFUSAL_SITES)) {
      for (const text of [site.action, site.resourceType, site.reason]) {
        expect(text).not.toMatch(/ORGANIZATION_ADMIN|UNION_ADMIN|SYSTEM_ADMIN|\?|\/v1\/|:id/);
      }
    }
  });

  describe('rolesGuardSiteFor', () => {
    it.each([
      ['GET', '/v1/users', 'LIST_USERS'],
      ['POST', '/v1/users', 'CREATE_USER'],
      ['POST', '/v1/users/:id/memberships', 'ADD_MEMBERSHIP'],
      ['POST', '/v1/memberships/:id/roles', 'UPDATE_MEMBERSHIP_ROLES'],
    ])('finds the roles-guard site for exactly %s %s', (method, route, expected) => {
      expect(rolesGuardSiteFor(method, route)).toBe(expected);
    });

    it.each<[string, unknown, unknown]>([
      ["the service-decided site's own route", 'POST', '/v1/users/me/active-organization'],
      ['another method on the same template', 'PUT', '/v1/users'],
      ['PATCH on the same template', 'PATCH', '/v1/users'],
      ['another template', 'GET', '/v1/users/:id'],
      ['GET on the membership template', 'GET', '/v1/users/:id/memberships'],
      ['PUT on the membership template', 'PUT', '/v1/users/:id/memberships'],
      ['lower-case POST on the membership template', 'post', '/v1/users/:id/memberships'],
      ['a trailing slash on the membership template', 'POST', '/v1/users/:id/memberships/'],
      ['a differently named parameter', 'POST', '/v1/users/:userId/memberships'],
      ['an adjacent deeper template', 'POST', '/v1/users/:id/memberships/:membershipId'],
      ['a concrete membership URL', 'POST', '/v1/users/USR_01ABC/memberships'],
      ['a concrete membership URL with a query', 'POST', '/v1/users/:id/memberships?role=x'],
      ['lower-case POST on the roles template', 'post', '/v1/memberships/:id/roles'],
      ['GET on the roles template', 'GET', '/v1/memberships/:id/roles'],
      ['PUT on the roles template', 'PUT', '/v1/memberships/:id/roles'],
      ['PATCH on the roles template', 'PATCH', '/v1/memberships/:id/roles'],
      ['a concrete roles URL', 'POST', '/v1/memberships/MBR_01ABC/roles'],
      ['a roles template with a query', 'POST', '/v1/memberships/:id/roles?role=UNION_ADMIN'],
      ['a trailing slash on the roles template', 'POST', '/v1/memberships/:id/roles/'],
      ['a differently named roles parameter', 'POST', '/v1/memberships/:membershipId/roles'],
      ['a deeper roles template', 'POST', '/v1/memberships/:id/roles/:role'],
      ['the membership collection', 'POST', '/v1/memberships'],
      ['membership revoke', 'POST', '/v1/memberships/:id/revoke'],
      ['registration approval', 'POST', '/v1/registration-requests/:id/approve'],
      ['registration rejection', 'POST', '/v1/registration-requests/:id/reject'],
      ['a concrete URL', 'GET', '/v1/users?q=x'],
      ['a concrete POST URL', 'POST', '/v1/users?role=ORGANIZATION_ADMIN'],
      ['a trailing slash', 'GET', '/v1/users/'],
      ['a trailing slash on POST', 'POST', '/v1/users/'],
      ['lower-case method', 'get', '/v1/users'],
      ['lower-case POST', 'post', '/v1/users'],
      ['no route', 'GET', undefined],
      ['no route for a POST', 'POST', undefined],
      ['no method', undefined, '/v1/users/:id/memberships'],
      ['non-string values', 1, { path: '/v1/users' }],
    ])('finds nothing for %s', (_label, method, route) => {
      expect(rolesGuardSiteFor(method, route)).toBeUndefined();
    });
  });

  it.each(Object.values(REFUSAL_SITES))(
    '$key names a dotted action the contract accepts',
    (site) => {
      expect(site.action).toMatch(AUDIT_ACTION_PATTERN);
      expect(site.status).toBe(403);
    },
  );

  it('gives every site its own aggregation identity, so aggregation never merges two sites', () => {
    // Refusals aggregate on action, resource type and error code (plus tenant,
    // actor, resource id and window). Two sites sharing that triple would be
    // counted into one row under one site's fixed reason.
    const identities = Object.values(REFUSAL_SITES).map(
      (site) => `${site.action}|${site.resourceType}|${site.errorCode}`,
    );
    expect(identities).toHaveLength(5);
    expect(new Set(identities).size).toBe(identities.length);
  });

  it('keeps the two roles-guard sites on one template apart only by method', () => {
    const list = REFUSAL_SITES.LIST_USERS;
    const create = REFUSAL_SITES.CREATE_USER;
    expect(create.route).toBe(list.route);
    expect(create.method).not.toBe(list.method);
    expect(create.action).not.toBe(list.action);
    expect(create.key).not.toBe(list.key);
  });

  it('keeps every site key and route template unique per method', () => {
    const sites = Object.values(REFUSAL_SITES);
    expect(new Set(sites.map((site) => site.key)).size).toBe(sites.length);
    expect(new Set(sites.map((site) => `${site.method} ${site.route}`)).size).toBe(sites.length);
  });

  it('marks an error without changing anything the platform filter reads', () => {
    const plain = RastaError.tenantMismatch('ORG_X', []);
    const marked = markRefusal(
      RastaError.tenantMismatch('ORG_X', []),
      'SWITCH_ACTIVE_ORGANIZATION',
    );

    expect(marked).toBeInstanceOf(RastaError);
    expect(marked.status).toBe(plain.status);
    expect(marked.code).toBe(plain.code);
    expect(marked.message).toBe(plain.message);
    expect(marked.internalContext).toEqual(plain.internalContext);
    expect(Object.keys(marked).sort()).toEqual(Object.keys(plain).sort());
    expect(JSON.stringify(marked)).toBe(JSON.stringify(plain));
  });

  it('keeps the two Membership sites apart by action, so their evidence never merges', () => {
    const add = REFUSAL_SITES.ADD_MEMBERSHIP;
    const replace = REFUSAL_SITES.UPDATE_MEMBERSHIP_ROLES;
    expect(replace.resourceType).toBe(add.resourceType);
    expect(replace.errorCode).toBe(add.errorCode);
    expect(replace.action).not.toBe(add.action);
    expect(replace.route).not.toBe(add.route);
  });

  it.each(['CREATE_USER', 'ADD_MEMBERSHIP', 'UPDATE_MEMBERSHIP_ROLES'] as const)(
    'marks a role refusal as %s without changing its serialisation',
    (siteName) => {
      const plain = RastaError.insufficientRole(['ORGANIZATION_ADMIN'], ['AUDITOR']);
      const marked = markRefusal(
        RastaError.insufficientRole(['ORGANIZATION_ADMIN'], ['AUDITOR']),
        siteName,
      );
      expect(refusalSiteOf(marked)).toBe(REFUSAL_SITES[siteName]);
      expect(refusalSiteOf(plain)).toBeUndefined();
      expect(JSON.stringify(marked)).toBe(JSON.stringify(plain));
    },
  );

  it('recognises only the error instance that was marked', () => {
    const marked = markRefusal(
      RastaError.tenantMismatch('ORG_X', []),
      'SWITCH_ACTIVE_ORGANIZATION',
    );
    expect(refusalSiteOf(marked)).toBe(REFUSAL_SITES.SWITCH_ACTIVE_ORGANIZATION);

    // Same code, same message, different instance — e.g. the auth guard's own
    // TENANT_MISMATCH for a bad X-Organization-Id header.
    expect(refusalSiteOf(RastaError.tenantMismatch('ORG_X', ['ORG_A']))).toBeUndefined();
  });

  it.each([
    ['an unmarked FORBIDDEN', RastaError.forbidden()],
    ['an unmarked INSUFFICIENT_ROLE', RastaError.insufficientRole(['UNION_ADMIN'], [])],
    ['an unmarked 401', RastaError.unauthenticated()],
    ['a plain Error', new Error('boom')],
    ['a string', 'TENANT_MISMATCH'],
    ['null', null],
    ['undefined', undefined],
  ])('returns no site for %s', (_label, value) => {
    expect(refusalSiteOf(value)).toBeUndefined();
  });
});
