import type { EventEnvelope } from '@rasta/contracts';
import { UsageConsumer } from './usage.consumer';
import type { MaintenanceRepository } from '../maintenance/maintenance.repository';
import type { DueAnnouncerService } from '../maintenance/due-announcer.service';

/**
 * The usage consumer, driven directly.
 *
 * No broker and no mocking of kafkajs: the class takes its consumer factory as
 * an argument precisely so that `handle()` can be called with a hand-built
 * envelope. What is worth testing here is not Kafka — it is which events are
 * folded, which are ignored, and what happens on the redelivery the
 * at-least-once outbox guarantees will come.
 */

interface Fold {
  assetId: string;
  hoursDelta: string;
  kilometresDelta: string;
  reportedHourMeter: string | null;
  reportedOdometer: string | null;
  organizationId: string;
}

function harness(
  options: {
    alreadyProcessed?: boolean;
    /** A real ledger: an id marks once. */ ledger?: boolean;
  } = {},
) {
  const folds: Fold[] = [];
  const announced: string[] = [];
  const marked: string[] = [];

  const repository = {
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn({});
    },
    async markEventProcessed(_tx: unknown, eventId: string): Promise<boolean> {
      if (options.ledger && marked.includes(eventId)) return false;
      marked.push(eventId);
      return !options.alreadyProcessed;
    },
    async foldUsageIntoMeter(_tx: unknown, input: Fold): Promise<void> {
      folds.push(input);
    },
  } as unknown as MaintenanceRepository;

  const announcer = {
    async announceForAsset(assetId: string): Promise<number> {
      announced.push(assetId);
      return 0;
    },
  } as unknown as DueAnnouncerService;

  return { consumer: new UsageConsumer(null, repository, announcer), folds, announced, marked };
}

function envelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    eventId: '01JBQ8Z4K7M2N5P8R1T3V6X9Y2',
    eventName: 'USAGE_RECORDED',
    eventVersion: 1,
    occurredAt: '2026-08-28T10:00:00.000Z',
    producer: 'fleet-service',
    aggregateType: 'UsageRecord',
    aggregateId: 'USG_1',
    tenantId: 'ORG-DEH-0001',
    correlationId: 'corr-1',
    payload: {
      usageRecordId: 'USG_1',
      assetId: 'AST-SEED-0001',
      organizationId: 'ORG-DEH-0001',
      periodEnd: '2026-08-28T09:00:00.000Z',
      hours: '8.00',
      kilometres: '0',
      hourMeter: '4318.50',
      odometer: null,
      source: 'MANUAL',
    },
    ...overrides,
  } as EventEnvelope;
}

describe('usage consumer', () => {
  it('folds a reading into the meter and assesses the machine schedules', () => {
    const { consumer, folds, announced } = harness();

    return consumer.handle(envelope()).then(() => {
      expect(folds).toHaveLength(1);
      expect(folds[0]).toMatchObject({
        assetId: 'AST-SEED-0001',
        hoursDelta: '8.00',
        reportedHourMeter: '4318.50',
        organizationId: 'ORG-DEH-0001',
      });
      // Assessment is the point of consuming this event at all: usage-based
      // maintenance is event-driven, not scanned (docs/08 § 8.7).
      expect(announced).toEqual(['AST-SEED-0001']);
    });
  });

  it('does not fold a redelivered event a second time', async () => {
    // The failure this prevents is the one fleet-service's own event contract
    // warns about: a replayed week of readings adds a week of hours the
    // machine never ran, and every schedule slips into the future.
    const { consumer, folds, announced } = harness({ alreadyProcessed: true });

    const outcome = await consumer.handle(envelope());

    expect(outcome).toBe('SKIPPED');
    expect(folds).toHaveLength(0);
    expect(announced).toHaveLength(0);
  });

  it('ignores the other events on the fleet topic', async () => {
    // `rasta.fleet.v1` also carries driver registrations, assignments and
    // availability declarations. Skipping them is normal operation, and
    // forward compatibility depends on it.
    const { consumer, folds } = harness();

    for (const eventName of ['ASSET_ASSIGNED', 'ASSIGNMENT_ENDED', 'DRIVER_REGISTERED']) {
      expect(await consumer.handle(envelope({ eventName }))).toBe('SKIPPED');
    }

    expect(folds).toHaveLength(0);
  });

  it('treats an absent quantity as zero rather than refusing the reading', async () => {
    // fleet-service requires at least one of hours or kilometres, so a
    // kilometres-only reading from a truck is valid input. Refusing it would
    // lose real usage.
    const { consumer, folds } = harness();

    await consumer.handle(
      envelope({
        payload: {
          usageRecordId: 'USG_2',
          assetId: 'AST-SEED-0003',
          organizationId: 'ORG-DEH-0001',
          kilometres: '120.50',
          odometer: '18240.00',
        },
      }),
    );

    expect(folds[0]).toMatchObject({
      hoursDelta: '0',
      kilometresDelta: '120.50',
      reportedHourMeter: null,
      reportedOdometer: '18240.00',
    });
  });

  it('takes the envelope tenant when the payload omits its organization', async () => {
    const { consumer, folds } = harness();

    await consumer.handle(
      envelope({
        payload: { usageRecordId: 'USG_3', assetId: 'AST-SEED-0001', hours: '4.00' },
      }),
    );

    expect(folds[0]?.organizationId).toBe('ORG-DEH-0001');
  });

  it.each([
    ['without a payload organization', undefined],
    ['even with a payload organization', 'ORG-DEH-0001'],
  ])(
    'dead-letters a reading with no envelope tenant, %s (L7-26, review #205 r1)',
    async (_label, organizationId) => {
      // The meter is scoped by the envelope tenant only. Folded into the
      // organization the payload names and marked processed, a wrong tenant
      // could never be corrected by a replay: refused at once, before the marker.
      const { consumer, folds, marked } = harness({ ledger: true });
      const reading = {
        usageRecordId: 'USG_4',
        assetId: 'AST-SEED-0001',
        hours: '4.00',
        ...(organizationId ? { organizationId } : {}),
      };

      await expect(
        consumer.handle(envelope({ tenantId: undefined, payload: reading })),
      ).rejects.toMatchObject({
        name: 'UnprocessableEventError',
        reason: 'VALIDATION_FAILED',
        message: 'USAGE_RECORDED 01JBQ8Z4K7M2N5P8R1T3V6X9Y2 carries no tenant',
      });
      expect(marked).toEqual([]);
      expect(folds).toHaveLength(0);

      // The corrected event, replayed with the same id, advances the meter once.
      await consumer.handle(envelope({ payload: reading }));
      await consumer.handle(envelope({ payload: reading }));
      expect(folds).toHaveLength(1);
      expect(folds[0]?.organizationId).toBe('ORG-DEH-0001');
    },
  );

  it('dead-letters a reading whose payload names another organization than its envelope (review #205 r1)', async () => {
    const { consumer, folds, marked } = harness({ ledger: true });
    const reading = (organizationId: string) => ({
      usageRecordId: 'USG_6',
      assetId: 'AST-SEED-0001',
      organizationId,
      hours: '4.00',
    });

    const refusal = consumer.handle(envelope({ payload: reading('ORG-DEH-SENTINEL') }));

    await expect(refusal).rejects.toMatchObject({
      reason: 'VALIDATION_FAILED',
      message:
        'USAGE_RECORDED 01JBQ8Z4K7M2N5P8R1T3V6X9Y2 payload organization differs from its ' +
        'envelope tenant: tenant_mismatch',
    });
    await expect(refusal).rejects.not.toHaveProperty(
      'message',
      expect.stringContaining('SENTINEL'),
    );
    expect(marked).toEqual([]);
    expect(folds).toHaveLength(0);

    await consumer.handle(envelope({ payload: reading('ORG-DEH-0001') }));
    await consumer.handle(envelope({ payload: reading('ORG-DEH-0001') }));
    expect(folds).toHaveLength(1);
    expect(folds[0]?.organizationId).toBe('ORG-DEH-0001');
  });

  it('still skips an event it does not consume, with no tenant (forward compatibility)', async () => {
    const { consumer, marked } = harness();

    const outcome = await consumer.handle(
      envelope({ eventName: 'DRIVER_REGISTERED', tenantId: undefined, payload: {} }),
    );

    expect(outcome).toBe('SKIPPED');
    expect(marked).toEqual([]);
  });

  it('dead-letters, rather than skips, a reading that names no machine (L7-26)', async () => {
    // A retry cannot add an assetId, so it is refused at once as
    // VALIDATION_FAILED — and acknowledged nowhere, so the reading is not lost.
    // The message names the field and the code, never a value.
    const { consumer, folds, marked } = harness();

    await expect(
      consumer.handle(envelope({ payload: { usageRecordId: 'USG_5', hours: '4318.75' } })),
    ).rejects.toMatchObject({
      name: 'UnprocessableEventError',
      reason: 'VALIDATION_FAILED',
      message:
        'USAGE_RECORDED 01JBQ8Z4K7M2N5P8R1T3V6X9Y2 payload fails its schema: assetId invalid_type',
    });
    expect(folds).toHaveLength(0);
    // Not marked processed, so a corrected replay of the same id still folds.
    expect(marked).toHaveLength(0);
  });

  it('folds the corrected reading replayed from the DLQ, once (L7-26)', async () => {
    const { consumer, folds, announced } = harness({ ledger: true });

    await expect(
      consumer.handle(envelope({ payload: { usageRecordId: 'USG_1', hours: '8.00' } })),
    ).rejects.toMatchObject({ reason: 'VALIDATION_FAILED' });
    await expect(consumer.handle(envelope())).resolves.toBeUndefined();
    await expect(consumer.handle(envelope())).resolves.toBe('SKIPPED');

    expect(folds).toHaveLength(1);
    expect(folds[0]).toMatchObject({ assetId: 'AST-SEED-0001', hoursDelta: '8.00' });
    expect(announced).toEqual(['AST-SEED-0001']);
  });
});
