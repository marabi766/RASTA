import { ulid } from 'ulid';
import { AssetRepository } from '../src/asset/asset.repository';
import { AssetService } from '../src/asset/asset.service';
import { InsuranceService } from '../src/insurance/insurance.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { FakeDocuments, asActor, id, newPrisma, tenants } from './helpers';
import { clearingOwners } from './transfer-clearance.fake';

/**
 * What happens to an asset's document references when it changes owner (docs/24 Q-99, provisional
 * answer (a)): **nothing moves.** document-service keeps a document owned by the organization that
 * registered it, so a reference carried to the new owner would be one it cannot read (404) — and
 * would hand it the previous owner's private data the day any grant exists. The references stay the
 * previous owner's rows (its history); the new owner starts with an empty documents list and
 * attaches its own. Against a real PostgreSQL, through the real service.
 */
describe('document references on an ownership transfer (Q-99)', () => {
  const org = tenants();
  const third = `ORG-ITEST-C-${ulid().slice(-10)}`;
  const orgs = [org.a, org.b, third];
  const TITLE_A = 'سند محرمانهٔ مالک اول';
  const TITLE_B = 'سند مالک دوم';

  let prisma: PrismaService;
  let repository: AssetRepository;
  let assets: AssetService;
  let insurance: InsuranceService;
  const documents = new FakeDocuments();

  const manager = (organizationId: string) => ({ organizationId, roles: ['FLEET_MANAGER'] });
  const admin = (organizationId: string) => ({
    organizationId,
    roles: ['ORGANIZATION_ADMIN'],
    userId: `USR-ADMIN-${organizationId.slice(-4)}`,
  });

  /** An ACTIVE machine of `organizationId` with one document of its own attached. */
  async function machineWithDocument(organizationId: string, title = TITLE_A) {
    const created = await asActor(manager(organizationId), () =>
      assets.create({ name: 'لودر آزمون', type: 'LOADER', specifications: {} } as never),
    );
    await prisma.client.$executeRawUnsafe(
      `UPDATE asset SET status = 'ACTIVE'::"OperationalStatus" WHERE id = $1`,
      created.id,
    );
    const documentId = id('DOC');
    documents.ownedBy(documentId, organizationId);
    await asActor(manager(organizationId), () =>
      assets.attachDocument(created.id, { documentId, kind: 'OWNERSHIP_TITLE', title }),
    );
    return { assetId: created.id, documentId };
  }

  const transfer = (assetId: string, from: string, to: string) =>
    asActor(admin(from), () =>
      assets.transfer(assetId, { toOrganizationId: to, reason: 'واگذاری آزمون' }),
    );

  const refsOf = (assetId: string) =>
    prisma.client.$queryRawUnsafe<{ document_id: string; organization_id: string }[]>(
      `SELECT document_id, organization_id FROM asset_document_ref WHERE asset_id = $1
        ORDER BY created_at`,
      assetId,
    );
  const documentTimelineOf = (assetId: string) =>
    prisma.client.$queryRawUnsafe<{ organization_id: string; description: string | null }[]>(
      `SELECT organization_id, description FROM asset_timeline_entry
        WHERE asset_id = $1 AND category = 'DOCUMENT'`,
      assetId,
    );
  const documentsSeenBy = async (organizationId: string, assetId: string) =>
    (await asActor(manager(organizationId), () => assets.dossier(assetId))).documents;

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    repository = new AssetRepository(prisma);
    assets = new AssetService(repository, undefined, clearingOwners(), documents);
    insurance = new InsuranceService(repository, assets, 30);
    for (const organizationId of orgs) {
      await repository.upsertOrganizationRef({
        id: organizationId,
        name: 'سازمان آزمون',
        type: 'DEHYARI',
        status: 'ACTIVE',
        sourceEvent: 'itest',
      });
    }
  });

  afterAll(async () => {
    await prisma.client.$executeRawUnsafe(
      `DELETE FROM outbox_message WHERE organization_id = ANY($1::text[])`,
      orgs,
    );
    for (const table of [
      'insurance_policy',
      'asset_document_ref',
      'asset_timeline_entry',
      'asset_transfer',
      'asset_location',
      'asset',
    ]) {
      await prisma.client.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE organization_id = ANY($1::text[])`,
        orgs,
      );
    }
    await prisma.client.$executeRawUnsafe(
      `DELETE FROM organization_ref WHERE id = ANY($1::text[])`,
      orgs,
    );
    await prisma.onModuleDestroy();
  });

  it('A → B: the new owner’s dossier lists no inherited reference, and A’s stay A’s own rows', async () => {
    const { assetId, documentId } = await machineWithDocument(org.a);
    expect(await documentsSeenBy(org.a, assetId)).toHaveLength(1);

    await transfer(assetId, org.a, org.b);

    // B starts with an empty documents list …
    expect(await documentsSeenBy(org.b, assetId)).toEqual([]);
    // … A's reference was not re-assigned: it is still A's row, and B has none.
    expect(await refsOf(assetId)).toEqual([{ document_id: documentId, organization_id: org.a }]);
    // A can no longer read the asset at all, so no read path shows it to anyone.
    await expect(asActor(manager(org.a), () => assets.dossier(assetId))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(asActor(manager(third), () => assets.dossier(assetId))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('no read path of the new owner carries the previous owner’s document: timeline, dossier timeline and counts', async () => {
    const { assetId, documentId } = await machineWithDocument(org.a);
    await transfer(assetId, org.a, org.b);

    // The timeline entry that names the document (its title is in the description) stays with A.
    expect(await documentTimelineOf(assetId)).toEqual([
      { organization_id: org.a, description: TITLE_A },
    ]);

    const timeline = await asActor(manager(org.b), () =>
      assets.timeline(assetId, { limit: 50 } as never),
    );
    const dossier = await asActor(manager(org.b), () => assets.dossier(assetId));
    for (const seen of [JSON.stringify(timeline), JSON.stringify(dossier)]) {
      expect(seen).not.toContain(TITLE_A);
      expect(seen).not.toContain(documentId);
    }
    expect(timeline.items.map((item) => item.category)).not.toContain('DOCUMENT');
    // The rest of the history did follow the asset (Q-66's decision is unchanged for it).
    expect(timeline.items.map((item) => item.category)).toEqual(
      expect.arrayContaining(['LIFECYCLE', 'TRANSFER']),
    );
  });

  it('the event that announces the transfer names no document', async () => {
    const { assetId, documentId } = await machineWithDocument(org.a);
    await transfer(assetId, org.a, org.b);

    const rows = await prisma.client.$queryRawUnsafe<{ event_name: string; payload: unknown }[]>(
      `SELECT event_name, payload FROM outbox_message
        WHERE aggregate_id = $1 AND event_name = 'ASSET_TRANSFERRED'`,
      assetId,
    );
    expect(rows).toHaveLength(1);
    const text = JSON.stringify(rows[0]!.payload);
    expect(text).not.toContain(documentId);
    expect(text).not.toContain(TITLE_A);
    expect(text).not.toContain('document');
  });

  it('B cannot attach A’s document (404, nothing written); B attaches its own and sees only that', async () => {
    const { assetId, documentId } = await machineWithDocument(org.a);
    await transfer(assetId, org.a, org.b);

    // document-service answers 404 to anyone but the owner: the fake does the same.
    await expect(
      asActor(manager(org.b), () =>
        assets.attachDocument(assetId, { documentId, kind: 'OTHER', title: 'تلاش' }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await refsOf(assetId)).toEqual([{ document_id: documentId, organization_id: org.a }]);

    const own = id('DOC');
    documents.ownedBy(own, org.b);
    await asActor(manager(org.b), () =>
      assets.attachDocument(assetId, { documentId: own, kind: 'OWNERSHIP_TITLE', title: TITLE_B }),
    );
    expect((await documentsSeenBy(org.b, assetId)).map((doc) => doc.title)).toEqual([TITLE_B]);
    expect(await refsOf(assetId)).toEqual([
      { document_id: documentId, organization_id: org.a },
      { document_id: own, organization_id: org.b },
    ]);
  });

  it('the new owner must attach its own ownership document to activate: the previous owner’s does not count', async () => {
    const { assetId } = await machineWithDocument(org.a);
    await transfer(assetId, org.a, org.b);

    const refused = await asActor(manager(org.b), async () =>
      assets.activate(assetId, {
        expectedVersion: (await assets.get(assetId)).version,
      }),
    ).catch((error: unknown) => error);
    expect(refused).toMatchObject({
      code: 'BUSINESS_RULE_VIOLATION',
      internalContext: expect.objectContaining({ rule: 'INCOMPLETE_DOSSIER' }),
    });
    expect(
      (refused as { internalContext: { missing: string[] } }).internalContext.missing,
    ).toContain('an ownership title or registration card');
  });

  it('round trip A → B → A: A sees its own references again (they are A’s rows); B’s stay B’s', async () => {
    const { assetId, documentId } = await machineWithDocument(org.a);
    await transfer(assetId, org.a, org.b);
    const own = id('DOC');
    documents.ownedBy(own, org.b);
    await asActor(manager(org.b), () =>
      assets.attachDocument(assetId, {
        documentId: own,
        kind: 'REGISTRATION_CARD',
        title: TITLE_B,
      }),
    );

    await transfer(assetId, org.b, org.a);

    // A's original reference is back in its dossier — it never left A's rows — and B's is not shown.
    expect((await documentsSeenBy(org.a, assetId)).map((doc) => doc.documentId)).toEqual([
      documentId,
    ]);
    expect(JSON.stringify(await documentsSeenBy(org.a, assetId))).not.toContain(TITLE_B);
    await expect(asActor(manager(org.b), () => assets.dossier(assetId))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await refsOf(assetId)).toEqual([
      { document_id: documentId, organization_id: org.a },
      { document_id: own, organization_id: org.b },
    ]);
  });

  it('a transfer leaves the other tenants’ references alone', async () => {
    const mine = await machineWithDocument(org.a);
    const theirs = await machineWithDocument(third);
    await transfer(mine.assetId, org.a, org.b);
    expect(await refsOf(theirs.assetId)).toEqual([
      { document_id: theirs.documentId, organization_id: third },
    ]);
    expect(await documentsSeenBy(third, theirs.assetId)).toHaveLength(1);
  });

  describe('commissioning is the current owner’s, by every way into service (#234 round 1)', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const version = async (organizationId: string, assetId: string) =>
      (await asActor(manager(organizationId), () => assets.get(assetId))).version;
    const withdraw = async (organizationId: string, assetId: string) =>
      asActor(manager(organizationId), async () =>
        assets.changeStatus(assetId, {
          status: 'OUT_OF_SERVICE',
          reason: 'خارج از سرویس',
          expectedVersion: await version(organizationId, assetId),
        }),
      );
    const putBack = async (organizationId: string, assetId: string) =>
      asActor(manager(organizationId), async () =>
        assets.changeStatus(assetId, {
          status: 'ACTIVE',
          reason: 'بازگشت',
          expectedVersion: await version(organizationId, assetId),
        }),
      );
    const record = (organizationId: string, assetId: string) =>
      asActor(manager(organizationId), () =>
        insurance.recordPolicy(assetId, {
          policyNumber: `POL-${ulid().slice(-8)}`,
          insurerName: 'بیمه نمونه',
          coverage: 'THIRD_PARTY',
          validFrom: new Date(Date.now() - DAY).toISOString(),
          validTo: new Date(Date.now() + 300 * DAY).toISOString(),
        }),
      );
    const missingOf = (error: unknown) =>
      (error as { internalContext?: { missing?: string[] } }).internalContext?.missing;

    it('REGISTERED → OUT_OF_SERVICE → ACTIVE is no way round activation: the new owner needs its own ownership document (and a policy) for the return too', async () => {
      const { assetId } = await machineWithDocument(org.a);
      await transfer(assetId, org.a, org.b);

      // REGISTERED → ACTIVE through the plain status route is refused, as before.
      await expect(putBack(org.b, assetId)).rejects.toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
      });
      // REGISTERED → OUT_OF_SERVICE is allowed (a machine can turn out to be unusable) …
      expect((await withdraw(org.b, assetId)).status).toBe('OUT_OF_SERVICE');
      // … but the return is a way into service, and runs the commissioning check.
      const refused = await putBack(org.b, assetId).catch((error: unknown) => error);
      expect(refused).toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
        internalContext: expect.objectContaining({ rule: 'INCOMPLETE_DOSSIER' }),
      });
      expect(missingOf(refused)).toContain('an ownership title or registration card');
      expect((await asActor(manager(org.b), () => assets.get(assetId))).status).toBe(
        'OUT_OF_SERVICE',
      );

      // B attaches its own document: still no policy.
      const documentId = id('DOC');
      documents.ownedBy(documentId, org.b);
      await asActor(manager(org.b), () =>
        assets.attachDocument(assetId, { documentId, kind: 'OWNERSHIP_TITLE', title: TITLE_B }),
      );
      const stillRefused = await putBack(org.b, assetId).catch((error: unknown) => error);
      expect(missingOf(stillRefused)).toEqual(['an insurance policy currently in force']);

      // With its own document and a policy the current owner may return the asset to service.
      await record(org.b, assetId);
      expect((await putBack(org.b, assetId)).status).toBe('ACTIVE');
    });

    it('the previous owner’s ownership document never satisfies the check, however the asset comes back', async () => {
      const { assetId } = await machineWithDocument(org.a);
      await record(org.a, assetId);
      await transfer(assetId, org.a, org.b);
      await withdraw(org.b, assetId);
      // A's in-force policy follows the vehicle (Q-66); A's document does not (Q-99).
      const refused = await putBack(org.b, assetId).catch((error: unknown) => error);
      expect(missingOf(refused)).toEqual(['an ownership title or registration card']);
      await expect(
        asActor(manager(org.b), async () =>
          assets.activate(assetId, { expectedVersion: await version(org.b, assetId) }),
        ),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    });

    it('an owner that commissioned its own asset withdraws and returns it with its dossier complete; IDLE → ACTIVE asks nothing more', async () => {
      const { assetId } = await machineWithDocument(org.a);
      await record(org.a, assetId);
      expect((await withdraw(org.a, assetId)).status).toBe('OUT_OF_SERVICE');
      expect((await putBack(org.a, assetId)).status).toBe('ACTIVE');

      // IDLE is reachable only from ACTIVE, so an IDLE asset was commissioned by its current owner.
      const idle = await machineWithDocument(org.a);
      await asActor(manager(org.a), async () =>
        assets.changeStatus(idle.assetId, {
          status: 'IDLE',
          reason: 'بی‌کار',
          expectedVersion: await version(org.a, idle.assetId),
        }),
      );
      expect((await putBack(org.a, idle.assetId)).status).toBe('ACTIVE');
    });

    it('an asset withdrawn from service whose dossier has since lost its policy is refused its return, with what is missing', async () => {
      const { assetId } = await machineWithDocument(org.a);
      await withdraw(org.a, assetId);
      const refused = await putBack(org.a, assetId).catch((error: unknown) => error);
      expect(missingOf(refused)).toEqual(['an insurance policy currently in force']);
    });
  });

  describe('the cost summary is the current owner’s own rows (#234 round 1)', () => {
    it('the previous owner’s DOCUMENT timeline rows and their amounts are not in the new owner’s dossier', async () => {
      const { assetId } = await machineWithDocument(org.a);
      await prisma.client.$executeRawUnsafe(
        `UPDATE asset_timeline_entry SET amount_minor = 5000000
          WHERE asset_id = $1 AND category = 'DOCUMENT'`,
        assetId,
      );
      const before = await asActor(manager(org.a), () => assets.dossier(assetId));
      expect(before.costs.totalMinor).toBe('5000000');

      await transfer(assetId, org.a, org.b);

      const after = await asActor(manager(org.b), () => assets.dossier(assetId));
      expect(after.costs.totalMinor).toBe('0');
      const own = await prisma.client.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM asset_timeline_entry
          WHERE asset_id = $1 AND organization_id = $2`,
        assetId,
        org.b,
      );
      expect(after.costs.entryCount).toBe(own[0]!.n);
      // A's DOCUMENT row is still A's, and is not counted for B.
      expect(await documentTimelineOf(assetId)).toEqual([
        { organization_id: org.a, description: TITLE_A },
      ]);
    });

    it('answers by organization in the query itself: asking as another organization sums nothing', async () => {
      const { assetId } = await machineWithDocument(org.a);
      expect((await repository.costSummary(assetId, third)).length).toBe(0);
      expect((await repository.costSummary(assetId, org.a)).length).toBeGreaterThan(0);
    });
  });
});
