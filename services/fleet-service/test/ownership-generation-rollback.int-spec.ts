import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EventEnvelope } from '@rasta/contracts';
import { ulid } from 'ulid';
import { AssetSyncConsumer } from '../src/consumers/asset-sync.consumer';
import { AssignmentService } from '../src/fleet/assignment.service';
import { FleetRepository } from '../src/fleet/fleet.repository';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  asActor,
  cleanup,
  id,
  newPrisma,
  ownerDatabaseUrl,
  producerShaped,
  tenants,
} from './helpers';

/**
 * Rolling back `20261008230000_asset_ref_ownership_generation` and applying it
 * again forgets the ownership generation and the retained coverages (#240
 * round 3). What that leaves must fail closed: a replica whose generation is
 * unknown refuses an `INSURANCE_RECORDED` of any organization but its current
 * owner, so the previous owner's delayed event cannot authorize the new owner.
 *
 * The migration files are run whole, as an operator does, with `psql --file`
 * against a scratch schema built from the real migrations; the state they leave
 * is then carried to the replica and the real consumer and the real dispatch
 * check decide.
 */
const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const GENERATION = '20261008230000_asset_ref_ownership_generation';

describe('rollback of the ownership generation (#240 round 3)', () => {
  jest.setTimeout(120_000);
  const org = tenants();
  const year = 365 * 86_400_000;
  const COVERAGES = ['THIRD_PARTY', 'COMPREHENSIVE', 'PASSENGER_ACCIDENT', 'LIABILITY'];
  const ALL = readdirSync(MIGRATIONS)
    .filter((name) => /^\d{14}_/.test(name))
    .sort();
  const schemas: string[] = [];
  let prisma: PrismaService;
  let repository: FleetRepository;
  let consumer: AssetSyncConsumer;
  let strict: AssignmentService;

  /** What psql connects with, as the PG* environment, so no password is on a command line. */
  const connection = (schema: string): NodeJS.ProcessEnv => {
    const parts = /^postgres(?:ql)?:\/\/([^:@/]+):([^@]*)@([^:/?]+)(?::(\d+))?\/([^?]+)/.exec(
      ownerDatabaseUrl(),
    );
    if (!parts) throw new Error('DATABASE_URL_FLEET_MIGRATOR is not a postgresql:// url');
    const [, user, password, host, port, database] = parts;
    return {
      ...process.env,
      PGHOST: host!,
      PGPORT: port ?? '5432',
      PGUSER: decodeURIComponent(user!),
      PGPASSWORD: decodeURIComponent(password!),
      PGDATABASE: decodeURIComponent(database!),
      PGOPTIONS: `-c search_path=${schema} -c timezone=UTC`,
    };
  };

  const psql = (schema: string, args: string[]): string => {
    const result = spawnSync('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', ...args], {
      env: connection(schema),
      encoding: 'utf8',
    });
    if (result.error) throw result.error;
    const out = `${result.stdout}${result.stderr}`.trim();
    if (result.status !== 0) throw new Error(`psql failed: ${out.slice(0, 600)}`);
    return out;
  };

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    repository = new FleetRepository(prisma);
    consumer = new AssetSyncConsumer(null, repository);
    strict = new AssignmentService(repository);
    await cleanup(prisma, [org.a, org.b]);
  });

  afterAll(async () => {
    for (const schema of schemas)
      psql('public', ['-c', `DROP SCHEMA IF EXISTS "${schema}" CASCADE`]);
    await cleanup(prisma, [org.a, org.b]);
    await prisma.onModuleDestroy();
  });

  const eventFor = (
    tenantId: string,
    eventName: string,
    payload: Record<string, unknown>,
  ): EventEnvelope => ({
    eventId: id('EVT'),
    eventName,
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    producer: 'asset-service',
    producerVersion: '0.1.0',
    aggregateType: 'Asset',
    aggregateId: String(payload.assetId),
    tenantId,
    correlationId: id('COR'),
    payload: producerShaped(eventName, { organizationId: tenantId, ...payload }),
  });

  const recorded = (tenantId: string, assetId: string, coverage: string, generation?: number) =>
    eventFor(tenantId, 'INSURANCE_RECORDED', {
      assetId,
      policyId: id('INS'),
      insurerName: 'بیمه ایران',
      coverage,
      validFrom: new Date(Date.now() - 1000).toISOString(),
      validTo: new Date(Date.now() + year).toISOString(),
      ...(generation === undefined ? {} : { ownershipGeneration: generation }),
    });

  it('down → up leaves the generation unknown, and an unknown generation fails closed', async () => {
    // --- the migration files, run whole, on a scratch schema holding a transferred row -------
    const schema = `gr_${ulid().toLowerCase()}`;
    schemas.push(schema);
    psql('public', ['-c', `CREATE SCHEMA "${schema}"`]);
    psql(schema, ['-c', 'CREATE TABLE "_prisma_migrations" ("migration_name" text NOT NULL)']);
    for (const name of ALL.slice(0, ALL.indexOf(GENERATION) + 1)) {
      psql(schema, ['--file', join(MIGRATIONS, name, 'migration.sql')]);
      psql(schema, ['-c', `INSERT INTO "_prisma_migrations" VALUES ('${name}')`]);
    }
    psql(schema, [
      '-c',
      `INSERT INTO "asset_ref" ("id", "organization_id", "status", "synced_at", "source_event",
                                "ownership_generation", "retained_coverages")
       VALUES ('AST-ROLLBACK', '${org.b}', 'REGISTERED', now(), 'ASSET_TRANSFERRED', 2,
               ARRAY['THIRD_PARTY'])`,
    ]);
    const state = (): string =>
      psql(schema, [
        '-c',
        `SELECT coalesce(ownership_generation::text, 'NULL') || '|' || retained_coverages::text
           FROM "asset_ref" WHERE id = 'AST-ROLLBACK'`,
      ]);
    expect(state()).toBe('2|{THIRD_PARTY}');

    psql(schema, ['--file', join(MIGRATIONS, GENERATION, 'down.sql')]);
    expect(
      psql(schema, [
        '-c',
        `SELECT count(*) FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'asset_ref'
            AND column_name IN ('ownership_generation', 'retained_coverages')`,
      ]),
    ).toBe('0');
    psql(schema, ['--file', join(MIGRATIONS, GENERATION, 'migration.sql')]);
    // The row survives; what it knew about its generation does not.
    expect(state()).toBe('NULL|{}');

    // --- that state, in the replica, with the real consumer and the real dispatch check --------
    const assetId = id('AST');
    await consumer.handle(eventFor(org.a, 'ASSET_CREATED', { assetId, status: 'ACTIVE' }));
    for (const coverage of COVERAGES) {
      await consumer.handle(recorded(org.a, assetId, coverage, 1));
    }
    await consumer.handle(
      eventFor(org.b, 'ASSET_TRANSFERRED', {
        assetId,
        fromOrganizationId: org.a,
        toOrganizationId: org.b,
        transferredAt: new Date().toISOString(),
        reason: 'واگذاری',
        ownershipGeneration: 2,
        retainedCoverages: [],
      }),
    );
    await consumer.handle(eventFor(org.b, 'ASSET_ACTIVATED', { assetId }));
    await prisma.client.$executeRawUnsafe(
      `UPDATE asset_ref SET ownership_generation = NULL, retained_coverages = ARRAY[]::text[]
        WHERE id = $1`,
      assetId,
    );
    const driverId = id('DRV');
    await asActor({ organizationId: org.b }, () =>
      prisma.client.driver.create({
        data: {
          organizationId: org.b,
          id: driverId,
          userId: `USR-${driverId}`,
          createdBy: 'ITEST',
          updatedBy: 'ITEST',
        },
      }),
    );
    const dispatch = () =>
      asActor({ organizationId: org.b }, () => strict.create({ driverId, assetId }));
    const refused = {
      code: 'BUSINESS_RULE_VIOLATION',
      message: expect.stringContaining('withdrawn from dispatch'),
    };

    // The previous owner's delayed events: ignored, whatever generation they carry.
    for (const generation of [undefined, 1, 9]) {
      for (const coverage of COVERAGES) {
        await consumer.handle(recorded(org.a, assetId, coverage, generation));
      }
    }
    expect((await repository.findAssetRefUnscoped(assetId))!.insuranceCover).toEqual({});
    await expect(dispatch()).rejects.toMatchObject(refused);

    // The current owner's re-projected events restore the coverage.
    for (const coverage of COVERAGES) {
      await consumer.handle(recorded(org.b, assetId, coverage, 2));
    }
    await expect(dispatch()).resolves.toMatchObject({ assetId });
  });
});
