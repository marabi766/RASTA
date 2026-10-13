import type { EventEnvelope } from '@rasta/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { FleetRepository } from '../src/fleet/fleet.repository';
import { AssetSyncConsumer, CONSUMER_NAME } from '../src/consumers/asset-sync.consumer';
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
    policies.replica = (assetId) => repository.findAssetRefUnscoped(assetId);
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

    // Nothing left to clear: a rerun changes no value, but still moves the
    // invalidation epoch (r11) — and nothing else.
    const emptied = (await row(assetId))!;
    await expect(run({ organizationId: org.b })).resolves.toMatchObject({
      scanned: 1,
      cleared: 0,
      invalidated: 1,
      byOrganization: {},
    });
    const rerun = (await row(assetId))!;
    expect(rerun.insuranceEpoch).toBe(emptied.insuranceEpoch + 1n);
    expect(rerun.insuranceRevision).toBe(emptied.insuranceRevision);
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

    const recorded = (organizationId: string, ownershipGeneration: number, olderTenure = false) => {
      const policyId = id('INS');
      // r7: the previous tenure's policy is one asset-service denies under the current rule.
      if (olderTenure) policies.deny(policyId, 'NOT_FOLLOWING_VEHICLE');
      return consumer.handle(
        eventFor(organizationId, 'INSURANCE_RECORDED', {
          assetId,
          policyId,
          insurerName: 'بیمه ایران',
          coverage: 'THIRD_PARTY',
          validFrom: new Date(Date.now() - 1000).toISOString(),
          validTo: new Date(Date.now() + year).toISOString(),
          ownershipGeneration,
        }),
      );
    };

    // The previous owner's event, delivered late: the source denies it.
    await recorded(org.a, 1, true);
    expect(await windows(assetId)).toEqual([]);

    // The re-projection names the current owner and generation: the window is back.
    await recorded(org.b, 2);
    expect(await windows(assetId)).toEqual(['THIRD_PARTY']);
  });

  it('r10: a live verification paused across the clear restores nothing; its retry asks again', async () => {
    const assetId = await insured();
    // THIRD_PARTY followed the vehicle when it was transferred.
    await transfer(assetId, { ownershipGeneration: 2, retainedCoverages: ['THIRD_PARTY'] });
    expect(await windows(assetId)).toEqual(['THIRD_PARTY']);

    // A delayed event of the previous owner for THIRD_PARTY: under the rule of
    // the moment it follows the vehicle, so the source counts it for org.b.
    const policyId = id('INS');
    const validFrom = new Date(Date.now() - 1000).toISOString();
    const validTo = new Date(Date.now() + year).toISOString();
    policies.set(policyId, {
      counts: true,
      organizationId: org.b,
      coverage: 'THIRD_PARTY',
      validFrom,
      validUntil: validTo,
      ownershipGeneration: 2,
    });
    const event = eventFor(org.a, 'INSURANCE_RECORDED', {
      assetId,
      policyId,
      insurerName: 'بیمه ایران',
      coverage: 'THIRD_PARTY',
      validFrom,
      validTo,
      ownershipGeneration: 1,
    });

    // The answer is held while the rule is narrowed and the windows cleared. No
    // lock is held while asking, so the clear does not wait for it.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const asking = new Promise<void>((resolve) => (reached = resolve));
    const verify = policies.verify.bind(policies);
    const paused = jest.spyOn(policies, 'verify').mockImplementationOnce(async (...args) => {
      const answer = await verify(...args);
      reached();
      await held;
      return answer;
    });
    const delivery = consumer.handle(event);
    await asking;
    await expect(run({ organizationId: org.b })).resolves.toMatchObject({
      cleared: expect.any(Number),
    });
    expect(await windows(assetId)).toEqual([]);
    release();

    // The answer was about a replica that no longer stands: the delivery fails
    // with its marker rolled back, and nothing is restored.
    await expect(delivery).rejects.toThrow(/changed while asset-service was asked/);
    paused.mockRestore();
    expect(await windows(assetId)).toEqual([]);
    const marked = () =>
      prisma.client.processedEvent.count({
        where: { eventId: event.eventId, consumerName: CONSUMER_NAME },
      });
    expect(await marked()).toBe(0);

    // The retry asks again, under the narrowed rule: ignored, as processed.
    policies.deny(policyId, 'NOT_FOLLOWING_VEHICLE');
    await consumer.handle(event);
    expect(await windows(assetId)).toEqual([]);
    expect(await marked()).toBe(1);
  });

  it('r11: a held answer for a transferred machine with nothing to clear restores nothing', async () => {
    // Transferred with nothing following the vehicle: no window, no retained
    // coverage. The clear has no value to change, so the revision cannot move.
    const assetId = id('AST');
    await consumer.handle(eventFor(org.a, 'ASSET_CREATED', { assetId, status: 'ACTIVE' }));
    await transfer(assetId, { ownershipGeneration: 2, retainedCoverages: [] });
    const before = (await row(assetId))!;
    expect(before.insuranceCover).toEqual({});
    expect(before.retainedCoverages).toEqual([]);

    // A delayed event of the previous owner, which the rule of the moment lets
    // follow the vehicle: the source counts it for org.b.
    const policyId = id('INS');
    const validFrom = new Date(Date.now() - 1000).toISOString();
    const validTo = new Date(Date.now() + year).toISOString();
    policies.set(policyId, {
      counts: true,
      organizationId: org.b,
      coverage: 'THIRD_PARTY',
      validFrom,
      validUntil: validTo,
      ownershipGeneration: 2,
    });
    const event = eventFor(org.a, 'INSURANCE_RECORDED', {
      assetId,
      policyId,
      insurerName: 'بیمه ایران',
      coverage: 'THIRD_PARTY',
      validFrom,
      validTo,
      ownershipGeneration: 1,
    });

    // The old rule's answer is held while the rule is narrowed and the clear runs.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const asking = new Promise<void>((resolve) => (reached = resolve));
    const verify = policies.verify.bind(policies);
    const paused = jest.spyOn(policies, 'verify').mockImplementationOnce(async (...args) => {
      const answer = await verify(...args);
      reached();
      await held;
      return answer;
    });
    const delivery = consumer.handle(event);
    await asking;
    const report = await run({ organizationId: org.b });
    expect(report.invalidated).toBeGreaterThanOrEqual(1);
    const after = (await row(assetId))!;
    // Only the epoch says the row was cleared.
    expect(after.insuranceRevision).toBe(before.insuranceRevision);
    expect(after.insuranceEpoch).toBe(before.insuranceEpoch + 1n);
    release();

    // The held answer is discarded: no window, the marker rolled back.
    await expect(delivery).rejects.toThrow(/changed while asset-service was asked/);
    paused.mockRestore();
    expect(await windows(assetId)).toEqual([]);
    const marked = () =>
      prisma.client.processedEvent.count({
        where: { eventId: event.eventId, consumerName: CONSUMER_NAME },
      });
    expect(await marked()).toBe(0);

    // The retry asks again, under the narrowed rule: nothing applied.
    policies.deny(policyId, 'NOT_FOLLOWING_VEHICLE');
    await consumer.handle(event);
    expect(await windows(assetId)).toEqual([]);
    expect(await marked()).toBe(1);
  });

  it('every write to the insurance state moves the revision; other writes do not', async () => {
    const assetId = await insured();
    const revision = async () => (await row(assetId))!.insuranceRevision;
    const before = await revision();

    // A status change touches nothing an insurance answer depends on.
    await consumer.handle(
      eventFor(org.a, 'ASSET_STATUS_CHANGED', {
        assetId,
        oldStatus: 'ACTIVE',
        newStatus: 'IN_MAINTENANCE',
      }),
    );
    expect(await revision()).toBe(before);

    // A transfer, then the clear.
    await transfer(assetId, { ownershipGeneration: 2, retainedCoverages: COVERAGES });
    const transferred = await revision();
    expect(transferred).toBeGreaterThan(before);
    await run({ organizationId: org.b });
    expect(await revision()).toBeGreaterThan(transferred);

    // Not writable directly: the trigger keeps it.
    const kept = await revision();
    await prisma.client
      .$executeRaw`UPDATE asset_ref SET insurance_revision = 0 WHERE id = ${assetId}`;
    expect(await revision()).toBe(kept);
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

  // Last: its org.a rows would change the counts the tests above expect.
  it('r11: the epoch moves for exactly the rows a run targets, empty ones included', async () => {
    const never = await insured();
    const transferred = await insured();
    await consumer.handle(
      eventFor(org.a, 'ASSET_TRANSFERRED', {
        assetId: transferred,
        fromOrganizationId: org.b,
        toOrganizationId: org.a,
        transferredAt: new Date().toISOString(),
        reason: 'واگذاری',
        ownershipGeneration: 2,
        retainedCoverages: [],
      }),
    );
    // Nothing followed the vehicle: nothing left to clear.
    expect(await windows(transferred)).toEqual([]);
    const epoch = async (assetId: string) => (await row(assetId))!.insuranceEpoch;
    const neverBefore = await epoch(never);
    const transferredBefore = await epoch(transferred);

    // Another organization's run, and a dry run, move nothing.
    await run({ organizationId: org.b });
    const dry = await run({ organizationId: org.a, dryRun: true });
    expect(dry.invalidated).toBeGreaterThanOrEqual(1);
    expect(await epoch(never)).toBe(neverBefore);
    expect(await epoch(transferred)).toBe(transferredBefore);

    // The organization's run: the transferred machine, empty as it is.
    await run({ organizationId: org.a });
    expect(await epoch(transferred)).toBe(transferredBefore + 1n);
    expect(await epoch(never)).toBe(neverBefore);

    // With the unknown generation asked for, the never-transferred one too.
    await run({ organizationId: org.a, includeUnknownGeneration: true });
    expect(await epoch(never)).toBe(neverBefore + 1n);
    expect(await epoch(transferred)).toBe(transferredBefore + 2n);
  });

  it('refuses a page size outside 1 to 500', async () => {
    await expect(run({ pageSize: 0 })).rejects.toThrow(/pageSize/);
    await expect(run({ pageSize: 501 })).rejects.toThrow(/pageSize/);
  });
});
