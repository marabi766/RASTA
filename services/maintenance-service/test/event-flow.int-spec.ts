import { Kafka, type Consumer, type Producer } from 'kafkajs';
import { OutboxRelay, type EventEnvelope } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import { KafkaEventPublisher } from '../src/outbox/kafka.publisher';
import { MaintenanceRepository } from '../src/maintenance/maintenance.repository';
import { ScheduleService } from '../src/maintenance/schedule.service';
import { RequestService } from '../src/maintenance/request.service';
import { RepairOrderService } from '../src/maintenance/repair-order.service';
import { DueAnnouncerService } from '../src/maintenance/due-announcer.service';
import { UnverifiedWorkshopDirectory } from '../src/maintenance/workshop.directory';
import { UsageConsumer } from '../src/consumers/usage.consumer';
import { AssetSyncConsumer } from '../src/consumers/asset-sync.consumer';
import { MAINTENANCE_TOPIC } from '../src/config/env';
import type { MaintenanceEnv } from '../src/config/env';
import {
  asActor,
  brokers,
  cleanup,
  id,
  newPrisma,
  seedAsset,
  seedMeter,
  tenants,
  waitFor,
} from './helpers';

/**
 * The event path, end to end, over a real broker.
 *
 * Two flows meet in this service, and until it existed neither had both ends:
 *
 *   **fleet → maintenance.** fleet-service has been publishing
 *   `USAGE_RECORDED` since it shipped, with no consumer at all. It is the
 *   trigger for usage-based service schedules (docs/04 § 4.6) — the platform's
 *   single largest reason for maintenance to exist — and this test carries a
 *   real message from the fleet topic into the meter and out again as
 *   `MAINTENANCE_DUE`.
 *
 *   **maintenance → asset.** fleet-service has been *consuming*
 *   `MAINTENANCE_STARTED` and `MAINTENANCE_COMPLETED` since it shipped, with
 *   no producer. asset-service's timeline projector likewise. This test proves
 *   the envelope those consumers require actually reaches the topic.
 *
 * Every link is real: no mocked producer, no in-memory queue, no stubbed
 * consumer.
 */

const brokerList = brokers();
// Skips rather than fails when no broker is configured: a developer without
// Docker should still be able to run the database half of the suite. A skip is
// visible in the output; silently passing is not.
const describeWithKafka = brokerList ? describe : describe.skip;

if (!brokerList) {
  console.warn('[event-flow] KAFKA_BROKERS is not set — skipping the broker tests');
}

const FLEET_TOPIC = 'rasta.fleet.v1';

describeWithKafka('maintenance event flow over Kafka', () => {
  const org = tenants();
  const groupId = `maintenance-itest-${ulid().slice(-12)}`;
  const usageGroupId = `maintenance-usage-itest-${ulid().slice(-12)}`;

  let prisma: PrismaService;
  let repository: MaintenanceRepository;
  let schedules: ScheduleService;
  let requests: RequestService;
  let repairOrders: RepairOrderService;
  let announcer: DueAnnouncerService;
  let usageConsumer: UsageConsumer;
  let publisher: KafkaEventPublisher;
  let relay: OutboxRelay;
  let consumer: Consumer;
  let fleetProducer: Producer;

  const received: EventEnvelope[] = [];
  const assetId = id('AST');

  const env = { MAINTENANCE_DEFAULT_LEAD_DAYS: 7 } as MaintenanceEnv;

  /** Waits for a consumer to actually join its group, not merely for `run()`. */
  function groupJoin(target: Consumer, name: string): Promise<void> {
    // On a broker that has just started, `connect()`, `subscribe()` and `run()`
    // all succeed while the group coordinator is still unavailable: the
    // `__consumer_offsets` partitions have not finished loading. kafkajs then
    // retries in the background and the test publishes into a topic nobody is
    // reading yet, failing on a timeout that names the wrong thing. CI found
    // this in fleet-service; a developer machine cannot, because the broker
    // there has been up for hours.
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Consumer group ${name} did not join within 60s`)),
        60_000,
      );
      target.on(target.events.GROUP_JOIN, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    repository = new MaintenanceRepository(prisma);
    schedules = new ScheduleService(repository, env);
    requests = new RequestService(repository);
    repairOrders = new RepairOrderService(repository, new UnverifiedWorkshopDirectory());
    announcer = new DueAnnouncerService(repository);

    publisher = new KafkaEventPublisher({
      brokers: brokerList as string[],
      clientId: 'maintenance-itest-producer',
    });
    relay = new OutboxRelay({ store: new PrismaOutboxStore(prisma), publisher });

    const kafka = new Kafka({
      clientId: 'maintenance-itest',
      brokers: brokerList as string[],
      logLevel: 1,
    });

    // Stands in for fleet-service. Publishing a real message onto the real
    // fleet topic is the only way to prove this service consumes what
    // fleet-service actually emits.
    fleetProducer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
    await fleetProducer.connect();

    // A dedicated consumer group per run, reading only what this run
    // publishes: the topic is shared with whatever else is on the machine.
    consumer = kafka.consumer({ groupId, sessionTimeout: 30_000 });
    const joined = groupJoin(consumer, groupId);
    await consumer.connect();
    await consumer.subscribe({ topic: MAINTENANCE_TOPIC, fromBeginning: false });
    await consumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value) return;
        received.push(JSON.parse(message.value.toString('utf8')) as EventEnvelope);
      },
    });
    await joined;

    await cleanup(prisma, [org.a, org.b]);
    await seedAsset(prisma, assetId, org.a);
  }, 120_000);

  afterAll(async () => {
    await usageConsumer?.onModuleDestroy();
    await fleetProducer?.disconnect();
    await consumer?.disconnect();
    await publisher?.onModuleDestroy();
    await cleanup(prisma, [org.a, org.b]);
    await prisma?.onModuleDestroy();
  }, 60_000);

  // -------------------------------------------------------------------------
  // Run-owned fixtures
  //
  // Every `it()` below establishes the state it reads through one of these,
  // rather than through a sibling having run first. Five of the eight tests
  // used to read rows another test created, so `jest -t` -- which CI uses to
  // re-run a single failure, and which a developer uses all day -- selected a
  // test into a database that had none of its prerequisites. The failure
  // surfaced as `findFirstOrThrow` raising "No record was found for a query",
  // naming the query rather than the missing setup (F-25).
  // -------------------------------------------------------------------------

  /** A fresh asset for this run, under this run's tenant. */
  async function ownAsset(): Promise<string> {
    const asset = id('AST');
    await seedAsset(prisma, asset, org.a);
    return asset;
  }

  /**
   * A repair this caller owns, driven to IN_PROGRESS and published.
   *
   * Returns identifiers rather than rows: every caller below needs to name its
   * own request when it queries, and taking the ids from here is what stops a
   * query from matching a sibling test's repair.
   *
   * `awaitEnvelope` is opt-in, and deliberately not the default. Self-seeding
   * means the work the first repair test used to do for everyone is now done
   * per caller, so a wait placed here is a wait three tests pay. Only the two
   * that read `received` need the envelope in hand; the completion test drives
   * its own relay and waits on its own `MAINTENANCE_COMPLETED`, so making it
   * block on `MAINTENANCE_STARTED` would buy nothing and would triple this
   * file's exposure to the broker stalls F-27 tracks.
   */
  async function startedRepair({ awaitEnvelope = false } = {}): Promise<{
    assetId: string;
    requestId: string;
    orderId: string;
  }> {
    const asset = await ownAsset();

    const request = await asActor({ organizationId: org.a, userId: 'USR-ITEST-MANAGER' }, () =>
      requests.create({
        assetId: asset,
        type: 'CORRECTIVE',
        severity: 'HIGH',
        title: 'REPAIR-FIXTURE',
      }),
    );

    const order = await asActor({ organizationId: org.a, userId: 'USR-ITEST-MANAGER' }, () =>
      repairOrders.assign(request.id, {
        workshopOrganizationId: 'ORG-ITEST-WORKSHOP',
        workshopName: 'WORKSHOP-FIXTURE',
      }),
    );

    await asActor({ organizationId: org.a, userId: 'USR-ITEST-MANAGER' }, () =>
      repairOrders.start(order.id, {}),
    );

    // Published unconditionally: the outbox row has to leave the table either
    // way, or a later `relay.tick()` in this run would republish it.
    await relay.tick();

    // Awaited only when the caller reads `received`, so it finds the envelope
    // rather than racing the relay.
    //
    // 60s rather than `waitFor`'s default 30s, and it is a tolerance for
    // delivery latency rather than a hope that a wrong assertion will come
    // good. Under local contention the consumer's 30s session expires, the
    // coordinator removes the member — "removing member … on heartbeat
    // expiration" in the broker log, `read ECONNRESET` on this side — and the
    // group rebalances. Committed offsets survive that, so the envelope is
    // delivered late rather than lost, and the old deadline could expire
    // while it was still in flight. Charged against a 120s test timeout, so
    // an envelope that never comes still fails rather than hangs. The
    // contention itself is F-27 and is not addressed here.
    if (awaitEnvelope) {
      await waitFor(
        `MAINTENANCE_STARTED for ${request.id} to arrive`,
        async () =>
          received.find(
            (e) =>
              e.eventName === 'MAINTENANCE_STARTED' &&
              (e.payload as { requestId?: string }).requestId === request.id,
          ),
        60_000,
      );
    }

    return { assetId: asset, requestId: request.id, orderId: order.id };
  }

  // -------------------------------------------------------------------------
  // FLOW A — fleet-service → Kafka → maintenance-service
  // -------------------------------------------------------------------------

  it('folds a real USAGE_RECORDED message once, and ignores its redelivery', async () => {
    // The schedule is due at 4 560 hours; the reading below takes the machine
    // past it, which is what makes this an end-to-end test of the trigger
    // rather than of message delivery.
    const schedule = await asActor({ organizationId: org.a }, () =>
      schedules.create({
        assetId,
        title: 'تعویض روغن موتور',
        maintenanceType: 'PREVENTIVE',
        recurrence: 'RECURRING',
        intervalHours: '250.00',
        leadHours: '25.00',
        lastServicedHourMeter: '4310.00',
      }),
    );

    // The real consumer, on the real topic, with the real EventConsumer
    // underneath — the same class the service runs in production.
    const { EventConsumer } = await import('@rasta/nest-common');
    usageConsumer = new UsageConsumer(
      (handler) =>
        new EventConsumer(
          {
            brokers: brokerList as string[],
            clientId: 'maintenance-itest-usage',
            groupId: usageGroupId,
            topics: [FLEET_TOPIC],
            deadLetterTopic: 'rasta.maintenance.v1.dlq',
            fromBeginning: false,
          },
          handler,
          { log: () => {}, warn: () => {}, error: () => {} },
        ),
      repository,
      announcer,
    );

    await usageConsumer.onModuleInit();
    // Give the consumer time to join before publishing into the topic.
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    const usageEventId = ulid();
    const correlationId = `itest-usage-${ulid()}`;

    await fleetProducer.send({
      topic: FLEET_TOPIC,
      acks: -1,
      messages: [
        {
          key: assetId,
          value: JSON.stringify({
            eventId: usageEventId,
            eventName: 'USAGE_RECORDED',
            eventVersion: 1,
            occurredAt: new Date().toISOString(),
            producer: 'fleet-service',
            producerVersion: '0.1.0',
            aggregateType: 'UsageRecord',
            aggregateId: `USG_${usageEventId}`,
            tenantId: org.a,
            correlationId,
            actor: { type: 'USER', id: 'USR-ITEST-DRIVER' },
            payload: {
              usageRecordId: `USG_${usageEventId}`,
              assetId,
              organizationId: org.a,
              driverId: 'DRV-ITEST',
              assignmentId: null,
              periodStart: new Date(Date.now() - 3_600_000).toISOString(),
              periodEnd: new Date().toISOString(),
              // Quantities as strings, exactly as fleet-service emits them.
              hours: '8.00',
              kilometres: null,
              hourMeter: '4570.00',
              odometer: null,
              source: 'MANUAL',
            },
          }),
          headers: { 'x-correlation-id': correlationId },
        },
      ],
    });

    const meter = await waitFor(`the meter for ${assetId} to reach 4570`, async () => {
      const row = await repository.findMeter(assetId);
      return row && row.hourMeter.toString() === '4570' ? row : null;
    });

    expect(meter.lastUsageRecordId).toBe(`USG_${usageEventId}`);
    expect(meter.recordCount).toBe(1);

    // And the schedule, evaluated the moment the reading landed, announced
    // itself. This is the dead path the platform has had since fleet shipped:
    // a usage event with no consumer.
    const announcement = await waitFor(`MAINTENANCE_DUE for ${schedule.id}`, async () =>
      asActor({ organizationId: org.a }, () =>
        repository.client.outboxMessage.findFirst({
          where: { aggregateId: schedule.id, eventName: 'MAINTENANCE_DUE' },
        }),
      ),
    );

    const payload = (announcement.payload as { payload: Record<string, unknown> }).payload;
    expect(payload.basis).toBe('HOURS');
    expect(payload.state).toBe('OVERDUE');
    expect(payload.dueAtMeter).toBe('4560.00');
    expect(payload.assetId).toBe(assetId);

    // --- the same reading, delivered again ---------------------------------
    //
    // At-least-once delivery means this happens in normal operation. Counting
    // it twice would add hours the machine never ran and defer a service that
    // is actually due — the failure fleet-service's own event contract warns
    // about.
    //
    // Asserted here rather than in a sibling `it()`. It was one until F-25:
    // it read both the meter *and* the `usageConsumer` this test constructs,
    // so selecting it alone consumed nothing and compared a meter that did not
    // exist. The two halves are one delivery — "folded once" and "not folded
    // twice" are the same fact observed either side of a redelivery — and
    // separating them would mean standing up a second consumer group only to
    // re-establish the first half.
    const before = meter;

    const duplicate = {
      eventId: `${before?.lastUsageRecordId}`.replace('USG_', ''),
      eventName: 'USAGE_RECORDED',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: 'fleet-service',
      producerVersion: '0.1.0',
      aggregateType: 'UsageRecord',
      aggregateId: before?.lastUsageRecordId ?? 'USG_UNKNOWN',
      tenantId: org.a,
      correlationId: 'itest-replay',
      payload: {
        usageRecordId: before?.lastUsageRecordId,
        assetId,
        organizationId: org.a,
        periodEnd: new Date().toISOString(),
        hours: '8.00',
        hourMeter: '4570.00',
      },
    };

    await fleetProducer.send({
      topic: FLEET_TOPIC,
      acks: -1,
      messages: [{ key: assetId, value: JSON.stringify(duplicate) }],
    });

    // Wait long enough for the consumer to have processed it, then assert
    // nothing moved. A sleep is honest here: the assertion is about absence.
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    const after = await repository.findMeter(assetId);
    expect(after?.hourMeter.toString()).toBe('4570');
    expect(after?.recordCount).toBe(1);
  }, 180_000);

  it('announces a due schedule exactly once per cycle', async () => {
    // A machine working daily would otherwise announce on every reading until
    // someone acts. The guard is `WHERE due_announced_at IS NULL`, which is
    // also what makes the scan safe on every replica at once (ADR-027).
    //
    // Its own asset, meter and schedule. It used to read the schedule the
    // delivery test creates, which also meant the single announcement it
    // counted had been published by that test rather than by either call
    // below — so the guard being asserted was never exercised here at all.
    const scheduledAsset = await ownAsset();
    await seedMeter(prisma, scheduledAsset, org.a, '4570.00');
    const schedule = await asActor({ organizationId: org.a }, () =>
      schedules.create({
        assetId: scheduledAsset,
        title: 'SCHEDULE-FIXTURE',
        maintenanceType: 'PREVENTIVE',
        recurrence: 'RECURRING',
        intervalHours: '250.00',
        leadHours: '25.00',
        lastServicedHourMeter: '4310.00',
      }),
    );

    // The first call finds it due and claims the marker; the second finds the
    // marker already set. Exactly one event either way.
    expect(await announcer.announceIfDue(schedule as never, new Date())).toBe(true);
    expect(await announcer.announceIfDue(schedule as never, new Date())).toBe(false);

    const announcements = await asActor({ organizationId: org.a }, () =>
      repository.client.outboxMessage.findMany({
        where: { aggregateId: schedule.id, eventName: 'MAINTENANCE_DUE' },
      }),
    );

    expect(announcements).toHaveLength(1);
  }, 60_000);

  // -------------------------------------------------------------------------
  // FLOW B — maintenance-service → outbox → Kafka
  // -------------------------------------------------------------------------

  it('carries a repair from a domain write to a Kafka consumer', async () => {
    const request = await asActor({ organizationId: org.a, userId: 'USR-ITEST-MANAGER' }, () =>
      requests.create({
        assetId,
        type: 'CORRECTIVE',
        severity: 'HIGH',
        title: 'نشتی سیستم هیدرولیک',
      }),
    );

    const order = await asActor({ organizationId: org.a, userId: 'USR-ITEST-MANAGER' }, () =>
      repairOrders.assign(request.id, {
        workshopOrganizationId: 'ORG-ITEST-WORKSHOP',
        workshopName: 'تعمیرگاه آزمون',
      }),
    );

    await asActor({ organizationId: org.a, userId: 'USR-ITEST-MANAGER' }, () =>
      repairOrders.start(order.id, {}),
    );

    // The row exists but is unpublished until the relay runs. Driving the
    // relay explicitly rather than waiting on its timer keeps the test
    // deterministic.
    const pending = await asActor({ organizationId: org.a }, () =>
      prisma.client.outboxMessage.findFirstOrThrow({
        where: { aggregateId: request.id, eventName: 'MAINTENANCE_STARTED' },
      }),
    );
    expect(pending.publishedAt).toBeNull();

    expect(await relay.tick()).toBeGreaterThanOrEqual(1);

    const envelope = await waitFor(
      `MAINTENANCE_STARTED for ${request.id} to arrive on ${MAINTENANCE_TOPIC}`,
      async () =>
        received.find(
          (e) =>
            e.eventName === 'MAINTENANCE_STARTED' &&
            (e.payload as { requestId?: string }).requestId === request.id,
        ),
    );

    // The envelope every consumer relies on (docs/07 § 7.3).
    expect(envelope.producer).toBe('maintenance-service');
    expect(envelope.aggregateType).toBe('MaintenanceRequest');
    expect(envelope.tenantId).toBe(org.a);
    expect(envelope.correlationId).toBeTruthy();
    expect(envelope.actor).toEqual({ type: 'USER', id: 'USR-ITEST-MANAGER' });

    // The field both waiting consumers need. fleet-service sets
    // `asset_ref.inMaintenance` from it and asset-service attaches the dossier
    // entry by it — an event without it is silently skipped by both.
    const payload = envelope.payload as Record<string, unknown>;
    expect(payload.assetId).toBe(assetId);
    expect(payload.repairOrderId).toBe(order.id);
    expect(payload.workshopOrganizationId).toBe('ORG-ITEST-WORKSHOP');
  }, 120_000);

  /**
   * This run's own `MAINTENANCE_STARTED`, and the outbox row that produced it.
   *
   * `received` is appended to for every message that lands on the shared topic
   * from the moment the group joins, so a predicate naming only the event is a
   * predicate any other producer can satisfy — an overlapping CI shard, a
   * second developer, a live `pnpm dev`. The row is selected first because
   * `buildOutboxRow` writes the envelope's `eventId` as the row's primary key
   * (`packages/nest-common/src/outbox/outbox.ts`), so a row this run owns names
   * its own envelope exactly. Nothing here depends on arrival order, array
   * position or a sleep.
   *
   * This is test observation only. It says nothing about cross-topic ordering,
   * which is D-027's separate question.
   *
   * `requestId` narrows the row within the run. It is not a relaxation of the
   * above: the envelope is still resolved by `eventId`, which is still the
   * only link a foreign producer cannot satisfy. It is needed because each
   * caller now starts its own repair, so this run's tenant owns several
   * `MAINTENANCE_STARTED` rows and the tenant alone no longer names one.
   */
  async function ownMaintenanceStarted(requestId: string) {
    const outbox = await asActor({ organizationId: org.a }, () =>
      prisma.client.outboxMessage.findFirstOrThrow({
        // org.a is generated per run by `tenants()`, so this row is this run's;
        // aggregateId picks out the repair the caller just started.
        where: {
          organizationId: org.a,
          eventName: 'MAINTENANCE_STARTED',
          aggregateId: requestId,
        },
      }),
    );
    return { outbox, envelope: received.find((e) => e.eventId === outbox.id) };
  }

  it('keeps one correlation id across the whole chain', async () => {
    const { requestId } = await startedRepair({ awaitEnvelope: true });
    const { outbox, envelope } = await ownMaintenanceStarted(requestId);
    expect(envelope).toBeDefined();

    expect(envelope?.correlationId).toBe(outbox.correlationId);
    // The header carries it too, so a consumer can filter without parsing the
    // body.
    expect((outbox.headers as Record<string, string>)['x-correlation-id']).toBe(
      outbox.correlationId,
    );
  }, 120_000);

  // N2 — foreign-message control. Deterministic: the stale envelope is placed
  // directly into `received`, so the control needs no second producer, no
  // broker timing and no shared infrastructure.
  it('resolves its own MAINTENANCE_STARTED when a stale one shares the collection', async () => {
    const { requestId } = await startedRepair({ awaitEnvelope: true });
    const { outbox } = await ownMaintenanceStarted(requestId);

    const foreignRequestId = id('MRQ');
    const foreign: EventEnvelope = {
      eventId: id('EVT'),
      eventName: 'MAINTENANCE_STARTED',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: 'maintenance-service',
      producerVersion: '0.1.0',
      aggregateType: 'MaintenanceRequest',
      aggregateId: foreignRequestId,
      tenantId: 'ORG-FOREIGN-CONTROL',
      correlationId: `itest-foreign-${ulid()}`,
      payload: {
        requestId: foreignRequestId,
        assetId: id('AST'),
        repairOrderId: id('RPO'),
        workshopOrganizationId: 'ORG-FOREIGN-WORKSHOP',
      },
    };

    // Index 0 is where a foreign message lands when it is published before
    // this run's — the case F-15 describes.
    received.unshift(foreign);

    try {
      // The control is only meaningful if the stale envelope would in fact
      // have been selected. Asserting that first is what stops this test from
      // passing vacuously if the collection is ever ordered differently.
      expect(received.find((e) => e.eventName === 'MAINTENANCE_STARTED')).toBe(foreign);

      const { envelope } = await ownMaintenanceStarted(requestId);
      expect(envelope).toBeDefined();
      expect(envelope).not.toBe(foreign);
      expect(envelope?.eventId).toBe(outbox.id);
      expect(envelope?.tenantId).toBe(org.a);
      expect(envelope?.correlationId).toBe(outbox.correlationId);
      expect(envelope?.correlationId).not.toBe(foreign.correlationId);
    } finally {
      // Later tests read the same array; leave it as it was found.
      const at = received.indexOf(foreign);
      if (at >= 0) received.splice(at, 1);
    }
  }, 120_000);

  it('publishes the completion and the approval the dossier and settlement need', async () => {
    // Its own repair. It used to read whichever IN_PROGRESS request happened
    // to sit against the shared asset, which is the row the publish test
    // creates — nothing but run order made that true.
    const { assetId: repairAssetId, requestId, orderId } = await startedRepair();

    await asActor({ organizationId: org.a, userId: 'USR-ITEST-MANAGER' }, () =>
      repairOrders.recordPart(orderId, {
        partName: 'شیلنگ هیدرولیک',
        quantity: '1',
        unit: 'عدد',
        unitCostMinor: '4800000',
        source: 'MARKETPLACE',
      }),
    );

    await asActor({ organizationId: org.a, userId: 'USR-ITEST-MANAGER' }, () =>
      repairOrders.complete(orderId, { workPerformed: 'شیلنگ تعویض شد' }),
    );

    await asActor({ organizationId: org.a, userId: 'USR-ITEST-OWNER' }, () =>
      requests.approve(requestId, { expectedTotalCostMinor: '4800000' }),
    );

    await relay.tick();

    const completed = await waitFor(`MAINTENANCE_COMPLETED for ${requestId}`, async () =>
      received.find(
        (e) =>
          e.eventName === 'MAINTENANCE_COMPLETED' &&
          (e.payload as { requestId?: string }).requestId === requestId,
      ),
    );

    const completedPayload = completed.payload as Record<string, unknown>;
    expect(completedPayload.assetId).toBe(repairAssetId);
    // A flat minor-unit string, because that is what asset-service's timeline
    // projector reads. A nested money object would record the repair as free.
    expect(completedPayload.totalCostMinor).toBe('4800000');
    expect(typeof completedPayload.downtimeMinutes).toBe('number');

    const approved = await waitFor(`MAINTENANCE_APPROVED for ${requestId}`, async () =>
      received.find(
        (e) =>
          e.eventName === 'MAINTENANCE_APPROVED' &&
          (e.payload as { requestId?: string }).requestId === requestId,
      ),
    );

    const approvedPayload = approved.payload as Record<string, unknown>;
    expect(approvedPayload.approvedBy).toBe('USR-ITEST-OWNER');
    expect(approvedPayload.totalCostMinor).toBe('4800000');
    // The breakdown economic-service will reconcile against, rather than one
    // number it has to trust (ADR-028).
    const breakdown = approvedPayload.costBreakdown as { category: string; amountMinor: string }[];
    expect(breakdown).toEqual([{ category: 'PART', amountMinor: '4800000', currency: 'IRR' }]);
  }, 120_000);

  // -------------------------------------------------------------------------
  // Consumer idempotency over the real path
  // -------------------------------------------------------------------------

  it('applies a redelivered asset event exactly once', async () => {
    // At-least-once delivery means this happens in normal operation, not only
    // in a fault. The marker and the effect share a transaction, so the second
    // delivery finds the marker and stops (docs/07 § 7.5).
    const sync = new AssetSyncConsumer(null, repository);
    const eventId = ulid();
    const freshAsset = id('AST');

    const event = {
      eventId,
      eventName: 'ASSET_STATUS_CHANGED',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: 'asset-service',
      producerVersion: '0.1.0',
      aggregateType: 'Asset',
      aggregateId: freshAsset,
      tenantId: org.a,
      correlationId: `corr-${eventId}`,
      payload: {
        assetId: freshAsset,
        organizationId: org.a,
        previousStatus: 'ACTIVE',
        newStatus: 'OUT_OF_SERVICE',
      },
    } as EventEnvelope;

    await sync.handle(event);
    expect((await repository.findAssetRef(freshAsset))?.status).toBe('OUT_OF_SERVICE');

    // Replay the identical event, then a *newer* one, then the replay again —
    // the ordering that catches a consumer whose idempotency is only a
    // last-write-wins upsert.
    await sync.handle({
      ...event,
      eventId: ulid(),
      payload: { ...(event.payload as object), newStatus: 'ACTIVE' },
    } as EventEnvelope);
    await sync.handle(event);

    // If the replay had been applied a second time, this would read
    // OUT_OF_SERVICE again — a stale event undoing a newer one.
    expect((await repository.findAssetRef(freshAsset))?.status).toBe('ACTIVE');

    const markers = await prisma.client.processedEvent.findMany({ where: { eventId } });
    expect(markers).toHaveLength(1);

    await prisma.client.$executeRawUnsafe(`DELETE FROM asset_ref WHERE id = $1`, freshAsset);
    await prisma.client.$executeRawUnsafe(
      `DELETE FROM processed_event WHERE event_id = ANY($1::text[])`,
      [eventId],
    );
  }, 60_000);
});
