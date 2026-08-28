import { Kafka, type Consumer } from 'kafkajs';
import { OutboxRelay, type EventEnvelope } from '@rasta/nest-common';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import { KafkaEventPublisher } from '../src/outbox/kafka.publisher';
import { FleetRepository } from '../src/fleet/fleet.repository';
import { AssignmentService } from '../src/fleet/assignment.service';
import { AssetSyncConsumer } from '../src/consumers/asset-sync.consumer';
import { FLEET_TOPIC } from '../src/config/env';
import { asActor, brokers, cleanup, id, newPrisma, tenants, waitFor } from './helpers';

/**
 * The event path, end to end, over a real broker.
 *
 * This is the test the repository has never had: a domain change writes an
 * outbox row in the same transaction, the relay publishes it to Kafka, and a
 * consumer on the other side reads it back. Every link is real — no mocked
 * producer, no in-memory queue.
 *
 * It also proves the shape asset-service depends on. Its TimelineConsumer
 * projects `ASSET_ASSIGNED` by name and attaches the entry by `assetId`; an
 * event missing that field is silently skipped, so the dossier would simply
 * never record the assignment. Asserting the envelope here is what stops that
 * from being discovered in production.
 */

const brokerList = brokers();
// Skips rather than fails when no broker is configured: a developer without
// Docker should still be able to run the database half of the suite. A skip is
// visible in the output; silently passing is not.
const describeWithKafka = brokerList ? describe : describe.skip;

if (!brokerList) {
  console.warn('[event-flow] KAFKA_BROKERS is not set — skipping the broker tests');
}

describeWithKafka('fleet event flow over Kafka', () => {
  const org = tenants();
  const groupId = `fleet-itest-${id('G').slice(-12)}`;

  let prisma: PrismaService;
  let repository: FleetRepository;
  let assignments: AssignmentService;
  let publisher: KafkaEventPublisher;
  let relay: OutboxRelay;
  let consumer: Consumer;

  const received: EventEnvelope[] = [];

  const driverId = id('DRV');
  const assetId = id('AST');

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    repository = new FleetRepository(prisma);
    assignments = new AssignmentService(repository);

    publisher = new KafkaEventPublisher({
      brokers: brokerList!,
      clientId: 'fleet-itest-producer',
    });
    relay = new OutboxRelay({ store: new PrismaOutboxStore(prisma), publisher });

    // A dedicated consumer group per run, reading only what this run
    // publishes: the topic is shared with whatever else is on the machine.
    const kafka = new Kafka({
      clientId: 'fleet-itest-consumer',
      brokers: brokerList!,
      logLevel: 1,
    });
    consumer = kafka.consumer({ groupId, sessionTimeout: 30_000 });
    await consumer.connect();
    await consumer.subscribe({ topic: FLEET_TOPIC, fromBeginning: false });
    await consumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value) return;
        received.push(JSON.parse(message.value.toString('utf8')) as EventEnvelope);
      },
    });

    await cleanup(prisma, [org.a, org.b]);

    await asActor({ organizationId: org.a }, async () => {
      await prisma.client.driver.create({
        data: { id: driverId, userId: `USR-${driverId}`, createdBy: 'ITEST', updatedBy: 'ITEST' },
      });
      await prisma.client.assetRef.create({
        data: {
          id: assetId,
          organizationId: org.a,
          status: 'ACTIVE',
          name: 'گریدر آزمون',
          assetType: 'GRADER',
          syncedAt: new Date(),
          sourceEvent: 'ITEST',
        },
      });
    });
  }, 90_000);

  afterAll(async () => {
    await consumer?.disconnect();
    await publisher?.onModuleDestroy();
    await cleanup(prisma, [org.a, org.b]);
    await prisma?.onModuleDestroy();
  }, 60_000);

  it('carries an assignment from a domain write to a Kafka consumer', async () => {
    const assignment = await asActor({ organizationId: org.a, userId: 'USR-ITEST-MANAGER' }, () =>
      assignments.create({ driverId, assetId, purpose: 'آزمون یکپارچگی' }),
    );

    // The row exists but is unpublished until the relay runs. Driving the
    // relay explicitly rather than waiting on its timer keeps the test
    // deterministic.
    const pending = await prisma.client.outboxMessage.findFirstOrThrow({
      where: { aggregateId: assignment.id },
    });
    expect(pending.publishedAt).toBeNull();

    const published = await relay.tick();
    expect(published).toBeGreaterThanOrEqual(1);

    const marked = await prisma.client.outboxMessage.findFirstOrThrow({
      where: { aggregateId: assignment.id },
    });
    expect(marked.publishedAt).not.toBeNull();

    const envelope = await waitFor(
      `ASSET_ASSIGNED for ${assignment.id} to arrive on ${FLEET_TOPIC}`,
      async () =>
        received.find(
          (e) =>
            e.eventName === 'ASSET_ASSIGNED' &&
            (e.payload as { assignmentId?: string }).assignmentId === assignment.id,
        ),
    );

    // The envelope every consumer relies on (docs/07 § 7.3).
    expect(envelope.producer).toBe('fleet-service');
    expect(envelope.aggregateType).toBe('Assignment');
    expect(envelope.tenantId).toBe(org.a);
    expect(envelope.correlationId).toBeTruthy();
    expect(envelope.actor).toEqual({ type: 'USER', id: 'USR-ITEST-MANAGER' });

    // The field asset-service's projector attaches the dossier entry by.
    // Without it the entry is skipped and the machine never moves to ASSIGNED.
    const payload = envelope.payload as Record<string, unknown>;
    expect(payload.assetId).toBe(assetId);
    expect(payload.driverId).toBe(driverId);
    expect(payload.organizationId).toBe(org.a);
  }, 90_000);

  it('keeps one correlation id across the whole chain', async () => {
    // § 40: HTTP → fleet-service → outbox → Kafka must stay traceable.
    const envelope = received.find((e) => e.eventName === 'ASSET_ASSIGNED');
    expect(envelope).toBeDefined();

    const outbox = await prisma.client.outboxMessage.findFirstOrThrow({
      where: { organizationId: org.a, eventName: 'ASSET_ASSIGNED' },
    });

    expect(envelope!.correlationId).toBe(outbox.correlationId);
    // The header carries it too, so a consumer can filter without parsing the
    // body.
    expect((outbox.headers as Record<string, string>)['x-correlation-id']).toBe(
      outbox.correlationId,
    );
  });

  it('emits ASSIGNMENT_ENDED with the assetId the projector needs', async () => {
    const active = await asActor({ organizationId: org.a }, () =>
      repository.findActiveAssignmentForAsset(assetId),
    );
    expect(active).not.toBeNull();

    await asActor({ organizationId: org.a }, () =>
      assignments.end(active!.id, { reason: 'COMPLETED' }),
    );
    await relay.tick();

    const envelope = await waitFor(`ASSIGNMENT_ENDED for ${active!.id}`, async () =>
      received.find(
        (e) =>
          e.eventName === 'ASSIGNMENT_ENDED' &&
          (e.payload as { assignmentId?: string }).assignmentId === active!.id,
      ),
    );

    const payload = envelope.payload as Record<string, unknown>;
    // The catalogue's summary column lists only assignmentId and endedAt.
    // Following it literally would leave asset-service unable to attach the
    // entry, and every released machine stuck in ASSIGNED.
    expect(payload.assetId).toBe(assetId);
    expect(payload.reason).toBe('COMPLETED');
  }, 90_000);

  describe('consumer idempotency over the real path', () => {
    it('applies a redelivered event exactly once', async () => {
      // At-least-once delivery means this happens in normal operation, not
      // only in a fault. The marker and the effect share a transaction, so the
      // second delivery finds the marker and stops (docs/07 § 7.5).
      const sync = new AssetSyncConsumer(null, repository);
      const eventId = id('EVT');
      const freshAsset = id('AST');

      const event: EventEnvelope = {
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
          reason: 'آزمون',
        },
      };

      await sync.handle(event);
      const afterFirst = await repository.findAssetRef(freshAsset);
      expect(afterFirst?.status).toBe('OUT_OF_SERVICE');

      // Replay the identical event, then a *newer* one, then the replay again —
      // the ordering that catches a consumer whose idempotency is only a
      // last-write-wins upsert.
      await sync.handle({
        ...event,
        eventId: id('EVT'),
        payload: { ...event.payload, newStatus: 'ACTIVE' },
      });
      await sync.handle(event);

      const afterReplay = await repository.findAssetRef(freshAsset);
      // If the replay had been applied a second time, this would read
      // OUT_OF_SERVICE again — a stale event undoing a newer one.
      expect(afterReplay?.status).toBe('ACTIVE');

      const markers = await prisma.client.processedEvent.findMany({ where: { eventId } });
      expect(markers).toHaveLength(1);

      await prisma.client.$executeRawUnsafe(`DELETE FROM asset_ref WHERE id = $1`, freshAsset);
      await prisma.client.$executeRawUnsafe(
        `DELETE FROM processed_event WHERE event_id = ANY($1::text[])`,
        [eventId],
      );
    }, 60_000);
  });
});
