import { runWithContext } from '@rasta/nest-common';
import {
  PROJECT,
  SQUARE,
  asAdmin,
  cleanup,
  context,
  newOrganizationId,
  newUserId,
  outboxFor,
  wire,
  type Wiring,
} from './helpers';

/**
 * Tenant isolation (AGENTS.md § 4, ADR-011): organization B can neither read
 * nor change anything of organization A — through any endpoint's service
 * method and through any repository read — and every refusal is a `404`,
 * indistinguishable from a project that does not exist.
 *
 * After each attempt A's rows are unchanged and neither organization gained an
 * outbox row, so a refused cross-tenant command leaves no trace in the event
 * log either.
 */

describe('tenant isolation', () => {
  let w: Wiring;
  const organizations: string[] = [];
  let a: string;
  let b: string;
  let projectId: string;
  let needId: string;
  let outboxBefore: number;

  beforeAll(async () => {
    w = wire();
    a = newOrganizationId();
    b = newOrganizationId();
    organizations.push(a, b);

    const project = await asAdmin(a, () => w.projects.create({ ...PROJECT, area: SQUARE }));
    projectId = project.id;
    const need = await asAdmin(a, () =>
      w.needs.add(projectId, { title: 'Gravel', description: 'Base' }),
    );
    needId = need.id;
    // B has a project of its own, so "B sees nothing" is not merely "B has nothing".
    await asAdmin(b, () => w.projects.create({ ...PROJECT, title: 'B project' }));
    outboxBefore = (await outboxFor(w.prisma, a)).length;
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
  });

  afterEach(async () => {
    const project = await asAdmin(a, () => w.projects.get(projectId));
    expect(project).toMatchObject({ version: 1, status: 'DRAFT', title: PROJECT.title });
    const needs = await asAdmin(a, () => w.needs.list(projectId, { limit: 25 }));
    expect(needs.items).toEqual([
      expect.objectContaining({ id: needId, version: 1, status: 'DRAFT' }),
    ]);
    expect(await outboxFor(w.prisma, a)).toHaveLength(outboxBefore);
    expect((await outboxFor(w.prisma, b)).map((row) => row.eventName)).toEqual(['PROJECT_CREATED']);
  });

  describe('every endpoint answers 404 across tenants', () => {
    it.each<[string, () => Promise<unknown>]>([
      ['GET /v1/projects/{id}', () => w.projects.get(projectId)],
      [
        'PATCH /v1/projects/{id}',
        () => w.projects.update(projectId, { expectedVersion: 1, title: 'Hijacked' }),
      ],
      [
        'POST /v1/projects/{id}/cancel',
        () => w.projects.cancel(projectId, { expectedVersion: 1, reason: 'Cross-tenant attempt' }),
      ],
      [
        'POST /v1/projects/{id}/needs',
        () => w.needs.add(projectId, { title: 'Inject', description: 'Needs' }),
      ],
      ['GET /v1/projects/{id}/needs', () => w.needs.list(projectId, { limit: 25 })],
      [
        'PATCH /v1/projects/{id}/needs/{needId}',
        () => w.needs.update(projectId, needId, { expectedVersion: 1, title: 'Hijacked' }),
      ],
      [
        'POST /v1/projects/{id}/needs/{needId}/submit',
        () => w.needs.submit(projectId, needId, { expectedVersion: 1 }),
      ],
      [
        'POST /v1/projects/{id}/needs/{needId}/withdraw',
        () =>
          w.needs.withdraw(projectId, needId, {
            expectedVersion: 1,
            reason: 'Cross-tenant attempt',
          }),
      ],
    ])('%s', async (_route, call) => {
      await expect(asAdmin(b, call)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('GET /v1/projects lists only the caller’s organization', async () => {
      const page = await asAdmin(b, () => w.projects.list({ limit: 200 }));
      expect(page.items.map((item) => item.organizationId)).toEqual([b]);
      expect(page.items.map((item) => item.id)).not.toContain(projectId);
    });
  });

  it('a platform operator of another organization is still only that organization (ADR-060)', async () => {
    const sysAdminInB = runWithContext(
      context({
        organizationId: b,
        organizationIds: [b],
        userId: newUserId(),
        roles: ['SYSTEM_ADMIN'],
      }),
      () => w.projects.get(projectId),
    );
    await expect(sysAdminInB).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a person who belongs to both organizations sees A only while acting for A', async () => {
    const user = newUserId();
    const both = (active: string) =>
      context({
        organizationId: active,
        organizationIds: [a, b],
        userId: user,
        roles: ['ORGANIZATION_ADMIN'],
      });

    await expect(runWithContext(both(b), () => w.projects.get(projectId))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(runWithContext(both(a), () => w.projects.get(projectId))).resolves.toMatchObject({
      id: projectId,
    });
  });

  describe('every repository read is scoped', () => {
    it('findProject and needsSummary see nothing of A from B', async () => {
      await expect(asAdmin(b, () => w.repository.findProject(projectId))).resolves.toBeNull();
      await expect(asAdmin(b, () => w.repository.needsSummary(projectId))).resolves.toEqual({
        draft: 0,
        submitted: 0,
        withdrawn: 0,
      });
    });

    it('listProjects and listNeeds return nothing of A to B', async () => {
      const projects = await asAdmin(b, () => w.repository.listProjects({ limit: 200 }));
      expect(projects.every((row) => row.organizationId === b)).toBe(true);
      await expect(
        asAdmin(b, () => w.repository.listNeeds(projectId, { limit: 200 })),
      ).resolves.toEqual([]);
    });

    it('findNeed sees nothing of A from B', async () => {
      await expect(
        asAdmin(b, () => w.repository.findNeed(w.prisma.client, projectId, needId)),
      ).resolves.toBeNull();
    });

    it('the raw reads name the organization in their own predicate', async () => {
      await expect(w.repository.readArea(b, projectId)).resolves.toBeNull();
      await expect(w.repository.projectsWithArea(b, [projectId])).resolves.toEqual(new Set());
      await expect(w.repository.readArea(a, projectId)).resolves.toEqual(SQUARE);
    });

    it('the row lock finds nothing of A under B’s organization', async () => {
      const locked = await w.prisma.transaction((tx) => w.repository.lockProject(tx, b, projectId));
      expect(locked).toBeNull();
    });

    it('the compare-and-set writes match nothing of A from B', async () => {
      const matched = await asAdmin(b, () =>
        w.prisma.transaction((tx) =>
          w.repository.updateProjectContent(tx, projectId, 1, { title: 'Hijacked' }),
        ),
      );
      expect(matched).toBe(0);
    });

    it('setArea with B’s organization changes nothing of A', async () => {
      await w.prisma.transaction((tx) => w.repository.setArea(tx, b, projectId, null));
      await expect(w.repository.readArea(a, projectId)).resolves.toEqual(SQUARE);
    });
  });
});
