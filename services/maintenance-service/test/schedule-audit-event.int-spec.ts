import { RastaError } from '@rasta/nest-common';
import {
  ISO_INSTANT_SHAPE,
  arrayOf,
  envelopeShape,
  expectStoredMessageWithout,
} from '@rasta/testing';
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
    const { assetId, schedule } = await ownSchedule('ویرایش قاعده');

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
    // The WHOLE domain payload, pinned: ids and the actor by exact value, the instant by its
    // strict shape. A field added to it, or text appended to one of its values, fails here.
    const { changedAt, ...held } = events[1].payload;
    expect(held).toEqual({
      scheduleId: schedule.id,
      assetId,
      organizationId: org.a,
      change: 'UPDATED',
      status: 'ACTIVE',
      previousStatus: 'ACTIVE',
      reason: null,
      changedFields: ['intervalHours', 'leadHours'],
      changedBy: actor,
    });
    expect(changedAt).toMatch(ISO_INSTANT_SHAPE);
    expect(new Date(changedAt as string).toISOString()).toBe(changedAt);

    // The whole stored message, envelope included, pinned and searched at every depth: the exact
    // shape (an unknown key anywhere, `actor` too, is a failure; `changedAt` and `occurredAt` are
    // the only fields exempt from the search, and must hold a strict instant), and the new values
    // nowhere in it — as a key, a value, part of one, or a number written another way (`500`,
    // `"500"`, `5e2`). `intervalHours` may only be a NAME in `changedFields`, so it is refused as
    // a key. Never as a substring of the payload's JSON alone: that text carries instants a short
    // number can occur inside by chance.
    expectStoredMessageWithout(events[1].envelope, {
      anywhere: ['500.00', '50.00'],
      numbers: ['500.00', '50.00'],
      inKeys: ['intervalHours', 'leadHours', 'lastServicedHourMeter'],
      shape: envelopeShape({
        scheduleId: 'string',
        assetId: 'string',
        organizationId: 'string',
        change: 'string',
        status: 'string',
        previousStatus: ['string', 'null'],
        reason: ['string', 'null'],
        changedFields: arrayOf('string'),
        changedBy: 'string',
        changedAt: 'instant',
      }),
    });
    expect(JSON.stringify(events[1].envelope)).not.toContain('500.00');
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

    const refusal = (await create().catch((error: unknown) => error)) as RastaError;
    expect(refusal).toBeInstanceOf(RastaError);
    expect(refusal.code).toBe('BUSINESS_RULE_VIOLATION');
    // The title is client text: the refusal names the field, never the value (S-09).
    expect(refusal.internalContext).toEqual({
      rule: 'DUPLICATE_SCHEDULE_TITLE',
      assetId,
      field: 'title',
    });
    expect(JSON.stringify([refusal.message, refusal.internalContext])).not.toContain(title);

    expect(await countEvents()).toBe(before);

    const schedulesOnAsset = await asActor({ organizationId: org.a }, () =>
      prisma.client.maintenanceSchedule.count({ where: { assetId, title } }),
    );
    expect(schedulesOnAsset).toBe(1);
  });

  // The same constraint, reached by renaming a schedule rather than creating
  // one: the refusal is the create path's, not a 500 out of the driver.
  it('refuses an edit that takes another live schedule’s title, and writes nothing', async () => {
    const { assetId, schedule: taken } = await ownSchedule('عنوان گرفته‌شده');
    const renamed = await asActor({ organizationId: org.a, userId: actor }, () =>
      schedules.create({
        assetId,
        title: 'عنوان دیگر',
        maintenanceType: 'PREVENTIVE',
        recurrence: 'RECURRING',
        intervalDays: 90,
      }),
    );
    const eventsBefore = await eventsFor(renamed.id);

    const refusal = (await asActor({ organizationId: org.a, userId: actor }, () =>
      schedules.update(renamed.id, { title: taken.title, intervalDays: 30 }),
    ).catch((error: unknown) => error)) as RastaError;

    expect(refusal).toBeInstanceOf(RastaError);
    expect(refusal.code).toBe('BUSINESS_RULE_VIOLATION');
    expect(refusal.status).toBe(422);
    expect(refusal.message).toBe('This machine already has a live schedule with that title.');
    expect(refusal.internalContext).toEqual({
      rule: 'DUPLICATE_SCHEDULE_TITLE',
      assetId,
      field: 'title',
    });
    expect(JSON.stringify([refusal.message, refusal.internalContext])).not.toContain(taken.title);

    // The edit and its announcement rolled back together.
    expect(await eventsFor(renamed.id)).toHaveLength(eventsBefore.length);
    const row = await asActor({ organizationId: org.a }, () =>
      prisma.client.maintenanceSchedule.findUniqueOrThrow({ where: { id: renamed.id } }),
    );
    expect(row).toMatchObject({ title: 'عنوان دیگر', intervalDays: 90 });
  });

  it('still lets an archived schedule’s title be taken by an edit', async () => {
    const { assetId, schedule: archived } = await ownSchedule('عنوان بایگانی‌شده');
    await asActor({ organizationId: org.a, userId: actor }, () =>
      schedules.changeStatus(archived.id, { status: 'ARCHIVED', reason: 'جایگزین شد' }),
    );
    const live = await asActor({ organizationId: org.a, userId: actor }, () =>
      schedules.create({
        assetId,
        title: 'عنوان تازه',
        maintenanceType: 'PREVENTIVE',
        recurrence: 'RECURRING',
        intervalDays: 90,
      }),
    );

    const edited = await asActor({ organizationId: org.a, userId: actor }, () =>
      schedules.update(live.id, { title: archived.title }),
    );
    expect(edited.title).toBe(archived.title);
  });
});
