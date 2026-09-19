import { MaintenanceRepository } from '../src/maintenance/maintenance.repository';
import { ScheduleService } from '../src/maintenance/schedule.service';
import type { MaintenanceEnv } from '../src/config/env';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, cleanup, id, newPrisma, seedAsset, tenants } from './helpers';

/**
 * `D-011` — a service schedule now leaves an audit trail.
 *
 * A maintenance schedule decides how often a machine is serviced. Until this
 * change, creating one, changing its interval or switching it off produced no
 * event at all: the reason went into the `notes` column and nowhere else.
 * `audit-service` has exactly one input, the event log, so the most
 * consequential decision this service holds was the one it could never see —
 * which is what `docs/23 § D-011` recorded and what `AGENTS.md` S-06 forbids.
 *
 * ## Why these tests need a real database
 *
 * The claim is not "an event is published". It is that the event and the row
 * it announces **commit together** (`AGENTS.md` A-08). A unit test with a
 * mocked client can show that a method was called; only a transaction against
 * a real database can show that a rollback takes both. The last test here is
 * the one that matters: a create that violates the unique-title constraint
 * must leave neither a schedule nor an outbox row, and a mock cannot fail that
 * way.
 */
describe('schedule changes reach the audit trail', () => {
  let prisma: PrismaService;
  let repository: MaintenanceRepository;
  let schedules: ScheduleService;

  const org = tenants();
  const env = { MAINTENANCE_DEFAULT_LEAD_DAYS: 7 } as MaintenanceEnv;
  const actor = 'USR-ITEST-FLEET-MANAGER';

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    repository = new MaintenanceRepository(prisma);
    schedules = new ScheduleService(repository, env);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await prisma.onModuleDestroy();
  });

  /**
   * Every schedule event written for one schedule, oldest first.
   *
   * The `payload` column holds the whole envelope, so the domain payload is
   * one level down. Reads go through `asActor` because the tenant guard scopes
   * every query and refuses one with no request context — which is the guard
   * working, not a test inconvenience.
   */
  async function eventsFor(scheduleId: string) {
    const rows = await asActor({ organizationId: org.a }, () =>
      prisma.client.outboxMessage.findMany({
        where: { aggregateId: scheduleId, eventName: 'MAINTENANCE_SCHEDULE_CHANGED' },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return rows.map((row) => ({
      row,
      envelope: row.payload as Record<string, unknown>,
      payload: (row.payload as { payload: Record<string, unknown> }).payload,
    }));
  }

  async function ownSchedule(title: string) {
    const assetId = id('AST-ITEST');
    await seedAsset(prisma, assetId, org.a);

    const schedule = await asActor({ organizationId: org.a, userId: actor }, () =>
      schedules.create({
        assetId,
        title,
        maintenanceType: 'PREVENTIVE',
        recurrence: 'RECURRING',
        intervalHours: '250.00',
        leadHours: '25.00',
        lastServicedHourMeter: '4310.00',
      }),
    );

    return { assetId, schedule };
  }

  it('records the creation of a schedule, with the actor who created it', async () => {
    const { assetId, schedule } = await ownSchedule('ثبت برنامه سرویس');

    const events = await eventsFor(schedule.id);
    expect(events).toHaveLength(1);

    expect(events[0].payload).toMatchObject({
      scheduleId: schedule.id,
      assetId,
      organizationId: org.a,
      change: 'CREATED',
      status: 'ACTIVE',
      previousStatus: null,
      reason: null,
      changedFields: [],
      changedBy: actor,
    });
  });

  // Every maintenance event is keyed by the machine, so one asset's whole
  // history stays in one partition and in order. A schedule event keyed by the
  // schedule would scatter it.
  it('keys the event by the asset, like every other maintenance event', async () => {
    const { assetId, schedule } = await ownSchedule('کلید پارتیشن');

    const [event] = await eventsFor(schedule.id);
    expect(event.row.partitionKey).toBe(assetId);
    expect(event.row.topic).toBe('rasta.maintenance.v1');
    expect(event.row.aggregateType).toBe('MaintenanceSchedule');
  });

  it('records which fields an edit moved, and nothing about their values', async () => {
    const { schedule } = await ownSchedule('ویرایش قاعده');

    await asActor({ organizationId: org.a, userId: actor }, () =>
      schedules.update(schedule.id, { intervalHours: '500.00', leadHours: '50.00' }),
    );

    const events = await eventsFor(schedule.id);
    expect(events).toHaveLength(2);

    expect(events[1].payload).toMatchObject({
      change: 'UPDATED',
      status: 'ACTIVE',
      previousStatus: 'ACTIVE',
      reason: null,
      changedFields: ['intervalHours', 'leadHours'],
      changedBy: actor,
    });

    // The new interval is this service's data. It is not copied into a log
    // every service reads and retains — see the note on the payload schema.
    expect(JSON.stringify(events[1].payload)).not.toContain('500.00');
  });

  // The transition D-011 was actually written about.
  it('records who switched a schedule off, and the reason they gave', async () => {
    const { schedule } = await ownSchedule('توقف برنامه');

    const reason = 'دستگاه تا پایان فصل از ناوگان خارج است';
    await asActor({ organizationId: org.a, userId: actor }, () =>
      schedules.changeStatus(schedule.id, { status: 'PAUSED', reason }),
    );

    const events = await eventsFor(schedule.id);
    expect(events).toHaveLength(2);

    expect(events[1].payload).toMatchObject({
      change: 'STATUS_CHANGED',
      previousStatus: 'ACTIVE',
      status: 'PAUSED',
      reason,
      changedFields: ['status'],
      changedBy: actor,
    });
  });

  it('records an archive the same way a pause is recorded', async () => {
    const { schedule } = await ownSchedule('بایگانی برنامه');

    await asActor({ organizationId: org.a, userId: actor }, () =>
      schedules.changeStatus(schedule.id, { status: 'ARCHIVED', reason: 'دستگاه فروخته شد' }),
    );

    const events = await eventsFor(schedule.id);
    expect(events[1].payload).toMatchObject({
      change: 'STATUS_CHANGED',
      previousStatus: 'ACTIVE',
      status: 'ARCHIVED',
    });
  });

  it('carries the tenant on the row, so the relay can filter without reading the payload', async () => {
    const { schedule } = await ownSchedule('مستأجر روی ردیف');

    const [event] = await eventsFor(schedule.id);
    expect(event.row.organizationId).toBe(org.a);
  });

  /**
   * The invariant, and the reason this file needs a database.
   *
   * A second schedule with the same title on the same machine violates a
   * unique constraint. The write and its announcement are in one transaction,
   * so the rollback must take both — an outbox row for a schedule that does
   * not exist would tell `audit-service` about a decision nobody made.
   */
  it('writes neither the schedule nor its event when the write is refused', async () => {
    const assetId = id('AST-ITEST');
    await seedAsset(prisma, assetId, org.a);

    const title = 'عنوان تکراری';
    const create = () =>
      asActor({ organizationId: org.a, userId: actor }, () =>
        schedules.create({
          assetId,
          title,
          maintenanceType: 'PREVENTIVE',
          recurrence: 'RECURRING',
          intervalDays: 90,
        }),
      );

    const countEvents = () =>
      asActor({ organizationId: org.a }, () =>
        prisma.client.outboxMessage.count({
          where: { eventName: 'MAINTENANCE_SCHEDULE_CHANGED', organizationId: org.a },
        }),
      );

    await create();
    const before = await countEvents();

    await expect(create()).rejects.toThrow();

    expect(await countEvents()).toBe(before);

    const schedulesOnAsset = await asActor({ organizationId: org.a }, () =>
      prisma.client.maintenanceSchedule.count({ where: { assetId, title } }),
    );
    expect(schedulesOnAsset).toBe(1);
  });
});
