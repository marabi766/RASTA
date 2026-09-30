import type { EventEnvelope } from '@rasta/contracts';
import { AssetSyncConsumer, PROJECTIONS } from './asset-sync.consumer';
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
  } = {},
) {
  const upserts: Upsert[] = [];
  const calls: string[] = [];

  const repository = {
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn({});
    },
    async markEventProcessed(): Promise<boolean> {
      return !options.already;
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

  return { consumer: new AssetSyncConsumer(null, repository), upserts, calls };
}

function envelope(eventName: string, payload: object, tenantId?: string): EventEnvelope {
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
      envelope('ASSET_CREATED', { assetId: 'AST-SEED-0009', name: 'لودر' }, 'ORG-DEH-0001'),
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

  it('skips a first sighting that carries no tenant at all', async () => {
    const { consumer, upserts } = harness();

    const outcome = await consumer.handle(envelope('ASSET_CREATED', { assetId: 'AST-UNKNOWN' }));

    expect(outcome).toBe('SKIPPED');
    expect(upserts).toHaveLength(0);
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
});
