import { ulid } from 'ulid';
import { cleanup, newOrganizationId, wire, type Wiring } from './helpers';

/**
 * What PostgreSQL itself refuses, whatever a future write path forgets.
 *
 * Each case writes raw SQL — below the DTOs, the services and the tenant guard
 * — and asserts the database answers with the named constraint. These are the
 * invariants a reader would otherwise take on trust from the service code.
 */

describe('database invariants', () => {
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

  /** Inserts a valid project, with any column overridden. Returns its id. */
  async function insertProject(
    organizationId: string,
    overrides: Record<string, string> = {},
  ): Promise<string> {
    const id = `PRJ_${ulid()}`;
    const columns: Record<string, string> = {
      id: `'${id}'`,
      organization_id: `'${organizationId}'`,
      title: `'Road'`,
      operation_type: `'road'`,
      scope_of_work: `'Resurface'`,
      location_description: `'North'`,
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
      `INSERT INTO "project" (${Object.keys(columns)
        .map((c) => `"${c}"`)
        .join(', ')})
       VALUES (${Object.values(columns).join(', ')})`,
    );
    return id;
  }

  async function insertNeed(
    organizationId: string,
    projectId: string,
    overrides: Record<string, string> = {},
  ): Promise<void> {
    const columns: Record<string, string> = {
      id: `'PND_${ulid()}'`,
      organization_id: `'${organizationId}'`,
      project_id: `'${projectId}'`,
      title: `'Gravel'`,
      description: `'Base'`,
      status: `'DRAFT'`,
      created_at: 'now()',
      created_by: `'USR_1'`,
      created_correlation_id: `'corr'`,
      updated_at: 'now()',
      updated_by: `'USR_1'`,
      ...overrides,
    };
    await w.prisma.client.$executeRawUnsafe(
      `INSERT INTO "project_need" (${Object.keys(columns)
        .map((c) => `"${c}"`)
        .join(', ')})
       VALUES (${Object.values(columns).join(', ')})`,
    );
  }

  it('accepts the valid baselines', async () => {
    const a = org();
    const project = await insertProject(a);
    await expect(insertNeed(a, project)).resolves.toBeUndefined();
  });

  describe('the tenant-bound foreign key', () => {
    it('refuses a need of one organization on a project of another', async () => {
      const a = org();
      const b = org();
      const projectOfA = await insertProject(a);

      await expect(insertNeed(b, projectOfA)).rejects.toThrow(
        /project_need_organization_id_project_id_fkey/,
      );
    });

    it('refuses to delete a project that still has needs', async () => {
      const a = org();
      const project = await insertProject(a);
      await insertNeed(a, project);

      await expect(
        w.prisma.client.$executeRawUnsafe(`DELETE FROM "project" WHERE "id" = '${project}'`),
      ).rejects.toThrow(/project_need_organization_id_project_id_fkey/);
    });
  });

  describe('project', () => {
    it.each([
      ['a blank title', { title: `'   '` }, 'ck_project_text_not_blank'],
      ['a blank actor', { created_by: `' '` }, 'ck_project_actor_recorded'],
      ['a negative estimate', { estimated_cost_minor: '-1' }, 'ck_project_estimate_nonneg'],
      [
        'a cancellation without a reason',
        { status: `'CANCELLED'` },
        'ck_project_cancellation_has_reason',
      ],
      [
        'a blank cancellation reason',
        { status: `'CANCELLED'`, status_reason: `' '` },
        'ck_project_cancellation_has_reason',
      ],
      ['version zero', { version: '0' }, 'ck_project_version_positive'],
      [
        'an update before creation',
        { updated_at: `now() - interval '1 day'` },
        'ck_project_timestamps_ordered',
      ],
      [
        'a self-intersecting area',
        { area: `ST_GeogFromText('POLYGON((0 0, 1 1, 1 0, 0 1, 0 0))')` },
        'ck_project_area_valid',
      ],
    ])('refuses %s', async (_label, overrides, constraint) => {
      await expect(insertProject(org(), overrides)).rejects.toThrow(new RegExp(constraint));
    });

    it('accepts a cancellation that carries its reason, and a zero estimate', async () => {
      await expect(
        insertProject(org(), {
          status: `'CANCELLED'`,
          status_reason: `'Funding withdrawn'`,
          estimated_cost_minor: '0',
        }),
      ).resolves.toMatch(/^PRJ_/);
    });
  });

  describe('project_need', () => {
    it.each([
      ['a blank description', { description: `''` }, 'ck_need_text_not_blank'],
      ['a blank unit', { unit: `' '` }, 'ck_need_text_not_blank'],
      ['a zero quantity', { quantity: '0' }, 'ck_need_quantity_positive'],
      ['a negative estimate', { estimated_cost_minor: '-5' }, 'ck_need_estimate_nonneg'],
      [
        'a SUBMITTED need with no submission',
        { status: `'SUBMITTED'` },
        'ck_need_submission_complete',
      ],
      [
        'a submission without its actor',
        { status: `'SUBMITTED'`, submitted_at: 'now()' },
        'ck_need_submission_complete',
      ],
      [
        'a DRAFT that claims a submission',
        { submitted_at: 'now()', submitted_by: `'USR_1'` },
        'ck_need_submission_complete',
      ],
      [
        'a WITHDRAWN need with no withdrawal',
        { status: `'WITHDRAWN'` },
        'ck_need_withdrawal_complete',
      ],
      [
        'a withdrawal without a reason',
        { status: `'WITHDRAWN'`, withdrawn_at: 'now()', withdrawn_by: `'USR_1'` },
        'ck_need_withdrawal_complete',
      ],
      [
        'a DRAFT that claims a withdrawal',
        { withdrawn_at: 'now()', withdrawn_by: `'USR_1'`, withdrawal_reason: `'Because'` },
        'ck_need_withdrawal_complete',
      ],
      ['version zero', { version: '0' }, 'ck_need_version_positive'],
    ])('refuses %s', async (_label, overrides, constraint) => {
      const a = org();
      const project = await insertProject(a);
      await expect(insertNeed(a, project, overrides)).rejects.toThrow(new RegExp(constraint));
    });

    it('accepts a complete withdrawal of a need that was never submitted', async () => {
      const a = org();
      const project = await insertProject(a);
      await expect(
        insertNeed(a, project, {
          status: `'WITHDRAWN'`,
          withdrawn_at: 'now()',
          withdrawn_by: `'USR_1'`,
          withdrawal_reason: `'Not needed'`,
        }),
      ).resolves.toBeUndefined();
    });
  });
});
