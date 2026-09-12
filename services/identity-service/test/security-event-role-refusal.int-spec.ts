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
 * The two roles-guard refusal sites — `GET /v1/users` (AUD-004 Phase C3) and
 * `POST /v1/users` (Phase C4), each refused by the roles guard with
 * `403 INSUFFICIENT_ROLE` — against a real PostgreSQL (ADR-053 § 4).
 *
 * Every refusal here is a real request through the real `AppModule`: the global
 * auth guard, then `IdentityRolesGuard` delegating to the platform
 * `RolesGuard`, then the refusal filter, then the Phase C2 aggregation upsert.
 * Nothing about either site bypasses any of them.
 *
 * `POST /v1/users/:id/memberships` stays uninstrumented, so it is the
 * comparison for "the response is unchanged" and one of the negative probes.
 *
 * A two-second aggregation window (configuration, not a bypass) lets the suite
 * watch a window close. Everything written carries `TAG`; cleanup removes
 * exactly that.
 */

const TAG = ulid().slice(-10);
const tagged = (prefix: string): string => `${prefix}_${TAG}_${ulid()}`;
const LIST = REFUSAL_SITES.LIST_USERS;
const CREATE = REFUSAL_SITES.CREATE_USER;
const WINDOW_SECONDS = 2;

const QUERY_SECRET = `query-secret-${TAG}`;
const COOKIE_SECRET = `cookie-secret-${TAG}`;
const BODY_SECRET = `body-secret-${TAG}`;
/** The endpoint's required roles: policy, never evidence. */
const REQUIRED_ROLES = ['ORGANIZATION_ADMIN', 'UNION_ADMIN'];

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

  /** An uninstrumented role refusal: same guard, same error, not an allowlisted template. */
  const addMembership = (caller: Caller) =>
    request(harness.app.getHttpServer())
      .post(`/v1/users/${tagged('USR')}/memberships`)
      .set('authorization', `Bearer ${userToken(caller)}`)
      .send({});

  const caller = (roles: string[] = ['FLEET_MANAGER']): Caller => ({
    userId: tagged('USR'),
    organizationId: tagged('ORG'),
    roles,
  });

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

    it('answers with the same response shape as an uninstrumented role refusal', async () => {
      const refused = caller();
      const listing = await listUsers(refused);
      const uninstrumented = await addMembership(refused);

      expect(listing.status).toBe(403);
      expect(uninstrumented.status).toBe(403);
      expect(Object.keys(listing.body).sort()).toEqual(Object.keys(uninstrumented.body).sort());
      expect(listing.body.code).toBe(uninstrumented.body.code);
      expect(listing.body.message).toBe(uninstrumented.body.message);
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

    it('answers with the same response shape as an uninstrumented role refusal', async () => {
      const refused = caller();
      const creating = await createUser(refused);
      const uninstrumented = await addMembership(refused);

      expect(creating.status).toBe(403);
      expect(uninstrumented.status).toBe(403);
      expect(Object.keys(creating.body).sort()).toEqual(Object.keys(uninstrumented.body).sort());
      expect(creating.body.code).toBe(uninstrumented.body.code);
      expect(creating.body.message).toBe(uninstrumented.body.message);
      // The uninstrumented refusal is still uncaptured; the instrumented one is.
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

  it('tenant isolation: never merges refusals across tenants or actors, nor across the three sites', async () => {
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
      expect((await createUser(person)).status).toBe(403);
      expect((await createUser(person, { headers: { 'x-organization-id': second } })).status).toBe(
        403,
      );
      expect((await createUser(colleague)).status).toBe(403);
    }
    // The same person refused by both other sites in the same window.
    expect((await listUsers(person)).status).toBe(403);
    const switchRefusal = await request(harness.app.getHttpServer())
      .post('/v1/users/me/active-organization')
      .set('authorization', `Bearer ${userToken(person)}`)
      .send({ organizationId: `ORG-REQ-${TAG}` });
    expect(switchRefusal.status).toBe(403);

    const personRows = await rowsFor(person.userId);
    expect(
      personRows.map((row) => `${row.action} ${row.organizationId} ${row.occurrenceCount}`).sort(),
    ).toEqual(
      [
        `identity.active_organization.switch ${home} 1`,
        `identity.users.list ${home} 1`,
        `identity.users.create ${home} 2`,
        `identity.users.create ${second} 2`,
      ].sort(),
    );
    expect(
      (await rowsFor(colleague.userId)).map((row) => [
        row.action,
        row.organizationId,
        row.occurrenceCount,
      ]),
    ).toEqual([[CREATE.action, home, 2]]);
    // A tenant-scoped read sees only its own tenant's rows.
    const secondTenantRows = await prisma.client.securityEventOutbox.findMany({
      where: { organizationId: second, actorId: { in: [person.userId, colleague.userId] } },
    });
    expect(secondTenantRows.map((row) => [row.actorId, row.action])).toEqual([
      [person.userId, CREATE.action],
    ]);
  });

  it('captures nothing for an INSUFFICIENT_ROLE from a role-guarded endpoint that is not allowlisted', async () => {
    const refused = caller();
    // Paths, not requests: supertest binds a listener per request and closes
    // it when that request ends, so each one is built only when it is sent.
    const paths = [
      `/v1/users/${tagged('USR')}/memberships`,
      `/v1/memberships/${tagged('MBR')}/roles`,
      `/v1/memberships/${tagged('MBR')}/revoke`,
    ];
    for (const path of paths) {
      const response = await request(harness.app.getHttpServer())
        .post(path)
        .set('authorization', `Bearer ${userToken(refused)}`)
        .send({});
      expect(response.status).toBe(403);
      expect(response.body.code).toBe(ERROR_CODES.INSUFFICIENT_ROLE);
    }
    expect(await rowsFor(refused.userId)).toHaveLength(0);
  });

  it.each<[string, RefusalSite, (refused: Caller) => request.Test]>([
    ['GET /v1/users', LIST, (refused) => listUsers(refused)],
    ['POST /v1/users', CREATE, (refused) => createUser(refused)],
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
        resourceType: 'User',
        resourceId: refused.userId,
        outcome: 'REFUSED',
        errorCode: 'INSUFFICIENT_ROLE',
        occurrenceCount: 2,
      });
      const wire = JSON.stringify(envelope);
      for (const leaked of [...REQUIRED_ROLES, BODY_SECRET]) expect(wire).not.toContain(leaked);

      expect(await harness.store.markPublished([row!.id], closed.token!)).toBe(1);
    },
  );
});
