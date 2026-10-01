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
 * Tenant isolation for publishing and inviting (AGENTS.md § 4, ADR-011):
 * organization B can neither publish, invite to, nor read the invitations of
 * organization A's tender, every refusal is a `404`, and a refused attempt makes
 * no key, no invitation and no event.
 */

const WHOLE: CriterionInput[] = [
  { code: 'PRICE', label: 'Price', weightBp: 10_000, scoringMethod: 'MANUAL_SCORE', maxScore: 100 },
];
const DAY = 24 * 60 * 60 * 1000;

describe('tenant isolation — publication and invitations', () => {
  let w: Wiring;
  const organizations: string[] = [];
  let a: string;
  let b: string;
  let tenderId: string;
  let version: number;
  let outboxBeforeA: number;
  let outboxBeforeB: number;

  beforeAll(async () => {
    w = wire();
    a = newOrganizationId();
    b = newOrganizationId();
    organizations.push(a, b);

    const project = await approvedProject(w, a);
    const tender = await asAdmin(a, () =>
      w.tenders.create(project.id, {
        title: 'A tender',
        scopeOfWork: 'Private scope of A',
        procurementNature: 'RFP',
        visibility: 'RESTRICTED',
        bidOpeningAt: new Date(Date.now() + DAY).toISOString(),
        bidClosingAt: new Date(Date.now() + 30 * DAY).toISOString(),
      }),
    );
    tenderId = tender.id;
    const set = await asAdmin(a, () =>
      w.criteria.setCriteria(tenderId, { expectedVersion: 1, criteria: WHOLE }),
    );
    version = set.version;
    await asAdmin(a, () => w.publication.invite(tenderId, { organizationId: 'ORG_BIDDER_1' }));

    // B has a publishable tender of its own, so "B can do nothing to A's" is not "B can do nothing".
    const own = await approvedProject(w, b);
    const ownTender = await asAdmin(b, () =>
      w.tenders.create(own.id, {
        title: 'B tender',
        scopeOfWork: 'Scope of B',
        procurementNature: 'RFP',
        visibility: 'PUBLIC',
        bidOpeningAt: new Date(Date.now() + DAY).toISOString(),
        bidClosingAt: new Date(Date.now() + 30 * DAY).toISOString(),
      }),
    );
    await asAdmin(b, () =>
      w.criteria.setCriteria(ownTender.id, { expectedVersion: 1, criteria: WHOLE }),
    );
    outboxBeforeA = (await outboxFor(w.prisma, a)).length;
    outboxBeforeB = (await outboxFor(w.prisma, b)).length;
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
  });

  afterEach(async () => {
    expect(await asAdmin(a, () => w.tenders.get(tenderId))).toMatchObject({
      status: 'DRAFT',
      version,
      publishedAt: null,
    });
    expect(
      await asAdmin(a, async () => await w.prisma.client.tenderKey.count({ where: { tenderId } })),
    ).toBe(0);
    expect(
      (await asAdmin(a, () => w.publication.listInvitations(tenderId, { limit: 25 }))).items,
    ).toHaveLength(1);
    expect(await outboxFor(w.prisma, a)).toHaveLength(outboxBeforeA);
    expect(await outboxFor(w.prisma, b)).toHaveLength(outboxBeforeB);
  });

  it.each<[string, () => Promise<unknown>]>([
    [
      'POST /v1/tenders/{id}/publish',
      () => w.publication.publish(tenderId, { expectedVersion: version }),
    ],
    [
      'POST /v1/tenders/{id}/invitations',
      () => w.publication.invite(tenderId, { organizationId: 'ORG_BIDDER_2' }),
    ],
    [
      'GET /v1/tenders/{id}/invitations',
      () => w.publication.listInvitations(tenderId, { limit: 25 }),
    ],
  ])('%s answers 404 to B', async (_route, call) => {
    await expect(asAdmin(b, call)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('B’s repository reads see none of A’s invitations', async () => {
    await expect(
      asAdmin(b, () => w.publicationRepository.listInvitations(tenderId, { limit: 25 })),
    ).resolves.toEqual([]);
    await expect(
      asAdmin(b, () =>
        w.prisma.transaction((tx) => w.publicationRepository.countInvitations(tx, tenderId)),
      ),
    ).resolves.toBe(0);
    await expect(
      asAdmin(b, async () => await w.prisma.client.tenderKey.count({ where: { tenderId } })),
    ).resolves.toBe(0);
  });

  it('B publishing its own tender makes a key for B alone, and none for A', async () => {
    const own = await asAdmin(b, () => w.tenders.list({ limit: 10 }));
    const ownTender = own.items[0]!;
    const published = await asAdmin(b, () =>
      w.publication.publishApproved(ownTender.id, { expectedVersion: 2 }),
    );
    expect(published.status).toBe('PUBLISHED');
    expect(
      await asAdmin(
        b,
        async () => await w.prisma.client.tenderKey.count({ where: { tenderId: ownTender.id } }),
      ),
    ).toBe(1);
    // The afterEach for this test counts B's event stream once more; account for it.
    outboxBeforeB += 1;
  });
});
