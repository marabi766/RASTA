/** Child process for the committed-effect/uncommitted-offset recovery proof. Never shipped. */
import { KafkaJSNonRetriableError } from 'kafkajs';
import {
  EventConsumer,
  installGracefulShutdown,
  kafkaConnectionFor,
  type EventHandler,
} from '@rasta/nest-common';
import type { EventEnvelope } from '@rasta/contracts';
import { SettlementAuthorityConsumer } from '../src/consumers/settlement-authority.consumer';
import { StatementSettlementConsumer } from '../src/consumers/statement-settlement.consumer';
import { RewardTriggerConsumer } from '../src/consumers/reward-trigger.consumer';
import { FakeSourceFacts } from './source-facts.fake';
import { newPrisma, wire } from './helpers';
import type {
  MaintenanceRequestFact,
  StatementFact,
  UsageRecordFact,
} from '../src/provenance/source-facts.client';

interface Input {
  kind: 'settlement-authority' | 'statement-settlement' | 'reward-trigger';
  group: string;
  reference: string;
  topic: string;
  event: EventEnvelope;
  fact: MaintenanceRequestFact | StatementFact | UsageRecordFact;
  crash: boolean;
}

process.once('message', (input: Input) => {
  void run(input).catch(() => process.exit(2));
});

async function run(input: Input): Promise<void> {
  const prisma = newPrisma();
  const wiring = wire(prisma);
  const sources = new FakeSourceFacts();
  if (input.kind === 'settlement-authority')
    sources.requests.set(input.reference, input.fact as MaintenanceRequestFact);
  else if (input.kind === 'statement-settlement')
    sources.statements.set(input.reference, input.fact as StatementFact);
  else sources.usage.set(input.reference, input.fact as UsageRecordFact);
  let shared!: EventConsumer;
  const factory = (handler: EventHandler): EventConsumer => {
    shared = new EventConsumer(
      {
        ...kafkaConnectionFor('economic-service', 'economic-restart-proof'),
        groupId: input.group,
        topics: [input.topic],
        deadLetterTopic: 'rasta.economic.v1.dlq',
      },
      async (event, delivery) => {
        if (event.correlationId !== input.event.correlationId) return 'SKIPPED';
        return handler(event, delivery);
      },
      { log: () => undefined, warn: () => undefined, error: () => undefined },
    );
    // Crash precisely AFTER the production handler has committed, BEFORE KafkaJS resolves
    // the message. The production EventConsumer CRASH listener and process shutdown are real.
    const client = (
      shared as unknown as {
        kafka: {
          consumer: (...args: unknown[]) => import('kafkajs').Consumer;
          admin: () => import('kafkajs').Admin;
        };
      }
    ).kafka;
    const makeConsumer = client.consumer.bind(client);
    client.consumer = (...args) => {
      const inner = makeConsumer(...args);
      const run = inner.run.bind(inner);
      inner.on(inner.events.GROUP_JOIN, async () => {
        if (input.crash) {
          const admin = client.admin();
          await admin.connect();
          try {
            const offsets = await admin.fetchTopicOffsets(input.topic);
            await inner.commitOffsets(
              offsets.map(({ partition, high }) => ({
                topic: input.topic,
                partition,
                offset: high,
              })),
            );
          } finally {
            await admin.disconnect();
          }
        }
        process.send?.({ type: 'ready' });
      });
      inner.run = async (config) =>
        run({
          ...config,
          eachMessage: async (payload) => {
            await config!.eachMessage!(payload);
            const event = JSON.parse(payload.message.value!.toString()) as EventEnvelope;
            if (event.correlationId !== input.event.correlationId) return;
            process.send?.({
              type: event.eventId === input.event.eventId ? 'effect' : 'probe',
              calls: sources.calls.length,
            });
            if (input.crash)
              throw new KafkaJSNonRetriableError('COMMITTED_EFFECT_BEFORE_OFFSET_TEST_CRASH');
          },
        });
      return inner;
    };
    return shared;
  };
  const consumer =
    input.kind === 'settlement-authority'
      ? new SettlementAuthorityConsumer(factory, prisma, wiring.transactions, sources)
      : input.kind === 'statement-settlement'
        ? new StatementSettlementConsumer(factory, prisma, wiring.transactions, sources, null)
        : new RewardTriggerConsumer(factory, prisma, wiring.rewards, sources);
  installGracefulShutdown(
    {
      close: async () => {
        await shared.stop({ deadlineAt: Date.now() + 5_000 });
        await prisma.stop();
      },
    },
    {
      serviceName: 'economic-service',
      timeoutMs: 8_000,
      logger: { warn: () => undefined, error: () => undefined },
    },
  );
  await consumer.onModuleInit();
}
