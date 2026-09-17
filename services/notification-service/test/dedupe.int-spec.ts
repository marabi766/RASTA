import { runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import {
  cleanup,
  deliver,
  insuranceExpiring,
  maintenanceDue,
  MAINTENANCE_TOPIC,
  newOrganizationId,
  newUserId,
  rowsFor,
  wire,
  type Wiring,
} from './helpers';

/**
 * The regression ADR-054 § 3 exists for, at the database level.
 *
 * 120 `INSURANCE_EXPIRING` events with 120 distinct event ids — the insurance
 * sweep's actual output over a 30-day window at four sweeps a day — must
 * produce at most five in-app notifications per recipient, one per band. And
 * the two layers that make that true are proven separately, because they
 * answer different questions: the same event id twice is layer 1; different
 * event ids for one fact is layer 2. Both are required (ADR § 9 invariant 2).
 */
describe('semantic deduplication against PostgreSQL', () => {
  let w: Wiring;
  const organizations: string[] = [];

  function organization(): string {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  }

  beforeAll(async () => {
    w = wire();
    await w.prisma.onModuleInit();
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.prisma.onModuleDestroy();
  });

  it('collapses 120 distinct sweep emissions into at most five intents, and five in-app rows per recipient', async () => {
    const organizationId = organization();
    const policyId = `POL_${ulid()}`;
    const manager = newUserId();
    const admin = newUserId();
    w.recipients.answers.set(organizationId, [
      { userId: manager, role: 'FLEET_MANAGER' },
      { userId: admin, role: 'ORGANIZATION_ADMIN' },
    ]);

    const eventIds = new Set<string>();
    let created = 0;
    let deduped = 0;
    for (let hour = 0; hour < 30 * 24; hour += 6) {
      const envelope = insuranceExpiring({
        organizationId,
        policyId,
        daysRemaining: 30 - Math.floor(hour / 24),
      });
      eventIds.add(envelope.eventId);
      const outcome = await deliver(w, envelope);
      if (outcome === 'SKIPPED') deduped += 1;
      else created += 1;
    }

    expect(eventIds.size).toBe(120);
    expect(created).toBe(5);
    expect(deduped).toBe(115);

    // The dedupe rows say how often each window was hit: the bands are uneven
    // (16, 7, 4, 2 and 1 days wide) and the sweep runs four times a day.
    const before = await rowsFor(w.prisma, organizationId);
    expect(before.intents).toHaveLength(5);
    expect(before.intents.every((intent) => intent.status === 'PENDING')).toBe(true);
    expect(before.dedupe).toHaveLength(5);
    expect(before.dedupe.map((row) => row.seenCount).sort((a, b) => a - b)).toEqual([
      4, 8, 16, 28, 64,
    ]);
    expect(new Set(before.intents.map((intent) => intent.dedupeKey)).size).toBe(5);

    // Resolution: two recipients × five intents.
    await w.worker.tick();

    const after = await rowsFor(w.prisma, organizationId);
    expect(after.intents.every((intent) => intent.status === 'DISPATCHED')).toBe(true);
    expect(after.deliveries).toHaveLength(10);
    expect(
      after.deliveries.every((delivery) => delivery.status === 'SENT' && delivery.sentAt !== null),
    ).toBe(true);
    expect(after.attempts).toHaveLength(10);
    expect(after.attempts.every((attempt) => attempt.outcome === 'SUCCESS')).toBe(true);
    expect(after.inApp).toHaveLength(10);
    expect(after.inApp.filter((row) => row.userId === manager)).toHaveLength(5);
    expect(after.inApp.filter((row) => row.userId === admin)).toHaveLength(5);
    // One per band, and every band is a different message.
    const bodies = new Set(
      after.inApp.filter((row) => row.userId === manager).map((row) => row.body),
    );
    expect(bodies.size).toBe(5);
  }, 120_000);

  it('layer 1: the same event id twice is one intent — a redelivery, not a repeat', async () => {
    const organizationId = organization();
    const envelope = insuranceExpiring({
      organizationId,
      policyId: `POL_${ulid()}`,
      daysRemaining: 10,
    });

    await expect(deliver(w, envelope)).resolves.toBeUndefined();
    await expect(deliver(w, envelope)).resolves.toBe('SKIPPED');

    const rows = await rowsFor(w.prisma, organizationId);
    expect(rows.intents).toHaveLength(1);
    expect(rows.dedupe[0]?.seenCount).toBe(1);
    const marker = await w.prisma.client.processedEvent.findUnique({
      where: {
        eventId_consumerName: {
          eventId: envelope.eventId,
          consumerName: 'notification-service.dispatcher',
        },
      },
    });
    expect(marker).not.toBeNull();
  });

  it('layer 2: two distinct event ids in the same band are one intent; a new band is a second', async () => {
    const organizationId = organization();
    const policyId = `POL_${ulid()}`;

    await expect(
      deliver(w, insuranceExpiring({ organizationId, policyId, daysRemaining: 12 })),
    ).resolves.toBeUndefined();
    await expect(
      deliver(w, insuranceExpiring({ organizationId, policyId, daysRemaining: 9 })),
    ).resolves.toBe('SKIPPED');
    await expect(
      deliver(w, insuranceExpiring({ organizationId, policyId, daysRemaining: 6 })),
    ).resolves.toBeUndefined();

    const rows = await rowsFor(w.prisma, organizationId);
    expect(rows.intents).toHaveLength(2);
    expect(rows.dedupe.map((row) => row.seenCount).sort()).toEqual([1, 2]);
  });

  it('keeps two policies and two tenants apart even in the same band', async () => {
    const a = organization();
    const b = organization();

    await deliver(
      w,
      insuranceExpiring({ organizationId: a, policyId: 'POL_SHARED_ID', daysRemaining: 20 }),
    );
    await deliver(
      w,
      insuranceExpiring({ organizationId: b, policyId: 'POL_SHARED_ID', daysRemaining: 20 }),
    );
    await deliver(
      w,
      insuranceExpiring({ organizationId: a, policyId: 'POL_OTHER', daysRemaining: 20 }),
    );

    expect((await rowsFor(w.prisma, a)).intents).toHaveLength(2);
    expect((await rowsFor(w.prisma, b)).intents).toHaveLength(1);
  });

  it('notifies again once the window has expired — the declared bound, proven rather than assumed', async () => {
    const organizationId = organization();
    const policyId = `POL_${ulid()}`;

    await deliver(w, insuranceExpiring({ organizationId, policyId, daysRemaining: 20 }));
    const first = (await rowsFor(w.prisma, organizationId)).intents[0]!;

    // Replay inside the window: nothing new.
    await expect(
      deliver(w, insuranceExpiring({ organizationId, policyId, daysRemaining: 19 })),
    ).resolves.toBe('SKIPPED');

    // Age the window past its retention, as the NTF-005 sweep will one day
    // find it, then replay again.
    await runUnscoped('the test ages a dedupe window to simulate retention passing', () =>
      w.prisma.client.notificationDedupe.updateMany({
        where: { organizationId },
        data: {
          firstSeenAt: new Date(Date.now() - 46 * 86_400_000),
          lastSeenAt: new Date(Date.now() - 46 * 86_400_000),
          expiresAt: new Date(Date.now() - 86_400_000),
        },
      }),
    );
    await expect(
      deliver(w, insuranceExpiring({ organizationId, policyId, daysRemaining: 18 })),
    ).resolves.toBeUndefined();

    const rows = await rowsFor(w.prisma, organizationId);
    expect(rows.intents).toHaveLength(2);
    expect(rows.dedupe).toHaveLength(1);
    expect(rows.dedupe[0]!.intentId).not.toBe(first.id);
    expect(rows.dedupe[0]!.seenCount).toBe(1);
    expect(rows.dedupe[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('buckets MAINTENANCE_DUE by state: DUE_SOON then OVERDUE are two, a second DUE_SOON is not', async () => {
    const organizationId = organization();
    const scheduleId = `SCH_${ulid()}`;

    await expect(
      deliver(
        w,
        maintenanceDue({ organizationId, scheduleId, state: 'DUE_SOON' }),
        MAINTENANCE_TOPIC,
      ),
    ).resolves.toBeUndefined();
    await expect(
      deliver(
        w,
        maintenanceDue({ organizationId, scheduleId, state: 'DUE_SOON' }),
        MAINTENANCE_TOPIC,
      ),
    ).resolves.toBe('SKIPPED');
    await expect(
      deliver(
        w,
        maintenanceDue({ organizationId, scheduleId, state: 'OVERDUE' }),
        MAINTENANCE_TOPIC,
      ),
    ).resolves.toBeUndefined();

    const rows = await rowsFor(w.prisma, organizationId);
    expect(rows.intents).toHaveLength(2);
    expect(rows.intents.map((intent) => intent.sourceTopic)).toEqual([
      MAINTENANCE_TOPIC,
      MAINTENANCE_TOPIC,
    ]);
  });

  it('discards a stale stream position as DISCARDED, and processes an envelope without one normally', async () => {
    const organizationId = organization();
    const policyId = `POL_${ulid()}`;

    await expect(
      deliver(w, insuranceExpiring({ organizationId, policyId, daysRemaining: 20, streamSeq: 10 })),
    ).resolves.toBeUndefined();
    // An older position for the same subject, in a *different* band so
    // dedupe cannot be what stops it.
    await expect(
      deliver(w, insuranceExpiring({ organizationId, policyId, daysRemaining: 5, streamSeq: 9 })),
    ).resolves.toBe('SKIPPED');
    // No sequence at all: today's behaviour, unchanged.
    await expect(
      deliver(w, insuranceExpiring({ organizationId, policyId, daysRemaining: 2 })),
    ).resolves.toBeUndefined();

    const rows = await rowsFor(w.prisma, organizationId);
    const byStatus = rows.intents.map((intent) => [intent.status, intent.terminalReason]);
    expect(byStatus).toEqual(
      expect.arrayContaining([
        ['PENDING', null],
        ['DISCARDED', 'STALE_STREAM_SEQ'],
        ['PENDING', null],
      ]),
    );
    expect(rows.intents).toHaveLength(3);
    expect(rows.dedupe).toHaveLength(2);
  });

  it('preserves source provenance and correlation on the intent', async () => {
    const organizationId = organization();
    const envelope = insuranceExpiring({
      organizationId,
      policyId: `POL_${ulid()}`,
      daysRemaining: 20,
      streamSeq: 7,
      occurredAt: '2026-09-17T03:00:00.000Z',
    });
    await deliver(w, envelope);

    const intent = (await rowsFor(w.prisma, organizationId)).intents[0]!;
    expect(intent.sourceEventId).toBe(envelope.eventId);
    expect(intent.sourceEventName).toBe('INSURANCE_EXPIRING');
    expect(intent.sourceTopic).toBe('rasta.insurance.v1');
    expect(intent.sourcePartitionKey).toBe(envelope.aggregateId);
    expect(intent.sourceStreamSeq).toBe(7n);
    expect(intent.occurredAt.toISOString()).toBe('2026-09-17T03:00:00.000Z');
    expect(intent.correlationId).toBe(envelope.correlationId);
    expect(intent.contextData).not.toHaveProperty('organizationId');
    expect(intent.contextData).toHaveProperty('daysRemaining', 20);
  });
});
