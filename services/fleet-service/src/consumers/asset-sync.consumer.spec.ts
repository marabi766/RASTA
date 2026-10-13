import type { EventEnvelope } from '@rasta/contracts';
import { RastaError, tryGetContext, type OutboxMessageInput } from '@rasta/nest-common';
import { dlqMessagesTotal } from '@rasta/observability';
import {
  AssetSyncConsumer,
  CONSUMER_NAME,
  DEFAULT_PARKING,
  type ParkingOptions,
} from './asset-sync.consumer';
import type {
  DeadLetterOutboxInput,
  FleetRepository,
  ParkedInsuranceInput,
} from '../fleet/fleet.repository';
import { CONSUMED_EVENTS, CONSUMED_PAYLOADS } from '../fleet/events';
import { FakePolicySource, echoing } from '../../test/policy-source.fake';
import type { InsurancePolicySource } from './replica-sources';
import { activeDispatchBlocks } from '../fleet/dispatch-blocks';

/**
 * The consumer drives the replica that every availability answer is built on,
 * and the safety blocks that keep an uninspected machine off the road. Both
 * are tested here without a broker: the projector takes an envelope, so a test
 * can hand it one directly.
 */

interface Recorded {
  upserts: Record<string, unknown>[];
  processed: string[];
  /** Markers removed (a parked event dead-lettered, #240 r8). */
  unmarked: string[];
  /** The parked-insurance table, by event id. */
  parked: Map<string, ParkedRow>;
  /** Every outbox row, with the actor and tenant of the context it was built in. */
  events: (OutboxMessageInput & { callerService?: string; contextTenant?: string })[];
  /** Dead letters enqueued in the outbox (#240 r9), with the transaction each was written in. */
  deadLetters: (DeadLetterOutboxInput & { tx: number })[];
  /** The transaction each parked row was removed in, and each marker. */
  removedIn: { parked: number[]; unmarked: number[] };
  /** For each question to asset-service: whether a transaction was open (#240 r9). */
  askedInTransaction: boolean[];
}

/** The fake transaction handle: which `transaction()` call it belongs to. */
const txOf = (tx: unknown): number => (tx as { id: number }).id;

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

/** A parked row as the repository stores it (#240 r8). */
interface ParkedRow extends ParkedInsuranceInput {
  attempts: number;
  due: boolean;
}

function buildConsumer(options: {
  existing?: Record<string, unknown> | null;
  /** What the replica shows at each read, when it changes during a test; overrides `existing`. */
  replica?: () => Record<string, unknown> | null;
  alreadyProcessed?: boolean;
  open?: OpenAssignment[];
  windows?: LiveWindow[];
  /** asset-service's answers about policies; by default it confirms what each event states. */
  policies?: FakePolicySource;
  parking?: Partial<ParkingOptions>;
}) {
  const recorded: Recorded = {
    upserts: [],
    processed: [],
    unmarked: [],
    parked: new Map(),
    events: [],
    deadLetters: [],
    removedIn: { parked: [], unmarked: [] },
    askedInTransaction: [],
  };
  const replica = options.replica ?? (() => options.existing ?? null);
  let transactions = 0;
  let open = 0;

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
    findAssetRefUnscoped: jest.fn(async () => replica()),
    lockAssetRef: jest.fn(async () => undefined),
    dropTransferFences: jest.fn(async () => 0),
    transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      transactions += 1;
      open += 1;
      try {
        return await fn({ id: transactions });
      } finally {
        open -= 1;
      }
    }),
    markEventProcessed: jest.fn(async (_tx: unknown, eventId: string) => {
      if (options.alreadyProcessed) return false;
      recorded.processed.push(eventId);
      return true;
    }),
    isEventProcessed: jest.fn(async () => options.alreadyProcessed ?? false),
    unmarkEventProcessed: jest.fn(async (tx: unknown, eventId: string) => {
      recorded.unmarked.push(eventId);
      recorded.removedIn.unmarked.push(txOf(tx));
    }),
    enqueueDeadLetter: jest.fn(async (tx: unknown, letter: DeadLetterOutboxInput) => {
      recorded.deadLetters.push({ ...letter, tx: txOf(tx) });
      return 'OUTBOX-DLQ-1';
    }),
    upsertAssetRef: jest.fn(async (_tx: unknown, data: Record<string, unknown>) => {
      recorded.upserts.push(data);
      return data;
    }),
    parkInsuranceEvent: jest.fn(async (_tx: unknown, row: ParkedInsuranceInput) => {
      recorded.parked.set(row.eventId, { ...row, attempts: 0, due: true });
    }),
    // A copy, as a read from the database is: a later change is not seen in it.
    findParkedInsurance: jest.fn(async (_tx: unknown, eventId: string) => {
      const row = recorded.parked.get(eventId);
      return row ? { ...row } : null;
    }),
    markParkedInsuranceDue: jest.fn(async (_tx: unknown, assetId: string) => {
      const rows = [...recorded.parked.values()].filter((row) => row.assetId === assetId);
      for (const row of rows) row.due = true;
      return rows.length;
    }),
    listDueParkedInsurance: jest.fn(async () =>
      [...recorded.parked.values()]
        .filter((row) => row.due)
        .map((row) => ({ eventId: row.eventId, assetId: row.assetId })),
    ),
    recordParkedAttempt: jest.fn(async (_tx: unknown, eventId: string, reason: string) => {
      const row = recorded.parked.get(eventId)!;
      row.attempts += 1;
      row.reason = reason;
      return row.attempts;
    }),
    deleteParkedInsurance: jest.fn(async (tx: unknown, eventId: string) => {
      recorded.removedIn.parked.push(txOf(tx));
      return recorded.parked.delete(eventId);
    }),
  } as unknown as FleetRepository;

  const policies = options.policies ?? new FakePolicySource();
  policies.replica = () => replica();
  // What the consumer is given: the fake, noting whether a transaction is open
  // at each question. A test that replaces `policies.verify` is still noted.
  const source: InsurancePolicySource = {
    verify: async (...args) => {
      recorded.askedInTransaction.push(open > 0);
      return policies.verify(...args);
    },
  };
  const consumer = echoing(
    new AssetSyncConsumer(null, repository, undefined, undefined, undefined, source, {
      ...DEFAULT_PARKING,
      ...options.parking,
    }),
    policies,
  );
  return { consumer, repository, recorded, policies };
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
        // No generation stated: a known one is never lowered (#240 r12; r5 set
        // it to unknown). Every window went with it, and a verified answer at a
        // later generation is parked, not applied, until the replica catches up.
        expect(patch.ownershipGeneration).toBe(1);
      });

      it('r12: a transfer without a generation leaves an unknown one unknown: the owner check applies', async () => {
        const { consumer, recorded } = buildConsumer({
          existing: { ...movingMachine, ownershipGeneration: null },
        });

        await consumer.handle(transfer());

        expect(recorded.upserts[0]!.organizationId).toBe('ORG-DEH-0002');
        expect(recorded.upserts[0]!.ownershipGeneration).toBeNull();
      });

      it('refuses a malformed retainedCoverages before the marker', async () => {
        const { consumer, recorded } = buildConsumer({ existing: movingMachine });

        await expect(
          consumer.handle(transferWith({ retainedCoverages: 'THIRD_PARTY' })),
        ).rejects.toThrow();
        expect(recorded.processed).toHaveLength(0);
      });
    });

    describe('r12: the ownership generation only rises', () => {
      // The replica at generation 2, owner B, with B's own window recorded at 2:
      // what operator replays (`--allow-stale`) leave after C→A→B, while the
      // original C→A transfer (generation 1) is still on its way.
      const atTwo = {
        id: 'AST-SEED-0001',
        organizationId: 'ORG-DEH-0002',
        status: 'ACTIVE',
        ownershipGeneration: 2,
        retainedCoverages: [],
        insuranceCover: {
          COMPREHENSIVE: [
            {
              policyId: 'INS-B',
              validFrom: '2026-01-01T00:00:00.000Z',
              validTo: '2030-01-01T00:00:00.000Z',
              generation: 2,
            },
          ],
        },
      };
      const lateTransfer = (generation: number) =>
        transfer({
          tenantId: 'ORG-DEH-0003',
          payload: {
            assetId: 'AST-SEED-0001',
            fromOrganizationId: 'ORG-DEH-0001',
            toOrganizationId: 'ORG-DEH-0003',
            transferredAt: '2026-08-27T10:00:00.000Z',
            reason: 'واگذاری',
            ownershipGeneration: generation,
            retainedCoverages: [],
          },
        });

      it.each([1, 2])(
        'a transfer at generation %i, not after the replica’s 2: marked handled, nothing changed or ended',
        async (generation) => {
          const { consumer, repository, recorded } = buildConsumer({
            existing: atTwo,
            open: [open],
          });

          await consumer.handle(lateTransfer(generation));

          expect(recorded.processed).toEqual(['EVT-TRANSFER-1']);
          expect(recorded.upserts).toEqual([]);
          expect(repository.endActiveAssignmentsForAsset).not.toHaveBeenCalled();
          expect(repository.revokeWindowsAfterTransfer).not.toHaveBeenCalled();
          expect(repository.dropTransferFences).not.toHaveBeenCalled();
          expect(repository.markParkedInsuranceDue).not.toHaveBeenCalled();
          expect(recorded.events).toEqual([]);
        },
      );

      it('a replayed one (.retry) is history too: the source is not even asked', async () => {
        const { repository, recorded } = buildConsumer({ existing: atTwo });
        const snapshot = jest.fn();
        const consumer = new AssetSyncConsumer(null, repository, { snapshot });

        await consumer.handle(lateTransfer(1), { topic: 'rasta.asset.v1.retry', partition: 0 });

        expect(snapshot).not.toHaveBeenCalled();
        expect(recorded.processed).toEqual(['EVT-TRANSFER-1']);
        expect(recorded.upserts).toEqual([]);
      });

      it('a transfer after it applies as ever, and raises the generation', async () => {
        const { consumer, recorded } = buildConsumer({ existing: atTwo, open: [open] });

        await consumer.handle(lateTransfer(3));

        expect(recorded.upserts[0]).toMatchObject({
          organizationId: 'ORG-DEH-0003',
          ownershipGeneration: 3,
        });
        expect(recorded.upserts[0]!.insuranceCover).toEqual({});
      });
    });

    describe('r12: a refresh writes the source’s generation', () => {
      const RETRY = { topic: 'rasta.asset.v1.retry', partition: 0 } as const;
      const snapshotAt = (organizationId: string, transferGeneration: number) => ({
        assetId: 'AST-SEED-0001',
        organizationId,
        status: 'ACTIVE',
        name: 'لودر',
        type: 'LOADER',
        assetTag: null,
        transferGeneration,
        viaTransfer: false,
      });
      const window = (policyId: string, generation: number) => ({
        policyId,
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: '2030-01-01T00:00:00.000Z',
        generation,
      });
      const activation = (tenantId: string) =>
        envelope({ eventName: 'ASSET_ACTIVATED', tenantId, payload: { assetId: 'AST-SEED-0001' } });
      const refreshed = (existing: Record<string, unknown>, snapshot: object) => {
        const built = buildConsumer({ existing });
        Object.assign(built.repository, { findTransferFence: jest.fn(async () => null) });
        const consumer = new AssetSyncConsumer(
          null,
          built.repository,
          { snapshot: async () => snapshot as never },
          undefined,
          { resolve: async () => 'RECORDED' },
        );
        return { ...built, consumer };
      };

      it('a new owner: the snapshot’s generation, and only windows recorded under it stay', async () => {
        const { consumer, recorded } = refreshed(
          {
            id: 'AST-SEED-0001',
            organizationId: 'ORG-DEH-0001',
            ownershipGeneration: null,
            insuranceCover: { COMPREHENSIVE: [window('INS-A', 1), window('INS-B', 2)] },
          },
          snapshotAt('ORG-DEH-0002', 2),
        );

        await consumer.handle(activation('ORG-DEH-0002'), RETRY);

        expect(recorded.upserts[0]).toMatchObject({
          organizationId: 'ORG-DEH-0002',
          ownershipGeneration: 2,
          retainedCoverages: [],
          insuranceCover: { COMPREHENSIVE: [window('INS-B', 2)] },
        });
      });

      it('the same owner at a later generation (A→B→A missed): the earlier tenure’s windows go', async () => {
        const { consumer, recorded } = refreshed(
          {
            id: 'AST-SEED-0001',
            organizationId: 'ORG-DEH-0001',
            ownershipGeneration: 0,
            insuranceCover: { COMPREHENSIVE: [window('INS-A1', 0)] },
          },
          snapshotAt('ORG-DEH-0001', 2),
        );

        await consumer.handle(activation('ORG-DEH-0001'), RETRY);

        expect(recorded.upserts[0]).toMatchObject({
          ownershipGeneration: 2,
          retainedCoverages: [],
        });
        expect(recorded.upserts[0]!.insuranceCover).toEqual({});
      });

      it('the same tenure: the generation is written, the windows are left alone', async () => {
        const cover = { COMPREHENSIVE: [window('INS-A', 1)] };
        const { consumer, recorded } = refreshed(
          {
            id: 'AST-SEED-0001',
            organizationId: 'ORG-DEH-0001',
            ownershipGeneration: 1,
            insuranceCover: cover,
          },
          snapshotAt('ORG-DEH-0001', 1),
        );

        await consumer.handle(activation('ORG-DEH-0001'), RETRY);

        expect(recorded.upserts[0]!.ownershipGeneration).toBe(1);
        expect(recorded.upserts[0]).not.toHaveProperty('insuranceCover');
      });

      describe('r13: from an unknown generation (a migrated row), the tenure is uncertain', () => {
        const legacy = (policyId: string) => ({
          policyId,
          validFrom: '2026-01-01T00:00:00.000Z',
          validTo: '2030-01-01T00:00:00.000Z',
        });

        it('the same owner at generation 2: a window with no generation, or an earlier one, goes; one verified at 2 stays', async () => {
          const { consumer, recorded } = refreshed(
            {
              id: 'AST-SEED-0001',
              organizationId: 'ORG-DEH-0001',
              ownershipGeneration: null,
              retainedCoverages: ['COMPREHENSIVE'],
              insuranceCover: {
                COMPREHENSIVE: [legacy('INS-A1'), window('INS-A0', 0)],
                THIRD_PARTY: [window('INS-A2', 2)],
              },
            },
            snapshotAt('ORG-DEH-0001', 2),
          );

          await consumer.handle(activation('ORG-DEH-0001'), RETRY);

          expect(recorded.upserts[0]).toMatchObject({
            organizationId: 'ORG-DEH-0001',
            ownershipGeneration: 2,
            retainedCoverages: [],
          });
          expect(recorded.upserts[0]!.insuranceCover).toEqual({
            THIRD_PARTY: [window('INS-A2', 2)],
          });
        });

        it('generation 0 (never transferred, one tenure): every window stays', async () => {
          const { consumer, recorded } = refreshed(
            {
              id: 'AST-SEED-0001',
              organizationId: 'ORG-DEH-0001',
              ownershipGeneration: null,
              insuranceCover: { COMPREHENSIVE: [legacy('INS-A1')] },
            },
            snapshotAt('ORG-DEH-0001', 0),
          );

          await consumer.handle(activation('ORG-DEH-0001'), RETRY);

          expect(recorded.upserts[0]!.ownershipGeneration).toBe(0);
          expect(recorded.upserts[0]).not.toHaveProperty('insuranceCover');
        });

        it('ending assignments and revoking windows stay an owner change’s alone', async () => {
          const { consumer, repository } = refreshed(
            {
              id: 'AST-SEED-0001',
              organizationId: 'ORG-DEH-0001',
              ownershipGeneration: null,
              insuranceCover: { COMPREHENSIVE: [legacy('INS-A1')] },
            },
            snapshotAt('ORG-DEH-0001', 2),
          );

          await consumer.handle(activation('ORG-DEH-0001'), RETRY);

          expect(repository.endActiveAssignmentsForAsset).not.toHaveBeenCalled();
          expect(repository.revokeWindowsAfterTransfer).not.toHaveBeenCalled();
        });
      });

      describe('r13: an ASSET_CREATED only initialises an absent replica', () => {
        const created = (tenantId: string) =>
          envelope({
            eventId: 'EVT-CREATED-LATE',
            eventName: 'ASSET_CREATED',
            tenantId,
            payload: {
              assetId: 'AST-SEED-0001',
              organizationId: tenantId,
              name: 'نام هنگام ثبت',
              type: 'LOADER',
              assetTag: null,
              status: 'REGISTERED',
            },
          });
        // What replays leave after C→A→B: B at generation 2 with its own window.
        const atB = {
          id: 'AST-SEED-0001',
          organizationId: 'ORG-DEH-0002',
          status: 'ACTIVE',
          ownershipGeneration: 2,
          retainedCoverages: [],
          insuranceCover: { COMPREHENSIVE: [window('INS-B', 2)] },
        };

        it('the late original of the first owner: reconciled from asset-service, asked as the event’s tenant; owner, generation and windows stay', async () => {
          const snapshot = jest.fn(async () => ({
            ...snapshotAt('ORG-DEH-0002', 2),
            viaTransfer: true,
          }));
          const built = buildConsumer({ existing: atB });
          Object.assign(built.repository, { findTransferFence: jest.fn(async () => null) });
          const consumer = new AssetSyncConsumer(null, built.repository, { snapshot });

          await consumer.handle(created('ORG-DEH-0003'), {
            topic: 'rasta.asset.v1',
            partition: 0,
          });

          expect(snapshot).toHaveBeenCalledWith('ORG-DEH-0003', 'AST-SEED-0001');
          expect(built.recorded.processed).toEqual(['EVT-CREATED-LATE']);
          const written = built.recorded.upserts[0]!;
          expect(written).toMatchObject({
            organizationId: 'ORG-DEH-0002',
            ownershipGeneration: 2,
            status: 'ACTIVE',
            name: 'لودر',
          });
          expect(written).not.toHaveProperty('insuranceCover');
          expect(built.repository.endActiveAssignmentsForAsset).not.toHaveBeenCalled();
        });

        it('no answer from asset-service: thrown before any write (retried, then dead-lettered)', async () => {
          const built = buildConsumer({ existing: atB });
          const consumer = new AssetSyncConsumer(null, built.repository, {
            snapshot: async () => {
              throw RastaError.upstreamUnavailable('asset-service');
            },
          });

          await expect(consumer.handle(created('ORG-DEH-0003'))).rejects.toThrow();
          expect(built.recorded.upserts).toEqual([]);
        });

        it('no source configured: refused, never applied from the payload', async () => {
          const { consumer, recorded } = buildConsumer({ existing: atB });

          await expect(consumer.handle(created('ORG-DEH-0003'))).rejects.toThrow();
          expect(recorded.upserts).toEqual([]);
        });

        it('an absent row is initialised from the payload; nobody is asked', async () => {
          const snapshot = jest.fn();
          const built = buildConsumer({});
          const consumer = new AssetSyncConsumer(null, built.repository, { snapshot });

          await consumer.handle(created('ORG-DEH-0003'));

          expect(snapshot).not.toHaveBeenCalled();
          expect(built.recorded.upserts[0]).toMatchObject({
            organizationId: 'ORG-DEH-0003',
            name: 'نام هنگام ثبت',
            status: 'REGISTERED',
          });
        });

        it('its transaction gets a replay’s timeout, since it may ask under the lock', async () => {
          const built = buildConsumer({});
          const consumer = new AssetSyncConsumer(
            null,
            built.repository,
            undefined,
            undefined,
            undefined,
            undefined,
            DEFAULT_PARKING,
            9_000,
            400,
          );

          await consumer.handle(created('ORG-DEH-0003'));

          expect(built.repository.transaction).toHaveBeenCalledWith(expect.any(Function), {
            timeoutMs: 9_000,
            maxWaitMs: 400,
          });
        });
      });

      it.each([
        ['an earlier generation', snapshotAt('ORG-DEH-0001', 1)],
        ['another owner at the same generation', snapshotAt('ORG-DEH-0003', 2)],
      ])(
        'a snapshot showing %s than the replica is never written: retried',
        async (_label, snapshot) => {
          const { consumer, recorded } = refreshed(
            { id: 'AST-SEED-0001', organizationId: 'ORG-DEH-0002', ownershipGeneration: 2 },
            snapshot,
          );

          await expect(consumer.handle(activation('ORG-DEH-0002'), RETRY)).rejects.toThrow(
            /does not follow the replica's 2/,
          );
          expect(recorded.upserts).toEqual([]);
        },
      );
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

      // r7: the replica's retained list is no longer a verdict. The source is
      // asked every time, and these are the answers it gives under the current rule.
      it('is ignored when the source says the policy does not follow the vehicle', async () => {
        const policies = new FakePolicySource().deny('INS-LATE', 'NOT_FOLLOWING_VEHICLE');
        const { consumer, recorded } = buildConsumer({ existing: afterTransferMachine, policies });

        await consumer.handle(recordedWith('COMPREHENSIVE', 1));

        expect(recorded.processed).toHaveLength(1);
        expect(recorded.upserts[0]).not.toHaveProperty('insuranceCover');
      });

      it('is ignored when it carries no generation and the source says it does not count', async () => {
        const policies = new FakePolicySource().deny('INS-LATE', 'NOT_FOLLOWING_VEHICLE');
        const { consumer, recorded } = buildConsumer({ existing: afterTransferMachine, policies });

        await consumer.handle(recordedWith('COMPREHENSIVE'));

        expect(recorded.upserts[0]).not.toHaveProperty('insuranceCover');
      });

      it('is applied when its coverage follows the vehicle', async () => {
        const { consumer, recorded } = buildConsumer({ existing: afterTransferMachine });

        await consumer.handle(recordedWith('THIRD_PARTY', 1));

        // Stored with the generation the SOURCE states (the replica's), not the event's.
        expect(recorded.upserts[0]!.insuranceCover).toMatchObject({
          THIRD_PARTY: [{ policyId: 'INS-LATE', generation: 2 }],
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

        it('never decides from the replica alone: a policy that counts under the current rule is stored (r7)', async () => {
          // A legacy transfer retained nothing and the generation is unknown, so
          // the old pre-filter would have refused this for ever. The source says
          // it counts for the current owner: the window is stored.
          const policies = new FakePolicySource().set('INS-LATE', {
            counts: true,
            organizationId: 'ORG-DEH-0002',
            coverage: 'COMPREHENSIVE',
            validFrom: '2026-01-01T00:00:00.000Z',
            validUntil: '2030-01-01T00:00:00.000Z',
            ownershipGeneration: 2,
          });
          const { consumer, recorded } = buildConsumer({ existing: unknown, policies });

          await consumer.handle(recordedWith('COMPREHENSIVE'));

          expect(policies.asked).toEqual([
            { organizationId: 'ORG-DEH-0002', assetId: 'AST-SEED-0001', policyId: 'INS-LATE' },
          ]);
          expect(recorded.upserts[0]!.insuranceCover).toMatchObject({
            COMPREHENSIVE: [{ policyId: 'INS-LATE', validTo: '2030-01-01T00:00:00.000Z' }],
          });
        });

        it('ignores a delayed event of the previous owner when the source says it does not count', async () => {
          const policies = new FakePolicySource().deny('INS-LATE', 'NOT_FOLLOWING_VEHICLE');
          const { consumer, recorded } = buildConsumer({ existing: unknown, policies });

          await consumer.handle(recordedWith('COMPREHENSIVE'));

          expect(recorded.processed).toHaveLength(1);
          expect(recorded.upserts[0]).not.toHaveProperty('insuranceCover');
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

  /**
   * ADR-061 § 4 (#240 r6): an `INSURANCE_RECORDED` is applied only as
   * asset-service confirms it now, by whatever route it was delivered.
   */
  describe('INSURANCE_RECORDED is verified at its source', () => {
    const OWNER = 'ORG-DEH-0001';
    const machine = {
      id: 'AST-SEED-0001',
      organizationId: OWNER,
      inspectionBlockedAt: null,
      insuranceLapsedCoverages: [],
      insuranceCover: {},
      ownershipGeneration: 3,
      retainedCoverages: [],
    };
    const recordedPolicy = (overrides: Record<string, unknown> = {}) =>
      envelope({
        eventName: 'INSURANCE_RECORDED',
        payload: {
          assetId: 'AST-SEED-0001',
          organizationId: OWNER,
          policyId: 'INS-1',
          insurerName: 'بیمه ایران',
          coverage: 'COMPREHENSIVE',
          validFrom: '2026-01-01T00:00:00.000Z',
          validTo: '2999-01-01T00:00:00.000Z',
          ownershipGeneration: 3,
          ...overrides,
        },
      });
    const blocks = (cover: unknown) =>
      activeDispatchBlocks(
        {
          inspectionBlockedReason: null,
          insuranceLapsedCoverages: [],
          insuranceCover: cover,
          ownershipGeneration: 3,
        },
        new Date('2026-10-01T00:00:00.000Z'),
        { blockingCoverages: ['COMPREHENSIVE'], requiredCoverages: ['COMPREHENSIVE'] },
      );

    it('stores the window and generation the source states, not the event’s', async () => {
      const policies = new FakePolicySource().set('INS-1', {
        counts: true,
        organizationId: OWNER,
        coverage: 'COMPREHENSIVE',
        validFrom: '2026-02-01T00:00:00.000Z',
        validUntil: '2027-02-01T00:00:00.000Z',
        ownershipGeneration: 3,
      });
      const { consumer, recorded } = buildConsumer({ existing: machine, policies });

      await consumer.handle(recordedPolicy({ ownershipGeneration: 1 }));

      expect(recorded.upserts[0]!.insuranceCover).toEqual({
        COMPREHENSIVE: [
          {
            policyId: 'INS-1',
            validFrom: '2026-02-01T00:00:00.000Z',
            validTo: '2027-02-01T00:00:00.000Z',
            generation: 3,
          },
        ],
      });
      expect(policies.asked).toEqual([
        { organizationId: OWNER, assetId: 'AST-SEED-0001', policyId: 'INS-1' },
      ]);
    });

    it('ignores, as processed, a policy the source says does not count — a replay after the list was narrowed', async () => {
      // The event carries the current generation, so no owner or generation
      // check can refuse it: only the source knows the rule was narrowed.
      const policies = new FakePolicySource().deny('INS-1', 'NOT_FOLLOWING_VEHICLE');
      const { consumer, recorded } = buildConsumer({ existing: machine, policies });

      await consumer.handle(recordedPolicy());

      expect(recorded.processed).toHaveLength(1);
      expect(recorded.upserts[0]).not.toHaveProperty('insuranceCover');
      // Dispatch is refused: nothing in force for the required coverage.
      expect(blocks(machine.insuranceCover)).toEqual([
        expect.objectContaining({ cause: 'INSURANCE', coverages: ['COMPREHENSIVE'] }),
      ]);
    });

    it('ignores a policy the source does not know', async () => {
      const policies = new FakePolicySource().deny('INS-GHOST', 'UNKNOWN_POLICY');
      const { consumer, recorded } = buildConsumer({ existing: machine, policies });

      await consumer.handle(recordedPolicy({ policyId: 'INS-GHOST' }));

      expect(recorded.processed).toHaveLength(1);
      expect(recorded.upserts[0]).not.toHaveProperty('insuranceCover');
    });

    it('A→B→A: a delayed first-tenure event of A with an unknown generation is not applied', async () => {
      // The replica owner is A again, its generation unknown (a generation-less
      // transfer): the owner check cannot tell A's first tenure from this one.
      const policies = new FakePolicySource().deny('INS-OLD');
      const { consumer, recorded } = buildConsumer({
        existing: { ...machine, ownershipGeneration: null },
        policies,
      });

      await consumer.handle(recordedPolicy({ policyId: 'INS-OLD', ownershipGeneration: 1 }));

      expect(policies.asked).toHaveLength(1);
      expect(recorded.upserts[0]).not.toHaveProperty('insuranceCover');
    });

    it('A→B→A: a policy of the current tenure is stored with the source’s window and generation', async () => {
      const policies = new FakePolicySource().set('INS-NEW', {
        counts: true,
        organizationId: OWNER,
        coverage: 'COMPREHENSIVE',
        validFrom: '2026-09-01T00:00:00.000Z',
        validUntil: '2027-09-01T00:00:00.000Z',
        ownershipGeneration: 3,
      });
      const { consumer, recorded } = buildConsumer({
        existing: { ...machine, ownershipGeneration: null },
        policies,
      });

      await consumer.handle(recordedPolicy({ policyId: 'INS-NEW', ownershipGeneration: 3 }));

      expect(recorded.upserts[0]).toMatchObject({
        insuranceCover: {
          COMPREHENSIVE: [
            { policyId: 'INS-NEW', validTo: '2027-09-01T00:00:00.000Z', generation: 3 },
          ],
        },
        // r15: the source's answer initialises the unknown generation.
        ownershipGeneration: 3,
        retainedCoverages: [],
      });
    });

    describe('r15: an unknown generation initialised by the source’s answer', () => {
      const legacyWindow = {
        policyId: 'INS-FIRST-TENURE',
        validFrom: '2025-01-01T00:00:00.000Z',
        validTo: '2999-01-01T00:00:00.000Z',
      };
      const migrated = {
        ...machine,
        ownershipGeneration: null,
        retainedCoverages: ['THIRD_PARTY'],
        insuranceCover: {
          COMPREHENSIVE: [legacyWindow],
          THIRD_PARTY: [{ ...legacyWindow, policyId: 'INS-TP-NOW', generation: 3 }],
        },
      };
      const verdict = (generation: number) => ({
        counts: true as const,
        organizationId: OWNER,
        coverage: 'COMPREHENSIVE',
        validFrom: '2026-09-01T00:00:00.000Z',
        validUntil: '2027-09-01T00:00:00.000Z',
        ownershipGeneration: generation,
      });

      it('above generation 0: windows with no generation, or an earlier one, go; nothing retained', async () => {
        const policies = new FakePolicySource().set('INS-NEW', verdict(3));
        const { consumer, recorded } = buildConsumer({ existing: migrated, policies });

        await consumer.handle(recordedPolicy({ policyId: 'INS-NEW' }));

        const upsert = recorded.upserts[0]!;
        expect(upsert.ownershipGeneration).toBe(3);
        expect(upsert.retainedCoverages).toEqual([]);
        expect(upsert.insuranceCover).toEqual({
          COMPREHENSIVE: [
            {
              policyId: 'INS-NEW',
              validFrom: '2026-09-01T00:00:00.000Z',
              validTo: '2027-09-01T00:00:00.000Z',
              generation: 3,
            },
          ],
          THIRD_PARTY: [{ ...legacyWindow, policyId: 'INS-TP-NOW', generation: 3 }],
        });
      });

      it('at generation 0 (never transferred, one tenure): every window stays', async () => {
        const policies = new FakePolicySource().set('INS-NEW', verdict(0));
        const neverMoved = { ...migrated, retainedCoverages: [] };
        const { consumer, recorded } = buildConsumer({ existing: neverMoved, policies });

        await consumer.handle(recordedPolicy({ policyId: 'INS-NEW', ownershipGeneration: 0 }));

        const upsert = recorded.upserts[0]!;
        expect(upsert.ownershipGeneration).toBe(0);
        expect(upsert).not.toHaveProperty('retainedCoverages');
        expect((upsert.insuranceCover as Record<string, unknown[]>).COMPREHENSIVE).toEqual([
          legacyWindow,
          expect.objectContaining({ policyId: 'INS-NEW', generation: 0 }),
        ]);
      });

      it('a known generation is not touched by the answer', async () => {
        const policies = new FakePolicySource().set('INS-NEW', verdict(3));
        const { consumer, recorded } = buildConsumer({
          existing: { ...migrated, ownershipGeneration: 3 },
          policies,
        });

        await consumer.handle(recordedPolicy({ policyId: 'INS-NEW' }));

        expect(recorded.upserts[0]).not.toHaveProperty('ownershipGeneration');
        expect(recorded.upserts[0]).not.toHaveProperty('retainedCoverages');
        expect(
          (recorded.upserts[0]!.insuranceCover as Record<string, unknown[]>).COMPREHENSIVE,
        ).toHaveLength(2);
      });

      it('a transfer from it retains no window without a generation, even of a following coverage', async () => {
        const { consumer, recorded } = buildConsumer({ existing: migrated });

        await consumer.handle(
          envelope({
            eventId: 'EVT-TRANSFER-FROM-UNKNOWN',
            eventName: 'ASSET_TRANSFERRED',
            tenantId: 'ORG-DEH-0002',
            payload: {
              assetId: 'AST-SEED-0001',
              fromOrganizationId: OWNER,
              toOrganizationId: 'ORG-DEH-0002',
              transferredAt: '2026-08-27T10:00:00.000Z',
              reason: 'x',
              ownershipGeneration: 4,
              retainedCoverages: ['COMPREHENSIVE', 'THIRD_PARTY'],
            },
          }),
        );

        expect(recorded.upserts[0]).toMatchObject({
          organizationId: 'ORG-DEH-0002',
          ownershipGeneration: 4,
        });
        expect(recorded.upserts[0]!.insuranceCover).toEqual({
          THIRD_PARTY: [{ ...legacyWindow, policyId: 'INS-TP-NOW', generation: 3 }],
        });
      });
    });

    /** An ASSET_TRANSFERRED of the machine to `to`, stating the new generation. */
    const transferTo = (to: string, generation: number, from = OWNER) =>
      envelope({
        eventId: `EVT-TRANSFER-${to}-${generation}`,
        eventName: 'ASSET_TRANSFERRED',
        tenantId: to,
        payload: {
          assetId: 'AST-SEED-0001',
          fromOrganizationId: from,
          toOrganizationId: to,
          transferredAt: '2026-08-27T10:00:00.000Z',
          reason: 'x',
          ownershipGeneration: generation,
          retainedCoverages: [],
        },
      });

    describe('r7: the former owner, and an answer that is a snapshot', () => {
      const FORMER = 'ORG-DEH-0001';
      const NEW_OWNER = 'ORG-DEH-0002';
      const newOwnersMachine = { ...machine, organizationId: NEW_OWNER, ownershipGeneration: 3 };
      const counting = (overrides: Record<string, unknown> = {}) =>
        ({
          counts: true,
          organizationId: NEW_OWNER,
          coverage: 'COMPREHENSIVE',
          validFrom: '2026-02-01T00:00:00.000Z',
          validUntil: '2027-02-01T00:00:00.000Z',
          ownershipGeneration: 3,
          ...overrides,
        }) as never;

      it('asks as the owner the REPLICA shows, whatever tenant the old event carries', async () => {
        const policies = new FakePolicySource().set('INS-1', counting());
        const { consumer, recorded } = buildConsumer({ existing: newOwnersMachine, policies });

        // The event is the former owner's (tenant and payload).
        await consumer.handle(recordedPolicy({ ownershipGeneration: 1 }));

        expect(policies.asked).toEqual([
          { organizationId: NEW_OWNER, assetId: 'AST-SEED-0001', policyId: 'INS-1' },
        ]);
        expect(recorded.upserts[0]!.insuranceCover).toMatchObject({
          COMPREHENSIVE: [{ policyId: 'INS-1', generation: 3 }],
        });
        void FORMER;
      });

      it('NOT_CURRENT_OWNER while the replica still shows that owner: PARKED with the marker, never dead-lettered or ignored (r8)', async () => {
        // The transfer committed at the source; the replica has not consumed it.
        const policies = new FakePolicySource().set(
          'INS-1',
          counting({ organizationId: NEW_OWNER, ownershipGeneration: 4 }),
        );
        const { consumer, recorded } = buildConsumer({ existing: machine, policies });

        await consumer.handle(recordedPolicy(), {
          topic: 'rasta.insurance.v1',
          partition: 2,
          key: 'AST-SEED-0001',
          offset: '77',
        });

        expect(recorded.processed).toEqual(['01JBQ8Z4K7M2N5P8R1T3V6X9Y2']);
        expect(recorded.upserts).toHaveLength(0);
        expect(recorded.parked.get('01JBQ8Z4K7M2N5P8R1T3V6X9Y2')).toMatchObject({
          assetId: 'AST-SEED-0001',
          // The envelope's tenant, never the replica's or the source's owner.
          organizationId: OWNER,
          reason: 'NOT_CURRENT_OWNER',
          messageKey: 'AST-SEED-0001',
          sourceTopic: 'rasta.insurance.v1',
          sourcePartition: 2,
          sourceOffset: '77',
          envelope: expect.objectContaining({ eventName: 'INSURANCE_RECORDED' }),
        });
      });

      it('...and is applied, without a redelivery, by the sweep once the transfer is consumed', async () => {
        const policies = new FakePolicySource().set(
          'INS-1',
          counting({ organizationId: NEW_OWNER, ownershipGeneration: 4 }),
        );
        let shown: Record<string, unknown> = machine;
        const { consumer, recorded } = buildConsumer({ replica: () => shown, policies });
        await consumer.handle(recordedPolicy());
        expect(recorded.parked.size).toBe(1);

        // The transfer arrives; the projection is what the replica shows next.
        shown = { ...machine, organizationId: NEW_OWNER, ownershipGeneration: 4 };
        await consumer.handle(transferTo(NEW_OWNER, 4));
        await consumer.sweepParked();

        expect(recorded.parked.size).toBe(0);
        const applied = recorded.upserts.find((row) => row.sourceEvent === 'INSURANCE_RECORDED');
        expect(applied).toMatchObject({
          id: 'AST-SEED-0001',
          organizationId: NEW_OWNER,
          insuranceCover: { COMPREHENSIVE: [{ policyId: 'INS-1', generation: 4 }] },
        });
        expect(policies.asked.at(-1)).toEqual({
          organizationId: NEW_OWNER,
          assetId: 'AST-SEED-0001',
          policyId: 'INS-1',
        });
      });

      it('the source AHEAD of the replica (a transfer between answer and commit): not applied, parked', async () => {
        const policies = new FakePolicySource().set(
          'INS-1',
          counting({ organizationId: OWNER, ownershipGeneration: 4 }),
        );
        const { consumer, recorded } = buildConsumer({ existing: machine, policies });

        await consumer.handle(recordedPolicy());

        expect(recorded.upserts).toHaveLength(0);
        expect([...recorded.parked.values()].map((row) => row.reason)).toEqual(['SOURCE_AHEAD']);
      });

      it('the source AHEAD with the replica generation unknown and the owner changed: parked too', async () => {
        const policies = new FakePolicySource().set('INS-1', counting());
        const { consumer, recorded } = buildConsumer({
          existing: { ...machine, ownershipGeneration: null },
          policies,
        });

        // Asked as OWNER (the replica's), the source answers NOT_CURRENT_OWNER.
        await consumer.handle(recordedPolicy());

        expect(recorded.upserts).toHaveLength(0);
        expect(recorded.parked.size).toBe(1);
      });

      it('a redelivery of a parked event stops at the marker: parked once', async () => {
        const policies = new FakePolicySource().set(
          'INS-1',
          counting({ organizationId: NEW_OWNER, ownershipGeneration: 4 }),
        );
        const { consumer, recorded, repository } = buildConsumer({
          existing: machine,
          policies,
          alreadyProcessed: true,
        });

        await consumer.handle(recordedPolicy());

        expect(repository.parkInsuranceEvent).not.toHaveBeenCalled();
        expect(recorded.parked.size).toBe(0);
      });

      it('the source BEHIND the replica: the answer is stale, ignored as processed', async () => {
        const policies = new FakePolicySource().set(
          'INS-1',
          counting({ organizationId: OWNER, ownershipGeneration: 2 }),
        );
        const { consumer, recorded } = buildConsumer({ existing: machine, policies });

        await consumer.handle(recordedPolicy());

        expect(recorded.processed).toHaveLength(1);
        expect(recorded.upserts[0]).not.toHaveProperty('insuranceCover');
      });

      it('the source and the replica EQUAL: applied', async () => {
        const policies = new FakePolicySource().set(
          'INS-1',
          counting({ organizationId: OWNER, ownershipGeneration: 3 }),
        );
        const { consumer, recorded } = buildConsumer({ existing: machine, policies });

        await consumer.handle(recordedPolicy());

        expect(recorded.upserts[0]!.insuranceCover).toMatchObject({
          COMPREHENSIVE: [{ policyId: 'INS-1', generation: 3 }],
        });
      });

      it('a plain not-counting verdict is still ignored, not retried', async () => {
        const policies = new FakePolicySource().deny('INS-1', 'NOT_ACTIVE');
        const { consumer, recorded } = buildConsumer({ existing: machine, policies });

        await consumer.handle(recordedPolicy());

        expect(recorded.processed).toHaveLength(1);
        expect(recorded.upserts[0]).not.toHaveProperty('insuranceCover');
      });
    });

    /**
     * #240 r8, r10: a parked event is decided again by the same verification —
     * by the sweep, which the transfer makes it due for — and dead-lettered,
     * never applied, when its attempts run out.
     */
    describe('r8: parked events, re-verified', () => {
      const B = 'ORG-DEH-0002';
      const C = 'ORG-DEH-0003';
      const counting = (organizationId: string, ownershipGeneration: number) =>
        ({
          counts: true,
          organizationId,
          coverage: 'COMPREHENSIVE',
          validFrom: '2026-02-01T00:00:00.000Z',
          validUntil: '2027-02-01T00:00:00.000Z',
          ownershipGeneration,
        }) as const;

      /**
       * A consumer whose replica shows `machine` until `move` is called, at an
       * insurance revision that `bumpRevision` moves (#240 r10).
       */
      function parkedSetup(
        verdictOwner: string,
        generation: number,
        parking: Partial<ParkingOptions> = {},
      ) {
        const policies = new FakePolicySource().set('INS-1', counting(verdictOwner, generation));
        let revision = 0n;
        let shown: Record<string, unknown> = { ...machine, insuranceRevision: revision };
        const built = buildConsumer({ replica: () => shown, policies, parking });
        return {
          ...built,
          move: (organizationId: string, ownershipGeneration: number) => {
            shown = {
              ...machine,
              organizationId,
              ownershipGeneration,
              insuranceRevision: revision,
            };
          },
          bumpRevision: () => {
            revision += 1n;
            shown = { ...shown, insuranceRevision: revision };
          },
          /** A clear of a row with nothing to empty: the epoch moves, the revision does not (r11). */
          bumpEpoch: () => {
            shown = { ...shown, insuranceEpoch: ((shown.insuranceEpoch as bigint) ?? 0n) + 1n };
          },
        };
      }

      it('a policy that does not count once the transfer is consumed: removed, nothing applied', async () => {
        const { consumer, recorded, policies, move } = parkedSetup(B, 4);
        await consumer.handle(recordedPolicy());
        expect(recorded.parked.size).toBe(1);

        policies.deny('INS-1', 'NOT_FOLLOWING_VEHICLE');
        await consumer.handle(transferTo(B, 4));
        move(B, 4);
        await consumer.sweepParked();

        expect(recorded.parked.size).toBe(0);
        expect(recorded.upserts.some((row) => row.sourceEvent === 'INSURANCE_RECORDED')).toBe(
          false,
        );
      });

      it('the source BEHIND the replica at re-verification: removed as stale', async () => {
        const { consumer, recorded, policies, move } = parkedSetup(B, 4);
        await consumer.handle(recordedPolicy());

        policies.set('INS-1', counting(B, 4));
        await consumer.handle(transferTo(B, 5));
        move(B, 5);
        await consumer.sweepParked();

        expect(recorded.parked.size).toBe(0);
        expect(recorded.upserts.some((row) => row.sourceEvent === 'INSURANCE_RECORDED')).toBe(
          false,
        );
      });

      it('A→B→C with only B consumed: still about a later owner, kept with one attempt counted', async () => {
        const { consumer, recorded, move } = parkedSetup(C, 5);
        await consumer.handle(recordedPolicy());

        await consumer.handle(transferTo(B, 4));
        move(B, 4);
        await consumer.sweepParked();

        expect(recorded.parked.get('01JBQ8Z4K7M2N5P8R1T3V6X9Y2')).toMatchObject({
          attempts: 1,
          reason: 'NOT_CURRENT_OWNER',
        });
        expect(recorded.unmarked).toHaveLength(0);
      });

      it('asset-service down at re-verification: the transfer is still projected, the event stays parked', async () => {
        const { consumer, recorded, policies, move } = parkedSetup(B, 4);
        await consumer.handle(recordedPolicy());

        policies.unreachable();
        // Moved once the transfer is handled: before, the replica would already
        // stand at its generation and the transfer be history (r12).
        await consumer.handle(transferTo(B, 4));
        move(B, 4);
        expect(recorded.upserts.at(-1)).toMatchObject({ sourceEvent: 'ASSET_TRANSFERRED' });
        await consumer.sweepParked();

        expect(recorded.parked.get('01JBQ8Z4K7M2N5P8R1T3V6X9Y2')).toMatchObject({
          attempts: 1,
          reason: 'NO_ANSWER',
        });
      });

      it('r10: the transfer asks nobody — it makes the machine’s parked events due in its own transaction and returns', async () => {
        const { consumer, recorded, repository, policies, move } = parkedSetup(B, 4);
        await consumer.handle(recordedPolicy());
        recorded.parked.get('01JBQ8Z4K7M2N5P8R1T3V6X9Y2')!.due = false;
        const asked = policies.asked.length;

        await consumer.handle(transferTo(B, 4));
        move(B, 4);

        expect(policies.asked).toHaveLength(asked);
        expect(recorded.parked.get('01JBQ8Z4K7M2N5P8R1T3V6X9Y2')).toMatchObject({
          due: true,
          attempts: 0,
        });
        // In the transfer's own transaction (the last one opened), under its lock.
        const [[tx, assetId]] = (repository.markParkedInsuranceDue as jest.Mock).mock.calls as [
          [unknown, string],
        ];
        expect(assetId).toBe('AST-SEED-0001');
        expect(txOf(tx)).toBe((repository.transaction as jest.Mock).mock.calls.length);

        // The sweep decides it.
        expect(await consumer.sweepParked()).toMatchObject({ APPLIED: 1 });
        expect(recorded.parked.size).toBe(0);
      });

      it('the sweep applies a due event once the replica has caught up by any route', async () => {
        const { consumer, recorded, move } = parkedSetup(B, 4);
        await consumer.handle(recordedPolicy());

        // A replay refreshed the replica, or a transfer's own re-verification failed.
        move(B, 4);
        const counts = await consumer.sweepParked();

        expect(counts).toMatchObject({ APPLIED: 1, KEPT: 0, DEAD_LETTERED: 0 });
        expect(recorded.parked.size).toBe(0);
        expect(recorded.upserts.at(-1)).toMatchObject({
          organizationId: B,
          insuranceCover: { COMPREHENSIVE: [{ policyId: 'INS-1', generation: 4 }] },
        });
      });

      it('the sweep leaves a row that is not due yet', async () => {
        const { consumer, recorded, policies, repository } = parkedSetup(B, 4);
        await consumer.handle(recordedPolicy());
        recorded.parked.get('01JBQ8Z4K7M2N5P8R1T3V6X9Y2')!.due = false;
        const asked = policies.asked.length;

        // Listed a moment ago (by another instance's run, say): re-checked under the lock.
        (repository.listDueParkedInsurance as jest.Mock).mockResolvedValueOnce([
          { eventId: '01JBQ8Z4K7M2N5P8R1T3V6X9Y2', assetId: 'AST-SEED-0001' },
        ]);
        const counts = await consumer.sweepParked();

        expect(counts.NOT_DUE).toBe(1);
        expect(policies.asked).toHaveLength(asked);
        expect(recorded.parked.get('01JBQ8Z4K7M2N5P8R1T3V6X9Y2')!.attempts).toBe(0);
      });

      it('r9, r10: asset-service is never asked inside a transaction, live or parked', async () => {
        const { consumer, recorded, move } = parkedSetup(B, 4);
        await consumer.handle(recordedPolicy());
        // The live delivery asks before its transaction (r10).
        expect(recorded.askedInTransaction).toEqual([false]);

        await consumer.handle(transferTo(B, 4));
        move(B, 4);
        await consumer.sweepParked();

        expect(recorded.askedInTransaction).toEqual([false, false]);
        expect(recorded.parked.size).toBe(0);
      });

      it('r10: the insurance revision moved while the source was asked (a clear) — kept, no attempt counted, nothing applied', async () => {
        const { consumer, recorded, policies, move, bumpRevision } = parkedSetup(B, 4);
        await consumer.handle(recordedPolicy());
        move(B, 4);
        const verify = policies.verify.bind(policies);
        jest.spyOn(policies, 'verify').mockImplementationOnce(async (...args) => {
          const answer = await verify(...args);
          // insurance:clear-transferred committed in between: same owner and
          // generation, the windows emptied — only the revision says so.
          bumpRevision();
          return answer;
        });

        expect(await consumer.sweepParked()).toMatchObject({ KEPT: 1, APPLIED: 0 });
        expect(recorded.parked.get('01JBQ8Z4K7M2N5P8R1T3V6X9Y2')).toMatchObject({ attempts: 0 });
        expect(recorded.upserts.some((row) => row.sourceEvent === 'INSURANCE_RECORDED')).toBe(
          false,
        );

        // Still parked and due: the next run asks again, now under the new rule.
        policies.deny('INS-1', 'NOT_FOLLOWING_VEHICLE');
        expect(await consumer.sweepParked()).toMatchObject({ DROPPED: 1 });
        expect(recorded.upserts.some((row) => row.sourceEvent === 'INSURANCE_RECORDED')).toBe(
          false,
        );
      });

      it('r11: only the invalidation epoch moved while the source was asked (a clear with nothing to empty) — kept, nothing applied', async () => {
        const { consumer, recorded, policies, move, bumpEpoch } = parkedSetup(B, 4);
        await consumer.handle(recordedPolicy());
        move(B, 4);
        const verify = policies.verify.bind(policies);
        jest.spyOn(policies, 'verify').mockImplementationOnce(async (...args) => {
          const answer = await verify(...args);
          bumpEpoch();
          return answer;
        });

        expect(await consumer.sweepParked()).toMatchObject({ KEPT: 1, APPLIED: 0 });
        expect(recorded.parked.get('01JBQ8Z4K7M2N5P8R1T3V6X9Y2')).toMatchObject({ attempts: 0 });
        expect(recorded.upserts.some((row) => row.sourceEvent === 'INSURANCE_RECORDED')).toBe(
          false,
        );

        policies.deny('INS-1', 'NOT_FOLLOWING_VEHICLE');
        expect(await consumer.sweepParked()).toMatchObject({ DROPPED: 1 });
        expect(recorded.upserts.some((row) => row.sourceEvent === 'INSURANCE_RECORDED')).toBe(
          false,
        );
      });

      it('r9: an upstream timeout is counted as an attempt each run, and the maximum dead-letters it', async () => {
        const { consumer, recorded, policies } = parkedSetup(B, 4, { maxAttempts: 3 });
        await consumer.handle(recordedPolicy(), {
          topic: 'rasta.insurance.v1',
          partition: 1,
          key: 'AST-SEED-0001',
          offset: '9',
        });
        jest
          .spyOn(policies, 'verify')
          .mockRejectedValue(RastaError.upstreamTimeout('asset-service', 30_000));

        expect(await consumer.sweepParked()).toMatchObject({ KEPT: 1 });
        expect(recorded.parked.get('01JBQ8Z4K7M2N5P8R1T3V6X9Y2')).toMatchObject({
          attempts: 1,
          reason: 'NO_ANSWER',
        });
        expect(await consumer.sweepParked()).toMatchObject({ KEPT: 1 });
        expect(await consumer.sweepParked()).toMatchObject({ DEAD_LETTERED: 1 });

        expect(recorded.parked.size).toBe(0);
        expect(recorded.deadLetters).toHaveLength(1);
        expect(recorded.deadLetters[0]!.headers).toMatchObject({
          'x-dlq-reason': 'PARKED_VERIFICATION_EXHAUSTED',
          'x-dlq-attempts': '3',
        });
        expect(recorded.deadLetters[0]!.headers['x-dlq-error']).toMatch(/\(last: NO_ANSWER\)/);
        expect(recorded.askedInTransaction.slice(1)).toEqual([false, false, false]);
      });

      it('r9: decided again under the lock — an attempt another run counted meanwhile is not counted twice', async () => {
        const { consumer, recorded, policies } = parkedSetup(B, 4);
        await consumer.handle(recordedPolicy());
        const verify = policies.verify.bind(policies);
        jest.spyOn(policies, 'verify').mockImplementationOnce(async (...args) => {
          // Another instance's sweep tried it first.
          recorded.parked.get('01JBQ8Z4K7M2N5P8R1T3V6X9Y2')!.attempts += 1;
          return verify(...args);
        });

        expect(await consumer.sweepParked()).toMatchObject({ NOT_DUE: 1, KEPT: 0 });
        expect(recorded.parked.get('01JBQ8Z4K7M2N5P8R1T3V6X9Y2')!.attempts).toBe(1);
      });

      it('r9: the replica moved while the source was asked — kept, not decided on an answer about another owner', async () => {
        const { consumer, recorded, policies, move } = parkedSetup(B, 4);
        await consumer.handle(recordedPolicy());
        const verify = policies.verify.bind(policies);
        jest.spyOn(policies, 'verify').mockImplementationOnce(async (...args) => {
          const answer = await verify(...args);
          move(B, 4); // the transfer committed in between
          return answer;
        });

        expect(await consumer.sweepParked()).toMatchObject({ KEPT: 1 });
        expect(recorded.parked.get('01JBQ8Z4K7M2N5P8R1T3V6X9Y2')).toMatchObject({ attempts: 0 });
        expect(recorded.upserts.some((row) => row.sourceEvent === 'INSURANCE_RECORDED')).toBe(
          false,
        );
      });

      it('exhausted: one transaction enqueues the dead letter in the outbox and removes the row and the marker', async () => {
        const counted = async () =>
          (await dlqMessagesTotal.get()).values.find(
            (sample) =>
              sample.labels.service === 'fleet-service-asset-sync' &&
              sample.labels.topic === 'rasta.insurance.v1' &&
              sample.labels.reason === 'PARKED_VERIFICATION_EXHAUSTED',
          )?.value ?? 0;
        const { consumer, recorded } = parkedSetup(B, 4, {
          maxAttempts: 2,
          dlqMetricService: 'fleet-service-asset-sync',
        });
        const before = await counted();
        await consumer.handle(recordedPolicy(), {
          topic: 'rasta.insurance.v1',
          partition: 1,
          key: 'AST-SEED-0001',
          offset: '9',
        });

        expect(await consumer.sweepParked()).toMatchObject({ KEPT: 1, DEAD_LETTERED: 0 });
        expect(recorded.deadLetters).toHaveLength(0);
        expect(await consumer.sweepParked()).toMatchObject({ DEAD_LETTERED: 1 });

        expect(recorded.deadLetters).toHaveLength(1);
        const letter = recorded.deadLetters[0]!;
        expect(letter).toMatchObject({
          topic: 'rasta.fleet.v1.dlq',
          key: 'AST-SEED-0001',
          organizationId: OWNER,
          envelope: { eventId: '01JBQ8Z4K7M2N5P8R1T3V6X9Y2', eventName: 'INSURANCE_RECORDED' },
        });
        expect(letter.headers).toMatchObject({
          'x-event-id': '01JBQ8Z4K7M2N5P8R1T3V6X9Y2',
          'x-event-name': 'INSURANCE_RECORDED',
          'x-tenant-id': OWNER,
          'x-dlq-reason': 'PARKED_VERIFICATION_EXHAUSTED',
          'x-dlq-original-topic': 'rasta.insurance.v1',
          'x-dlq-original-partition': '1',
          'x-dlq-original-offset': '9',
          'x-dlq-attempts': '2',
          // Written by fleet's consumer, not by the original producer.
          'x-producer': 'fleet-service-asset-sync',
        });
        expect(letter.headers['x-dlq-error']).toMatch(
          /PARKED_VERIFICATION_EXHAUSTED.*after 2 attempts \(last: NOT_CURRENT_OWNER\)/,
        );
        // The same transaction: published exactly when the row and the marker are gone.
        expect(recorded.removedIn.parked.at(-1)).toBe(letter.tx);
        expect(recorded.removedIn.unmarked).toEqual([letter.tx]);
        expect(recorded.parked.size).toBe(0);
        // A replay of the dead letter is applied, not stopped at the marker.
        expect(recorded.unmarked).toEqual(['01JBQ8Z4K7M2N5P8R1T3V6X9Y2']);
        // Never applied unverified.
        expect(recorded.upserts.some((row) => row.sourceEvent === 'INSURANCE_RECORDED')).toBe(
          false,
        );
        expect((await counted()) - before).toBe(1);
      });

      it('exhausted but the dead letter cannot be enqueued: nothing removed, nothing counted', async () => {
        const { consumer, recorded, repository } = parkedSetup(B, 4, { maxAttempts: 1 });
        await consumer.handle(recordedPolicy());
        (repository.enqueueDeadLetter as jest.Mock).mockRejectedValueOnce(new Error('db down'));

        const counts = await consumer.sweepParked();

        expect(counts.DEAD_LETTERED).toBe(0);
        expect(recorded.parked.size).toBe(1);
        expect(recorded.unmarked).toHaveLength(0);
        expect(recorded.deadLetters).toHaveLength(0);
      });
    });

    it('with asset-service down: the event fails (retry), the policy is never applied', async () => {
      const policies = new FakePolicySource().unreachable();
      const { consumer, recorded } = buildConsumer({ existing: machine, policies });

      await expect(consumer.handle(recordedPolicy())).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
      });

      expect(recorded.upserts).toHaveLength(0);
    });

    describe('r10: the live delivery asks before its transaction, and decides on an unchanged revision', () => {
      const confirmed = {
        counts: true,
        organizationId: OWNER,
        coverage: 'COMPREHENSIVE',
        validFrom: '2026-02-01T00:00:00.000Z',
        validUntil: '2027-02-01T00:00:00.000Z',
        ownershipGeneration: 3,
      } as const;

      it('the revision moved while the source was asked (a clear): fails for a retry, nothing applied; the retry asks again', async () => {
        const policies = new FakePolicySource().set('INS-1', confirmed);
        let shown: Record<string, unknown> = { ...machine, insuranceRevision: 7n };
        const { consumer, recorded, repository } = buildConsumer({
          replica: () => shown,
          policies,
        });
        const verify = policies.verify.bind(policies);
        jest.spyOn(policies, 'verify').mockImplementationOnce(async (...args) => {
          const answer = await verify(...args);
          // insurance:clear-transferred committed in between: same owner and
          // generation, the windows emptied.
          shown = { ...shown, insuranceRevision: 8n };
          return answer;
        });

        await expect(consumer.handle(recordedPolicy())).rejects.toThrow(
          /insurance state of AST-SEED-0001 changed while asset-service was asked/,
        );
        expect(recorded.upserts).toHaveLength(0);
        expect(repository.parkInsuranceEvent).not.toHaveBeenCalled();
        // The source was asked with no lock and no transaction.
        expect(repository.lockAssetRef).toHaveBeenCalledTimes(1);
        expect(recorded.askedInTransaction).toEqual([false]);

        // The retry: the narrowed rule no longer counts the policy.
        policies.deny('INS-1', 'NOT_FOLLOWING_VEHICLE');
        await consumer.handle(recordedPolicy());
        expect(policies.asked).toHaveLength(2);
        expect(recorded.upserts.at(-1)).not.toHaveProperty('insuranceCover');
      });

      it('r11: only the invalidation epoch moved (a clear with nothing to empty): fails for a retry, nothing applied', async () => {
        const policies = new FakePolicySource().set('INS-1', confirmed);
        let shown: Record<string, unknown> = {
          ...machine,
          insuranceRevision: 7n,
          insuranceEpoch: 2n,
        };
        const { consumer, recorded, repository } = buildConsumer({
          replica: () => shown,
          policies,
        });
        const verify = policies.verify.bind(policies);
        jest.spyOn(policies, 'verify').mockImplementationOnce(async (...args) => {
          const answer = await verify(...args);
          // The revision cannot move: the clear changed no value.
          shown = { ...shown, insuranceEpoch: 3n };
          return answer;
        });

        await expect(consumer.handle(recordedPolicy())).rejects.toThrow(
          /insurance state of AST-SEED-0001 changed while asset-service was asked/,
        );
        expect(recorded.upserts).toHaveLength(0);
        expect(repository.parkInsuranceEvent).not.toHaveBeenCalled();

        policies.deny('INS-1', 'NOT_FOLLOWING_VEHICLE');
        await consumer.handle(recordedPolicy());
        expect(policies.asked).toHaveLength(2);
        expect(recorded.upserts.at(-1)).not.toHaveProperty('insuranceCover');
      });

      it('an unchanged revision: decided and applied under the lock', async () => {
        const policies = new FakePolicySource().set('INS-1', confirmed);
        const { consumer, recorded } = buildConsumer({
          existing: { ...machine, insuranceRevision: 7n },
          policies,
        });

        await consumer.handle(recordedPolicy());

        expect(recorded.upserts[0]!.insuranceCover).toMatchObject({
          COMPREHENSIVE: [{ policyId: 'INS-1', generation: 3 }],
        });
      });

      it('a redelivery of a handled event asks nobody', async () => {
        const policies = new FakePolicySource().set('INS-1', confirmed);
        const { consumer, recorded } = buildConsumer({
          existing: machine,
          policies,
          alreadyProcessed: true,
        });

        await consumer.handle(recordedPolicy());

        expect(policies.asked).toHaveLength(0);
        expect(recorded.upserts).toHaveLength(0);
      });

      it('handled when read but unmarked since (its parked row dead-lettered): fails for a retry, never applied unverified', async () => {
        const policies = new FakePolicySource().set('INS-1', confirmed);
        const { consumer, recorded, repository } = buildConsumer({ existing: machine, policies });
        (repository.isEventProcessed as jest.Mock).mockResolvedValueOnce(true);

        await expect(consumer.handle(recordedPolicy())).rejects.toThrow(/no longer marked handled/);
        expect(policies.asked).toHaveLength(0);
        expect(recorded.upserts).toHaveLength(0);
      });
    });

    it('a service built without asset-service applies nothing', async () => {
      const { repository } = buildConsumer({ existing: machine });
      const unwired = new AssetSyncConsumer(null, repository);

      await expect(unwired.handle(recordedPolicy())).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
      });
    });

    it('asks on a .retry delivery too, whatever the topic', async () => {
      const policies = new FakePolicySource().deny('INS-1');
      const { consumer, recorded } = buildConsumer({ existing: machine, policies });

      await consumer.handle(recordedPolicy(), {
        topic: 'rasta.insurance.v1.retry',
      } as never);

      expect(policies.asked).toHaveLength(1);
      expect(recorded.upserts[0]).not.toHaveProperty('insuranceCover');
    });

    describe('r12: transactions, reads and heartbeats inside the delivery budget', () => {
      it('every transaction states its start wait; an ordinary event keeps Prisma’s timeout', async () => {
        const { repository } = buildConsumer({ existing: machine });
        const consumer = new AssetSyncConsumer(
          null,
          repository,
          undefined,
          undefined,
          undefined,
          undefined,
          DEFAULT_PARKING,
          14_200,
          321,
        );

        await consumer.handle(
          envelope({
            eventName: 'ASSET_ACTIVATED',
            tenantId: OWNER,
            payload: { assetId: 'AST-SEED-0001' },
          }),
        );

        expect(jest.mocked(repository.transaction).mock.calls.at(-1)![1]).toEqual({
          maxWaitMs: 321,
        });
      });

      it('the reads before the transaction are bounded by the start wait: slower, the attempt fails and nothing is asked', async () => {
        const policies = new FakePolicySource();
        const { repository } = buildConsumer({ existing: machine, policies });
        jest
          .mocked(repository.isEventProcessed)
          .mockImplementation(() => new Promise<boolean>(() => undefined));
        const consumer = new AssetSyncConsumer(
          null,
          repository,
          undefined,
          undefined,
          undefined,
          policies,
          DEFAULT_PARKING,
          14_200,
          60,
        );
        const started = Date.now();

        await expect(consumer.handle(recordedPolicy())).rejects.toThrow(
          /reading the replica of AST-SEED-0001 took longer than 60 ms/,
        );
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(policies.asked).toHaveLength(0);
        expect(repository.transaction).not.toHaveBeenCalled();
      });

      it('heartbeats before and after asking asset-service, and the transaction states both bounds', async () => {
        const order: string[] = [];
        const { consumer, repository, policies } = buildConsumer({ existing: machine });
        const verify = policies.verify.bind(policies);
        jest.spyOn(policies, 'verify').mockImplementation(async (...args) => {
          order.push('verify');
          return verify(...args);
        });
        const heartbeat = jest.fn(() => {
          order.push('beat');
        });

        await consumer.handle(recordedPolicy(), {
          topic: 'rasta.insurance.v1',
          partition: 0,
          heartbeat,
        });

        expect(order).toEqual(['beat', 'verify', 'beat']);
        expect(jest.mocked(repository.transaction).mock.calls.at(-1)![1]).toEqual({
          timeoutMs: 14_200,
          maxWaitMs: 500,
        });
      });

      it('heartbeats after a question that fails, too', async () => {
        const policies = new FakePolicySource().unreachable();
        const { consumer } = buildConsumer({ existing: machine, policies });
        const heartbeat = jest.fn();

        await expect(
          consumer.handle(recordedPolicy(), {
            topic: 'rasta.insurance.v1',
            partition: 0,
            heartbeat,
          }),
        ).rejects.toThrow();
        expect(heartbeat).toHaveBeenCalledTimes(2);
      });
    });
  });
});
