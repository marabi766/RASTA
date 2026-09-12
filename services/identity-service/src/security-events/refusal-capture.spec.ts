import { ERROR_CODES } from '@rasta/contracts';
import { RastaError, type RequestContext } from '@rasta/nest-common';
import { CAPTURE_SKIP_REASONS, decideCapture, type RefusalObservation } from './refusal-capture';
import { markRefusal, REFUSAL_SITES } from './refusal-sites';

/**
 * The capture decision, branch by branch. Every value a persisted row carries
 * is asserted to come from the trusted context or from the fixed site — and the
 * request's own text is planted with sentinels that must never appear.
 */

const NOW = new Date('2026-09-11T10:00:00.000Z');
const EVENT_ID = '01J9ZC0000000000000000TEST';
const ENVIRONMENT = { now: NOW, newId: () => EVENT_ID, producerVersion: '1.4.2' };

const REQUESTED_ORGANIZATION = 'ORG_REQUESTED_SENTINEL';
const QUERY_SECRET = 'QUERY-SECRET-SENTINEL';

const site = REFUSAL_SITES.SWITCH_ACTIVE_ORGANIZATION;

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    correlationId: 'COR_01J9ZC00000000000000000001',
    requestId: '01J9ZC00000000000000000REQ',
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    spanId: '00f067aa0ba902b7',
    organizationId: 'ORG_A',
    organizationIds: ['ORG_A'],
    userId: 'USR_A',
    subject: 'kc-subject',
    roles: ['FLEET_MANAGER', 'ORGANIZATION_ADMIN'],
    authType: 'USER',
    ip: '203.0.113.7',
    userAgent: 'Mozilla/5.0 (identity unit)',
    method: 'POST',
    path: `/v1/users/me/active-organization?token=${QUERY_SECRET}`,
    startedAt: 0,
    ...overrides,
  };
}

const refusal = (): RastaError =>
  markRefusal(RastaError.tenantMismatch(REQUESTED_ORGANIZATION, []), 'SWITCH_ACTIVE_ORGANIZATION');

function observe(overrides: Partial<RefusalObservation> = {}): RefusalObservation {
  return {
    exception: refusal(),
    status: 403,
    code: ERROR_CODES.TENANT_MISMATCH,
    method: 'POST',
    route: site.route,
    context: context(),
    ...overrides,
  };
}

function captured(observation: RefusalObservation) {
  const decision = decideCapture(observation, ENVIRONMENT);
  if (decision.kind !== 'CAPTURE') {
    throw new Error(`expected a capture, got ${JSON.stringify(decision)}`);
  }
  return decision.draft;
}

function skipReason(observation: RefusalObservation): string | undefined {
  const decision = decideCapture(observation, ENVIRONMENT);
  return decision.kind === 'SKIP' ? decision.reason : undefined;
}

describe('decideCapture', () => {
  it('maps actor, roles, tenant, source and trace from the trusted context and the rest from the site', () => {
    expect(captured(observe())).toEqual({
      id: EVENT_ID,
      organizationId: 'ORG_A',
      actorType: 'USER',
      actorId: 'USR_A',
      actorRoles: ['FLEET_MANAGER', 'ORGANIZATION_ADMIN'],
      action: 'identity.active_organization.switch',
      resourceType: 'User',
      resourceId: 'USR_A',
      errorCode: 'TENANT_MISMATCH',
      reason: site.reason,
      sourceIp: '203.0.113.7',
      sourceUserAgent: 'Mozilla/5.0 (identity unit)',
      correlationId: 'COR_01J9ZC00000000000000000001',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      producerVersion: '1.4.2',
      occurredAt: NOW,
      // One occurrence. Which window row it is counted into is the store's
      // database decision, not this function's.
      occurrenceCount: 1,
    });
  });

  it('carries no requested organization, no URL text and no exception message', () => {
    const serialised = JSON.stringify(captured(observe()));
    expect(serialised).not.toContain(REQUESTED_ORGANIZATION);
    expect(serialised).not.toContain(QUERY_SECRET);
    expect(serialised).not.toContain('active-organization?');
    expect(serialised).not.toContain(refusal().message);
  });

  it('records the tenant the caller was acting for, never another one', () => {
    expect(
      captured(
        observe({ context: context({ organizationId: 'ORG_B', organizationIds: ['ORG_B'] }) }),
      ).organizationId,
    ).toBe('ORG_B');
  });

  it('records a platform-scoped refusal when the caller acts for no organization', () => {
    const draft = captured(
      observe({ context: context({ organizationId: undefined, organizationIds: [] }) }),
    );
    expect(draft.organizationId).toBeNull();
  });

  it('deduplicates roles in their original order and keeps an empty list empty', () => {
    expect(
      captured(observe({ context: context({ roles: ['B', 'A', 'B', 'A'] }) })).actorRoles,
    ).toEqual(['B', 'A']);
    expect(captured(observe({ context: context({ roles: [] }) })).actorRoles).toEqual([]);
  });

  describe('the roles-guard site GET /v1/users (AUD-004 Phase C3)', () => {
    const listSite = REFUSAL_SITES.LIST_USERS;
    const denial = (): RastaError =>
      markRefusal(
        RastaError.insufficientRole(['ORGANIZATION_ADMIN', 'UNION_ADMIN'], ['FLEET_MANAGER']),
        'LIST_USERS',
      );
    const observeList = (overrides: Partial<RefusalObservation> = {}): RefusalObservation => ({
      exception: denial(),
      status: 403,
      code: ERROR_CODES.INSUFFICIENT_ROLE,
      method: 'GET',
      route: listSite.route,
      context: context({ roles: ['FLEET_MANAGER'], path: `/v1/users?q=${QUERY_SECRET}` }),
      ...overrides,
    });

    it('maps the actor, roles and tenant from the context and everything else from the site', () => {
      expect(captured(observeList())).toMatchObject({
        organizationId: 'ORG_A',
        actorType: 'USER',
        actorId: 'USR_A',
        actorRoles: ['FLEET_MANAGER'],
        action: 'identity.users.list',
        resourceType: 'User',
        resourceId: 'USR_A',
        errorCode: 'INSUFFICIENT_ROLE',
        reason: listSite.reason,
        occurrenceCount: 1,
      });
    });

    it("records neither the endpoint's required roles, the query, nor the error's text or context", () => {
      const serialised = JSON.stringify(captured(observeList()));
      expect(serialised).not.toContain('ORGANIZATION_ADMIN');
      expect(serialised).not.toContain('UNION_ADMIN');
      expect(serialised).not.toContain(QUERY_SECRET);
      expect(serialised).not.toContain(denial().message);
      expect(serialised).not.toContain('required');
    });

    it.each([
      ['a TENANT_MISMATCH classification', { code: ERROR_CODES.TENANT_MISMATCH }],
      ['a 401', { status: 401, code: ERROR_CODES.UNAUTHENTICATED }],
    ])('skips a marked denial classified as %s', (_label, overrides) => {
      expect(skipReason(observeList(overrides))).toBe(CAPTURE_SKIP_REASONS.CLASSIFICATION_MISMATCH);
    });

    it.each([
      ['POST on the same template', { method: 'POST' }],
      ['another template', { route: '/v1/users/:id' }],
    ])('skips a marked denial observed on %s', (_label, overrides) => {
      expect(skipReason(observeList(overrides))).toBe(CAPTURE_SKIP_REASONS.ROUTE_MISMATCH);
    });

    it('never captures an unmarked INSUFFICIENT_ROLE, even on GET /v1/users', () => {
      expect(
        decideCapture(
          observeList({ exception: RastaError.insufficientRole(['UNION_ADMIN'], []) }),
          ENVIRONMENT,
        ),
      ).toEqual({ kind: 'NOT_A_REFUSAL_SITE' });
    });
  });

  describe('the roles-guard site POST /v1/users (AUD-004 Phase C4)', () => {
    const createSite = REFUSAL_SITES.CREATE_USER;
    const BODY_SECRET = 'BODY-SECRET-SENTINEL';
    const denial = (): RastaError =>
      markRefusal(
        RastaError.insufficientRole(['ORGANIZATION_ADMIN', 'UNION_ADMIN'], ['AUDITOR']),
        'CREATE_USER',
      );
    const observeCreate = (overrides: Partial<RefusalObservation> = {}): RefusalObservation => ({
      exception: denial(),
      status: 403,
      code: ERROR_CODES.INSUFFICIENT_ROLE,
      method: 'POST',
      route: createSite.route,
      context: context({ roles: ['AUDITOR'], path: `/v1/users?username=${BODY_SECRET}` }),
      ...overrides,
    });

    it('maps the actor, roles and tenant from the context and everything else from the site', () => {
      expect(captured(observeCreate())).toMatchObject({
        organizationId: 'ORG_A',
        actorType: 'USER',
        actorId: 'USR_A',
        actorRoles: ['AUDITOR'],
        action: 'identity.users.create',
        resourceType: 'User',
        resourceId: 'USR_A',
        errorCode: 'INSUFFICIENT_ROLE',
        reason: createSite.reason,
        occurrenceCount: 1,
      });
    });

    it("records neither the endpoint's required roles, the request, nor the error's text or context", () => {
      const serialised = JSON.stringify(captured(observeCreate()));
      expect(serialised).not.toContain('ORGANIZATION_ADMIN');
      expect(serialised).not.toContain('UNION_ADMIN');
      expect(serialised).not.toContain(BODY_SECRET);
      expect(serialised).not.toContain(denial().message);
      expect(serialised).not.toContain('required');
    });

    it('never shares an aggregation identity with the listing site on the same template', () => {
      const create = captured(observeCreate());
      const list = captured({
        ...observeCreate(),
        exception: markRefusal(RastaError.insufficientRole(['UNION_ADMIN'], []), 'LIST_USERS'),
        method: 'GET',
      });
      expect(create.action).not.toBe(list.action);
      expect(create.reason).not.toBe(list.reason);
    });

    it.each([
      ['GET on the same template', { method: 'GET' }],
      ['a nested template', { route: '/v1/users/:id/memberships' }],
    ])('skips a marked denial observed on %s', (_label, overrides) => {
      expect(skipReason(observeCreate(overrides))).toBe(CAPTURE_SKIP_REASONS.ROUTE_MISMATCH);
    });

    it('never captures an unmarked INSUFFICIENT_ROLE, even on POST /v1/users', () => {
      expect(
        decideCapture(
          observeCreate({ exception: RastaError.insufficientRole(['UNION_ADMIN'], []) }),
          ENVIRONMENT,
        ),
      ).toEqual({ kind: 'NOT_A_REFUSAL_SITE' });
    });
  });

  describe('the roles-guard site POST /v1/users/:id/memberships (AUD-004 Phase C5)', () => {
    const membershipSite = REFUSAL_SITES.ADD_MEMBERSHIP;
    const TARGET_USER = 'USR_TARGET_PATH_SENTINEL';
    const BODY_ORGANIZATION = 'ORG_BODY_SENTINEL';
    const denial = (): RastaError =>
      markRefusal(
        RastaError.insufficientRole(['ORGANIZATION_ADMIN', 'UNION_ADMIN'], ['AUDITOR']),
        'ADD_MEMBERSHIP',
      );
    const observeMembership = (
      overrides: Partial<RefusalObservation> = {},
    ): RefusalObservation => ({
      exception: denial(),
      status: 403,
      code: ERROR_CODES.INSUFFICIENT_ROLE,
      method: 'POST',
      route: membershipSite.route,
      context: context({
        roles: ['AUDITOR'],
        path: `/v1/users/${TARGET_USER}/memberships?organizationId=${BODY_ORGANIZATION}`,
      }),
      ...overrides,
    });

    it('names the verified caller as the resource, never the target user in the path', () => {
      const draft = captured(observeMembership());
      expect(draft).toMatchObject({
        organizationId: 'ORG_A',
        actorType: 'USER',
        actorId: 'USR_A',
        actorRoles: ['AUDITOR'],
        action: 'identity.memberships.create',
        resourceType: 'Membership',
        resourceId: 'USR_A',
        errorCode: 'INSUFFICIENT_ROLE',
        reason: membershipSite.reason,
        occurrenceCount: 1,
      });
      expect(draft.resourceId).not.toBe(TARGET_USER);
    });

    it("records neither the path, the body, the endpoint's required roles, nor the error's text or context", () => {
      const serialised = JSON.stringify(captured(observeMembership()));
      for (const leaked of [
        TARGET_USER,
        BODY_ORGANIZATION,
        '/v1/users',
        'ORGANIZATION_ADMIN',
        'UNION_ADMIN',
        denial().message,
        'required',
      ]) {
        expect(serialised).not.toContain(leaked);
      }
    });

    it('never shares an aggregation identity with any other site', () => {
      const draft = captured(observeMembership());
      for (const other of Object.values(REFUSAL_SITES)) {
        if (other === membershipSite) continue;
        expect(`${draft.action}|${draft.resourceType}`).not.toBe(
          `${other.action}|${other.resourceType}`,
        );
      }
    });

    it.each([
      ['POST /v1/users', { route: '/v1/users' }],
      ['GET on the same template', { method: 'GET' }],
      ['a concrete path where the template belongs', { route: '/v1/users/USR_X/memberships' }],
      ['membership roles', { route: '/v1/memberships/:id/roles' }],
    ])('skips a marked denial observed on %s', (_label, overrides) => {
      expect(skipReason(observeMembership(overrides))).toBe(CAPTURE_SKIP_REASONS.ROUTE_MISMATCH);
    });

    it('never captures an unmarked INSUFFICIENT_ROLE, even on the membership template', () => {
      expect(
        decideCapture(
          observeMembership({ exception: RastaError.insufficientRole(['UNION_ADMIN'], []) }),
          ENVIRONMENT,
        ),
      ).toEqual({ kind: 'NOT_A_REFUSAL_SITE' });
    });
  });

  describe('the roles-guard site POST /v1/memberships/:id/roles (AUD-004 Phase C6)', () => {
    const rolesSite = REFUSAL_SITES.UPDATE_MEMBERSHIP_ROLES;
    const TARGET_MEMBERSHIP = 'MBR_TARGET_PATH_SENTINEL';
    const BODY_REASON = 'REASON_BODY_SENTINEL';
    const denial = (): RastaError =>
      markRefusal(
        RastaError.insufficientRole(['ORGANIZATION_ADMIN', 'UNION_ADMIN'], ['AUDITOR']),
        'UPDATE_MEMBERSHIP_ROLES',
      );
    const observeRoles = (overrides: Partial<RefusalObservation> = {}): RefusalObservation => ({
      exception: denial(),
      status: 403,
      code: ERROR_CODES.INSUFFICIENT_ROLE,
      method: 'POST',
      route: rolesSite.route,
      context: context({
        roles: ['AUDITOR'],
        path: `/v1/memberships/${TARGET_MEMBERSHIP}/roles?reason=${BODY_REASON}`,
      }),
      ...overrides,
    });

    it('names the verified caller as the resource, never the membership in the path', () => {
      const draft = captured(observeRoles());
      expect(draft).toMatchObject({
        organizationId: 'ORG_A',
        actorType: 'USER',
        actorId: 'USR_A',
        actorRoles: ['AUDITOR'],
        action: 'identity.memberships.roles.replace',
        resourceType: 'Membership',
        resourceId: 'USR_A',
        errorCode: 'INSUFFICIENT_ROLE',
        reason: rolesSite.reason,
        occurrenceCount: 1,
      });
      expect(draft.resourceId).not.toBe(TARGET_MEMBERSHIP);
    });

    it("records neither the path, the body, the endpoint's required roles, nor the error's text or context", () => {
      const serialised = JSON.stringify(captured(observeRoles()));
      for (const leaked of [
        TARGET_MEMBERSHIP,
        BODY_REASON,
        '/v1/memberships',
        '/roles',
        'ORGANIZATION_ADMIN',
        'UNION_ADMIN',
        denial().message,
        'required',
      ]) {
        expect(serialised).not.toContain(leaked);
      }
    });

    it('never shares an aggregation identity with any other site, including membership creation', () => {
      const draft = captured(observeRoles());
      for (const other of Object.values(REFUSAL_SITES)) {
        if (other === rolesSite) continue;
        expect(`${draft.action}|${draft.resourceType}|${draft.errorCode}`).not.toBe(
          `${other.action}|${other.resourceType}|${other.errorCode}`,
        );
      }
    });

    it.each([
      ['POST /v1/users/:id/memberships', { route: '/v1/users/:id/memberships' }],
      ['GET on the same template', { method: 'GET' }],
      ['a concrete path where the template belongs', { route: '/v1/memberships/MBR_X/roles' }],
      ['membership revoke', { route: '/v1/memberships/:id/revoke' }],
      ['a trailing slash', { route: '/v1/memberships/:id/roles/' }],
    ])('skips a marked denial observed on %s', (_label, overrides) => {
      expect(skipReason(observeRoles(overrides))).toBe(CAPTURE_SKIP_REASONS.ROUTE_MISMATCH);
    });

    it('never captures an unmarked INSUFFICIENT_ROLE, even on the roles template', () => {
      expect(
        decideCapture(
          observeRoles({ exception: RastaError.insufficientRole(['UNION_ADMIN'], []) }),
          ENVIRONMENT,
        ),
      ).toEqual({ kind: 'NOT_A_REFUSAL_SITE' });
    });
  });

  describe('is not a refusal site', () => {
    it.each([
      ["the auth guard's own TENANT_MISMATCH", RastaError.tenantMismatch('ORG_X', ['ORG_A'])],
      ['an INSUFFICIENT_ROLE refusal', RastaError.insufficientRole(['UNION_ADMIN'], [])],
      ['a FORBIDDEN refusal', RastaError.forbidden()],
      ['a 401', RastaError.unauthenticated()],
      ['a plain Error', new Error('boom')],
    ])('for %s', (_label, exception) => {
      expect(decideCapture(observe({ exception }), ENVIRONMENT)).toEqual({
        kind: 'NOT_A_REFUSAL_SITE',
      });
    });
  });

  describe('skips a marked refusal that does not match its site exactly', () => {
    it.each([
      ['status 401', { status: 401, code: ERROR_CODES.UNAUTHENTICATED }],
      ['status 500', { status: 500, code: ERROR_CODES.INTERNAL_ERROR }],
      ['a different 403 code', { code: ERROR_CODES.FORBIDDEN }],
      ['a missing code', { code: undefined }],
    ])('classification: %s', (_label, overrides) => {
      expect(skipReason(observe(overrides))).toBe(CAPTURE_SKIP_REASONS.CLASSIFICATION_MISMATCH);
    });

    it.each([
      ['another method', { method: 'GET' }],
      ['no matched route', { route: undefined }],
      ['another route template', { route: '/v1/users/:id' }],
      ['the concrete URL instead of the template', { route: `${site.route}?x=1` }],
    ])('route: %s', (_label, overrides) => {
      expect(skipReason(observe(overrides))).toBe(CAPTURE_SKIP_REASONS.ROUTE_MISMATCH);
    });

    it.each([
      ['no request context', undefined],
      ['an anonymous caller', context({ authType: 'ANONYMOUS', userId: undefined, roles: [] })],
      ['a service caller', context({ authType: 'SERVICE', userId: undefined, callerService: 'x' })],
      ['a user token with no user id', context({ userId: undefined })],
      ['a blank user id', context({ userId: '   ' })],
    ])('authentication: %s', (_label, ctx) => {
      expect(skipReason(observe({ context: ctx }))).toBe(
        CAPTURE_SKIP_REASONS.NOT_AUTHENTICATED_USER,
      );
    });

    it.each([
      ['more than 64 roles', context({ roles: Array.from({ length: 65 }, (_, i) => `ROLE_${i}`) })],
      ['a blank role', context({ roles: ['FLEET_MANAGER', ' '] })],
      ['an oversized role', context({ roles: ['R'.repeat(129)] })],
      ['a blank organization', context({ organizationId: ' ' })],
      ['an oversized organization id', context({ organizationId: 'O'.repeat(129) })],
      ['an oversized user id', context({ userId: 'U'.repeat(257) })],
    ])('attribution: %s', (_label, ctx) => {
      expect(skipReason(observe({ context: ctx }))).toBe(CAPTURE_SKIP_REASONS.UNATTRIBUTABLE);
    });

    it('contract: an event the audit contract would refuse never becomes a row', () => {
      const decision = decideCapture(observe(), { ...ENVIRONMENT, newId: () => '' });
      expect(decision).toMatchObject({
        kind: 'SKIP',
        reason: CAPTURE_SKIP_REASONS.CONTRACT_VIOLATION,
      });
    });
  });

  describe('source and correlation values are bounded or dropped', () => {
    it('strips control characters from the user agent and truncates it to 512 characters', () => {
      const nul = String.fromCharCode(0);
      const bell = String.fromCharCode(7);
      const del = String.fromCharCode(127);
      const draft = captured(
        observe({
          context: context({ userAgent: `Agent${nul}/1${bell}.0${del} ${'x'.repeat(600)}` }),
        }),
      );
      expect(draft.sourceUserAgent).toHaveLength(512);
      expect(draft.sourceUserAgent?.startsWith('Agent/1.0 xxx')).toBe(true);
      expect(
        [...(draft.sourceUserAgent ?? '')].every((c) => {
          const code = c.codePointAt(0) ?? 0;
          return code >= 32 && code !== 127;
        }),
      ).toBe(true);
    });

    it('drops a user agent that is only control characters or whitespace', () => {
      const tab = String.fromCharCode(9);
      expect(
        captured(observe({ context: context({ userAgent: `${tab}  ${tab}` }) })).sourceUserAgent,
      ).toBeNull();
      expect(
        captured(observe({ context: context({ userAgent: undefined }) })).sourceUserAgent,
      ).toBeNull();
    });

    it.each([
      ['an IPv4 address', '198.51.100.4', '198.51.100.4'],
      ['an IPv6 address', '2001:db8::7', '2001:db8::7'],
      ['an IPv4-mapped IPv6 address', '::ffff:127.0.0.1', '::ffff:127.0.0.1'],
      ['a hostname', 'proxy.internal', null],
      ['a header-injected list', '1.2.3.4, 5.6.7.8', null],
      ['nothing', undefined, null],
    ])('source ip: %s', (_label, ip, expected) => {
      expect(captured(observe({ context: context({ ip }) })).sourceIp).toBe(expected);
    });

    it.each([
      ['with spaces', 'not an id'],
      ['too long', 'C'.repeat(129)],
      ['with markup', '<script>'],
    ])(
      'falls back to the minted request id for a caller-supplied correlation id %s',
      (_l, value) => {
        expect(
          captured(observe({ context: context({ correlationId: value }) })).correlationId,
        ).toBe('01J9ZC00000000000000000REQ');
      },
    );

    it('falls back to the event id when neither correlation nor request id is usable', () => {
      expect(
        captured(observe({ context: context({ correlationId: 'a b', requestId: 'c d' }) }))
          .correlationId,
      ).toBe(EVENT_ID);
    });

    it.each([
      ['no trace', { traceId: undefined, spanId: undefined }],
      ['a malformed trace id', { traceId: 'XYZ' }],
      ['a malformed span id', { spanId: '123' }],
    ])('leaves traceparent out for %s', (_label, overrides) => {
      expect(captured(observe({ context: context(overrides) })).traceparent).toBeNull();
    });

    it.each([
      ['too long', 'v'.repeat(65)],
      ['blank', '  '],
    ])('replaces a %s producer version with a fixed placeholder', (_label, producerVersion) => {
      expect(decideCapture(observe(), { ...ENVIRONMENT, producerVersion })).toMatchObject({
        kind: 'CAPTURE',
        draft: { producerVersion: '0.0.0' },
      });
    });
  });
});
