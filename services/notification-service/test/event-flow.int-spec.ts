import { Kafka, type Producer } from 'kafkajs';
import { ulid } from 'ulid';
import { EventConsumer } from '@rasta/nest-common';
import { DLQ_HEADERS, type EventEnvelope } from '@rasta/contracts';
import { DispatcherConsumer } from '../src/intake/dispatcher.consumer';
import { SUBSCRIBED_TOPICS } from '../src/rules/rules';
import {
  cleanup,
  brokers,
  DEDUPE_RETENTION_DAYS,
  insuranceExpiring,
  INSURANCE_TOPIC,
  maintenanceDue,
  MAINTENANCE_TOPIC,
  newOrganizationId,
  newUserId,
  rowsFor,
  silentLogger,
  waitFor,
  wire,
  type Wiring,
} from './helpers';

/**
 * The pipeline over a real broker and a real database.
 *
 * Publish → the shared `EventConsumer` → `DispatcherConsumer.handle` →
 * intent → worker → in-app row. Nothing between the producer and the table is
 * substituted except identity-service, behind the port.
 *
 * ## Isolation
 *
 * The consumer group is unique per run and starts at the topic's tail
 * (`fromBeginning: false`, the production setting), so a developer's stack
 * or a concurrent shard never steals partitions from this suite. Every
 * assertion selects by this run's organization ids, never by a global count.
 *
 * ## The tail race, and how it is closed
 *
 * `fromBeginning: false` resolves to "the end of the topic at the instant the
 * group first fetches", so a message published before that instant is never
 * delivered — and on a broker that drops a connection during the join, the
 * instant moves. So `beforeAll` publishes sentinels, one every ten seconds,
 * until one of them comes back as an intent: only then is the pipe known to be
 * flowing from the tail, and every later publish lands after it.
 */
const brokerList = brokers();
const describeWithKafka = brokerList ? describe : describe.skip;

const GROUP_JOIN_TIMEOUT_MS = 60_000;
const DELIVERY_TIMEOUT_MS = 90_000;

if (!brokerList) {
  console.warn('[notification] KAFKA_BROKERS is not set — skipping the event-flow tests');
}

describeWithKafka('event flow over Kafka', () => {
  let w: Wiring;
  let dispatcher: DispatcherConsumer;
  let producer: Producer;
  let kafka: Kafka;
  const organizations: string[] = [];
  const groupId = `notification-itest-${ulid().slice(-12)}`;
  const dlqTopic = 'rasta.notification.v1.dlq';

  function organization(): string {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  }

  async function publish(topic: string, envelope: EventEnvelope): Promise<void> {
    await producer.send({
      topic,
      messages: [{ key: envelope.aggregateId, value: JSON.stringify(envelope) }],
    });
  }

  function intentFor(sourceEventId: string) {
    return () =>
      rowsFor(w.prisma, organizations[organizations.length - 1]!).then(
        (rows) => rows.intents.find((intent) => intent.sourceEventId === sourceEventId) ?? null,
      );
  }

  beforeAll(async () => {
    w = wire();
    await w.prisma.onModuleInit();

    kafka = new Kafka({
      clientId: 'notification-itest-producer',
      brokers: brokerList as string[],
      logLevel: 1,
    });
    producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
    await producer.connect();

    dispatcher = new DispatcherConsumer(
      (handler) =>
        new EventConsumer(
          {
            brokers: brokerList as string[],
            clientId: 'notification-itest',
            groupId,
            topics: [...SUBSCRIBED_TOPICS],
            fromBeginning: false,
            deadLetterTopic: dlqTopic,
            maxRetries: 2,
            retryBackoffMs: 50,
          },
          handler,
          { log: () => undefined, warn: () => undefined, error: () => undefined },
        ),
      w.repository,
      DEDUPE_RETENTION_DAYS,
      silentLogger,
    );
    await dispatcher.start();

    // Sentinels until one flows: proves the group is consuming from the tail
    // before any timing-sensitive assertion is made.
    const organizationId = organization();
    const deadline = Date.now() + GROUP_JOIN_TIMEOUT_MS + DELIVERY_TIMEOUT_MS;
    for (;;) {
      const sentinel = insuranceExpiring({
        organizationId,
        policyId: `POL_${ulid()}`,
        daysRemaining: 20,
      });
      await publish(INSURANCE_TOPIC, sentinel);
      try {
        await waitFor('a sentinel intent', intentFor(sentinel.eventId), 10_000, 250);
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
      }
    }
  }, 200_000);

  afterAll(async () => {
    await dispatcher?.onModuleDestroy();
    await producer?.disconnect();
    await cleanup(w.prisma, organizations);
    await w.prisma.onModuleDestroy();
  }, 120_000);

  it('MAINTENANCE_DUE → intent → resolution → in-app row, with the correlation id carried through', async () => {
    const organizationId = organization();
    const user = newUserId();
    w.recipients.answers.set(organizationId, [{ userId: user, role: 'FLEET_MANAGER' }]);
    const envelope = maintenanceDue({
      organizationId,
      scheduleId: `SCH_${ulid()}`,
      correlationId: `COR_${ulid()}`,
    });

    await publish(MAINTENANCE_TOPIC, envelope);
    const intent = await waitFor(
      'the maintenance intent',
      intentFor(envelope.eventId),
      DELIVERY_TIMEOUT_MS,
      250,
    );
    expect(intent.sourceTopic).toBe(MAINTENANCE_TOPIC);
    expect(intent.correlationId).toBe(envelope.correlationId);
    expect(intent.status).toBe('PENDING');

    await w.worker.tick();

    const rows = await rowsFor(w.prisma, organizationId);
    expect(rows.intents[0]!.status).toBe('DISPATCHED');
    expect(rows.inApp).toHaveLength(1);
    expect(rows.inApp[0]).toMatchObject({
      userId: user,
      intentId: intent.id,
      ruleKey: 'maintenance.due',
    });
    // The worker is cross-tenant, so the last query may belong to another
    // suite's event on the shared broker; the claim is that *this* intent's
    // resolution asked identity under *this* event's correlation id.
    expect(
      w.recipients.queries.some(
        (query) =>
          query.organizationId === organizationId && query.correlationId === envelope.correlationId,
      ),
    ).toBe(true);
  }, 150_000);

  it('the same eventId published twice is one intent (layer 1)', async () => {
    const organizationId = organization();
    const envelope = insuranceExpiring({
      organizationId,
      policyId: `POL_${ulid()}`,
      daysRemaining: 20,
    });

    await publish(INSURANCE_TOPIC, envelope);
    await waitFor('the first delivery', intentFor(envelope.eventId), DELIVERY_TIMEOUT_MS, 250);
    await publish(INSURANCE_TOPIC, envelope);
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    expect((await rowsFor(w.prisma, organizationId)).intents).toHaveLength(1);
  }, 150_000);

  it('different eventIds for one fact in one band are one intent; a new band is a second (layer 2)', async () => {
    const organizationId = organization();
    const policyId = `POL_${ulid()}`;
    const first = insuranceExpiring({ organizationId, policyId, daysRemaining: 20 });
    const repeat = insuranceExpiring({ organizationId, policyId, daysRemaining: 17 });
    const newBand = insuranceExpiring({ organizationId, policyId, daysRemaining: 6 });

    await publish(INSURANCE_TOPIC, first);
    await waitFor('the first intent', intentFor(first.eventId), DELIVERY_TIMEOUT_MS, 250);
    await publish(INSURANCE_TOPIC, repeat);
    await publish(INSURANCE_TOPIC, newBand);
    await waitFor('the new-band intent', intentFor(newBand.eventId), DELIVERY_TIMEOUT_MS, 250);

    const rows = await rowsFor(w.prisma, organizationId);
    expect(rows.intents.map((intent) => intent.sourceEventId).sort()).toEqual(
      [first.eventId, newBand.eventId].sort(),
    );
    expect(rows.dedupe.map((row) => row.seenCount).sort()).toEqual([1, 2]);
  }, 150_000);

  it('a poison payload is dead-lettered with the original bytes and the partition keeps moving', async () => {
    const organizationId = organization();
    const poison = {
      ...insuranceExpiring({ organizationId, policyId: `POL_${ulid()}`, daysRemaining: 20 }),
      payload: { policyId: 'x', daysRemaining: 'many' },
    };
    const healthy = insuranceExpiring({
      organizationId,
      policyId: `POL_${ulid()}`,
      daysRemaining: 20,
    });

    // A reader on the dlq, pinned to the tail before the poison is published.
    const reader = kafka.consumer({ groupId: `${groupId}-dlq`, sessionTimeout: 60_000 });
    await reader.connect();
    await reader.subscribe({ topic: dlqTopic, fromBeginning: false });
    const seen: { eventId?: string; reason?: string; value: string }[] = [];
    let readerJoined = false;
    reader.on(reader.events.GROUP_JOIN, () => {
      readerJoined = true;
    });
    await reader.run({
      eachMessage: async ({ message }) => {
        const value = message.value?.toString('utf8') ?? '';
        seen.push({
          eventId: (JSON.parse(value) as { eventId?: string }).eventId,
          reason: message.headers?.[DLQ_HEADERS.reason]?.toString(),
          value,
        });
      },
    });
    try {
      await waitFor(
        'the dlq reader to join',
        async () => readerJoined || null,
        GROUP_JOIN_TIMEOUT_MS,
        250,
      );

      await publish(INSURANCE_TOPIC, poison as EventEnvelope);
      await publish(INSURANCE_TOPIC, healthy);

      const dead = await waitFor(
        'the poison event on the dlq',
        async () => seen.find((entry) => entry.eventId === poison.eventId) ?? null,
        DELIVERY_TIMEOUT_MS,
        250,
      );
      expect(dead.reason).toBe('MAX_RETRIES_EXCEEDED');
      expect(JSON.parse(dead.value)).toEqual(poison);

      await waitFor(
        'the healthy intent behind it',
        intentFor(healthy.eventId),
        DELIVERY_TIMEOUT_MS,
        250,
      );
      const rows = await rowsFor(w.prisma, organizationId);
      expect(rows.intents.map((intent) => intent.sourceEventId)).toEqual([healthy.eventId]);
    } finally {
      await reader.disconnect();
    }
  }, 200_000);

  it('an event no rule claims on a subscribed topic is skipped, and the next one still arrives', async () => {
    const organizationId = organization();
    const unclaimed = {
      ...insuranceExpiring({ organizationId, policyId: `POL_${ulid()}`, daysRemaining: 20 }),
      eventName: 'INSURANCE_RECORDED',
    };
    const claimed = insuranceExpiring({
      organizationId,
      policyId: `POL_${ulid()}`,
      daysRemaining: 20,
    });

    await publish(INSURANCE_TOPIC, unclaimed as EventEnvelope);
    await publish(INSURANCE_TOPIC, claimed);
    await waitFor('the claimed intent', intentFor(claimed.eventId), DELIVERY_TIMEOUT_MS, 250);

    const rows = await rowsFor(w.prisma, organizationId);
    expect(rows.intents.map((intent) => intent.sourceEventId)).toEqual([claimed.eventId]);
  }, 150_000);
});
