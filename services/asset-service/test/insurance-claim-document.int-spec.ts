import { ulid } from 'ulid';
import { runUnscoped } from '@rasta/nest-common';
import { AssetRepository } from '../src/asset/asset.repository';
import { AssetService } from '../src/asset/asset.service';
import { InsuranceService } from '../src/insurance/insurance.service';
import { ClaimService } from '../src/insurance/claim.service';
import { INSURANCE_EVENTS } from '../src/asset/events';
import type { PrismaService } from '../src/prisma/prisma.service';
import { FakeDocuments, asActor, id, newPrisma, tenants } from './helpers';
import { clearingOwners } from './transfer-clearance.fake';

/**
 * Documents on an insurance claim (COM-010 criterion 2, docs/24 Q-128), against a
 * real PostgreSQL and the real services; document-service is the only fake.
 *
 *   1. The reference, its outbox event and its dossier line commit together, and
 *      the claim read lists the reference.
 *   2. **No oracle.** Another organization's document, a missing one and one
 *      registered for another machine are the same `404 Document`; another
 *      organization's claim is a `404` before document-service is asked at all.
 *   3. The rules the database enforces under concurrency: one reference per
 *      document, at most twenty per claim.
 *   4. A transfer moves the claim and leaves the references with their owner.
 */
describe('documents on an insurance claim (Q-128)', () => {
  const org = tenants();
  const third = `ORG-ITEST-C-${ulid().slice(-10)}`;
  const orgs = [org.a, org.b, third];
  const day = 86_400_000;

  let prisma: PrismaService;
  let repository: AssetRepository;
  let assets: AssetService;
  let insurance: InsuranceService;
  let claims: ClaimService;
  const documents = new FakeDocuments();

  const manager = (organizationId: string) => ({ organizationId, roles: ['FLEET_MANAGER'] });
  const admin = (organizationId: string) => ({
    organizationId,
    roles: ['ORGANIZATION_ADMIN'],
    userId: `USR-ADMIN-${organizationId.slice(-4)}`,
  });

  async function machine(organizationId: string): Promise<string> {
    const created = await asActor(manager(organizationId), () =>
      assets.create({ name: 'لودر آزمون', type: 'LOADER', specifications: {} } as never),
    );
    return created.id;
  }

  /** An open claim of `organizationId` on a fresh machine. */
  async function openClaim(organizationId: string) {
    const assetId = await machine(organizationId);
    const policy = await asActor(manager(organizationId), () =>
      insurance.recordPolicy(assetId, {
        policyNumber: `POL-${id('P').slice(-8)}`,
        insurerName: 'بیمه نمونه',
        coverage: 'COMPREHENSIVE',
        validFrom: new Date(Date.now() - 100 * day).toISOString(),
        validTo: new Date(Date.now() + 200 * day).toISOString(),
      }),
    );
    const claim = await asActor(manager(organizationId), () =>
      claims.submitClaim(assetId, {
        policyId: policy.id,
        description: 'برخورد با مانع در جاده روستایی، آسیب به بدنه',
        incidentAt: new Date(Date.now() - 5 * day).toISOString(),
      }),
    );
    return { assetId, claimId: claim.id };
  }

  const attach = (organizationId: string, assetId: string, claimId: string, documentId: string) =>
    asActor(manager(organizationId), () => claims.attachDocument(assetId, claimId, { documentId }));

  const rowsOf = (claimId: string) =>
    prisma.client.$queryRawUnsafe<{ document_id: string; organization_id: string }[]>(
      `SELECT document_id, organization_id FROM insurance_claim_document WHERE claim_id = $1
        ORDER BY created_at, id`,
      claimId,
    );

  const outboxFor = (aggregateId: string) =>
    runUnscoped('the outbox audit reads platform plumbing', () =>
      prisma.client.outboxMessage.findMany({
        where: { aggregateId },
        orderBy: { createdAt: 'asc' },
      }),
    );

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    repository = new AssetRepository(prisma);
    assets = new AssetService(repository, undefined, clearingOwners(), documents);
    insurance = new InsuranceService(repository, assets, 30);
    claims = new ClaimService(repository, assets, {
      decisionRoles: ['ORGANIZATION_ADMIN'],
      approvalCeilingMinor: null,
    });
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
      'insurance_claim_document',
      'insurance_claim',
      'insurance_policy',
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

  it('attaches a document: one row, one event on the claim’s stream, one dossier line, listed on the read', async () => {
    const { assetId, claimId } = await openClaim(org.a);
    const documentId = id('DOC');

    const view = await attach(org.a, assetId, claimId, documentId);
    expect(view.documentId).toBe(documentId);
    expect(await rowsOf(claimId)).toEqual([{ document_id: documentId, organization_id: org.a }]);

    const events = (await outboxFor(claimId)).map((e) => e.eventName);
    expect(events).toEqual([
      INSURANCE_EVENTS.INSURANCE_CLAIM_OPENED,
      INSURANCE_EVENTS.INSURANCE_CLAIM_DOCUMENT_ATTACHED,
    ]);
    const attached = (await outboxFor(claimId))[1];
    expect(attached).toMatchObject({ topic: 'rasta.insurance.v1', organizationId: org.a });
    expect(Number(attached?.streamSeq)).toBe(2);
    expect((attached?.payload as { payload?: unknown }).payload).toMatchObject({
      claimId,
      documentId,
      organizationId: org.a,
    });

    const detail = await asActor(manager(org.a), () => claims.getClaim(assetId, claimId));
    expect(detail.documents.map((d) => d.documentId)).toEqual([documentId]);
    // An attachment is not a status: the claim's history is unchanged.
    expect(detail.history.map((h) => h.status)).toEqual(['SUBMITTED']);

    // The dossier says a document was added, with the claim and without the file name.
    const lines = await prisma.client.$queryRawUnsafe<{ detail: { claimId?: string } }[]>(
      `SELECT detail FROM asset_timeline_entry WHERE asset_id = $1 AND category = 'DOCUMENT'`,
      assetId,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.detail.claimId).toBe(claimId);
  });

  describe('no existence oracle', () => {
    it('answers the same 404 for another organization’s document, a missing one and one of another machine', async () => {
      const { assetId, claimId } = await openClaim(org.a);
      const other = await openClaim(org.a);

      const foreign = id('DOC');
      documents.ownedBy(foreign, org.b);
      const missing = id('DOC');
      documents.missing(missing);
      const ofAnotherMachine = id('DOC');
      documents.ownedBy(ofAnotherMachine, org.a, {
        ownerResourceType: 'Asset',
        ownerResourceId: other.assetId,
      });

      const refusals = [];
      for (const documentId of [foreign, missing, ofAnotherMachine]) {
        refusals.push(
          await attach(org.a, assetId, claimId, documentId).then(
            () => null,
            (error: { code: string; message: string; httpStatus?: number }) => error,
          ),
        );
      }
      expect(refusals.every((r) => r?.code === 'NOT_FOUND')).toBe(true);
      // Indistinguishable: the same code, status and text, whichever it was.
      expect(new Set(refusals.map((r) => `${r?.code}|${r?.httpStatus}|${r?.message}`)).size).toBe(
        1,
      );
      expect(await rowsOf(claimId)).toEqual([]);
      expect((await outboxFor(claimId)).map((e) => e.eventName)).toEqual([
        INSURANCE_EVENTS.INSURANCE_CLAIM_OPENED,
      ]);
    });

    it('asks document-service as the machine’s organization, never as the caller’s claim of it', async () => {
      const { assetId, claimId } = await openClaim(org.a);
      const documentId = id('DOC');
      documents.asked.length = 0;
      await attach(org.a, assetId, claimId, documentId);
      expect(documents.asked).toEqual([{ documentId, organizationId: org.a }]);
    });

    it('does not attach to, list or learn anything about another organization’s claim', async () => {
      const { assetId, claimId } = await openClaim(org.a);
      const documentId = id('DOC');
      await attach(org.a, assetId, claimId, documentId);

      documents.asked.length = 0;
      await expect(attach(org.b, assetId, claimId, id('DOC'))).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(
        asActor(manager(org.b), () => claims.getClaim(assetId, claimId)),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // Refused before document-service was asked anything.
      expect(documents.asked).toEqual([]);

      // Org B's own claim: A's claim id under B's asset is a 404 too.
      const own = await openClaim(org.b);
      await expect(attach(org.b, own.assetId, claimId, id('DOC'))).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      expect(await rowsOf(claimId)).toHaveLength(1);
    });
  });

  it('fails closed when document-service is unavailable: nothing is attached', async () => {
    const { assetId, claimId } = await openClaim(org.a);
    documents.unavailable();
    try {
      await expect(attach(org.a, assetId, claimId, id('DOC'))).rejects.toMatchObject({
        code: expect.stringMatching(/UPSTREAM/),
      });
    } finally {
      documents.unavailable(false);
    }
    expect(await rowsOf(claimId)).toEqual([]);
  });

  it('attaching the same document twice, even at once, is one reference and one event', async () => {
    const { assetId, claimId } = await openClaim(org.a);
    const documentId = id('DOC');

    const results = await Promise.all([
      attach(org.a, assetId, claimId, documentId),
      attach(org.a, assetId, claimId, documentId),
      attach(org.a, assetId, claimId, documentId),
    ]);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await rowsOf(claimId)).toHaveLength(1);
    expect(
      (await outboxFor(claimId)).filter(
        (e) => e.eventName === INSURANCE_EVENTS.INSURANCE_CLAIM_DOCUMENT_ATTACHED,
      ),
    ).toHaveLength(1);
  });

  it('takes at most twenty documents, even when the last ones race', async () => {
    const { assetId, claimId } = await openClaim(org.a);
    for (let i = 0; i < 18; i += 1) await attach(org.a, assetId, claimId, id('DOC'));

    const settled = await Promise.allSettled([
      attach(org.a, assetId, claimId, id('DOC')),
      attach(org.a, assetId, claimId, id('DOC')),
      attach(org.a, assetId, claimId, id('DOC')),
      attach(org.a, assetId, claimId, id('DOC')),
    ]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(2);
    const refused = settled.filter((s) => s.status === 'rejected') as PromiseRejectedResult[];
    expect(refused).toHaveLength(2);
    for (const r of refused) {
      expect(r.reason).toMatchObject({
        internalContext: expect.objectContaining({ rule: 'CLAIM_DOCUMENT_LIMIT' }),
      });
    }
    expect(await rowsOf(claimId)).toHaveLength(20);
  });

  it('takes no document once the claim is decided', async () => {
    const { assetId, claimId } = await openClaim(org.a);
    await attach(org.a, assetId, claimId, id('DOC'));
    await asActor(admin(org.a), () => claims.startReview(assetId, claimId, {}));
    await asActor(admin(org.a), () =>
      claims.decide(assetId, claimId, { decision: 'REJECTED', notes: 'خارج از پوشش' }),
    );

    await expect(attach(org.a, assetId, claimId, id('DOC'))).rejects.toMatchObject({
      internalContext: expect.objectContaining({ rule: 'CLAIM_NOT_OPEN_FOR_DOCUMENTS' }),
    });
    expect(await rowsOf(claimId)).toHaveLength(1);
  });

  it('a transfer moves the claim, not the references: the new owner reads it without the previous owner’s files', async () => {
    const { assetId, claimId } = await openClaim(org.a);
    const documentId = id('DOC');
    await attach(org.a, assetId, claimId, documentId);
    // A transfer waits for open claims to be closed out.
    await asActor(admin(org.a), () => claims.startReview(assetId, claimId, {}));
    await asActor(admin(org.a), () =>
      claims.decide(assetId, claimId, { decision: 'REJECTED', notes: 'خارج از پوشش' }),
    );

    await asActor(admin(org.a), () =>
      assets.transfer(assetId, { toOrganizationId: org.b, reason: 'واگذاری آزمون' }),
    );

    const seenByNewOwner = await asActor(manager(org.b), () => claims.getClaim(assetId, claimId));
    expect(seenByNewOwner.id).toBe(claimId);
    expect(seenByNewOwner.documents).toEqual([]);
    // The previous owner's row is still its own.
    expect(await rowsOf(claimId)).toEqual([{ document_id: documentId, organization_id: org.a }]);
  });
});
