import request from 'supertest';
import type { Server } from 'node:http';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  cleanupRun,
  disabledProtectiveTriggers,
  instantIn,
  newMigratorPrisma,
  runMonth,
  RUN_TAG,
  runtimeUrl,
  type CleanupReport,
} from './helpers';
import { startApi, systemAdmin, unionAdmin, type ApiHarness } from './api-helpers';
import { orgId, projectOrganization, seedAuditEvent } from './fixtures';

/**
 * This file's `runMonth` slot. Distinct from every other platform-chain suite
 * (`ingestion` 0, `hash-chain` and `trail-ingestion` 1, `correction-linkage` 7).
 */
const TENANT_ISOLATION_MONTH_SLOT = 8;

/**
 * The month every row this file writes lands in — and so the month of its one
 * platform-scoped row's chain, `PLATFORM/(platform)/<RUN_MONTH>`.
 *
 * Not the shared `2026-10` window from `fixtures.ts`. The platform chain key
 * carries no tenant and no tag, so a fixed month is one chain shared by every
 * run that ever seeds a platform row into it: two overlapping runs — or one
 * interrupted before its cleanup — each leave rows the other's `cleanupRun`
 * must refuse to clean around. A run-owned month makes this file the chain's
 * only writer by construction.
 */
const RUN_MONTH = runMonth(TENANT_ISOLATION_MONTH_SLOT);

const MINUTES_PER_DAY = 24 * 60;

/** An instant `minutes` into this run's month. */
const at = (minutes: number): Date => instantIn(RUN_MONTH, minutes);

/** A window of whole days inside `RUN_MONTH`, as query parameters. */
const dayWindow = (firstDay: number, days: number): { from: string; to: string } => ({
  from: instantIn(RUN_MONTH, firstDay * MINUTES_PER_DAY).toISOString(),
  to: instantIn(RUN_MONTH, (firstDay + days) * MINUTES_PER_DAY).toISOString(),
});

/** The first day of the month — every row below is seeded within its first 70 minutes. */
const SEEDED_WINDOW = dayWindow(0, 1);

/** A day in the same month that no seeded row falls in. */
const DISJOINT_WINDOW = dayWindow(2, 1);

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

  const window = SEEDED_WINDOW;

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
    try {
      const report = await cleanupRun(migrator);
      await expectOwnMonthCleaned(report);
    } finally {
      await migrator.onModuleDestroy();
    }
  }, 120_000);

  /**
   * What sits in this run's platform chain, `PLATFORM/(platform)/<RUN_MONTH>`:
   * rows this run wrote, rows anyone else wrote, and the chain's head. Counted
   * with the same tag predicate `cleanupRun` deletes on.
   */
  async function platformChainState(): Promise<{ tagged: number; foreign: number; heads: number }> {
    const [state] = await migrator.client.$queryRawUnsafe<
      { tagged_rows: bigint; foreign_rows: bigint; heads: bigint }[]
    >(
      `WITH platform_month AS (
         SELECT (source_event_id LIKE $2 OR resource_id LIKE $2 OR correlation_id LIKE $2) AS tagged
           FROM audit_event
          WHERE organization_id IS NULL
            AND occurred_at >= ($1::date::timestamp AT TIME ZONE 'UTC')
            AND occurred_at <  (($1::date + INTERVAL '1 month')::timestamp AT TIME ZONE 'UTC')
       )
       SELECT (SELECT count(*) FROM platform_month WHERE tagged)     AS tagged_rows,
              (SELECT count(*) FROM platform_month WHERE NOT tagged) AS foreign_rows,
              (SELECT count(*) FROM audit_chain_head
                WHERE chain_scope = 'PLATFORM'::audit_chain_scope
                  AND organization_id = ''
                  AND chain_month = $1::date)                        AS heads`,
      RUN_MONTH,
      `%_${RUN_TAG}_%`,
    );
    if (!state) throw new Error(`no state for PLATFORM/(platform)/${RUN_MONTH}`);
    return {
      tagged: Number(state.tagged_rows),
      foreign: Number(state.foreign_rows),
      heads: Number(state.heads),
    };
  }

  /**
   * That the cleanup was this run's alone and emptied its platform month.
   *
   * `cleanupRun` has already proven that no tagged audit, processed-event or
   * organization-ref row and no tag-owned head survived. This adds what only
   * this file knows: every chain it wrote into — tenant or platform — was in
   * `RUN_MONTH`, none held a foreign row, the platform chain of that month has
   * neither rows nor a head left, and every protective trigger is back on.
   */
  async function expectOwnMonthCleaned(report: CleanupReport): Promise<void> {
    expect(report.chains.length).toBeGreaterThan(0);
    expect(report.chains.filter((chain) => chain.chainMonth !== RUN_MONTH)).toEqual([]);
    expect(report.chains.filter((chain) => chain.foreignRows > 0)).toEqual([]);
    expect(report.chains.filter((chain) => chain.chainScope === 'PLATFORM')).toEqual([
      {
        chainScope: 'PLATFORM',
        organizationId: '',
        chainMonth: RUN_MONTH,
        taggedRows: 1,
        foreignRows: 0,
      },
    ]);

    expect(await platformChainState()).toEqual({ tagged: 0, foreign: 0, heads: 0 });
    expect(await disabledProtectiveTriggers(migrator)).toEqual([]);
  }

  // -------------------------------------------------------------------------
  // 0. The fixture owns the one chain key that carries no run tag.
  // -------------------------------------------------------------------------

  it('seeds its platform-scoped row into a platform chain month no other run writes', async () => {
    // Outside the eighteen pre-built partitions `runMonth` avoids, and never
    // the shared `2026-10` window the other read suites use.
    expect(RUN_MONTH).toMatch(/^2\d{3}-(0[1-9]|1[0-2])-01$/);
    expect(RUN_MONTH).not.toBe('2026-10-01');

    // Exactly the one row this run seeded and nobody else's, which is what lets
    // `cleanupRun` remove the chain rather than refuse it.
    const { tagged, foreign } = await platformChainState();
    expect({ tagged, foreign }).toEqual({ tagged: 1, foreign: 0 });
  });

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
      .query(DISJOINT_WINDOW)
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
