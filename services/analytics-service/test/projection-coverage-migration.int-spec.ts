import { join } from 'node:path';
import { ulid } from 'ulid';
import { PrismaClient } from '../src/generated/prisma';
import { applyMigration } from './migration-helpers';
import { newOrganizationId, ownerClient, ownerDatabaseUrl } from './helpers';

/**
 * 20261029120000_projection_coverage on an isolated schema that already holds facts: it creates
 * the table EMPTY (an upgrade never manufactures historical coverage — Q-154), reverses cleanly
 * and re-applies.
 */
describe('projection_coverage migration', () => {
  const schema = `coverage_mig_${ulid().toLowerCase()}`;
  const owner = ownerClient();
  const url = new URL(ownerDatabaseUrl());
  url.searchParams.set('schema', schema);
  const scratch = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  const migrations = join(__dirname, '..', 'prisma', 'migrations');
  const coverage = join(migrations, '20261029120000_projection_coverage');
  const apply = (directory: string, file: string): void =>
    applyMigration(ownerDatabaseUrl(), schema, join(directory, file));

  const catalog = async () => {
    const [row] = await scratch.$queryRaw<
      { tables: bigint; functions: bigint; triggers: bigint; ledger: bigint }[]
    >`
      SELECT
        (SELECT count(*) FROM information_schema.tables WHERE table_schema = ${schema} AND table_name = 'projection_coverage') AS tables,
        (SELECT count(*) FROM information_schema.routines WHERE routine_schema = ${schema} AND routine_name LIKE 'projection_coverage%') AS functions,
        (SELECT count(*) FROM information_schema.triggers WHERE trigger_schema = ${schema} AND trigger_name LIKE 'tg_projection_coverage%') AS triggers,
        (SELECT count(*) FROM _prisma_migrations WHERE migration_name = '20261029120000_projection_coverage') AS ledger`;
    return row;
  };

  beforeAll(async () => {
    await owner.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    apply(join(migrations, '20261017140000_init_analytics'), 'migration.sql');
    apply(join(migrations, '20261024120000_baseline_metric'), 'migration.sql');
    await scratch.$executeRawUnsafe(
      'CREATE TABLE "_prisma_migrations" ("migration_name" text PRIMARY KEY)',
    );
  });
  afterAll(async () => {
    await scratch.$disconnect();
    await owner.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await owner.$disconnect();
  });

  it('up on a database that already holds facts creates NO coverage row; down removes it; up again is empty too', async () => {
    await scratch.factMaintenance.create({
      data: {
        organizationId: newOrganizationId(),
        requestId: 'older-than-the-upgrade',
        assetId: 'test-asset',
        maintenanceType: 'PREVENTIVE',
        completedAt: new Date('2026-01-01T00:00:00Z'),
        totalCostMinor: 9n,
        currency: 'IRR',
        sourceEventId: ulid(),
      },
    });

    apply(coverage, 'migration.sql');
    await scratch.$executeRawUnsafe(
      "INSERT INTO _prisma_migrations VALUES ('20261029120000_projection_coverage')",
    );
    expect(await catalog()).toEqual({ tables: 1n, functions: 2n, triggers: 3n, ledger: 1n });
    // Never manufactured: the existing fact does not make the past "covered".
    expect(await scratch.$queryRaw`SELECT * FROM projection_coverage`).toEqual([]);

    // While populated: the guards are installed (insert stamps the clock, update/delete refused).
    await scratch.$executeRawUnsafe(
      "INSERT INTO projection_coverage (consumer_name, covered_from) VALUES ('c', '2000-01-01')",
    );
    const [held] = await scratch.$queryRaw<
      { covered_from: Date }[]
    >`SELECT covered_from FROM projection_coverage`;
    expect(held?.covered_from.getUTCFullYear()).toBeGreaterThanOrEqual(2026);
    await expect(scratch.$executeRawUnsafe('DELETE FROM projection_coverage')).rejects.toThrow(
      /ck_projection_coverage_append_only/,
    );

    // Down needs no refusal (losing a start only makes reads more conservative) and leaves facts.
    apply(coverage, 'down.sql');
    expect(await catalog()).toEqual({ tables: 0n, functions: 0n, triggers: 0n, ledger: 0n });
    expect(await scratch.factMaintenance.count()).toBe(1);

    apply(coverage, 'migration.sql');
    expect(await scratch.$queryRaw`SELECT * FROM projection_coverage`).toEqual([]);
    expect((await catalog()).triggers).toBe(3n);
  });
});
