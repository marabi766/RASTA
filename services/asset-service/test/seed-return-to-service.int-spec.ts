import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { AssetRepository } from '../src/asset/asset.repository';
import { AssetService } from '../src/asset/asset.service';
import { InsuranceService } from '../src/insurance/insurance.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { FakeDocuments, asActor, newPrisma } from './helpers';
import { clearingOwners } from './transfer-clearance.fake';

/**
 * The demo seed's commissioned assets can go out of service and come back (#234 round 3). The REAL
 * seed (`prisma/seed.ts`, run as `pnpm db:seed` runs it) is executed against the test database —
 * a database the development bootstrap marked disposable (the seed refuses any other) — and the
 * seeded assets are then taken through OUT_OF_SERVICE → ACTIVE by the real service, and restored
 * to their seeded status by the service too (no raw status writes). Without `commissioned_for_organization_id`
 * on the seeded rows the return would demand a dossier the seed never gave them. Insurance is still
 * checked on every return (round 7): a seeded asset the seed gave no policy in force is refused with
 * only the policy named, and returns once one is recorded (removed again afterwards).
 */
describe('a seeded commissioned asset returns to service (#234 round 3)', () => {
  const SERVICE_DIR = join(__dirname, '..');
  const SEEDED = [
    { id: 'AST-SEED-0001', organizationId: 'ORG-DEH-0001', status: 'ACTIVE' },
    { id: 'AST-SEED-0002', organizationId: 'ORG-DEH-0001', status: 'IDLE' },
    { id: 'AST-SEED-0004', organizationId: 'ORG-DEH-0002', status: 'ACTIVE' },
    { id: 'AST-SEED-0005', organizationId: 'ORG-UNION-YAZD', status: 'ACTIVE' },
    { id: 'AST-SEED-E2E-0001', organizationId: 'ORG-DEH-0001', status: 'ACTIVE' },
  ] as const;

  let prisma: PrismaService;
  let assets: AssetService;
  let insurance: InsuranceService;
  const POLICY_PREFIX = 'POL-SEEDTEST-';

  const manager = (organizationId: string) => ({ organizationId, roles: ['FLEET_MANAGER'] });
  const version = async (organizationId: string, assetId: string) =>
    (await asActor(manager(organizationId), () => assets.get(assetId))).version;
  const changeStatus = (organizationId: string, assetId: string, status: string) =>
    asActor(manager(organizationId), async () =>
      assets.changeStatus(assetId, {
        status,
        reason: 'آزمون بذر',
        expectedVersion: await version(organizationId, assetId),
      } as never),
    );

  const recordPolicy = (organizationId: string, assetId: string) =>
    asActor(manager(organizationId), () =>
      insurance.recordPolicy(assetId, {
        policyNumber: `${POLICY_PREFIX}${assetId}`,
        insurerName: 'بیمه نمونه',
        coverage: 'THIRD_PARTY',
        validFrom: new Date(Date.now() - 86_400_000).toISOString(),
        validTo: new Date(Date.now() + 300 * 86_400_000).toISOString(),
      }),
    );
  const missingOf = (error: unknown) =>
    (error as { internalContext?: { missing?: string[] } }).internalContext?.missing;

  beforeAll(async () => {
    jest.setTimeout(120_000);
    const seeded = spawnSync(process.execPath, ['-r', '@swc-node/register', 'prisma/seed.ts'], {
      cwd: SERVICE_DIR,
      env: { ...process.env, NODE_ENV: 'test', RASTA_ALLOW_DEMO_SEED: 'true' },
      encoding: 'utf8',
    });
    // The seed's output is not echoed: only that it ran.
    if (seeded.status !== 0) throw new Error(`the demo seed failed (exit ${seeded.status})`);

    prisma = newPrisma();
    await prisma.onModuleInit();
    const repository = new AssetRepository(prisma);
    assets = new AssetService(repository, undefined, clearingOwners(), new FakeDocuments());
    insurance = new InsuranceService(repository, assets, 30);
  }, 120_000);

  afterAll(async () => {
    // Put each seeded asset back in the status the seed gave it — through the service, never a
    // raw write: the outbox event, timeline entry and version bump of every step are real, so the
    // read models downstream end in the state asset-service ends in. An asset a failed test left
    // OUT_OF_SERVICE is returned to ACTIVE first; IDLE is reachable only from ACTIVE.
    for (const seeded of SEEDED) {
      const status = async () =>
        (await asActor(manager(seeded.organizationId), () => assets.get(seeded.id))).status;
      if ((await status()) === 'OUT_OF_SERVICE') {
        await changeStatus(seeded.organizationId, seeded.id, 'ACTIVE').catch(async () => {
          await recordPolicy(seeded.organizationId, seeded.id);
          await changeStatus(seeded.organizationId, seeded.id, 'ACTIVE');
        });
      }
      if (seeded.status === 'IDLE' && (await status()) === 'ACTIVE') {
        await changeStatus(seeded.organizationId, seeded.id, 'IDLE');
      }
    }
    // The policies this spec recorded for seeded assets that had none.
    await prisma.client.$executeRawUnsafe(
      `DELETE FROM insurance_policy WHERE policy_number LIKE $1`,
      `${POLICY_PREFIX}%`,
    );
    await prisma.onModuleDestroy();
  });

  it('every commissioned seeded asset is commissioned for its own organization; the uncommissioned one is for nobody', async () => {
    const rows = await prisma.client.$queryRawUnsafe<
      {
        id: string;
        organization_id: string;
        commissioned_at: Date | null;
        commissioned_for: string | null;
      }[]
    >(
      `SELECT id, organization_id, commissioned_at, commissioned_for_organization_id AS commissioned_for
         FROM asset WHERE id LIKE 'AST-SEED-%'`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(6);
    for (const row of rows) {
      expect(row.commissioned_for).toBe(row.commissioned_at ? row.organization_id : null);
    }
  });

  it.each(SEEDED)(
    '$id ($status): OUT_OF_SERVICE and back to ACTIVE, with no document references; only a missing policy can refuse it',
    async ({ id, organizationId }) => {
      expect((await changeStatus(organizationId, id, 'OUT_OF_SERVICE')).status).toBe(
        'OUT_OF_SERVICE',
      );
      const outcome = await changeStatus(organizationId, id, 'ACTIVE').catch(
        (error: unknown) => error,
      );
      if (outcome instanceof Error) {
        // The seed gave this asset no policy in force: that alone refuses it — the ownership
        // document is waived by the marker.
        expect(missingOf(outcome)).toEqual(['an insurance policy currently in force']);
        await recordPolicy(organizationId, id);
        expect((await changeStatus(organizationId, id, 'ACTIVE')).status).toBe('ACTIVE');
      } else {
        expect((outcome as { status: string }).status).toBe('ACTIVE');
      }
    },
  );
});
