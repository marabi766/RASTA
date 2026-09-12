import request from 'supertest';
import { ulid } from 'ulid';
import { ERROR_CODES } from '@rasta/contracts';
import { REFUSAL_SITES } from '../src/security-events/refusal-sites';
import type { PrismaService } from '../src/prisma/prisma.service';
import {
  serviceToken,
  startIdentityApi,
  userToken,
  type Caller,
  type IdentityApiHarness,
} from './api-helpers';
import { atFreshWindow, waitForWindowClose } from './helpers';

/**
 * The auth guard's own tenant refusal → `security_event_outbox`, against a real
 * PostgreSQL (ADR-053 § 4, AUD-004 Phase C10).
 *
 * Every refusal here is a real request through the real `AppModule`: the global
 * `AuthGuard` — the platform's, wired with this service's observation seam
 * exactly as `app.module.ts` wires it — verifies the token, refuses the
 * `X-Organization-Id` header, and the refusal filter captures what the guard
 * reported. Nothing here marks, attributes or captures anything a test
 * arranged: the guard decides, and the guard says who it decided against.
 *
 * ## Why this suite is not organised by route
 *
 * The other refusal suites are: each site is one method and one route
 * template. This refusal happens *before* controller authorization, on
 * whatever the request was aimed at, so the site is route-agnostic and the
 * invariant to prove is the opposite one — that the same caller probing
 * several different endpoints in one window produces **one** row, and that
 * the route plays no part in the record.
 *
 * A two-second aggregation window (configuration, not a bypass) lets the suite
 * watch a window close. Everything written carries `TAG`; cleanup removes
 * exactly that.
 */

const TAG = ulid().slice(-10);
const tagged = (prefix: string): string => `${prefix}_${TAG}_${ulid()}`;
const SITE = REFUSAL_SITES.AUTH_TENANT_MISMATCH;
const SWITCH_SITE = REFUSAL_SITES.SWITCH_ACTIVE_ORGANIZATION;
const WINDOW_SECONDS = 2;

const TRACEPARENT = '00-1af7651916cd43dd8448eb211c80319c-c7ad6b7169203331-01';
const USER_AGENT = 'Mozilla/5.0 (identity auth-guard itest)';
const QUERY_SECRET = `query-secret-${TAG}`;
const COOKIE_SECRET = `cookie-secret-${TAG}`;

/** The organization an attacker asks for. Never a membership, never evidence. */
const rejectedOrg = (): string => `ORG-REJECTED-${TAG}-${ulid()}`;

interface ProbeOptions {
  path?: string;
  method?: 'get' | 'post';
  correlationId?: string;
  query?: string;
  token?: string;
  headers?: Record<string, string>;
}

describe('auth-guard tenant refusals → security_event_outbox (real PostgreSQL)', () => {
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

  /** One request whose `X-Organization-Id` the verified token does not allow. */
  function probe(caller: Caller, requested: string, options: ProbeOptions = {}) {
    const call = request(harness.app.getHttpServer())
      [options.method ?? 'get'](`${options.path ?? '/v1/users/me'}${options.query ?? ''}`)
      .set('user-agent', USER_AGENT)
      .set('x-correlation-id', options.correlationId ?? tagged('COR'))
      .set('traceparent', TRACEPARENT)
      .set('x-organization-id', requested);
    call.set('authorization', `Bearer ${options.token ?? userToken(caller)}`);
    for (const [name, value] of Object.entries(options.headers ?? {})) call.set(name, value);
    return call;
  }

  const caller = (organizationId: string, extra: Partial<Caller> = {}): Caller => ({
    userId: tagged('USR'),
    organizationId,
    roles: ['FLEET_MANAGER'],
    ...extra,
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

  it('captures the refusal under the caller’s own active tenant, and answers the exact unchanged 403', async () => {
    const home = tagged('ORG');
    const second = tagged('ORG');
    const person = caller(home, { organizationIds: [home, second] });
    const requested = rejectedOrg();
    const correlationId = tagged('COR');
    const token = userToken(person);

    const response = await probe(person, requested, {
      token,
      correlationId,
      query: `?access_token=${QUERY_SECRET}`,
      headers: { cookie: `session=${COOKIE_SECRET}` },
    });

    // The refusal the platform has always given, unchanged by the marking:
    // only the platform's own fields, and the caller's own correlation id.
    expect(response.status).toBe(403);
    const { timestamp, ...body } = response.body as Record<string, unknown>;
    expect(typeof timestamp).toBe('string');
    expect(body).toEqual({
      code: ERROR_CODES.TENANT_MISMATCH,
      message: 'You are not a member of the requested organization',
      correlationId,
      // The caller's own trace, echoed as it is on every platform error.
      traceId: '1af7651916cd43dd8448eb211c80319c',
      path: `/v1/users/me?access_token=${QUERY_SECRET}`,
    });

    const rows = await rowsFor(person.userId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    expect(row).toMatchObject({
      // The tenant the caller legitimately acts for, never the requested one.
      organizationId: home,
      actorType: 'USER',
      actorId: person.userId,
      actorRoles: ['FLEET_MANAGER'],
      action: SITE.action,
      resourceType: SITE.resourceType,
      resourceId: person.userId,
      errorCode: 'TENANT_MISMATCH',
      reason: SITE.reason,
      sourceUserAgent: USER_AGENT,
      correlationId,
      traceparent: TRACEPARENT,
      occurrenceCount: 1,
      publishedAt: null,
    });

    // Nothing the caller controls, and nothing the token merely knows, reached
    // the table — checked against every column as PostgreSQL renders the row.
    const everything = await rawRow(row.id);
    for (const leaked of [
      requested,
      second,
      QUERY_SECRET,
      COOKIE_SECRET,
      token,
      'access_token',
      '/v1/users/me',
      'You are not a member',
    ]) {
      expect(everything).not.toContain(leaked);
    }
  });

  it('counts varied rejected organizations into one row per window, and opens a new row in the next', async () => {
    const home = tagged('ORG');
    const person = caller(home);
    await atFreshWindow(prisma, WINDOW_SECONDS, 1_500);

    const rejected = [rejectedOrg(), rejectedOrg(), rejectedOrg()];
    for (const requested of rejected) {
      expect((await probe(person, requested)).status).toBe(403);
    }

    let rows = await rowsFor(person.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrenceCount).toBe(3);

    // Which organization was asked for changes nothing about the identity of
    // the record: the actor and their own tenant do.
    const everything = await rawRow(rows[0]!.id);
    for (const requested of rejected) expect(everything).not.toContain(requested);

    await waitForWindowClose(prisma, rows[0]!.id);
    expect((await probe(person, rejectedOrg())).status).toBe(403);

    rows = await rowsFor(person.userId);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.occurrenceCount)).toEqual([3, 1]);
    expect(rows[1]!.windowStartedAt.getTime()).toBeGreaterThan(rows[0]!.windowStartedAt.getTime());
  });

  it('counts one caller’s probes of several different endpoints into one row (route-agnostic)', async () => {
    // The guard refuses before controller authorization, so the endpoint the
    // caller aimed at is not part of the refusal. Were the site pinned to a
    // route, three of these four would go unrecorded.
    const home = tagged('ORG');
    const person = caller(home);
    await atFreshWindow(prisma, WINDOW_SECONDS, 1_500);

    const paths: [ProbeOptions['method'], string][] = [
      ['get', '/v1/users/me'],
      // A roles-guarded route: the auth guard still decides first, so this is
      // a TENANT_MISMATCH rather than the INSUFFICIENT_ROLE of Phase C3.
      ['get', '/v1/users'],
      ['get', `/v1/users/${tagged('USR')}`],
      // Another method, another roles-guarded route, and a rate-limited
      // prefix: still the same one refusal.
      ['post', `/v1/registration-requests/${tagged('REG')}/reject`],
    ];
    for (const [method, path] of paths) {
      const response = await probe(person, rejectedOrg(), { method, path });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe(ERROR_CODES.TENANT_MISMATCH);
    }

    const rows = await rowsFor(person.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrenceCount).toBe(4);
    expect(rows[0]!.action).toBe(SITE.action);

    const everything = await rawRow(rows[0]!.id);
    for (const [, path] of paths) expect(everything).not.toContain(path);
  });

  it('tenant isolation: never merges two actors, nor one actor’s two active tenants', async () => {
    const orgA = tagged('ORG');
    const orgB = tagged('ORG');
    const person = caller(orgA);
    const colleague = caller(orgA);
    // The same human, with a token whose active organization is the other
    // tenant: a different tenant context, and so different evidence.
    const personInB: Caller = { ...person, organizationId: orgB };

    await atFreshWindow(prisma, WINDOW_SECONDS, 1_500);
    for (const who of [person, colleague, personInB]) {
      expect((await probe(who, rejectedOrg())).status).toBe(403);
    }

    const personRows = await rowsFor(person.userId);
    expect(personRows.map((row) => `${row.organizationId} ${row.occurrenceCount}`).sort()).toEqual(
      [`${orgA} 1`, `${orgB} 1`].sort(),
    );
    expect(personRows.every((row) => row.actorId === person.userId)).toBe(true);

    const colleagueRows = await rowsFor(colleague.userId);
    expect(colleagueRows).toHaveLength(1);
    expect(colleagueRows[0]!.organizationId).toBe(orgA);

    // A tenant-scoped read sees only its own tenant's rows.
    const inB = await prisma.client.securityEventOutbox.findMany({
      where: { organizationId: orgB, actorId: { in: [person.userId, colleague.userId] } },
    });
    expect(inB.map((row) => row.actorId)).toEqual([person.userId]);
  });

  it('keeps the domain’s own TENANT_MISMATCH a separate site in the same window', async () => {
    // Two decisions, the same error code, one caller, one window: the guard's
    // header refusal and `IdentityService`'s refused switch. Two rows, never
    // one, and neither wearing the other's action.
    const home = tagged('ORG');
    const person = caller(home);
    await atFreshWindow(prisma, WINDOW_SECONDS, 1_500);

    for (let i = 0; i < 2; i += 1) {
      expect((await probe(person, rejectedOrg())).status).toBe(403);

      const switchRefusal = await request(harness.app.getHttpServer())
        .post(SWITCH_SITE.route)
        .set('authorization', `Bearer ${userToken(person)}`)
        .set('x-correlation-id', tagged('COR'))
        .send({ organizationId: `ORG-REQ-${TAG}-${ulid()}` });
      expect(switchRefusal.status).toBe(403);
      expect(switchRefusal.body.code).toBe(ERROR_CODES.TENANT_MISMATCH);
    }

    const rows = await rowsFor(person.userId);
    expect(rows.map((row) => `${row.action} ${row.occurrenceCount}`).sort()).toEqual(
      [`${SITE.action} 2`, `${SWITCH_SITE.action} 2`].sort(),
    );
    for (const row of rows) {
      expect(row).toMatchObject({
        organizationId: home,
        actorId: person.userId,
        resourceId: person.userId,
        errorCode: 'TENANT_MISMATCH',
      });
    }
    expect(new Set(rows.map((row) => row.reason)).size).toBe(2);
  });

  it('captures nothing for an accepted selection, an unattributable refusal, a service caller or an anonymous request', async () => {
    const home = tagged('ORG');
    const second = tagged('ORG');

    // Accepted: the header names a real membership of the verified token, so
    // the guard resolves it and the request reaches the domain.
    const member = caller(home, { organizationIds: [home, second] });
    const accepted = await probe(member, second);
    expect(accepted.status).toBe(404);
    expect(accepted.body.code).toBe(ERROR_CODES.NOT_FOUND);

    // Refused, but unattributable: the verified token has no active
    // organization, so there is no trusted tenant to file the evidence under.
    // Fail closed — refused all the same, simply not recorded.
    const homeless: Caller = { userId: tagged('USR'), organizationIds: [tagged('ORG')] };
    const unattributable = await probe(homeless, rejectedOrg());
    expect(unattributable.status).toBe(403);
    expect(unattributable.body.code).toBe(ERROR_CODES.TENANT_MISMATCH);

    // A service caller. identity-service exposes no `@AllowService` endpoint,
    // so the guard refuses it with FORBIDDEN before any tenant check — a
    // different decision, and not this site. (The service tenant refusal
    // itself is proved in `@rasta/nest-common`'s own guard specs.)
    const serviceCorrelation = tagged('COR');
    const asService = await request(harness.app.getHttpServer())
      .get('/v1/users/me')
      .set('x-internal-token', await serviceToken('fleet-service', home))
      .set('x-correlation-id', serviceCorrelation)
      .set('x-organization-id', rejectedOrg());
    expect(asService.status).toBe(403);
    expect(asService.body.code).toBe(ERROR_CODES.FORBIDDEN);

    // No credentials at all: a 401 has no attributable actor.
    const anonymousCorrelation = tagged('COR');
    const anonymous = await request(harness.app.getHttpServer())
      .get('/v1/users/me')
      .set('x-correlation-id', anonymousCorrelation)
      .set('x-organization-id', rejectedOrg());
    expect(anonymous.status).toBe(401);

    for (const actor of [member, homeless]) {
      expect(await rowsFor(actor.userId)).toHaveLength(0);
    }
    expect(
      await prisma.client.securityEventOutbox.count({
        where: { correlationId: { in: [serviceCorrelation, anonymousCorrelation] } },
      }),
    ).toBe(0);
  });

  it('becomes claimable only once its window closes, carrying the aggregated count', async () => {
    const home = tagged('ORG');
    const person = caller(home);
    await atFreshWindow(prisma, WINDOW_SECONDS, 1_500);
    for (let i = 0; i < 2; i += 1) expect((await probe(person, rejectedOrg())).status).toBe(403);

    const [row] = await rowsFor(person.userId);
    expect(row!.occurrenceCount).toBe(2);

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
    expect(await harness.store.markPublished([row!.id], closed.token!)).toBe(1);
  });
});
