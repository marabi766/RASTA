import type { EventEnvelope } from '@rasta/contracts';
import { OutboxRelay, RastaError, runUnscoped, type OutboxRow } from '@rasta/nest-common';
import { PrismaService } from '../src/prisma/prisma.service';
import { FleetRepository } from '../src/fleet/fleet.repository';
import { AssignmentService } from '../src/fleet/assignment.service';
import {
  AssetSyncConsumer,
  CONSUMER_NAME,
  type ParkingOptions,
} from '../src/consumers/asset-sync.consumer';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import { clearTransferredInsurance } from '../src/fleet/clear-transferred.command';
import { InMemoryEventPublisher } from '../src/outbox/kafka.publisher';
import { FakePolicySource } from './policy-source.fake';
import { asActor, cleanup, id, newPrisma, producerShaped, tenants } from './helpers';

/**
 * #240 r8, against PostgreSQL: an `INSURANCE_RECORDED` that reaches fleet after
 * asset-service transferred the machine, but before fleet consumed the
 * transfer, is parked — not retried into the DLQ — and applied once the
 * transfer is projected: the transfer makes it due (r10) and the sweep
 * re-verifies it, as it does what is left, and dead-letters a row whose
 * attempts run out. Never applied unverified.
 *
 * Real database: the parked row commits with the delivery's marker, is made due
 * by the transfer's handler and decided under the asset lock by the sweep, and
 * is tenant data the guard scopes.
 */
describe('parked INSURANCE_RECORDED (#240 r8)', () => {
  const org = tenants();
  let prisma: PrismaService;
  let repository: FleetRepository;
  let policies: FakePolicySource;
  let consumer: AssetSyncConsumer;
  /** The real outbox relay, publishing to memory instead of Kafka. */
  let relay: OutboxRelay;
  let publisher: InMemoryEventPublisher;
  /** Only comprehensive cover is required, so one policy makes a machine dispatchable. */
  let comprehensive: AssignmentService;

  const PARKING: ParkingOptions = {
    minAgeSeconds: 30,
    maxAttempts: 2,
    sweepIntervalMs: 60_000,
    batchSize: 1_000,
  };

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    repository = new FleetRepository(prisma);
    policies = new FakePolicySource();
    consumer = new AssetSyncConsumer(
      null,
      repository,
      undefined,
      undefined,
      undefined,
      policies,
      PARKING,
    );
    comprehensive = new AssignmentService(repository, {
      blockingCoverages: ['COMPREHENSIVE'],
      requiredCoverages: ['COMPREHENSIVE'],
    });
    publisher = new InMemoryEventPublisher();
    relay = new OutboxRelay({ store: new PrismaOutboxStore(prisma), publisher });
    await cleanup(prisma, [org.a, org.b]);
  });

  beforeEach(() => {
    policies.unreachable(false);
    publisher.clear();
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await prisma.onModuleDestroy();
  });

  const year = 365 * 86_400_000;

  const eventFor = (
    tenant: string,
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
    tenantId: tenant,
    correlationId: id('COR'),
    payload: producerShaped(eventName, { organizationId: tenant, ...payload }),
  });

  /** org.a's machine, in service, never transferred in the replica. */
  async function machineOfA(): Promise<string> {
    const assetId = id('AST');
    await consumer.handle(
      eventFor(org.a, 'ASSET_CREATED', { assetId, status: 'ACTIVE', name: 'لودر' }),
    );
    return assetId;
  }

  /**
   * The new owner's policy, recorded at asset-service after the transfer there:
   * the source counts it for org.b at generation 1, and is asked as org.a while
   * the replica still shows org.a.
   */
  function newOwnersPolicy(assetId: string): { policyId: string; envelope: EventEnvelope } {
    const policyId = id('INS');
    const validFrom = new Date(Date.now() - 1000).toISOString();
    const validTo = new Date(Date.now() + year).toISOString();
    policies.set(policyId, {
      counts: true,
      organizationId: org.b,
      coverage: 'COMPREHENSIVE',
      validFrom,
      validUntil: validTo,
      ownershipGeneration: 1,
    });
    return {
      policyId,
      envelope: eventFor(org.b, 'INSURANCE_RECORDED', {
        assetId,
        policyId,
        insurerName: 'بیمه ایران',
        coverage: 'COMPREHENSIVE',
        validFrom,
        validTo,
        ownershipGeneration: 1,
      }),
    };
  }

  const transferToB = (assetId: string) =>
    consumer.handle(
      eventFor(org.b, 'ASSET_TRANSFERRED', {
        assetId,
        fromOrganizationId: org.a,
        toOrganizationId: org.b,
        transferredAt: new Date().toISOString(),
        reason: 'واگذاری',
        ownershipGeneration: 1,
        retainedCoverages: [],
      }),
    );

  const activateForB = (assetId: string) =>
    consumer.handle(eventFor(org.b, 'ASSET_ACTIVATED', { assetId }));

  async function driverOfB(): Promise<string> {
    const driverId = id('DRV');
    await asActor({ organizationId: org.b }, () =>
      prisma.client.driver.create({
        data: {
          organizationId: org.b,
          id: driverId,
          userId: `USR-${driverId}`,
          createdBy: 'ITEST',
          updatedBy: 'ITEST',
        },
      }),
    );
    return driverId;
  }

  const parked = (eventId: string) =>
    runUnscoped('test reads the parked table across tenants', () =>
      prisma.client.insurancePendingVerification.findFirst({ where: { eventId } }),
    );

  const marked = async (eventId: string): Promise<boolean> =>
    (await prisma.client.processedEvent.count({
      where: { eventId, consumerName: CONSUMER_NAME },
    })) === 1;

  /** The dead letters of an event waiting in the outbox, or published. */
  const deadLetterRows = (eventId: string) =>
    prisma.client.outboxMessage.findMany({
      where: { topic: 'rasta.fleet.v1.dlq', headers: { path: ['x-event-id'], equals: eventId } },
    });

  /** Runs the relay until the outbox is drained; what it published for `eventId` to the DLQ. */
  async function relayDeadLetters(eventId: string): Promise<OutboxRow[]> {
    let ticks = 0;
    while (ticks < 50 && (await relay.tick()) > 0) ticks += 1;
    return publisher.published.filter(
      (row) => row.topic === 'rasta.fleet.v1.dlq' && row.headers['x-event-id'] === eventId,
    );
  }

  /** Makes a parked row, and its last attempt, an hour old by the database's clock. */
  const age = (eventId: string) =>
    prisma.client.$executeRaw`
      UPDATE insurance_pending_verification
         SET first_seen_at = now() - interval '1 hour',
             last_attempt_at = CASE WHEN last_attempt_at IS NULL THEN NULL
                                    ELSE now() - interval '1 hour' END
       WHERE event_id = ${eventId}`;

  it('policy before transfer: parked with its marker, applied by the sweep once the transfer is consumed, dispatch allowed', async () => {
    const assetId = await machineOfA();
    const driverId = await driverOfB();
    const { policyId, envelope } = newOwnersPolicy(assetId);

    // Consumed before the transfer: the source answers for org.b, the replica
    // shows org.a. Acknowledged (no throw: no retry, no DLQ), not applied.
    await consumer.handle(envelope, {
      topic: 'rasta.insurance.v1',
      partition: 0,
      key: assetId,
      offset: '12',
    });

    expect(await marked(envelope.eventId)).toBe(true);
    expect(await parked(envelope.eventId)).toMatchObject({
      assetId,
      organizationId: org.b,
      reason: 'NOT_CURRENT_OWNER',
      messageKey: assetId,
      sourceTopic: 'rasta.insurance.v1',
      sourcePartition: 0,
      sourceOffset: '12',
      attempts: 0,
    });
    expect((await repository.findAssetRefUnscoped(assetId))!.insuranceCover).toEqual({});

    await transferToB(assetId);
    await activateForB(assetId);
    await consumer.sweepParked();

    expect(await parked(envelope.eventId)).toBeNull();
    const row = await repository.findAssetRefUnscoped(assetId);
    expect(row!.organizationId).toBe(org.b);
    expect(row!.insuranceCover).toMatchObject({
      COMPREHENSIVE: [{ policyId, generation: 1 }],
    });
    expect(policies.asked.at(-1)).toEqual({ organizationId: org.b, assetId, policyId });

    const created = await asActor({ organizationId: org.b }, () =>
      comprehensive.create({ driverId, assetId }),
    );
    expect(created.assetId).toBe(assetId);
  });

  it('a parked policy that does not count once the transfer is consumed: removed, nothing applied', async () => {
    const assetId = await machineOfA();
    const driverId = await driverOfB();
    const { policyId, envelope } = newOwnersPolicy(assetId);
    await consumer.handle(envelope);
    expect(await parked(envelope.eventId)).not.toBeNull();

    policies.deny(policyId, 'NOT_ACTIVE');
    await transferToB(assetId);
    await activateForB(assetId);
    await consumer.sweepParked();

    expect(await parked(envelope.eventId)).toBeNull();
    expect((await repository.findAssetRefUnscoped(assetId))!.insuranceCover).toEqual({});
    await expect(
      asActor({ organizationId: org.b }, () => comprehensive.create({ driverId, assetId })),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
  });

  it('the sweep: tries at once a row the transfer made due; one it could not decide waits for its age', async () => {
    const assetId = await machineOfA();
    const { policyId, envelope } = newOwnersPolicy(assetId);
    await consumer.handle(envelope);

    // Parked a moment ago: not due, untouched by the sweep.
    await consumer.sweepParked();
    expect(await parked(envelope.eventId)).toMatchObject({ attempts: 0, nextAttemptAt: null });

    // The transfer asks nobody; it makes the row due.
    await transferToB(assetId);
    expect((await repository.findAssetRefUnscoped(assetId))!.organizationId).toBe(org.b);
    expect(await parked(envelope.eventId)).toMatchObject({
      attempts: 0,
      nextAttemptAt: expect.any(Date),
    });

    // asset-service down when the sweep tries it: one attempt counted, the mark spent.
    policies.unreachable();
    await consumer.sweepParked();
    expect(await parked(envelope.eventId)).toMatchObject({
      attempts: 1,
      reason: 'NO_ANSWER',
      nextAttemptAt: null,
    });
    policies.unreachable(false);

    // Just tried: not due, untouched by the sweep.
    await consumer.sweepParked();
    expect(await parked(envelope.eventId)).toMatchObject({ attempts: 1 });

    await age(envelope.eventId);
    await consumer.sweepParked();

    expect(await parked(envelope.eventId)).toBeNull();
    expect((await repository.findAssetRefUnscoped(assetId))!.insuranceCover).toMatchObject({
      COMPREHENSIVE: [{ policyId, generation: 1 }],
    });
  });

  it('the sweep dead-letters through the outbox: a rollback publishes nothing and keeps the row and marker; a commit is published by the relay and its replay applied', async () => {
    const assetId = await machineOfA();
    const { policyId, envelope } = newOwnersPolicy(assetId);
    await consumer.handle(envelope, {
      topic: 'rasta.insurance.v1',
      partition: 3,
      key: assetId,
      offset: '40',
    });

    // The transfer never arrives. Attempt 1: still NOT_CURRENT_OWNER, kept.
    await age(envelope.eventId);
    await consumer.sweepParked();
    expect(await parked(envelope.eventId)).toMatchObject({ attempts: 1 });
    expect(await deadLetterRows(envelope.eventId)).toHaveLength(0);

    // Attempt 2 reaches the maximum. The transaction dies after the dead letter
    // was enqueued (a lost connection, an expired transaction): all of it rolls
    // back — no dead letter to publish, the row and the marker stay.
    await age(envelope.eventId);
    const crash = jest
      .spyOn(repository, 'unmarkEventProcessed')
      .mockRejectedValueOnce(new Error('connection lost'));
    expect(await consumer.sweepParked()).toMatchObject({ DEAD_LETTERED: 0 });
    expect(crash).toHaveBeenCalledTimes(1);
    crash.mockRestore();
    expect(await parked(envelope.eventId)).toMatchObject({ attempts: 1 });
    expect(await marked(envelope.eventId)).toBe(true);
    expect(await deadLetterRows(envelope.eventId)).toHaveLength(0);
    expect(await relayDeadLetters(envelope.eventId)).toHaveLength(0);

    // Committed: the row and the marker are gone with the dead letter enqueued.
    expect(await consumer.sweepParked()).toMatchObject({ DEAD_LETTERED: 1 });
    expect(await parked(envelope.eventId)).toBeNull();
    expect(await marked(envelope.eventId)).toBe(false);
    expect(await deadLetterRows(envelope.eventId)).toMatchObject([
      { organizationId: org.b, publishedAt: null },
    ]);
    expect((await repository.findAssetRefUnscoped(assetId))!.insuranceCover).toEqual({});

    // The relay publishes it, as the original was published.
    const published = await relayDeadLetters(envelope.eventId);
    expect(published).toHaveLength(1);
    const letter = published[0]!;
    expect(letter.partitionKey).toBe(assetId);
    expect(letter.headers).toMatchObject({
      'x-event-id': envelope.eventId,
      'x-event-name': 'INSURANCE_RECORDED',
      'x-tenant-id': org.b,
      'x-dlq-reason': 'PARKED_VERIFICATION_EXHAUSTED',
      'x-dlq-original-topic': 'rasta.insurance.v1',
      'x-dlq-original-partition': '3',
      'x-dlq-original-offset': '40',
      'x-dlq-attempts': '2',
    });
    const body = JSON.parse(JSON.stringify(letter.payload)) as EventEnvelope;
    expect(body).toMatchObject({ eventId: envelope.eventId, payload: { policyId } });
    expect((await deadLetterRows(envelope.eventId))[0]!.publishedAt).not.toBeNull();

    // The transfer is consumed at last; the operator replays the dead letter.
    await transferToB(assetId);
    await consumer.handle(body, {
      topic: 'rasta.insurance.v1.retry',
      partition: 0,
      key: letter.partitionKey,
    });
    expect((await repository.findAssetRefUnscoped(assetId))!.insuranceCover).toMatchObject({
      COMPREHENSIVE: [{ policyId, generation: 1 }],
    });
  });

  it('r9: a source slower than the transaction timeout still has each attempt recorded, and the last one dead-letters', async () => {
    const assetId = await machineOfA();
    const { envelope } = newOwnersPolicy(assetId);
    await consumer.handle(envelope, { topic: 'rasta.insurance.v1', partition: 0, key: assetId });

    // Each question outlives the 1 s transaction timeout, then times out. Asked
    // inside a transaction, the attempt would roll back with it, every time.
    const slow = {
      verify: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        throw RastaError.upstreamTimeout('asset-service', 1_500);
      },
    };
    const impatient = new AssetSyncConsumer(
      null,
      repository,
      undefined,
      undefined,
      undefined,
      slow,
      PARKING,
      1_000,
    );

    await age(envelope.eventId);
    expect(await impatient.sweepParked()).toMatchObject({ KEPT: 1 });
    expect(await parked(envelope.eventId)).toMatchObject({ attempts: 1, reason: 'NO_ANSWER' });

    await age(envelope.eventId);
    expect(await impatient.sweepParked()).toMatchObject({ DEAD_LETTERED: 1 });
    expect(await parked(envelope.eventId)).toBeNull();
    expect(await marked(envelope.eventId)).toBe(false);
    expect(await deadLetterRows(envelope.eventId)).toHaveLength(1);
    expect((await repository.findAssetRefUnscoped(assetId))!.insuranceCover).toEqual({});
  }, 30_000);

  it('r10: the transfer returns at once however many events are parked; the sweep applies them', async () => {
    const assetId = await machineOfA();
    const parkedIds: string[] = [];
    for (let i = 0; i < 120; i++) {
      const { envelope } = newOwnersPolicy(assetId);
      await consumer.handle(envelope);
      parkedIds.push(envelope.eventId);
    }
    const ofMachine = () =>
      runUnscoped('test reads the parked table across tenants', () =>
        prisma.client.insurancePendingVerification.findMany({ where: { assetId } }),
      );
    expect(await ofMachine()).toHaveLength(120);

    // A slow source: deciding them inside the handler, one after another, would
    // keep it 120 × 250 ms = 30 s away from Kafka — past the session timeout.
    const verify = policies.verify.bind(policies);
    const slow = jest.spyOn(policies, 'verify').mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return verify(...args);
    });
    const started = Date.now();
    await transferToB(assetId);
    const took = Date.now() - started;
    expect(slow).not.toHaveBeenCalled();
    slow.mockRestore();
    expect(took).toBeLessThan(5_000);

    const marked = await ofMachine();
    expect(marked).toHaveLength(120);
    expect(marked.every((row) => row.attempts === 0 && row.nextAttemptAt !== null)).toBe(true);

    // The sweep, outside the handler, decides them all at once: due by the
    // transfer, not by their age.
    expect((await consumer.sweepParked()).APPLIED).toBeGreaterThanOrEqual(120);
    expect(await ofMachine()).toHaveLength(0);
    const cover = (await repository.findAssetRefUnscoped(assetId))!.insuranceCover as Record<
      string,
      { policyId: string }[]
    >;
    expect(cover.COMPREHENSIVE).toHaveLength(120);
  }, 120_000);

  it('r10: a parked verification paused across insurance:clear-transferred restores nothing', async () => {
    const assetId = await machineOfA();
    const validFrom = new Date(Date.now() - 1000).toISOString();
    const validTo = new Date(Date.now() + year).toISOString();
    const comprehensive = (policyId: string) =>
      eventFor(org.a, 'INSURANCE_RECORDED', {
        assetId,
        policyId,
        insurerName: 'بیمه ایران',
        coverage: 'COMPREHENSIVE',
        validFrom,
        validTo,
      });
    const window = async () =>
      (await repository.findAssetRefUnscoped(assetId))!.insuranceCover as Record<string, unknown>;

    // org.a's policy, in force before the transfer.
    const first = id('INS');
    policies.set(first, {
      counts: true,
      organizationId: org.a,
      coverage: 'COMPREHENSIVE',
      validFrom,
      validUntil: validTo,
      ownershipGeneration: 0,
    });
    await consumer.handle(comprehensive(first));
    // org.a's renewal, consumed here after the transfer committed at the source
    // but before fleet consumed it: parked. Under the rule of the moment
    // COMPREHENSIVE follows the vehicle, so the source counts it for org.b.
    const renewal = id('INS');
    policies.set(renewal, {
      counts: true,
      organizationId: org.b,
      coverage: 'COMPREHENSIVE',
      validFrom,
      validUntil: validTo,
      ownershipGeneration: 1,
    });
    const event = comprehensive(renewal);
    await consumer.handle(event);
    expect(await parked(event.eventId)).toMatchObject({ reason: 'NOT_CURRENT_OWNER' });
    await consumer.handle(
      eventFor(org.b, 'ASSET_TRANSFERRED', {
        assetId,
        fromOrganizationId: org.a,
        toOrganizationId: org.b,
        transferredAt: new Date().toISOString(),
        reason: 'واگذاری',
        ownershipGeneration: 1,
        retainedCoverages: ['COMPREHENSIVE'],
      }),
    );
    expect(await window()).toMatchObject({ COMPREHENSIVE: [{ policyId: first }] });

    // The sweep asks about the renewal. While the old rule's answer is held, the
    // rule is narrowed and the transferred machines' windows are cleared.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const asking = new Promise<void>((resolve) => (reached = resolve));
    const verify = policies.verify.bind(policies);
    const paused = jest
      .spyOn(policies, 'verify')
      .mockImplementation(async (organizationId, asked, policyId) => {
        const answer = await verify(organizationId, asked, policyId);
        if (policyId === renewal) {
          reached();
          await held;
        }
        return answer;
      });
    const sweep = consumer.sweepParked();
    await asking;
    const report = await clearTransferredInsurance(repository, {
      dryRun: false,
      includeUnknownGeneration: false,
      organizationId: org.b,
      pageSize: 100,
    });
    expect(report.cleared).toBeGreaterThanOrEqual(1);
    expect(await window()).toEqual({});
    release();
    await sweep;
    paused.mockRestore();

    // The answer was about a replica that no longer stands: nothing restored,
    // the event still parked, no attempt counted.
    expect(await window()).toEqual({});
    expect(await parked(event.eventId)).toMatchObject({ attempts: 0 });

    // Still due: the next run asks again, under the narrowed rule.
    policies.deny(renewal, 'NOT_FOLLOWING_VEHICLE');
    await consumer.sweepParked();
    expect(await parked(event.eventId)).toBeNull();
    expect(await window()).toEqual({});
  });

  it('is tenant data: each organization reads only the rows parked under it', async () => {
    const assetOfA = await machineOfA();
    const assetOfB = await machineOfA();
    const first = newOwnersPolicy(assetOfA);
    await consumer.handle(first.envelope); // parked under org.b
    // org.a's own event about a machine that moved on at the source.
    const policyId = id('INS');
    policies.set(policyId, {
      counts: true,
      organizationId: org.b,
      coverage: 'COMPREHENSIVE',
      validFrom: new Date().toISOString(),
      validUntil: new Date(Date.now() + year).toISOString(),
      ownershipGeneration: 1,
    });
    const second = eventFor(org.a, 'INSURANCE_RECORDED', {
      assetId: assetOfB,
      policyId,
      insurerName: 'بیمه ایران',
      coverage: 'COMPREHENSIVE',
      validFrom: new Date().toISOString(),
      validTo: new Date(Date.now() + year).toISOString(),
    });
    await consumer.handle(second); // parked under org.a

    const seenBy = (organizationId: string) =>
      asActor({ organizationId }, () =>
        prisma.client.insurancePendingVerification.findMany({
          where: { eventId: { in: [first.envelope.eventId, second.eventId] } },
          select: { eventId: true, organizationId: true },
        }),
      );

    expect(await seenBy(org.a)).toEqual([{ eventId: second.eventId, organizationId: org.a }]);
    expect(await seenBy(org.b)).toEqual([
      { eventId: first.envelope.eventId, organizationId: org.b },
    ]);
    // Another tenant's row cannot be written under this one.
    await expect(
      asActor({ organizationId: org.a }, () =>
        prisma.client.insurancePendingVerification.create({
          data: {
            eventId: id('EVT'),
            assetId: assetOfA,
            organizationId: org.b,
            envelope: {},
            sourceTopic: 'rasta.insurance.v1',
            reason: 'NOT_CURRENT_OWNER',
          },
        }),
      ),
    ).rejects.toThrow(/Cross-tenant writes are never implicit/);
    // The transfer's handler marks by machine, whichever tenant parked.
    expect(
      await repository.transaction((tx) => repository.markParkedInsuranceDue(tx, assetOfA)),
    ).toBe(1);
    expect(await parked(first.envelope.eventId)).toMatchObject({
      nextAttemptAt: expect.any(Date),
    });
  });
});
