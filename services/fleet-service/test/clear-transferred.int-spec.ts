import type { EventEnvelope } from '@rasta/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { FleetRepository } from '../src/fleet/fleet.repository';
import { AssetSyncConsumer } from '../src/consumers/asset-sync.consumer';
import { FakePolicySource, echoing } from './policy-source.fake';
import { clearTransferredInsurance } from '../src/fleet/clear-transferred.command';
import { cleanup, id, newPrisma, tenants, producerShaped } from './helpers';

/**
 * `insurance:clear-transferred` against PostgreSQL (docs/24 Q-101, runbook
 * insurance-reprojection.md, "changing the following-coverage list"): which
 * replica rows lose their windows, that a dry run writes nothing, that nothing
 * but the windows changes, and that it is bounded and tenant-correct.
 *
 * Every run is limited to this suite's organizations: the database is shared
 * with other suites and with development data.
 */
describe('insurance:clear-transferred (Q-101)', () => {
  const org = tenants();
  const year = 365 * 86_400_000;
  const COVERAGES = ['THIRD_PARTY', 'COMPREHENSIVE', 'PASSENGER_ACCIDENT', 'LIABILITY'];
  let prisma: PrismaService;
  let repository: FleetRepository;
  let consumer: AssetSyncConsumer;
  let policies: FakePolicySource;

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    repository = new FleetRepository(prisma);
    // asset-service confirms each policy as its event states it, unless a test says otherwise.
    policies = new FakePolicySource();
    consumer = echoing(
      new AssetSyncConsumer(null, repository, undefined, undefined, undefined, policies),
      policies,
    );
    await cleanup(prisma, [org.a, org.b]);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await prisma.onModuleDestroy();
  });

  const eventFor = (
    tenantId: string,
    eventName: string,
    payload: Record<string, unknown>,
  ): EventEnvelope => ({
    eventId: id('EVT'),
    eventName,
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    producer: 'asset-service',
    producerVersion: '0.1.0',
    aggregateType: 'Asset',
    aggregateId: String(payload.assetId),
    tenantId,
    correlationId: id('COR'),
    payload: producerShaped(eventName, { organizationId: tenantId, ...payload }),
  });

  /** org.a's machine with a window for every coverage and one recorded lapse. */
  async function insured(): Promise<string> {
    const assetId = id('AST');
    await consumer.handle(eventFor(org.a, 'ASSET_CREATED', { assetId, status: 'ACTIVE' }));
    for (const coverage of COVERAGES) {
      await consumer.handle(
        eventFor(org.a, 'INSURANCE_RECORDED', {
          assetId,
          policyId: id('INS'),
          insurerName: 'بیمه ایران',
          coverage,
          validFrom: new Date(Date.now() - 1000).toISOString(),
          validTo: new Date(Date.now() + year).toISOString(),
          ownershipGeneration: 1,
        }),
      );
    }
    await consumer.handle(eventFor(org.a, 'INSURANCE_EXPIRED', { assetId, coverage: 'LIABILITY' }));
    return assetId;
  }

  const transfer = (assetId: string, extra: Record<string, unknown>) =>
    consumer.handle(
      eventFor(org.b, 'ASSET_TRANSFERRED', {
        assetId,
        fromOrganizationId: org.a,
        toOrganizationId: org.b,
        transferredAt: new Date().toISOString(),
        reason: 'واگذاری',
        ...extra,
      }),
    );

  const row = (assetId: string) => repository.findAssetRefUnscoped(assetId);
  const windows = async (assetId: string) =>
    Object.keys(((await row(assetId))!.insuranceCover ?? {}) as object).sort();
  const run = (extra: Partial<Parameters<typeof clearTransferredInsurance>[1]> = {}) =>
    clearTransferredInsurance(repository, {
      dryRun: false,
      includeUnknownGeneration: false,
      pageSize: 100,
      ...extra,
    });

  it('clears the windows of a machine transferred with a generation, and only the windows', async () => {
    const assetId = await insured();
    await transfer(assetId, { ownershipGeneration: 2, retainedCoverages: COVERAGES });
    expect(await windows(assetId)).toEqual([...COVERAGES].sort());
    const before = (await row(assetId))!;

    const report = await run({ organizationId: org.b });

    expect(report).toMatchObject({ dryRun: false, cleared: 1, skipped: 0 });
    expect(report.byOrganization).toEqual({ [org.b]: 1 });
    const after = (await row(assetId))!;
    expect(after.insuranceCover).toEqual({});
    // Nothing but the windows (and the sync stamp) changed.
    expect(after.insuranceLapsedCoverages).toEqual(before.insuranceLapsedCoverages);
    expect(after.ownershipGeneration).toBe(2);
    // The retained list goes with the windows: see the delayed-event test below.
    expect(after.retainedCoverages).toEqual([]);
    expect(after.organizationId).toBe(org.b);
    expect(after.status).toBe(before.status);

    // Nothing left to clear: a rerun is a no-op.
    await expect(run({ organizationId: org.b })).resolves.toMatchObject({ scanned: 0, cleared: 0 });
  });

  it('ignores a delayed old-owner event for a coverage that followed at transfer time, and takes the current owner’s', async () => {
    const assetId = await insured();
    // THIRD_PARTY followed the vehicle when it was transferred.
    await transfer(assetId, { ownershipGeneration: 2, retainedCoverages: ['THIRD_PARTY'] });
    expect(await windows(assetId)).toEqual(['THIRD_PARTY']);

    await run({ organizationId: org.b });
    const cleared = (await row(assetId))!;
    expect(cleared.insuranceCover).toEqual({});
    expect(cleared.retainedCoverages).toEqual([]);

    const recorded = (organizationId: string, ownershipGeneration: number) =>
      consumer.handle(
        eventFor(organizationId, 'INSURANCE_RECORDED', {
          assetId,
          policyId: id('INS'),
          insurerName: 'بیمه ایران',
          coverage: 'THIRD_PARTY',
          validFrom: new Date(Date.now() - 1000).toISOString(),
          validTo: new Date(Date.now() + year).toISOString(),
          ownershipGeneration,
        }),
      );

    // The previous owner's event, delivered late: the exemption is gone.
    await recorded(org.a, 1);
    expect(await windows(assetId)).toEqual([]);

    // The re-projection names the current owner and generation: the window is back.
    await recorded(org.b, 2);
    expect(await windows(assetId)).toEqual(['THIRD_PARTY']);
  });

  it('clears a row that has no windows left but still retains coverages', async () => {
    const assetId = id('AST');
    await consumer.handle(eventFor(org.a, 'ASSET_CREATED', { assetId, status: 'ACTIVE' }));
    await transfer(assetId, { ownershipGeneration: 2, retainedCoverages: ['THIRD_PARTY'] });
    expect((await row(assetId))!.retainedCoverages).toEqual(['THIRD_PARTY']);

    // Other tests of this suite leave rows for org.b too; this one must be among them.
    expect((await run({ organizationId: org.b })).cleared).toBeGreaterThanOrEqual(1);
    expect((await row(assetId))!.retainedCoverages).toEqual([]);
  });

  it('writes nothing in a dry run, and counts what a real run clears', async () => {
    const assetId = await insured();
    await transfer(assetId, { ownershipGeneration: 2, retainedCoverages: COVERAGES });

    const dry = await run({ organizationId: org.b, dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, cleared: 1 });
    expect(await windows(assetId)).toEqual([...COVERAGES].sort());

    await expect(run({ organizationId: org.b })).resolves.toMatchObject({ cleared: dry.cleared });
    expect(await windows(assetId)).toEqual([]);
  });

  it('leaves a machine that was never transferred, unless the unknown generation is asked for', async () => {
    const assetId = await insured();
    // Stated generation 1 by the policies, but the replica itself saw no transfer.
    expect((await row(assetId))!.ownershipGeneration).toBeNull();

    await expect(run({ organizationId: org.a })).resolves.toMatchObject({ cleared: 0 });
    expect(await windows(assetId)).toEqual([...COVERAGES].sort());

    await expect(
      run({ organizationId: org.a, includeUnknownGeneration: true }),
    ).resolves.toMatchObject({ cleared: 1, byOrganization: { [org.a]: 1 } });
    expect(await windows(assetId)).toEqual([]);
  });

  it('finds a legacy transfer (no generation) while the transfer is still the latest event, and the rest only with the flag', async () => {
    const latest = await insured();
    await transfer(latest, { retainedCoverages: COVERAGES });
    // A later event overwrites the replica's source event; with no generation
    // left there is nothing in the row that says it was ever transferred.
    const activated = await insured();
    await transfer(activated, { retainedCoverages: COVERAGES });
    await consumer.handle(eventFor(org.b, 'ASSET_ACTIVATED', { assetId: activated }));

    await expect(run({ organizationId: org.b })).resolves.toMatchObject({ cleared: 1 });
    expect(await windows(latest)).toEqual([]);
    expect(await windows(activated)).toEqual([...COVERAGES].sort());

    await expect(
      run({ organizationId: org.b, includeUnknownGeneration: true }),
    ).resolves.toMatchObject({ cleared: 1 });
    expect(await windows(activated)).toEqual([]);
  });

  it('is limited to the organization that owns the machine now', async () => {
    const mine = await insured();
    await transfer(mine, { ownershipGeneration: 2, retainedCoverages: COVERAGES });
    const theirs = await insured();
    await consumer.handle(
      eventFor(org.a, 'ASSET_TRANSFERRED', {
        assetId: theirs,
        fromOrganizationId: org.b,
        toOrganizationId: org.a,
        transferredAt: new Date().toISOString(),
        reason: 'واگذاری',
        ownershipGeneration: 2,
        retainedCoverages: COVERAGES,
      }),
    );
    expect((await row(theirs))!.organizationId).toBe(org.a);

    const report = await run({ organizationId: org.b });

    expect(report.byOrganization).toEqual({ [org.b]: 1 });
    expect(await windows(mine)).toEqual([]);
    expect(await windows(theirs)).toEqual([...COVERAGES].sort());
    // Not another tenant's row, whatever the filter: only org.b's was named.
    await expect(run({ organizationId: org.a })).resolves.toMatchObject({
      byOrganization: { [org.a]: 1 },
    });
  });

  it('works through the rows in bounded pages', async () => {
    const assetIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const assetId = await insured();
      await transfer(assetId, { ownershipGeneration: 2, retainedCoverages: COVERAGES });
      assetIds.push(assetId);
    }

    const report = await run({ organizationId: org.b, pageSize: 2 });

    expect(report.cleared).toBe(5);
    for (const assetId of assetIds) expect(await windows(assetId)).toEqual([]);
  });

  it('refuses a page size outside 1 to 500', async () => {
    await expect(run({ pageSize: 0 })).rejects.toThrow(/pageSize/);
    await expect(run({ pageSize: 501 })).rejects.toThrow(/pageSize/);
  });
});
