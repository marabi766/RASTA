import request from 'supertest';
import type { Server } from 'node:http';
import { PrismaService } from '../src/prisma/prisma.service';
import { cleanupRun, newMigratorPrisma, runtimeUrl } from './helpers';
import { startApi, systemAdmin, unionAdmin, type ApiHarness } from './api-helpers';
import { at, orgId, projectOrganization, queryWindow, seedAuditEvent } from './fixtures';

/**
 * The five tenant-isolation cases of `ADR-053-implementation-plan.md` § 6.4,
 * asserted on the **response body** and not only on the status code.
 *
 * A status assertion cannot see a leaked row. Every case below therefore reads
 * the organizations actually returned, because the failure this suite exists to
 * catch — `organization_id = $1 OR organization_id IS NULL` — answers `200` and
 * looks perfectly healthy from the outside.
 *
 * ## The asymmetry that is the whole design
 *
 * A union administrator's authority over their **own** organization comes from
 * the verified token. The hierarchy projection is consulted only to *extend*
 * that authority downwards, and it extends nothing it cannot prove. So a
 * projection that is empty, lagging, or wrong in any direction can produce a
 * **missing** row and never an extra one (ADR-053 § 10).
 */
describe('audit tenant isolation (real PostgreSQL)', () => {
  let api: ApiHarness;
  let migrator: PrismaService;
  let server: Server;

  /** Union A, with a child beneath it and a sibling union beside it. */
  const UNION_A = orgId('ISO-UNION-A');
  const CHILD_A = orgId('ISO-CHILD-A');
  const GRANDCHILD_A = orgId('ISO-GRAND-A');
  const UNION_B = orgId('ISO-UNION-B');
  const CHILD_B = orgId('ISO-CHILD-B');
  /** Seen only as the tenant of an audit event — no organization event yet. */
  const UNPROJECTED = orgId('ISO-UNPROJECTED');
  /** Projected under A, then moved out from under it. */
  const MOVED_OUT = orgId('ISO-MOVED-OUT');
  /** Projected under A, then deactivated. */
  const DEACTIVATED = orgId('ISO-DEACTIVATED');

  const window = queryWindow();

  /** The organizations a response actually carried. */
  const organizationsIn = (body: { items: { organizationId: string | null }[] }): unknown[] =>
    body.items.map((item) => item.organizationId);

  beforeAll(async () => {
    migrator = newMigratorPrisma();
    await migrator.onModuleInit();

    api = await startApi();
    server = api.app.getHttpServer() as Server;

    await projectOrganization(api.prisma, { organizationId: UNION_A, parentOrganizationId: null });
    await projectOrganization(api.prisma, {
      organizationId: CHILD_A,
      parentOrganizationId: UNION_A,
    });
    await projectOrganization(api.prisma, {
      organizationId: GRANDCHILD_A,
      parentOrganizationId: CHILD_A,
    });
    await projectOrganization(api.prisma, { organizationId: UNION_B, parentOrganizationId: null });
    await projectOrganization(api.prisma, {
      organizationId: CHILD_B,
      parentOrganizationId: UNION_B,
    });
    // The stale replica: an identifier this service has seen on an audit event
    // and holds no hierarchy for. A null parent must not read as "a root".
    await projectOrganization(api.prisma, {
      organizationId: UNPROJECTED,
      parentOrganizationId: null,
      relationState: 'UNKNOWN',
    });
    // Moved out from under A. Its parent is B now, so A no longer reaches it.
    await projectOrganization(api.prisma, {
      organizationId: MOVED_OUT,
      parentOrganizationId: UNION_B,
    });
    await projectOrganization(api.prisma, {
      organizationId: DEACTIVATED,
      parentOrganizationId: UNION_A,
      status: 'DEACTIVATED',
    });

    let minute = 0;
    for (const organizationId of [
      UNION_A,
      CHILD_A,
      GRANDCHILD_A,
      UNION_B,
      CHILD_B,
      UNPROJECTED,
      MOVED_OUT,
      DEACTIVATED,
      // The platform-scoped row. Only a SYSTEM_ADMIN may ever see it.
      null,
    ]) {
      minute += 1;
      await seedAuditEvent(api.prisma, { organizationId, occurredAt: at(minute) });
    }
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    await cleanupRun(migrator);
    await migrator.onModuleDestroy();
  }, 120_000);

  // -------------------------------------------------------------------------
  // 1. A union administrator asking for another union.
  // -------------------------------------------------------------------------

  it('refuses union A when it names union B', async () => {
    const response = await request(server)
      .get('/v1/audit-events')
      .query({ ...window, organizationId: UNION_B })
      .set('Authorization', `Bearer ${unionAdmin(UNION_A)}`);

    expect(response.status).toBe(403);
  });

  it('returns no row of union B when union A searches without naming anyone', async () => {
    const response = await request(server)
      .get('/v1/audit-events')
      .query({ ...window, limit: 200 })
      .set('Authorization', `Bearer ${unionAdmin(UNION_A)}`);

    expect(response.status).toBe(200);
    const organizations = organizationsIn(response.body);
    expect(organizations.length).toBeGreaterThan(0);
    expect(new Set(organizations)).toEqual(new Set([UNION_A]));
  });

  // -------------------------------------------------------------------------
  // 2. The negative control: a null-tenant row never reaches a tenant result.
  // -------------------------------------------------------------------------

  it('never returns a platform-scoped row to a tenant-scoped caller', async () => {
    // The specific mistake ADR-053 § 10 names. Asserted on the body, because a
    // service that made it would still answer 200.
    for (const target of [undefined, UNION_A, CHILD_A, GRANDCHILD_A]) {
      const response = await request(server)
        .get('/v1/audit-events')
        .query({ ...window, limit: 200, ...(target ? { organizationId: target } : {}) })
        .set('Authorization', `Bearer ${unionAdmin(UNION_A)}`);

      expect(response.status).toBe(200);
      expect(organizationsIn(response.body)).not.toContain(null);
    }
  });

  it('shows the platform-scoped row to a platform administrator', async () => {
    // The positive control for the case above: the row exists, so "no null in
    // the tenant result" is a filter working rather than a row missing.
    const response = await request(server)
      .get('/v1/audit-events')
      .query({ ...window, limit: 200 })
      .set('Authorization', `Bearer ${systemAdmin()}`);

    expect(response.status).toBe(200);
    expect(organizationsIn(response.body)).toContain(null);
  });

  it('excludes the platform-scoped row when a platform administrator names a tenant', async () => {
    // `organizationId` is exact for SYSTEM_ADMIN too — never "this tenant plus
    // the unscoped rows".
    const response = await request(server)
      .get('/v1/audit-events')
      .query({ ...window, limit: 200, organizationId: UNION_A })
      .set('Authorization', `Bearer ${systemAdmin()}`);

    expect(new Set(organizationsIn(response.body))).toEqual(new Set([UNION_A]));
  });

  // -------------------------------------------------------------------------
  // 3. The subtree includes children and excludes siblings.
  // -------------------------------------------------------------------------

  it('reaches a child and a grandchild, and refuses a sibling union', async () => {
    for (const target of [CHILD_A, GRANDCHILD_A]) {
      const allowed = await request(server)
        .get('/v1/audit-events')
        .query({ ...window, organizationId: target })
        .set('Authorization', `Bearer ${unionAdmin(UNION_A)}`);

      expect(allowed.status).toBe(200);
      expect(new Set(organizationsIn(allowed.body))).toEqual(new Set([target]));
    }

    for (const target of [UNION_B, CHILD_B]) {
      const refused = await request(server)
        .get('/v1/audit-events')
        .query({ ...window, organizationId: target })
        .set('Authorization', `Bearer ${unionAdmin(UNION_A)}`);

      expect(refused.status).toBe(403);
    }
  });

  it("refuses the sibling's child even though the walk passes through a root", async () => {
    // `CHILD_B`'s ancestry terminates at `UNION_B`, which is a root but not
    // *this* caller's root. An implementation that stopped at "reached a root"
    // rather than "reached my root" would allow this.
    const response = await request(server)
      .get('/v1/audit-events')
      .query({ ...window, organizationId: CHILD_B })
      .set('Authorization', `Bearer ${unionAdmin(UNION_A)}`);

    expect(response.status).toBe(403);
  });

  it('refuses an organization that has moved out from under the caller', async () => {
    const response = await request(server)
      .get('/v1/audit-events')
      .query({ ...window, organizationId: MOVED_OUT })
      .set('Authorization', `Bearer ${unionAdmin(UNION_A)}`);

    expect(response.status).toBe(403);
  });

  it('refuses a deactivated organization', async () => {
    // Deactivation is terminal upstream, so a deactivated organization is no
    // longer a tenant a union administrator holds authority over. `SUSPENDED`
    // deliberately still is — that is precisely when somebody needs the trail.
    const response = await request(server)
      .get('/v1/audit-events')
      .query({ ...window, organizationId: DEACTIVATED })
      .set('Authorization', `Bearer ${unionAdmin(UNION_A)}`);

    expect(response.status).toBe(403);
  });

  it('still reaches a suspended child', async () => {
    await projectOrganization(api.prisma, {
      organizationId: CHILD_A,
      parentOrganizationId: UNION_A,
      status: 'SUSPENDED',
    });

    const response = await request(server)
      .get('/v1/audit-events')
      .query({ ...window, organizationId: CHILD_A })
      .set('Authorization', `Bearer ${unionAdmin(UNION_A)}`);

    expect(response.status).toBe(200);

    await projectOrganization(api.prisma, {
      organizationId: CHILD_A,
      parentOrganizationId: UNION_A,
      status: 'ACTIVE',
    });
  });

  // -------------------------------------------------------------------------
  // 4. A stale projection produces a missing row, never an extra one.
  // -------------------------------------------------------------------------

  it('refuses an organization the projection knows only as an identifier', async () => {
    // `UNPROJECTED` has a null parent, exactly like a genuine root. Only
    // `relation_state` separates the two, and it is what keeps every unknown
    // organization from becoming the root of everything.
    const response = await request(server)
      .get('/v1/audit-events')
      .query({ ...window, organizationId: UNPROJECTED })
      .set('Authorization', `Bearer ${unionAdmin(UNION_A)}`);

    expect(response.status).toBe(403);
  });

  it('refuses an organization no row exists for at all', async () => {
    const response = await request(server)
      .get('/v1/audit-events')
      .query({ ...window, organizationId: orgId('ISO-ABSENT') })
      .set('Authorization', `Bearer ${unionAdmin(UNION_A)}`);

    expect(response.status).toBe(403);
  });

  it('still answers for the caller own organization when the projection is empty', async () => {
    // The other half of the asymmetry. A union administrator whose own
    // organization has no projection row keeps their own tenant, because the
    // token said so — degraded to less, never to more.
    const unprojectedUnion = orgId('ISO-NO-PROJECTION');
    await seedAuditEvent(api.prisma, { organizationId: unprojectedUnion, occurredAt: at(50) });

    const response = await request(server)
      .get('/v1/audit-events')
      .query(window)
      .set('Authorization', `Bearer ${unionAdmin(unprojectedUnion)}`);

    expect(response.status).toBe(200);
    expect(new Set(organizationsIn(response.body))).toEqual(new Set([unprojectedUnion]));
  });

  it('gives the same 404 for a record in another tenant as for one that does not exist', async () => {
    const foreign = await seedAuditEvent(api.prisma, {
      organizationId: UNION_B,
      occurredAt: at(60),
    });

    const crossTenant = await request(server)
      .get(`/v1/audit-events/${foreign.id}`)
      .query(window)
      .set('Authorization', `Bearer ${unionAdmin(UNION_A)}`);
    const unknown = await request(server)
      .get('/v1/audit-events/01JNOSUCHRECORD0000000000')
      .query(window)
      .set('Authorization', `Bearer ${unionAdmin(UNION_A)}`);

    expect(crossTenant.status).toBe(404);
    expect(unknown.status).toBe(404);
    // Indistinguishable, so the existence of the record is never disclosed.
    expect(crossTenant.body.code).toBe(unknown.body.code);
    expect(crossTenant.body.message).toBe(unknown.body.message);
  });

  it('gives a 404 for a record outside the supplied window', async () => {
    // The window is a filter, not a hint. A record found by ignoring it would
    // be the unbounded cross-partition scan the mandatory window exists to stop.
    const inside = await seedAuditEvent(api.prisma, {
      organizationId: UNION_A,
      occurredAt: at(70),
    });

    const response = await request(server)
      .get(`/v1/audit-events/${inside.id}`)
      .query({ from: '2026-11-01T00:00:00.000Z', to: '2026-11-30T00:00:00.000Z' })
      .set('Authorization', `Bearer ${unionAdmin(UNION_A)}`);

    expect(response.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // 5. The database boundary itself.
  // -------------------------------------------------------------------------

  it('cannot reach another service database with the audit runtime role', async () => {
    // A-01 in the layer that does not depend on any application code being
    // correct. `rasta_notification` has `REVOKE ALL ... FROM PUBLIC` and grants
    // only to its own role, so connecting with the audit credentials is refused
    // by PostgreSQL before a statement is parsed.
    const foreign = new URL(runtimeUrl());
    foreign.pathname = '/rasta_notification';
    foreign.searchParams.delete('schema');

    const client = new PrismaService(foreign.toString());
    let message = '';
    try {
      await client.client.$queryRaw`SELECT 1`;
      message = 'the query succeeded';
    } catch (error) {
      message = String((error as Error).message);
    } finally {
      await client.onModuleDestroy().catch(() => undefined);
    }

    expect(message).not.toBe('the query succeeded');
    // PostgreSQL says `permission denied for database`; Prisma reports the same
    // refusal as P1010, "User ... was denied access on the database". Matched on
    // the shared word rather than on one driver's phrasing, so this asserts the
    // refusal and not a message format.
    expect(message.toLowerCase()).toMatch(/denied|not permitted|no permission/);
  });

  // -------------------------------------------------------------------------
  // Paging cannot escape the scope either.
  // -------------------------------------------------------------------------

  it('keeps a cursor inside the caller scope', async () => {
    // A cursor is a value the client holds and can edit, so it carries a
    // position and no scope. One minted from a platform-wide page must not move
    // a union administrator outside their own tenant.
    const platformPage = await request(server)
      .get('/v1/audit-events')
      .query({ ...window, limit: 1 })
      .set('Authorization', `Bearer ${systemAdmin()}`);

    expect(platformPage.status).toBe(200);
    expect(platformPage.body.nextCursor).not.toBeNull();

    const scoped = await request(server)
      .get('/v1/audit-events')
      .query({ ...window, limit: 200, cursor: platformPage.body.nextCursor })
      .set('Authorization', `Bearer ${unionAdmin(UNION_A)}`);

    expect(scoped.status).toBe(200);
    expect(new Set(organizationsIn(scoped.body))).toEqual(new Set([UNION_A]));
  });

  it('pages a scoped result without repeating or skipping a row', async () => {
    const all = await request(server)
      .get('/v1/audit-events')
      .query({ ...window, limit: 200, organizationId: UNION_A })
      .set('Authorization', `Bearer ${unionAdmin(UNION_A)}`);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const response = await request(server)
        .get('/v1/audit-events')
        .query({ ...window, limit: 1, organizationId: UNION_A, ...(cursor ? { cursor } : {}) })
        .set('Authorization', `Bearer ${unionAdmin(UNION_A)}`);

      expect(response.status).toBe(200);
      seen.push(...response.body.items.map((item: { id: string }) => item.id));
      cursor = response.body.nextCursor;
      if (!cursor) break;
    }

    const expected = all.body.items.map((item: { id: string }) => item.id);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
