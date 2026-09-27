import { Kafka, type Consumer } from 'kafkajs';
import type { EventEnvelope } from '@rasta/contracts';
import { OutboxRelay } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import { KafkaEventPublisher } from '../src/outbox/kafka.publisher';
import { CONSTRUCTION_TOPIC } from '../src/config/env';
import {
  PROJECT,
  asAdmin,
  brokers,
  cleanup,
  newOrganizationId,
  outboxFor,
  waitFor,
  wire,
  type Wiring,
} from './helpers';

/**
 * The whole path over a real broker: domain command → outbox row in the same
 * transaction → relay → `rasta.construction.v1`, keyed by the project, with
 * the stream sequence, tenant and correlation id intact on the wire.
 *
 * Skips visibly without `KAFKA_BROKERS`; CI sets it, and creates the topic —
 * auto-creation is off (ADR-006).
 */

const brokerList = brokers();
const describeWithKafka = brokerList ? describe : describe.skip;

if (!brokerList) {
  console.warn('[event-flow] KAFKA_BROKERS is not set — skipping the broker tests');
}

interface Delivered {
  key: string | undefined;
  headers: Record<string, string>;
  envelope: EventEnvelope;
}

describeWithKafka('construction event flow over Kafka', () => {
  const org = newOrganizationId();
  const groupId = `construction-itest-${ulid().slice(-12)}`;

  let w: Wiring;
  let publisher: KafkaEventPublisher;
  let relay: OutboxRelay;
  let consumer: Consumer;
  const received: Delivered[] = [];

  beforeAll(async () => {
    w = wire();
    publisher = new KafkaEventPublisher({
      brokers: brokerList as string[],
      clientId: 'construction-itest-producer',
    });
    relay = new OutboxRelay({ store: new PrismaOutboxStore(w.prisma), publisher });

    const kafka = new Kafka({
      clientId: 'construction-itest',
      brokers: brokerList as string[],
      logLevel: 1,
    });
    consumer = kafka.consumer({ groupId, sessionTimeout: 30_000 });
    const joined = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${groupId} did not join within 60s`)),
        60_000,
      );
      consumer.on(consumer.events.GROUP_JOIN, () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await consumer.connect();
    await consumer.subscribe({ topic: CONSTRUCTION_TOPIC, fromBeginning: false });
    await consumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value) return;
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(message.headers ?? {})) {
          if (value) headers[name] = value.toString();
        }
        received.push({
          key: message.key?.toString(),
          headers,
          envelope: JSON.parse(message.value.toString('utf8')) as EventEnvelope,
        });
      },
    });
    await joined;
  }, 180_000);

  afterAll(async () => {
    await consumer?.disconnect();
    await publisher?.onModuleDestroy();
    await cleanup(w.prisma, [org]);
    await w.close();
  }, 60_000);

  it('carries a project’s lifecycle to the topic, keyed by projectId, in stream order', async () => {
    const project = await asAdmin(org, () => w.projects.create(PROJECT));
    const need = await asAdmin(org, () =>
      w.needs.add(project.id, { title: 'Gravel', description: 'Base' }),
    );
    await asAdmin(org, () => w.needs.submit(project.id, need.id, { expectedVersion: 1 }));
    await asAdmin(org, () =>
      w.projects.cancel(project.id, { expectedVersion: 1, reason: 'Funding was withdrawn' }),
    );

    relay.start();
    try {
      await waitFor(
        () => (received.filter((m) => m.key === project.id).length >= 4 ? true : undefined),
        'the relay to deliver the four project events',
        60_000,
      );
    } finally {
      await relay.stop();
    }

    const delivered = received.filter((message) => message.key === project.id);
    expect(delivered.map((message) => message.envelope.eventName)).toEqual([
      'PROJECT_CREATED',
      'PROJECT_NEED_ADDED',
      'PROJECT_NEED_SUBMITTED',
      'PROJECT_STATUS_CHANGED',
    ]);
    expect(delivered.map((message) => message.envelope.streamSeq)).toEqual([1, 2, 3, 4]);

    const rows = await outboxFor(w.prisma, org);
    for (const message of delivered) {
      expect(message.envelope.streamKey).toBe(project.id);
      expect(message.headers['x-tenant-id']).toBe(org);
      expect(message.headers['x-producer']).toBe('construction-service');
      expect(message.headers['x-stream-seq']).toBe(String(message.envelope.streamSeq));
      const row = rows.find((candidate) => candidate.id === message.envelope.eventId);
      expect(row?.correlationId).toBe(message.envelope.correlationId);
      expect(row?.publishedAt).not.toBeNull();
    }
  });

  it('reports the broker healthy', async () => {
    await expect(publisher.isHealthy()).resolves.toBe(true);
  });
});
