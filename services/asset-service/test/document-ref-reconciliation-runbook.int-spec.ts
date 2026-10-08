import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ulid } from 'ulid';
import { AssetRepository } from '../src/asset/asset.repository';
import { AssetService } from '../src/asset/asset.service';
import { InsuranceService } from '../src/insurance/insurance.service';
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

  /** A runbook SQL block, byte for byte: no line is stripped, nothing is reworded. */
  const block = (name: string): string => {
    const match = new RegExp('```sql ' + name + '\\n([\\s\\S]*?)```').exec(
      readFileSync(RUNBOOK, 'utf8'),
    );
    if (!match) throw new Error(`runbook has no \`sql ${name}\` block`);
    return match[1]!;
  };

  /** The operator's session: `psql` as the migrator role, stopping at the first error. */
  const psqlArgs = (): string[] => {
    const url = new URL(ownerDatabaseUrl());
    url.search = '';
    return ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-F', '|', url.toString()];
  };

  /** A long-lived psql session: send text, wait for an `\echo` marker, finish. */
  function startPsql() {
    const child = spawn('psql', psqlArgs(), { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const watchers: (() => void)[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      watchers.forEach((notify) => notify());
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    const done = new Promise<string>((resolveDone, reject) => {
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolveDone(out) : reject(new Error(`psql exited ${code}: ${err}`)),
      );
    });
    return {
      send: (text: string) => child.stdin.write(text + '\n'),
      end: () => child.stdin.end(),
      kill: () => child.kill(),
      done,
      waitFor: (marker: string) =>
        new Promise<void>((resolveWait, reject) => {
          const check = () => {
            if (out.includes(marker)) resolveWait();
          };
          watchers.push(check);
          child.on('close', () => reject(new Error(`psql ended before ${marker}: ${err}`)));
          check();
        }),
    };
  }

  const runPsql = (script: string): Promise<string> => {
    const session = startPsql();
    session.send(script);
    session.end();
    return session.done;
  };

  /** Splits psql output on the `\echo @@name` markers a script prints between its queries. */
  const sections = (output: string): Record<string, string[][]> => {
    const result: Record<string, string[][]> = {};
    let current: string[][] | undefined;
    for (const line of output.split('\n')) {
      if (line.startsWith('@@')) {
        current = result[line.slice(2)] = [];
      } else if (line !== '' && current) {
        current.push(line.split('|'));
      }
    }
    return result;
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

  async function attach(
    assetId: string,
    organizationId: string,
    kind: 'OTHER' | 'OWNERSHIP_TITLE' = 'OTHER',
  ): Promise<string> {
    const documentId = id('DOC');
    documents.ownedBy(documentId, organizationId);
    owners.set(documentId, organizationId);
    const view = await asActor(manager(organizationId), () =>
      assets.attachDocument(assetId, {
        documentId,
        kind,
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

  /** Step 1, as the operator runs it: the `candidates` block in a psql session of its own. */
  const candidatesOf = async (assetId: string): Promise<Row[]> =>
    (await runPsql(block('candidates')))
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => {
        const [refId, rowAsset, , currentOrg, entryId, entryOrg] = line.split('|');
        return {
          ref_id: refId!,
          asset_id: rowAsset!,
          entry_id: entryId || null,
          current_org: currentOrg!,
          entry_org: entryOrg || null,
        };
      })
      .filter((row) => refsOfAsset.get(row.ref_id) === assetId);
  const refsOfAsset = new Map<string, string>();

  const insertOwners = (rows: { ref: string; owner: string }[]) =>
    rows
      .map(
        (v) =>
          `INSERT INTO verified_owner (ref_id, document_owner) VALUES ('${v.ref}', '${v.owner}');`,
      )
      .join('\n');

  /**
   * Runs the runbook's step 3 and 4 for `assetId` the way the operator would: one psql session, the
   * blocks verbatim — read-only switched off, BEGIN, the lock fence, temp tables, repair, the three
   * checks, COMMIT.
   */
  async function repair(assetId: string) {
    const candidates = await candidatesOf(assetId);
    // Step 2: the owner of each document, from document-service.
    const verified = candidates.map((row) => ({
      ref: row.ref_id,
      owner: owners.get(refDocument.get(row.ref_id)!)!,
      current: row.current_org,
    }));
    const moved = verified.filter((v) => v.owner !== v.current);

    const output = sections(
      await runPsql(
        [
          block('begin'),
          block('load'),
          block('load-returned'),
          insertOwners(verified),
          '\\echo @@repair',
          block('repair'),
          '\\echo @@pairs',
          block('verify-pairs'),
          '\\echo @@owners',
          block('verify-owners'),
          '\\echo @@markers',
          block('verify-markers'),
          block('commit'),
        ].join('\n'),
      ),
    );
    const [refsFixed, entriesFixed, markersCleared, assetsReturned] =
      output.repair![0]!.map(Number);
    return {
      counts: {
        refs_fixed: refsFixed,
        entries_fixed: entriesFixed,
        markers_cleared: markersCleared,
        assets_returned: assetsReturned,
      },
      pairs: output.pairs!,
      ownersLeft: output.owners!,
      markersLeft: output.markers!.map((row) => row[0]!),
      moved: moved.length,
      verified,
    };
  }

  const markerOf = async (assetId: string) =>
    (
      await prisma.client.$queryRawUnsafe<{ marker: string | null }[]>(
        `SELECT commissioned_for_organization_id AS marker FROM asset WHERE id = $1`,
        assetId,
      )
    )[0]!.marker;
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
    expect(result.counts).toEqual({
      refs_fixed: 2,
      entries_fixed: 2,
      markers_cleared: 0,
      assets_returned: 1,
    });
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
    expect(result.counts).toEqual({
      refs_fixed: 1,
      entries_fixed: 1,
      markers_cleared: 0,
      assets_returned: 1,
    });
    expect(result.pairs).toEqual([]);
    expect(result.ownersLeft).toEqual([]);
    expect(await orgOfRef(refA)).toBe(org.a);
    expect(await orgOfEntry(assetId, refA)).toBe(org.a);
    expect(await orgOfRef(refB)).toBe(org.b);
    expect(await orgOfEntry(assetId, refB)).toBe(org.b);
  });

  it('a reference created in the very millisecond of the transfer is a candidate too, and is repaired (#234 round 3)', async () => {
    const assetId = await newAsset(org.a);
    const refA = await attach(assetId, org.a);
    await transfer(assetId, org.a, org.b);
    await legacyCarry(assetId, org.b);
    // Both columns are TIMESTAMP(3): the owner comparison decides, not the order of two equal instants.
    await prisma.client.$executeRawUnsafe(
      `UPDATE asset_document_ref r SET created_at = t.transferred_at
         FROM asset_transfer t WHERE r.id = $1 AND t.asset_id = r.asset_id`,
      refA,
    );
    refsOfAsset.set(refA, assetId);
    const [equal] = await prisma.client.$queryRawUnsafe<{ same: boolean }[]>(
      `SELECT r.created_at = t.transferred_at AS same
         FROM asset_document_ref r JOIN asset_transfer t ON t.asset_id = r.asset_id WHERE r.id = $1`,
      refA,
    );
    expect(equal!.same).toBe(true);

    expect((await candidatesOf(assetId)).map((row) => row.ref_id)).toEqual([refA]);
    const result = await repair(assetId);

    expect(result.counts).toEqual({
      refs_fixed: 1,
      entries_fixed: 1,
      markers_cleared: 0,
      assets_returned: 1,
    });
    expect(result.pairs).toEqual([]);
    expect(await orgOfRef(refA)).toBe(org.a);
    expect(await orgOfEntry(assetId, refA)).toBe(org.a);
  });

  it('the recipient activated with the legacy moved reference before the reconciliation: the repair clears its marker and the post-check is empty (#234 round 9)', async () => {
    const assetId = await newAsset(org.a);
    const refA = await attach(assetId, org.a, 'OWNERSHIP_TITLE');
    await prisma.client.$executeRawUnsafe(
      `UPDATE asset SET status = 'ACTIVE'::"OperationalStatus", commissioned_at = now() WHERE id = $1`,
      assetId,
    );
    await transfer(assetId, org.a, org.b);
    // The legacy transfer moved A's ownership title to B …
    await legacyCarry(assetId, org.b);
    refsOfAsset.set(refA, assetId);
    // … and B, before the runbook ran, put the asset into service with it: the marker is B's.
    const insurance = new InsuranceService(repository, assets, 30);
    await asActor(manager(org.b), () =>
      insurance.recordPolicy(assetId, {
        policyNumber: `POL-${ulid().slice(-8)}`,
        insurerName: 'بیمه نمونه',
        coverage: 'THIRD_PARTY',
        validFrom: new Date(Date.now() - 86_400_000).toISOString(),
        validTo: new Date(Date.now() + 86_400_000 * 300).toISOString(),
      }),
    );
    await asActor(manager(org.b), async () =>
      assets.activate(assetId, {
        expectedVersion: (await assets.get(assetId)).version,
      }),
    );
    expect(await markerOf(assetId)).toBe(org.b);

    const result = await repair(assetId);

    // The reference went back to A, and with it the marker B earned from it.
    expect(result.counts).toEqual({
      refs_fixed: 1,
      entries_fixed: 1,
      markers_cleared: 1,
      assets_returned: 1,
    });
    expect(result.markersLeft).toEqual([]);
    expect(await orgOfRef(refA)).toBe(org.a);
    expect(await markerOf(assetId)).toBeNull();
  });

  /** Step 4's marker check, as the operator runs it: in the repair's transaction, with its temporary tables. */
  const markerCheck = async (
    returned: { assetId: string; ownership: boolean }[],
  ): Promise<string[]> => {
    const output = sections(
      await runPsql(
        [
          block('begin'),
          block('load'),
          block('load-returned'),
          ...returned.map(
            (r) =>
              `INSERT INTO returned_asset (asset_id, returned_ownership) VALUES ('${r.assetId}', ${r.ownership});`,
          ),
          '\\echo @@markers',
          block('verify-markers'),
          block('commit'),
        ].join('\n'),
      ),
    );
    return output.markers!.map((row) => row[0]!);
  };

  /** B’s own title and A’s misplaced other-kind reference: B’s marker is B’s (#234 round 11). */
  async function misplacedOtherWithOwnTitle(ownTitle: boolean) {
    const assetId = await newAsset(org.a);
    const refA = await attach(assetId, org.a); // OTHER
    await transfer(assetId, org.a, org.b);
    await legacyCarry(assetId, org.b);
    const refB = ownTitle ? await attach(assetId, org.b, 'OWNERSHIP_TITLE') : undefined;
    for (const r of [refA, refB]) if (r) refsOfAsset.set(r, assetId);
    await prisma.client.$executeRawUnsafe(
      `UPDATE asset SET commissioned_for_organization_id = $2 WHERE id = $1`,
      assetId,
      org.b,
    );
    return { assetId, refA };
  }

  it('the post-check names a returned asset that still has a marker', async () => {
    const assetId = await newAsset(org.a);
    const refA = await attach(assetId, org.a);
    await transfer(assetId, org.a, org.b);
    refsOfAsset.set(refA, assetId);
    await prisma.client.$executeRawUnsafe(
      `UPDATE asset SET commissioned_for_organization_id = $2 WHERE id = $1`,
      assetId,
      org.b,
    );

    expect(await markerCheck([{ assetId, ownership: true }])).toContain(assetId);
  });

  it('A’s misplaced OTHER reference returned and B holds its own title: B’s marker is kept and the post-check accepts it (#234 round 11)', async () => {
    const { assetId, refA } = await misplacedOtherWithOwnTitle(true);

    const result = await repair(assetId);

    expect(result.counts).toEqual({
      refs_fixed: 1,
      entries_fixed: 1,
      markers_cleared: 0,
      assets_returned: 1,
    });
    expect(result.markersLeft).toEqual([]);
    expect(await orgOfRef(refA)).toBe(org.a);
    expect(await markerOf(assetId)).toBe(org.b);
    // Even told the returned reference was an ownership document, B's own title keeps the marker valid.
    expect(await markerCheck([{ assetId, ownership: true }])).toEqual([]);
  });

  it('only an other-kind reference returned and B has no title of its own: the marker is kept (rule (a)) (#234 round 11)', async () => {
    const { assetId } = await misplacedOtherWithOwnTitle(false);

    const result = await repair(assetId);

    expect(result.counts.markers_cleared).toBe(0);
    expect(result.markersLeft).toEqual([]);
    expect(await markerOf(assetId)).toBe(org.b);
  });

  it('the repair’s lock fence: no other session can read asset_document_ref or asset between BEGIN and COMMIT (#234 round 11)', async () => {
    const session = startPsql();
    try {
      session.send([block('begin'), '\\echo @@locked'].join('\n'));
      await session.waitFor('@@locked');

      for (const table of ['asset_document_ref', 'asset']) {
        await expect(
          prisma.client.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '500ms'`);
            return tx.$queryRawUnsafe(`SELECT count(*) FROM ${table}`);
          }),
        ).rejects.toThrow(/lock timeout/);
      }

      session.send(block('commit'));
      session.end();
      await session.done;
    } finally {
      session.kill();
    }

    // Released at COMMIT.
    await expect(
      prisma.client.$queryRawUnsafe(`SELECT count(*) FROM asset_document_ref`),
    ).resolves.toBeDefined();
  });

  it('the post-check leaves alone a marker legitimately earned and whose document was later removed (not returned in this run) (#234 round 10)', async () => {
    const assetId = await newAsset(org.a);
    await transfer(assetId, org.a, org.b);
    // B earned the marker with its own title, then removed it: no document is left, yet it is B's to keep.
    await prisma.client.$executeRawUnsafe(
      `UPDATE asset SET commissioned_for_organization_id = $2 WHERE id = $1`,
      assetId,
      org.b,
    );

    expect(await markerCheck([])).not.toContain(assetId);
    expect(await markerOf(assetId)).toBe(org.b);
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
    expect((await repair(assetId)).counts).toEqual({
      refs_fixed: 1,
      entries_fixed: 1,
      markers_cleared: 0,
      assets_returned: 1,
    });
    expect((await repair(assetId)).counts).toEqual({
      refs_fixed: 0,
      entries_fixed: 0,
      markers_cleared: 0,
      assets_returned: 0,
    });
    expect(await count()).toBe(before);
    expect(await orgOfRef(refA)).toBe(org.a);
  });

  it('the preflight refuses while another session is on the asset database, and passes once it is alone (#234 round 10)', async () => {
    // The runtime pool and this suite's own owner pool are other sessions: the check refuses.
    await expect(owner.client.$executeRawUnsafe(block('preflight'))).rejects.toThrow(
      /not quiesced/,
    );

    // Alone: close every other connection of this suite, keep one connection as the operator's session.
    await prisma.onModuleDestroy();
    await owner.onModuleDestroy();
    const url = new URL(ownerDatabaseUrl());
    url.searchParams.set('connection_limit', '1');
    const operator = new PrismaService(url.toString());
    await operator.onModuleInit();
    try {
      await expect(operator.client.$executeRawUnsafe(block('preflight'))).resolves.toBeDefined();
    } finally {
      await operator.onModuleDestroy();
      // afterAll cleans up through these two.
      prisma = newPrisma();
      await prisma.onModuleInit();
      owner = new PrismaService(ownerDatabaseUrl());
      await owner.onModuleInit();
    }
  });
});
