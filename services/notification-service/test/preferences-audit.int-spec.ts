import { runUnscoped } from '@rasta/nest-common';
import { EventPublisher } from '../src/events/publisher';
import { NOTIFICATION_EVENTS } from '../src/events/published';
import type { NotificationEnv } from '../src/config/env';
import type { PrismaService } from '../src/prisma/prisma.service';
import { PreferencesRepository } from '../src/preferences/preferences.repository';
import { PreferencesService } from '../src/preferences/preferences.service';
import { asUser, cleanup, newOrganizationId, newPrisma, newUserId } from './helpers';

/**
 * Preference and quiet-hours changes reach the audit trail (AGENTS.md S-06,
 * global audit L7-14), against a real PostgreSQL.
 *
 * Driven through `PreferencesService` inside a user context, so the actor on
 * each envelope is the one the request carried — exactly as over HTTP — and
 * the tenant is the one the service resolved from it.
 */
describe('preference changes are audited (L7-14)', () => {
  let prisma: PrismaService;
  let events: EventPublisher;
  let service: PreferencesService;
  const organizations: string[] = [];

  function organization(): string {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  }

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    await prisma.client.$queryRawUnsafe('SELECT 1');
    events = new EventPublisher({ SERVICE_VERSION: '0.1.0' } as NotificationEnv);
    service = new PreferencesService(new PreferencesRepository(prisma, events));
  });

  afterAll(async () => {
    await cleanup(prisma, organizations);
    await runUnscoped('integration cleanup removes exactly what the suite wrote', async () => {
      const where = { organizationId: { in: organizations } };
      await prisma.client.notificationPreference.deleteMany({ where });
      await prisma.client.outboxMessage.deleteMany({ where });
    });
    await prisma.onModuleDestroy();
  });

  const eventsFor = (organizationId: string, eventName: string) =>
    runUnscoped('a test reading the outbox the way the relay does', () =>
      prisma.client.outboxMessage.findMany({
        where: { organizationId, eventName },
        orderBy: { createdAt: 'asc' },
      }),
    );

  type Envelope = {
    tenantId?: string;
    actor?: { type: string; id: string };
    aggregateType: string;
    aggregateId: string;
    payload: Record<string, unknown>;
  };

  it('commits one NOTIFICATION_PREFERENCES_REPLACED per real change, with the user as actor', async () => {
    const org = organization();
    const me = newUserId();
    const set = [{ scope: 'GLOBAL' as const, channel: 'EMAIL' as const, enabled: false }];

    await asUser(org, me, () => service.replaceOwn(set));
    // The same set again changes nothing and records nothing.
    await asUser(org, me, () => service.replaceOwn(set));

    const rows = await eventsFor(org, NOTIFICATION_EVENTS.NOTIFICATION_PREFERENCES_REPLACED);
    expect(rows).toHaveLength(1);
    const envelope = rows[0].payload as Envelope;
    expect(rows[0].topic).toBe('rasta.notification.v1');
    expect(rows[0].partitionKey).toBe(me);
    expect(envelope.tenantId).toBe(org);
    expect(envelope.actor).toEqual({ type: 'USER', id: me });
    expect(envelope.aggregateType).toBe('NotificationPreferences');
    expect(envelope.aggregateId).toBe(`${org}:${me}`);
    expect(envelope.payload).toMatchObject({
      preferences: [{ scope: 'GLOBAL', scopeKey: null, channel: 'EMAIL', enabled: false }],
      organizationId: org,
      userId: me,
    });
  });

  it('commits one NOTIFICATION_QUIET_HOURS_CHANGED for set and one for clear', async () => {
    const org = organization();
    const me = newUserId();
    const window = { start: '22:00', end: '07:00', timezone: 'Asia/Tehran' };

    await asUser(org, me, () => service.replaceQuietHours(window));
    await asUser(org, me, () => service.replaceQuietHours(window));
    await asUser(org, me, () => service.replaceQuietHours(null));
    await asUser(org, me, () => service.replaceQuietHours(null));

    const rows = await eventsFor(org, NOTIFICATION_EVENTS.NOTIFICATION_QUIET_HOURS_CHANGED);
    expect(rows.map((row) => (row.payload as Envelope).payload.quietHours)).toEqual([
      { startMinute: 22 * 60, endMinute: 7 * 60, timezone: 'Asia/Tehran' },
      null,
    ]);
    for (const row of rows) {
      expect((row.payload as Envelope).actor).toEqual({ type: 'USER', id: me });
      expect(row.organizationId).toBe(org);
    }
  });

  it.each([
    [
      'preferences',
      () => service.replaceOwn([{ scope: 'GLOBAL', channel: 'EMAIL', enabled: false }]),
    ],
    [
      'quiet hours',
      () => service.replaceQuietHours({ start: '22:00', end: '07:00', timezone: 'Asia/Tehran' }),
    ],
  ])('rolls a %s change and its event back together', async (_label, change) => {
    const org = organization();
    const me = newUserId();
    const original = events.enqueue.bind(events);
    // Fails *after* the outbox insert, inside the same transaction: if the
    // rows and the event were not atomic, one of them would survive.
    const spy = jest.spyOn(events, 'enqueue').mockImplementationOnce(async (tx, input) => {
      await original(tx, input);
      throw new Error('failure after the outbox insert');
    });

    try {
      await expect(asUser(org, me, change)).rejects.toThrow('failure after the outbox insert');
    } finally {
      spy.mockRestore();
    }

    const left = await runUnscoped('assertions read the rows directly', async () => ({
      preferences: await prisma.client.notificationPreference.count({
        where: { organizationId: org },
      }),
      quietHours: await prisma.client.notificationQuietHours.count({
        where: { organizationId: org },
      }),
      events: await prisma.client.outboxMessage.count({ where: { organizationId: org } }),
    }));
    expect(left).toEqual({ preferences: 0, quietHours: 0, events: 0 });
  });

  it('files one person’s change under their own tenant only', async () => {
    const orgA = organization();
    const orgB = organization();
    const me = newUserId();

    // The same person, a member of two organizations, changes their settings
    // in one of them. Nothing is recorded against the other.
    await asUser(orgA, me, () =>
      service.replaceOwn([{ scope: 'GLOBAL', channel: 'EMAIL', enabled: false }]),
    );

    expect(
      await eventsFor(orgA, NOTIFICATION_EVENTS.NOTIFICATION_PREFERENCES_REPLACED),
    ).toHaveLength(1);
    expect(
      await eventsFor(orgB, NOTIFICATION_EVENTS.NOTIFICATION_PREFERENCES_REPLACED),
    ).toHaveLength(0);
  });
});
