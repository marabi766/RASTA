import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from '../src/prisma/prisma.service';
import { id, ownerDatabaseUrl, tenants } from './helpers';

/**
 * The backfill of migration 20261007120000_asset_commissioned_for_organization against rows made
 * the OLD way (#234 round 4): `commissioned_at` set, `commissioned_for_organization_id` NULL.
 *
 * The migration's own UPDATE statement — read from the shipped file, not restated here — is run as
 * the owner against ISOLATED copies of the tables: inside one transaction a throwaway schema is
 * created, `asset` and `asset_transfer` are cloned into it (LIKE public.… INCLUDING ALL), the five
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
  const backfill = /UPDATE "asset" a[\s\S]*?;/.exec(migration)?.[0];

  const old = id('AST'); // never transferred
  const transferred = id('AST'); // one transfer: generation 1 and a transfer row
  const orphanTransfer = id('AST'); // generation 0 but a transfer row exists
  const advancedGeneration = id('AST'); // a transfer row is missing but the generation moved
  const neverCommissioned = id('AST');
  const ids = [old, transferred, orphanTransfer, advancedGeneration, neverCommissioned];

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
    expect(backfill).toBeDefined();
    expect(escapesTheScratchSchema(backfill)).toBe(false);
  });

  it('gives a never-transferred commissioned row its owner; every other row stays NULL', async () => {
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
             VALUES ($1, $2, $3, $4, $4, 'itest', now(), 'USR-ITEST')`,
            id('ATR'),
            assetId,
            org.b,
            org.a,
          );

        await insertAsset(old, true, 0);
        await insertAsset(transferred, true, 1);
        await insertTransfer(transferred);
        await insertAsset(orphanTransfer, true, 0);
        await insertTransfer(orphanTransfer);
        await insertAsset(advancedGeneration, true, 1);
        await insertAsset(neverCommissioned, false, 0);

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
        expect(escapesTheScratchSchema(backfill)).toBe(false);
        // Only the scratch schema is on the path: the unqualified statement cannot reach public.
        await tx.$executeRawUnsafe(`SET LOCAL search_path = ${scratch}`);
        const updated = await tx.$executeRawUnsafe(backfill!);
        expect(updated).toBe(1);
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
  });
});
