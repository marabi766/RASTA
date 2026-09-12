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
 * (AUD-004 Phases C3–C4: `GET /v1/users` and `POST /v1/users`).
 */

class ProbeController {
  @Roles('ORGANIZATION_ADMIN', 'UNION_ADMIN')
  list(): void {}

  @Roles('ORGANIZATION_ADMIN', 'UNION_ADMIN')
  create(): void {}

  @Public('guard spec probe')
  open(): void {}

  anyAuthenticated(): void {}
}

const LIST = ProbeController.prototype.list;
const CREATE = ProbeController.prototype.create;
const OPEN = ProbeController.prototype.open;
const ANY = ProbeController.prototype.anyAuthenticated;

interface ProbeRequest {
  method?: string;
  route?: { path?: string };
  url?: string;
  body?: unknown;
}

const listRequest: ProbeRequest = {
  method: 'GET',
  route: { path: '/v1/users' },
  url: '/v1/users?q=SENSITIVE-QUERY-SENTINEL',
};

const createRequest: ProbeRequest = {
  method: 'POST',
  route: { path: '/v1/users' },
  url: '/v1/users',
  body: { username: 'SENSITIVE-BODY-SENTINEL', roles: ['SYSTEM_ADMIN'] },
};

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

  it('marks the shared guard’s INSUFFICIENT_ROLE for POST /v1/users with the CREATE_USER site', () => {
    const { error } = outcome(
      identityGuard(),
      execution(CREATE, createRequest),
      user(['FLEET_MANAGER']),
    );

    expect(error).toBeInstanceOf(RastaError);
    expect((error as RastaError).code).toBe(ERROR_CODES.INSUFFICIENT_ROLE);
    expect((error as RastaError).status).toBe(403);
    expect(refusalSiteOf(error)).toBe(REFUSAL_SITES.CREATE_USER);
  });

  it('rethrows the very object the shared guard threw for POST /v1/users, unchanged', () => {
    const exec = execution(CREATE, createRequest);
    const thrown = RastaError.insufficientRole(['ORGANIZATION_ADMIN'], ['FLEET_MANAGER']);
    const spy = jest.spyOn(RolesGuard.prototype, 'canActivate').mockImplementation(() => {
      throw thrown;
    });
    const { error } = outcome(identityGuard(), exec, user(['FLEET_MANAGER']));
    expect(error).toBe(thrown);
    expect(refusalSiteOf(thrown)).toBe(REFUSAL_SITES.CREATE_USER);
    spy.mockRestore();

    const marked = outcome(identityGuard(), exec, user(['FLEET_MANAGER'])).error as RastaError;
    const plain = outcome(platformGuard(), exec, user(['FLEET_MANAGER'])).error as RastaError;
    expect(refusalSiteOf(plain)).toBeUndefined();
    expect(marked.constructor).toBe(plain.constructor);
    expect(marked.internalContext).toEqual(plain.internalContext);
    expect(JSON.stringify(marked)).toBe(JSON.stringify(plain));
    // The body the caller sent plays no part in the decision or the error.
    expect(JSON.stringify(marked)).not.toContain('SENSITIVE-BODY-SENTINEL');
  });

  it.each<[string, ProbeRequest]>([
    ['another method on the same template', { method: 'PUT', route: { path: '/v1/users' } }],
    ['a lower-case method', { method: 'post', route: { path: '/v1/users' } }],
    ['another route template', { method: 'GET', route: { path: '/v1/memberships' } }],
    ['a nested template', { method: 'GET', route: { path: '/v1/users/:id' } }],
    ['a nested POST template', { method: 'POST', route: { path: '/v1/users/:id/memberships' } }],
    ['a trailing slash', { method: 'POST', route: { path: '/v1/users/' } }],
    ['no matched route at all', { method: 'GET', url: '/v1/users' }],
    ['no matched route for a POST', { method: 'POST', url: '/v1/users' }],
    [
      'a concrete URL where the template belongs',
      { method: 'GET', route: { path: '/v1/users?q=x' } },
    ],
  ])('does not mark INSUFFICIENT_ROLE on %s', (_label, request) => {
    const { error } = outcome(identityGuard(), execution(LIST, request), user(['FLEET_MANAGER']));

    expect((error as RastaError).code).toBe(ERROR_CODES.INSUFFICIENT_ROLE);
    expect(refusalSiteOf(error)).toBeUndefined();
  });

  it('does not mark outside HTTP', () => {
    const { error } = outcome(
      identityGuard(),
      execution(LIST, listRequest, 'rpc'),
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
      execution(LIST, listRequest),
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
    ])('%s', (_label, handler, context) => {
      const exec = execution(handler, handler === CREATE ? createRequest : listRequest);
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
