import type { NotificationActor } from '../access/access';
import type { EventPublisher } from '../events/publisher';
import { NOTIFICATION_EVENTS, validateNotificationPayload } from '../events/published';
import type { PrismaService } from '../prisma/prisma.service';
import type { PreferenceInput } from './preferences.dto';
import { PreferencesRepository, type QuietHoursRow } from './preferences.repository';

/**
 * Preference and quiet-hours changes are audited (AGENTS.md S-06, global audit
 * L7-14): one event per change, in the transaction that made it, and none for
 * a call that changed nothing.
 *
 * The transaction client is a stand-in holding the rows in memory; that the
 * event and the rows really commit together is proven against PostgreSQL in
 * `test/preferences-audit.int-spec.ts`.
 */

const ACTOR: NotificationActor = {
  userId: 'USR_1',
  organizationId: 'ORG_A',
} as NotificationActor;
const NOW = new Date('2026-09-25T20:00:00.000Z');

interface Stored {
  scope: string;
  scopeKey: string | null;
  channel: string;
  enabled: boolean;
}

function harness(initial: { preferences?: Stored[]; quietHours?: QuietHoursRow | null } = {}) {
  let preferences: Stored[] = [...(initial.preferences ?? [])];
  let quietHours: QuietHoursRow | null = initial.quietHours ?? null;

  const tx = {
    $executeRaw: jest.fn(async () => 1),
    notificationPreference: {
      findMany: jest.fn(async () => preferences.map((row) => ({ ...row }))),
      deleteMany: jest.fn(async () => {
        const count = preferences.length;
        preferences = [];
        return { count };
      }),
      createMany: jest.fn(async ({ data }: { data: Stored[] }) => {
        preferences = data.map(({ scope, scopeKey, channel, enabled }) => ({
          scope,
          scopeKey,
          channel,
          enabled,
        }));
        return { count: data.length };
      }),
    },
    notificationQuietHours: {
      findUnique: jest.fn(async () => (quietHours ? { ...quietHours } : null)),
      deleteMany: jest.fn(async () => {
        const count = quietHours ? 1 : 0;
        quietHours = null;
        return { count };
      }),
      upsert: jest.fn(async ({ update }: { update: QuietHoursRow }) => {
        quietHours = {
          startMinute: update.startMinute,
          endMinute: update.endMinute,
          timezone: update.timezone,
        };
        return quietHours;
      }),
    },
  };

  const prisma = {
    transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;

  const enqueued: Array<{
    tx: unknown;
    eventName: string;
    aggregateId: string;
    organizationId: string;
    payload: unknown;
  }> = [];
  const events = {
    enqueue: jest.fn(async (client: unknown, input: Omit<(typeof enqueued)[number], 'tx'>) => {
      // Validated as the real publisher does, so a payload the contract would
      // refuse fails here too.
      validateNotificationPayload(input.eventName as never, input.payload);
      enqueued.push({ tx: client, ...input });
      return 'EVT_1';
    }),
  } as unknown as EventPublisher;

  return {
    tx,
    enqueued,
    repository: new PreferencesRepository(prisma, events),
    stored: () => ({ preferences, quietHours }),
  };
}

const input = (overrides: Partial<PreferenceInput>): PreferenceInput =>
  ({
    scope: 'RULE',
    scopeKey: 'INSURANCE_EXPIRING_30D',
    channel: 'EMAIL',
    enabled: false,
    ...overrides,
  }) as PreferenceInput;

describe('replaceOwn — audit', () => {
  it('records exactly one NOTIFICATION_PREFERENCES_REPLACED, in the write transaction, under the actor’s tenant', async () => {
    const h = harness();

    await h.repository.replaceOwn(
      ACTOR,
      [
        input({ channel: 'IN_APP', enabled: true }),
        input({ scope: 'GLOBAL', scopeKey: 'ignored' }),
      ],
      NOW,
    );

    expect(h.enqueued).toEqual([
      {
        tx: h.tx,
        eventName: NOTIFICATION_EVENTS.NOTIFICATION_PREFERENCES_REPLACED,
        aggregateId: 'ORG_A:USR_1',
        organizationId: 'ORG_A',
        payload: {
          // The whole new set, in a fixed order, with a GLOBAL row's key
          // dropped exactly as it is stored.
          preferences: [
            { scope: 'GLOBAL', scopeKey: null, channel: 'EMAIL', enabled: false },
            { scope: 'RULE', scopeKey: 'INSURANCE_EXPIRING_30D', channel: 'IN_APP', enabled: true },
          ],
          organizationId: 'ORG_A',
          userId: 'USR_1',
          occurredAt: NOW.toISOString(),
        },
      },
    ]);
  });

  it('records clearing every preference as an empty set', async () => {
    const h = harness({
      preferences: [{ scope: 'GLOBAL', scopeKey: null, channel: 'EMAIL', enabled: false }],
    });

    await h.repository.replaceOwn(ACTOR, [], NOW);

    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0].payload).toMatchObject({ preferences: [] });
    expect(h.stored().preferences).toEqual([]);
  });

  it('records nothing when the set in force is submitted again, in any order', async () => {
    const current = [
      { scope: 'RULE', scopeKey: 'INSURANCE_EXPIRING_30D', channel: 'EMAIL', enabled: false },
      { scope: 'GLOBAL', scopeKey: null, channel: 'IN_APP', enabled: false },
    ];
    const h = harness({ preferences: current });

    await h.repository.replaceOwn(
      ACTOR,
      [
        input({ scope: 'GLOBAL', scopeKey: null, channel: 'IN_APP' }),
        input({ scope: 'RULE', scopeKey: 'INSURANCE_EXPIRING_30D', channel: 'EMAIL' }),
      ],
      NOW,
    );

    expect(h.enqueued).toEqual([]);
    // Nor is anything written: the rows, their ids and timestamps stay as they
    // are (Codex #114 R1-3).
    expect(h.tx.notificationPreference.deleteMany).not.toHaveBeenCalled();
    expect(h.tx.notificationPreference.createMany).not.toHaveBeenCalled();
  });

  it('records a flip of one flag', async () => {
    const h = harness({
      preferences: [{ scope: 'GLOBAL', scopeKey: null, channel: 'EMAIL', enabled: false }],
    });

    await h.repository.replaceOwn(ACTOR, [input({ scope: 'GLOBAL', enabled: true })], NOW);

    expect(h.enqueued).toHaveLength(1);
  });
});

describe('serialisation (Codex #114 R1-4)', () => {
  it('takes the per-person lock before reading, in both operations', async () => {
    for (const run of [
      (h: ReturnType<typeof harness>) => h.repository.replaceOwn(ACTOR, [], NOW),
      (h: ReturnType<typeof harness>) => h.repository.replaceQuietHours(ACTOR, null, NOW),
    ]) {
      const h = harness();
      await run(h);
      expect(h.tx.$executeRaw).toHaveBeenCalledTimes(1);
      const lockedAt = h.tx.$executeRaw.mock.invocationCallOrder[0]!;
      const firstRead = Math.min(
        ...[
          ...h.tx.notificationPreference.findMany.mock.invocationCallOrder,
          ...h.tx.notificationQuietHours.findUnique.mock.invocationCallOrder,
        ],
      );
      expect(lockedAt).toBeLessThan(firstRead);
    }
  });
});

describe('replaceQuietHours — audit', () => {
  const WINDOW: QuietHoursRow = {
    startMinute: 22 * 60,
    endMinute: 7 * 60,
    timezone: 'Asia/Tehran',
  };

  it('records exactly one NOTIFICATION_QUIET_HOURS_CHANGED when a window is set', async () => {
    const h = harness();

    await h.repository.replaceQuietHours(ACTOR, WINDOW, NOW);

    expect(h.enqueued).toEqual([
      {
        tx: h.tx,
        eventName: NOTIFICATION_EVENTS.NOTIFICATION_QUIET_HOURS_CHANGED,
        aggregateId: 'ORG_A:USR_1',
        organizationId: 'ORG_A',
        payload: {
          quietHours: WINDOW,
          organizationId: 'ORG_A',
          userId: 'USR_1',
          occurredAt: NOW.toISOString(),
        },
      },
    ]);
  });

  it('records a cleared window as null', async () => {
    const h = harness({ quietHours: WINDOW });

    await h.repository.replaceQuietHours(ACTOR, null, NOW);

    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0].payload).toMatchObject({ quietHours: null });
  });

  it('records a moved window', async () => {
    const h = harness({ quietHours: WINDOW });

    await h.repository.replaceQuietHours(ACTOR, { ...WINDOW, endMinute: 6 * 60 }, NOW);

    expect(h.enqueued).toHaveLength(1);
  });

  it.each([
    ['clearing a window that was never set', null, null],
    ['setting the window already in force', WINDOW, WINDOW],
  ])('records nothing for %s', async (_label, before, next) => {
    const h = harness({ quietHours: before });

    await h.repository.replaceQuietHours(ACTOR, next, NOW);

    expect(h.enqueued).toEqual([]);
    // …and writes nothing (Codex #114 R1-3).
    expect(h.tx.notificationQuietHours.deleteMany).not.toHaveBeenCalled();
    expect(h.tx.notificationQuietHours.upsert).not.toHaveBeenCalled();
  });
});
