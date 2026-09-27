import { Kafka, type Consumer, type Producer } from 'kafkajs';
import { DLQ_HEADERS, DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import { EventConsumer, UnprocessableEventError, runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { ConcludedOutcomeRepository } from '../src/performance/concluded-outcome.repository';
import { PerformanceEventRepository } from '../src/performance/performance-event.repository';
import {
  PERFORMANCE_CONSUMED_TOPICS,
  PERFORMANCE_CONSUMER,
  PerformanceConsumer,
  SUPPLIER_DEAD_LETTER_TOPIC,
} from '../src/performance/performance.consumer';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asSupplier, brokers, newOrganizationId, newPrisma } from './helpers';
import { ownerPrisma, raw } from './performance-helpers';

/**
 * ADR-052 step 5 — the performance consumer against a real PostgreSQL, and
 * then over a real broker.
 *
 * The database half drives `handle()` directly with envelopes shaped exactly
 * as marketplace publishes them: which row lands, in whose tenant, how often,
 * and what is refused. The broker half proves the three provenance outcomes
 * end to end — accepted, refused by the shared consumer (ADR-061 § 2), refused
 * by this one (§ 5) — with the refusals read back off the dead-letter topic.
 *
 * Every test uses fresh organizations and event ids: the stores are
 * append-only and nothing here can be cleaned up.
 */

const silent = { info: () => undefined, warn: () => undefined, debug: () => undefined };

interface Order {
  buyer: string;
  supplier: string;
  orderId: string;
}

function newOrder(): Order {
  return { buyer: newOrganizationId(), supplier: newOrganizationId(), orderId: `ORD_${ulid()}` };
}

/** Fields each consumed event carries beyond the order's parties. */
const PAYLOAD: Record<string, Record<string, unknown>> = {
  ORDER_CREATED: {
    totalAmountMinor: '1000',
    currency: 'IRR',
    lines: [],
    createdAt: '2026-09-20T08:00:00.000Z',
    promisedDeliveryAt: '2026-09-27T08:00:00.000Z',
  },
  ORDER_FULFILLED: {
    fulfillmentId: 'FUL_1',
    trackingReference: null,
    fulfilledAt: '2026-09-26T08:00:00.000Z',
    receiptDueAt: '2026-10-03T08:00:00.000Z',
  },
  REVIEW_SUBMITTED: { reviewId: 'REV_1', rating: 2, submittedAt: '2026-09-28T08:00:00.000Z' },
  ORDER_DISPUTE_RESOLVED: {
    disputeId: 'DSP_1',
    outcome: 'REFUND',
    responsibility: 'SUPPLIER',
    resolvedBy: 'USR_OP',
    resolvedAt: '2026-09-28T08:00:00.000Z',
  },
  ORDER_CANCELLED: {
    totalAmountMinor: '1000',
    currency: 'IRR',
    reason: 'free text nobody reads',
    cancelledBy: 'USR_1',
    cancelledAt: '2026-09-28T08:00:00.000Z',
    cancellationCause: 'PLATFORM',
  },
  ORDER_COMPLETED: {
    totalAmountMinor: '1000',
    commissionAmountMinor: '10',
    netAmountMinor: '990',
    currency: 'IRR',
    settlementId: 'STL_1',
    completedAt: '2026-09-28T08:00:00.000Z',
  },
};

function envelope(
  eventName: string,
  order: Order,
  payload: Record<string, unknown> = {},
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
  return {
    eventId: `EVT_${ulid()}`,
    eventName,
    eventVersion: 1,
    occurredAt: '2026-09-28T08:00:00.000Z',
    producer: 'marketplace-service',
    producerVersion: '1.0.0',
    aggregateType: 'Order',
    aggregateId: order.orderId,
    // marketplace stamps every order event with the buyer's tenant.
    tenantId: order.buyer,
    correlationId: `COR_${ulid()}`,
    payload: {
      orderId: order.orderId,
      buyerOrganizationId: order.buyer,
      supplierOrganizationId: order.supplier,
      ...(PAYLOAD[eventName] ?? {}),
      ...payload,
    },
    ...overrides,
  };
}

async function eventually<T>(
  describe: string,
  probe: () => Promise<T | undefined | null>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${describe}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('performance consumer (ADR-052 step 5)', () => {
  let prisma: PrismaService;
  let owner: PrismaService;
  let events: PerformanceEventRepository;
  let outcomes: ConcludedOutcomeRepository;
  let consumer: PerformanceConsumer;

  beforeAll(() => {
    prisma = newPrisma();
    owner = ownerPrisma();
    events = new PerformanceEventRepository(prisma);
    outcomes = new ConcludedOutcomeRepository(prisma);
    consumer = new PerformanceConsumer(null, prisma, events, outcomes, silent);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
    await owner.onModuleDestroy();
  });

  const ALL_TIME: [Date, Date] = [new Date('2000-01-01'), new Date('2100-01-01')];

  function factsOf(organizationId: string) {
    return asSupplier(organizationId, () => events.listInWindow(...ALL_TIME));
  }

  function outcomesOf(organizationId: string) {
    return asSupplier(organizationId, () => outcomes.listInWindow(...ALL_TIME));
  }

  function marked(eventId: string): Promise<number> {
    return raw(() =>
      prisma.client.processedEvent.count({
        where: { eventId, consumerName: PERFORMANCE_CONSUMER },
      }),
    );
  }

  describe('each event lands as one row, in the supplier’s tenant', () => {
    it.each([
      ['ORDER_CREATED', { component: 'ON_TIME', promisedAt: new Date('2026-09-27T08:00:00.000Z') }],
      [
        'ORDER_FULFILLED',
        { component: 'ON_TIME', deliveredAt: new Date('2026-09-26T08:00:00.000Z') },
      ],
      ['REVIEW_SUBMITTED', { component: 'CUSTOMER_SATISFACTION', rating: 2 }],
      [
        'ORDER_DISPUTE_RESOLVED',
        { component: 'DISPUTE_ABSENCE', responsibility: 'SUPPLIER', disputeId: 'DSP_1' },
      ],
      ['ORDER_CANCELLED', { component: 'CANCELLATION_ABSENCE', responsibility: 'PLATFORM' }],
    ] as const)('%s', async (eventName, expected) => {
      const order = newOrder();
      const source = envelope(eventName, order);

      await consumer.handle(source);

      expect(await factsOf(order.supplier)).toEqual([
        expect.objectContaining({
          organizationId: order.supplier,
          sourceEventId: source.eventId,
          sourceEventName: eventName,
          outcomeKind: 'ORDER',
          outcomeKey: order.orderId,
          occurredAt: new Date(source.occurredAt),
          correlationId: source.correlationId,
          ...expected,
        }),
      ]);
      // Recorded under the supplier, so the buyer's tenant holds nothing.
      expect(await factsOf(order.buyer)).toEqual([]);
      expect(await marked(source.eventId)).toBe(1);
    });

    it('ORDER_COMPLETED as a concluded outcome, and no component fact', async () => {
      const order = newOrder();
      const source = envelope('ORDER_COMPLETED', order);

      await consumer.handle(source);

      expect(await outcomesOf(order.supplier)).toEqual([
        expect.objectContaining({
          organizationId: order.supplier,
          sourceEventId: source.eventId,
          sourceEventName: 'ORDER_COMPLETED',
          outcomeKind: 'ORDER',
          outcomeKey: order.orderId,
          occurredAt: new Date(source.occurredAt),
        }),
      ]);
      expect(await factsOf(order.supplier)).toEqual([]);
      expect(await outcomesOf(order.buyer)).toEqual([]);
      expect(await marked(source.eventId)).toBe(1);
    });

    it('records a supplier that has no profile in this service, and scores nobody', async () => {
      // Project manager, 2026-09-26: the history is the order's. Scoring an
      // unregistered supplier is step 6's refusal, not this consumer's.
      const order = newOrder();
      await consumer.handle(envelope('REVIEW_SUBMITTED', order));

      expect(
        await runUnscoped('test: is there any profile for this supplier', () =>
          prisma.client.supplier.count({ where: { organizationId: order.supplier } }),
        ),
      ).toBe(0);
      expect(await factsOf(order.supplier)).toHaveLength(1);
      expect(
        await runUnscoped('test: no snapshot was computed', () =>
          prisma.client.performanceScoreSnapshot.count({
            where: { organizationId: order.supplier },
          }),
        ),
      ).toBe(0);
    });
  });

  describe('idempotency (ADR-032, ADR-052 rule 8)', () => {
    it('counts a redelivered event once, with one marker', async () => {
      const order = newOrder();
      const source = envelope('ORDER_DISPUTE_RESOLVED', order);

      await consumer.handle(source);
      await consumer.handle(source);
      // A retry or a replay carries a new trace id; that is the same event.
      await consumer.handle({ ...source, correlationId: `COR_${ulid()}` });

      expect(await factsOf(order.supplier)).toHaveLength(1);
      expect(await marked(source.eventId)).toBe(1);
    });

    describe('a redelivery that states a different effect is refused, not dropped (Codex review of #126)', () => {
      async function refusedAfter(first: EventEnvelope, second: EventEnvelope): Promise<void> {
        await consumer.handle(first);
        const refusal = await consumer.handle(second).catch((error: unknown) => error);
        expect(refusal).toBeInstanceOf(UnprocessableEventError);
        expect((refusal as UnprocessableEventError).reason).toBe(
          DLQ_REASONS.BUSINESS_RULE_VIOLATION,
        );
      }

      it('a changed rating', async () => {
        const order = newOrder();
        const first = envelope('REVIEW_SUBMITTED', order, { rating: 2 });
        await refusedAfter(first, {
          ...first,
          payload: { ...(first.payload as object), rating: 5 },
        });

        expect((await factsOf(order.supplier)).map((row) => row.rating)).toEqual([2]);
        expect(await marked(first.eventId)).toBe(1);
      });

      it('a changed supplier — nothing lands in the other tenant', async () => {
        const order = newOrder();
        const other = newOrganizationId();
        const first = envelope('REVIEW_SUBMITTED', order);
        await refusedAfter(first, {
          ...first,
          payload: { ...(first.payload as object), supplierOrganizationId: other },
        });

        expect(await factsOf(order.supplier)).toHaveLength(1);
        expect(await factsOf(other)).toEqual([]);
      });

      it('a changed order', async () => {
        const order = newOrder();
        const first = envelope('ORDER_CANCELLED', order);
        await refusedAfter(first, {
          ...first,
          payload: { ...(first.payload as object), orderId: `ORD_${ulid()}` },
        });

        expect((await factsOf(order.supplier)).map((row) => row.outcomeKey)).toEqual([
          order.orderId,
        ]);
      });

      it('a fact redelivered as a concluded outcome', async () => {
        const order = newOrder();
        const first = envelope('ORDER_DISPUTE_RESOLVED', order);
        await refusedAfter(
          first,
          envelope('ORDER_COMPLETED', order, {}, { eventId: first.eventId }),
        );

        expect(await factsOf(order.supplier)).toHaveLength(1);
        expect(await outcomesOf(order.supplier)).toEqual([]);
      });

      it('a concluded outcome redelivered as a fact', async () => {
        const order = newOrder();
        const first = envelope('ORDER_COMPLETED', order);
        await refusedAfter(
          first,
          envelope('REVIEW_SUBMITTED', order, {}, { eventId: first.eventId }),
        );

        expect(await outcomesOf(order.supplier)).toHaveLength(1);
        expect(await factsOf(order.supplier)).toEqual([]);
      });

      it('a marker with no recorded effect behind it', async () => {
        const order = newOrder();
        const source = envelope('REVIEW_SUBMITTED', order);
        await raw(() =>
          prisma.client.processedEvent.create({
            data: { eventId: source.eventId, consumerName: PERFORMANCE_CONSUMER },
          }),
        );

        await expect(consumer.handle(source)).rejects.toMatchObject({
          reason: DLQ_REASONS.BUSINESS_RULE_VIOLATION,
        });
        expect(await factsOf(order.supplier)).toEqual([]);
      });

      it('two conflicting deliveries at once: one is recorded, the other refused', async () => {
        const order = newOrder();
        const first = envelope('REVIEW_SUBMITTED', order, { rating: 1 });
        const second = { ...first, payload: { ...(first.payload as object), rating: 5 } };

        const results = await Promise.allSettled([consumer.handle(first), consumer.handle(second)]);

        expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
        const rejected = results.find((result) => result.status === 'rejected');
        expect((rejected as PromiseRejectedResult).reason).toMatchObject({
          reason: DLQ_REASONS.BUSINESS_RULE_VIOLATION,
        });
        expect(await factsOf(order.supplier)).toHaveLength(1);
        expect(await marked(first.eventId)).toBe(1);
      });

      it('a fact and an outcome under one id at once: one is recorded, the other refused', async () => {
        const order = newOrder();
        const fact = envelope('ORDER_DISPUTE_RESOLVED', order);
        const outcome = envelope('ORDER_COMPLETED', order, {}, { eventId: fact.eventId });

        const results = await Promise.allSettled([consumer.handle(fact), consumer.handle(outcome)]);

        expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
        const rows =
          (await factsOf(order.supplier)).length + (await outcomesOf(order.supplier)).length;
        expect(rows).toBe(1);
      });

      it('two identical deliveries at once: both succeed, one row', async () => {
        const order = newOrder();
        const source = envelope('ORDER_FULFILLED', order);

        const results = await Promise.allSettled([
          consumer.handle(source),
          consumer.handle(source),
        ]);

        expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
        expect(await factsOf(order.supplier)).toHaveLength(1);
      });
    });

    it('refuses an event id already counted as a different fact, and leaves no marker', async () => {
      // The marker is absent — as after an operator cleared it to replay — so
      // the store's own comparison is what catches the disagreement.
      const order = newOrder();
      const source = envelope('REVIEW_SUBMITTED', order);
      await asSupplier(order.supplier, () =>
        prisma.transaction((tx) =>
          events.record(tx, {
            organizationId: order.supplier,
            sourceEventId: source.eventId,
            sourceEventName: 'REVIEW_SUBMITTED',
            component: 'CUSTOMER_SATISFACTION',
            outcomeKind: 'ORDER',
            outcomeKey: order.orderId,
            responsibility: null,
            rating: 5,
            promisedAt: null,
            deliveredAt: null,
            disputeId: null,
            compensatesSourceEventId: null,
            occurredAt: new Date(source.occurredAt),
            correlationId: source.correlationId,
          }),
        ),
      );

      await expect(consumer.handle(source)).rejects.toMatchObject({
        name: 'UnprocessableEventError',
        reason: DLQ_REASONS.BUSINESS_RULE_VIOLATION,
      });
      expect(await marked(source.eventId)).toBe(0);
      expect((await factsOf(order.supplier)).map((row) => row.rating)).toEqual([5]);
    });
  });

  describe('ADR-061 § 5 — the envelope’s tenant must be the payload’s buyer', () => {
    it.each(Object.keys(PAYLOAD))(
      'refuses %s stamped with another tenant: SOURCE_UNCONFIRMED, nothing recorded, no marker',
      async (eventName) => {
        const order = newOrder();
        const forged = envelope(eventName, order, {}, { tenantId: newOrganizationId() });

        const refusal = await consumer.handle(forged).catch((error: unknown) => error);

        expect(refusal).toBeInstanceOf(UnprocessableEventError);
        expect((refusal as UnprocessableEventError).reason).toBe(DLQ_REASONS.SOURCE_UNCONFIRMED);
        expect(await factsOf(order.supplier)).toEqual([]);
        expect(await outcomesOf(order.supplier)).toEqual([]);
        expect(await marked(forged.eventId)).toBe(0);
      },
    );

    it('refuses a supplier writing about itself in its own tenant', async () => {
      const order = newOrder();
      const forged = envelope(
        'REVIEW_SUBMITTED',
        order,
        { rating: 5 },
        { tenantId: order.supplier },
      );

      await expect(consumer.handle(forged)).rejects.toMatchObject({
        reason: DLQ_REASONS.SOURCE_UNCONFIRMED,
      });
      expect(await factsOf(order.supplier)).toEqual([]);
    });
  });

  describe('events that contribute nothing are skipped, and not marked', () => {
    it.each([
      ['an ORDER_CREATED with no promise', 'ORDER_CREATED', { promisedDeliveryAt: undefined }],
      [
        'an ORDER_CANCELLED with no attribution',
        'ORDER_CANCELLED',
        { cancellationCause: undefined },
      ],
      [
        'an event this consumer does not read',
        'ORDER_CONFIRMED',
        { confirmedAt: '2026-09-28T08:00:00.000Z' },
      ],
    ])('%s', async (_label, eventName, payload) => {
      const order = newOrder();
      const source = envelope(eventName, order, payload);

      expect(await consumer.handle(source)).toBe('SKIPPED');
      expect(await factsOf(order.supplier)).toEqual([]);
      expect(await marked(source.eventId)).toBe(0);
    });
  });

  describe('a dispute resolved twice', () => {
    it('keeps both resolutions, each naming the dispute, for the later one to supersede', async () => {
      const order = newOrder();
      const disputeId = `DSP_${ulid()}`;
      const first = envelope('ORDER_DISPUTE_RESOLVED', order, {
        disputeId,
        responsibility: 'SUPPLIER',
      });
      const second = envelope(
        'ORDER_DISPUTE_RESOLVED',
        order,
        { disputeId, responsibility: 'UNDETERMINED' },
        { occurredAt: '2026-09-29T08:00:00.000Z' },
      );

      await consumer.handle(first);
      await consumer.handle(second);

      expect(
        (await factsOf(order.supplier)).map((row) => [
          row.sourceEventId,
          row.disputeId,
          row.responsibility,
        ]),
      ).toEqual([
        [first.eventId, disputeId, 'SUPPLIER'],
        [second.eventId, disputeId, 'UNDETERMINED'],
      ]);
    });
  });

  describe('the concluded-outcome store refuses what the fact store refuses', () => {
    function exec(sql: string): Promise<number> {
      return raw(() => owner.client.$executeRawUnsafe(sql));
    }

    async function seeded(): Promise<string> {
      const order = newOrder();
      const source = envelope('ORDER_COMPLETED', order);
      await consumer.handle(source);
      return source.eventId;
    }

    it.each([
      [
        'UPDATE',
        (id: string) =>
          `UPDATE "performance_concluded_outcome" SET "correlation_id" = 'X' WHERE "source_event_id" = '${id}'`,
      ],
      [
        'DELETE',
        (id: string) =>
          `DELETE FROM "performance_concluded_outcome" WHERE "source_event_id" = '${id}'`,
      ],
      ['TRUNCATE', () => 'TRUNCATE "performance_concluded_outcome"'],
    ])('refuses %s, even to the table owner', async (_op, sql) => {
      const id = await seeded();
      await expect(exec(sql(id))).rejects.toThrow(/performance_concluded_outcome is append-only/);
    });

    it('refuses a second row for one source event, and a blank outcome key', async () => {
      const id = await seeded();
      const insert = (sourceEventId: string, outcomeKey: string) =>
        `INSERT INTO "performance_concluded_outcome" ("id", "organization_id", "source_event_id",
           "source_event_name", "outcome_kind", "outcome_key", "occurred_at", "correlation_id")
         VALUES ('PCO_${ulid()}', 'ORG_X', '${sourceEventId}', 'ORDER_COMPLETED', 'ORDER', ${outcomeKey}, now(), 'COR')`;

      await expect(exec(insert(id, `'ORD_X'`))).rejects.toThrow(/Key \(source_event_id\)/);
      await expect(exec(insert(`EVT_${ulid()}`, `E'\\t'`))).rejects.toThrow(
        /ck_performance_concluded_outcome_text_not_blank/,
      );
    });

    it('reports a same-outcome redelivery as DUPLICATE and refuses a different one', async () => {
      // Straight through the repository: with the consumer's marker in place a
      // redelivery never reaches the store, so this is the store's own rule.
      const order = newOrder();
      const outcome = {
        organizationId: order.supplier,
        sourceEventId: `EVT_${ulid()}`,
        sourceEventName: 'ORDER_COMPLETED',
        outcomeKind: 'ORDER' as const,
        outcomeKey: order.orderId,
        occurredAt: new Date('2026-09-28T08:00:00.000Z'),
        correlationId: 'COR_1',
      };
      const record = (input: typeof outcome) =>
        asSupplier(order.supplier, () => prisma.transaction((tx) => outcomes.record(tx, input)));

      expect(await record(outcome)).toBe('RECORDED');
      expect(await record({ ...outcome, correlationId: 'COR_2' })).toBe('DUPLICATE');
      await expect(record({ ...outcome, outcomeKey: `ORD_${ulid()}` })).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
        internalContext: { differingFields: ['outcomeKey'] },
      });
      expect(await outcomesOf(order.supplier)).toHaveLength(1);
    });

    it('never shows one supplier another’s concluded orders', async () => {
      const a = newOrder();
      const b = newOrder();
      await consumer.handle(envelope('ORDER_COMPLETED', a));
      await consumer.handle(envelope('ORDER_COMPLETED', b));

      expect((await outcomesOf(a.supplier)).map((row) => row.organizationId)).toEqual([a.supplier]);
    });
  });
});

// ---------------------------------------------------------------------------
// Over a real broker
// ---------------------------------------------------------------------------

const brokerList = brokers();
const describeWithKafka = brokerList ? describe : describe.skip;
if (!brokerList) {
  console.warn('[performance-consumer] KAFKA_BROKERS is not set — skipping the broker tests');
}

describeWithKafka('performance consumer over Kafka', () => {
  const MARKETPLACE_TOPIC = PERFORMANCE_CONSUMED_TOPICS[0];
  const groupId = `supplier-perf-itest-${ulid().slice(-12)}`;

  let prisma: PrismaService;
  let events: PerformanceEventRepository;
  let consumer: PerformanceConsumer;
  let producer: Producer;
  let dlqReader: Consumer;
  const deadLetters: { reason?: string; originalTopic?: string; body: string }[] = [];

  function factsOf(organizationId: string) {
    return asSupplier(organizationId, () =>
      events.listInWindow(new Date('2000-01-01'), new Date('2100-01-01')),
    );
  }

  async function publish(source: EventEnvelope): Promise<void> {
    const payload = source.payload as { orderId: string };
    await producer.send({
      topic: MARKETPLACE_TOPIC,
      messages: [{ key: payload.orderId, value: JSON.stringify(source) }],
    });
  }

  function deadLetterFor(eventId: string) {
    return eventually(`${eventId} on ${SUPPLIER_DEAD_LETTER_TOPIC}`, async () =>
      deadLetters.find((message) => message.body.includes(eventId)),
    );
  }

  beforeAll(async () => {
    prisma = newPrisma();
    events = new PerformanceEventRepository(prisma);
    const kafka = new Kafka({ clientId: 'supplier-perf-itest', brokers: brokerList!, logLevel: 1 });

    producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
    await producer.connect();

    // From the beginning, filtered by this run's event ids: no join race, and
    // nothing another run left behind can satisfy a wait.
    dlqReader = kafka.consumer({ groupId: `${groupId}-dlq` });
    await dlqReader.connect();
    await dlqReader.subscribe({ topic: SUPPLIER_DEAD_LETTER_TOPIC, fromBeginning: true });
    await dlqReader.run({
      eachMessage: async ({ message }) => {
        deadLetters.push({
          reason: message.headers?.[DLQ_HEADERS.reason]?.toString(),
          originalTopic: message.headers?.[DLQ_HEADERS.originalTopic]?.toString(),
          body: message.value?.toString('utf8') ?? '',
        });
      },
    });

    consumer = new PerformanceConsumer(
      (handler) =>
        new EventConsumer(
          {
            brokers: brokerList!,
            clientId: 'supplier-perf-itest-consumer',
            groupId,
            topics: [...PERFORMANCE_CONSUMED_TOPICS],
            deadLetterTopic: SUPPLIER_DEAD_LETTER_TOPIC,
            // Not from the beginning: a shared broker's marketplace history is
            // other runs' traffic. The warm-up below waits for the join instead.
            fromBeginning: false,
            retryBackoffMs: 50,
          },
          handler,
          { log: () => undefined, warn: () => undefined, error: () => undefined },
        ),
      prisma,
      events,
      new ConcludedOutcomeRepository(prisma),
      silent,
    );
    await consumer.start();

    // A fresh group reads only what is published after it has joined, so a
    // warm-up fact is published until one lands.
    const warmUp = newOrder();
    await eventually(
      'the consumer to join and record a warm-up fact',
      async () => {
        await publish(envelope('REVIEW_SUBMITTED', warmUp));
        return (await factsOf(warmUp.supplier)).length > 0 || undefined;
      },
      120_000,
    );
  }, 180_000);

  afterAll(async () => {
    await consumer?.stop();
    await dlqReader?.disconnect();
    await producer?.disconnect();
    await prisma?.onModuleDestroy();
  }, 60_000);

  it('records a fact marketplace published, under the supplier', async () => {
    const order = newOrder();
    const source = envelope('ORDER_DISPUTE_RESOLVED', order);
    await publish(source);

    const [fact] = await eventually('the dispute fact', async () => {
      const rows = await factsOf(order.supplier);
      return rows.length > 0 ? rows : undefined;
    });
    expect(fact).toMatchObject({
      sourceEventId: source.eventId,
      component: 'DISPUTE_ABSENCE',
      responsibility: 'SUPPLIER',
    });
  }, 90_000);

  it('dead-letters a fact in another service’s name: PRODUCER_NOT_ALLOWED (ADR-061 § 2)', async () => {
    const order = newOrder();
    const forged = envelope(
      'REVIEW_SUBMITTED',
      order,
      { rating: 5 },
      { producer: 'economic-service' },
    );
    await publish(forged);

    const dead = await deadLetterFor(forged.eventId);
    expect(dead.reason).toBe(DLQ_REASONS.PRODUCER_NOT_ALLOWED);
    expect(dead.originalTopic).toBe(MARKETPLACE_TOPIC);
    expect(await factsOf(order.supplier)).toEqual([]);
  }, 90_000);

  it('dead-letters a fact whose tenant is not its buyer: SOURCE_UNCONFIRMED (ADR-061 § 5)', async () => {
    const order = newOrder();
    const forged = envelope('REVIEW_SUBMITTED', order, { rating: 5 }, { tenantId: order.supplier });
    await publish(forged);

    const dead = await deadLetterFor(forged.eventId);
    expect(dead.reason).toBe(DLQ_REASONS.SOURCE_UNCONFIRMED);
    expect(await factsOf(order.supplier)).toEqual([]);
  }, 90_000);
});
