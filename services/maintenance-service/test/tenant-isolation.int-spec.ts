import { RastaError } from '@rasta/nest-common';
import { MaintenanceRepository } from '../src/maintenance/maintenance.repository';
import { RequestService } from '../src/maintenance/request.service';
import { ScheduleService } from '../src/maintenance/schedule.service';
import type { MaintenanceEnv } from '../src/config/env';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, cleanup, id, newPrisma, seedAsset, tenants } from './helpers';

/**
 * Tenant isolation, against a real PostgreSQL.
 *
 * A unit test with a mocked client can only prove that the code *asks* for a
 * scoped query. It cannot prove the extension rewrites the `where` clause, and
 * that is the only thing that matters — one tenant reading another's repair
 * bills is a data breach, not a bug.
 *
 * Every test here has two organizations with real rows in both, so an empty
 * result is evidence of isolation rather than evidence of an empty table.
 */
describe('tenant isolation', () => {
  let prisma: PrismaService;
  let repository: MaintenanceRepository;
  let schedules: ScheduleService;
  let requests: RequestService;

  const org = tenants();
  const assetA = id('AST-ITEST-A');
  const assetB = id('AST-ITEST-B');

  const env = { MAINTENANCE_DEFAULT_LEAD_DAYS: 7 } as MaintenanceEnv;

  beforeAll(async () => {
    prisma = newPrisma();
    repository = new MaintenanceRepository(prisma);
    schedules = new ScheduleService(repository, env);
    requests = new RequestService(repository);

    await seedAsset(prisma, assetA, org.a);
    await seedAsset(prisma, assetB, org.b);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await prisma.onModuleDestroy();
  });

  it('writes each schedule into the organization the caller is acting for', async () => {
    const a = await asActor({ organizationId: org.a }, () =>
      schedules.create({
        assetId: assetA,
        title: 'سرویس الف',
        maintenanceType: 'PREVENTIVE',
        recurrence: 'RECURRING',
        intervalDays: 90,
      }),
    );

    const b = await asActor({ organizationId: org.b }, () =>
      schedules.create({
        assetId: assetB,
        title: 'سرویس ب',
        maintenanceType: 'PREVENTIVE',
        recurrence: 'RECURRING',
        intervalDays: 90,
      }),
    );

    expect(a.organizationId).toBe(org.a);
    expect(b.organizationId).toBe(org.b);
  });

  it('hides the other tenant schedules from a list', async () => {
    const listed = await asActor({ organizationId: org.a }, () => schedules.list({ limit: 50 }));

    // Both organizations have a schedule. Seeing exactly one is the proof.
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.organizationId).toBe(org.a);
  });

  it('reports another tenant schedule as absent, never as forbidden', async () => {
    const theirs = await asActor({ organizationId: org.b }, () => schedules.list({ limit: 50 }));
    const scheduleId = theirs.items[0]?.id as string;

    // A 403 would confirm the schedule exists. The uniform 404 rule is what
    // stops an identifier probe from mapping another organization's fleet.
    await expect(
      asActor({ organizationId: org.a }, () => schedules.get(scheduleId)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses to raise work against another tenant machine', async () => {
    // The replica is platform-wide and knows about `assetB`. The check is not
    // "do I know this machine" but "is it this tenant's", and the refusal is a
    // 404 for the same non-disclosure reason.
    await expect(
      asActor({ organizationId: org.a }, () =>
        requests.create({
          assetId: assetB,
          type: 'CORRECTIVE',
          severity: 'HIGH',
          title: 'نشتی روغن',
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rewrites the where clause on a direct model query', async () => {
    // Straight at the extension, with no service in the way: a `findMany` with
    // no `organizationId` in it must still come back scoped.
    await asActor({ organizationId: org.a }, async () => {
      const rows = await repository.client.maintenanceSchedule.findMany({});
      expect(rows.every((row) => row.organizationId === org.a)).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  it('refuses a write that names another organization outright', async () => {
    // The guard does not merely add a filter to reads; it refuses a create
    // that tries to plant a row in a tenant the caller is not acting for.
    await asActor({ organizationId: org.a }, async () => {
      await expect(
        repository.client.maintenanceSchedule.create({
          data: {
            id: id('MSC-ITEST'),
            organizationId: org.b,
            assetId: assetB,
            title: 'تلاش میان‌تنانتی',
            intervalDays: 30,
            createdBy: 'ITEST',
            updatedBy: 'ITEST',
          },
        }),
      ).rejects.toThrow();
    });
  });

  it('scopes the requests a reporter can see to their own reports', async () => {
    // Object-level narrowing on top of the tenant boundary: two operators in
    // the *same* organization must not read each other's reports.
    const mine = await asActor(
      { organizationId: org.a, userId: 'USR-ITEST-OP-1', roles: ['OPERATOR'] },
      () =>
        requests.create({
          assetId: assetA,
          type: 'CORRECTIVE',
          severity: 'MEDIUM',
          title: 'صدای غیرعادی موتور',
        }),
    );

    const theirView = await asActor(
      { organizationId: org.a, userId: 'USR-ITEST-OP-2', roles: ['OPERATOR'] },
      () => requests.list({ limit: 50 }),
    );

    expect(theirView.items).toHaveLength(0);

    await expect(
      asActor({ organizationId: org.a, userId: 'USR-ITEST-OP-2', roles: ['OPERATOR'] }, () =>
        requests.get(mine.id),
      ),
    ).rejects.toBeInstanceOf(RastaError);

    // A supervisor in the same organization does see it.
    const supervisorView = await asActor({ organizationId: org.a }, () =>
      requests.list({ limit: 50 }),
    );
    expect(supervisorView.items.map((item) => item.id)).toContain(mine.id);
  });
});
