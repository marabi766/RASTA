import { Kafka, type Producer } from 'kafkajs';
import { ulid } from 'ulid';
import { EventConsumer } from '@rasta/nest-common';
import type { EventEnvelope } from '@rasta/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditRepository } from '../src/audit/audit.repository';
import { DomainProjectorConsumer } from '../src/consumers/domain-projector.consumer';
import { DOMAIN_PROJECTOR_CONSUMER, DOMAIN_TOPICS } from '../src/audit/audit.mapper';
import { brokers, cleanupRun, id, newMigratorPrisma, newPrisma, RUN_TAG, waitFor } from './helpers';

/**
 * The projector over a real broker and a real database.
 *
 * Nothing is mocked. The claim AUD-001 makes is that a domain event published
 * by another service becomes a durable audit row, and every link in that
 * sentence — the broker, the envelope, the consumer group, the transaction,
 * the append-only table — has to be the real one for the claim to mean
 * anything.
 *
 * ## Isolation
 *
 * The consumer group is unique per run, so this suite never competes with a
 * developer's running stack or a concurrent CI shard for partitions, and
 * `fromBeginning: true` on a fresh group replays whatever the broker still
 * holds — including other runs' messages. Every assertion therefore selects by
 * *this run's* identifiers and never by a global count.
 */
const brokerList = brokers();
const describeWithKafka = brokerList ? describe : describe.skip;

if (!brokerList) {
  console.warn('[audit] KAFKA_BROKERS is not set — skipping the projector tests');
}

describeWithKafka('domain projector over Kafka', () => {
  let prisma: PrismaService;
  let migrator: PrismaService;
  let repository: AuditRepository;
  let projector: DomainProjectorConsumer;
  let producer: Producer;

  const groupId = `audit-itest-${ulid().slice(-12)}`;
  const silentLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    fatal: () => undefined,
    trace: () => undefined,
    child: () => silentLogger,
  } as unknown as Parameters<typeof DomainProjectorConsumer.prototype.constructor>[2];

  function envelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
    return {
      eventId: id('EVT'),
      eventName: 'ASSET_DECOMMISSIONED',
      eventVersion: 1,
      occurredAt: '2026-12-01T09:00:00.000Z',
      producer: 'asset-service',
      producerVersion: '3.0.0',
      aggregateType: 'Asset',
      aggregateId: id('AST'),
      tenantId: id('ORG'),
      correlationId: id('COR'),
      payload: { reason: 'sold' },
      ...overrides,
    } as EventEnvelope;
  }

  async function publish(topic: string, body: unknown): Promise<void> {
    await producer.send({
      topic,
      messages: [{ key: ulid(), value: JSON.stringify(body) }],
    });
  }

  /** This run's row for a given source event id, or undefined. */
  function rowFor(sourceEventId: string) {
    return () => prisma.client.auditEvent.findFirst({ where: { sourceEventId } });
  }

  beforeAll(async () => {
    prisma = newPrisma();
    migrator = newMigratorPrisma();
    await prisma.onModuleInit();
    await migrator.onModuleInit();
    repository = new AuditRepository(prisma);

    const kafka = new Kafka({
      clientId: 'audit-itest-producer',
      brokers: brokerList as string[],
      logLevel: 1,
    });
    producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
    await producer.connect();

    projector = new DomainProjectorConsumer(
      (handler) =>
        new EventConsumer(
          {
            brokers: brokerList as string[],
            clientId: 'audit-itest',
            groupId,
            topics: [...DOMAIN_TOPICS],
            fromBeginning: true,
            deadLetterTopic: 'rasta.audit.v1.dlq',
          },
          handler,
          { log: () => undefined, warn: () => undefined, error: () => undefined },
        ),
      repository,
      silentLogger,
    );
    await projector.start();

    // Drain once, before any assertion depends on timing.
    //
    // `fromBeginning: true` is the correct production setting — the store must
    // be able to rebuild from whatever the broker still holds — but on a shared
    // developer broker it means this fresh group first replays days of other
    // runs' traffic, several thousand messages, each of which is a real audit
    // insert. CI never sees this because it creates the topics in the same job.
    //
    // A sentinel published now and waited for is caught up by definition: the
    // consumer reaches it only after everything before it. Every later wait in
    // this file is then a real assertion about the projector rather than a
    // race against a backlog.
    const sentinel = envelope({ aggregateType: 'Sentinel' });
    await publish('rasta.identity.v1', sentinel);
    await waitFor(
      'the projector to catch up with the broker backlog',
      rowFor(sentinel.eventId),
      600_000,
      1000,
    );
  }, 660_000);

  afterAll(async () => {
    await projector?.onModuleDestroy();
    await producer?.disconnect();
    await cleanupRun(migrator);
    await prisma.onModuleDestroy();
    await migrator.onModuleDestroy();
  }, 120_000);

  it('records one event from each of the ten topics, with the topic it arrived on', async () => {
    // The breadth claim. Each topic gets its own event, and each row must name
    // the topic the broker delivered it on rather than anything derived from
    // the producer.
    const sent = new Map<string, string>();
    for (const topic of DOMAIN_TOPICS) {
      const source = envelope({ aggregateType: 'Probe' });
      sent.set(topic, source.eventId);
      await publish(topic, source);
    }

    for (const [topic, eventId] of sent) {
      const row = await waitFor(`a row for ${eventId} from ${topic}`, rowFor(eventId));
      expect(row.sourceTopic).toBe(topic);
    }
  }, 180_000);

  it('preserves actor, tenant, source, time and correlation on a real ASSET_DECOMMISSIONED', async () => {
    const source = envelope({
      actor: { type: 'USER', id: id('USR') },
      causationId: id('CAU'),
      traceparent: '00-1234-5678-01',
    });
    await publish('rasta.asset.v1', source);

    const row = await waitFor('the decommission row', rowFor(source.eventId));

    expect(row.actorType).toBe('USER');
    expect(row.actorId).toBe(source.actor?.id);
    expect(row.organizationId).toBe(source.tenantId);
    expect(row.sourceService).toBe('asset-service');
    expect(row.sourceServiceVersion).toBe('3.0.0');
    expect(row.sourceEventName).toBe('ASSET_DECOMMISSIONED');
    expect(row.sourceTopic).toBe('rasta.asset.v1');
    expect(row.occurredAt.toISOString()).toBe('2026-12-01T09:00:00.000Z');
    expect(row.correlationId).toBe(source.correlationId);
    expect(row.causationId).toBe(source.causationId);
    expect(row.traceparent).toBe('00-1234-5678-01');
    // Path A is honestly incomplete, and the incompleteness is visible.
    expect(row.actorRoles).toEqual([]);
    expect(row.sourceIp).toBeNull();
    expect(row.outcome).toBe('SUCCESS');
  }, 120_000);

  it('writes one row for a message delivered twice', async () => {
    const source = envelope();

    await publish('rasta.fleet.v1', source);
    await waitFor('the first delivery', rowFor(source.eventId));

    // The same envelope again, exactly as an at-least-once redelivery would be.
    await publish('rasta.fleet.v1', source);

    // Settle, then count. A count taken immediately could pass simply because
    // the second message had not arrived yet, which would prove nothing.
    await new Promise((resolve) => setTimeout(resolve, 3000));

    expect(await prisma.client.auditEvent.count({ where: { sourceEventId: source.eventId } })).toBe(
      1,
    );
  }, 120_000);

  it('does not duplicate rows when a new group replays from offset zero', async () => {
    // `fromBeginning: true` means a rebalance or a fresh replica re-reads the
    // log. That must be safe, because the alternative is an audit store that
    // multiplies its own evidence.
    const source = envelope();
    await publish('rasta.maintenance.v1', source);
    await waitFor('the original row', rowFor(source.eventId));

    const replayGroup = `${groupId}-replay`;
    const replay = new DomainProjectorConsumer(
      (handler) =>
        new EventConsumer(
          {
            brokers: brokerList as string[],
            clientId: 'audit-itest-replay',
            groupId: replayGroup,
            topics: ['rasta.maintenance.v1'],
            fromBeginning: true,
          },
          handler,
          { log: () => undefined, warn: () => undefined, error: () => undefined },
        ),
      repository,
      silentLogger,
    );

    try {
      await replay.start();
      // Long enough for a fresh group to join and drain the partition.
      await new Promise((resolve) => setTimeout(resolve, 8000));

      // The replay group has its own `processed_event` key, so it does not see
      // the first group's marker. The unique index on
      // (occurred_at, source_event_id, source_topic) is what stops the second
      // row — which is exactly the layer ADR § 8 puts there for this case.
      expect(
        await prisma.client.auditEvent.count({ where: { sourceEventId: source.eventId } }),
      ).toBe(1);
    } finally {
      await replay.onModuleDestroy();
    }
  }, 180_000);

  it('stores an event whose name nothing declares', async () => {
    const source = envelope({ eventName: 'A_NAME_NO_SERVICE_HAS_DECLARED' });
    await publish('rasta.supplier.v1', source);

    const row = await waitFor('the unknown-name row', rowFor(source.eventId));

    expect(row.sourceEventName).toBe('A_NAME_NO_SERVICE_HAS_DECLARED');
    expect(row.action).toBe('A_NAME_NO_SERVICE_HAS_DECLARED');
  }, 120_000);

  it('keeps an out-of-order streamSeq event and one with none at all', async () => {
    // ADR § 8: audit never discards on sequence. A stale event is still
    // evidence that the event existed, and ordering is a read-time question.
    // This asserts storage and nothing about D-027 or ADR-051 B4-B6, neither of
    // which is implemented.
    const later = envelope({ streamSeq: 9 });
    const earlier = envelope({ streamSeq: 2 });
    const none = envelope({ streamSeq: undefined });

    await publish('rasta.economic.v1', later);
    await publish('rasta.economic.v1', earlier);
    await publish('rasta.economic.v1', none);

    const laterRow = await waitFor('the later-seq row', rowFor(later.eventId));
    const earlierRow = await waitFor('the earlier-seq row', rowFor(earlier.eventId));
    const noneRow = await waitFor('the no-seq row', rowFor(none.eventId));

    expect(laterRow.sourceStreamSeq).toBe(9n);
    expect(earlierRow.sourceStreamSeq).toBe(2n);
    expect(noneRow.sourceStreamSeq).toBeNull();
  }, 120_000);

  it('dead-letters a malformed envelope without leaking its body, and keeps consuming', async () => {
    const dlq = new Kafka({
      clientId: 'audit-itest-dlq-reader',
      brokers: brokerList as string[],
      logLevel: 1,
    });
    const dlqConsumer = dlq.consumer({ groupId: `${groupId}-dlq` });
    const dlqMessages: { reason?: string; originalTopic?: string; body: string }[] = [];

    await dlqConsumer.connect();
    await dlqConsumer.subscribe({ topic: 'rasta.audit.v1.dlq', fromBeginning: false });
    await dlqConsumer.run({
      eachMessage: async ({ message }) => {
        dlqMessages.push({
          reason: message.headers?.['x-dlq-reason']?.toString(),
          originalTopic: message.headers?.['x-dlq-original-topic']?.toString(),
          body: message.value?.toString('utf8') ?? '',
        });
      },
    });
    // Give the DLQ group time to join before the bad message is published.
    await new Promise((resolve) => setTimeout(resolve, 5000));

    try {
      const secret = `SECRET-${RUN_TAG}`;
      // Structurally invalid: `eventName` must be SCREAMING_SNAKE_CASE and
      // `correlationId` is required. Carries a secret so the leak check means
      // something.
      await publish('rasta.document.v1', {
        eventId: id('EVT'),
        eventName: 'not a valid name',
        occurredAt: '2026-12-01T09:00:00.000Z',
        producer: 'document-service',
        aggregateType: 'Document',
        aggregateId: id('DOC'),
        payload: { password: secret },
      });

      const dead = await waitFor('the malformed message on the dlq', async () =>
        dlqMessages.find((m) => m.body.includes('not a valid name')),
      );
      expect(dead.reason).toBe('VALIDATION_FAILED');
      // The original topic rides along, so a replay knows where it came from.
      expect(dead.originalTopic).toBe('rasta.document.v1');

      // A valid message on the same topic afterwards still lands, which is the
      // real assertion: one bad message must not stop the partition.
      const good = envelope({ producer: 'document-service', aggregateType: 'Document' });
      await publish('rasta.document.v1', good);
      const row = await waitFor('the following valid row', rowFor(good.eventId));
      expect(row.sourceTopic).toBe('rasta.document.v1');
    } finally {
      await dlqConsumer.disconnect();
    }
  }, 180_000);

  it('never marks an event processed when the write fails', async () => {
    // The invariant that matters most: an event marked processed without its
    // row is evidence lost with no trace it was lost. Forced by handing the
    // consumer a repository whose write always fails.
    const failing = {
      ingest: async (): Promise<never> => {
        throw new Error('database unavailable (injected)');
      },
    } as unknown as AuditRepository;

    const source = envelope();
    const consumer = new DomainProjectorConsumer(
      () => ({}) as EventConsumer,
      failing,
      silentLogger,
    );

    await expect(
      consumer.handle(source, Object.freeze({ topic: 'rasta.identity.v1', partition: 0 })),
    ).rejects.toThrow(/injected/);

    // Nothing recorded, in either table. The shared consumer's retry and DLQ
    // policy then applies, which is what leaves the event replayable.
    expect(
      await prisma.client.processedEvent.count({
        where: { eventId: source.eventId, consumerName: DOMAIN_PROJECTOR_CONSUMER },
      }),
    ).toBe(0);
    expect(await prisma.client.auditEvent.count({ where: { sourceEventId: source.eventId } })).toBe(
      0,
    );
  }, 60_000);
});
