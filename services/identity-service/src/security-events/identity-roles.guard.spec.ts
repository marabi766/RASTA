import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ERROR_CODES } from '@rasta/contracts';
import {
  Public,
  RastaError,
  Roles,
  RolesGuard,
  runWithContext,
  type RequestContext,
} from '@rasta/nest-common';
import { IdentityRolesGuard } from './identity-roles.guard';
import { refusalSiteOf, REFUSAL_SITES } from './refusal-sites';

/**
 * The identity role guard is the shared `RolesGuard` plus one thing: it marks
 * the shared guard's own `INSUFFICIENT_ROLE` refusal — the same object — when,
 * and only when, the matched route is an allowlisted `ROLES_GUARD` site
 * (AUD-004 Phases C3–C8: `GET /v1/users`, `POST /v1/users`,
 * `POST /v1/users/:id/memberships`, `POST /v1/memberships/:id/roles`,
 * `POST /v1/memberships/:id/revoke` and
 * `POST /v1/registration-requests/:id/approve`).
 *
 * `POST /v1/registration-requests/:id/reject` carries the same method, the same
 * prefix and the same single required role, and is deliberately **not** a site:
 * it is the near miss that proves only the allowlist decides.
 */

class ProbeController {
  @Roles('ORGANIZATION_ADMIN', 'UNION_ADMIN')
  list(): void {}

  @Roles('ORGANIZATION_ADMIN', 'UNION_ADMIN')
  create(): void {}

  @Roles('ORGANIZATION_ADMIN', 'UNION_ADMIN')
  addMembership(): void {}

  @Roles('ORGANIZATION_ADMIN', 'UNION_ADMIN')
  replaceRoles(): void {}

  @Roles('ORGANIZATION_ADMIN', 'UNION_ADMIN')
  revokeMembership(): void {}

  // The two registration review outcomes: one required role, not two.
  @Roles('UNION_ADMIN')
  approveRegistration(): void {}

  @Roles('UNION_ADMIN')
  rejectRegistration(): void {}

  @Public('guard spec probe')
  open(): void {}

  anyAuthenticated(): void {}
}

const LIST = ProbeController.prototype.list;
const CREATE = ProbeController.prototype.create;
const ADD_MEMBERSHIP = ProbeController.prototype.addMembership;
const REPLACE_ROLES = ProbeController.prototype.replaceRoles;
const REVOKE = ProbeController.prototype.revokeMembership;
const APPROVE = ProbeController.prototype.approveRegistration;
const REJECT = ProbeController.prototype.rejectRegistration;
const OPEN = ProbeController.prototype.open;
const ANY = ProbeController.prototype.anyAuthenticated;

interface ProbeRequest {
  method?: string;
  route?: { path?: string };
  url?: string;
  params?: Record<string, string>;
  body?: unknown;
}

const PATH_SENTINEL = 'USR-PATH-SENTINEL';
const BODY_SENTINEL = 'SENSITIVE-BODY-SENTINEL';

const listRequest: ProbeRequest = {
  method: 'GET',
  route: { path: '/v1/users' },
  url: '/v1/users?q=SENSITIVE-QUERY-SENTINEL',
};

const createRequest: ProbeRequest = {
  method: 'POST',
  route: { path: '/v1/users' },
  url: '/v1/users',
  body: { username: BODY_SENTINEL, roles: ['SYSTEM_ADMIN'] },
};

const addMembershipRequest: ProbeRequest = {
  method: 'POST',
  route: { path: '/v1/users/:id/memberships' },
  url: `/v1/users/${PATH_SENTINEL}/memberships?role=UNION_ADMIN`,
  params: { id: PATH_SENTINEL },
  body: { organizationId: `ORG-${BODY_SENTINEL}`, roles: ['SYSTEM_ADMIN'] },
};

const replaceRolesRequest: ProbeRequest = {
  method: 'POST',
  route: { path: '/v1/memberships/:id/roles' },
  url: `/v1/memberships/${PATH_SENTINEL}/roles?role=UNION_ADMIN`,
  params: { id: PATH_SENTINEL },
  body: { roles: ['SYSTEM_ADMIN'], reason: BODY_SENTINEL },
};

const revokeRequest: ProbeRequest = {
  method: 'POST',
  route: { path: '/v1/memberships/:id/revoke' },
  url: `/v1/memberships/${PATH_SENTINEL}/revoke?reason=UNION_ADMIN`,
  params: { id: PATH_SENTINEL },
  body: { reason: BODY_SENTINEL },
};

const approveRequest: ProbeRequest = {
  method: 'POST',
  route: { path: '/v1/registration-requests/:id/approve' },
  url: `/v1/registration-requests/${PATH_SENTINEL}/approve?role=UNION_ADMIN`,
  params: { id: PATH_SENTINEL },
  body: { organizationId: `ORG-${BODY_SENTINEL}`, roles: ['SYSTEM_ADMIN'] },
};

/** The uninstrumented sibling: identical in every way the guard can see. */
const rejectRequest: ProbeRequest = {
  method: 'POST',
  route: { path: '/v1/registration-requests/:id/reject' },
  url: `/v1/registration-requests/${PATH_SENTINEL}/reject`,
  params: { id: PATH_SENTINEL },
  body: { reason: BODY_SENTINEL },
};

const REQUEST_BY_HANDLER = new Map<() => void, ProbeRequest>([
  [CREATE, createRequest],
  [ADD_MEMBERSHIP, addMembershipRequest],
  [REPLACE_ROLES, replaceRolesRequest],
  [REVOKE, revokeRequest],
  [APPROVE, approveRequest],
  [REJECT, rejectRequest],
]);

const requestFor = (handler: () => void): ProbeRequest =>
  REQUEST_BY_HANDLER.get(handler) ?? listRequest;

type MarkedSiteName =
  | 'CREATE_USER'
  | 'ADD_MEMBERSHIP'
  | 'UPDATE_MEMBERSHIP_ROLES'
  | 'REVOKE_MEMBERSHIP'
  | 'APPROVE_REGISTRATION_REQUEST';

const MARKED_SITES: [string, () => void, ProbeRequest, MarkedSiteName][] = [
  ['POST /v1/users', CREATE, createRequest, 'CREATE_USER'],
  ['POST /v1/users/:id/memberships', ADD_MEMBERSHIP, addMembershipRequest, 'ADD_MEMBERSHIP'],
  ['POST /v1/memberships/:id/roles', REPLACE_ROLES, replaceRolesRequest, 'UPDATE_MEMBERSHIP_ROLES'],
  ['POST /v1/memberships/:id/revoke', REVOKE, revokeRequest, 'REVOKE_MEMBERSHIP'],
  [
    'POST /v1/registration-requests/:id/approve',
    APPROVE,
    approveRequest,
    'APPROVE_REGISTRATION_REQUEST',
  ],
];

function execution(
  handler: () => void,
  request: ProbeRequest,
  type: 'http' | 'rpc' = 'http',
): ExecutionContext {
  return {
    getType: () => type,
    getHandler: () => handler,
    getClass: () => ProbeController,
    getArgs: () => [request],
    getArgByIndex: () => request,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
    switchToRpc: () => {
      throw new Error('not rpc');
    },
    switchToWs: () => {
      throw new Error('not ws');
    },
  } as unknown as ExecutionContext;
}

function user(roles: string[]): RequestContext {
  return {
    correlationId: 'COR_GUARD_1',
    requestId: 'REQ_GUARD_1',
    organizationId: 'ORG_A',
    organizationIds: ['ORG_A'],
    userId: 'USR_A',
    roles,
    authType: 'USER',
    startedAt: 0,
  };
}

const serviceCaller: RequestContext = {
  correlationId: 'COR_GUARD_2',
  requestId: 'REQ_GUARD_2',
  organizationId: 'ORG_A',
  organizationIds: ['ORG_A'],
  roles: [],
  authType: 'SERVICE',
  callerService: 'marketplace-service',
  startedAt: 0,
};

const identityGuard = () => new IdentityRolesGuard(new Reflector());
const platformGuard = () => new RolesGuard(new Reflector());

/** What a guard did: its return value, or the error it threw. */
function outcome(
  guard: { canActivate(e: ExecutionContext): boolean },
  exec: ExecutionContext,
  context: RequestContext | undefined,
): { result?: boolean; error?: unknown } {
  const run = () => {
    try {
      return { result: guard.canActivate(exec) };
    } catch (error) {
      return { error };
    }
  };
  return context === undefined ? run() : runWithContext(context, run);
}

describe('IdentityRolesGuard', () => {
  afterEach(() => jest.restoreAllMocks());

  it('marks the shared guard’s INSUFFICIENT_ROLE for GET /v1/users with the LIST_USERS site', () => {
    const { error } = outcome(
      identityGuard(),
      execution(LIST, listRequest),
      user(['FLEET_MANAGER']),
    );

    expect(error).toBeInstanceOf(RastaError);
    expect((error as RastaError).code).toBe(ERROR_CODES.INSUFFICIENT_ROLE);
    expect((error as RastaError).status).toBe(403);
    expect(refusalSiteOf(error)).toBe(REFUSAL_SITES.LIST_USERS);
  });

  it('rethrows the very object the shared guard threw', () => {
    const thrown = RastaError.insufficientRole(['ORGANIZATION_ADMIN'], ['FLEET_MANAGER']);
    jest.spyOn(RolesGuard.prototype, 'canActivate').mockImplementation(() => {
      throw thrown;
    });

    const { error } = outcome(
      identityGuard(),
      execution(LIST, listRequest),
      user(['FLEET_MANAGER']),
    );

    expect(error).toBe(thrown);
    expect(refusalSiteOf(thrown)).toBe(REFUSAL_SITES.LIST_USERS);
  });

  it('leaves the error byte-for-byte what the shared guard produces', () => {
    const exec = execution(LIST, listRequest);
    const marked = outcome(identityGuard(), exec, user(['FLEET_MANAGER'])).error as RastaError;
    const plain = outcome(platformGuard(), exec, user(['FLEET_MANAGER'])).error as RastaError;

    expect(refusalSiteOf(plain)).toBeUndefined();
    expect(marked.constructor).toBe(plain.constructor);
    expect(marked.message).toBe(plain.message);
    expect(marked.code).toBe(plain.code);
    expect(marked.status).toBe(plain.status);
    expect(marked.internalContext).toEqual(plain.internalContext);
    expect(Object.keys(marked).sort()).toEqual(Object.keys(plain).sort());
    expect(JSON.stringify(marked)).toBe(JSON.stringify(plain));
  });

  it.each(MARKED_SITES)(
    'marks the shared guard’s INSUFFICIENT_ROLE for %s with its own site',
    (_label, handler, request, siteName) => {
      const { error } = outcome(identityGuard(), execution(handler, request), user(['AUDITOR']));

      expect(error).toBeInstanceOf(RastaError);
      expect((error as RastaError).code).toBe(ERROR_CODES.INSUFFICIENT_ROLE);
      expect((error as RastaError).status).toBe(403);
      expect(refusalSiteOf(error)).toBe(REFUSAL_SITES[siteName]);
    },
  );

  it.each(MARKED_SITES)(
    'rethrows the very object the shared guard threw for %s, unchanged',
    (_label, handler, request, siteName) => {
      const exec = execution(handler, request);
      const thrown = RastaError.insufficientRole(['ORGANIZATION_ADMIN'], ['FLEET_MANAGER']);
      const spy = jest.spyOn(RolesGuard.prototype, 'canActivate').mockImplementation(() => {
        throw thrown;
      });
      const { error } = outcome(identityGuard(), exec, user(['FLEET_MANAGER']));
      expect(error).toBe(thrown);
      expect(refusalSiteOf(thrown)).toBe(REFUSAL_SITES[siteName]);
      spy.mockRestore();

      const marked = outcome(identityGuard(), exec, user(['FLEET_MANAGER'])).error as RastaError;
      const plain = outcome(platformGuard(), exec, user(['FLEET_MANAGER'])).error as RastaError;
      expect(refusalSiteOf(plain)).toBeUndefined();
      expect(marked.constructor).toBe(plain.constructor);
      expect(marked.internalContext).toEqual(plain.internalContext);
      expect(JSON.stringify(marked)).toBe(JSON.stringify(plain));
      // The path id and the body the caller sent play no part in the decision or the error.
      expect(JSON.stringify(marked)).not.toContain(BODY_SENTINEL);
      expect(JSON.stringify(marked)).not.toContain(PATH_SENTINEL);
    },
  );

  it.each<[string, ProbeRequest]>([
    ['another method on the same template', { method: 'PUT', route: { path: '/v1/users' } }],
    ['a lower-case method', { method: 'post', route: { path: '/v1/users' } }],
    ['another route template', { method: 'GET', route: { path: '/v1/memberships' } }],
    ['a nested template', { method: 'GET', route: { path: '/v1/users/:id' } }],
    ['a trailing slash', { method: 'POST', route: { path: '/v1/users/' } }],
    [
      'a lower-case method on the membership template',
      { method: 'post', route: { path: '/v1/users/:id/memberships' } },
    ],
    [
      'GET on the membership template',
      { method: 'GET', route: { path: '/v1/users/:id/memberships' } },
    ],
    [
      'a trailing slash on the membership template',
      { method: 'POST', route: { path: '/v1/users/:id/memberships/' } },
    ],
    [
      'a differently named path parameter',
      { method: 'POST', route: { path: '/v1/users/:userId/memberships' } },
    ],
    [
      'an adjacent deeper template',
      { method: 'POST', route: { path: '/v1/users/:id/memberships/:membershipId' } },
    ],
    [
      'a concrete membership URL where the template belongs',
      { method: 'POST', route: { path: `/v1/users/${PATH_SENTINEL}/memberships` } },
    ],
    [
      'a lower-case method on the roles template',
      { method: 'post', route: { path: '/v1/memberships/:id/roles' } },
    ],
    ['GET on the roles template', { method: 'GET', route: { path: '/v1/memberships/:id/roles' } }],
    ['PUT on the roles template', { method: 'PUT', route: { path: '/v1/memberships/:id/roles' } }],
    [
      'a trailing slash on the roles template',
      { method: 'POST', route: { path: '/v1/memberships/:id/roles/' } },
    ],
    [
      'a differently named roles parameter',
      { method: 'POST', route: { path: '/v1/memberships/:membershipId/roles' } },
    ],
    [
      'a deeper roles template',
      { method: 'POST', route: { path: '/v1/memberships/:id/roles/:role' } },
    ],
    [
      'a concrete roles URL where the template belongs',
      { method: 'POST', route: { path: `/v1/memberships/${PATH_SENTINEL}/roles` } },
    ],
    [
      'a roles template with a query',
      { method: 'POST', route: { path: '/v1/memberships/:id/roles?role=UNION_ADMIN' } },
    ],
    [
      'no matched route for a roles POST',
      { method: 'POST', url: `/v1/memberships/${PATH_SENTINEL}/roles` },
    ],
    [
      'a lower-case method on the revoke template',
      { method: 'post', route: { path: '/v1/memberships/:id/revoke' } },
    ],
    [
      'GET on the revoke template',
      { method: 'GET', route: { path: '/v1/memberships/:id/revoke' } },
    ],
    [
      'PUT on the revoke template',
      { method: 'PUT', route: { path: '/v1/memberships/:id/revoke' } },
    ],
    [
      'a trailing slash on the revoke template',
      { method: 'POST', route: { path: '/v1/memberships/:id/revoke/' } },
    ],
    [
      'a differently named revoke parameter',
      { method: 'POST', route: { path: '/v1/memberships/:membershipId/revoke' } },
    ],
    [
      'a deeper revoke template',
      { method: 'POST', route: { path: '/v1/memberships/:id/revoke/:confirm' } },
    ],
    [
      'a concrete revoke URL where the template belongs',
      { method: 'POST', route: { path: `/v1/memberships/${PATH_SENTINEL}/revoke` } },
    ],
    [
      'a revoke template with a query',
      { method: 'POST', route: { path: '/v1/memberships/:id/revoke?reason=x' } },
    ],
    [
      'no matched route for a revoke POST',
      { method: 'POST', url: `/v1/memberships/${PATH_SENTINEL}/revoke` },
    ],
    ['the membership collection', { method: 'POST', route: { path: '/v1/memberships' } }],
    [
      'a lower-case method on the approve template',
      { method: 'post', route: { path: '/v1/registration-requests/:id/approve' } },
    ],
    [
      'GET on the approve template',
      { method: 'GET', route: { path: '/v1/registration-requests/:id/approve' } },
    ],
    [
      'PUT on the approve template',
      { method: 'PUT', route: { path: '/v1/registration-requests/:id/approve' } },
    ],
    [
      'a trailing slash on the approve template',
      { method: 'POST', route: { path: '/v1/registration-requests/:id/approve/' } },
    ],
    [
      'a differently named approve parameter',
      { method: 'POST', route: { path: '/v1/registration-requests/:requestId/approve' } },
    ],
    [
      'a deeper approve template',
      { method: 'POST', route: { path: '/v1/registration-requests/:id/approve/:step' } },
    ],
    [
      'a concrete approve URL where the template belongs',
      { method: 'POST', route: { path: `/v1/registration-requests/${PATH_SENTINEL}/approve` } },
    ],
    [
      'an approve template with a query',
      { method: 'POST', route: { path: '/v1/registration-requests/:id/approve?role=x' } },
    ],
    [
      'no matched route for an approve POST',
      { method: 'POST', url: `/v1/registration-requests/${PATH_SENTINEL}/approve` },
    ],
    [
      'the registration-request collection',
      { method: 'POST', route: { path: '/v1/registration-requests' } },
    ],
    [
      'registration rejection, the uninstrumented sibling',
      { method: 'POST', route: { path: '/v1/registration-requests/:id/reject' } },
    ],
    [
      'a concrete rejection URL',
      { method: 'POST', route: { path: `/v1/registration-requests/${PATH_SENTINEL}/reject` } },
    ],
    ['no matched route at all', { method: 'GET', url: '/v1/users' }],
    [
      'no matched route for a membership POST',
      { method: 'POST', url: `/v1/users/${PATH_SENTINEL}/memberships` },
    ],
    [
      'a concrete URL where the template belongs',
      { method: 'GET', route: { path: '/v1/users?q=x' } },
    ],
  ])('does not mark INSUFFICIENT_ROLE on %s', (_label, request) => {
    const { error } = outcome(identityGuard(), execution(LIST, request), user(['FLEET_MANAGER']));

    expect((error as RastaError).code).toBe(ERROR_CODES.INSUFFICIENT_ROLE);
    expect(refusalSiteOf(error)).toBeUndefined();
  });

  it('marks ORGANIZATION_ADMIN’s approve refusal, a role every earlier site allows', () => {
    // The approve endpoint requires UNION_ADMIN only. The shared guard refuses
    // ORGANIZATION_ADMIN here and allows it on all four earlier roles-guard
    // sites, so this is the one case where the role alone decides nothing and
    // the site still has to be exactly right.
    const exec = execution(APPROVE, approveRequest);
    const { result, error } = outcome(identityGuard(), exec, user(['ORGANIZATION_ADMIN']));

    expect(result).toBeUndefined();
    expect((error as RastaError).code).toBe(ERROR_CODES.INSUFFICIENT_ROLE);
    expect(refusalSiteOf(error)).toBe(REFUSAL_SITES.APPROVE_REGISTRATION_REQUEST);
    expect(outcome(platformGuard(), exec, user(['ORGANIZATION_ADMIN'])).result).toBeUndefined();
  });

  it('never marks the sibling POST /v1/registration-requests/:id/reject', () => {
    const exec = execution(REJECT, rejectRequest);
    const mine = outcome(identityGuard(), exec, user(['ORGANIZATION_ADMIN']));
    const shared = outcome(platformGuard(), exec, user(['ORGANIZATION_ADMIN']));

    expect((mine.error as RastaError).code).toBe(ERROR_CODES.INSUFFICIENT_ROLE);
    expect((mine.error as RastaError).status).toBe(403);
    expect(refusalSiteOf(mine.error)).toBeUndefined();
    expect(JSON.stringify(mine.error)).toBe(JSON.stringify(shared.error));
  });

  it('does not mark outside HTTP', () => {
    const { error } = outcome(
      identityGuard(),
      execution(ADD_MEMBERSHIP, addMembershipRequest, 'rpc'),
      user(['FLEET_MANAGER']),
    );
    expect((error as RastaError).code).toBe(ERROR_CODES.INSUFFICIENT_ROLE);
    expect(refusalSiteOf(error)).toBeUndefined();
  });

  it('does not mark any other error the shared guard throws, even on the allowlisted route', () => {
    const other = RastaError.tenantMismatch('ORG_B', ['ORG_A']);
    jest.spyOn(RolesGuard.prototype, 'canActivate').mockImplementation(() => {
      throw other;
    });

    const { error } = outcome(
      identityGuard(),
      execution(ADD_MEMBERSHIP, addMembershipRequest),
      user(['FLEET_MANAGER']),
    );

    expect(error).toBe(other);
    expect(refusalSiteOf(other)).toBeUndefined();
  });

  it('keeps a missing request context a 401, unmarked', () => {
    const { error } = outcome(identityGuard(), execution(LIST, listRequest), undefined);

    expect(error).toBeInstanceOf(RastaError);
    expect((error as RastaError).code).toBe(ERROR_CODES.UNAUTHENTICATED);
    expect((error as RastaError).status).toBe(401);
    expect(refusalSiteOf(error)).toBeUndefined();
  });

  it('still throws the original refusal, unmarked, if deciding whether to mark fails', () => {
    const exec = execution(LIST, listRequest);
    const broken = {
      ...exec,
      switchToHttp: () => {
        throw new Error('request unavailable');
      },
    } as unknown as ExecutionContext;
    const thrown = RastaError.insufficientRole(['ORGANIZATION_ADMIN'], []);
    jest.spyOn(RolesGuard.prototype, 'canActivate').mockImplementation(() => {
      throw thrown;
    });

    const { error } = outcome(identityGuard(), broken, user(['FLEET_MANAGER']));

    expect(error).toBe(thrown);
    expect(refusalSiteOf(thrown)).toBeUndefined();
  });

  describe('authorizes exactly as the shared guard does', () => {
    it.each<[string, () => void, RequestContext | undefined]>([
      ['ORGANIZATION_ADMIN on a @Roles endpoint', LIST, user(['ORGANIZATION_ADMIN'])],
      ['UNION_ADMIN on a @Roles endpoint', LIST, user(['UNION_ADMIN'])],
      ['SYSTEM_ADMIN on a @Roles endpoint', LIST, user(['SYSTEM_ADMIN'])],
      ['a service caller on a @Roles endpoint', LIST, serviceCaller],
      ['any user on a public endpoint', OPEN, user([])],
      ['no context on a public endpoint', OPEN, undefined],
      ['any user on an endpoint with no @Roles', ANY, user(['FLEET_MANAGER'])],
      ['a disallowed role on a @Roles endpoint', LIST, user(['FLEET_MANAGER', 'AUDITOR'])],
      ['no roles at all on a @Roles endpoint', LIST, user([])],
      ['no context on a @Roles endpoint', LIST, undefined],
      ['ORGANIZATION_ADMIN on the create endpoint', CREATE, user(['ORGANIZATION_ADMIN'])],
      ['SYSTEM_ADMIN on the create endpoint', CREATE, user(['SYSTEM_ADMIN'])],
      ['a service caller on the create endpoint', CREATE, serviceCaller],
      ['a disallowed role on the create endpoint', CREATE, user(['AUDITOR'])],
      ['no context on the create endpoint', CREATE, undefined],
      [
        'ORGANIZATION_ADMIN on the membership endpoint',
        ADD_MEMBERSHIP,
        user(['ORGANIZATION_ADMIN']),
      ],
      ['UNION_ADMIN on the membership endpoint', ADD_MEMBERSHIP, user(['UNION_ADMIN'])],
      ['SYSTEM_ADMIN on the membership endpoint', ADD_MEMBERSHIP, user(['SYSTEM_ADMIN'])],
      ['a service caller on the membership endpoint', ADD_MEMBERSHIP, serviceCaller],
      ['a disallowed role on the membership endpoint', ADD_MEMBERSHIP, user(['AUDITOR'])],
      ['no roles on the membership endpoint', ADD_MEMBERSHIP, user([])],
      ['no context on the membership endpoint', ADD_MEMBERSHIP, undefined],
      ['ORGANIZATION_ADMIN on the roles endpoint', REPLACE_ROLES, user(['ORGANIZATION_ADMIN'])],
      ['UNION_ADMIN on the roles endpoint', REPLACE_ROLES, user(['UNION_ADMIN'])],
      ['SYSTEM_ADMIN on the roles endpoint', REPLACE_ROLES, user(['SYSTEM_ADMIN'])],
      ['a service caller on the roles endpoint', REPLACE_ROLES, serviceCaller],
      ['a disallowed role on the roles endpoint', REPLACE_ROLES, user(['AUDITOR'])],
      ['no roles on the roles endpoint', REPLACE_ROLES, user([])],
      ['no context on the roles endpoint', REPLACE_ROLES, undefined],
      ['ORGANIZATION_ADMIN on the revoke endpoint', REVOKE, user(['ORGANIZATION_ADMIN'])],
      ['UNION_ADMIN on the revoke endpoint', REVOKE, user(['UNION_ADMIN'])],
      ['SYSTEM_ADMIN on the revoke endpoint', REVOKE, user(['SYSTEM_ADMIN'])],
      ['a service caller on the revoke endpoint', REVOKE, serviceCaller],
      ['a disallowed role on the revoke endpoint', REVOKE, user(['AUDITOR'])],
      ['no roles on the revoke endpoint', REVOKE, user([])],
      ['no context on the revoke endpoint', REVOKE, undefined],
      // The approve endpoint requires UNION_ADMIN *only*, so ORGANIZATION_ADMIN
      // is refused here and allowed everywhere else — the shared guard decides
      // that, and identity's guard must agree with it exactly.
      ['UNION_ADMIN on the approve endpoint', APPROVE, user(['UNION_ADMIN'])],
      ['SYSTEM_ADMIN on the approve endpoint', APPROVE, user(['SYSTEM_ADMIN'])],
      ['ORGANIZATION_ADMIN on the approve endpoint', APPROVE, user(['ORGANIZATION_ADMIN'])],
      ['a service caller on the approve endpoint', APPROVE, serviceCaller],
      ['a disallowed role on the approve endpoint', APPROVE, user(['AUDITOR'])],
      ['no roles on the approve endpoint', APPROVE, user([])],
      ['no context on the approve endpoint', APPROVE, undefined],
      ['UNION_ADMIN on the reject endpoint', REJECT, user(['UNION_ADMIN'])],
      ['ORGANIZATION_ADMIN on the reject endpoint', REJECT, user(['ORGANIZATION_ADMIN'])],
      ['a disallowed role on the reject endpoint', REJECT, user(['AUDITOR'])],
      ['no context on the reject endpoint', REJECT, undefined],
    ])('%s', (_label, handler, context) => {
      const exec = execution(handler, requestFor(handler));
      const mine = outcome(identityGuard(), exec, context);
      const shared = outcome(platformGuard(), exec, context);

      expect(mine.result).toBe(shared.result);
      expect((mine.error as RastaError | undefined)?.code).toBe(
        (shared.error as RastaError | undefined)?.code,
      );
      expect((mine.error as RastaError | undefined)?.status).toBe(
        (shared.error as RastaError | undefined)?.status,
      );
      if (mine.result !== undefined) expect(mine.result).toBe(true);
    });
  });
});
