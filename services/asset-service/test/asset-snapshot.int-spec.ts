import { ulid } from 'ulid';
import { runWithContext, type RequestContext } from '@rasta/nest-common';
import { AssetRepository } from '../src/asset/asset.repository';
import { AssetService } from '../src/asset/asset.service';
import { AssetSnapshotService } from '../src/asset/asset-snapshot';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, newPrisma, tenants } from './helpers';
import { clearingOwners } from './transfer-clearance.fake';

/**
 * The internal read a replica refreshes from when an event is replayed on
 * `<topic>.retry` (D-039), against PostgreSQL: tenant from the signed token
 * only; the owner sees the machine, a previous owner only that it moved and to
 * whom, everyone else the 404 of an asset that does not exist.
 */
describe('asset snapshot (internal)', () => {
  const org = tenants();
  const third = `ORG-ITEST-C-${ulid().slice(-10)}`;

  let prisma: PrismaService;
  let repository: AssetRepository;
  let assets: AssetService;
  let snapshots: AssetSnapshotService;

  function asService<T>(
    fn: () => Promise<T>,
    overrides: Partial<RequestContext> & { organizationId?: string | undefined } = {},
  ): Promise<T> {
    const context: RequestContext = {
      correlationId: `itest-${ulid()}`,
      requestId: `itest-${ulid()}`,
      organizationId: org.a,
      roles: [],
      organizationIds: [],
      authType: 'SERVICE',
      callerService: 'fleet-service',
      startedAt: Date.now(),
      ...overrides,
    };
    return runWithContext(context, async () => fn());
  }

  const admin = (organizationId: string) => ({
    organizationId,
    roles: ['ORGANIZATION_ADMIN'],
    userId: `USR-ADMIN-${organizationId.slice(-4)}`,
  });

  async function machine(organizationId: string): Promise<string> {
    const created = await asActor({ organizationId, roles: ['FLEET_MANAGER'] }, () =>
      assets.create({
        name: 'لودر آزمون',
        type: 'LOADER',
        assetTag: `TAG-${ulid().slice(-6)}`,
        specifications: {},
      } as never),
    );
    await prisma.client.$executeRawUnsafe(
      `UPDATE asset SET status = 'ACTIVE'::"OperationalStatus" WHERE id = $1`,
      created.id,
    );
    return created.id;
  }

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    repository = new AssetRepository(prisma);
    assets = new AssetService(repository, undefined, clearingOwners());
    snapshots = new AssetSnapshotService(repository);

    for (const organizationId of [org.a, org.b, third]) {
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
    const orgs = [org.a, org.b, third];
    await prisma.client.$executeRawUnsafe(
      `DELETE FROM outbox_message WHERE organization_id = ANY($1::text[])`,
      orgs,
    );
    for (const table of ['asset_timeline_entry', 'asset_transfer', 'asset']) {
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

  it('gives the current owner the full snapshot, to either replica', async () => {
    const assetId = await machine(org.a);

    for (const callerService of ['fleet-service', 'maintenance-service']) {
      await expect(
        asService(() => snapshots.snapshot(assetId), { callerService }),
      ).resolves.toMatchObject({
        transferred: false,
        assetId,
        organizationId: org.a,
        status: 'ACTIVE',
        name: 'لودر آزمون',
        type: 'LOADER',
      });
    }
  });

  it('tells a previous owner only that the machine moved, and to whom', async () => {
    const assetId = await machine(org.a);
    await asActor(admin(org.a), () =>
      assets.transfer(assetId, { toOrganizationId: org.b, reason: 'واگذاری آزمون' }),
    );

    const seen = await asService(() => snapshots.snapshot(assetId), { organizationId: org.a });

    expect(seen).toEqual({
      transferred: true,
      assetId,
      organizationId: org.b,
      transferGeneration: expect.any(Number),
    });
    // Nothing about the machine itself.
    expect(Object.keys(seen).sort()).toEqual([
      'assetId',
      'organizationId',
      'transferGeneration',
      'transferred',
    ]);

    // And the new owner has the full snapshot, under its own token.
    await expect(
      asService(() => snapshots.snapshot(assetId), { organizationId: org.b }),
    ).resolves.toMatchObject({ transferred: false, organizationId: org.b, status: 'REGISTERED' });
  });

  it('gives any other organization the 404 of an asset that does not exist', async () => {
    const assetId = await machine(org.a);
    await asActor(admin(org.a), () =>
      assets.transfer(assetId, { toOrganizationId: org.b, reason: 'واگذاری آزمون' }),
    );
    const other = await machine(org.b);

    const refusals = await Promise.all(
      [
        asService(() => snapshots.snapshot(assetId), { organizationId: third }),
        asService(() => snapshots.snapshot(other), { organizationId: third }),
        asService(() => snapshots.snapshot(other), { organizationId: org.a }),
        asService(() => snapshots.snapshot(`AST_${ulid()}`), { organizationId: org.a }),
      ].map((call) => call.catch((error: unknown) => error)),
    );

    for (const refusal of refusals) {
      expect(refusal).toMatchObject({ code: 'NOT_FOUND' });
    }
    // Indistinguishable: the same message whether the asset exists or not.
    expect(
      new Set(refusals.map((r) => (r as { message: string }).message.replace(/AST_\w+/, ''))),
    ).toHaveProperty('size', 1);
  });

  it('is closed to user tokens, to other services, and to a token with no organization', async () => {
    const assetId = await machine(org.a);

    await expect(
      asService(() => snapshots.snapshot(assetId), { authType: 'USER' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      asService(() => snapshots.snapshot(assetId), { callerService: 'economic-service' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      asService(() => snapshots.snapshot(assetId), { organizationId: undefined }),
    ).rejects.toMatchObject({ code: 'SERVICE_TENANT_CONTEXT_INVALID' });
  });
});
