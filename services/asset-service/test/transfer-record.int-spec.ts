import { ulid } from 'ulid';
import { runWithContext, type RequestContext } from '@rasta/nest-common';
import { AssetRepository } from '../src/asset/asset.repository';
import { AssetService } from '../src/asset/asset.service';
import { TransferRecordService } from '../src/asset/transfer-record';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, newPrisma, tenants } from './helpers';
import { clearingOwners } from './transfer-clearance.fake';

/**
 * The internal answer an owner of a machine's work needs before it lifts an
 * expired transfer fence (ADR-062 § 3b, review #127 #2), against PostgreSQL.
 *
 * It says only whether one of the calling organization's own transfers was
 * recorded, waits for a transfer that is still committing, and is closed to
 * everyone but fleet-service and maintenance-service.
 */
describe('transfer record (internal)', () => {
  const org = tenants();
  const third = `ORG-ITEST-C-${ulid().slice(-10)}`;

  let prisma: PrismaService;
  let repository: AssetRepository;
  let assets: AssetService;
  let records: TransferRecordService;

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
      callerService: 'maintenance-service',
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
      assets.create({ name: 'لودر آزمون', type: 'LOADER', specifications: {} } as never),
    );
    await prisma.client.$executeRawUnsafe(
      `UPDATE asset SET status = 'ACTIVE'::"OperationalStatus" WHERE id = $1`,
      created.id,
    );
    return created.id;
  }

  /** Transfers `assetId` from A to B and returns the transfer's id. */
  async function transferred(assetId: string): Promise<string> {
    await asActor(admin(org.a), () =>
      assets.transfer(assetId, { toOrganizationId: org.b, reason: 'واگذاری آزمون' }),
    );
    const rows = await prisma.client.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM asset_transfer WHERE asset_id = $1`,
      assetId,
    );
    return rows[0]!.id;
  }

  const unknownTransfer = () => `TRF_${ulid()}`;

  async function waitForBlocked(n: number) {
    for (let attempt = 0; attempt < 400; attempt++) {
      const rows = await prisma.client.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if (rows[0]!.n >= n) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`fewer than ${n} sessions ever blocked`);
  }

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    repository = new AssetRepository(prisma);
    assets = new AssetService(repository, undefined, clearingOwners());
    records = new TransferRecordService(repository);

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

  it('answers RECORDED for the calling organization’s own transfer, to either owner of work', async () => {
    const assetId = await machine(org.a);
    const transferId = await transferred(assetId);

    for (const callerService of ['maintenance-service', 'fleet-service']) {
      await expect(
        asService(() => records.recorded(assetId, transferId), { callerService }),
      ).resolves.toEqual({ assetId, transferId, recorded: true });
    }
  });

  it('answers the owner’s NOT_FOUND for a transfer that never committed', async () => {
    const assetId = await machine(org.a);

    await expect(
      asService(() => records.recorded(assetId, unknownTransfer())),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'AssetTransfer not found' });
  });

  it('answers NOT_FOUND for the right transfer on the wrong machine', async () => {
    const assetId = await machine(org.a);
    const other = await machine(org.a);
    const transferId = await transferred(assetId);

    await expect(asService(() => records.recorded(other, transferId))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  describe('tenant isolation', () => {
    it('answers another organization exactly as for a transfer that does not exist', async () => {
      const assetId = await machine(org.a);
      const transferId = await transferred(assetId);

      // The receiving organization and an unrelated one: neither made it.
      for (const organizationId of [org.b, third]) {
        const real = await asService(() => records.recorded(assetId, transferId), {
          organizationId,
        }).catch((error: unknown) => error);
        const missing = await asService(() => records.recorded(assetId, unknownTransfer()), {
          organizationId,
        }).catch((error: unknown) => error);

        expect(real).toMatchObject({ code: 'NOT_FOUND', message: 'AssetTransfer not found' });
        expect(missing).toMatchObject({ code: 'NOT_FOUND', message: 'AssetTransfer not found' });
      }
    });

    it.each([
      ['a user token', { authType: 'USER' as const, callerService: undefined, userId: 'USR-1' }],
      ['a third service', { callerService: 'economic-service' }],
      ['the asset service itself', { callerService: 'asset-service' }],
    ])('refuses %s before reading anything', async (_label, overrides) => {
      const assetId = await machine(org.a);
      const transferId = await transferred(assetId);

      await expect(
        asService(() => records.recorded(assetId, transferId), overrides),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('refuses a service token that carries no organization', async () => {
      const assetId = await machine(org.a);

      await expect(
        asService(() => records.recorded(assetId, unknownTransfer()), {
          organizationId: undefined,
        }),
      ).rejects.toMatchObject({ code: 'SERVICE_TENANT_CONTEXT_INVALID' });
    });
  });

  describe('a transfer still committing', () => {
    /**
     * A transfer as `AssetService.transfer` makes it: the asset row locked by
     * its compare-and-set, the transfer row written, the commit held open.
     */
    async function transferInFlight(assetId: string, transferId: string) {
      let finish!: (commit: boolean) => void;
      const finished = new Promise<boolean>((resolve) => (finish = resolve));
      let written!: () => void;
      const isWritten = new Promise<void>((resolve) => (written = resolve));

      const done = prisma.client
        .$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe(
              `UPDATE asset SET organization_id = $2 WHERE id = $1`,
              assetId,
              org.b,
            );
            await tx.$executeRawUnsafe(
              `INSERT INTO asset_transfer
                 (id, asset_id, from_organization_id, to_organization_id, organization_id,
                  reason, transferred_at, transferred_by)
               VALUES ($1, $2, $3, $4, $4, 'آزمون', now(), 'itest')`,
              transferId,
              assetId,
              org.a,
              org.b,
            );
            written();
            if (!(await finished)) throw new Error('rolled back on purpose');
          },
          { timeout: 30_000 },
        )
        .catch(() => undefined);

      await isWritten;
      return async (commit: boolean) => {
        finish(commit);
        await done;
      };
    }

    it.each([
      ['commits', true, 'RECORDED'],
      ['rolls back', false, 'NOT_FOUND'],
    ])('waits for it, and answers what it became when it %s', async (_label, commit, expected) => {
      const assetId = await machine(org.a);
      const transferId = unknownTransfer();
      const end = await transferInFlight(assetId, transferId);

      const answer = asService(() => records.recorded(assetId, transferId)).then(
        () => 'RECORDED',
        (error: { code?: string }) => error.code ?? 'ERROR',
      );
      await waitForBlocked(1);
      await end(commit);

      expect(await answer).toBe(expected);
    });
  });
});
