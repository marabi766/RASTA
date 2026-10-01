import { ulid } from 'ulid';
import { cleanup, newOrganizationId, wire, type Wiring } from './helpers';

/**
 * What PostgreSQL itself refuses about a tender, whatever a future write path
 * forgets. Each case writes raw SQL — below the DTOs, the services and the
 * tenant guard — and asserts the database answers with the named constraint.
 */

describe('tender database invariants', () => {
  let w: Wiring;
  const organizations: string[] = [];

  beforeAll(() => {
    w = wire();
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
  });

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  async function insertProject(organizationId: string): Promise<string> {
    const id = `PRJ_${ulid()}`;
    await w.prisma.client.$executeRawUnsafe(
      `INSERT INTO "project" ("id", "organization_id", "title", "operation_type", "scope_of_work",
         "location_description", "status", "status_changed_at", "status_changed_by", "created_at",
         "created_by", "created_correlation_id", "updated_at", "updated_by")
       VALUES ('${id}', '${organizationId}', 'Road', 'road', 'Resurface', 'North', 'APPROVED',
         now(), 'USR_1', now(), 'USR_1', 'corr', now(), 'USR_1')`,
    );
    return id;
  }

  async function insertTender(
    organizationId: string,
    projectId: string,
    overrides: Record<string, string> = {},
  ): Promise<void> {
    const columns: Record<string, string> = {
      id: `'TND_${ulid()}'`,
      organization_id: `'${organizationId}'`,
      project_id: `'${projectId}'`,
      title: `'Road resurfacing'`,
      scope_of_work: `'Two kilometres'`,
      status: `'DRAFT'`,
      status_changed_at: 'now()',
      status_changed_by: `'USR_1'`,
      created_at: 'now()',
      created_by: `'USR_1'`,
      created_correlation_id: `'corr'`,
      updated_at: 'now()',
      updated_by: `'USR_1'`,
      ...overrides,
    };
    await w.prisma.client.$executeRawUnsafe(
      `INSERT INTO "tender" (${Object.keys(columns)
        .map((c) => `"${c}"`)
        .join(', ')})
       VALUES (${Object.values(columns).join(', ')})`,
    );
  }

  const COMPLETE = {
    procurement_nature: `'FORMAL_TENDER'`,
    visibility: `'PUBLIC'`,
    bid_opening_at: `'2026-11-01T08:00:00Z'`,
    bid_closing_at: `'2026-11-30T20:30:00Z'`,
  };

  /** Who published and when: required from PUBLISHED on (`ck_tender_publication_complete`). */
  const PUBLISHED_BY = { published_at: 'now()', published_by: `'USR_1'` };

  it('accepts the valid baselines: a bare draft, and a complete published tender', async () => {
    const a = org();
    const project = await insertProject(a);
    await expect(insertTender(a, project)).resolves.toBeUndefined();
    await expect(
      insertTender(a, project, { status: `'PUBLISHED'`, ...COMPLETE, ...PUBLISHED_BY }),
    ).resolves.toBeUndefined();
  });

  it('refuses a tender of one organization on a project of another (the tenant-bound foreign key)', async () => {
    const a = org();
    const b = org();
    const projectOfA = await insertProject(a);

    await expect(insertTender(b, projectOfA)).rejects.toThrow(
      /tender_organization_id_project_id_fkey/,
    );
  });

  it('refuses to delete a project that still has a tender', async () => {
    const a = org();
    const project = await insertProject(a);
    await insertTender(a, project);

    await expect(
      w.prisma.client.$executeRawUnsafe(`DELETE FROM "project" WHERE "id" = '${project}'`),
    ).rejects.toThrow(/tender_organization_id_project_id_fkey/);
  });

  it.each([
    ['a blank title', { title: `'   '` }, 'ck_tender_text_not_blank'],
    ['a blank scope', { scope_of_work: `''` }, 'ck_tender_text_not_blank'],
    ['a blank actor', { created_by: `' '` }, 'ck_tender_actor_recorded'],
    ['version zero', { version: '0' }, 'ck_tender_version_positive'],
    [
      'an update that predates the creation',
      { updated_at: `now() - interval '1 day'` },
      'ck_tender_timestamps_ordered',
    ],
  ])('refuses %s', async (_label, overrides, constraint) => {
    const a = org();
    const project = await insertProject(a);
    await expect(insertTender(a, project, overrides)).rejects.toThrow(new RegExp(constraint));
  });

  describe('the bidding window', () => {
    it.each([
      [
        'closing before opening',
        { bid_opening_at: `'2026-11-30T20:30:00Z'`, bid_closing_at: `'2026-11-01T08:00:00Z'` },
      ],
      [
        'closing at the same instant as opening',
        { bid_opening_at: `'2026-11-01T08:00:00Z'`, bid_closing_at: `'2026-11-01T08:00:00Z'` },
      ],
      ['only an opening', { bid_opening_at: `'2026-11-01T08:00:00Z'` }],
      ['only a closing', { bid_closing_at: `'2026-11-30T20:30:00Z'` }],
    ])('refuses %s', async (_label, overrides) => {
      const a = org();
      const project = await insertProject(a);
      await expect(insertTender(a, project, overrides)).rejects.toThrow(/ck_tender_window_ordered/);
    });

    it('stores a deadline as one UTC instant whatever offset it was written with', async () => {
      const a = org();
      const project = await insertProject(a);
      await insertTender(a, project, {
        bid_opening_at: `'2026-11-01T11:30:00+03:30'`,
        bid_closing_at: `'2026-11-30T20:30:00Z'`,
      });
      const rows = await w.prisma.client.$queryRawUnsafe<{ opening: string }[]>(
        `SELECT to_char("bid_opening_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS opening
           FROM "tender" WHERE "organization_id" = '${a}' AND "bid_opening_at" IS NOT NULL`,
      );
      expect(rows[0]?.opening).toBe('2026-11-01T08:00:00Z');
    });
  });

  describe('publication is never on a default', () => {
    it.each(['PUBLISHED', 'CLOSED', 'EVALUATING', 'EVALUATED', 'AWARDED'])(
      'refuses a %s tender without its nature, visibility and window',
      async (status) => {
        const a = org();
        const project = await insertProject(a);
        await expect(
          insertTender(a, project, { status: `'${status}'`, ...PUBLISHED_BY }),
        ).rejects.toThrow(/ck_tender_published_complete/);
      },
    );

    it.each(['procurement_nature', 'visibility', 'bid_opening_at', 'bid_closing_at'])(
      'refuses a PUBLISHED tender without %s',
      async (missing) => {
        const a = org();
        const project = await insertProject(a);
        const { [missing]: _omitted, ...rest } = COMPLETE as Record<string, string>;
        await expect(
          insertTender(a, project, { status: `'PUBLISHED'`, ...rest, ...PUBLISHED_BY }),
        ).rejects.toThrow(/ck_tender_published_complete|ck_tender_window_ordered/);
      },
    );
  });

  describe('a cancellation says why', () => {
    it('refuses CANCELLED with no reason or no code', async () => {
      const a = org();
      const project = await insertProject(a);
      await expect(
        insertTender(a, project, { status: `'CANCELLED'`, status_reason_code: `'OWNER_REQUEST'` }),
      ).rejects.toThrow(/ck_tender_cancellation_has_reason/);
      await expect(
        insertTender(a, project, {
          status: `'CANCELLED'`,
          status_reason: `'Funding was withdrawn'`,
        }),
      ).rejects.toThrow(/ck_tender_cancellation_has_reason/);
      await expect(
        insertTender(a, project, {
          status: `'CANCELLED'`,
          status_reason: `'   '`,
          status_reason_code: `'OWNER_REQUEST'`,
        }),
      ).rejects.toThrow(/ck_tender_cancellation_has_reason/);
    });

    it('refuses a reason on a tender that is not cancelled, and a code outside the closed set', async () => {
      const a = org();
      const project = await insertProject(a);
      await expect(
        insertTender(a, project, {
          status_reason: `'A reason'`,
          status_reason_code: `'OWNER_REQUEST'`,
        }),
      ).rejects.toThrow(/ck_tender_cancellation_has_reason/);
      await expect(
        insertTender(a, project, {
          status: `'CANCELLED'`,
          status_reason: `'Funding was withdrawn'`,
          status_reason_code: `'BECAUSE'`,
        }),
      ).rejects.toThrow(/ck_tender_cancellation_has_reason/);
    });

    it('accepts the two closed codes', async () => {
      const a = org();
      const project = await insertProject(a);
      for (const code of ['OWNER_REQUEST', 'NO_QUALIFIED_BID']) {
        await expect(
          insertTender(a, project, {
            status: `'CANCELLED'`,
            status_reason: `'Stated for the record'`,
            status_reason_code: `'${code}'`,
          }),
        ).resolves.toBeUndefined();
      }
    });
  });
});
