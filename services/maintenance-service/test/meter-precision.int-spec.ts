import { MaintenanceRepository } from '../src/maintenance/maintenance.repository';
import { ScheduleService } from '../src/maintenance/schedule.service';
import { RequestService } from '../src/maintenance/request.service';
import { RepairOrderService } from '../src/maintenance/repair-order.service';
import { UnverifiedWorkshopDirectory } from '../src/maintenance/workshop.directory';
import { createScheduleSchema } from '../src/maintenance/dto';
import type { MaintenanceEnv } from '../src/config/env';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, cleanup, id, newPrisma, seedAsset, tenants } from './helpers';

describe('ADR-073 cumulative meter precision', () => {
  const org = tenants();
  let prisma: PrismaService;
  let schedules: ScheduleService;
  let requests: RequestService;
  let repairs: RepairOrderService;
  const actor = <T>(fn: () => Promise<T>) => asActor({ organizationId: org.a }, fn);
  beforeAll(() => {
    prisma = newPrisma();
    const repository = new MaintenanceRepository(prisma);
    schedules = new ScheduleService(repository, {
      MAINTENANCE_DEFAULT_LEAD_DAYS: 7,
    } as MaintenanceEnv);
    requests = new RequestService(repository);
    repairs = new RepairOrderService(repository, new UnverifiedWorkshopDirectory());
  });
  afterAll(async () => {
    await cleanup(prisma, [org.a]);
    await prisma.stop();
  });

  async function machine(): Promise<string> {
    const assetId = id('AST');
    await seedAsset(prisma, assetId, org.a);
    return assetId;
  }
  async function setMeter(assetId: string, value: string): Promise<void> {
    await prisma.client.assetUsageMeter.upsert({
      where: { assetId },
      create: {
        assetId,
        organizationId: org.a,
        hourMeter: value,
        odometer: value,
        updatedAt: new Date(),
      },
      update: { hourMeter: value, odometer: value },
    });
  }
  async function schedule(assetId: string) {
    return actor(() =>
      schedules.create(
        createScheduleSchema.parse({
          assetId,
          title: 'Meter precision',
          intervalHours: '1',
          intervalKilometres: '1',
        }),
      ),
    );
  }
  it('schedule without explicit anchors copies both post-old-max counters exactly', async () => {
    const assetId = await machine();
    await setMeter(assetId, '10000000000.99');
    const s = await schedule(assetId);
    expect(s.lastServicedHourMeter).toBe('10000000000.99');
    expect(s.lastServicedOdometer).toBe('10000000000.99');
  });
  it('scheduled repair completion commits and reanchors both expanded counters exactly', async () => {
    const assetId = await machine();
    const s = await schedule(assetId);
    const r = await actor(() =>
      requests.create({ assetId, scheduleId: s.id, type: 'PREVENTIVE', title: 'Service' }),
    );
    const order = await actor(() => repairs.assign(r.id, { workshopOrganizationId: org.b }));
    await actor(() => repairs.start(order.id, {}));
    await setMeter(assetId, '10000000000.99');
    await actor(() => repairs.complete(order.id, { workPerformed: 'Completed' }));
    const updated = await actor(() => schedules.get(s.id));
    expect(updated.lastServicedHourMeter).toBe('10000000000.99');
    expect(updated.lastServicedOdometer).toBe('10000000000.99');
    expect((await actor(() => requests.get(r.id))).status).toBe('COMPLETED');
  });
  it('reads, due evaluation and announcements retain hundredths on an 18-digit anchor', async () => {
    const assetId = await machine();
    await setMeter(assetId, '999999999999999998.98');
    const s = await schedule(assetId);
    await setMeter(assetId, '999999999999999999.99');
    const page = await actor(() => schedules.listDue({ assetId, limit: 25, includeNotDue: true }));
    expect(page.items).toHaveLength(1);
    expect(page.items[0].meter.hourMeter).toBe('999999999999999999.99');
    expect(page.items[0].due.dueAtMeter).toBe('999999999999999999.98');
    expect(page.items[0].due.triggers.map((t) => t.remaining)).toEqual(['-0.01', '-0.01']);
    const { DueAnnouncerService } = await import('../src/maintenance/due-announcer.service');
    const announcer = new DueAnnouncerService(new MaintenanceRepository(prisma));
    expect(await announcer.announceForAsset(assetId, new Date())).toBe(1);
    const rows = await prisma.client.$queryRaw<{ payload: { dueAtMeter: string } }[]>`
      SELECT payload FROM outbox_message WHERE organization_id = ${org.a} AND event_name = 'MAINTENANCE_DUE' AND aggregate_id = ${s.id}`;
    expect(rows[0].payload.dueAtMeter).toBe('999999999999999999.98');
  });
});
