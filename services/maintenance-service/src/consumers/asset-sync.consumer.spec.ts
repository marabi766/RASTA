import type { EventEnvelope } from '@rasta/contracts';
import { AssetSyncConsumer, PROJECTIONS } from './asset-sync.consumer';
import type { AssetSnapshotSource } from './replica-sources';
import type { MaintenanceRepository } from '../maintenance/maintenance.repository';

/**
 * The reference replica, driven directly.
 *
 * The interesting cases are all about *not* losing information: an event that
 * carries a status must not blank out a name, and an event whose tenant is
 * only on the envelope must not write a row with no organization. That second
 * one was a real bug in fleet-service, caught by an integration test rather
 * than a unit test — so it is pinned here as well, where it costs nothing.
 */

interface Upsert {
  id: string;
  organizationId: string;
  name?: string | null;
  status?: string;
  sourceEvent: string;
}

function harness(
  options: {
    existing?: { organizationId: string } | null;
    already?: boolean;
    openWork?: { openRequests: number; openRepairOrders: number };
    /** A real ledger: an event id marks once. */
    ledger?: boolean;
    assetSource?: AssetSnapshotSource;
  } = {},
) {
  const upserts: Upsert[] = [];
  const calls: string[] = [];
  const marked = new Set<string>();
  const marks: string[] = [];
  /** Marks written in the transaction now open; rolled back if it throws, as in PostgreSQL. */
  let pending: string[] = [];

  const repository = {
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      pending = [];
      try {
        return await fn({});
      } catch (error) {
        for (const eventId of pending) {
          marks.splice(marks.lastIndexOf(eventId), 1);
          marked.delete(eventId);
        }
        throw error;
      }
    },
    async markEventProcessed(_tx: unknown, eventId: string): Promise<boolean> {
      marks.push(eventId);
      if (options.ledger) {
        if (marked.has(eventId)) return false;
        marked.add(eventId);
      }
      pending.push(eventId);
      return !options.already;
    },
    async findTransferFence() {
      return null;
    },
    async findAssetRef() {
      return options.existing ?? null;
    },
    async upsertAssetRef(_tx: unknown, data: Upsert): Promise<void> {
      calls.push('upsert');
      upserts.push(data);
    },
    async lockAssetRef(): Promise<void> {
      // The replica-row lock every delivery takes (D-039); not part of the ordering pinned here.
    },
    async lockAssetForWork(_tx: unknown, assetId: string, mode: string): Promise<void> {
      calls.push(`lock:${assetId}:${mode}`);
    },
    async dropTransferFences(_tx: unknown, assetId: string, organizationId: string) {
      calls.push(`drop:${assetId}:${organizationId}`);
      return 1;
    },
    async countOpenWork(_tx: unknown, assetId: string, organizationId: string) {
      calls.push(`count:${assetId}:${organizationId}`);
      return options.openWork ?? { openRequests: 0, openRepairOrders: 0 };
    },
  } as unknown as MaintenanceRepository;

  return {
    consumer: new AssetSyncConsumer(null, repository, options.assetSource),
    upserts,
    calls,
    marks,
  };
}

/** `tenantId: null` leaves the envelope without a tenant; the default is the machine's owner. */
function envelope(
  eventName: string,
  payload: object,
  tenantId: string | null = 'ORG-DEH-0001',
): EventEnvelope {
  return {
    eventId: `evt-${eventName}`,
    eventName,
    eventVersion: 1,
    occurredAt: '2026-08-28T10:00:00.000Z',
    producer: 'asset-service',
    aggregateType: 'Asset',
    aggregateId: 'AST-SEED-0001',
    correlationId: 'corr-1',
    payload,
    ...(tenantId ? { tenantId } : {}),
  } as EventEnvelope;
}

/** A real-shaped ASSET_CREATED payload (asset-service `assetCreatedPayload`). */
function created(assetId: string, overrides: Record<string, unknown> = {}): object {
  return {
    assetId,
    organizationId: 'ORG-DEH-0001',
    name: 'لودر',
    type: 'LOADER',
    assetTag: null,
    serialNumber: null,
    status: 'REGISTERED',
    ...overrides,
  };
}

describe('asset reference replica', () => {
  describe('a transfer landing (ADR-062)', () => {
    const transfer = () =>
      envelope(
        'ASSET_TRANSFERRED',
        {
          assetId: 'AST-SEED-0001',
          fromOrganizationId: 'ORG-DEH-0001',
          toOrganizationId: 'ORG-DEH-0002',
          transferredAt: '2026-09-27T10:00:00.000Z',
        },
        'ORG-DEH-0002',
      );

    it('locks exclusively, moves the replica, then lifts the previous owner’s fence', async () => {
      const { consumer, calls } = harness({ existing: { organizationId: 'ORG-DEH-0001' } });

      await consumer.handle(transfer());

      expect(calls).toEqual([
        'lock:AST-SEED-0001:EXCLUSIVE',
        'upsert',
        'drop:AST-SEED-0001:ORG-DEH-0001',
        'count:AST-SEED-0001:ORG-DEH-0001',
      ]);
    });

    it('counts open work left with the previous owner and leaves it where it is (Q-74)', async () => {
      const { transferOpenWorkTotal } = await import('../observability/metrics');
      const before = (await transferOpenWorkTotal.get()).values[0]?.value ?? 0;
      const { consumer, calls } = harness({
        existing: { organizationId: 'ORG-DEH-0001' },
        openWork: { openRequests: 2, openRepairOrders: 1 },
      });

      await consumer.handle(transfer());

      const after = (await transferOpenWorkTotal.get()).values[0]?.value ?? 0;
      // Requests and repair orders both (review #127 #6).
      expect(after - before).toBe(3);
      // Nothing cancelled, nothing moved: the repository was only counted.
      expect(calls.filter((call) => !/^(lock|upsert|drop|count)/.test(call))).toEqual([]);
    });

    it.each([
      ['no toOrganizationId', { toOrganizationId: undefined }, {}],
      ['no fromOrganizationId', { fromOrganizationId: undefined }, {}],
      ['no transferredAt', { transferredAt: undefined }, {}],
      ['an unreadable transferredAt', { transferredAt: 'yesterday' }, {}],
      [
        'one organization twice',
        { toOrganizationId: 'ORG-DEH-0001' },
        { tenantId: 'ORG-DEH-0001' },
      ],
      ['an envelope tenant other than the new owner', {}, { tenantId: 'ORG-DEH-0003' }],
      ['no envelope tenant', {}, { tenantId: undefined }],
      ['an aggregate other than the asset', {}, { aggregateId: 'AST-OTHER' }],
    ])(
      'dead-letters a transfer with %s, before any marker or effect (review #127 #5)',
      async (_label, payloadOverride, envelopeOverride) => {
        const { consumer, calls, upserts } = harness({
          existing: { organizationId: 'ORG-DEH-0001' },
        });
        const base = transfer();
        const event = {
          ...base,
          ...envelopeOverride,
          payload: { ...(base.payload as object), ...payloadOverride },
        } as EventEnvelope;

        await expect(consumer.handle(event)).rejects.toMatchObject({
          name: 'UnprocessableEventError',
          reason: 'VALIDATION_FAILED',
        });
        expect(calls).toEqual([]);
        expect(upserts).toEqual([]);
      },
    );

    it('takes no lock and touches no fence for any other event', async () => {
      const { consumer, calls } = harness({ existing: { organizationId: 'ORG-DEH-0001' } });

      await consumer.handle(envelope('ASSET_DECOMMISSIONED', { assetId: 'AST-SEED-0001' }));

      expect(calls).toEqual(['upsert']);
    });
  });

  it('records a new machine from ASSET_CREATED', async () => {
    const { consumer, upserts } = harness();

    await consumer.handle(
      envelope('ASSET_CREATED', {
        assetId: 'AST-SEED-0001',
        organizationId: 'ORG-DEH-0001',
        name: 'گریدر شهرداری',
        type: 'GRADER',
        assetTag: null,
        serialNumber: null,
        status: 'REGISTERED',
      }),
    );

    expect(upserts[0]).toMatchObject({
      id: 'AST-SEED-0001',
      organizationId: 'ORG-DEH-0001',
      name: 'گریدر شهرداری',
      status: 'REGISTERED',
    });
  });

  it('takes the tenant from the envelope when the payload omits it', async () => {
    // The fleet-service bug, pinned. A `patch` key present with an
    // `undefined` value overwrote the resolved organization, and the row was
    // written with none — which then made every query for that machine return
    // nothing, silently.
    const { consumer, upserts } = harness();

    await consumer.handle(
      envelope('ASSET_CREATED', created('AST-SEED-0009', { organizationId: undefined })),
    );

    expect(upserts[0]?.organizationId).toBe('ORG-DEH-0001');
  });

  it('does not blank a name when only a status arrives', async () => {
    const { consumer, upserts } = harness({ existing: { organizationId: 'ORG-DEH-0001' } });

    await consumer.handle(
      envelope('ASSET_STATUS_CHANGED', { assetId: 'AST-SEED-0001', newStatus: 'IDLE' }),
    );

    expect(upserts[0]).toMatchObject({ status: 'IDLE' });
    expect(upserts[0]).not.toHaveProperty('name');
  });

  it('follows a machine to its new owner on transfer', async () => {
    // A replica that kept the old owner would let the previous organization
    // keep raising work against a machine it no longer has.
    const { consumer, upserts } = harness({ existing: { organizationId: 'ORG-DEH-0001' } });

    await consumer.handle(
      envelope(
        'ASSET_TRANSFERRED',
        {
          assetId: 'AST-SEED-0001',
          fromOrganizationId: 'ORG-DEH-0001',
          toOrganizationId: 'ORG-DEH-0002',
          transferredAt: '2026-09-27T10:00:00.000Z',
        },
        'ORG-DEH-0002',
      ),
    );

    expect(upserts[0]).toMatchObject({
      organizationId: 'ORG-DEH-0002',
      status: 'REGISTERED',
    });
  });

  it('marks a decommissioned machine, which then refuses new work', async () => {
    const { consumer, upserts } = harness({ existing: { organizationId: 'ORG-DEH-0001' } });

    await consumer.handle(envelope('ASSET_DECOMMISSIONED', { assetId: 'AST-SEED-0001' }));

    expect(upserts[0]?.status).toBe('DECOMMISSIONED');
  });

  it('ignores the rest of the asset topic', async () => {
    // Location updates, document attachments, inspections. Skipping them is
    // normal operation, not an error.
    const { consumer, upserts } = harness();

    for (const eventName of [
      'ASSET_LOCATION_RECORDED',
      'ASSET_DOCUMENT_ATTACHED',
      'ASSET_UPDATED',
    ]) {
      expect(await consumer.handle(envelope(eventName, { assetId: 'AST-SEED-0001' }))).toBe(
        'SKIPPED',
      );
    }

    expect(upserts).toHaveLength(0);
  });

  it('dead-letters, rather than skips, a first sighting that carries no tenant at all (L7-26)', async () => {
    // No organization to place the machine in, and guessing one would invent
    // it: a broken producer, refused at once before the marker.
    const { consumer, upserts, marks } = harness({ ledger: true });

    await expect(
      consumer.handle(envelope('ASSET_CREATED', created('AST-UNKNOWN'), null)),
    ).rejects.toMatchObject({
      name: 'UnprocessableEventError',
      reason: 'VALIDATION_FAILED',
      message: 'ASSET_CREATED evt-ASSET_CREATED carries no tenant',
    });
    expect(marks).toEqual([]);
    expect(upserts).toHaveLength(0);

    // The corrected event, replayed with the same id, is applied.
    await consumer.handle(envelope('ASSET_CREATED', created('AST-UNKNOWN')));
    expect(marks).toEqual(['evt-ASSET_CREATED']);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ id: 'AST-UNKNOWN', organizationId: 'ORG-DEH-0001' });
  });

  it('still skips an event it does not project, with no tenant (forward compatibility)', async () => {
    const { consumer, marks } = harness();

    const outcome = await consumer.handle(envelope('ASSET_LOCATION_UPDATED', {}, null));

    expect(outcome).toBe('SKIPPED');
    expect(marks).toEqual([]);
  });

  it('dead-letters, rather than skips, a consumed event that names no machine (L7-26)', async () => {
    // A producer defect no retry fixes: refused at once as VALIDATION_FAILED,
    // before the marker. The message names the field and the code, never a value.
    const { consumer, upserts, marks } = harness();

    await expect(
      consumer.handle(
        envelope(
          'ASSET_DECOMMISSIONED',
          { reason: 'SENTINEL-free-text-0012345678' },
          'ORG-DEH-0001',
        ),
      ),
    ).rejects.toMatchObject({
      name: 'UnprocessableEventError',
      reason: 'VALIDATION_FAILED',
      message:
        'ASSET_DECOMMISSIONED evt-ASSET_DECOMMISSIONED payload fails its schema: assetId invalid_type',
    });
    expect(marks).toHaveLength(0);
    expect(upserts).toHaveLength(0);
  });

  it('applies the corrected event replayed from the DLQ, once (L7-26)', async () => {
    const snapshot = jest.fn(async () => ({
      assetId: 'AST-SEED-0001',
      organizationId: 'ORG-DEH-0001',
      status: 'DECOMMISSIONED',
      name: 'لودر',
      type: 'LOADER',
      assetTag: null,
      transferGeneration: 0,
      viaTransfer: false,
    }));
    const { consumer, upserts } = harness({
      existing: { organizationId: 'ORG-DEH-0001' },
      ledger: true,
      assetSource: { snapshot } as unknown as AssetSnapshotSource,
    });
    const replay = { topic: 'rasta.asset.v1.retry', partition: 0 };

    await expect(
      consumer.handle(envelope('ASSET_DECOMMISSIONED', {}, 'ORG-DEH-0001')),
    ).rejects.toMatchObject({ reason: 'VALIDATION_FAILED' });
    const corrected = envelope(
      'ASSET_DECOMMISSIONED',
      { assetId: 'AST-SEED-0001' },
      'ORG-DEH-0001',
    );
    await consumer.handle(corrected, replay);
    await consumer.handle(corrected, replay);

    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ id: 'AST-SEED-0001', status: 'DECOMMISSIONED' });
  });

  it('applies a redelivered event only once', async () => {
    const { consumer, upserts } = harness({
      existing: { organizationId: 'ORG-DEH-0001' },
      already: true,
    });

    await consumer.handle(envelope('ASSET_ACTIVATED', { assetId: 'AST-SEED-0001' }));

    expect(upserts).toHaveLength(0);
  });

  it('leaves USAGE_RECORDED to the other consumer', () => {
    // Listed in the table as null rather than omitted, so the table stays a
    // complete answer to "what does this service consume".
    expect(PROJECTIONS.USAGE_RECORDED).toBeNull();
  });

  describe('the tenant comes from the envelope only (review #205 r1)', () => {
    const decommissioned = (organizationId?: string) => ({
      assetId: 'AST-SEED-0001',
      ...(organizationId ? { organizationId } : {}),
      reason: 'اسقاط',
      decommissionedAt: '2026-09-27T10:00:00.000Z',
    });

    it.each([
      ['no payload organization, no replica row', undefined, null],
      ['a payload organization, no replica row', 'ORG-DEH-0001', null],
      ['no payload organization, a replica row', undefined, { organizationId: 'ORG-DEH-0001' }],
      ['a payload organization, a replica row', 'ORG-DEH-0001', { organizationId: 'ORG-DEH-0001' }],
    ])(
      'dead-letters an event with no envelope tenant (%s): nothing written, no marker',
      async (_label, organizationId, existing) => {
        // Taken from the payload (or the row) and marked processed, a wrong
        // tenant could never be corrected by a replay.
        const { consumer, upserts, marks } = harness({ existing, ledger: true });

        await expect(
          consumer.handle(envelope('ASSET_DECOMMISSIONED', decommissioned(organizationId), null)),
        ).rejects.toMatchObject({
          name: 'UnprocessableEventError',
          reason: 'VALIDATION_FAILED',
          message: 'ASSET_DECOMMISSIONED evt-ASSET_DECOMMISSIONED carries no tenant',
        });
        expect(marks).toEqual([]);
        expect(upserts).toHaveLength(0);

        // The corrected event, replayed with the same id, is applied once.
        await consumer.handle(envelope('ASSET_DECOMMISSIONED', decommissioned(organizationId)));
        await consumer.handle(envelope('ASSET_DECOMMISSIONED', decommissioned(organizationId)));
        expect(upserts).toHaveLength(1);
        expect(upserts[0]).toMatchObject({
          id: 'AST-SEED-0001',
          organizationId: 'ORG-DEH-0001',
          status: 'DECOMMISSIONED',
        });
      },
    );

    it.each([
      ['no replica row', null],
      ['a replica row', { organizationId: 'ORG-DEH-0001' }],
    ])(
      'dead-letters a payload organization other than the envelope tenant (%s), naming neither',
      async (_label, existing) => {
        const { consumer, upserts, marks } = harness({ existing, ledger: true });

        const refusal = consumer.handle(
          envelope(
            'ASSET_CREATED',
            created('AST-SEED-0001', { organizationId: 'ORG-DEH-SENTINEL' }),
          ),
        );

        await expect(refusal).rejects.toMatchObject({
          reason: 'VALIDATION_FAILED',
          message:
            'ASSET_CREATED evt-ASSET_CREATED payload organization differs from its envelope ' +
            'tenant: tenant_mismatch',
        });
        await expect(refusal).rejects.not.toHaveProperty(
          'message',
          expect.stringContaining('SENTINEL'),
        );
        expect(marks).toEqual([]);
        expect(upserts).toHaveLength(0);

        await consumer.handle(envelope('ASSET_CREATED', created('AST-SEED-0001')));
        await consumer.handle(envelope('ASSET_CREATED', created('AST-SEED-0001')));
        expect(upserts).toHaveLength(1);
        expect(upserts[0]?.organizationId).toBe('ORG-DEH-0001');
      },
    );
  });

  describe("each event is held to the producer contract's fields its projection uses (review #205 r1)", () => {
    it('dead-letters ASSET_STATUS_CHANGED without newStatus, then applies the corrected replay once', async () => {
      // Accepted, the replica would keep its old status and be marked processed.
      const { consumer, upserts, marks } = harness({
        existing: { organizationId: 'ORG-DEH-0001' },
        ledger: true,
      });
      const changed = (fields: Record<string, unknown>) =>
        envelope('ASSET_STATUS_CHANGED', {
          assetId: 'AST-SEED-0001',
          organizationId: 'ORG-DEH-0001',
          previousStatus: 'ACTIVE',
          reason: 'SENTINEL-free-text',
          ...fields,
        });

      await expect(consumer.handle(changed({}))).rejects.toMatchObject({
        reason: 'VALIDATION_FAILED',
        message:
          'ASSET_STATUS_CHANGED evt-ASSET_STATUS_CHANGED payload fails its schema: newStatus invalid_type',
      });
      await expect(consumer.handle(changed({ newStatus: '' }))).rejects.toMatchObject({
        message: expect.stringMatching(/newStatus too_small$/),
      });
      expect(marks).toEqual([]);
      expect(upserts).toHaveLength(0);

      await consumer.handle(changed({ newStatus: 'OUT_OF_SERVICE' }));
      await consumer.handle(changed({ newStatus: 'OUT_OF_SERVICE' }));
      expect(upserts).toHaveLength(1);
      expect(upserts[0]?.status).toBe('OUT_OF_SERVICE');
    });

    it.each([
      ['status', { status: undefined }, 'status invalid_type'],
      ['name', { name: undefined }, 'name invalid_type'],
      ['type', { type: undefined }, 'type invalid_type'],
      ['assetTag (nullable, not optional)', { assetTag: undefined }, 'assetTag invalid_type'],
    ])('dead-letters ASSET_CREATED without %s', async (_label, override, issues) => {
      const { consumer, upserts, marks } = harness();

      await expect(
        consumer.handle(envelope('ASSET_CREATED', created('AST-SEED-0011', override))),
      ).rejects.toMatchObject({
        reason: 'VALIDATION_FAILED',
        message: `ASSET_CREATED evt-ASSET_CREATED payload fails its schema: ${issues}`,
      });
      expect(marks).toEqual([]);
      expect(upserts).toHaveLength(0);
    });
  });

  describe("an ordinary state event must come from the replica's owner (review #205 r2)", () => {
    const A = 'ORG-DEH-0001';
    const B = 'ORG-DEH-0002';
    const statusChanged = (tenant: string) =>
      envelope(
        'ASSET_STATUS_CHANGED',
        {
          assetId: 'AST-SEED-0001',
          organizationId: tenant,
          previousStatus: 'ACTIVE',
          newStatus: 'OUT_OF_SERVICE',
          reason: 'آزمون',
        },
        tenant,
      );

    it("dead-letters B's status change for A's machine: A's row unchanged, no marker; A's corrected event applies once", async () => {
      const { consumer, upserts, marks } = harness({
        existing: { organizationId: A },
        ledger: true,
      });

      await expect(consumer.handle(statusChanged(B))).rejects.toMatchObject({
        name: 'UnprocessableEventError',
        reason: 'VALIDATION_FAILED',
        message:
          'ASSET_STATUS_CHANGED evt-ASSET_STATUS_CHANGED names a tenant that does not own the asset: owner_mismatch',
      });
      expect(upserts).toHaveLength(0);
      expect(marks).toEqual([]);

      await consumer.handle(statusChanged(A));
      await consumer.handle(statusChanged(A));
      expect(upserts).toHaveLength(1);
      expect(upserts[0]).toMatchObject({
        id: 'AST-SEED-0001',
        organizationId: A,
        status: 'OUT_OF_SERVICE',
      });
    });

    it.each([
      ['ASSET_ACTIVATED', { commissionedAt: '2026-09-01T00:00:00.000Z' }],
      ['ASSET_DECOMMISSIONED', { reason: 'x', decommissionedAt: '2026-09-01T00:00:00.000Z' }],
    ])("dead-letters B's %s for A's machine, writing nothing", async (eventName, fields) => {
      const { consumer, upserts, marks } = harness({
        existing: { organizationId: A },
        ledger: true,
      });

      await expect(
        consumer.handle(
          envelope(eventName, { assetId: 'AST-SEED-0001', organizationId: B, ...fields }, B),
        ),
      ).rejects.toMatchObject({
        reason: 'VALIDATION_FAILED',
        message: expect.stringMatching(/owner_mismatch$/),
      });
      expect(upserts).toHaveLength(0);
      expect(marks).toEqual([]);
    });

    it("still moves A's machine to B on ASSET_TRANSFERRED", async () => {
      const { consumer, upserts, marks } = harness({
        existing: { organizationId: A },
        ledger: true,
      });

      await consumer.handle(
        envelope(
          'ASSET_TRANSFERRED',
          {
            assetId: 'AST-SEED-0001',
            fromOrganizationId: A,
            toOrganizationId: B,
            transferredAt: '2026-09-27T10:00:00.000Z',
            reason: 'x',
          },
          B,
        ),
      );

      expect(marks).toEqual(['evt-ASSET_TRANSFERRED']);
      expect(upserts[0]).toMatchObject({ organizationId: B, status: 'REGISTERED' });
    });
  });
});
