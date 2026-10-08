import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from '../src/prisma/prisma.service';
import { id, newPrisma, ownerDatabaseUrl, tenants } from './helpers';

/**
 * The backfill of migration 20261007120000_asset_commissioned_for_organization against rows made
 * the OLD way (#234 round 4): `commissioned_at` set, `commissioned_for_organization_id` NULL.
 *
 * The test database is already migrated, so the migration's own UPDATE statement — read from the
 * shipped file, not restated here — is run as the owner inside a transaction that is rolled back:
 * the rows this suite made are judged by it, and no other row in the database is touched.
 */
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

  let prisma: PrismaService;
  let owner: PrismaService;

  const insertAsset = (assetId: string, commissioned: boolean, generation: number) =>
    prisma.client.$executeRawUnsafe(
      `INSERT INTO asset
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
    prisma.client.$executeRawUnsafe(
      `INSERT INTO asset_transfer
         (id, asset_id, from_organization_id, to_organization_id, organization_id, reason,
          transferred_at, transferred_by)
       VALUES ($1, $2, $3, $4, $4, 'itest', now(), 'USR-ITEST')`,
      id('ATR'),
      assetId,
      org.b,
      org.a,
    );

  beforeAll(async () => {
    expect(backfill).toBeDefined();
    prisma = newPrisma();
    await prisma.onModuleInit();
    owner = new PrismaService(ownerDatabaseUrl());
    await owner.onModuleInit();

    await insertAsset(old, true, 0);
    await insertAsset(transferred, true, 1);
    await insertTransfer(transferred);
    await insertAsset(orphanTransfer, true, 0);
    await insertTransfer(orphanTransfer);
    await insertAsset(advancedGeneration, true, 1);
    await insertAsset(neverCommissioned, false, 0);
  });

  afterAll(async () => {
    for (const table of ['asset_transfer', 'asset']) {
      await prisma.client.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE ${table === 'asset' ? 'id' : 'asset_id'} = ANY($1::text[])`,
        ids,
      );
    }
    await owner.onModuleDestroy();
    await prisma.onModuleDestroy();
  });

  it('gives a never-transferred commissioned row its owner; every other row stays NULL', async () => {
    const ROLLBACK = new Error('rolled back on purpose');
    let seen: Record<string, string | null> = {};
    await owner.client
      .$transaction(async (tx) => {
        const before = await tx.$queryRawUnsafe<{ id: string; c: string | null }[]>(
          `SELECT id, commissioned_for_organization_id AS c FROM asset WHERE id = ANY($1::text[])`,
          ids,
        );
        // The rows are what the old code left: the column exists and is NULL.
        expect(before).toHaveLength(ids.length);
        expect(before.every((row) => row.c === null)).toBe(true);

        await tx.$executeRawUnsafe(backfill!);

        const after = await tx.$queryRawUnsafe<{ id: string; c: string | null }[]>(
          `SELECT id, commissioned_for_organization_id AS c FROM asset WHERE id = ANY($1::text[])`,
          ids,
        );
        seen = Object.fromEntries(after.map((row) => [row.id, row.c]));
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
