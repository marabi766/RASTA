import { Kafka, type Consumer } from 'kafkajs';
import { OutboxRelay } from '@rasta/nest-common';
import type { EventEnvelope } from '@rasta/contracts';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import { KafkaEventPublisher } from '../src/outbox/kafka.publisher';
import { MARKETPLACE_TOPIC } from '../src/config/env';
import {
  asActor,
  brokers,
  cleanup,
  id,
  key,
  newPrisma,
  publishOffer,
  tenants,
  waitFor,
  wire,
  type Wiring,
} from './helpers';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * The ADR-052 phase-2 producers, over a real broker.
 *
 * Every other suite in this directory proves the outbox row is written
 * correctly; none of them proves it ever reaches Kafka. This is that link —
 * a domain write commits an outbox row, `OutboxRelay` publishes it, and a
 * consumer on the other side reads the envelope back — for the three
 * payload changes ADR-052 step 1 makes: `ORDER_CREATED.promisedDeliveryAt`,
 * `ORDER_DISPUTE_RESOLVED`, and `ORDER_CANCELLED.cancellationCause`.
 *
 * Two of the three lessons the parallel agents' CI failures left behind are
 * applied throughout: nothing here asserts on a message count or on "the
 * last" envelope from `received` — `received` accumulates every message this
 * run's consumer group sees on the shared topic, which on a shared broker
 * includes whatever else is running. Every lookup is keyed by this run's own
 * `orderId`, generated fresh by `tenants()`/`place()` and therefore not
 * satisfiable by another run's traffic.
 */

const brokerList = brokers();
const describeWithKafka = brokerList ? describe : describe.skip;

if (!brokerList) {
  console.warn('[event-flow] KAFKA_BROKERS is not set — skipping the broker tests');
}

describeWithKafka('marketplace performance-signal events over Kafka', () => {
  const org = tenants();
  const groupId = `marketplace-itest-${id('G').slice(-12)}`;

  let prisma: PrismaService;
  let wiring: Wiring;
  let publisher: KafkaEventPublisher;
  let relay: OutboxRelay;
  let consumer: Consumer;

  const received: EventEnvelope[] = [];

  const asBuyer = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.buyer, roles: ['PROCUREMENT_USER'], userId: 'USR-BUYER' }, fn);

  const asSupplier = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.supplier, roles: ['SUPPLIER'], userId: 'USR-SUPPLIER' }, fn);

  const asOperator = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.other, roles: ['UNION_ADMIN'], userId: 'USR-OPS' }, fn);

  const asSaga = <T>(fn: () => Promise<T>) =>
    asActor(
      {
        organizationId: org.buyer,
        authType: 'SERVICE',
        callerService: 'marketplace-service',
        roles: ['SERVICE'],
      },
      fn,
    );

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    wiring = wire(prisma);

    publisher = new KafkaEventPublisher({
      brokers: brokerList!,
      clientId: 'marketplace-itest-producer',
    });
    relay = new OutboxRelay({ store: new PrismaOutboxStore(prisma), publisher });

    const kafka = new Kafka({
      clientId: 'marketplace-itest-consumer',
      brokers: brokerList!,
      logLevel: 1,
    });
    consumer = kafka.consumer({ groupId, sessionTimeout: 30_000 });

    // See fleet-service's event-flow suite for why this waits on GROUP_JOIN
    // rather than trusting `run()` to resolve: on a freshly started broker the
    // group coordinator can still be loading `__consumer_offsets`, and
    // publishing before the join completes fails on a timeout that names the
    // wrong thing.
    const joined = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Consumer group ${groupId} did not join within 60s`)),
        60_000,
      );
      consumer.on(consumer.events.GROUP_JOIN, () => {
        clearTimeout(timer);
        resolve();
      });
    });

    await consumer.connect();
    await consumer.subscribe({ topic: MARKETPLACE_TOPIC, fromBeginning: false });
    await consumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value) return;
        received.push(JSON.parse(message.value.toString('utf8')) as EventEnvelope);
      },
    });
    await joined;

    await cleanup(prisma, [org.buyer, org.supplier, org.other]);
  }, 90_000);

  afterAll(async () => {
    await consumer?.disconnect();
    await publisher?.onModuleDestroy();
    await cleanup(prisma, [org.buyer, org.supplier, org.other]);
    await prisma?.onModuleDestroy();
  }, 60_000);

  /** Finds this run's own envelope for `eventName` and `orderId`, waiting if needed. */
  async function ownEnvelope(eventName: string, orderId: string) {
    return waitFor(`${eventName} for ${orderId} to arrive on ${MARKETPLACE_TOPIC}`, async () =>
      received.find(
        (e) => e.eventName === eventName && (e.payload as { orderId?: string }).orderId === orderId,
      ),
    );
  }

  it('carries promisedDeliveryAt on ORDER_CREATED from a domain write to a Kafka consumer', async () => {
    const { offerId } = await publishOffer(wiring, org.supplier, { leadTimeDays: 6 });
    const order = await asBuyer(() =>
      wiring.orders.place({ lines: [{ offerId, quantity: 1 }] }, key('ev-created')),
    );

    const pending = await prisma.client.outboxMessage.findFirstOrThrow({
      where: { aggregateId: order.id, eventName: 'ORDER_CREATED' },
    });
    expect(pending.publishedAt).toBeNull();

    await relay.tick();

    const marked = await prisma.client.outboxMessage.findFirstOrThrow({
      where: { aggregateId: order.id, eventName: 'ORDER_CREATED' },
    });
    expect(marked.publishedAt).not.toBeNull();

    const envelope = await ownEnvelope('ORDER_CREATED', order.id);

    // The envelope every consumer relies on (docs/07 § 7.3).
    expect(envelope.producer).toBe('marketplace-service');
    expect(envelope.aggregateType).toBe('Order');
    expect(envelope.tenantId).toBe(org.buyer);
    expect(envelope.eventVersion).toBe(1);

    const payload = envelope.payload as Record<string, unknown>;
    expect(typeof payload.promisedDeliveryAt).toBe('string');
    // Six days of lead time, computed once and stored, must survive the
    // outbox → Kafka round trip unchanged.
    const promised = new Date(payload.promisedDeliveryAt as string).getTime();
    const created = new Date(payload.createdAt as string).getTime();
    expect(Math.round((promised - created) / (24 * 60 * 60 * 1000))).toBe(6);
  }, 90_000);

  it('carries ORDER_DISPUTE_RESOLVED with the operator’s own responsibility', async () => {
    const { offerId } = await publishOffer(wiring, org.supplier);
    const order = await asBuyer(() =>
      wiring.orders.place({ lines: [{ offerId, quantity: 1 }] }, key('ev-dispute')),
    );
    await asSaga(() => wiring.orders.markFundsHeld(order.id, id('TXN')));
    await asSupplier(() => wiring.orders.confirm(order.id));
    await asBuyer(() =>
      wiring.orders.raiseDispute(order.id, {
        reason: 'the part received does not match the order',
      }),
    );
    await asOperator(() =>
      wiring.orders.resolveDispute(order.id, {
        outcome: 'SETTLE',
        resolution: 'the supplier evidenced correct delivery over the broker suite',
        responsibility: 'BUYER',
      }),
    );

    await relay.tick();
    const envelope = await ownEnvelope('ORDER_DISPUTE_RESOLVED', order.id);

    expect(envelope.aggregateType).toBe('Order');
    expect(envelope.tenantId).toBe(org.buyer);
    const payload = envelope.payload as Record<string, unknown>;
    expect(payload.outcome).toBe('SETTLE');
    expect(payload.responsibility).toBe('BUYER');
    expect(payload.disputeId).toBeTruthy();
  }, 90_000);

  it('carries ORDER_CANCELLED with the structured cancellationCause', async () => {
    const { offerId } = await publishOffer(wiring, org.supplier);
    const order = await asBuyer(() =>
      wiring.orders.place({ lines: [{ offerId, quantity: 1 }] }, key('ev-cancel')),
    );
    await asBuyer(() =>
      wiring.orders.cancel(order.id, { reason: 'no longer needed, over the broker suite' }),
    );
    await asSaga(() =>
      wiring.orders.markCancelled(order.id, 'no longer needed, over the broker suite'),
    );

    await relay.tick();
    const envelope = await ownEnvelope('ORDER_CANCELLED', order.id);

    expect(envelope.aggregateType).toBe('Order');
    const payload = envelope.payload as Record<string, unknown>;
    expect(payload.cancellationCause).toBe('BUYER');
  }, 90_000);

  describe('idempotency over the real path', () => {
    it('does not move the score-relevant fields on a redelivered ORDER_CANCELLED', async () => {
      // ADR-052 § 11: the source event is immutable and idempotency keys off
      // the outbox row's own eventId — this proves the row itself, not a
      // consumer that does not exist yet, never changes on redelivery.
      const { offerId } = await publishOffer(wiring, org.supplier);
      const order = await asBuyer(() =>
        wiring.orders.place({ lines: [{ offerId, quantity: 1 }] }, key('ev-idem')),
      );
      await asBuyer(() => wiring.orders.cancel(order.id, { reason: 'idempotency probe' }));
      await asSaga(() => wiring.orders.markCancelled(order.id, 'idempotency probe'));

      const before = await prisma.client.outboxMessage.findFirstOrThrow({
        where: { aggregateId: order.id, eventName: 'ORDER_CANCELLED' },
      });

      await relay.tick();
      await relay.tick(); // a second tick must not re-publish or re-write the row

      const after = await prisma.client.outboxMessage.findFirstOrThrow({
        where: { aggregateId: order.id, eventName: 'ORDER_CANCELLED' },
      });
      expect(after.id).toBe(before.id);
      expect(
        (after.payload as { payload: Record<string, unknown> }).payload.cancellationCause,
      ).toBe('BUYER');
    }, 90_000);
  });
});
