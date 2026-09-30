import type { CriterionInput } from '../src/tender/criteria.dto';
import {
  approvedProject,
  asAdmin,
  cleanup,
  newOrganizationId,
  outboxFor,
  wire,
  type Wiring,
} from './helpers';

/**
 * Tenant isolation for criteria templates and a tender's criteria (AGENTS.md § 4,
 * ADR-011): organization B can neither read nor change anything of organization
 * A's — through any service method and any repository read — every refusal is a
 * `404`, and a refused attempt leaves no row and no event.
 */

const CRITERIA: CriterionInput[] = [
  { code: 'PRICE', label: 'Price', weightBp: 6000, scoringMethod: 'MANUAL_SCORE', maxScore: 100 },
  {
    code: 'TECH',
    label: 'Technical',
    weightBp: 4000,
    scoringMethod: 'MANUAL_SCORE',
    maxScore: 100,
  },
];

describe('tenant isolation — criteria', () => {
  let w: Wiring;
  const organizations: string[] = [];
  let a: string;
  let b: string;
  let tenderId: string;
  let templateId: string;
  let outboxBeforeA: number;
  let outboxBeforeB: number;

  beforeAll(async () => {
    w = wire();
    a = newOrganizationId();
    b = newOrganizationId();
    organizations.push(a, b);

    const project = await approvedProject(w, a);
    const tender = await asAdmin(a, () =>
      w.tenders.create(project.id, { title: 'A tender', scopeOfWork: 'Private scope of A' }),
    );
    tenderId = tender.id;
    const template = await asAdmin(a, () =>
      w.criteria.createTemplate({ label: 'A roads', criteria: CRITERIA }),
    );
    templateId = template.id;
    await asAdmin(a, () =>
      w.criteria.setCriteria(tenderId, { expectedVersion: 1, criteria: CRITERIA }),
    );

    // B has a template of its own, so "B sees nothing of A" is not merely "B has nothing".
    await asAdmin(b, () => w.criteria.createTemplate({ label: 'B roads', criteria: CRITERIA }));
    outboxBeforeA = (await outboxFor(w.prisma, a)).length;
    outboxBeforeB = (await outboxFor(w.prisma, b)).length;
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
  });

  afterEach(async () => {
    const now = await asAdmin(a, () => w.criteria.getCriteria(tenderId));
    expect(now).toMatchObject({ version: 2, totalWeightBp: 10_000 });
    expect(now.items.map((item) => item.code)).toEqual(['PRICE', 'TECH']);
    expect(await outboxFor(w.prisma, a)).toHaveLength(outboxBeforeA);
    expect(await outboxFor(w.prisma, b)).toHaveLength(outboxBeforeB);
  });

  it.each<[string, () => Promise<unknown>]>([
    ['GET /v1/criteria-templates/{id}', () => w.criteria.getTemplate(templateId)],
    ['GET /v1/tenders/{id}/criteria', () => w.criteria.getCriteria(tenderId)],
    [
      'PUT /v1/tenders/{id}/criteria (written out)',
      () => w.criteria.setCriteria(tenderId, { expectedVersion: 2, criteria: [CRITERIA[0]!] }),
    ],
    [
      'PUT /v1/tenders/{id}/criteria (from A’s template, on A’s tender)',
      () => w.criteria.setCriteria(tenderId, { expectedVersion: 2, templateId }),
    ],
  ])('%s answers 404 to B', async (_route, call) => {
    await expect(asAdmin(b, call)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lists only the caller’s organization’s templates', async () => {
    const page = await asAdmin(b, () => w.criteria.listTemplates({ limit: 200 }));
    expect(page.items.map((item) => item.organizationId)).toEqual([b]);
    expect(page.items.map((item) => item.id)).not.toContain(templateId);
    const byLabel = await asAdmin(b, () =>
      w.criteria.listTemplates({ limit: 200, label: 'A roads' }),
    );
    expect(byLabel.items).toEqual([]);
  });

  it('gives B version 1 of a label A already versioned: labels are per organization', async () => {
    const own = await asAdmin(b, () =>
      w.criteria.createTemplate({ label: 'A roads', criteria: CRITERIA }),
    );
    expect(own.version).toBe(1);
    // That was a write of B's own; account for its event so the afterEach stays exact.
    outboxBeforeB += 1;
  });

  describe('every repository read is scoped', () => {
    it('templates and criteria of A are invisible to B', async () => {
      await expect(
        asAdmin(b, () => w.criteriaRepository.findTemplate(templateId)),
      ).resolves.toBeNull();
      await expect(asAdmin(b, () => w.criteriaRepository.listCriteria(tenderId))).resolves.toEqual(
        [],
      );
      const rows = await asAdmin(b, () => w.criteriaRepository.listTemplates({ limit: 200 }));
      expect(rows.every((row) => row.organizationId === b)).toBe(true);
    });

    it('a replace under B’s organization touches nothing of A’s tender', async () => {
      await asAdmin(b, () =>
        w.prisma
          .transaction(async (tx) => {
            await w.criteriaRepository
              .replaceCriteria(tx, {
                organizationId: b,
                tenderId,
                criteria: [CRITERIA[0]!],
                templateId: null,
                newId: () => 'CRT_should_not_exist',
                actor: 'USR_B',
                at: new Date(),
              })
              .catch(() => undefined);
          })
          .catch(() => undefined),
      );
      // Whatever the database did with that attempt, A's list is exactly what it was.
      const now = await asAdmin(a, () => w.criteriaRepository.listCriteria(tenderId));
      expect(now.map((row) => row.code)).toEqual(['PRICE', 'TECH']);
    });
  });
});
