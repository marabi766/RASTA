import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ulid } from 'ulid';
import { AssetRepository } from '../src/asset/asset.repository';
import { AssetService } from '../src/asset/asset.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { FakeDocuments, asActor, id, newPrisma, ownerDatabaseUrl, tenants } from './helpers';
import { clearingOwners } from './transfer-clearance.fake';

/**
 * The reconciliation runbook (docs/runbooks/asset-document-ref-reconciliation.md, Q-99) proven before
 * anyone uses it: its own SQL blocks — extracted from the document, so what is written is what is
 * tested — run on histories the legacy transfer left behind (every document reference and its
 * timeline entry carried to the receiving organization), A → B → C and A → B → A.
 */
describe('runbook: asset document reference reconciliation (#234 round 2)', () => {
  const org = tenants();
  const third = `ORG-ITEST-C-${ulid().slice(-10)}`;
  const orgs = [org.a, org.b, third];
  const RUNBOOK = resolve(__dirname, '../../../docs/runbooks/asset-document-ref-reconciliation.md');

  const block = (name: string): string => {
    const match = new RegExp('```sql ' + name + '\\n([\\s\\S]*?)```').exec(
      readFileSync(RUNBOOK, 'utf8'),
    );
    if (!match) throw new Error(`runbook has no \`sql ${name}\` block`);
    // `SET default_transaction_read_only` is for the operator's read-only session.
    return match[1]!
      .split('\n')
      .filter((line) => !line.startsWith('SET default_transaction_read_only'))
      .join('\n')
      .trim()
      .replace(/;$/, '');
  };

  let prisma: PrismaService;
  /** The runbook runs as the migrator role (it creates a temporary table), never the runtime role. */
  let owner: PrismaService;
  let repository: AssetRepository;
  let assets: AssetService;
  const documents = new FakeDocuments();

  const manager = (organizationId: string) => ({ organizationId, roles: ['FLEET_MANAGER'] });
  const admin = (organizationId: string) => ({
    organizationId,
    roles: ['ORGANIZATION_ADMIN'],
    userId: `USR-ADMIN-${organizationId.slice(-4)}`,
  });

  /** document id → who owns it in document-service (what runbook step 2 reads). */
  const owners = new Map<string, string>();
  /** reference id → document id */
  const refDocument = new Map<string, string>();

  async function attach(assetId: string, organizationId: string): Promise<string> {
    const documentId = id('DOC');
    documents.ownedBy(documentId, organizationId);
    owners.set(documentId, organizationId);
    const view = await asActor(manager(organizationId), () =>
      assets.attachDocument(assetId, {
        documentId,
        kind: 'OTHER',
        title: `سند ${organizationId.slice(-4)}`,
      }),
    );
    refDocument.set(view.id, documentId);
    return view.id;
  }

  const transfer = (assetId: string, from: string, to: string) =>
    asActor(admin(from), () =>
      assets.transfer(assetId, { toOrganizationId: to, reason: 'واگذاری آزمون' }),
    );

  /** What the legacy transfer left: every reference and DOCUMENT entry of the asset at `owner`. */
  const legacyCarry = async (assetId: string, to: string) => {
    await prisma.client.$executeRawUnsafe(
      `UPDATE asset_document_ref SET organization_id = $2 WHERE asset_id = $1`,
      assetId,
      to,
    );
    await prisma.client.$executeRawUnsafe(
      `UPDATE asset_timeline_entry SET organization_id = $2
        WHERE asset_id = $1 AND category = 'DOCUMENT'`,
      assetId,
      to,
    );
  };

  type Row = {
    ref_id: string;
    entry_id: string | null;
    current_org: string;
    entry_org: string | null;
  };

  const candidatesOf = async (assetId: string) =>
    (await prisma.client.$queryRawUnsafe<Row[]>(block('candidates'))).filter(
      (row) => row.ref_id && refsOfAsset.has(row.ref_id) && refsOfAsset.get(row.ref_id) === assetId,
    );
  const refsOfAsset = new Map<string, string>();

  /** Runs the runbook's steps 2–4 for `assetId` in one transaction, like the operator would. */
  async function repair(assetId: string) {
    const candidates = await candidatesOf(assetId);
    // Step 2: the owner of each document, from document-service.
    const verified = candidates.map((row) => ({
      ref: row.ref_id,
      owner: owners.get(refDocument.get(row.ref_id)!)!,
      current: row.current_org,
    }));
    const moved = verified.filter((v) => v.owner !== v.current);

    return owner.client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(block('load'));
      for (const v of verified) {
        await tx.$executeRawUnsafe(
          `INSERT INTO verified_owner (ref_id, document_owner) VALUES ($1, $2)`,
          v.ref,
          v.owner,
        );
      }
      const [counts] = await tx.$queryRawUnsafe<{ refs_fixed: number; entries_fixed: number }[]>(
        block('repair'),
      );
      const pairs = await tx.$queryRawUnsafe<unknown[]>(block('verify-pairs'));
      const ownersLeft = await tx.$queryRawUnsafe<unknown[]>(block('verify-owners'));
      return { counts: counts!, pairs, ownersLeft, moved: moved.length, verified };
    });
  }

  const orgOfRef = async (refId: string) =>
    (
      await prisma.client.$queryRawUnsafe<{ organization_id: string }[]>(
        `SELECT organization_id FROM asset_document_ref WHERE id = $1`,
        refId,
      )
    )[0]!.organization_id;
  const orgOfEntry = async (assetId: string, refId: string) =>
    (
      await prisma.client.$queryRawUnsafe<{ organization_id: string }[]>(
        `SELECT organization_id FROM asset_timeline_entry
          WHERE asset_id = $1 AND source_event_id = $2 AND category = 'DOCUMENT'`,
        assetId,
        refId,
      )
    )[0]!.organization_id;

  async function newAsset(organizationId: string) {
    const created = await asActor(manager(organizationId), () =>
      assets.create({ name: 'لودر آزمون', type: 'LOADER', specifications: {} } as never),
    );
    return created.id;
  }

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    owner = new PrismaService(ownerDatabaseUrl());
    await owner.onModuleInit();
    repository = new AssetRepository(prisma);
    assets = new AssetService(repository, undefined, clearingOwners(), documents);
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
    await owner.onModuleDestroy();
    await prisma.onModuleDestroy();
  });

  it('A → B → C: each reference AND its timeline entry go back to the document’s owner (A’s to A, B’s to B)', async () => {
    const assetId = await newAsset(org.a);
    const refA = await attach(assetId, org.a);
    await transfer(assetId, org.a, org.b);
    const refB = await attach(assetId, org.b);
    await transfer(assetId, org.b, third);
    // The legacy transfers carried everything to the receiver.
    await legacyCarry(assetId, third);
    for (const r of [refA, refB]) refsOfAsset.set(r, assetId);
    expect(await orgOfRef(refA)).toBe(third);
    expect(await orgOfEntry(assetId, refA)).toBe(third);

    const result = await repair(assetId);

    expect(result.verified).toHaveLength(2);
    expect(result.counts).toEqual({ refs_fixed: 2, entries_fixed: 2 });
    expect(result.pairs).toEqual([]);
    expect(result.ownersLeft).toEqual([]);
    // The previous procedure restored the reference to A but the entry to B: here both are paired.
    expect(await orgOfRef(refA)).toBe(org.a);
    expect(await orgOfEntry(assetId, refA)).toBe(org.a);
    expect(await orgOfRef(refB)).toBe(org.b);
    expect(await orgOfEntry(assetId, refB)).toBe(org.b);
  });

  it('A → B → A: A’s rows are legitimately A’s and untouched; B’s own document goes back to B; the post-check accepts the round trip', async () => {
    const assetId = await newAsset(org.a);
    const refA = await attach(assetId, org.a);
    await transfer(assetId, org.a, org.b);
    const refB = await attach(assetId, org.b);
    await transfer(assetId, org.b, org.a);
    await legacyCarry(assetId, org.a);
    for (const r of [refA, refB]) refsOfAsset.set(r, assetId);

    // The candidate list still shows A's own row (an old "list must be empty" check would fail) …
    expect((await candidatesOf(assetId)).map((row) => row.ref_id)).toEqual(
      expect.arrayContaining([refA, refB]),
    );

    const result = await repair(assetId);

    // … but only B's was wrong.
    expect(result.counts).toEqual({ refs_fixed: 1, entries_fixed: 1 });
    expect(result.pairs).toEqual([]);
    expect(result.ownersLeft).toEqual([]);
    expect(await orgOfRef(refA)).toBe(org.a);
    expect(await orgOfEntry(assetId, refA)).toBe(org.a);
    expect(await orgOfRef(refB)).toBe(org.b);
    expect(await orgOfEntry(assetId, refB)).toBe(org.b);
  });

  it('running it twice changes nothing the second time, and no row is deleted', async () => {
    const assetId = await newAsset(org.a);
    const refA = await attach(assetId, org.a);
    await transfer(assetId, org.a, org.b);
    await legacyCarry(assetId, org.b);
    refsOfAsset.set(refA, assetId);

    const count = async () =>
      (
        await prisma.client.$queryRawUnsafe<{ n: number }[]>(
          `SELECT (SELECT count(*) FROM asset_document_ref WHERE asset_id = $1)::int
                + (SELECT count(*) FROM asset_timeline_entry WHERE asset_id = $1)::int AS n`,
          assetId,
        )
      )[0]!.n;
    const before = await count();
    expect((await repair(assetId)).counts).toEqual({ refs_fixed: 1, entries_fixed: 1 });
    expect((await repair(assetId)).counts).toEqual({ refs_fixed: 0, entries_fixed: 0 });
    expect(await count()).toBe(before);
    expect(await orgOfRef(refA)).toBe(org.a);
  });
});
