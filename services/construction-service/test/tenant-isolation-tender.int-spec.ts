import { runWithContext } from '@rasta/nest-common';
import {
  approvedProject,
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
 * Tenant isolation for the tender aggregate (AGENTS.md § 4, ADR-011): the
 * owner's organization B can neither read nor change anything of organization
 * A's tender — through any service method and through any repository read — and
 * every refusal is a `404`, indistinguishable from a tender that does not exist.
 *
 * After each attempt A's tender is unchanged and neither organization gained an
 * outbox row, so a refused cross-tenant command leaves no trace in the event log.
 */

describe('tenant isolation — tenders', () => {
  let w: Wiring;
  const organizations: string[] = [];
  let a: string;
  let b: string;
  let projectId: string;
  let projectVersion: number;
  let tenderId: string;
  let outboxBeforeA: number;
  let outboxBeforeB: number;

  beforeAll(async () => {
    w = wire();
    a = newOrganizationId();
    b = newOrganizationId();
    organizations.push(a, b);

    const project = await approvedProject(w, a);
    projectId = project.id;
    projectVersion = project.version;
    const tender = await asAdmin(a, () =>
      w.tenders.create(projectId, { title: 'A tender', scopeOfWork: 'Private scope of A' }),
    );
    tenderId = tender.id;

    // B has an approved project and a tender of its own, so "B sees nothing of A"
    // is not merely "B has nothing".
    const own = await approvedProject(w, b);
    await asAdmin(b, () =>
      w.tenders.create(own.id, { title: 'B tender', scopeOfWork: 'Scope of B' }),
    );
    outboxBeforeA = (await outboxFor(w.prisma, a)).length;
    outboxBeforeB = (await outboxFor(w.prisma, b)).length;
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
  });

  afterEach(async () => {
    const tender = await asAdmin(a, () => w.tenders.get(tenderId));
    expect(tender).toMatchObject({
      version: 1,
      status: 'DRAFT',
      title: 'A tender',
      scopeOfWork: 'Private scope of A',
    });
    expect(await outboxFor(w.prisma, a)).toHaveLength(outboxBeforeA);
    expect(await outboxFor(w.prisma, b)).toHaveLength(outboxBeforeB);
  });

  describe('every operation answers 404 across tenants', () => {
    it.each<[string, () => Promise<unknown>]>([
      ['GET /v1/tenders/{id}', () => w.tenders.get(tenderId)],
      [
        'PATCH /v1/tenders/{id}',
        () => w.tenders.update(tenderId, { expectedVersion: 1, title: 'Hijacked' }),
      ],
      [
        'POST /v1/tenders/{id}/cancel',
        () =>
          w.tenders.cancel(tenderId, {
            expectedVersion: 1,
            reason: 'Cross-tenant attempt',
            reasonCode: 'OWNER_REQUEST',
          }),
      ],
      [
        'POST /v1/projects/{id}/tenders (a tender under another organization’s project)',
        () => w.tenders.create(projectId, { title: 'Inject', scopeOfWork: 'Cross-tenant' }),
      ],
    ])('%s', async (_route, call) => {
      await expect(asAdmin(b, call)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('GET /v1/tenders lists only the caller’s organization', async () => {
      const page = await asAdmin(b, () => w.tenders.list({ limit: 200 }));
      expect(page.items.map((item) => item.organizationId)).toEqual([b]);
      expect(page.items.map((item) => item.id)).not.toContain(tenderId);
    });

    it('a filter naming A’s project still lists nothing of A for B', async () => {
      const page = await asAdmin(b, () => w.tenders.list({ limit: 200, projectId }));
      expect(page.items).toEqual([]);
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
      () => w.tenders.get(tenderId),
    );
    await expect(sysAdminInB).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a person who belongs to both organizations sees A’s tender only while acting for A', async () => {
    const user = newUserId();
    const both = (active: string) =>
      context({
        organizationId: active,
        organizationIds: [a, b],
        userId: user,
        roles: ['ORGANIZATION_ADMIN'],
      });

    await expect(runWithContext(both(b), () => w.tenders.get(tenderId))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(runWithContext(both(a), () => w.tenders.get(tenderId))).resolves.toMatchObject({
      id: tenderId,
    });
  });

  it('cancelling A’s project is refused for B as 404, and for A it is refused only because of the live tender', async () => {
    await expect(
      asAdmin(b, () =>
        w.projects.cancel(projectId, {
          expectedVersion: projectVersion,
          reason: 'Cross-tenant attempt',
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      asAdmin(a, () =>
        w.projects.cancel(projectId, {
          expectedVersion: projectVersion,
          reason: 'Funding was withdrawn',
        }),
      ),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
  });

  describe('every repository read is scoped', () => {
    it('findTender and listTenders see nothing of A from B', async () => {
      await expect(asAdmin(b, () => w.tenderRepository.findTender(tenderId))).resolves.toBeNull();
      const rows = await asAdmin(b, () => w.tenderRepository.listTenders({ limit: 200 }));
      expect(rows.map((row) => row.organizationId)).toEqual([b]);
    });

    it('the row lock finds nothing of A under B’s organization', async () => {
      const found = await asAdmin(b, () =>
        w.prisma.transaction((tx) => w.tenderRepository.lockTender(tx, b, tenderId)),
      );
      expect(found).toBeNull();
    });

    it('the compare-and-set writes match nothing of A from B', async () => {
      const [content, status] = await asAdmin(b, () =>
        w.prisma.transaction(async (tx) => [
          await w.tenderRepository.updateTenderContent(tx, tenderId, 1, { title: 'Hijacked' }),
          await w.tenderRepository.transitionTender(tx, {
            tenderId,
            from: 'DRAFT',
            to: 'CANCELLED',
            expectedVersion: 1,
            reason: 'Cross-tenant attempt',
            reasonCode: 'OWNER_REQUEST',
            actor: 'USR_B',
            at: new Date(),
          }),
        ]),
      );
      expect([content, status]).toEqual([0, 0]);
    });

    it('hasLiveTender sees none of A’s tenders from B', async () => {
      const live = await asAdmin(b, () =>
        w.prisma.transaction((tx) => w.tenderRepository.hasLiveTender(tx, projectId)),
      );
      expect(live).toBe(false);
    });
  });
});
