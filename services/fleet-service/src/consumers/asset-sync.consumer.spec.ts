import type { EventEnvelope } from '@rasta/contracts';
import { tryGetContext, type OutboxMessageInput } from '@rasta/nest-common';
import { AssetSyncConsumer, CONSUMER_NAME } from './asset-sync.consumer';
import type { FleetRepository } from '../fleet/fleet.repository';
import { CONSUMED_EVENTS, CONSUMED_PAYLOADS } from '../fleet/events';

/**
 * The consumer drives the replica that every availability answer is built on,
 * and the safety blocks that keep an uninspected machine off the road. Both
 * are tested here without a broker: the projector takes an envelope, so a test
 * can hand it one directly.
 */

interface Recorded {
  upserts: Record<string, unknown>[];
  processed: string[];
  /** Every outbox row, with the actor and tenant of the context it was built in. */
  events: (OutboxMessageInput & { callerService?: string; contextTenant?: string })[];
}

/** An assignment still open on the machine, as the repository hands it back once ended. */
interface OpenAssignment {
  id: string;
  organizationId: string;
  driverId: string;
  startedAt: Date;
}

/** A live availability window of the previous owner, as the repository hands it back once revoked. */
interface LiveWindow {
  id: string;
  organizationId: string;
}

function buildConsumer(options: {
  existing?: Record<string, unknown> | null;
  alreadyProcessed?: boolean;
  open?: OpenAssignment[];
  windows?: LiveWindow[];
}) {
  const recorded: Recorded = { upserts: [], processed: [], events: [] };

  const repository = {
    endActiveAssignmentsForAsset: jest.fn(async (_tx: unknown, _assetId: string, at: Date) =>
      (options.open ?? []).map((row) => ({
        ...row,
        endedAt: row.startedAt > at ? row.startedAt : at,
      })),
    ),
    revokeWindowsAfterTransfer: jest.fn(
      async (_tx: unknown, _assetId: string, _previousOrganizationId: string, revokedAt: Date) =>
        (options.windows ?? []).map((row) => ({ ...row, revokedAt })),
    ),
    enqueueEvent: jest.fn(async (_tx: unknown, input: OutboxMessageInput) => {
      const context = tryGetContext();
      recorded.events.push({
        ...input,
        callerService: context?.callerService,
        contextTenant: context?.organizationId,
      });
      return 'OUTBOX-1';
    }),
    findAssetRefUnscoped: jest.fn(async () => options.existing ?? null),
    lockAssetRef: jest.fn(async () => undefined),
    dropTransferFences: jest.fn(async () => 0),
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
  describe('the transfer fence (ADR-062)', () => {
    it('lifts the previous owner’s fence under the asset lock, and only on a transfer', async () => {
      const { consumer, repository } = buildConsumer({
        existing: { organizationId: 'ORG-DEH-0001', status: 'ACTIVE' },
      });

      await consumer.handle(
        envelope({
          eventName: 'ASSET_TRANSFERRED',
          tenantId: 'ORG-DEH-0002',
          payload: {
            assetId: 'AST-SEED-0001',
            fromOrganizationId: 'ORG-DEH-0001',
            toOrganizationId: 'ORG-DEH-0002',
            transferredAt: '2026-08-27T10:00:00.000Z',
            reason: 'x',
          },
        }),
      );

      expect(repository.dropTransferFences).toHaveBeenCalledWith(
        expect.anything(),
        'AST-SEED-0001',
        'ORG-DEH-0001',
      );
      const lock = (repository.lockAssetRef as jest.Mock).mock.invocationCallOrder[0]!;
      const drop = (repository.dropTransferFences as jest.Mock).mock.invocationCallOrder[0]!;
      expect(lock).toBeLessThan(drop);

      await consumer.handle(
        envelope({
          eventId: 'EVT-STATUS-1',
          eventName: 'ASSET_STATUS_CHANGED',
          payload: { assetId: 'AST-SEED-0001', newStatus: 'ACTIVE' },
        }),
      );
      expect(repository.dropTransferFences).toHaveBeenCalledTimes(1);
    });
  });

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
          tenantId: 'ORG-DEH-0002',
          payload: {
            assetId: 'AST-SEED-0001',
            fromOrganizationId: 'ORG-DEH-0001',
            toOrganizationId: 'ORG-DEH-0002',
            transferredAt: '2026-08-27T10:00:00.000Z',
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

  describe('a transfer ends the assignments still open on the machine', () => {
    // asset-service refuses to transfer an ASSIGNED machine, but it learns of
    // an assignment only when it consumes ASSET_ASSIGNED. One made here in
    // that window used to survive the transfer, with the old owner's driver
    // in charge of the new owner's machine.
    const transfer = (overrides: Partial<EventEnvelope> = {}) =>
      envelope({
        eventId: 'EVT-TRANSFER-1',
        eventName: 'ASSET_TRANSFERRED',
        tenantId: 'ORG-DEH-0002',
        correlationId: 'corr-transfer',
        payload: {
          assetId: 'AST-SEED-0001',
          fromOrganizationId: 'ORG-DEH-0001',
          toOrganizationId: 'ORG-DEH-0002',
          transferredAt: '2026-08-27T10:00:00.000Z',
          reason: 'واگذاری',
        },
        ...overrides,
      });

    it.each([
      ['no toOrganizationId', { toOrganizationId: undefined }, {}],
      ['no fromOrganizationId', { fromOrganizationId: undefined }, {}],
      ['no transferredAt', { transferredAt: undefined }, {}],
      [
        'one organization twice',
        { toOrganizationId: 'ORG-DEH-0001' },
        { tenantId: 'ORG-DEH-0001' },
      ],
      ['an envelope tenant other than the new owner', {}, { tenantId: 'ORG-DEH-0003' }],
      ['an aggregate other than the asset', {}, { aggregateId: 'AST-OTHER' }],
    ])(
      'dead-letters a transfer with %s, before any marker or effect (review #127 #5)',
      async (_label, payloadOverride, envelopeOverride) => {
        const { consumer, repository, recorded } = buildConsumer({
          existing: { organizationId: 'ORG-DEH-0001', status: 'ACTIVE' },
        });
        const base = transfer();

        await expect(
          consumer.handle({
            ...base,
            ...envelopeOverride,
            payload: { ...(base.payload as object), ...payloadOverride },
          } as EventEnvelope),
        ).rejects.toMatchObject({ name: 'UnprocessableEventError', reason: 'VALIDATION_FAILED' });
        expect(repository.transaction).not.toHaveBeenCalled();
        expect(repository.markEventProcessed).not.toHaveBeenCalled();
        expect(recorded.upserts).toEqual([]);
      },
    );

    const open: OpenAssignment = {
      id: 'ASG-1',
      organizationId: 'ORG-DEH-0001',
      driverId: 'DRV-1',
      startedAt: new Date('2026-08-27T08:00:00.000Z'),
    };

    it('revokes every live window of the previous owner, as the system, and publishes each under that owner (review #225 r1, r2)', async () => {
      const { consumer, repository, recorded } = buildConsumer({
        existing: { id: 'AST-SEED-0001', organizationId: 'ORG-DEH-0001' },
        windows: [{ id: 'AVW-1', organizationId: 'ORG-DEH-0001' }],
      });

      await consumer.handle(transfer());

      expect(repository.revokeWindowsAfterTransfer).toHaveBeenCalledWith(
        expect.anything(),
        'AST-SEED-0001',
        // The previous owner's windows — never the new owner's.
        'ORG-DEH-0001',
        expect.any(Date),
        'SYSTEM',
        'ASSET_TRANSFERRED',
      );
      expect(recorded.events).toHaveLength(1);
      expect(recorded.events[0]).toMatchObject({
        eventName: 'AVAILABILITY_CHANGED',
        aggregateType: 'AvailabilityWindow',
        aggregateId: 'AVW-1',
        organizationId: 'ORG-DEH-0001',
        contextTenant: 'ORG-DEH-0001',
        callerService: 'fleet-service',
        causationId: 'EVT-TRANSFER-1',
        payload: {
          assetId: 'AST-SEED-0001',
          organizationId: 'ORG-DEH-0001',
          available: true,
          to: null,
        },
      });
    });

    it('revokes the windows after the replica names the new owner, so a declaration queued behind the lock is refused', async () => {
      const { consumer, repository } = buildConsumer({
        existing: { id: 'AST-SEED-0001', organizationId: 'ORG-DEH-0001' },
      });

      await consumer.handle(transfer());

      const upsert = (repository.upsertAssetRef as jest.Mock).mock.invocationCallOrder[0]!;
      const revoke = (repository.revokeWindowsAfterTransfer as jest.Mock).mock
        .invocationCallOrder[0]!;
      expect(upsert).toBeLessThan(revoke);
    });

    it('publishes nothing when the previous owner had no window to revoke', async () => {
      const { consumer, recorded } = buildConsumer({
        existing: { id: 'AST-SEED-0001', organizationId: 'ORG-DEH-0001' },
      });

      await consumer.handle(transfer());

      expect(recorded.events).toEqual([]);
    });

    it('ends it as the system, with a reason, and publishes the release under the old owner', async () => {
      const { consumer, repository, recorded } = buildConsumer({
        existing: { id: 'AST-SEED-0001', organizationId: 'ORG-DEH-0001' },
        open: [open],
      });

      await consumer.handle(transfer());

      expect(repository.endActiveAssignmentsForAsset).toHaveBeenCalledWith(
        expect.anything(),
        'AST-SEED-0001',
        new Date('2026-08-27T10:00:00.000Z'),
        'SYSTEM',
        'ASSET_UNAVAILABLE',
        expect.stringContaining('منتقل شد'),
      );
      expect(recorded.events).toHaveLength(1);
      expect(recorded.events[0]).toMatchObject({
        eventName: 'ASSIGNMENT_ENDED',
        aggregateType: 'Assignment',
        aggregateId: 'ASG-1',
        // The tenant that held the assignment. The new owner must not be
        // told which driver another organization had on the machine.
        organizationId: 'ORG-DEH-0001',
        contextTenant: 'ORG-DEH-0001',
        // Fleet ended it, because of the transfer — not asset-service, whose
        // name the consumer's own context carries.
        callerService: 'fleet-service',
        causationId: 'EVT-TRANSFER-1',
        payload: {
          assignmentId: 'ASG-1',
          assetId: 'AST-SEED-0001',
          driverId: 'DRV-1',
          organizationId: 'ORG-DEH-0001',
          startedAt: '2026-08-27T08:00:00.000Z',
          endedAt: '2026-08-27T10:00:00.000Z',
          reason: 'ASSET_UNAVAILABLE',
        },
      });
    });

    it('updates the replica before it ends anything, in the one transaction', async () => {
      // The replica names the new owner by the time the assignment is ended,
      // so an assignment attempt waiting on the asset's lock is refused.
      const { consumer, repository } = buildConsumer({
        existing: { id: 'AST-SEED-0001', organizationId: 'ORG-DEH-0001' },
        open: [open],
      });

      await consumer.handle(transfer());

      const lock = (repository.lockAssetRef as jest.Mock).mock.invocationCallOrder[0]!;
      const upsert = (repository.upsertAssetRef as jest.Mock).mock.invocationCallOrder[0]!;
      const end = (repository.endActiveAssignmentsForAsset as jest.Mock).mock
        .invocationCallOrder[0]!;
      expect(lock).toBeLessThan(upsert);
      expect(upsert).toBeLessThan(end);
      expect(repository.transaction).toHaveBeenCalledTimes(1);
    });

    it('never dates the end after now, however far ahead the producer clock runs', async () => {
      const { consumer, repository } = buildConsumer({
        existing: { id: 'AST-SEED-0001', organizationId: 'ORG-DEH-0001' },
        open: [open],
      });
      const before = Date.now();

      await consumer.handle(transfer({ occurredAt: '2999-01-01T00:00:00.000Z' }));

      const at = (repository.endActiveAssignmentsForAsset as jest.Mock).mock.calls[0]![2] as Date;
      expect(at.getTime()).toBeGreaterThanOrEqual(before);
      expect(at.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('ends one that started after the transfer at its own start, never before it', async () => {
      // Started in the window before the transfer reached this service.
      const late = { ...open, startedAt: new Date('2026-08-27T10:00:05.000Z') };
      const { consumer, recorded } = buildConsumer({
        existing: { id: 'AST-SEED-0001', organizationId: 'ORG-DEH-0001' },
        open: [late],
      });

      await consumer.handle(transfer());

      expect(recorded.events[0]!.payload).toMatchObject({
        startedAt: '2026-08-27T10:00:05.000Z',
        endedAt: '2026-08-27T10:00:05.000Z',
      });
    });

    it('publishes nothing when no assignment was open', async () => {
      const { consumer, recorded } = buildConsumer({
        existing: { id: 'AST-SEED-0001', organizationId: 'ORG-DEH-0001' },
      });

      await consumer.handle(transfer());

      expect(recorded.upserts).toHaveLength(1);
      expect(recorded.events).toHaveLength(0);
    });

    it('ends nothing again on a redelivery', async () => {
      const { consumer, repository, recorded } = buildConsumer({
        existing: { id: 'AST-SEED-0001', organizationId: 'ORG-DEH-0002' },
        alreadyProcessed: true,
        open: [open],
      });

      await consumer.handle(transfer());

      expect(repository.endActiveAssignmentsForAsset).not.toHaveBeenCalled();
      expect(recorded.events).toHaveLength(0);
    });

    describe('insurance windows after a transfer (#240 round 2, docs/24 Q-66 + Q-101)', () => {
      const window = (policyId: string, generation?: number) => ({
        policyId,
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: '2030-01-01T00:00:00.000Z',
        ...(generation === undefined ? {} : { generation }),
      });
      const movingMachine = {
        id: 'AST-SEED-0001',
        organizationId: 'ORG-DEH-0001',
        insuranceLapsedCoverages: ['THIRD_PARTY'],
        ownershipGeneration: 1,
        retainedCoverages: [],
        insuranceCover: {
          THIRD_PARTY: [window('INS-TP', 1)],
          COMPREHENSIVE: [window('INS-CO', 1)],
        },
      };
      const transferWith = (extra: Record<string, unknown>) =>
        transfer({
          payload: {
            assetId: 'AST-SEED-0001',
            fromOrganizationId: 'ORG-DEH-0001',
            toOrganizationId: 'ORG-DEH-0002',
            transferredAt: '2026-08-27T10:00:00.000Z',
            reason: 'واگذاری',
            ...extra,
          },
        });

      it('keeps the windows of coverages that follow the vehicle and drops the rest', async () => {
        const { consumer, recorded } = buildConsumer({ existing: movingMachine });

        await consumer.handle(
          transferWith({ ownershipGeneration: 2, retainedCoverages: ['THIRD_PARTY'] }),
        );

        const patch = recorded.upserts[0]!;
        expect(patch.organizationId).toBe('ORG-DEH-0002');
        expect(patch.insuranceCover).toEqual({ THIRD_PARTY: [window('INS-TP', 1)] });
        expect(patch.ownershipGeneration).toBe(2);
        expect(patch.retainedCoverages).toEqual(['THIRD_PARTY']);
        // Lapses only ever withhold; they stay.
        expect(patch).not.toHaveProperty('insuranceLapsedCoverages');
      });

      it('keeps a window the new owner recorded under the transfer’s generation', async () => {
        // The topics are separate: the new owner's INSURANCE_RECORDED can be
        // consumed before the transfer that made them the owner.
        const { consumer, recorded } = buildConsumer({
          existing: {
            ...movingMachine,
            insuranceCover: { COMPREHENSIVE: [window('INS-OLD', 1), window('INS-NEW', 2)] },
          },
        });

        await consumer.handle(transferWith({ ownershipGeneration: 2, retainedCoverages: [] }));

        expect(recorded.upserts[0]!.insuranceCover).toEqual({
          COMPREHENSIVE: [window('INS-NEW', 2)],
        });
      });

      it('drops every window when the event carries no retainedCoverages (an older event)', async () => {
        const { consumer, recorded } = buildConsumer({ existing: movingMachine });

        await consumer.handle(transfer());

        const patch = recorded.upserts[0]!;
        expect(patch.insuranceCover).toEqual({});
        expect(patch.retainedCoverages).toEqual([]);
        // No generation stated: the stored one (1) was the departing owner's, so
        // it is cleared to unknown and the owner check applies (#240 r5).
        expect(patch.ownershipGeneration).toBeNull();
      });

      it('refuses a malformed retainedCoverages before the marker', async () => {
        const { consumer, recorded } = buildConsumer({ existing: movingMachine });

        await expect(
          consumer.handle(transferWith({ retainedCoverages: 'THIRD_PARTY' })),
        ).rejects.toThrow();
        expect(recorded.processed).toHaveLength(0);
      });
    });

    describe('an insurance event of the previous owner after a transfer', () => {
      const afterTransferMachine = {
        id: 'AST-SEED-0001',
        organizationId: 'ORG-DEH-0002',
        inspectionBlockedAt: null,
        insuranceLapsedCoverages: [],
        insuranceCover: {},
        ownershipGeneration: 2,
        retainedCoverages: ['THIRD_PARTY'],
      };
      const recordedWith = (coverage: string, generation?: number) =>
        envelope({
          eventName: 'INSURANCE_RECORDED',
          payload: {
            assetId: 'AST-SEED-0001',
            organizationId: 'ORG-DEH-0001',
            policyId: 'INS-LATE',
            insurerName: 'بیمه ایران',
            coverage,
            validFrom: '2026-01-01T00:00:00.000Z',
            validTo: '2030-01-01T00:00:00.000Z',
            ...(generation === undefined ? {} : { ownershipGeneration: generation }),
          },
        });

      it('is ignored when its generation is lower and its coverage does not follow the vehicle', async () => {
        const { consumer, recorded } = buildConsumer({ existing: afterTransferMachine });

        await consumer.handle(recordedWith('COMPREHENSIVE', 1));

        expect(recorded.processed).toHaveLength(1);
        expect(recorded.upserts[0]).not.toHaveProperty('insuranceCover');
      });

      it('is ignored when it carries no generation (an older event)', async () => {
        const { consumer, recorded } = buildConsumer({ existing: afterTransferMachine });

        await consumer.handle(recordedWith('COMPREHENSIVE'));

        expect(recorded.upserts[0]).not.toHaveProperty('insuranceCover');
      });

      it('is applied when its coverage follows the vehicle', async () => {
        const { consumer, recorded } = buildConsumer({ existing: afterTransferMachine });

        await consumer.handle(recordedWith('THIRD_PARTY', 1));

        expect(recorded.upserts[0]!.insuranceCover).toMatchObject({
          THIRD_PARTY: [{ policyId: 'INS-LATE', generation: 1 }],
        });
      });

      it('is applied, with its generation, when it is the new owner’s', async () => {
        const { consumer, recorded } = buildConsumer({ existing: afterTransferMachine });

        await consumer.handle(recordedWith('COMPREHENSIVE', 2));

        expect(recorded.upserts[0]!.insuranceCover).toMatchObject({
          COMPREHENSIVE: [{ policyId: 'INS-LATE', generation: 2 }],
        });
      });

      describe('when the replica does not know the generation (a legacy transfer, or a row the migration initialised)', () => {
        const unknown = {
          ...afterTransferMachine,
          ownershipGeneration: null,
          retainedCoverages: [],
        };
        // The previous owner's tenant, the owner now being ORG-DEH-0002.
        const fromCurrentOwner = (coverage: string, generation?: number) => {
          const event = recordedWith(coverage, generation);
          return {
            ...event,
            tenantId: 'ORG-DEH-0002',
            payload: {
              ...(event.payload as Record<string, unknown>),
              organizationId: 'ORG-DEH-0002',
            },
          };
        };

        it('ignores a delayed event of the previous owner, whatever it carries (fail closed)', async () => {
          const { consumer, recorded } = buildConsumer({ existing: unknown });

          await consumer.handle(recordedWith('COMPREHENSIVE'));
          await consumer.handle({ ...recordedWith('COMPREHENSIVE', 9), eventId: 'EVT-LATE-2' });

          expect(recorded.processed).toHaveLength(2);
          for (const upsert of recorded.upserts)
            expect(upsert).not.toHaveProperty('insuranceCover');
        });

        it('applies the current owner’s event, a re-projected one included, and restores the coverage', async () => {
          const { consumer, recorded } = buildConsumer({ existing: unknown });

          await consumer.handle(fromCurrentOwner('COMPREHENSIVE', 2));

          expect(recorded.upserts[0]!.insuranceCover).toMatchObject({
            COMPREHENSIVE: [{ policyId: 'INS-LATE', generation: 2 }],
          });
        });

        it('applies the current owner’s event that states no generation', async () => {
          const { consumer, recorded } = buildConsumer({ existing: unknown });

          await consumer.handle(fromCurrentOwner('COMPREHENSIVE'));

          expect(recorded.upserts[0]!.insuranceCover).toMatchObject({
            COMPREHENSIVE: [{ policyId: 'INS-LATE' }],
          });
        });

        it('still applies the previous owner’s event for a coverage that follows the vehicle', async () => {
          const { consumer, recorded } = buildConsumer({
            existing: { ...unknown, retainedCoverages: ['THIRD_PARTY'] },
          });

          await consumer.handle(recordedWith('THIRD_PARTY'));

          expect(recorded.upserts[0]!.insuranceCover).toMatchObject({
            THIRD_PARTY: [{ policyId: 'INS-LATE' }],
          });
        });

        it('has no owner to disagree with on the first sighting of a machine', async () => {
          const { consumer, recorded } = buildConsumer({ existing: null });

          await consumer.handle(recordedWith('COMPREHENSIVE'));

          expect(recorded.upserts[0]!.insuranceCover).toMatchObject({
            COMPREHENSIVE: [{ policyId: 'INS-LATE' }],
          });
        });
      });
    });

    it.each(['ASSET_STATUS_CHANGED', 'ASSET_DECOMMISSIONED', 'INSPECTION_FAILED'])(
      'leaves assignments alone on %s',
      async (eventName) => {
        // Only a transfer takes the machine out of the organization. The
        // others refuse *new* assignments, as before; this change does not
        // widen what they do to a running one.
        const { consumer, repository } = buildConsumer({
          existing: { id: 'AST-SEED-0001', organizationId: 'ORG-DEH-0001' },
          open: [open],
        });

        await consumer.handle(
          envelope({
            eventName,
            payload: { assetId: 'AST-SEED-0001', newStatus: 'OUT_OF_SERVICE' },
          }),
        );

        expect(repository.endActiveAssignmentsForAsset).not.toHaveBeenCalled();
      },
    );
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

      expect(recorded.upserts[0]!.inspectionBlockedReason).toBe(
        'The most recent technical inspection failed',
      );
      // Dated by when the inspection failed, not by when fleet consumed it.
      expect(recorded.upserts[0]!.inspectionBlockedAt).toEqual(
        new Date('2026-08-27T10:00:00.000Z'),
      );
    });

    const lapsedMachine = {
      id: 'AST-SEED-0001',
      organizationId: 'ORG-DEH-0001',
      inspectionBlockedAt: null,
      insuranceLapsedCoverages: ['THIRD_PARTY'],
      insuranceLapsedAt: new Date('2026-09-01T00:00:00.000Z'),
      insuranceCover: {},
    };
    const recordedPolicy = (validFrom: string, validTo: string, coverage = 'THIRD_PARTY') =>
      envelope({
        eventName: 'INSURANCE_RECORDED',
        payload: {
          assetId: 'AST-SEED-0001',
          organizationId: 'ORG-DEH-0001',
          policyId: 'INS-2',
          insurerName: 'بیمه ایران',
          coverage,
          validFrom,
          validTo,
        },
      });

    it('records a lapse of the coverage when insurance expires', async () => {
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
            coverage: 'THIRD_PARTY',
            validTo: '2026-08-01T00:00:00.000Z',
          },
        }),
      );

      expect(recorded.upserts[0]!.insuranceLapsedCoverages).toEqual(['THIRD_PARTY']);
      expect(recorded.upserts[0]!.insuranceLapsedAt).toBeInstanceOf(Date);
    });

    it('records UNKNOWN when the lapse names no coverage, adding to earlier lapses', async () => {
      // A later block never overwrites an earlier one.
      const { consumer, recorded } = buildConsumer({ existing: lapsedMachine });

      await consumer.handle(
        envelope({
          eventName: 'INSURANCE_EXPIRED',
          payload: { assetId: 'AST-SEED-0001', organizationId: 'ORG-DEH-0001', policyId: 'INS-1' },
        }),
      );

      expect(recorded.upserts[0]!.insuranceLapsedCoverages).toEqual(['THIRD_PARTY', 'UNKNOWN']);
      expect(recorded.upserts[0]!.insuranceLapsedAt).toEqual(lapsedMachine.insuranceLapsedAt);
    });

    it('keeps the date of the newer failure when an older one arrives late', async () => {
      const first = new Date('2026-09-01T00:00:00.000Z');
      const { consumer, recorded } = buildConsumer({
        existing: { ...lapsedMachine, inspectionBlockedAt: first },
      });

      await consumer.handle(
        envelope({
          eventName: 'INSPECTION_FAILED',
          payload: {
            assetId: 'AST-SEED-0001',
            organizationId: 'ORG-DEH-0001',
            inspectionId: 'INP-2',
          },
        }),
      );

      expect(recorded.upserts[0]!.inspectionBlockedAt).toEqual(first);
      expect(recorded.upserts[0]).not.toHaveProperty('insuranceLapsedCoverages');
    });

    it('clears only the inspection block and the maintenance flag when a repair completes (L3-02)', async () => {
      // The bug: MAINTENANCE_COMPLETED used to clear a shared
      // `dispatchBlockedReason` regardless of which cause set it, so a
      // repair for an unrelated fault re-armed a machine whose insurance had
      // lapsed. The causes must now end independently.
      const { consumer, recorded } = buildConsumer({
        existing: {
          ...lapsedMachine,
          inMaintenance: true,
          inspectionBlockedReason: 'The most recent technical inspection failed',
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
        inspectionBlockedReason: null,
        inspectionBlockedAt: null,
      });
      // The insurance cause is untouched — not present in the patch at all.
      expect(recorded.upserts[0]).not.toHaveProperty('insuranceLapsedCoverages');
      expect(recorded.upserts[0]).not.toHaveProperty('insuranceCover');
    });

    describe('inspection failure and repair, in either order (review #2)', () => {
      const failure = (occurredAt: string) =>
        envelope({
          eventName: 'INSPECTION_FAILED',
          occurredAt,
          payload: { assetId: 'AST-SEED-0001', organizationId: 'ORG-DEH-0001' },
        });
      const completion = (occurredAt: string) =>
        envelope({
          eventName: 'MAINTENANCE_COMPLETED',
          producer: 'maintenance-service',
          occurredAt,
          payload: { assetId: 'AST-SEED-0001', organizationId: 'ORG-DEH-0001' },
        });
      const machine = { id: 'AST-SEED-0001', organizationId: 'ORG-DEH-0001' };

      it('moves the block to a newer failure', async () => {
        const { consumer, recorded } = buildConsumer({
          existing: { ...machine, inspectionBlockedAt: new Date('2026-09-01T10:00:00.000Z') },
        });
        await consumer.handle(failure('2026-09-05T10:00:00.000Z'));

        expect(recorded.upserts[0]!.inspectionBlockedAt).toEqual(
          new Date('2026-09-05T10:00:00.000Z'),
        );
      });

      it('does not let a repair completed before a failure clear that failure', async () => {
        // Repair at 10:00, inspection failed at 11:00, the failure consumed
        // first. The late completion must leave the newer failure in force.
        const { consumer, recorded } = buildConsumer({
          existing: {
            ...machine,
            inMaintenance: true,
            inspectionBlockedReason: 'The most recent technical inspection failed',
            inspectionBlockedAt: new Date('2026-09-01T11:00:00.000Z'),
          },
        });
        await consumer.handle(completion('2026-09-01T10:00:00.000Z'));

        expect(recorded.upserts[0]).toMatchObject({
          inMaintenance: false,
          inspectionResolvedAt: new Date('2026-09-01T10:00:00.000Z'),
        });
        expect(recorded.upserts[0]).not.toHaveProperty('inspectionBlockedReason');
        expect(recorded.upserts[0]).not.toHaveProperty('inspectionBlockedAt');
      });

      it('clears a failure older than the completed repair', async () => {
        const { consumer, recorded } = buildConsumer({
          existing: {
            ...machine,
            inspectionBlockedReason: 'The most recent technical inspection failed',
            inspectionBlockedAt: new Date('2026-09-01T09:00:00.000Z'),
          },
        });
        await consumer.handle(completion('2026-09-01T10:00:00.000Z'));

        expect(recorded.upserts[0]).toMatchObject({
          inspectionBlockedReason: null,
          inspectionBlockedAt: null,
        });
      });

      it('does not block on a failure a repair already answered, when the repair was consumed first', async () => {
        const { consumer, recorded } = buildConsumer({
          existing: { ...machine, inspectionResolvedAt: new Date('2026-09-01T10:00:00.000Z') },
        });
        await consumer.handle(failure('2026-09-01T09:00:00.000Z'));

        expect(recorded.upserts[0]).not.toHaveProperty('inspectionBlockedReason');
      });

      it('blocks on a failure after the last repair', async () => {
        const { consumer, recorded } = buildConsumer({
          existing: { ...machine, inspectionResolvedAt: new Date('2026-09-01T10:00:00.000Z') },
        });
        await consumer.handle(failure('2026-09-01T11:00:00.000Z'));

        expect(recorded.upserts[0]!.inspectionBlockedReason).toBe(
          'The most recent technical inspection failed',
        );
      });
    });

    it('ends the lapse when a policy of the same coverage in force is recorded (L3-02)', async () => {
      const { consumer, recorded } = buildConsumer({
        existing: {
          ...lapsedMachine,
          inspectionBlockedReason: 'The most recent technical inspection failed',
        },
      });

      await consumer.handle(recordedPolicy('2020-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'));

      expect(recorded.upserts[0]).toMatchObject({
        insuranceLapsedCoverages: [],
        insuranceLapsedAt: null,
        insuranceCover: {
          THIRD_PARTY: [
            {
              policyId: 'INS-2',
              validFrom: '2020-01-01T00:00:00.000Z',
              validTo: '2099-01-01T00:00:00.000Z',
            },
          ],
        },
      });
      // A renewed policy says nothing about whether the machine has since
      // passed inspection.
      expect(recorded.upserts[0]).not.toHaveProperty('inspectionBlockedReason');
    });

    it('stores a future-dated renewal but keeps the lapse until it starts', async () => {
      const { consumer, recorded } = buildConsumer({ existing: lapsedMachine });

      await consumer.handle(recordedPolicy('2099-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z'));

      expect(recorded.upserts[0]!.insuranceLapsedCoverages).toEqual(['THIRD_PARTY']);
      expect(recorded.upserts[0]!.insuranceLapsedAt).toEqual(lapsedMachine.insuranceLapsedAt);
      expect(recorded.upserts[0]!.insuranceCover).toHaveProperty('THIRD_PARTY');
    });

    it('does not end a lapse with a policy of another coverage', async () => {
      const { consumer, recorded } = buildConsumer({ existing: lapsedMachine });

      await consumer.handle(
        recordedPolicy(
          '2020-01-01T00:00:00.000Z',
          '2099-01-01T00:00:00.000Z',
          'PASSENGER_ACCIDENT',
        ),
      );

      expect(recorded.upserts[0]!.insuranceLapsedCoverages).toEqual(['THIRD_PARTY']);
    });

    it('dead-letters a recorded policy without its dates, leaving the lapse in force (L7-26)', async () => {
      // The one event that ends a lapse, without what it would end it with.
      // Refused before the marker, so nothing is written and the lapse the
      // row already holds stays in force: the machine stays off dispatch.
      const { consumer, recorded, repository } = buildConsumer({ existing: lapsedMachine });

      await expect(
        consumer.handle(
          envelope({
            eventName: 'INSURANCE_RECORDED',
            payload: {
              assetId: 'AST-SEED-0001',
              organizationId: 'ORG-DEH-0001',
              policyId: 'INS-2',
              coverage: 'THIRD_PARTY',
              insurerName: 'SENTINEL-insurer-0099',
            },
          }),
        ),
      ).rejects.toMatchObject({
        name: 'UnprocessableEventError',
        reason: 'VALIDATION_FAILED',
        message:
          'INSURANCE_RECORDED 01JBQ8Z4K7M2N5P8R1T3V6X9Y2 payload fails its schema: ' +
          'validFrom invalid_type; validTo invalid_type',
      });
      expect(repository.markEventProcessed).not.toHaveBeenCalled();
      expect(repository.lockAssetRef).not.toHaveBeenCalled();
      expect(recorded.upserts).toHaveLength(0);
    });

    it.each([
      ['coverage', 'too_small'],
      ['policyId', 'too_small'],
      ['validFrom', 'invalid_string; validTo custom'],
      ['validTo', 'invalid_string; validTo custom'],
    ])('dead-letters a recorded policy whose %s is empty', async (field, code) => {
      const { consumer, recorded, repository } = buildConsumer({ existing: lapsedMachine });
      const policy = recordedPolicy('2020-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z');

      await expect(
        consumer.handle({
          ...policy,
          payload: { ...(policy.payload as Record<string, unknown>), [field]: '' },
        }),
      ).rejects.toMatchObject({
        reason: 'VALIDATION_FAILED',
        message: expect.stringMatching(new RegExp(`payload fails its schema: ${field} ${code}$`)),
      });
      expect(repository.markEventProcessed).not.toHaveBeenCalled();
      expect(recorded.upserts).toHaveLength(0);
    });

    it.each([
      [
        'dates that do not parse',
        'SENTINEL-next-spring',
        'not-a-date',
        'validFrom invalid_string; validTo invalid_string; validTo custom',
      ],
      [
        'a date in a thirteenth month',
        '2026-01-01T00:00:00.000Z',
        '2026-13-45T00:00:00.000Z',
        'validTo invalid_string; validTo custom',
      ],
      [
        'a window that ends before it starts',
        '2027-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        'validTo custom',
      ],
      [
        'a window that ends as it starts',
        '2027-01-01T00:00:00.000Z',
        '2027-01-01T00:00:00.000Z',
        'validTo custom',
      ],
    ])(
      'dead-letters a recorded policy with %s, leaving the lapse in force (review #205 r1)',
      async (_label, validFrom, validTo, issues) => {
        // Non-empty but unusable: dispatch-blocks would treat the window as
        // never in force, yet with the marker committed no corrected replay
        // could restore the cover. Held to the producer's own rule instead.
        const { consumer, recorded, repository } = buildConsumer({ existing: lapsedMachine });

        const refusal = consumer.handle(recordedPolicy(validFrom, validTo));

        await expect(refusal).rejects.toMatchObject({
          reason: 'VALIDATION_FAILED',
          message: `INSURANCE_RECORDED 01JBQ8Z4K7M2N5P8R1T3V6X9Y2 payload fails its schema: ${issues}`,
        });
        await expect(refusal).rejects.not.toHaveProperty(
          'message',
          expect.stringContaining('SENTINEL'),
        );
        expect(repository.markEventProcessed).not.toHaveBeenCalled();
        expect(repository.lockAssetRef).not.toHaveBeenCalled();
        expect(recorded.upserts).toHaveLength(0);
      },
    );

    it('applies the corrected policy after an inverted window was refused, once (review #205 r1)', async () => {
      const { consumer, recorded, repository } = buildConsumer({ existing: lapsedMachine });
      const marked = new Set<string>();
      (repository.markEventProcessed as jest.Mock).mockImplementation(
        async (_tx: unknown, eventId: string) => {
          if (marked.has(eventId)) return false;
          marked.add(eventId);
          return true;
        },
      );
      const replay = { topic: 'rasta.insurance.v1.retry', partition: 0 };

      await expect(
        consumer.handle(recordedPolicy('2099-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')),
      ).rejects.toMatchObject({ reason: 'VALIDATION_FAILED' });
      const corrected = recordedPolicy('2020-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
      await consumer.handle(corrected, replay);
      await consumer.handle(corrected, replay);

      expect(recorded.upserts).toHaveLength(1);
      expect(recorded.upserts[0]).toMatchObject({
        insuranceLapsedCoverages: [],
        insuranceCover: { THIRD_PARTY: [{ policyId: 'INS-2' }] },
      });
    });

    it('applies the corrected policy replayed from the DLQ with the same id, once (L7-26)', async () => {
      const { consumer, recorded, repository } = buildConsumer({ existing: lapsedMachine });
      const marked = new Set<string>();
      (repository.markEventProcessed as jest.Mock).mockImplementation(
        async (_tx: unknown, eventId: string) => {
          if (marked.has(eventId)) return false;
          marked.add(eventId);
          return true;
        },
      );
      const corrected = recordedPolicy('2020-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
      const {
        validFrom: _from,
        validTo: _to,
        ...undated
      } = corrected.payload as Record<string, unknown>;
      const replay = { topic: 'rasta.asset.v1.retry', partition: 0 };

      await expect(consumer.handle({ ...corrected, payload: undated })).rejects.toMatchObject({
        reason: 'VALIDATION_FAILED',
      });
      expect(marked.size).toBe(0);
      await consumer.handle(corrected, replay);
      await consumer.handle(corrected, replay);

      // Same event id: applied once, and the lapse it answers is lifted.
      expect(recorded.upserts).toHaveLength(1);
      expect(recorded.upserts[0]).toMatchObject({
        id: 'AST-SEED-0001',
        insuranceLapsedCoverages: [],
        insuranceLapsedAt: null,
        insuranceCover: {
          THIRD_PARTY: [
            {
              policyId: 'INS-2',
              validFrom: '2020-01-01T00:00:00.000Z',
              validTo: '2099-01-01T00:00:00.000Z',
            },
          ],
        },
      });
    });

    it('locks the replica row before reading it for a projection', async () => {
      const { consumer, repository } = buildConsumer({ existing: lapsedMachine });
      await consumer.handle(recordedPolicy('2020-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'));

      const lockOrder = (repository.lockAssetRef as jest.Mock).mock.invocationCallOrder[0]!;
      const reads = (repository.findAssetRefUnscoped as jest.Mock).mock.invocationCallOrder;
      expect(repository.lockAssetRef).toHaveBeenCalledWith(expect.anything(), 'AST-SEED-0001');
      // The read the projection builds on comes after the lock.
      expect(reads[reads.length - 1]!).toBeGreaterThan(lockOrder);
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

  describe("the previous owner's insurance events after a transfer (docs/24 Q-66)", () => {
    // The policy follows the vehicle (project owner's decision, 2026-09-25).
    // Insurance and asset events travel on different topics, so the inherited
    // policy's event can be consumed after the transfer, under the previous
    // owner's tenant. It applies to the machine, which now has a new owner.
    // THIRD_PARTY is the coverage the transfer let follow the vehicle: with the
    // generation unknown, only a retained coverage of the previous owner applies.
    const afterTransfer = {
      id: 'AST-SEED-0001',
      organizationId: 'ORG-DEH-0002',
      ownershipGeneration: null,
      retainedCoverages: ['THIRD_PARTY'],
    };
    const fromPreviousOwner = (eventName: string, fields: Record<string, unknown>) =>
      envelope({
        eventName,
        tenantId: 'ORG-DEH-0001',
        payload: { assetId: 'AST-SEED-0001', organizationId: 'ORG-DEH-0001', ...fields },
      });

    it('records the inherited policy lapsing, under the new owner', async () => {
      const { consumer, recorded } = buildConsumer({ existing: afterTransfer });

      await consumer.handle(fromPreviousOwner('INSURANCE_EXPIRED', { coverage: 'THIRD_PARTY' }));

      expect(recorded.upserts[0]).toMatchObject({
        // The row stays with the owner it has now, never moved back.
        organizationId: 'ORG-DEH-0002',
        insuranceLapsedCoverages: ['THIRD_PARTY'],
      });
    });

    it('records the inherited policy, under the new owner', async () => {
      const { consumer, recorded } = buildConsumer({ existing: afterTransfer });

      await consumer.handle(
        fromPreviousOwner('INSURANCE_RECORDED', {
          coverage: 'THIRD_PARTY',
          policyId: 'INS-A',
          validFrom: '2026-01-01T00:00:00.000Z',
          validTo: '2999-01-01T00:00:00.000Z',
        }),
      );

      expect(recorded.upserts[0]).toMatchObject({
        organizationId: 'ORG-DEH-0002',
        insuranceCover: {
          THIRD_PARTY: [
            {
              policyId: 'INS-A',
              validFrom: '2026-01-01T00:00:00.000Z',
              validTo: '2999-01-01T00:00:00.000Z',
            },
          ],
        },
      });
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
    it('dead-letters, rather than skips, a safety event that names no machine (L7-26)', async () => {
      // An inspection failure acknowledged here would leave the machine
      // dispatchable with no trace. Refused at once as VALIDATION_FAILED, before
      // the marker; the message names the field and the code, never a value.
      const { consumer, recorded, repository } = buildConsumer({});
      const SENTINEL = 'SENTINEL-free-text-0012345678';

      await expect(
        consumer.handle(
          envelope({
            eventName: 'INSPECTION_FAILED',
            payload: { organizationId: 'ORG-DEH-0001', notes: SENTINEL },
          }),
        ),
      ).rejects.toMatchObject({
        name: 'UnprocessableEventError',
        reason: 'VALIDATION_FAILED',
        message:
          'INSPECTION_FAILED 01JBQ8Z4K7M2N5P8R1T3V6X9Y2 payload fails its schema: assetId invalid_type',
      });
      expect(repository.markEventProcessed).not.toHaveBeenCalled();
      expect(recorded.upserts).toHaveLength(0);
    });

    it('applies the corrected safety event replayed from the DLQ, once (L7-26)', async () => {
      const { consumer, recorded, repository } = buildConsumer({});
      const marked = new Set<string>();
      (repository.markEventProcessed as jest.Mock).mockImplementation(
        async (_tx: unknown, eventId: string) => {
          if (marked.has(eventId)) return false;
          marked.add(eventId);
          return true;
        },
      );
      const failed = (payload: Record<string, unknown>) =>
        envelope({ eventName: 'INSPECTION_FAILED', payload });
      const replay = { topic: 'rasta.asset.v1.retry', partition: 0 };

      await expect(
        consumer.handle(failed({ organizationId: 'ORG-DEH-0001' })),
      ).rejects.toMatchObject({ reason: 'VALIDATION_FAILED' });
      const corrected = failed({ assetId: 'AST-SEED-0001', organizationId: 'ORG-DEH-0001' });
      await consumer.handle(corrected, replay);
      await consumer.handle(corrected, replay);

      expect(recorded.upserts).toHaveLength(1);
      expect(recorded.upserts[0]).toMatchObject({
        id: 'AST-SEED-0001',
        inspectionBlockedAt: new Date('2026-08-27T10:00:00.000Z'),
      });
    });

    it('still skips an event it does not consume, however malformed (forward compatibility)', async () => {
      const { consumer, repository } = buildConsumer({});
      const outcome = await consumer.handle(
        envelope({ eventName: 'ASSET_LOCATION_UPDATED', payload: {} }),
      );

      expect(outcome).toBe('SKIPPED');
      expect(repository.markEventProcessed).not.toHaveBeenCalled();
    });

    it('dead-letters, rather than skips, a first sighting with no tenant (L7-26)', async () => {
      // Guessing would invent the very fact the replica exists to carry, and
      // would place a machine in an organization that does not own it. A
      // silent skip would lose the event: refused at once, before the marker.
      const { consumer, recorded, repository } = buildConsumer({});
      const marked = new Set<string>();
      (repository.markEventProcessed as jest.Mock).mockImplementation(
        async (_tx: unknown, eventId: string) => {
          if (marked.has(eventId)) return false;
          marked.add(eventId);
          return true;
        },
      );
      const failed = (tenantId: string | undefined) =>
        envelope({
          eventName: 'INSPECTION_FAILED',
          tenantId,
          payload: { assetId: 'AST-UNKNOWN', inspectionId: 'INP-9' },
        });

      await expect(consumer.handle(failed(undefined))).rejects.toMatchObject({
        name: 'UnprocessableEventError',
        reason: 'VALIDATION_FAILED',
        message: 'INSPECTION_FAILED 01JBQ8Z4K7M2N5P8R1T3V6X9Y2 carries no tenant',
      });
      expect(marked.size).toBe(0);
      expect(recorded.upserts).toHaveLength(0);

      // The corrected event, replayed with the same id, is applied once.
      await consumer.handle(failed('ORG-DEH-0001'));
      await consumer.handle(failed('ORG-DEH-0001'));
      expect(recorded.upserts).toHaveLength(1);
      expect(recorded.upserts[0]).toMatchObject({
        id: 'AST-UNKNOWN',
        organizationId: 'ORG-DEH-0001',
        inspectionBlockedAt: new Date('2026-08-27T10:00:00.000Z'),
      });
    });

    it('still skips an event it does not project, with no tenant (forward compatibility)', async () => {
      const { consumer, repository } = buildConsumer({});
      const outcome = await consumer.handle(
        envelope({ eventName: 'ASSET_LOCATION_UPDATED', tenantId: undefined, payload: {} }),
      );

      expect(outcome).toBe('SKIPPED');
      expect(repository.markEventProcessed).not.toHaveBeenCalled();
    });

    it('takes the envelope tenant when the payload omits its organization', async () => {
      const { consumer, recorded } = buildConsumer({});
      await consumer.handle(
        envelope({
          eventName: 'ASSET_CREATED',
          tenantId: 'ORG-DEH-0002',
          payload: {
            assetId: 'AST-SEED-0010',
            name: 'کامیون',
            type: 'TRUCK',
            assetTag: null,
            status: 'REGISTERED',
          },
        }),
      );

      expect(recorded.upserts[0]!.organizationId).toBe('ORG-DEH-0002');
    });
  });

  describe('the tenant comes from the envelope only (review #205 r1)', () => {
    /** A ledger that marks an id once, so a refused event leaves no marker. */
    function withLedger(repository: FleetRepository): Set<string> {
      const marked = new Set<string>();
      (repository.markEventProcessed as jest.Mock).mockImplementation(
        async (_tx: unknown, eventId: string) => {
          if (marked.has(eventId)) return false;
          marked.add(eventId);
          return true;
        },
      );
      return marked;
    }

    const inspectionFailed = (tenantId: string | undefined, organizationId?: string) =>
      envelope({
        eventName: 'INSPECTION_FAILED',
        tenantId,
        payload: {
          assetId: 'AST-SEED-0001',
          inspectionId: 'INP-7',
          ...(organizationId ? { organizationId } : {}),
        },
      });

    it.each([
      ['no payload organization, no replica row', undefined, null],
      ['a payload organization, no replica row', 'ORG-DEH-0001', null],
      [
        'no payload organization, a replica row',
        undefined,
        { id: 'AST-SEED-0001', organizationId: 'ORG-DEH-0001' },
      ],
      [
        'a payload organization, a replica row',
        'ORG-DEH-0001',
        { id: 'AST-SEED-0001', organizationId: 'ORG-DEH-0001' },
      ],
    ])(
      'dead-letters an event with no envelope tenant (%s): nothing written, no marker',
      async (_label, organizationId, existing) => {
        // Taken from the payload (or the row) and marked processed, a wrong
        // tenant could never be corrected by a replay.
        const { consumer, recorded, repository } = buildConsumer({ existing });
        const marked = withLedger(repository);

        await expect(
          consumer.handle(inspectionFailed(undefined, organizationId)),
        ).rejects.toMatchObject({
          name: 'UnprocessableEventError',
          reason: 'VALIDATION_FAILED',
          message: 'INSPECTION_FAILED 01JBQ8Z4K7M2N5P8R1T3V6X9Y2 carries no tenant',
        });
        expect(marked.size).toBe(0);
        expect(repository.lockAssetRef).not.toHaveBeenCalled();
        expect(recorded.upserts).toHaveLength(0);

        // The corrected event, replayed with the same id, is applied once.
        await consumer.handle(inspectionFailed('ORG-DEH-0001', organizationId));
        await consumer.handle(inspectionFailed('ORG-DEH-0001', organizationId));
        expect(recorded.upserts).toHaveLength(1);
        expect(recorded.upserts[0]).toMatchObject({
          id: 'AST-SEED-0001',
          organizationId: 'ORG-DEH-0001',
          inspectionBlockedReason: 'The most recent technical inspection failed',
        });
      },
    );

    it.each([
      ['no replica row', null],
      ['a replica row', { id: 'AST-SEED-0001', organizationId: 'ORG-DEH-0001' }],
    ])(
      'dead-letters a payload organization other than the envelope tenant (%s), naming neither',
      async (_label, existing) => {
        const { consumer, recorded, repository } = buildConsumer({ existing });
        const marked = withLedger(repository);

        const refusal = consumer.handle(inspectionFailed('ORG-DEH-0001', 'ORG-DEH-SENTINEL'));

        await expect(refusal).rejects.toMatchObject({
          reason: 'VALIDATION_FAILED',
          message:
            'INSPECTION_FAILED 01JBQ8Z4K7M2N5P8R1T3V6X9Y2 payload organization differs ' +
            'from its envelope tenant: tenant_mismatch',
        });
        expect(marked.size).toBe(0);
        expect(recorded.upserts).toHaveLength(0);

        await consumer.handle(inspectionFailed('ORG-DEH-0001', 'ORG-DEH-0001'));
        await consumer.handle(inspectionFailed('ORG-DEH-0001', 'ORG-DEH-0001'));
        expect(recorded.upserts).toHaveLength(1);
        expect(recorded.upserts[0]!.organizationId).toBe('ORG-DEH-0001');
      },
    );
  });

  describe("each event is held to the producer contract's fields its projection uses (review #205 r1)", () => {
    it('dead-letters ASSET_STATUS_CHANGED without newStatus, keeping the machine out of dispatch', async () => {
      // Accepted, the replica would keep its old status and be marked
      // processed: a machine taken OUT_OF_SERVICE could stay dispatchable.
      const { consumer, recorded, repository } = buildConsumer({
        existing: { id: 'AST-SEED-0001', organizationId: 'ORG-DEH-0001', status: 'ACTIVE' },
      });
      const marked = new Set<string>();
      (repository.markEventProcessed as jest.Mock).mockImplementation(
        async (_tx: unknown, eventId: string) => {
          if (marked.has(eventId)) return false;
          marked.add(eventId);
          return true;
        },
      );
      const changed = (fields: Record<string, unknown>) =>
        envelope({
          eventName: 'ASSET_STATUS_CHANGED',
          payload: {
            assetId: 'AST-SEED-0001',
            organizationId: 'ORG-DEH-0001',
            previousStatus: 'ACTIVE',
            reason: 'SENTINEL-free-text',
            ...fields,
          },
        });

      await expect(consumer.handle(changed({}))).rejects.toMatchObject({
        reason: 'VALIDATION_FAILED',
        message:
          'ASSET_STATUS_CHANGED 01JBQ8Z4K7M2N5P8R1T3V6X9Y2 payload fails its schema: newStatus invalid_type',
      });
      await expect(consumer.handle(changed({ newStatus: '' }))).rejects.toMatchObject({
        message: expect.stringMatching(/newStatus too_small$/),
      });
      expect(marked.size).toBe(0);
      expect(recorded.upserts).toHaveLength(0);

      await consumer.handle(changed({ newStatus: 'OUT_OF_SERVICE' }));
      await consumer.handle(changed({ newStatus: 'OUT_OF_SERVICE' }));
      expect(recorded.upserts).toHaveLength(1);
      expect(recorded.upserts[0]!.status).toBe('OUT_OF_SERVICE');
    });

    it.each([
      ['status', { status: undefined }, 'status invalid_type'],
      ['an empty status', { status: '' }, 'status too_small'],
      ['name', { name: undefined }, 'name invalid_type'],
      ['type', { type: undefined }, 'type invalid_type'],
      ['assetTag (nullable, not optional)', { assetTag: undefined }, 'assetTag invalid_type'],
    ])('dead-letters ASSET_CREATED without %s', async (_label, override, issues) => {
      const { consumer, recorded, repository } = buildConsumer({});

      await expect(
        consumer.handle(
          envelope({
            eventName: 'ASSET_CREATED',
            payload: {
              assetId: 'AST-SEED-0011',
              organizationId: 'ORG-DEH-0001',
              name: 'لودر',
              type: 'LOADER',
              assetTag: null,
              serialNumber: null,
              status: 'REGISTERED',
              ...override,
            },
          }),
        ),
      ).rejects.toMatchObject({
        reason: 'VALIDATION_FAILED',
        message: `ASSET_CREATED 01JBQ8Z4K7M2N5P8R1T3V6X9Y2 payload fails its schema: ${issues}`,
      });
      expect(repository.markEventProcessed).not.toHaveBeenCalled();
      expect(recorded.upserts).toHaveLength(0);
    });

    it('holds every consumed event to a contract, and the safety withdrawals to the machine alone', () => {
      expect(Object.keys(CONSUMED_PAYLOADS).sort()).toEqual(Object.values(CONSUMED_EVENTS).sort());
      // Refusing a lapse or a failed inspection would leave the machine
      // dispatchable until the replay: they need only the machine.
      expect(CONSUMED_PAYLOADS.INSPECTION_FAILED.fields).toEqual(['assetId', 'organizationId']);
      expect(CONSUMED_PAYLOADS.INSURANCE_EXPIRED.fields).toEqual(['assetId', 'organizationId']);
    });
  });

  describe("an ordinary state event must come from the replica's owner (review #205 r2)", () => {
    const A = 'ORG-DEH-0001';
    const B = 'ORG-DEH-0002';
    const ownedByA = {
      id: 'AST-SEED-0001',
      organizationId: A,
      status: 'ACTIVE',
      inspectionBlockedAt: null,
      insuranceLapsedCoverages: ['THIRD_PARTY'],
      insuranceLapsedAt: new Date('2026-09-01T00:00:00.000Z'),
      insuranceCover: {},
    };

    /**
     * A ledger that behaves like the real transaction: a marker written in a
     * transaction that throws is rolled back with it.
     */
    function transactionalLedger(repository: FleetRepository): Set<string> {
      const marked = new Set<string>();
      let pending: string[] = [];
      (repository.markEventProcessed as jest.Mock).mockImplementation(
        async (_tx: unknown, eventId: string) => {
          if (marked.has(eventId)) return false;
          marked.add(eventId);
          pending.push(eventId);
          return true;
        },
      );
      (repository.transaction as jest.Mock).mockImplementation(
        async (fn: (tx: unknown) => Promise<unknown>) => {
          pending = [];
          try {
            return await fn({});
          } catch (error) {
            for (const eventId of pending) marked.delete(eventId);
            throw error;
          }
        },
      );
      return marked;
    }

    const statusChanged = (tenant: string) =>
      envelope({
        eventId: 'EVT-OWNER-1',
        eventName: 'ASSET_STATUS_CHANGED',
        tenantId: tenant,
        payload: {
          assetId: 'AST-SEED-0001',
          organizationId: tenant,
          previousStatus: 'ACTIVE',
          newStatus: 'OUT_OF_SERVICE',
          reason: 'آزمون',
        },
      });

    it("dead-letters B's status change for A's machine: A's row unchanged, no marker; A's corrected event applies once", async () => {
      const { consumer, recorded, repository } = buildConsumer({ existing: ownedByA });
      const marked = transactionalLedger(repository);

      await expect(consumer.handle(statusChanged(B))).rejects.toMatchObject({
        name: 'UnprocessableEventError',
        reason: 'VALIDATION_FAILED',
        message:
          'ASSET_STATUS_CHANGED EVT-OWNER-1 names a tenant that does not own the asset: owner_mismatch',
      });
      expect(recorded.upserts).toHaveLength(0);
      expect(marked.size).toBe(0);

      await consumer.handle(statusChanged(A));
      await consumer.handle(statusChanged(A));
      expect(recorded.upserts).toHaveLength(1);
      expect(recorded.upserts[0]).toMatchObject({
        id: 'AST-SEED-0001',
        organizationId: A,
        status: 'OUT_OF_SERVICE',
      });
    });

    it.each([
      ['ASSET_UPDATED', { changedFields: ['name'] }],
      ['ASSET_ACTIVATED', { commissionedAt: '2026-09-01T00:00:00.000Z' }],
      ['ASSET_DECOMMISSIONED', { reason: 'x', decommissionedAt: '2026-09-01T00:00:00.000Z' }],
      ['MAINTENANCE_STARTED', { requestId: 'MNT-1' }],
      ['MAINTENANCE_COMPLETED', { requestId: 'MNT-1' }],
    ])("dead-letters B's %s for A's machine, writing nothing", async (eventName, fields) => {
      const { consumer, recorded, repository } = buildConsumer({ existing: ownedByA });
      const marked = transactionalLedger(repository);

      await expect(
        consumer.handle(
          envelope({
            eventName,
            tenantId: B,
            payload: { assetId: 'AST-SEED-0001', organizationId: B, ...fields },
          }),
        ),
      ).rejects.toMatchObject({
        reason: 'VALIDATION_FAILED',
        message: expect.stringMatching(/owner_mismatch$/),
      });
      expect(recorded.upserts).toHaveLength(0);
      expect(marked.size).toBe(0);
    });

    it('still applies the previous owner’s insurance events to the vehicle after a transfer (docs/24 Q-66)', async () => {
      // The machine now belongs to B; A's policy follows the vehicle.
      const { consumer, recorded, repository } = buildConsumer({
        existing: {
          ...ownedByA,
          organizationId: B,
          ownershipGeneration: null,
          retainedCoverages: ['THIRD_PARTY'],
        },
      });
      transactionalLedger(repository);

      await consumer.handle(
        envelope({
          eventId: 'EVT-Q66-1',
          eventName: 'INSURANCE_RECORDED',
          tenantId: A,
          payload: {
            assetId: 'AST-SEED-0001',
            organizationId: A,
            policyId: 'INS-A',
            insurerName: 'بیمه',
            coverage: 'THIRD_PARTY',
            validFrom: '2026-01-01T00:00:00.000Z',
            validTo: '2999-01-01T00:00:00.000Z',
          },
        }),
      );
      await consumer.handle(
        envelope({
          eventId: 'EVT-Q66-2',
          eventName: 'INSURANCE_EXPIRED',
          tenantId: A,
          payload: { assetId: 'AST-SEED-0001', organizationId: A, coverage: 'COLLISION' },
        }),
      );

      expect(recorded.upserts).toHaveLength(2);
      expect(recorded.upserts.map((row) => row.organizationId)).toEqual([B, B]);
      expect(recorded.upserts[1]!.insuranceLapsedCoverages).toEqual(['THIRD_PARTY', 'COLLISION']);
    });

    it('still withdraws the machine on a failed inspection whatever tenant reports it', async () => {
      // A withdrawal only ever takes the machine off dispatch; refusing it
      // would leave the machine dispatchable until the replay.
      const { consumer, recorded, repository } = buildConsumer({ existing: ownedByA });
      transactionalLedger(repository);

      await consumer.handle(
        envelope({
          eventName: 'INSPECTION_FAILED',
          tenantId: B,
          payload: { assetId: 'AST-SEED-0001', organizationId: B, inspectionId: 'INP-1' },
        }),
      );

      expect(recorded.upserts[0]).toMatchObject({
        organizationId: A,
        inspectionBlockedReason: 'The most recent technical inspection failed',
      });
    });

    it("still moves A's machine to B on ASSET_TRANSFERRED", async () => {
      const { consumer, recorded, repository } = buildConsumer({ existing: ownedByA });
      const marked = transactionalLedger(repository);

      await consumer.handle(
        envelope({
          eventId: 'EVT-TRANSFER-9',
          eventName: 'ASSET_TRANSFERRED',
          tenantId: B,
          payload: {
            assetId: 'AST-SEED-0001',
            fromOrganizationId: A,
            toOrganizationId: B,
            transferredAt: '2026-09-27T10:00:00.000Z',
            reason: 'x',
          },
        }),
      );

      expect(marked.has('EVT-TRANSFER-9')).toBe(true);
      expect(recorded.upserts[0]).toMatchObject({ organizationId: B, status: 'REGISTERED' });
    });
  });
});
