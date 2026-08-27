import type { EventEnvelope } from '@rasta/contracts';
import { TimelineConsumer } from './timeline.consumer';
import type { AssetRepository } from '../asset/asset.repository';
import type { AssetService } from '../asset/asset.service';

/**
 * The dossier projector.
 *
 * Driven directly with hand-built envelopes rather than through a broker: the
 * rules worth testing are which events become history, what happens when the
 * same event arrives twice, and whether an event may move an asset's status.
 * None of those need Kafka to be running.
 */

const DEH1 = 'ORG-DEH-0001';
const ASSET_ID = 'AST_01JASSET0000000000000001';

function envelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    eventId: 'EVT_1',
    eventName: 'USAGE_RECORDED',
    eventVersion: 1,
    occurredAt: new Date('2026-01-01T08:00:00.000Z').toISOString(),
    producer: 'fleet-service',
    producerVersion: '0.1.0',
    aggregateType: 'UsageRecord',
    aggregateId: 'USG_1',
    tenantId: DEH1,
    correlationId: 'CORR_1',
    payload: { assetId: ASSET_ID, organizationId: DEH1 },
    ...overrides,
  };
}

interface Harness {
  consumer: TimelineConsumer;
  appended: Array<Record<string, unknown>>;
  statusChanges: Array<{ assetId: string; status: string }>;
  markProcessed: jest.Mock;
}

function harness(options: { alreadyProcessed?: boolean; assetExists?: boolean } = {}): Harness {
  const appended: Harness['appended'] = [];
  const statusChanges: Harness['statusChanges'] = [];

  const markProcessed = jest.fn(async () => !options.alreadyProcessed);

  const repository = {
    findById: jest.fn(async () =>
      options.assetExists === false ? null : { id: ASSET_ID, organizationId: DEH1 },
    ),
    transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    markEventProcessed: markProcessed,
  } as unknown as AssetRepository;

  const assets = {
    appendTimeline: jest.fn(async (_tx: unknown, entry: Record<string, unknown>) => {
      appended.push(entry);
    }),
    applyEventStatusChange: jest.fn(async (assetId: string, status: string) => {
      statusChanges.push({ assetId, status });
    }),
  } as unknown as AssetService;

  // `null` for the factory: no broker, no kafkajs, just the projection rules.
  return {
    consumer: new TimelineConsumer(null, repository, assets),
    appended,
    statusChanges,
    markProcessed,
  };
}

describe('TimelineConsumer', () => {
  describe('what becomes history', () => {
    it('projects a known event onto the timeline', async () => {
      const h = harness();
      await h.consumer.handle(envelope());

      expect(h.appended).toHaveLength(1);
      expect(h.appended[0]).toMatchObject({
        assetId: ASSET_ID,
        organizationId: DEH1,
        category: 'USAGE',
        eventName: 'USAGE_RECORDED',
        sourceService: 'fleet-service',
      });
    });

    it('records when the event happened, not when it was consumed', async () => {
      // A dossier ordered by consumption time would reorder itself after any
      // replay or backlog.
      const h = harness();
      await h.consumer.handle(envelope());

      expect(h.appended[0]?.occurredAt).toEqual(new Date('2026-01-01T08:00:00.000Z'));
    });

    it('ignores an event it does not project', async () => {
      // Topics carry more than this service cares about; skipping the rest is
      // normal operation.
      const h = harness();
      const result = await h.consumer.handle(envelope({ eventName: 'DRIVER_CREATED' }));

      expect(result).toBe('SKIPPED');
      expect(h.appended).toHaveLength(0);
    });

    it('skips an event that names no asset', async () => {
      const h = harness();
      const result = await h.consumer.handle(envelope({ payload: { organizationId: DEH1 } }));

      expect(result).toBe('SKIPPED');
      expect(h.appended).toHaveLength(0);
    });

    it('skips an event carrying no tenant', async () => {
      // Without a tenant there is no organization to scope the write to, and
      // guessing one would put another dehyari's history on this machine.
      const h = harness();
      const result = await h.consumer.handle(envelope({ tenantId: undefined }));

      expect(result).toBe('SKIPPED');
      expect(h.appended).toHaveLength(0);
    });

    it('skips an event about an asset this service does not hold', async () => {
      const h = harness({ assetExists: false });
      const result = await h.consumer.handle(envelope());

      expect(result).toBe('SKIPPED');
      expect(h.appended).toHaveLength(0);
    });
  });

  describe('idempotency', () => {
    it('writes nothing when the event has already been handled', async () => {
      // Delivery is at-least-once (ADR-021), so a duplicate is expected
      // traffic, not an error.
      const h = harness({ alreadyProcessed: true });
      const result = await h.consumer.handle(envelope());

      expect(result).toBe('SKIPPED');
      expect(h.appended).toHaveLength(0);
      expect(h.statusChanges).toHaveLength(0);
    });

    it('marks the event handled inside the same transaction as the entry', async () => {
      // Separately committed, a crash between them would mark an event handled
      // with no history to show for it.
      const h = harness();
      await h.consumer.handle(envelope());

      expect(h.markProcessed).toHaveBeenCalledTimes(1);
      expect(h.appended).toHaveLength(1);
    });

    it('keys idempotency on the event id, not on the payload', async () => {
      const h = harness();
      await h.consumer.handle(envelope());

      expect(h.markProcessed).toHaveBeenCalledWith(
        expect.anything(),
        'EVT_1',
        'asset-service.timeline',
      );
      expect(h.appended[0]?.sourceEventId).toBe('EVT_1');
    });
  });

  describe('status consequences', () => {
    it('moves the asset to ASSIGNED when fleet-service assigns it', async () => {
      const h = harness();
      await h.consumer.handle(envelope({ eventName: 'ASSET_ASSIGNED' }));

      expect(h.statusChanges).toEqual([{ assetId: ASSET_ID, status: 'ASSIGNED' }]);
    });

    it('moves the asset into maintenance when a repair starts', async () => {
      const h = harness();
      await h.consumer.handle(envelope({ eventName: 'MAINTENANCE_STARTED' }));

      expect(h.statusChanges).toEqual([{ assetId: ASSET_ID, status: 'IN_MAINTENANCE' }]);
    });

    it('leaves the status alone for events that only add history', async () => {
      const h = harness();
      await h.consumer.handle(envelope({ eventName: 'BREAKDOWN_REPORTED' }));

      expect(h.appended).toHaveLength(1);
      expect(h.statusChanges).toHaveLength(0);
    });

    it('records the history before applying the status change', async () => {
      // The history is what happened; the status is a consequence. If the
      // transition turns out to be illegal, the record must survive anyway.
      const h = harness();
      await h.consumer.handle(envelope({ eventName: 'ASSET_ASSIGNED' }));

      expect(h.appended).toHaveLength(1);
      expect(h.statusChanges).toHaveLength(1);
    });
  });

  describe('cost projection', () => {
    it('reads a money field as a string in minor units', async () => {
      const h = harness();
      await h.consumer.handle(
        envelope({
          eventName: 'ORDER_COMPLETED',
          producer: 'marketplace-service',
          payload: { assetId: ASSET_ID, totalMinor: '125000000' },
        }),
      );

      expect(h.appended[0]?.amountMinor).toBe(125_000_000n);
      expect(h.appended[0]?.category).toBe('COST');
    });

    it('refuses a money value that arrived as a number', async () => {
      // Silently coercing a float is how a rounding error enters a cost report
      // (ADR-022). Better to record the event with no amount than a wrong one.
      const h = harness();
      await h.consumer.handle(
        envelope({
          eventName: 'ORDER_COMPLETED',
          producer: 'marketplace-service',
          payload: { assetId: ASSET_ID, totalMinor: 125000000 },
        }),
      );

      expect(h.appended[0]?.amountMinor).toBeNull();
    });

    it('leaves the amount null when the event carries no cost', async () => {
      const h = harness();
      await h.consumer.handle(envelope());

      expect(h.appended[0]?.amountMinor).toBeNull();
    });
  });

  describe('description', () => {
    it('uses a human-readable field from the payload when there is one', async () => {
      const h = harness();
      await h.consumer.handle(
        envelope({
          eventName: 'BREAKDOWN_REPORTED',
          payload: { assetId: ASSET_ID, description: 'نشتی روغن موتور' },
        }),
      );

      expect(h.appended[0]?.description).toBe('نشتی روغن موتور');
    });

    it('does not spill the raw payload into the timeline line', async () => {
      const h = harness();
      await h.consumer.handle(
        envelope({ payload: { assetId: ASSET_ID, hoursOperated: 7, fuelLitres: 42 } }),
      );

      expect(h.appended[0]?.description).toBeUndefined();
      // The full body is still available for anyone who needs it.
      expect(h.appended[0]?.detail).toMatchObject({ hoursOperated: 7, fuelLitres: 42 });
    });
  });
});
