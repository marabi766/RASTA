import request from 'supertest';
import { ulid } from 'ulid';
import {
  AUDIT_TRAIL_TOPIC,
  ERROR_CODES,
  auditTrailPayloadSchemaV1,
  parseEnvelope,
} from '@rasta/contracts';
import type { PrismaService } from '../src/prisma/prisma.service';
import { aggregationWindowOf } from '../src/security-events/refusal-aggregation';
import { REFUSAL_SITES, type RefusalSite } from '../src/security-events/refusal-sites';
import { startIdentityApi, userToken, type Caller, type IdentityApiHarness } from './api-helpers';
import { atFreshWindow, waitForWindowClose } from './helpers';

/**
 * The seven roles-guard refusal sites — `GET /v1/users` (AUD-004 Phase C3),
 * `POST /v1/users` (Phase C4), `POST /v1/users/:id/memberships` (Phase C5),
 * `POST /v1/memberships/:id/roles` (Phase C6),
 * `POST /v1/memberships/:id/revoke` (Phase C7),
 * `POST /v1/registration-requests/:id/approve` (Phase C8) and
 * `POST /v1/registration-requests/:id/reject` (Phase C9), each refused by the
 * roles guard with `403 INSUFFICIENT_ROLE` — against a real PostgreSQL
 * (ADR-053 § 4).
 *
 * Every refusal here is a real request through the real `AppModule`: the global
 * auth guard, then `IdentityRolesGuard` delegating to the platform
 * `RolesGuard`, then the refusal filter, then the Phase C2 aggregation upsert.
 * Nothing about any site bypasses any of them.
 *
 * Since Phase C9 every `@Roles` route in identity-service is a site, so there
 * is no uninstrumented role refusal left to compare a response against. Each
 * response is therefore pinned to the exact refusal the platform has always
 * given (`expectPlatformRefusal`), and the byte-for-byte equivalence with the
 * platform `RolesGuard` is proved in `identity-roles.guard.spec.ts`. The
 * negative controls are near misses of the instrumented templates. Since Phase
 * C10 the auth guard's own refusal is a site too, so it is no longer a negative
 * control for being uncaptured — it is asserted here to be captured as *its own*
 * site, which is what proves the two guards never mark each other's refusals.
 *
 * A two-second aggregation window (configuration, not a bypass) lets the suite
 * watch a window close. Everything written carries `TAG`; cleanup removes
 * exactly that.
 */

const TAG = ulid().slice(-10);
const tagged = (prefix: string): string => `${prefix}_${TAG}_${ulid()}`;
const LIST = REFUSAL_SITES.LIST_USERS;
const CREATE = REFUSAL_SITES.CREATE_USER;
const MEMBERSHIP = REFUSAL_SITES.ADD_MEMBERSHIP;
const ROLES = REFUSAL_SITES.UPDATE_MEMBERSHIP_ROLES;
const REVOKE = REFUSAL_SITES.REVOKE_MEMBERSHIP;
const APPROVE = REFUSAL_SITES.APPROVE_REGISTRATION_REQUEST;
const REJECT = REFUSAL_SITES.REJECT_REGISTRATION_REQUEST;
const WINDOW_SECONDS = 2;

const QUERY_SECRET = `query-secret-${TAG}`;
const COOKIE_SECRET = `cookie-secret-${TAG}`;
const BODY_SECRET = `body-secret-${TAG}`;
const PATH_SECRET = `path-secret-${TAG}`;
/** The endpoint's required roles: policy, never evidence. */
const REQUIRED_ROLES = ['ORGANIZATION_ADMIN', 'UNION_ADMIN'];
/** The approval endpoint requires exactly one role. Still policy, still never evidence. */
const APPROVE_REQUIRED_ROLE = 'UNION_ADMIN';

/** A user the caller asks to create. Attacker-chosen: none of it is evidence. */
const createBody = (marker: string = BODY_SECRET): Record<string, unknown> => ({
  username: `${marker}-user`,
  email: `${marker}@identity.itest`,
  firstName: `${marker}-first`,
  lastName: `${marker}-last`,
  organizationId: `ORG-BODY-${marker}`,
  roles: ['SYSTEM_ADMIN', 'ORGANIZATION_ADMIN'],
  password: `${marker}-password`,
});

/** A membership the caller asks to add. Attacker-chosen: none of it is evidence. */
const membershipBody = (marker: string = BODY_SECRET): Record<string, unknown> => ({
  organizationId: `ORG-BODY-${marker}`,
  roles: ['SYSTEM_ADMIN', 'UNION_ADMIN'],
  note: `${marker}-note`,
});

/** A role replacement the caller asks for. Attacker-chosen: none of it is evidence. */
const rolesBody = (marker: string = BODY_SECRET): Record<string, unknown> => ({
  roles: ['SYSTEM_ADMIN', 'UNION_ADMIN'],
  reason: `${marker}-reason`,
});

/** The reason the caller states for a revocation. Attacker-chosen: not evidence. */
const revokeBody = (marker: string = BODY_SECRET): Record<string, unknown> => ({
  reason: `${marker}-revoke-reason`,
});

/** What the caller says the approval should grant. Attacker-chosen: not evidence. */
const approveBody = (marker: string = BODY_SECRET): Record<string, unknown> => ({
  organizationId: `ORG-BODY-${marker}`,
  roles: ['SYSTEM_ADMIN', 'UNION_ADMIN'],
  note: `${marker}-approve-note`,
});

/** The reason the caller states for a rejection. Attacker-chosen: not evidence. */
const rejectBody = (marker: string = BODY_SECRET): Record<string, unknown> => ({
  reason: `${marker}-reject-reason`,
});

describe('roles-guard refusals → security_event_outbox (real PostgreSQL)', () => {
  let harness: IdentityApiHarness;
  let prisma: PrismaService;

  const rowsFor = (actorId: string) =>
    prisma.client.securityEventOutbox.findMany({
      where: { actorId },
      orderBy: [{ windowStartedAt: 'asc' }, { createdAt: 'asc' }],
    });

  /** Every column of one row as PostgreSQL renders it — nothing mapped away. */
  const rawRow = async (id: string): Promise<string> => {
    const rows = await prisma.client.$queryRawUnsafe<{ row: string }[]>(
      'SELECT row_to_json(s)::text AS row FROM security_event_outbox s WHERE id = $1',
      id,
    );
    return rows[0]?.row ?? '';
  };

  function listUsers(
    caller: Caller,
    options: { query?: string; headers?: Record<string, string> } = {},
  ) {
    const call = request(harness.app.getHttpServer())
      .get(`${LIST.route}${options.query ?? ''}`)
      .set('authorization', `Bearer ${userToken(caller)}`)
      .set('x-correlation-id', tagged('COR'));
    for (const [name, value] of Object.entries(options.headers ?? {})) call.set(name, value);
    return call;
  }

  function createUser(
    caller: Caller,
    options: { body?: Record<string, unknown>; headers?: Record<string, string> } = {},
  ) {
    const call = request(harness.app.getHttpServer())
      .post(CREATE.route)
      .set('authorization', `Bearer ${userToken(caller)}`)
      .set('x-correlation-id', tagged('COR'));
    for (const [name, value] of Object.entries(options.headers ?? {})) call.set(name, value);
    return call.send(options.body ?? createBody());
  }

  function addMembership(
    caller: Caller,
    options: {
      target?: string;
      body?: Record<string, unknown>;
      headers?: Record<string, string>;
    } = {},
  ) {
    const call = request(harness.app.getHttpServer())
      .post(`/v1/users/${options.target ?? `USR-${PATH_SECRET}`}/memberships`)
      .set('authorization', `Bearer ${userToken(caller)}`)
      .set('x-correlation-id', tagged('COR'));
    for (const [name, value] of Object.entries(options.headers ?? {})) call.set(name, value);
    return call.send(options.body ?? membershipBody());
  }

  function replaceRoles(
    caller: Caller,
    options: {
      target?: string;
      body?: Record<string, unknown>;
      headers?: Record<string, string>;
    } = {},
  ) {
    const call = request(harness.app.getHttpServer())
      .post(`/v1/memberships/${options.target ?? `MBR-${PATH_SECRET}`}/roles`)
      .set('authorization', `Bearer ${userToken(caller)}`)
      .set('x-correlation-id', tagged('COR'));
    for (const [name, value] of Object.entries(options.headers ?? {})) call.set(name, value);
    return call.send(options.body ?? rolesBody());
  }

  function revokeMembership(
    caller: Caller,
    options: {
      target?: string;
      body?: Record<string, unknown>;
      headers?: Record<string, string>;
    } = {},
  ) {
    const call = request(harness.app.getHttpServer())
      .post(`/v1/memberships/${options.target ?? `MBR-${PATH_SECRET}`}/revoke`)
      .set('authorization', `Bearer ${userToken(caller)}`)
      .set('x-correlation-id', tagged('COR'));
    for (const [name, value] of Object.entries(options.headers ?? {})) call.set(name, value);
    return call.send(options.body ?? revokeBody());
  }

  function approveRegistration(
    caller: Caller,
    options: {
      target?: string;
      body?: Record<string, unknown>;
      headers?: Record<string, string>;
    } = {},
  ) {
    const call = request(harness.app.getHttpServer())
      .post(`/v1/registration-requests/${options.target ?? `REG-${PATH_SECRET}`}/approve`)
      .set('authorization', `Bearer ${userToken(caller)}`)
      .set('x-correlation-id', tagged('COR'));
    for (const [name, value] of Object.entries(options.headers ?? {})) call.set(name, value);
    return call.send(options.body ?? approveBody());
  }

  function rejectRegistration(
    caller: Caller,
    options: {
      target?: string;
      body?: Record<string, unknown>;
      headers?: Record<string, string>;
    } = {},
  ) {
    const call = request(harness.app.getHttpServer())
      .post(`/v1/registration-requests/${options.target ?? `REG-${PATH_SECRET}`}/reject`)
      .set('authorization', `Bearer ${userToken(caller)}`)
      .set('x-correlation-id', tagged('COR'));
    for (const [name, value] of Object.entries(options.headers ?? {})) call.set(name, value);
    return call.send(options.body ?? rejectBody());
  }

  const caller = (roles: string[] = ['FLEET_MANAGER']): Caller => ({
    userId: tagged('USR'),
    organizationId: tagged('ORG'),
    roles,
  });

  /**
   * The exact refusal the platform has always given: `403`, the platform's
   * fields and nothing else, its code and message, and the caller's own
   * correlation id and path echoed back. There is no uninstrumented role
   * refusal left in this service to compare against (Phase C9).
   */
  const expectPlatformRefusal = (response: request.Response, correlationId?: string): void => {
    expect(response.status).toBe(403);
    expect(Object.keys(response.body).sort()).toEqual([
      'code',
      'correlationId',
      'message',
      'path',
      'timestamp',
    ]);
    expect(response.body.code).toBe(ERROR_CODES.INSUFFICIENT_ROLE);
    expect(response.body.message).toBe('You do not have permission to perform this action');
    if (correlationId !== undefined) expect(response.body.correlationId).toBe(correlationId);
  };

  beforeAll(async () => {
    harness = await startIdentityApi({ aggregationWindowSeconds: WINDOW_SECONDS });
    prisma = harness.prisma;
    await prisma.client.$queryRawUnsafe('SELECT 1');
  }, 60_000);

  afterAll(async () => {
    await prisma.client.$executeRawUnsafe(
      'DELETE FROM security_event_outbox WHERE actor_id LIKE $1',
      `%_${TAG}_%`,
    );
    await harness?.close();
  }, 60_000);

  describe('GET /v1/users (Phase C3)', () => {
    it('captures a real INSUFFICIENT_ROLE refusal with trusted attribution and no role policy, query, token or error text', async () => {
      const refused = caller();
      const token = userToken(refused);
      const correlationId = tagged('COR');

      const response = await request(harness.app.getHttpServer())
        .get(`${LIST.route}?q=${QUERY_SECRET}&role=UNION_ADMIN`)
        .set('authorization', `Bearer ${token}`)
        .set('cookie', `session=${COOKIE_SECRET}`)
        .set('x-correlation-id', correlationId);

      // The refusal the platform has always given.
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        code: ERROR_CODES.INSUFFICIENT_ROLE,
        message: 'You do not have permission to perform this action',
        correlationId,
      });

      const rows = await rowsFor(refused.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        organizationId: refused.organizationId,
        actorType: 'USER',
        actorId: refused.userId,
        actorRoles: ['FLEET_MANAGER'],
        action: 'identity.users.list',
        resourceType: 'User',
        resourceId: refused.userId,
        errorCode: 'INSUFFICIENT_ROLE',
        reason: LIST.reason,
        correlationId,
        occurrenceCount: 1,
        publishedAt: null,
        claimCount: 0,
      });

      const everything = await rawRow(rows[0]!.id);
      for (const leaked of [
        ...REQUIRED_ROLES,
        QUERY_SECRET,
        COOKIE_SECRET,
        token,
        '/v1/users',
        'q=',
        'You do not have permission',
        'required',
      ]) {
        expect(everything).not.toContain(leaked);
      }
    });

    it('answers with exactly the established platform refusal', async () => {
      const refused = caller();
      expectPlatformRefusal(await listUsers(refused));
    });

    it('aggregates sequential refusals in one short window, and opens a new row in the next', async () => {
      const refused = caller();
      await atFreshWindow(prisma, WINDOW_SECONDS, 1_500);

      for (let i = 0; i < 3; i += 1) {
        const response = await listUsers(refused, { query: `?q=${QUERY_SECRET}-${i}` });
        expect(response.status).toBe(403);
        expect(response.body.code).toBe(ERROR_CODES.INSUFFICIENT_ROLE);
      }

      const [first, ...others] = await rowsFor(refused.userId);
      expect(others).toHaveLength(0);
      expect(first).toMatchObject({ occurrenceCount: 3, action: LIST.action });
      expect(aggregationWindowOf(first!.occurredAt, WINDOW_SECONDS)).toEqual({
        startedAt: first!.windowStartedAt,
        endsAt: first!.windowEndsAt,
      });

      await waitForWindowClose(prisma, first!.id);
      expect((await listUsers(refused)).status).toBe(403);

      const rows = await rowsFor(refused.userId);
      expect(rows.map((row) => row.occurrenceCount)).toEqual([3, 1]);
      expect(rows[1]!.windowStartedAt.getTime()).toBeGreaterThanOrEqual(
        rows[0]!.windowEndsAt.getTime(),
      );
    });

    it('captures nothing for callers the shared guard allows', async () => {
      for (const roles of [['ORGANIZATION_ADMIN'], ['UNION_ADMIN'], ['SYSTEM_ADMIN']]) {
        const allowed = caller(roles);
        const response = await listUsers(allowed);
        expect(response.status).toBe(200);
        expect(await rowsFor(allowed.userId)).toHaveLength(0);
      }
    });
  });

  describe('POST /v1/users (Phase C4)', () => {
    it('captures a real INSUFFICIENT_ROLE refusal with trusted attribution and nothing from the body, role policy, token, cookie or error text', async () => {
      const refused = caller(['AUDITOR']);
      const token = userToken(refused);
      const correlationId = tagged('COR');

      const response = await request(harness.app.getHttpServer())
        .post(`${CREATE.route}?role=UNION_ADMIN&note=${QUERY_SECRET}`)
        .set('authorization', `Bearer ${token}`)
        .set('cookie', `session=${COOKIE_SECRET}`)
        .set('x-correlation-id', correlationId)
        .send(createBody());

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        code: ERROR_CODES.INSUFFICIENT_ROLE,
        message: 'You do not have permission to perform this action',
        correlationId,
      });
      expect(JSON.stringify(response.body)).not.toContain(BODY_SECRET);

      const rows = await rowsFor(refused.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        organizationId: refused.organizationId,
        actorType: 'USER',
        actorId: refused.userId,
        actorRoles: ['AUDITOR'],
        action: 'identity.users.create',
        resourceType: 'User',
        // The caller's own id: a refused create has no created user.
        resourceId: refused.userId,
        errorCode: 'INSUFFICIENT_ROLE',
        reason: CREATE.reason,
        correlationId,
        occurrenceCount: 1,
        publishedAt: null,
        claimCount: 0,
      });

      const everything = await rawRow(rows[0]!.id);
      for (const leaked of [
        ...REQUIRED_ROLES,
        'SYSTEM_ADMIN',
        BODY_SECRET,
        'ORG-BODY-',
        'password',
        QUERY_SECRET,
        COOKIE_SECRET,
        token,
        '/v1/users',
        'role=',
        'You do not have permission',
        'required',
      ]) {
        expect(everything).not.toContain(leaked);
      }
    });

    it('answers with exactly the established platform refusal', async () => {
      const refused = caller();
      expectPlatformRefusal(await createUser(refused));
      expect((await rowsFor(refused.userId)).map((row) => row.action)).toEqual([CREATE.action]);
    });

    it('aggregates sequential refusals in one short window regardless of the body, and opens a new row in the next', async () => {
      const refused = caller();
      await atFreshWindow(prisma, WINDOW_SECONDS, 1_500);

      for (let i = 0; i < 3; i += 1) {
        // A different body every time: none of it is aggregation-key material.
        const response = await createUser(refused, { body: createBody(`${BODY_SECRET}-${i}`) });
        expect(response.status).toBe(403);
        expect(response.body.code).toBe(ERROR_CODES.INSUFFICIENT_ROLE);
      }

      const [first, ...others] = await rowsFor(refused.userId);
      expect(others).toHaveLength(0);
      expect(first).toMatchObject({ occurrenceCount: 3, action: CREATE.action });
      expect(aggregationWindowOf(first!.occurredAt, WINDOW_SECONDS)).toEqual({
        startedAt: first!.windowStartedAt,
        endsAt: first!.windowEndsAt,
      });

      await waitForWindowClose(prisma, first!.id);
      expect((await createUser(refused)).status).toBe(403);

      const rows = await rowsFor(refused.userId);
      expect(rows.map((row) => row.occurrenceCount)).toEqual([3, 1]);
      expect(rows.map((row) => row.action)).toEqual([CREATE.action, CREATE.action]);
      expect(rows[1]!.windowStartedAt.getTime()).toBeGreaterThanOrEqual(
        rows[0]!.windowEndsAt.getTime(),
      );
    });

    it('lets the shared guard allow the callers it allows, and captures nothing for them', async () => {
      for (const roles of [['ORGANIZATION_ADMIN'], ['UNION_ADMIN'], ['SYSTEM_ADMIN']]) {
        const allowed = caller(roles);
        // An invalid body: the guard lets the request through to validation,
        // which answers 400 — so no user is created and nothing is refused.
        const response = await createUser(allowed, { body: {} });
        expect(response.status).toBe(400);
        expect(response.body.code).not.toBe(ERROR_CODES.INSUFFICIENT_ROLE);
        expect(await rowsFor(allowed.userId)).toHaveLength(0);
      }
    });
  });

  describe('POST /v1/users/:id/memberships (Phase C5)', () => {
    it('captures a real INSUFFICIENT_ROLE refusal attributed to the verified caller, with nothing from the path, body, role policy, token, cookie or error text', async () => {
      const refused = caller(['AUDITOR']);
      const token = userToken(refused);
      const correlationId = tagged('COR');
      const target = `USR-${PATH_SECRET}`;

      const response = await request(harness.app.getHttpServer())
        .post(`/v1/users/${target}/memberships?role=UNION_ADMIN&note=${QUERY_SECRET}`)
        .set('authorization', `Bearer ${token}`)
        .set('cookie', `session=${COOKIE_SECRET}`)
        .set('x-correlation-id', correlationId)
        .send(membershipBody());

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        code: ERROR_CODES.INSUFFICIENT_ROLE,
        message: 'You do not have permission to perform this action',
        correlationId,
      });
      // The platform's error body echoes the caller's own request path back to
      // them (unchanged, the same for every route); the body is never echoed.
      // What matters is that neither reaches the stored evidence, below.
      expect(JSON.stringify(response.body)).not.toContain(BODY_SECRET);

      const rows = await rowsFor(refused.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        organizationId: refused.organizationId,
        actorType: 'USER',
        actorId: refused.userId,
        actorRoles: ['AUDITOR'],
        action: 'identity.memberships.create',
        resourceType: 'Membership',
        // The verified caller — never the target user the path names.
        resourceId: refused.userId,
        errorCode: 'INSUFFICIENT_ROLE',
        reason: MEMBERSHIP.reason,
        correlationId,
        occurrenceCount: 1,
        publishedAt: null,
        claimCount: 0,
      });
      expect(rows[0]!.resourceId).not.toBe(target);

      const everything = await rawRow(rows[0]!.id);
      for (const leaked of [
        ...REQUIRED_ROLES,
        'SYSTEM_ADMIN',
        PATH_SECRET,
        target,
        BODY_SECRET,
        'ORG-BODY-',
        QUERY_SECRET,
        COOKIE_SECRET,
        token,
        '/v1/users',
        '/memberships',
        ':id',
        'role=',
        'You do not have permission',
        'required',
      ]) {
        expect(everything).not.toContain(leaked);
      }
    });

    it('answers with exactly the established platform refusal', async () => {
      const refused = caller();
      expectPlatformRefusal(await addMembership(refused));
      expect((await rowsFor(refused.userId)).map((row) => row.action)).toEqual([MEMBERSHIP.action]);
    });

    it('aggregates by the caller across different target ids and bodies in one window, and opens a new row in the next', async () => {
      const refused = caller();
      await atFreshWindow(prisma, WINDOW_SECONDS, 1_500);

      for (let i = 0; i < 3; i += 1) {
        // A different target and body every time: neither is aggregation-key material.
        const response = await addMembership(refused, {
          target: `USR-${PATH_SECRET}-${i}`,
          body: membershipBody(`${BODY_SECRET}-${i}`),
        });
        expect(response.status).toBe(403);
        expect(response.body.code).toBe(ERROR_CODES.INSUFFICIENT_ROLE);
      }

      const [first, ...others] = await rowsFor(refused.userId);
      expect(others).toHaveLength(0);
      expect(first).toMatchObject({
        occurrenceCount: 3,
        action: MEMBERSHIP.action,
        resourceId: refused.userId,
      });
      expect(aggregationWindowOf(first!.occurredAt, WINDOW_SECONDS)).toEqual({
        startedAt: first!.windowStartedAt,
        endsAt: first!.windowEndsAt,
      });

      await waitForWindowClose(prisma, first!.id);
      expect((await addMembership(refused)).status).toBe(403);

      const rows = await rowsFor(refused.userId);
      expect(rows.map((row) => row.occurrenceCount)).toEqual([3, 1]);
      expect(rows.map((row) => row.action)).toEqual([MEMBERSHIP.action, MEMBERSHIP.action]);
      expect(rows[1]!.windowStartedAt.getTime()).toBeGreaterThanOrEqual(
        rows[0]!.windowEndsAt.getTime(),
      );
    });

    it('lets the shared guard allow ORGANIZATION_ADMIN, UNION_ADMIN and SYSTEM_ADMIN, and captures nothing for them', async () => {
      for (const roles of [['ORGANIZATION_ADMIN'], ['UNION_ADMIN'], ['SYSTEM_ADMIN']]) {
        const allowed = caller(roles);
        // An invalid body: the guard lets the request through to validation,
        // which answers 400 — so no membership is created and nothing is refused.
        const response = await addMembership(allowed, { body: {} });
        expect(response.status).toBe(400);
        expect(response.body.code).not.toBe(ERROR_CODES.INSUFFICIENT_ROLE);
        expect(await rowsFor(allowed.userId)).toHaveLength(0);
      }
    });
  });

  describe('POST /v1/memberships/:id/roles (Phase C6)', () => {
    it('captures a real INSUFFICIENT_ROLE refusal attributed to the verified caller, with nothing from the path, body, role policy, token, cookie or error text', async () => {
      const refused = caller(['AUDITOR']);
      const token = userToken(refused);
      const correlationId = tagged('COR');
      const target = `MBR-${PATH_SECRET}`;

      const response = await request(harness.app.getHttpServer())
        .post(`/v1/memberships/${target}/roles?role=UNION_ADMIN&note=${QUERY_SECRET}`)
        .set('authorization', `Bearer ${token}`)
        .set('cookie', `session=${COOKIE_SECRET}`)
        .set('x-correlation-id', correlationId)
        .send(rolesBody());

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        code: ERROR_CODES.INSUFFICIENT_ROLE,
        message: 'You do not have permission to perform this action',
        correlationId,
      });
      // As for every route, the platform's error body echoes the caller's own
      // path back to them, unchanged; the body is never echoed.
      expect(JSON.stringify(response.body)).not.toContain(BODY_SECRET);

      const rows = await rowsFor(refused.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        organizationId: refused.organizationId,
        actorType: 'USER',
        actorId: refused.userId,
        actorRoles: ['AUDITOR'],
        action: 'identity.memberships.roles.replace',
        resourceType: 'Membership',
        // The verified caller — never the membership the path names.
        resourceId: refused.userId,
        errorCode: 'INSUFFICIENT_ROLE',
        reason: ROLES.reason,
        correlationId,
        occurrenceCount: 1,
        publishedAt: null,
        claimCount: 0,
      });
      expect(rows[0]!.resourceId).not.toBe(target);

      const everything = await rawRow(rows[0]!.id);
      for (const leaked of [
        ...REQUIRED_ROLES,
        'SYSTEM_ADMIN',
        PATH_SECRET,
        target,
        BODY_SECRET,
        QUERY_SECRET,
        COOKIE_SECRET,
        token,
        '/v1/memberships',
        '/roles',
        ':id',
        'role=',
        'You do not have permission',
        'required',
      ]) {
        expect(everything).not.toContain(leaked);
      }
    });

    it('answers with exactly the established platform refusal', async () => {
      const refused = caller();
      expectPlatformRefusal(await replaceRoles(refused));
      expect((await rowsFor(refused.userId)).map((row) => row.action)).toEqual([ROLES.action]);
    });

    it('aggregates by the caller across different membership ids and bodies in one window, and opens a new row in the next', async () => {
      const refused = caller();
      await atFreshWindow(prisma, WINDOW_SECONDS, 1_500);

      for (let i = 0; i < 3; i += 1) {
        // A different membership and body every time: neither is aggregation-key material.
        const response = await replaceRoles(refused, {
          target: `MBR-${PATH_SECRET}-${i}`,
          body: rolesBody(`${BODY_SECRET}-${i}`),
        });
        expect(response.status).toBe(403);
        expect(response.body.code).toBe(ERROR_CODES.INSUFFICIENT_ROLE);
      }

      const [first, ...others] = await rowsFor(refused.userId);
      expect(others).toHaveLength(0);
      expect(first).toMatchObject({
        occurrenceCount: 3,
        action: ROLES.action,
        resourceId: refused.userId,
      });
      expect(aggregationWindowOf(first!.occurredAt, WINDOW_SECONDS)).toEqual({
        startedAt: first!.windowStartedAt,
        endsAt: first!.windowEndsAt,
      });

      await waitForWindowClose(prisma, first!.id);
      expect((await replaceRoles(refused)).status).toBe(403);

      const rows = await rowsFor(refused.userId);
      expect(rows.map((row) => row.occurrenceCount)).toEqual([3, 1]);
      expect(rows.map((row) => row.action)).toEqual([ROLES.action, ROLES.action]);
      expect(rows[1]!.windowStartedAt.getTime()).toBeGreaterThanOrEqual(
        rows[0]!.windowEndsAt.getTime(),
      );
    });

    it('lets the shared guard allow ORGANIZATION_ADMIN, UNION_ADMIN and SYSTEM_ADMIN, and captures nothing for them', async () => {
      for (const roles of [['ORGANIZATION_ADMIN'], ['UNION_ADMIN'], ['SYSTEM_ADMIN']]) {
        const allowed = caller(roles);
        // An invalid body: the guard lets the request through to validation,
        // which answers 400 — so no membership is read or changed and nothing is refused.
        const response = await replaceRoles(allowed, { body: {} });
        expect(response.status).toBe(400);
        expect(response.body.code).not.toBe(ERROR_CODES.INSUFFICIENT_ROLE);
        expect(await rowsFor(allowed.userId)).toHaveLength(0);
      }
    });
  });

  describe('POST /v1/memberships/:id/revoke (Phase C7)', () => {
    it('captures a real INSUFFICIENT_ROLE refusal attributed to the verified caller, with nothing from the path, body reason, role policy, token, cookie or error text', async () => {
      const refused = caller(['AUDITOR']);
      const token = userToken(refused);
      const correlationId = tagged('COR');
      const target = `MBR-${PATH_SECRET}`;

      const response = await request(harness.app.getHttpServer())
        .post(`/v1/memberships/${target}/revoke?role=UNION_ADMIN&note=${QUERY_SECRET}`)
        .set('authorization', `Bearer ${token}`)
        .set('cookie', `session=${COOKIE_SECRET}`)
        .set('x-correlation-id', correlationId)
        .send(revokeBody());

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        code: ERROR_CODES.INSUFFICIENT_ROLE,
        message: 'You do not have permission to perform this action',
        correlationId,
      });
      // As for every route, the platform's error body echoes the caller's own
      // path back to them, unchanged; the body is never echoed.
      expect(JSON.stringify(response.body)).not.toContain(BODY_SECRET);

      const rows = await rowsFor(refused.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        organizationId: refused.organizationId,
        actorType: 'USER',
        actorId: refused.userId,
        actorRoles: ['AUDITOR'],
        action: 'identity.memberships.revoke',
        resourceType: 'Membership',
        // The verified caller — never the membership the path names.
        resourceId: refused.userId,
        errorCode: 'INSUFFICIENT_ROLE',
        reason: REVOKE.reason,
        correlationId,
        occurrenceCount: 1,
        publishedAt: null,
        claimCount: 0,
      });
      expect(rows[0]!.resourceId).not.toBe(target);

      const everything = await rawRow(rows[0]!.id);
      for (const leaked of [
        ...REQUIRED_ROLES,
        'SYSTEM_ADMIN',
        PATH_SECRET,
        target,
        BODY_SECRET,
        QUERY_SECRET,
        COOKIE_SECRET,
        token,
        '/v1/memberships',
        '/revoke',
        ':id',
        'role=',
        'You do not have permission',
        'required',
      ]) {
        expect(everything).not.toContain(leaked);
      }
    });

    it('answers with exactly the established platform refusal', async () => {
      const refused = caller();
      expectPlatformRefusal(await revokeMembership(refused));
      expect((await rowsFor(refused.userId)).map((row) => row.action)).toEqual([REVOKE.action]);
    });

    it('aggregates by the caller across different membership ids and body reasons in one window, and opens a new row in the next', async () => {
      const refused = caller();
      await atFreshWindow(prisma, WINDOW_SECONDS, 1_500);

      for (let i = 0; i < 3; i += 1) {
        // A different membership and reason every time: neither is aggregation-key material.
        const response = await revokeMembership(refused, {
          target: `MBR-${PATH_SECRET}-${i}`,
          body: revokeBody(`${BODY_SECRET}-${i}`),
        });
        expect(response.status).toBe(403);
        expect(response.body.code).toBe(ERROR_CODES.INSUFFICIENT_ROLE);
      }

      const [first, ...others] = await rowsFor(refused.userId);
      expect(others).toHaveLength(0);
      expect(first).toMatchObject({
        occurrenceCount: 3,
        action: REVOKE.action,
        resourceId: refused.userId,
      });
      expect(aggregationWindowOf(first!.occurredAt, WINDOW_SECONDS)).toEqual({
        startedAt: first!.windowStartedAt,
        endsAt: first!.windowEndsAt,
      });

      await waitForWindowClose(prisma, first!.id);
      expect((await revokeMembership(refused)).status).toBe(403);

      const rows = await rowsFor(refused.userId);
      expect(rows.map((row) => row.occurrenceCount)).toEqual([3, 1]);
      expect(rows.map((row) => row.action)).toEqual([REVOKE.action, REVOKE.action]);
      expect(rows[1]!.windowStartedAt.getTime()).toBeGreaterThanOrEqual(
        rows[0]!.windowEndsAt.getTime(),
      );
    });

    it('lets the shared guard allow ORGANIZATION_ADMIN, UNION_ADMIN and SYSTEM_ADMIN, and captures nothing for them', async () => {
      for (const roles of [['ORGANIZATION_ADMIN'], ['UNION_ADMIN'], ['SYSTEM_ADMIN']]) {
        const allowed = caller(roles);
        // An invalid body: the guard lets the request through to validation,
        // which answers 400 — so no membership is read or revoked and nothing is refused.
        const response = await revokeMembership(allowed, { body: {} });
        expect(response.status).toBe(400);
        expect(response.body.code).not.toBe(ERROR_CODES.INSUFFICIENT_ROLE);
        expect(await rowsFor(allowed.userId)).toHaveLength(0);
      }
    });
  });

  describe('POST /v1/registration-requests/:id/approve (Phase C8)', () => {
    it('captures a real INSUFFICIENT_ROLE refusal attributed to the verified caller, with nothing from the path, approval body, role policy, token, cookie or error text', async () => {
      const refused = caller(['AUDITOR']);
      const token = userToken(refused);
      const correlationId = tagged('COR');
      const target = `REG-${PATH_SECRET}`;

      const response = await request(harness.app.getHttpServer())
        .post(`/v1/registration-requests/${target}/approve?role=UNION_ADMIN&note=${QUERY_SECRET}`)
        .set('authorization', `Bearer ${token}`)
        .set('cookie', `session=${COOKIE_SECRET}`)
        .set('x-correlation-id', correlationId)
        .send(approveBody());

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        code: ERROR_CODES.INSUFFICIENT_ROLE,
        message: 'You do not have permission to perform this action',
        correlationId,
      });
      // As for every route, the platform's error body echoes the caller's own
      // path back to them, unchanged; the body is never echoed.
      expect(JSON.stringify(response.body)).not.toContain(BODY_SECRET);

      const rows = await rowsFor(refused.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        organizationId: refused.organizationId,
        actorType: 'USER',
        actorId: refused.userId,
        actorRoles: ['AUDITOR'],
        action: 'identity.registration_requests.approve',
        resourceType: 'RegistrationRequest',
        // The verified caller — never the registration request the path names.
        resourceId: refused.userId,
        errorCode: 'INSUFFICIENT_ROLE',
        reason: APPROVE.reason,
        correlationId,
        occurrenceCount: 1,
        publishedAt: null,
        claimCount: 0,
      });
      expect(rows[0]!.resourceId).not.toBe(target);

      const everything = await rawRow(rows[0]!.id);
      for (const leaked of [
        ...REQUIRED_ROLES,
        APPROVE_REQUIRED_ROLE,
        'SYSTEM_ADMIN',
        PATH_SECRET,
        target,
        BODY_SECRET,
        'ORG-BODY-',
        QUERY_SECRET,
        COOKIE_SECRET,
        token,
        '/v1/registration-requests',
        '/approve',
        ':id',
        'role=',
        'You do not have permission',
        'required',
      ]) {
        expect(everything).not.toContain(leaked);
      }
    });

    it('answers with exactly the established platform refusal', async () => {
      const refused = caller();
      expectPlatformRefusal(await approveRegistration(refused));
      expect((await rowsFor(refused.userId)).map((row) => row.action)).toEqual([APPROVE.action]);
    });

    it('aggregates by the caller across different request ids and body secrets in one window, and opens a new row in the next', async () => {
      const refused = caller();
      await atFreshWindow(prisma, WINDOW_SECONDS, 1_500);

      for (let i = 0; i < 3; i += 1) {
        // A different registration request and body every time: neither is
        // aggregation-key material.
        const response = await approveRegistration(refused, {
          target: `REG-${PATH_SECRET}-${i}`,
          body: approveBody(`${BODY_SECRET}-${i}`),
        });
        expect(response.status).toBe(403);
        expect(response.body.code).toBe(ERROR_CODES.INSUFFICIENT_ROLE);
      }

      const [first, ...others] = await rowsFor(refused.userId);
      expect(others).toHaveLength(0);
      expect(first).toMatchObject({
        occurrenceCount: 3,
        action: APPROVE.action,
        resourceId: refused.userId,
      });
      expect(aggregationWindowOf(first!.occurredAt, WINDOW_SECONDS)).toEqual({
        startedAt: first!.windowStartedAt,
        endsAt: first!.windowEndsAt,
      });

      await waitForWindowClose(prisma, first!.id);
      expect((await approveRegistration(refused)).status).toBe(403);

      const rows = await rowsFor(refused.userId);
      expect(rows.map((row) => row.occurrenceCount)).toEqual([3, 1]);
      expect(rows.map((row) => row.action)).toEqual([APPROVE.action, APPROVE.action]);
      expect(rows[1]!.windowStartedAt.getTime()).toBeGreaterThanOrEqual(
        rows[0]!.windowEndsAt.getTime(),
      );
    });

    it('lets the shared guard allow UNION_ADMIN and SYSTEM_ADMIN, and captures nothing for them', async () => {
      for (const roles of [['UNION_ADMIN'], ['SYSTEM_ADMIN']]) {
        const allowed = caller(roles);

        // An invalid body: the guard lets the request through to validation,
        // which rejects `roles: []` against `min(1)` — so nothing is approved.
        const invalid = await approveRegistration(allowed, { body: { roles: [] } });
        expect(invalid.status).toBe(400);
        expect(invalid.body.code).not.toBe(ERROR_CODES.INSUFFICIENT_ROLE);

        // An empty body is *valid* here (`roles` is optional), so this one gets
        // past the guard and past validation and reaches the domain, which
        // answers 404 for a registration request that was never created. That
        // is the stronger demonstration: the allowed caller was stopped by
        // nothing this slice added.
        const notFound = await approveRegistration(allowed, { body: {} });
        expect(notFound.status).toBe(404);
        expect(notFound.body.code).not.toBe(ERROR_CODES.INSUFFICIENT_ROLE);

        expect(await rowsFor(allowed.userId)).toHaveLength(0);
      }
    });

    it('refuses and captures ORGANIZATION_ADMIN, which every other roles-guard site allows', async () => {
      // This endpoint requires UNION_ADMIN alone. The shared guard makes that
      // call; the site only has to follow it exactly.
      const refused = caller(['ORGANIZATION_ADMIN']);
      const response = await approveRegistration(refused);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe(ERROR_CODES.INSUFFICIENT_ROLE);

      const rows = await rowsFor(refused.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: APPROVE.action,
        resourceType: APPROVE.resourceType,
        resourceId: refused.userId,
        // The caller's own role from the token, not the role the endpoint wants.
        actorRoles: ['ORGANIZATION_ADMIN'],
      });

      // The same caller is allowed by the shared guard on an earlier site.
      const allowedElsewhere = await listUsers(refused);
      expect(allowedElsewhere.status).toBe(200);
      expect((await rowsFor(refused.userId)).map((row) => row.action)).toEqual([APPROVE.action]);
    });
  });

  describe('POST /v1/registration-requests/:id/reject (Phase C9)', () => {
    it('captures a real INSUFFICIENT_ROLE refusal attributed to the verified caller, with nothing from the path, rejection reason, role policy, token, cookie or error text', async () => {
      const refused = caller(['AUDITOR']);
      const token = userToken(refused);
      const correlationId = tagged('COR');
      const target = `REG-${PATH_SECRET}`;

      const response = await request(harness.app.getHttpServer())
        .post(`/v1/registration-requests/${target}/reject?role=UNION_ADMIN&note=${QUERY_SECRET}`)
        .set('authorization', `Bearer ${token}`)
        .set('cookie', `session=${COOKIE_SECRET}`)
        .set('x-correlation-id', correlationId)
        .send(rejectBody());

      expectPlatformRefusal(response, correlationId);
      // As for every route, the platform's error body echoes the caller's own
      // path back to them, unchanged; the body is never echoed.
      expect(JSON.stringify(response.body)).not.toContain(BODY_SECRET);

      const rows = await rowsFor(refused.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        organizationId: refused.organizationId,
        actorType: 'USER',
        actorId: refused.userId,
        actorRoles: ['AUDITOR'],
        action: 'identity.registration_requests.reject',
        resourceType: 'RegistrationRequest',
        // The verified caller — never the registration request the path names.
        resourceId: refused.userId,
        errorCode: 'INSUFFICIENT_ROLE',
        reason: REJECT.reason,
        correlationId,
        occurrenceCount: 1,
        publishedAt: null,
        claimCount: 0,
      });
      expect(rows[0]!.resourceId).not.toBe(target);

      const everything = await rawRow(rows[0]!.id);
      for (const leaked of [
        ...REQUIRED_ROLES,
        APPROVE_REQUIRED_ROLE,
        'SYSTEM_ADMIN',
        PATH_SECRET,
        target,
        BODY_SECRET,
        'reject-reason',
        QUERY_SECRET,
        COOKIE_SECRET,
        token,
        '/v1/registration-requests',
        '/reject',
        ':id',
        'role=',
        'You do not have permission',
        'required',
      ]) {
        expect(everything).not.toContain(leaked);
      }
    });

    it('answers with exactly the established platform refusal', async () => {
      const refused = caller();
      expectPlatformRefusal(await rejectRegistration(refused));
      expect((await rowsFor(refused.userId)).map((row) => row.action)).toEqual([REJECT.action]);
    });

    it('aggregates by the caller across different request ids and reason secrets in one window, and opens a new row in the next', async () => {
      const refused = caller();
      await atFreshWindow(prisma, WINDOW_SECONDS, 1_500);

      for (let i = 0; i < 3; i += 1) {
        // A different registration request and reason every time: neither is
        // aggregation-key material.
        const response = await rejectRegistration(refused, {
          target: `REG-${PATH_SECRET}-${i}`,
          body: rejectBody(`${BODY_SECRET}-${i}`),
        });
        expect(response.status).toBe(403);
        expect(response.body.code).toBe(ERROR_CODES.INSUFFICIENT_ROLE);
      }

      const [first, ...others] = await rowsFor(refused.userId);
      expect(others).toHaveLength(0);
      expect(first).toMatchObject({
        occurrenceCount: 3,
        action: REJECT.action,
        resourceId: refused.userId,
      });
      expect(aggregationWindowOf(first!.occurredAt, WINDOW_SECONDS)).toEqual({
        startedAt: first!.windowStartedAt,
        endsAt: first!.windowEndsAt,
      });

      await waitForWindowClose(prisma, first!.id);
      expect((await rejectRegistration(refused)).status).toBe(403);

      const rows = await rowsFor(refused.userId);
      expect(rows.map((row) => row.occurrenceCount)).toEqual([3, 1]);
      expect(rows.map((row) => row.action)).toEqual([REJECT.action, REJECT.action]);
      expect(rows[1]!.windowStartedAt.getTime()).toBeGreaterThanOrEqual(
        rows[0]!.windowEndsAt.getTime(),
      );
    });

    it('lets the shared guard allow UNION_ADMIN and SYSTEM_ADMIN through to validation and the domain, and captures nothing for them', async () => {
      for (const roles of [['UNION_ADMIN'], ['SYSTEM_ADMIN']]) {
        const allowed = caller(roles);

        // No reason: the required, at-least-ten-character reason fails
        // validation — so nothing is rejected.
        const invalid = await rejectRegistration(allowed, { body: {} });
        expect(invalid.status).toBe(400);
        expect(invalid.body.code).not.toBe(ERROR_CODES.INSUFFICIENT_ROLE);

        // A valid reason passes the guard and validation and reaches the
        // domain, which answers 404 for a registration request that was never
        // created.
        const notFound = await rejectRegistration(allowed, {
          body: { reason: 'A reason long enough to pass validation' },
        });
        expect(notFound.status).toBe(404);
        expect(notFound.body.code).not.toBe(ERROR_CODES.INSUFFICIENT_ROLE);

        expect(await rowsFor(allowed.userId)).toHaveLength(0);
      }
    });

    it('refuses and captures ORGANIZATION_ADMIN, as it does on the approval', async () => {
      const refused = caller(['ORGANIZATION_ADMIN']);
      const response = await rejectRegistration(refused);
      expectPlatformRefusal(response);

      const rows = await rowsFor(refused.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: REJECT.action,
        resourceType: REJECT.resourceType,
        resourceId: refused.userId,
        // The caller's own role from the token, not the role the endpoint wants.
        actorRoles: ['ORGANIZATION_ADMIN'],
      });
    });

    it('never merges an approval refusal and a rejection refusal by the same caller in the same window', async () => {
      const refused = caller(['ORGANIZATION_ADMIN']);
      await atFreshWindow(prisma, WINDOW_SECONDS, 1_500);

      for (let i = 0; i < 2; i += 1) {
        const approving = await approveRegistration(refused, { target: `REG-${PATH_SECRET}-${i}` });
        expect(approving.status).toBe(403);
      }
      for (let i = 0; i < 3; i += 1) {
        const rejecting = await rejectRegistration(refused, { target: `REG-${PATH_SECRET}-${i}` });
        expect(rejecting.status).toBe(403);
      }

      const rows = await rowsFor(refused.userId);
      expect(rows.map((row) => `${row.action} ${row.occurrenceCount}`).sort()).toEqual(
        [`${APPROVE.action} 2`, `${REJECT.action} 3`].sort(),
      );
      // One window, one tenant, one actor, one resource id: only the action differs.
      expect(new Set(rows.map((row) => row.windowStartedAt.getTime())).size).toBe(1);
      for (const row of rows) {
        expect(row).toMatchObject({
          organizationId: refused.organizationId,
          resourceType: 'RegistrationRequest',
          resourceId: refused.userId,
          errorCode: 'INSUFFICIENT_ROLE',
        });
      }
    });
  });

  it('tenant isolation: never merges refusals across tenants or actors, nor across the eight sites', async () => {
    const home = tagged('ORG');
    const second = tagged('ORG');
    const person: Caller = {
      userId: tagged('USR'),
      organizationId: home,
      organizationIds: [home, second],
      roles: ['FLEET_MANAGER'],
    };
    const colleague: Caller = {
      userId: tagged('USR'),
      organizationId: home,
      roles: ['FLEET_MANAGER'],
    };
    await atFreshWindow(prisma, WINDOW_SECONDS, 1_500);

    for (let i = 0; i < 2; i += 1) {
      expect((await addMembership(person, { target: `USR-${PATH_SECRET}-${i}` })).status).toBe(403);
      expect(
        (await addMembership(person, { headers: { 'x-organization-id': second } })).status,
      ).toBe(403);
      expect((await addMembership(colleague)).status).toBe(403);
      expect((await replaceRoles(person, { target: `MBR-${PATH_SECRET}-${i}` })).status).toBe(403);
      expect(
        (await replaceRoles(person, { headers: { 'x-organization-id': second } })).status,
      ).toBe(403);
      expect((await replaceRoles(colleague)).status).toBe(403);
      expect((await revokeMembership(person, { target: `MBR-${PATH_SECRET}-${i}` })).status).toBe(
        403,
      );
      expect(
        (await revokeMembership(person, { headers: { 'x-organization-id': second } })).status,
      ).toBe(403);
      expect((await revokeMembership(colleague)).status).toBe(403);
      expect(
        (await approveRegistration(person, { target: `REG-${PATH_SECRET}-${i}` })).status,
      ).toBe(403);
      expect(
        (await approveRegistration(person, { headers: { 'x-organization-id': second } })).status,
      ).toBe(403);
      expect((await approveRegistration(colleague)).status).toBe(403);
      expect((await rejectRegistration(person, { target: `REG-${PATH_SECRET}-${i}` })).status).toBe(
        403,
      );
      expect(
        (await rejectRegistration(person, { headers: { 'x-organization-id': second } })).status,
      ).toBe(403);
      expect((await rejectRegistration(colleague)).status).toBe(403);
    }
    // The same person refused by all three other sites in the same window.
    expect((await listUsers(person)).status).toBe(403);
    expect((await createUser(person)).status).toBe(403);
    const switchRefusal = await request(harness.app.getHttpServer())
      .post('/v1/users/me/active-organization')
      .set('authorization', `Bearer ${userToken(person)}`)
      .send({ organizationId: `ORG-REQ-${TAG}` });
    expect(switchRefusal.status).toBe(403);

    // Totalled per (action, tenant), not per row: with seven sites this burst
    // may cross a window boundary, which splits one identity's refusals over two
    // rows. That is the *aggregation* property, proved per site above and on
    // either side of a boundary in `security-event-aggregation.int-spec.ts`.
    // What this test owns is the *isolation* property: what must never be
    // merged, never is — so the identity, not the window, is what it counts by.
    const totals = (
      rows: { action: string; organizationId: string | null; occurrenceCount: number }[],
    ) => {
      const summed = new Map<string, number>();
      for (const row of rows) {
        const identity = `${row.action} ${row.organizationId}`;
        summed.set(identity, (summed.get(identity) ?? 0) + row.occurrenceCount);
      }
      return [...summed].map(([identity, count]) => `${identity} ${count}`).sort();
    };

    const personRows = await rowsFor(person.userId);
    expect(totals(personRows)).toEqual(
      [
        `identity.active_organization.switch ${home} 1`,
        `identity.users.list ${home} 1`,
        `identity.users.create ${home} 1`,
        `identity.memberships.create ${home} 2`,
        `identity.memberships.create ${second} 2`,
        `identity.memberships.roles.replace ${home} 2`,
        `identity.memberships.roles.replace ${second} 2`,
        `identity.memberships.revoke ${home} 2`,
        `identity.memberships.revoke ${second} 2`,
        `identity.registration_requests.approve ${home} 2`,
        `identity.registration_requests.approve ${second} 2`,
        `identity.registration_requests.reject ${home} 2`,
        `identity.registration_requests.reject ${second} 2`,
      ].sort(),
    );
    // No row of the person's is ever filed under the colleague, or vice versa.
    expect(personRows.every((row) => row.actorId === person.userId)).toBe(true);
    expect(totals(await rowsFor(colleague.userId))).toEqual(
      [
        `${MEMBERSHIP.action} ${home} 2`,
        `${ROLES.action} ${home} 2`,
        `${REVOKE.action} ${home} 2`,
        `${APPROVE.action} ${home} 2`,
        `${REJECT.action} ${home} 2`,
      ].sort(),
    );
    // A tenant-scoped read sees only its own tenant's rows.
    const secondTenantRows = await prisma.client.securityEventOutbox.findMany({
      where: { organizationId: second, actorId: { in: [person.userId, colleague.userId] } },
    });
    expect(
      [...new Set(secondTenantRows.map((row) => `${row.actorId} ${row.action}`))].sort(),
    ).toEqual(
      [
        `${person.userId} ${MEMBERSHIP.action}`,
        `${person.userId} ${ROLES.action}`,
        `${person.userId} ${REVOKE.action}`,
        `${person.userId} ${APPROVE.action}`,
        `${person.userId} ${REJECT.action}`,
      ].sort(),
    );
  });

  it('captures nothing for a near miss of an instrumented template, and files the auth guard’s refusal under its own site', async () => {
    const refused = caller();
    // Every `@Roles` route in identity-service is a site since Phase C9, so the
    // negative control is no longer "another role-guarded route" but everything
    // that is not exactly a site: a method or a template no route serves...
    for (const [method, path] of [
      ['get', `/v1/registration-requests/REG-${PATH_SECRET}/reject`],
      ['put', `/v1/registration-requests/REG-${PATH_SECRET}/approve`],
      ['patch', `/v1/memberships/MBR-${PATH_SECRET}/revoke`],
      ['post', `/v1/registration-requests/REG-${PATH_SECRET}/reject/extra`],
      ['post', `/v1/users/USR-${PATH_SECRET}/memberships/extra`],
    ] as const) {
      const response = await request(harness.app.getHttpServer())
        [method](path)
        .set('authorization', `Bearer ${userToken(refused)}`)
        .send({ reason: `${BODY_SECRET}-near-miss` });
      expect(response.status).toBe(404);
    }

    expect(await rowsFor(refused.userId)).toHaveLength(0);

    // ...and the auth guard's own TENANT_MISMATCH on an instrumented route.
    // It is refused before any role decision, so it is never the role site: a
    // separate caller sends it, and their single row carries the auth guard's
    // action, not this route's (Phase C10).
    const probing = caller();
    const guarded = await rejectRegistration(probing, {
      headers: { 'x-organization-id': tagged('ORG') },
    });
    expect(guarded.status).toBe(403);
    expect(guarded.body.code).toBe(ERROR_CODES.TENANT_MISMATCH);

    const guardRows = await rowsFor(probing.userId);
    expect(guardRows).toHaveLength(1);
    expect(guardRows[0]).toMatchObject({
      action: REFUSAL_SITES.AUTH_TENANT_MISMATCH.action,
      errorCode: 'TENANT_MISMATCH',
      resourceId: probing.userId,
    });
    expect(guardRows[0]!.action).not.toBe(REJECT.action);
  });

  it.each<[string, RefusalSite, (refused: Caller) => request.Test]>([
    ['GET /v1/users', LIST, (refused) => listUsers(refused)],
    ['POST /v1/users', CREATE, (refused) => createUser(refused)],
    ['POST /v1/users/:id/memberships', MEMBERSHIP, (refused) => addMembership(refused)],
    ['POST /v1/memberships/:id/roles', ROLES, (refused) => replaceRoles(refused)],
    ['POST /v1/memberships/:id/revoke', REVOKE, (refused) => revokeMembership(refused)],
    [
      'POST /v1/registration-requests/:id/approve',
      APPROVE,
      (refused) => approveRegistration(refused),
    ],
    ['POST /v1/registration-requests/:id/reject', REJECT, (refused) => rejectRegistration(refused)],
  ])(
    '%s becomes claimable only once its window closes, as one contract-valid event with the aggregated count',
    async (_label, site, refuse) => {
      const refused = caller();
      await atFreshWindow(prisma, WINDOW_SECONDS, 1_500);
      for (let i = 0; i < 2; i += 1) expect((await refuse(refused)).status).toBe(403);
      const [row] = await rowsFor(refused.userId);

      const claimOnly = async (owner: string) => {
        const claim = await harness.store.claimPending({ limit: 1000, owner, leaseSeconds: 60 });
        const mine = claim.rows.filter((candidate) => candidate.id === row!.id);
        const others = claim.rows.filter((candidate) => candidate.id !== row!.id);
        if (claim.token && others.length > 0) {
          await harness.store.release(
            others.map((candidate) => candidate.id),
            claim.token,
          );
        }
        return { token: claim.token, mine };
      };

      expect((await claimOnly('itest-open')).mine).toHaveLength(0);
      await waitForWindowClose(prisma, row!.id);
      const closed = await claimOnly('itest-closed');
      expect(closed.mine).toHaveLength(1);

      const published = closed.mine[0]!;
      expect(published.topic).toBe(AUDIT_TRAIL_TOPIC);
      const envelope = parseEnvelope(published.payload, auditTrailPayloadSchemaV1);
      expect(envelope.eventId).toBe(row!.id);
      expect(envelope.tenantId).toBe(refused.organizationId);
      expect(envelope.payload).toMatchObject({
        action: site.action,
        resourceType: site.resourceType,
        resourceId: refused.userId,
        outcome: 'REFUSED',
        errorCode: 'INSUFFICIENT_ROLE',
        occurrenceCount: 2,
      });
      const wire = JSON.stringify(envelope);
      for (const leaked of [...REQUIRED_ROLES, BODY_SECRET, PATH_SECRET]) {
        expect(wire).not.toContain(leaked);
      }

      expect(await harness.store.markPublished([row!.id], closed.token!)).toBe(1);
    },
  );
});
