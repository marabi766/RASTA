import type { EventEnvelope } from '@rasta/contracts';
import { AssetSyncConsumer, CONSUMER_NAME } from './asset-sync.consumer';
import type { FleetRepository } from '../fleet/fleet.repository';

/**
 * The consumer drives the replica that every availability answer is built on,
 * and the safety blocks that keep an uninspected machine off the road. Both
 * are tested here without a broker: the projector takes an envelope, so a test
 * can hand it one directly.
 */

interface Recorded {
  upserts: Record<string, unknown>[];
  processed: string[];
}

function buildConsumer(options: {
  existing?: Record<string, unknown> | null;
  alreadyProcessed?: boolean;
}) {
  const recorded: Recorded = { upserts: [], processed: [] };

  const repository = {
    findAssetRef: jest.fn(async () => options.existing ?? null),
    transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    markEventProcessed: jest.fn(async (_tx: unknown, eventId: string) => {
      if (options.alreadyProcessed) return false;
      recorded.processed.push(eventId);
      return true;
    }),
    upsertAssetRef: jest.fn(async (_tx: unknown, data: Record<string, unknown>) => {
      recorded.upserts.push(data);
      return data;
    }),
  } as unknown as FleetRepository;

  return { consumer: new AssetSyncConsumer(null, repository), repository, recorded };
}

function envelope(overrides: Partial<EventEnvelope> & { eventName: string }): EventEnvelope {
  return {
    eventId: '01JBQ8Z4K7M2N5P8R1T3V6X9Y2',
    eventVersion: 1,
    occurredAt: '2026-08-27T10:00:00.000Z',
    producer: 'asset-service',
    producerVersion: '0.1.0',
    aggregateType: 'Asset',
    aggregateId: 'AST-SEED-0001',
    tenantId: 'ORG-DEH-0001',
    correlationId: 'corr-1',
    payload: {},
    ...overrides,
  };
}

describe('AssetSyncConsumer', () => {
  describe('events it does not project', () => {
    it('skips rather than failing', async () => {
      // These topics carry far more than this service cares about — every
      // location update, every document attachment. Forward compatibility
      // depends on ignoring the rest (docs/07 § 7.6).
      const { consumer, recorded } = buildConsumer({});
      const outcome = await consumer.handle(
        envelope({ eventName: 'ASSET_LOCATION_RECORDED', payload: { assetId: 'AST-SEED-0001' } }),
      );

      expect(outcome).toBe('SKIPPED');
      expect(recorded.upserts).toHaveLength(0);
    });
  });

  describe('replica maintenance', () => {
    it('records a newly registered machine', async () => {
      const { consumer, recorded } = buildConsumer({});
      await consumer.handle(
        envelope({
          eventName: 'ASSET_CREATED',
          payload: {
            assetId: 'AST-SEED-0009',
            organizationId: 'ORG-DEH-0001',
            name: 'لودر نمونه',
            type: 'LOADER',
            assetTag: '۱۲',
            status: 'REGISTERED',
          },
        }),
      );

      expect(recorded.upserts[0]).toMatchObject({
        id: 'AST-SEED-0009',
        organizationId: 'ORG-DEH-0001',
        name: 'لودر نمونه',
        assetType: 'LOADER',
        status: 'REGISTERED',
      });
    });

    it('applies a status change without touching the rest of the row', async () => {
      const { consumer, recorded } = buildConsumer({
        existing: { id: 'AST-SEED-0001', organizationId: 'ORG-DEH-0001', name: 'گریدر' },
      });

      await consumer.handle(
        envelope({
          eventName: 'ASSET_STATUS_CHANGED',
          payload: {
            assetId: 'AST-SEED-0001',
            organizationId: 'ORG-DEH-0001',
            previousStatus: 'ACTIVE',
            newStatus: 'OUT_OF_SERVICE',
            reason: 'گزارش خرابی',
          },
        }),
      );

      const patch = recorded.upserts[0]!;
      expect(patch.status).toBe('OUT_OF_SERVICE');
      // A status event says nothing about the name, so the name must not be
      // written — an undefined key would blank a value an earlier event set.
      expect(patch).not.toHaveProperty('name');
    });

    it('follows a machine to its new owner on transfer', async () => {
      // A replica that kept the old owner would keep offering the machine in
      // the wrong organization's availability listing.
      const { consumer, recorded } = buildConsumer({
        existing: { id: 'AST-SEED-0001', organizationId: 'ORG-DEH-0001' },
      });

      await consumer.handle(
        envelope({
          eventName: 'ASSET_TRANSFERRED',
          payload: {
            assetId: 'AST-SEED-0001',
            fromOrganizationId: 'ORG-DEH-0001',
            toOrganizationId: 'ORG-DEH-0002',
            reason: 'واگذاری',
          },
        }),
      );

      expect(recorded.upserts[0]).toMatchObject({
        organizationId: 'ORG-DEH-0002',
        // The new owner must re-commission it: their insurance, their
        // paperwork — exactly as asset-service records it.
        status: 'REGISTERED',
      });
    });

    it('ignores ASSET_UPDATED values because the event carries none', async () => {
      // The event carries changed field *names*, never their values, so a
      // rename does not put the old value on a topic every service retains.
      const { consumer, recorded } = buildConsumer({
        existing: { id: 'AST-SEED-0001', organizationId: 'ORG-DEH-0001', name: 'گریدر' },
      });

      await consumer.handle(
        envelope({
          eventName: 'ASSET_UPDATED',
          payload: {
            assetId: 'AST-SEED-0001',
            organizationId: 'ORG-DEH-0001',
            changedFields: ['name'],
          },
        }),
      );

      const patch = recorded.upserts[0]!;
      expect(patch).not.toHaveProperty('name');
      expect(patch).not.toHaveProperty('status');
    });
  });

  describe('safety withdrawals', () => {
    it('blocks dispatch when a technical inspection fails', async () => {
      // The catalogue is explicit that this is a safety event, not an
      // administrative one: fleet must take the machine off the dispatch list
      // immediately (docs/events/README.md § Insurance).
      const { consumer, recorded } = buildConsumer({
        existing: { id: 'AST-SEED-0001', organizationId: 'ORG-DEH-0001' },
      });

      await consumer.handle(
        envelope({
          eventName: 'INSPECTION_FAILED',
          producer: 'asset-service',
          payload: {
            assetId: 'AST-SEED-0001',
            organizationId: 'ORG-DEH-0001',
            inspectionId: 'INP-1',
            notes: 'ترمز',
          },
        }),
      );

      expect(recorded.upserts[0]!.dispatchBlockedReason).toBe(
        'The most recent technical inspection failed',
      );
      expect(recorded.upserts[0]!.dispatchBlockedAt).toBeInstanceOf(Date);
    });

    it('blocks dispatch when insurance lapses', async () => {
      const { consumer, recorded } = buildConsumer({
        existing: { id: 'AST-SEED-0001', organizationId: 'ORG-DEH-0001' },
      });

      await consumer.handle(
        envelope({
          eventName: 'INSURANCE_EXPIRED',
          payload: {
            assetId: 'AST-SEED-0001',
            organizationId: 'ORG-DEH-0001',
            policyId: 'INS-1',
            validTo: '2026-08-01T00:00:00.000Z',
          },
        }),
      );

      expect(recorded.upserts[0]!.dispatchBlockedReason).toBe('The insurance policy has expired');
    });

    it('clears the block and the maintenance flag when a repair completes', async () => {
      const { consumer, recorded } = buildConsumer({
        existing: {
          id: 'AST-SEED-0001',
          organizationId: 'ORG-DEH-0001',
          inMaintenance: true,
          dispatchBlockedReason: 'The most recent technical inspection failed',
        },
      });

      await consumer.handle(
        envelope({
          eventName: 'MAINTENANCE_COMPLETED',
          producer: 'maintenance-service',
          payload: { assetId: 'AST-SEED-0001', organizationId: 'ORG-DEH-0001', requestId: 'MNT-1' },
        }),
      );

      expect(recorded.upserts[0]).toMatchObject({
        inMaintenance: false,
        dispatchBlockedReason: null,
        dispatchBlockedAt: null,
      });
    });

    it('withdraws a machine while it is in the workshop', async () => {
      const { consumer, recorded } = buildConsumer({
        existing: { id: 'AST-SEED-0001', organizationId: 'ORG-DEH-0001' },
      });

      await consumer.handle(
        envelope({
          eventName: 'MAINTENANCE_STARTED',
          producer: 'maintenance-service',
          payload: { assetId: 'AST-SEED-0001', organizationId: 'ORG-DEH-0001', requestId: 'MNT-1' },
        }),
      );

      expect(recorded.upserts[0]!.inMaintenance).toBe(true);
    });
  });

  describe('idempotency', () => {
    it('applies nothing when the event was already handled', async () => {
      // The outbox guarantees at-least-once, so a redelivery is normal
      // operation. The marker and the effect share a transaction, so finding
      // the marker means the effect is already durable (docs/07 § 7.5).
      const { consumer, recorded } = buildConsumer({
        existing: { id: 'AST-SEED-0001', organizationId: 'ORG-DEH-0001' },
        alreadyProcessed: true,
      });

      await consumer.handle(
        envelope({
          eventName: 'ASSET_DECOMMISSIONED',
          payload: {
            assetId: 'AST-SEED-0001',
            organizationId: 'ORG-DEH-0001',
            reason: 'اسقاط',
            decommissionedAt: '2026-08-27T10:00:00.000Z',
          },
        }),
      );

      expect(recorded.upserts).toHaveLength(0);
    });

    it('marks under a consumer name of its own', async () => {
      // One group per (service, purpose). Sharing the marker namespace with
      // another consumer would let one consumer's progress suppress another's.
      expect(CONSUMER_NAME).toBe('fleet-service.asset-sync');
    });
  });

  describe('malformed producer output', () => {
    it('skips an event that names no machine', async () => {
      // A producer defect worth seeing, but not one a retry fixes — so it is
      // logged and skipped rather than dead-lettered, where it would only be
      // quieter.
      const { consumer, recorded } = buildConsumer({});
      const outcome = await consumer.handle(
        envelope({ eventName: 'ASSET_CREATED', payload: { organizationId: 'ORG-DEH-0001' } }),
      );

      expect(outcome).toBe('SKIPPED');
      expect(recorded.upserts).toHaveLength(0);
    });

    it('refuses to invent an organization for a first sighting with no tenant', async () => {
      // Guessing would invent the very fact the replica exists to carry, and
      // would place a machine in an organization that does not own it.
      const { consumer, recorded } = buildConsumer({});
      const outcome = await consumer.handle(
        envelope({
          eventName: 'ASSET_CREATED',
          tenantId: undefined,
          payload: { assetId: 'AST-UNKNOWN', name: 'بی‌سازمان' },
        }),
      );

      expect(outcome).toBe('SKIPPED');
      expect(recorded.upserts).toHaveLength(0);
    });

    it('falls back to the envelope tenant when the payload omits it', async () => {
      const { consumer, recorded } = buildConsumer({});
      await consumer.handle(
        envelope({
          eventName: 'ASSET_CREATED',
          tenantId: 'ORG-DEH-0002',
          payload: { assetId: 'AST-SEED-0010', name: 'کامیون', status: 'REGISTERED' },
        }),
      );

      expect(recorded.upserts[0]!.organizationId).toBe('ORG-DEH-0002');
    });
  });
});
