import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from '../src/prisma/prisma.service';
import { id, ownerDatabaseUrl, tenants } from './helpers';

/**
 * The backfill of migration 20261007120000_asset_commissioned_for_organization against rows made
 * the OLD way (#234 round 4): `commissioned_at` set, `commissioned_for_organization_id` NULL.
 * Round 7: a TRANSFERRED asset gets its owner only where its own timeline proves the current owner
 * activated it after the latest transfer (`ASSET_ACTIVATED`, `recorded_at` > `transferred_at`).
 *
 * The migration's own UPDATE statements — read from the shipped file, not restated here — are run as
 * the owner against ISOLATED copies of the tables: inside one transaction a throwaway schema is
 * created, `asset`, `asset_transfer` and `asset_timeline_entry` are cloned into it (LIKE public.… INCLUDING ALL), the five
 * fixture rows go there, and `SET LOCAL search_path` points the unqualified statement at the
 * copies. The transaction is rolled back. The statement is UNSCOPED (it rewrites every matching
 * row), so it must never run against public.asset on the shared dev database: that would lock and
 * rewrite every real commissioned asset until the rollback. The executing test therefore checks the
 * guard (`escapesTheScratchSchema`) on the statement immediately before running it, so a failing
 * guard means the statement never runs; a separate test shows the guard does reject qualified SQL.
 */

/**
 * Whether a statement could reach a table outside the scratch schema: a relation after UPDATE /
 * FROM / JOIN / INTO that carries a schema prefix ("public"."asset", public.asset), or the word
 * `public` at all.
 */
function escapesTheScratchSchema(sql: string | undefined): boolean {
  if (sql === undefined) return true;
  return (
    /\b(?:UPDATE|FROM|JOIN|INTO)\s+(?:ONLY\s+)?(?:"[^"]+"|\w+)\s*\./i.test(sql) ||
    /\bpublic\b/i.test(sql)
  );
}

describe('commissioned_for_organization_id backfill (20261007120000)', () => {
  const org = tenants();
  const migration = readFileSync(
    join(
      __dirname,
      '../prisma/migrations/20261007120000_asset_commissioned_for_organization/migration.sql',
    ),
    'utf8',
  );
  const backfills = [...migration.matchAll(/UPDATE "asset" a[\s\S]*?;/g)].map((match) => match[0]);

  const old = id('AST'); // never transferred
  const transferred = id('AST'); // one transfer: generation 1 and a transfer row
  const orphanTransfer = id('AST'); // generation 0 but a transfer row exists
  const advancedGeneration = id('AST'); // a transfer row is missing but the generation moved
  const neverCommissioned = id('AST');
  // Transferred to org.a two hours ago; what the timeline says about the activation decides.
  const proven = id('AST'); // ASSET_ACTIVATED for the owner, recorded after the transfer
  const beforeTransfer = id('AST'); // ASSET_ACTIVATED recorded before the transfer (re-stamped)
  const forgedInstant = id('AST'); // recorded before, but occurred_at claims after
  const otherOwner = id('AST'); // activated after the transfer, but for another organization
  const statusOnly = id('AST'); // a status change to ACTIVE after the transfer, no ASSET_ACTIVATED
  const noTransferRow = id('AST'); // generation moved, no transfer row: no instant to compare with
  const ids = [
    old,
    transferred,
    orphanTransfer,
    advancedGeneration,
    neverCommissioned,
    proven,
    beforeTransfer,
    forgedInstant,
    otherOwner,
    statusOnly,
    noTransferRow,
  ];

  let owner: PrismaService;

  beforeAll(async () => {
    owner = new PrismaService(ownerDatabaseUrl());
    await owner.onModuleInit();
  });

  afterAll(async () => {
    await owner.onModuleDestroy();
  });

  it('the guard rejects schema-qualified SQL, so it cannot pass vacuously', () => {
    expect(escapesTheScratchSchema(undefined)).toBe(true);
    for (const qualified of [
      'UPDATE "asset" a SET x = 1 WHERE NOT EXISTS (SELECT 1 FROM public.asset_transfer t)',
      'UPDATE "asset" a SET x = 1 FROM public.asset_transfer t',
      'UPDATE "public"."asset" a SET x = 1',
      'UPDATE "asset" a SET x = 1 FROM "public"."asset_transfer" t',
      'UPDATE asset a SET x = 1 JOIN other.asset_transfer t ON true',
      'INSERT INTO other.asset SELECT 1',
      'UPDATE "asset" a SET x = (SELECT 1 FROM "asset_transfer" t WHERE t.n = public.f())',
    ]) {
      expect(escapesTheScratchSchema(qualified)).toBe(true);
    }
    expect(
      escapesTheScratchSchema(
        'UPDATE "asset" a SET x = 1 WHERE NOT EXISTS (SELECT 1 FROM "asset_transfer" t WHERE t.asset_id = a.id)',
      ),
    ).toBe(false);
  });

  it('the shipped statement is unscoped and names its tables unqualified, so the scratch search_path decides what it touches', () => {
    expect(backfills).toHaveLength(2);
    for (const statement of backfills) expect(escapesTheScratchSchema(statement)).toBe(false);
  });

  it('gives a never-transferred commissioned row its owner, and a transferred row only when its history proves the current owner activated it; every other row stays NULL', async () => {
    const scratch = `backfill_test_${randomBytes(6).toString('hex')}`;
    const ROLLBACK = new Error('rolled back on purpose');
    let seen: Record<string, string | null> = {};
    await owner.client
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE SCHEMA ${scratch}`);
        await tx.$executeRawUnsafe(
          `CREATE TABLE ${scratch}.asset (LIKE public.asset INCLUDING ALL)`,
        );
        await tx.$executeRawUnsafe(
          `CREATE TABLE ${scratch}.asset_transfer (LIKE public.asset_transfer INCLUDING ALL)`,
        );
        await tx.$executeRawUnsafe(
          `CREATE TABLE ${scratch}.asset_timeline_entry (LIKE public.asset_timeline_entry INCLUDING ALL)`,
        );

        const insertAsset = (assetId: string, commissioned: boolean, generation: number) =>
          tx.$executeRawUnsafe(
            `INSERT INTO ${scratch}.asset
               (id, organization_id, name, type, status, commissioned_at, ownership_generation,
                created_at, updated_at, created_by, updated_by)
             VALUES ($1, $2, 'itest backfill', 'LOADER'::"AssetType", 'ACTIVE'::"OperationalStatus",
                     CASE WHEN $3::boolean THEN now() END, $4::int,
                     now(), now(), 'USR-ITEST', 'USR-ITEST')`,
            assetId,
            org.a,
            commissioned,
            generation,
          );
        const insertTransfer = (assetId: string) =>
          tx.$executeRawUnsafe(
            `INSERT INTO ${scratch}.asset_transfer
               (id, asset_id, from_organization_id, to_organization_id, organization_id, reason,
                transferred_at, transferred_by)
             VALUES ($1, $2, $3, $4, $4, 'itest', now() - interval '2 hours', 'USR-ITEST')`,
            id('ATR'),
            assetId,
            org.b,
            org.a,
          );

        const insertEntry = (
          assetId: string,
          organizationId: string,
          eventName: string,
          recordedAgo: string,
          occurredAgo: string,
          detail = '{}',
        ) =>
          tx.$executeRawUnsafe(
            `INSERT INTO ${scratch}.asset_timeline_entry
               (id, asset_id, organization_id, event_name, source_service, source_event_id,
                category, title, detail, occurred_at, recorded_at)
             VALUES ($1, $2, $3, $4, 'asset-service', $1, 'LIFECYCLE'::"TimelineCategory", 'itest',
                     $5::jsonb, now() - $7::interval, now() - $6::interval)`,
            id('ATL'),
            assetId,
            organizationId,
            eventName,
            detail,
            recordedAgo,
            occurredAgo,
          );

        await insertAsset(old, true, 0);
        await insertAsset(transferred, true, 1);
        await insertTransfer(transferred);
        await insertAsset(orphanTransfer, true, 0);
        await insertTransfer(orphanTransfer);
        await insertAsset(advancedGeneration, true, 1);
        await insertAsset(neverCommissioned, false, 0);

        // The transferred rows: one transfer to org.a two hours ago each (generation 1).
        for (const assetId of [proven, beforeTransfer, forgedInstant, otherOwner, statusOnly]) {
          await insertAsset(assetId, false, 1);
          await insertTransfer(assetId);
        }
        await insertAsset(noTransferRow, false, 1);
        await insertEntry(proven, org.a, 'ASSET_ACTIVATED', '1 hour', '1 hour');
        await insertEntry(beforeTransfer, org.a, 'ASSET_ACTIVATED', '3 hours', '3 hours');
        await insertEntry(forgedInstant, org.a, 'ASSET_ACTIVATED', '3 hours', '1 hour');
        await insertEntry(otherOwner, org.b, 'ASSET_ACTIVATED', '1 hour', '1 hour');
        await insertEntry(
          statusOnly,
          org.a,
          'ASSET_STATUS_CHANGED',
          '1 hour',
          '1 hour',
          '{"previousStatus":"OUT_OF_SERVICE","newStatus":"ACTIVE"}',
        );
        await insertEntry(noTransferRow, org.a, 'ASSET_ACTIVATED', '1 hour', '1 hour');

        const read = () =>
          tx.$queryRawUnsafe<{ id: string; c: string | null }[]>(
            `SELECT id, commissioned_for_organization_id AS c FROM ${scratch}.asset`,
          );

        // The rows are what the old code left: the column exists and is NULL.
        const before = await read();
        expect(before).toHaveLength(ids.length);
        expect(before.every((row) => row.c === null)).toBe(true);

        // The guard, immediately before the statement runs: if it fails the statement is never
        // executed (the throw rolls the transaction back).
        for (const statement of backfills) expect(escapesTheScratchSchema(statement)).toBe(false);
        // Only the scratch schema is on the path: the unqualified statements cannot reach public.
        await tx.$executeRawUnsafe(`SET LOCAL search_path = ${scratch}`);
        const updated = [];
        for (const statement of backfills) updated.push(await tx.$executeRawUnsafe(statement));
        // One never-transferred commissioned row; one transferred row with proof.
        expect(updated).toEqual([1, 1]);
        await tx.$executeRawUnsafe(`SET LOCAL search_path = public`);

        seen = Object.fromEntries((await read()).map((row) => [row.id, row.c]));
        throw ROLLBACK;
      })
      .catch((error: unknown) => {
        if (error !== ROLLBACK) throw error;
      });

    expect(seen[old]).toBe(org.a);
    expect(seen[transferred]).toBeNull();
    expect(seen[orphanTransfer]).toBeNull();
    expect(seen[advancedGeneration]).toBeNull();
    expect(seen[neverCommissioned]).toBeNull();
    // Transferred: proven gets the current owner; every unproven one stays NULL.
    expect(seen[proven]).toBe(org.a);
    expect(seen[beforeTransfer]).toBeNull();
    expect(seen[forgedInstant]).toBeNull();
    expect(seen[otherOwner]).toBeNull();
    expect(seen[statusOnly]).toBeNull();
    expect(seen[noTransferRow]).toBeNull();
  });
});
