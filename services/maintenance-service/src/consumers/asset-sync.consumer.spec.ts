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
  options: { existing?: { organizationId: string } | null; already?: boolean } = {},
) {
  const upserts: Upsert[] = [];

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
      upserts.push(data);
    },
  } as unknown as MaintenanceRepository;

  return { consumer: new AssetSyncConsumer(null, repository), upserts };
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
      envelope('ASSET_TRANSFERRED', {
        assetId: 'AST-SEED-0001',
        fromOrganizationId: 'ORG-DEH-0001',
        toOrganizationId: 'ORG-DEH-0002',
      }),
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
