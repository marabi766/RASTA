import type { EventEnvelope } from '@rasta/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { FleetRepository } from '../src/fleet/fleet.repository';
import { AssignmentService } from '../src/fleet/assignment.service';
import { AssetSyncConsumer } from '../src/consumers/asset-sync.consumer';
import { clearTransferredInsurance } from '../src/fleet/clear-transferred.command';
import { FakePolicySource } from './policy-source.fake';
import { asActor, cleanup, id, newPrisma, producerShaped, tenants } from './helpers';

/**
 * #240 r15, against PostgreSQL: the FIRST rollout of the ownership-generation
 * migration (`20261008230000`), which leaves every existing replica row with
 * `ownership_generation` NULL.
 *
 * Codex r14: machine X went A→B→A before the column existed, and the replica
 * still holds A's FIRST-tenure COMPREHENSIVE window, in force and with no
 * generation. `insurance:reproject` rightly sends nothing for that policy (it
 * does not count for A's current tenure), nothing refreshes the row, and before
 * r15 the assignment trusted the cached window: A was dispatched on an obsolete
 * policy. Now a row whose generation is unknown counts no window until
 * asset-service initialises it, and the runbook's first-rollout steps (fence,
 * `clear-transferred --include-unknown-generation`, `reproject --reissue`)
 * restore the valid ones.
 *
 * asset-service is the fake policy source below, answering as the real route
 * does; the re-projected events are the ones its command writes (one per
 * counting policy, for the current owner, with its generation).
 */
describe('first rollout of the ownership generation (#240 r15)', () => {
  const org = tenants();
  const A = org.a;
  const year = 365 * 86_400_000;

  let prisma: PrismaService;
  let repository: FleetRepository;
  let policies: FakePolicySource;
  let consumer: AssetSyncConsumer;
  /** Comprehensive cover required, so one policy decides dispatch. */
  let comprehensive: AssignmentService;

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    repository = new FleetRepository(prisma);
    policies = new FakePolicySource();
    consumer = new AssetSyncConsumer(null, repository, undefined, undefined, undefined, policies);
    comprehensive = new AssignmentService(repository, {
      blockingCoverages: ['COMPREHENSIVE'],
      requiredCoverages: ['COMPREHENSIVE'],
    });
    await cleanup(prisma, [org.a, org.b]);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await prisma.onModuleDestroy();
  });

  const event = (eventName: string, payload: Record<string, unknown>): EventEnvelope => ({
    eventId: id('EVT'),
    eventName,
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    producer: 'asset-service',
    producerVersion: '0.1.0',
    aggregateType: 'Asset',
    aggregateId: String(payload.assetId),
    tenantId: A,
    correlationId: id('COR'),
    payload: producerShaped(eventName, { organizationId: A, ...payload }),
  });

  // One validity for every policy here: in force for the whole suite.
  const validFrom = new Date(Date.now() - year).toISOString();
  const validTo = new Date(Date.now() + year).toISOString();
  const window = (policyId: string) => ({ policyId, validFrom, validTo });

  /**
   * A machine of A as the old code left it and the migration found it: windows
   * with no generation, nothing retained, and the generation column NULL.
   */
  async function migrated(cover: Record<string, unknown>): Promise<string> {
    const assetId = id('AST');
    await consumer.handle(event('ASSET_CREATED', { assetId, status: 'ACTIVE' }));
    await prisma.client.$executeRawUnsafe(
      `UPDATE asset_ref
          SET ownership_generation = NULL, retained_coverages = ARRAY[]::text[],
              insurance_cover = $2::jsonb, status = 'ACTIVE'
        WHERE id = $1`,
      assetId,
      JSON.stringify(cover),
    );
    expect(await repository.findAssetRefUnscoped(assetId)).toMatchObject({
      organizationId: A,
      ownershipGeneration: null,
      insuranceCover: cover,
    });
    return assetId;
  }

  /** A COMPREHENSIVE policy asset-service counts for A at `generation`. */
  function counting(policyId: string, generation: number): void {
    const w = window(policyId);
    policies.set(policyId, {
      counts: true,
      organizationId: A,
      coverage: 'COMPREHENSIVE',
      validFrom: w.validFrom,
      validUntil: w.validTo,
      ownershipGeneration: generation,
    });
  }

  /**
   * The INSURANCE_RECORDED `insurance:reproject` writes for a counting policy;
   * `run` stands for the id part a `--reissue` run adds.
   */
  const reprojected = (assetId: string, policyId: string, generation: number, run: string) => {
    const w = window(policyId);
    return {
      ...event('INSURANCE_RECORDED', {
        assetId,
        policyId,
        insurerName: 'بیمه ایران',
        coverage: 'COMPREHENSIVE',
        validFrom: w.validFrom,
        validTo: w.validTo,
        ownershipGeneration: generation,
      }),
      eventId: `EVT-REPROJECT-${policyId}-${run}`,
    } as EventEnvelope;
  };

  async function assign(assetId: string) {
    const driverId = id('DRV');
    await asActor({ organizationId: A }, () =>
      prisma.client.driver.create({
        data: {
          organizationId: A,
          id: driverId,
          userId: `USR-${driverId}`,
          createdBy: 'ITEST',
          updatedBy: 'ITEST',
        },
      }),
    );
    return asActor({ organizationId: A }, () => comprehensive.create({ driverId, assetId }));
  }

  /** The ordinary insurance refusal, naming the required coverage. */
  const uninsured = {
    code: 'BUSINESS_RULE_VIOLATION',
    message: expect.stringContaining('withdrawn from dispatch'),
    internalContext: expect.objectContaining({
      rule: 'ASSET_DISPATCH_BLOCKED',
      detail: 'The insurance policy has expired (COMPREHENSIVE)',
    }),
  };

  const row = (assetId: string) => repository.findAssetRefUnscoped(assetId);

  it('refuses the obsolete first-tenure window with no refresh at all; after the sanitize step and a reissue, the current-tenure policy dispatches', async () => {
    // X: A→B→A before the column existed; A's first-tenure policy is still in
    // the replica. asset-service no longer counts it for A (generation 2).
    const firstTenure = id('INS');
    policies.deny(firstTenure, 'NOT_CURRENT_TENURE');
    const x = await migrated({ COMPREHENSIVE: [window(firstTenure)] });
    // N: never transferred (generation 0); its legacy policy still counts.
    const nPolicy = id('INS');
    counting(nPolicy, 0);
    const n = await migrated({ COMPREHENSIVE: [window(nPolicy)] });
    // U: no policy at all at asset-service, a stale window in the replica.
    const u = await migrated({ COMPREHENSIVE: [window(id('INS'))] });

    // 1. The re-projection alone (the pre-r15 runbook). It sends nothing for X
    //    or U, and N's policy, which the source confirms at generation 0.
    await consumer.handle(reprojected(n, nPolicy, 0, 'run-1'));

    // 2. No refresh for X: its generation is still unknown and the old window
    //    still in the row — and it no longer counts. Refused, the normal way.
    expect(await row(x)).toMatchObject({
      ownershipGeneration: null,
      insuranceCover: { COMPREHENSIVE: [window(firstTenure)] },
    });
    await expect(assign(x)).rejects.toMatchObject(uninsured);
    await expect(assign(u)).rejects.toMatchObject(uninsured);
    // N was initialised by asset-service's answer (generation 0: one tenure).
    expect(await row(n)).toMatchObject({ ownershipGeneration: 0 });
    expect((await assign(n)).assetId).toBe(n);

    // 3. A records its current-tenure policy at asset-service (generation 2).
    const current = id('INS');
    counting(current, 2);

    // 4. The sanitize step, under the fence: every row with an unknown
    //    generation loses its windows and moves its epoch. The generation stays
    //    unknown; N, now known and never transferred, is not touched.
    const before = { x: (await row(x))!, n: (await row(n))!, u: (await row(u))! };
    const report = await clearTransferredInsurance(repository, {
      dryRun: false,
      includeUnknownGeneration: true,
      pageSize: 100,
      organizationId: A,
    });
    expect(report).toMatchObject({ cleared: 2, invalidated: 2 });
    for (const assetId of [x, u]) {
      const sanitized = (await row(assetId))!;
      expect(sanitized.insuranceCover).toEqual({});
      expect(sanitized.retainedCoverages).toEqual([]);
      expect(sanitized.ownershipGeneration).toBeNull();
    }
    expect((await row(x))!.insuranceEpoch).toBe(before.x.insuranceEpoch + 1n);
    expect((await row(u))!.insuranceEpoch).toBe(before.u.insuranceEpoch + 1n);
    expect(await row(n)).toMatchObject({
      insuranceCover: before.n.insuranceCover,
      insuranceEpoch: before.n.insuranceEpoch,
    });
    await expect(assign(x)).rejects.toMatchObject(uninsured);

    // 5. asset-service up, `insurance:reproject --reissue`: every counting
    //    policy again, under new ids. X's current policy initialises X at
    //    generation 2 and is its only window; N's is applied again.
    await consumer.handle(reprojected(x, current, 2, 'reissue-1'));
    await consumer.handle(reprojected(n, nPolicy, 0, 'reissue-1'));

    const initialised = (await row(x))!;
    expect(initialised.ownershipGeneration).toBe(2);
    expect(initialised.insuranceCover).toEqual({
      COMPREHENSIVE: [{ ...window(current), generation: 2 }],
    });
    expect((await assign(x)).assetId).toBe(x);
    // N (assigned in step 2) keeps its generation and its one policy.
    expect(await row(n)).toMatchObject({
      ownershipGeneration: 0,
      insuranceCover: { COMPREHENSIVE: [{ ...window(nPolicy), generation: 0 }] },
    });
    // U has no policy to send: unknown and refused, as an uninsured machine is.
    expect(await row(u)).toMatchObject({ ownershipGeneration: null, insuranceCover: {} });
    await expect(assign(u)).rejects.toMatchObject(uninsured);
  });

  it('without the sanitize step, a reissued current policy alone still initialises the row and drops the first-tenure window', async () => {
    const firstTenure = id('INS');
    policies.deny(firstTenure, 'NOT_CURRENT_TENURE');
    const x = await migrated({ COMPREHENSIVE: [window(firstTenure)] });
    await expect(assign(x)).rejects.toMatchObject(uninsured);

    const current = id('INS');
    counting(current, 2);
    await consumer.handle(reprojected(x, current, 2, 'reissue-2'));

    expect(await row(x)).toMatchObject({ ownershipGeneration: 2, retainedCoverages: [] });
    expect((await row(x))!.insuranceCover).toEqual({
      COMPREHENSIVE: [{ ...window(current), generation: 2 }],
    });
    expect((await assign(x)).assetId).toBe(x);
  });
});
