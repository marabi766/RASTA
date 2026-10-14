import 'reflect-metadata';
import {
  Inject,
  Injectable,
  Module,
  type INestApplicationContext,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DLQ_REASONS } from '@rasta/contracts';
import { installGracefulShutdown, type ShutdownSignalSource } from '../lifecycle/graceful-shutdown';
import type { OutboxStopOptions } from '../outbox/outbox';
import { OutboxShutdown } from '../outbox/outbox-shutdown';
import {
  ConsumerStoppingError,
  EventConsumer,
  UnprocessableEventError,
  type EventHandler,
} from './event-consumer';
import {
  FakeDlqProducer,
  FakeKafkaConsumer,
  envelopeOnAssetTopic,
  until,
  withFakeKafka,
} from './__tests__/fake-kafka';

/**
 * Codex on #267 (Medium), through a real Nest close: a Kafka consumer is one
 * of the service's background workers, stopped in the destroy phase by
 * `OutboxShutdown`'s one deadline, and the real `installGracefulShutdown`
 * closes the application under the real process deadline.
 *
 * Before, a consumer's own `onModuleDestroy` called `stop()` with no deadline,
 * and kafkajs's `disconnect()` waited for the message in flight: a handler or a
 * dead letter that did not end held the close until the timeout, exit 1.
 *
 * Settings: process deadline 2.5 s, outbox budget 1.5 s. kafkajs is the fake
 * of `__tests__/fake-kafka.ts`, which commits a message only when its
 * `eachMessage` returned — what the real runner does.
 */
const TIMEOUT_MS = 2500;
const BUDGET_MS = 1500;
const TOPIC = 'rasta.asset.v1';

const HANDLER = Symbol('HANDLER');
const KAFKA = Symbol('KAFKA');

interface KafkaFakes {
  consumer: FakeKafkaConsumer;
  producer: FakeDlqProducer;
}

/** A service's consumer wrapper, wired the way fleet/asset/maintenance now wire theirs. */
@Injectable()
class ProjectionConsumer implements OnModuleInit, OnApplicationShutdown {
  readonly consumer: EventConsumer;

  constructor(@Inject(HANDLER) handler: EventHandler, @Inject(KAFKA) fakes: KafkaFakes) {
    this.consumer = withFakeKafka(
      new EventConsumer(
        {
          brokers: ['localhost:9092'],
          clientId: 'nest-common-lifecycle-spec',
          groupId: 'nest-common-lifecycle-spec.group',
          topics: [TOPIC],
          deadLetterTopic: `${TOPIC}.dlq`,
          maxRetries: 3,
          // A pause no close can sit out.
          retryBackoffMs: 60_000,
        },
        handler,
        { log: () => undefined, warn: () => undefined, error: () => undefined },
      ),
      fakes.consumer,
      fakes.producer,
    );
  }

  async onModuleInit(): Promise<void> {
    await this.consumer.start();
  }

  /** An `OutboxShutdown` worker: stopped in the destroy phase by the shared deadline. */
  stop(options?: OutboxStopOptions): Promise<void> {
    return this.consumer.stop(options);
  }

  /** Joins the stop the coordinator began; returns at once. */
  onApplicationShutdown(): Promise<void> {
    return this.stop();
  }
}

class FakeSignals implements ShutdownSignalSource {
  on(): this {
    return this;
  }
}

async function boot(handler: EventHandler, fakes: KafkaFakes): Promise<INestApplicationContext> {
  @Module({
    providers: [
      { provide: HANDLER, useValue: handler },
      { provide: KAFKA, useValue: fakes },
      ProjectionConsumer,
      {
        provide: OutboxShutdown,
        inject: [ProjectionConsumer],
        useFactory: (consumer: ProjectionConsumer) =>
          new OutboxShutdown({
            relay: { stop: async () => undefined },
            workers: [consumer],
            budgetMs: BUDGET_MS,
          }),
      },
    ],
  })
  class AppModule {}

  return NestFactory.createApplicationContext(AppModule, { logger: false });
}

async function closeUnderDeadline(
  app: INestApplicationContext,
): Promise<{ exits: number[]; errors: string[]; tookMs: number }> {
  const exits: number[] = [];
  const errors: string[] = [];
  const shutdown = installGracefulShutdown(app, {
    serviceName: 'nest-common-lifecycle-spec',
    timeoutMs: TIMEOUT_MS,
    exit: (code) => exits.push(code),
    signalSource: new FakeSignals(),
    logger: { warn: () => undefined, error: (message) => errors.push(message) },
  });
  const startedAt = Date.now();
  await shutdown.shutdown('SIGTERM');
  return { exits, errors, tookMs: Date.now() - startedAt };
}

const message = (offset: string) => ({
  topic: TOPIC,
  partition: 0,
  offset,
  value: envelopeOnAssetTopic(`01JLIFECYCLESPEC000000000${offset}`),
});

describe('a Kafka consumer in the shutdown deadline, through a real Nest close', () => {
  it('a slow handler: exit 0 under the timeout, the message uncommitted', async () => {
    const fakes = { consumer: new FakeKafkaConsumer(), producer: new FakeDlqProducer() };
    let calls = 0;
    const app = await boot(() => {
      calls += 1;
      return new Promise<void>(() => undefined);
    }, fakes);
    void fakes.consumer.deliver(message('1'));
    await until(() => calls === 1);

    const { exits, errors, tookMs } = await closeUnderDeadline(app);

    expect(exits).toEqual([0]);
    expect(errors).toEqual([]);
    expect(tookMs).toBeLessThan(TIMEOUT_MS);
    // It waited for the handler as long as the budget allowed, no longer.
    expect(tookMs).toBeGreaterThanOrEqual(BUDGET_MS - 50);
    expect(calls).toBe(1);
    expect(fakes.consumer.committed).toEqual([]);
  });

  it('a slow dead-letter send: exit 0 under the timeout, the producer closed, nothing committed even when it lands late', async () => {
    const fakes = { consumer: new FakeKafkaConsumer(), producer: new FakeDlqProducer('send') };
    const app = await boot(async () => {
      throw new UnprocessableEventError(DLQ_REASONS.SOURCE_UNCONFIRMED, 'amount_mismatch');
    }, fakes);
    const delivered = fakes.consumer.deliver(message('2'));
    await until(() => fakes.producer.sendsStarted === 1);

    const { exits, errors, tookMs } = await closeUnderDeadline(app);

    expect(exits).toEqual([0]);
    expect(errors).toEqual([]);
    expect(tookMs).toBeLessThan(TIMEOUT_MS);
    expect(fakes.producer.disconnects).toBe(1);

    // kafkajs's close waits for the send; the broker accepts it after the close.
    fakes.producer.release();
    await delivered;
    expect(fakes.producer.sent).toHaveLength(1);
    expect(fakes.consumer.committed).toEqual([]);
    expect(fakes.consumer.uncommitted).toEqual([
      { offset: '2', error: expect.any(ConsumerStoppingError) },
    ]);
  });

  it('a handler that finishes after the close: its message is not committed', async () => {
    const fakes = { consumer: new FakeKafkaConsumer(), producer: new FakeDlqProducer() };
    let release!: () => void;
    let calls = 0;
    const app = await boot(() => {
      calls += 1;
      return new Promise<void>((resolve) => (release = resolve));
    }, fakes);
    const delivered = fakes.consumer.deliver(message('4'));
    await until(() => calls === 1);

    const { exits } = await closeUnderDeadline(app);
    expect(exits).toEqual([0]);

    release();
    await delivered;
    expect(fakes.consumer.committed).toEqual([]);
    expect(fakes.consumer.uncommitted).toEqual([
      { offset: '4', error: expect.any(ConsumerStoppingError) },
    ]);
  });

  it('a retry pause: exit 0 at once, no second attempt, the message uncommitted', async () => {
    const fakes = { consumer: new FakeKafkaConsumer(), producer: new FakeDlqProducer() };
    let calls = 0;
    const app = await boot(async () => {
      calls += 1;
      throw new Error('database blip');
    }, fakes);
    const delivered = fakes.consumer.deliver(message('3'));
    await until(() => calls === 1);

    const { exits, tookMs } = await closeUnderDeadline(app);
    await delivered;

    expect(exits).toEqual([0]);
    expect(tookMs).toBeLessThan(BUDGET_MS);
    expect(calls).toBe(1);
    expect(fakes.producer.connects).toBe(0);
    expect(fakes.consumer.committed).toEqual([]);
    expect(fakes.consumer.uncommitted[0]?.error).toBeInstanceOf(ConsumerStoppingError);
  });
});
