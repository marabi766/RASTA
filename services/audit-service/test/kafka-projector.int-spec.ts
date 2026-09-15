import { Kafka, type Consumer, type Producer } from 'kafkajs';
import { ulid } from 'ulid';
import { EventConsumer } from '@rasta/nest-common';
import {
  AUDIT_EVENT_RECORDED,
  AUDIT_EVENT_RECORDED_VERSION,
  AUDIT_TRAIL_TOPIC,
  DLQ_HEADERS,
  ERROR_CODES,
  type EventEnvelope,
} from '@rasta/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditRepository } from '../src/audit/audit.repository';
import { DomainProjectorConsumer } from '../src/consumers/domain-projector.consumer';
import { AuditTrailConsumer } from '../src/consumers/audit-trail.consumer';
import {
  AUDIT_DEAD_LETTER_TOPIC,
  DOMAIN_PROJECTOR_CONSUMER,
  DOMAIN_TOPICS,
} from '../src/audit/audit.mapper';
import { AUDIT_TRAIL_CONSUMER } from '../src/audit/audit-trail.mapper';
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

/**
 * How long a consumer group may take to join before the wait gives up.
 *
 * Finite on purpose. A broker that never assigns a partition is a real
 * failure, and a test that waits forever for it reports nothing.
 */
const GROUP_JOIN_TIMEOUT_MS = 45_000;

/**
 * How long a message may take to reach the dead-letter topic, or the store.
 *
 * The projector consumes with a 60-second session timeout, so a connection lost
 * mid-flight can cost a whole session before the partition is reassigned and
 * the message is delivered at all. A bound shorter than that cannot tell a slow
 * rejoin from a broken projector, which would make the failure it reports a
 * lie. It is a deadline and not a sleep: the passing path costs a few seconds.
 */
const DELIVERY_TIMEOUT_MS = 120_000;

/**
 * Pins a consumer to a fixed start offset, re-applied on every group join.
 *
 * `fromBeginning: false` is honoured only while a group has nothing committed,
 * and it resolves to *the end of the topic at the instant of the join*. That
 * makes it useless as a synchronisation point on a broker that drops
 * connections: the member joins, is reset, rejoins with still nothing
 * committed, and silently restarts past a message produced in between — after
 * which no amount of waiting can deliver it. The local docker broker does
 * exactly this, and no sleep in front of `run()`, of any length, covers it.
 *
 * Seeking to offsets captured *before* the message was produced removes the
 * question. Every join — the first, and every recovery after it — starts from
 * the same recorded position, so a message published after that position is
 * delivered however often the connection is lost. Re-delivery is harmless here:
 * the caller searches what it collected rather than counting it.
 *
 * `consumer.seek` needs `run()` to have created the consumer group; kafkajs
 * emits `GROUP_JOIN` from inside the join that follows, and applies pending
 * seeks at the top of the next fetch, so a seek issued from this listener lands
 * before the first record is read.
 *
 * `stop()` removes the listener. The wait holds no timer of its own beyond the
 * poll interval `waitFor` already awaits, so nothing is left open.
 */
function pinToOffsets(
  consumer: Consumer,
  topic: string,
  startAt: ReadonlyMap<number, string>,
): { joined: (timeoutMs?: number) => Promise<number>; stop: () => void } {
  let joins = 0;

  const stop = consumer.on(consumer.events.GROUP_JOIN, ({ payload }) => {
    for (const partition of payload.memberAssignment[topic] ?? []) {
      const offset = startAt.get(partition);
      if (offset !== undefined) consumer.seek({ topic, partition, offset });
    }
    joins += 1;
  });

  return {
    joined: (timeoutMs = GROUP_JOIN_TIMEOUT_MS) =>
      waitFor(
        `the dlq reader to join its group and take its start offsets on ${topic}`,
        async () => (joins > 0 ? joins : null),
        timeoutMs,
        100,
      ),
    stop,
  };
}

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
    const dlqTopic = 'rasta.audit.v1.dlq';
    const dlq = new Kafka({
      clientId: 'audit-itest-dlq-reader',
      brokers: brokerList as string[],
      logLevel: 1,
    });
    const dlqConsumer = dlq.consumer({ groupId: `${groupId}-dlq` });
    const dlqMessages: {
      reason?: string;
      originalTopic?: string;
      error?: string;
      body: string;
    }[] = [];

    // The end of the dead-letter topic *before* anything below is published.
    // Every join the reader makes starts from here, so nothing produced after
    // this line can be skipped past by a reconnect.
    const admin = dlq.admin();
    await admin.connect();
    let startAt: ReadonlyMap<number, string>;
    try {
      startAt = new Map(
        (await admin.fetchTopicOffsets(dlqTopic)).map(({ partition, offset }) => [
          partition,
          offset,
        ]),
      );
    } finally {
      await admin.disconnect();
    }

    // Attached before `run()`, because the first join happens inside it.
    const reader = pinToOffsets(dlqConsumer, dlqTopic, startAt);

    try {
      await dlqConsumer.connect();
      await dlqConsumer.subscribe({ topic: dlqTopic, fromBeginning: false });
      await dlqConsumer.run({
        eachMessage: async ({ message }) => {
          dlqMessages.push({
            reason: message.headers?.[DLQ_HEADERS.reason]?.toString(),
            originalTopic: message.headers?.[DLQ_HEADERS.originalTopic]?.toString(),
            error: message.headers?.[DLQ_HEADERS.error]?.toString(),
            body: message.value?.toString('utf8') ?? '',
          });
        },
      });
      await reader.joined();

      const secret = `SECRET-${RUN_TAG}`;
      // Structurally invalid: `eventName` must be SCREAMING_SNAKE_CASE and
      // `correlationId` is required. It carries a run-unique secret, which does
      // two jobs — it makes the leak check below mean something, and it stops a
      // concurrent run's malformed message from satisfying the wait.
      await publish('rasta.document.v1', {
        eventId: id('EVT'),
        eventName: 'not a valid name',
        occurredAt: '2026-12-01T09:00:00.000Z',
        producer: 'document-service',
        aggregateType: 'Document',
        aggregateId: id('DOC'),
        payload: { password: secret },
      });

      const dead = await waitFor(
        'the malformed message on the dlq',
        async () => dlqMessages.find((message) => message.body.includes(secret)),
        DELIVERY_TIMEOUT_MS,
      );
      expect(dead.reason).toBe('VALIDATION_FAILED');
      // The original topic rides along, so a replay knows where it came from.
      expect(dead.originalTopic).toBe('rasta.document.v1');
      // The triage headers explain the failure without repeating the payload.
      // Only the untouched body carries it, for whoever replays the message.
      expect(dead.error).toBeDefined();
      expect(dead.error).not.toContain(secret);

      // A valid message on the same topic afterwards still lands, which is the
      // real assertion: one bad message must not stop the partition.
      const good = envelope({ producer: 'document-service', aggregateType: 'Document' });
      await publish('rasta.document.v1', good);
      const row = await waitFor(
        'the following valid row',
        rowFor(good.eventId),
        DELIVERY_TIMEOUT_MS,
      );
      expect(row.sourceTopic).toBe('rasta.document.v1');
    } finally {
      reader.stop();
      await dlqConsumer.disconnect();
    }
  }, 300_000);

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

/**
 * Path B over a real broker and a real database (AUD-004 Phase B).
 *
 * The trail topic and the dead-letter topic are the real ones. The consumer
 * group is unique per run, for the isolation reason at the top of this file;
 * that the deployed group is exactly `audit-service.trail` is pinned by the
 * composition-root spec, and the idempotency key this suite asserts is the
 * constant, not the run's group.
 *
 * Fixtures are published straight onto the topic rather than through
 * identity-service, the producer that exists today — which is also the only
 * honest way to prove what this consumer does with a message a producer gets
 * wrong, since the real producer validates before it publishes.
 */
describeWithKafka('audit-trail consumer over Kafka', () => {
  let prisma: PrismaService;
  let migrator: PrismaService;
  let repository: AuditRepository;
  let trail: AuditTrailConsumer;
  let producer: Producer;

  const groupId = `audit-itest-trail-${ulid().slice(-12)}`;
  const silentLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    fatal: () => undefined,
    trace: () => undefined,
    child: () => silentLogger,
  } as unknown as Parameters<typeof AuditTrailConsumer.prototype.constructor>[2];

  interface TrailMessageOptions {
    tenant?: string;
    payload?: Record<string, unknown>;
    envelope?: Record<string, unknown>;
  }

  function trailMessage(options: TrailMessageOptions = {}): EventEnvelope {
    const tenant = options.tenant ?? id('ORG');
    return {
      eventId: id('EVT'),
      eventName: AUDIT_EVENT_RECORDED,
      eventVersion: AUDIT_EVENT_RECORDED_VERSION,
      occurredAt: '2026-12-01T09:00:00.000Z',
      producer: 'identity-service',
      producerVersion: '1.0.0',
      aggregateType: 'AuditEvent',
      aggregateId: id('RES'),
      tenantId: tenant,
      correlationId: id('COR'),
      payload: {
        actor: { type: 'USER', id: id('USR'), roles: ['UNION_ADMIN'] },
        organizationId: tenant,
        action: 'audit.access.refuse',
        resourceType: 'AuditEvent',
        resourceId: id('RES'),
        outcome: 'REFUSED',
        errorCode: ERROR_CODES.TENANT_MISMATCH,
        occurrenceCount: 1,
        source: { ip: '10.0.0.7', userAgent: 'audit-itest' },
        ...options.payload,
      },
      ...options.envelope,
    } as EventEnvelope;
  }

  async function publish(body: unknown): Promise<void> {
    await producer.send({
      topic: AUDIT_TRAIL_TOPIC,
      messages: [{ key: ulid(), value: JSON.stringify(body) }],
    });
  }

  const rowFor = (sourceEventId: string) => () =>
    prisma.client.auditEvent.findFirst({
      where: { sourceEventId, sourceTopic: AUDIT_TRAIL_TOPIC },
    });

  beforeAll(async () => {
    prisma = newPrisma();
    migrator = newMigratorPrisma();
    await prisma.onModuleInit();
    await migrator.onModuleInit();
    repository = new AuditRepository(prisma);

    const kafka = new Kafka({
      clientId: 'audit-itest-trail-producer',
      brokers: brokerList as string[],
      logLevel: 1,
    });
    producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
    await producer.connect();

    trail = new AuditTrailConsumer(
      (handler) =>
        new EventConsumer(
          {
            brokers: brokerList as string[],
            clientId: 'audit-itest-trail',
            groupId,
            topics: [AUDIT_TRAIL_TOPIC],
            fromBeginning: true,
            deadLetterTopic: AUDIT_DEAD_LETTER_TOPIC,
            // The production retry count, with a shorter pause between
            // attempts. A refused trail message is refused identically on
            // every attempt, and replaying earlier runs' refused fixtures at
            // the default backoff would spend this suite's budget waiting.
            retryBackoffMs: 50,
          },
          handler,
          { log: () => undefined, warn: () => undefined, error: () => undefined },
        ),
      repository,
      silentLogger,
    );
    await trail.start();

    // Drain once, as the projector suite does: a sentinel published now is
    // reached only after everything the trail topic already holds.
    const sentinel = trailMessage();
    await publish(sentinel);
    await waitFor('the trail consumer to catch up', rowFor(sentinel.eventId), 600_000, 1000);
  }, 660_000);

  afterAll(async () => {
    await trail?.onModuleDestroy();
    await producer?.disconnect();
    await cleanupRun(migrator);
    await prisma.onModuleDestroy();
    await migrator.onModuleDestroy();
  }, 120_000);

  it('records a real AUDIT_EVENT_RECORDED envelope from the trail topic as a path-B row', async () => {
    const source = trailMessage({
      payload: { actor: { type: 'USER', id: id('USR'), roles: ['UNION_ADMIN', 'FLEET_MANAGER'] } },
    });
    await publish(source);

    const row = await waitFor('the trail row', rowFor(source.eventId), DELIVERY_TIMEOUT_MS);

    expect(row.sourceTopic).toBe(AUDIT_TRAIL_TOPIC);
    expect(row.sourceEventName).toBe(AUDIT_EVENT_RECORDED);
    expect(row.organizationId).toBe(source.tenantId);
    expect(row.actorRoles).toEqual(['UNION_ADMIN', 'FLEET_MANAGER']);
    expect(row.outcome).toBe('REFUSED');
    expect(row.errorCode).toBe('TENANT_MISMATCH');
    expect(row.sourceIp).toBe('10.0.0.7');
    expect(row.sourceUserAgent).toBe('audit-itest');
    expect(row.recordHash).not.toBeNull();

    expect(
      await prisma.client.processedEvent.count({
        where: { eventId: source.eventId, consumerName: AUDIT_TRAIL_CONSUMER },
      }),
    ).toBe(1);
  }, 180_000);

  it('dead-letters malformed and tenant-mismatched trail messages, records neither, and keeps consuming', async () => {
    const dlq = new Kafka({
      clientId: 'audit-itest-trail-dlq-reader',
      brokers: brokerList as string[],
      logLevel: 1,
    });
    const dlqConsumer = dlq.consumer({ groupId: `${groupId}-dlq` });
    const dlqMessages: {
      reason?: string;
      originalTopic?: string;
      error?: string;
      body: string;
    }[] = [];

    const admin = dlq.admin();
    await admin.connect();
    let startAt: ReadonlyMap<number, string>;
    try {
      startAt = new Map(
        (await admin.fetchTopicOffsets(AUDIT_DEAD_LETTER_TOPIC)).map(({ partition, offset }) => [
          partition,
          offset,
        ]),
      );
    } finally {
      await admin.disconnect();
    }

    const reader = pinToOffsets(dlqConsumer, AUDIT_DEAD_LETTER_TOPIC, startAt);

    try {
      await dlqConsumer.connect();
      await dlqConsumer.subscribe({ topic: AUDIT_DEAD_LETTER_TOPIC, fromBeginning: false });
      await dlqConsumer.run({
        eachMessage: async ({ message }) => {
          dlqMessages.push({
            reason: message.headers?.[DLQ_HEADERS.reason]?.toString(),
            originalTopic: message.headers?.[DLQ_HEADERS.originalTopic]?.toString(),
            error: message.headers?.[DLQ_HEADERS.error]?.toString(),
            body: message.value?.toString('utf8') ?? '',
          });
        },
      });
      await reader.joined();

      // Run-unique and lower-case, so none of them can satisfy — or be
      // satisfied by — the projector suite's upper-case `SECRET-` probe.
      const secret = (label: string): string => `trail-secret-${label}-${RUN_TAG}`;

      // 1. Not an envelope at all: the shared consumer refuses it before the
      //    handler runs.
      const unparseable = {
        eventId: id('EVT'),
        eventName: 'not a valid name',
        occurredAt: '2026-12-01T09:00:00.000Z',
        producer: 'identity-service',
        aggregateType: 'AuditEvent',
        aggregateId: id('RES'),
        payload: { reason: secret('envelope') },
      };
      // 2. A real envelope carrying a payload outside the v1 contract.
      const malformed = trailMessage({
        payload: { outcome: 'MAYBE', reason: secret('payload') },
      });
      // 3. A valid payload for a tenant the envelope does not name.
      const mismatched = trailMessage({
        payload: { organizationId: id('ORG'), reason: secret('tenant') },
      });

      await publish(unparseable);
      await publish(malformed);
      await publish(mismatched);

      const deadFor = (label: string) =>
        waitFor(
          `the ${label} trail message on the dlq`,
          async () => dlqMessages.find((message) => message.body.includes(secret(label))),
          DELIVERY_TIMEOUT_MS,
        );

      const deadEnvelope = await deadFor('envelope');
      expect(deadEnvelope.reason).toBe('VALIDATION_FAILED');
      expect(deadEnvelope.originalTopic).toBe(AUDIT_TRAIL_TOPIC);
      expect(deadEnvelope.error).not.toContain(secret('envelope'));

      const deadPayload = await deadFor('payload');
      expect(deadPayload.reason).toBe('MAX_RETRIES_EXCEEDED');
      expect(deadPayload.originalTopic).toBe(AUDIT_TRAIL_TOPIC);
      expect(deadPayload.error).toContain('AuditTrailRejectedError');
      expect(deadPayload.error).toContain('trail_invalid_payload');
      expect(deadPayload.error).not.toContain(secret('payload'));
      expect(deadPayload.error).not.toContain('MAYBE');

      const deadTenant = await deadFor('tenant');
      expect(deadTenant.reason).toBe('MAX_RETRIES_EXCEEDED');
      expect(deadTenant.error).toContain('trail_tenant_mismatch');
      expect(deadTenant.error).not.toContain(secret('tenant'));
      expect(deadTenant.error).not.toContain(mismatched.tenantId as string);

      // Neither refused message left evidence or a marker behind.
      for (const refused of [malformed, mismatched]) {
        expect(
          await prisma.client.auditEvent.count({ where: { sourceEventId: refused.eventId } }),
        ).toBe(0);
        expect(
          await prisma.client.processedEvent.count({ where: { eventId: refused.eventId } }),
        ).toBe(0);
      }

      // And the partition kept moving: a valid message afterwards still lands.
      const good = trailMessage();
      await publish(good);
      const row = await waitFor(
        'the following valid trail row',
        rowFor(good.eventId),
        DELIVERY_TIMEOUT_MS,
      );
      expect(row.sourceTopic).toBe(AUDIT_TRAIL_TOPIC);
    } finally {
      reader.stop();
      await dlqConsumer.disconnect();
    }
  }, 300_000);

  it('records a correction as one linked row after duplicate delivery, and leaves the original untouched (AUD-003 correction)', async () => {
    const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const flatten = (row: unknown): string =>
      JSON.stringify(row, (_key, value: unknown) =>
        typeof value === 'bigint'
          ? value.toString()
          : value instanceof Uint8Array
            ? Buffer.from(value).toString('hex')
            : value,
      );

    const source = trailMessage();
    await publish(source);
    const target = await waitFor(
      'the original trail row',
      rowFor(source.eventId),
      DELIVERY_TIMEOUT_MS,
    );
    const before = flatten(target);

    // Exactly the envelope identity-service's correction command produces.
    const correction = {
      eventId: id('EVT'),
      eventName: AUDIT_EVENT_RECORDED,
      eventVersion: AUDIT_EVENT_RECORDED_VERSION,
      occurredAt: '2026-12-01T09:30:00.000Z',
      producer: 'identity-service',
      producerVersion: '0.1.0',
      aggregateType: 'AuditEvent',
      aggregateId: target.id,
      tenantId: source.tenantId,
      correlationId: id('COR'),
      actor: { type: 'USER', id: id('USRADMIN') },
      streamKey: target.id,
      streamSeq: 1,
      payload: {
        actor: { type: 'USER', id: id('USRADMIN'), roles: ['SYSTEM_ADMIN'] },
        organizationId: source.tenantId,
        action: 'audit.correction',
        resourceType: 'AuditEvent',
        resourceId: target.id,
        outcome: 'SUCCESS',
        reason: 'Recorded against the wrong resource (INC-5120)',
        changes: [
          { field: 'outcome', from: 'REFUSED', to: 'SUCCESS' },
          { field: 'credentials.password', from: { redacted: true }, to: { redacted: true } },
        ],
        occurrenceCount: 1,
        correctionOf: target.id,
      },
    };

    // Delivered twice, keyed by the target exactly as identity's relay keys it.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await producer.send({
        topic: AUDIT_TRAIL_TOPIC,
        messages: [{ key: target.id, value: JSON.stringify(correction) }],
      });
    }

    const row = await waitFor(
      'the correction row',
      rowFor(correction.eventId),
      DELIVERY_TIMEOUT_MS,
    );
    await pause(3_000);

    // eventId idempotency: one row and one processed marker, however many copies.
    expect(
      await prisma.client.auditEvent.count({
        where: { sourceEventId: correction.eventId, sourceTopic: AUDIT_TRAIL_TOPIC },
      }),
    ).toBe(1);
    expect(
      await prisma.client.processedEvent.count({
        where: { eventId: correction.eventId, consumerName: AUDIT_TRAIL_CONSUMER },
      }),
    ).toBe(1);

    expect(row).toMatchObject({
      correctionOf: target.id,
      organizationId: source.tenantId,
      action: 'audit.correction',
      resourceType: 'AuditEvent',
      resourceId: target.id,
      outcome: 'SUCCESS',
      errorCode: null,
      actorType: 'USER',
      actorRoles: ['SYSTEM_ADMIN'],
      correlationId: correction.correlationId,
      sourceTopic: AUDIT_TRAIL_TOPIC,
    });
    expect(row.changes).toEqual(correction.payload.changes);

    // Both link directions resolve under the tenant's own scope.
    const links = await repository.findCorrectionIds(
      { kind: 'ORGANIZATION', organizationId: source.tenantId as string },
      [target],
    );
    expect(links.get(target.id)).toEqual([row.id]);

    // Append-only: the original is exactly what it was.
    const after = await rowFor(source.eventId)();
    expect(flatten(after)).toBe(before);
  });
});
