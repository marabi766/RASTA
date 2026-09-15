import { AUDIT_ACTION_PATTERN, ERROR_CODES } from '@rasta/contracts';
import { RastaError } from '@rasta/nest-common';
import {
  markGuardRefusal,
  markRefusal,
  refusalSiteOf,
  rolesGuardSiteFor,
  trustedAttributionOf,
  REFUSAL_SITES,
} from './refusal-sites';

describe('refusal site allowlist (ADR-053 § 4, AUD-004 Phases C1–C10)', () => {
  it('instruments exactly nine refusal sites', () => {
    expect(Object.keys(REFUSAL_SITES)).toEqual([
      'SWITCH_ACTIVE_ORGANIZATION',
      'LIST_USERS',
      'CREATE_USER',
      'ADD_MEMBERSHIP',
      'UPDATE_MEMBERSHIP_ROLES',
      'REVOKE_MEMBERSHIP',
      'APPROVE_REGISTRATION_REQUEST',
      'REJECT_REGISTRATION_REQUEST',
      'AUTH_TENANT_MISMATCH',
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

  it('pins the membership revocation to POST /v1/memberships/:id/revoke, 403 and INSUFFICIENT_ROLE, decided by the roles guard', () => {
    expect(REFUSAL_SITES.REVOKE_MEMBERSHIP).toEqual({
      key: 'identity.revoke_membership',
      method: 'POST',
      route: '/v1/memberships/:id/revoke',
      status: 403,
      errorCode: ERROR_CODES.INSUFFICIENT_ROLE,
      decidedBy: 'ROLES_GUARD',
      action: 'identity.memberships.revoke',
      resourceType: 'Membership',
      // The caller, never the membership named in the path.
      resource: 'ACTOR_USER',
      reason:
        'Membership revocation refused: the caller holds none of the roles this endpoint requires',
    });
  });

  it('pins the registration approval to POST /v1/registration-requests/:id/approve, 403 and INSUFFICIENT_ROLE, decided by the roles guard', () => {
    expect(REFUSAL_SITES.APPROVE_REGISTRATION_REQUEST).toEqual({
      key: 'identity.approve_registration_request',
      method: 'POST',
      route: '/v1/registration-requests/:id/approve',
      status: 403,
      errorCode: ERROR_CODES.INSUFFICIENT_ROLE,
      decidedBy: 'ROLES_GUARD',
      action: 'identity.registration_requests.approve',
      resourceType: 'RegistrationRequest',
      // The caller, never the registration request named in the path.
      resource: 'ACTOR_USER',
      reason:
        'Registration approval refused: the caller holds none of the roles this endpoint requires',
    });
  });

  it('pins the registration rejection to POST /v1/registration-requests/:id/reject, 403 and INSUFFICIENT_ROLE, decided by the roles guard', () => {
    expect(REFUSAL_SITES.REJECT_REGISTRATION_REQUEST).toEqual({
      key: 'identity.reject_registration_request',
      method: 'POST',
      route: '/v1/registration-requests/:id/reject',
      status: 403,
      errorCode: ERROR_CODES.INSUFFICIENT_ROLE,
      decidedBy: 'ROLES_GUARD',
      action: 'identity.registration_requests.reject',
      resourceType: 'RegistrationRequest',
      // The caller, never the registration request named in the path.
      resource: 'ACTOR_USER',
      reason:
        'Registration rejection refused: the caller holds none of the roles this endpoint requires',
    });
  });

  it('pins the auth guard tenant refusal to no route at all, 403 and TENANT_MISMATCH (Phase C10)', () => {
    expect(REFUSAL_SITES.AUTH_TENANT_MISMATCH).toEqual({
      key: 'identity.auth_tenant_mismatch',
      // Route-agnostic: the shared auth guard refuses before any controller
      // authorization, so no route identifies this decision.
      method: null,
      route: null,
      status: 403,
      errorCode: ERROR_CODES.TENANT_MISMATCH,
      decidedBy: 'AUTH_GUARD',
      action: 'identity.tenant_context.select',
      resourceType: 'User',
      // The caller, never the organization the rejected header named.
      resource: 'ACTOR_USER',
      reason:
        'Organization selection refused: the requested organization is outside the verified token memberships',
    });
  });

  it('is the only route-agnostic site, and the only one the auth guard decides', () => {
    const routeless = Object.values(REFUSAL_SITES).filter(
      (site) => site.method === null || site.route === null,
    );
    const guardDecided = Object.values(REFUSAL_SITES).filter(
      (site) => site.decidedBy === 'AUTH_GUARD',
    );

    expect(routeless).toEqual([REFUSAL_SITES.AUTH_TENANT_MISMATCH]);
    expect(guardDecided).toEqual([REFUSAL_SITES.AUTH_TENANT_MISMATCH]);
    // Every other site still names both, so "no route" can never be the
    // accidental state of a site whose template was forgotten.
    for (const site of Object.values(REFUSAL_SITES)) {
      if (site.decidedBy === 'AUTH_GUARD') continue;
      expect(typeof site.method).toBe('string');
      expect(typeof site.route).toBe('string');
    }
  });

  it('keeps the two TENANT_MISMATCH sites apart by decider and action', () => {
    // The same code, the same status and the same resource type, raised at two
    // different decisions: the guard's header check and the domain's switch.
    const guard = REFUSAL_SITES.AUTH_TENANT_MISMATCH;
    const domain = REFUSAL_SITES.SWITCH_ACTIVE_ORGANIZATION;

    expect(guard.errorCode).toBe(domain.errorCode);
    expect(guard.status).toBe(domain.status);
    expect(guard.resourceType).toBe(domain.resourceType);
    expect(guard.decidedBy).not.toBe(domain.decidedBy);
    expect(guard.action).not.toBe(domain.action);
    expect(guard.key).not.toBe(domain.key);
    expect(guard.reason).not.toBe(domain.reason);
  });

  it('allowlists every @Roles route identity-service serves, so none is left uninstrumented (Phase C9)', () => {
    // The seven role-guarded routes of `identity.controller.ts`. With the last
    // of them a site, no HTTP role refusal is left to act as an "unchanged
    // response" comparator; that proof now compares the two guards directly
    // (`identity-roles.guard.spec.ts`).
    const roleGuarded: [string, string][] = [
      ['GET', '/v1/users'],
      ['POST', '/v1/users'],
      ['POST', '/v1/users/:id/memberships'],
      ['POST', '/v1/memberships/:id/roles'],
      ['POST', '/v1/memberships/:id/revoke'],
      ['POST', '/v1/registration-requests/:id/approve'],
      ['POST', '/v1/registration-requests/:id/reject'],
    ];
    for (const [method, route] of roleGuarded) {
      expect(rolesGuardSiteFor(method, route)).toBeDefined();
    }
    const rolesGuardSites = Object.values(REFUSAL_SITES).filter(
      (site) => site.decidedBy === 'ROLES_GUARD',
    );
    expect(rolesGuardSites).toHaveLength(roleGuarded.length);
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
      ['POST', '/v1/memberships/:id/revoke', 'REVOKE_MEMBERSHIP'],
      ['POST', '/v1/registration-requests/:id/approve', 'APPROVE_REGISTRATION_REQUEST'],
      ['POST', '/v1/registration-requests/:id/reject', 'REJECT_REGISTRATION_REQUEST'],
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
      ['lower-case POST on the revoke template', 'post', '/v1/memberships/:id/revoke'],
      ['GET on the revoke template', 'GET', '/v1/memberships/:id/revoke'],
      ['PUT on the revoke template', 'PUT', '/v1/memberships/:id/revoke'],
      ['PATCH on the revoke template', 'PATCH', '/v1/memberships/:id/revoke'],
      ['a concrete revoke URL', 'POST', '/v1/memberships/MBR_01ABC/revoke'],
      ['a revoke template with a query', 'POST', '/v1/memberships/:id/revoke?reason=x'],
      ['a trailing slash on the revoke template', 'POST', '/v1/memberships/:id/revoke/'],
      ['a differently named revoke parameter', 'POST', '/v1/memberships/:membershipId/revoke'],
      ['a deeper revoke template', 'POST', '/v1/memberships/:id/revoke/:confirm'],
      ['lower-case POST on the approve template', 'post', '/v1/registration-requests/:id/approve'],
      ['GET on the approve template', 'GET', '/v1/registration-requests/:id/approve'],
      ['PUT on the approve template', 'PUT', '/v1/registration-requests/:id/approve'],
      ['PATCH on the approve template', 'PATCH', '/v1/registration-requests/:id/approve'],
      ['a concrete approve URL', 'POST', '/v1/registration-requests/REG_01ABC/approve'],
      ['an approve template with a query', 'POST', '/v1/registration-requests/:id/approve?role=x'],
      [
        'a trailing slash on the approve template',
        'POST',
        '/v1/registration-requests/:id/approve/',
      ],
      [
        'a differently named approve parameter',
        'POST',
        '/v1/registration-requests/:requestId/approve',
      ],
      ['a deeper approve template', 'POST', '/v1/registration-requests/:id/approve/:step'],
      ['the registration-request collection', 'POST', '/v1/registration-requests'],
      ['a registration request by id', 'GET', '/v1/registration-requests/:id'],
      ['lower-case POST on the reject template', 'post', '/v1/registration-requests/:id/reject'],
      ['GET on the reject template', 'GET', '/v1/registration-requests/:id/reject'],
      ['PUT on the reject template', 'PUT', '/v1/registration-requests/:id/reject'],
      ['PATCH on the reject template', 'PATCH', '/v1/registration-requests/:id/reject'],
      ['a concrete reject URL', 'POST', '/v1/registration-requests/REG_01ABC/reject'],
      ['a reject template with a query', 'POST', '/v1/registration-requests/:id/reject?reason=x'],
      ['a trailing slash on the reject template', 'POST', '/v1/registration-requests/:id/reject/'],
      [
        'a differently named reject parameter',
        'POST',
        '/v1/registration-requests/:requestId/reject',
      ],
      ['a deeper reject template', 'POST', '/v1/registration-requests/:id/reject/:step'],
      ['a review template no route serves', 'POST', '/v1/registration-requests/:id/review'],
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
      // The route-agnostic site is never reachable through this lookup: it is
      // not decided by the roles guard, and it has no method or route to match.
      ['a null method and route', null, null],
      ['the guard site’s own null route', 'POST', null],
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
    expect(identities).toHaveLength(9);
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

  it('keeps the three Membership sites apart by action, so their evidence never merges', () => {
    const membershipSites = [
      REFUSAL_SITES.ADD_MEMBERSHIP,
      REFUSAL_SITES.UPDATE_MEMBERSHIP_ROLES,
      REFUSAL_SITES.REVOKE_MEMBERSHIP,
    ];
    // Same resource type and same error code: only the action separates them.
    for (const site of membershipSites) {
      expect(site.resourceType).toBe('Membership');
      expect(site.errorCode).toBe(ERROR_CODES.INSUFFICIENT_ROLE);
    }
    expect(new Set(membershipSites.map((site) => site.action)).size).toBe(3);
    expect(new Set(membershipSites.map((site) => site.route)).size).toBe(3);
  });

  it('keeps the two membership sub-resource sites on one prefix apart by their last segment', () => {
    const roles = REFUSAL_SITES.UPDATE_MEMBERSHIP_ROLES;
    const revoke = REFUSAL_SITES.REVOKE_MEMBERSHIP;
    expect(revoke.method).toBe(roles.method);
    expect(revoke.route).not.toBe(roles.route);
    expect(revoke.key).not.toBe(roles.key);
    expect(revoke.reason).not.toBe(roles.reason);
  });

  it('keeps the two outcomes of one registration review apart, so their evidence never merges', () => {
    const approve = REFUSAL_SITES.APPROVE_REGISTRATION_REQUEST;
    const reject = REFUSAL_SITES.REJECT_REGISTRATION_REQUEST;
    // Same method, same prefix, same resource type, same error code and the
    // same single required role: the action is what keeps their rows apart.
    expect(reject.method).toBe(approve.method);
    expect(reject.resourceType).toBe(approve.resourceType);
    expect(reject.errorCode).toBe(approve.errorCode);
    expect(reject.action).not.toBe(approve.action);
    expect(reject.key).not.toBe(approve.key);
    expect(reject.route).not.toBe(approve.route);
    expect(reject.reason).not.toBe(approve.reason);
    expect(rolesGuardSiteFor('POST', approve.route)).toBe('APPROVE_REGISTRATION_REQUEST');
    expect(rolesGuardSiteFor('POST', reject.route)).toBe('REJECT_REGISTRATION_REQUEST');
  });

  it.each([
    'CREATE_USER',
    'ADD_MEMBERSHIP',
    'UPDATE_MEMBERSHIP_ROLES',
    'REVOKE_MEMBERSHIP',
    'APPROVE_REGISTRATION_REQUEST',
    'REJECT_REGISTRATION_REQUEST',
  ] as const)('marks a role refusal as %s without changing its serialisation', (siteName) => {
    const plain = RastaError.insufficientRole(['ORGANIZATION_ADMIN'], ['AUDITOR']);
    const marked = markRefusal(
      RastaError.insufficientRole(['ORGANIZATION_ADMIN'], ['AUDITOR']),
      siteName,
    );
    expect(refusalSiteOf(marked)).toBe(REFUSAL_SITES[siteName]);
    expect(refusalSiteOf(plain)).toBeUndefined();
    expect(JSON.stringify(marked)).toBe(JSON.stringify(plain));
  });

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

  describe('the auth guard site is marked only with trusted attribution (Phase C10)', () => {
    const attribution = {
      userId: 'USR_TRUSTED',
      organizationId: 'ORG_ACTIVE',
      roles: ['FLEET_MANAGER'],
    };

    it('marks the refusal and keeps it byte-for-byte what it was', () => {
      const plain = RastaError.tenantMismatch('ORG_HEADER_SENTINEL', ['ORG_ACTIVE']);
      const marked = markGuardRefusal(
        RastaError.tenantMismatch('ORG_HEADER_SENTINEL', ['ORG_ACTIVE']),
        'AUTH_TENANT_MISMATCH',
        attribution,
      );

      expect(refusalSiteOf(marked)).toBe(REFUSAL_SITES.AUTH_TENANT_MISMATCH);
      expect(marked.constructor).toBe(plain.constructor);
      expect(marked.internalContext).toEqual(plain.internalContext);
      expect(Object.keys(marked).sort()).toEqual(Object.keys(plain).sort());
      expect(JSON.stringify(marked)).toBe(JSON.stringify(plain));
    });

    it('carries the trusted actor and tenant, copied rather than referenced', () => {
      const roles = ['FLEET_MANAGER'];
      const error = markGuardRefusal(
        RastaError.tenantMismatch('ORG_HEADER_SENTINEL', []),
        'AUTH_TENANT_MISMATCH',
        { ...attribution, roles },
      );

      // Mutating the caller's array afterwards must not rewrite evidence.
      roles.push('SYSTEM_ADMIN');

      expect(trustedAttributionOf(error)).toEqual({
        userId: 'USR_TRUSTED',
        organizationId: 'ORG_ACTIVE',
        roles: ['FLEET_MANAGER'],
      });
    });

    it('never re-marks or re-attributes an error another decider already marked', () => {
      // One refusal is one decision. Were a second mark to win, a domain
      // refusal could be re-filed as a guard refusal, with someone else's
      // attribution.
      const error = markRefusal(
        RastaError.tenantMismatch('ORG_HEADER_SENTINEL', []),
        'SWITCH_ACTIVE_ORGANIZATION',
      );
      markGuardRefusal(error, 'AUTH_TENANT_MISMATCH', attribution);

      expect(refusalSiteOf(error)).toBe(REFUSAL_SITES.SWITCH_ACTIVE_ORGANIZATION);
      expect(trustedAttributionOf(error)).toBeUndefined();
    });

    it('leaves every route-marked and unmarked error without attribution', () => {
      const roleRefusal = markRefusal(
        RastaError.insufficientRole(['UNION_ADMIN'], []),
        'LIST_USERS',
      );

      expect(trustedAttributionOf(roleRefusal)).toBeUndefined();
      expect(trustedAttributionOf(RastaError.tenantMismatch('ORG_X', []))).toBeUndefined();
      expect(trustedAttributionOf(undefined)).toBeUndefined();
      expect(trustedAttributionOf('TENANT_MISMATCH')).toBeUndefined();
    });

    it('recognises only the instance that was marked', () => {
      const marked = markGuardRefusal(
        RastaError.tenantMismatch('ORG_HEADER_SENTINEL', []),
        'AUTH_TENANT_MISMATCH',
        attribution,
      );

      expect(refusalSiteOf(marked)).toBe(REFUSAL_SITES.AUTH_TENANT_MISMATCH);
      // The auth guard's refusal for a different request: same class, same
      // code, no mark.
      const other = RastaError.tenantMismatch('ORG_HEADER_SENTINEL', []);
      expect(refusalSiteOf(other)).toBeUndefined();
      expect(trustedAttributionOf(other)).toBeUndefined();
    });
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
