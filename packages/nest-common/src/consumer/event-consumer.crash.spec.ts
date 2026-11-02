import { ServiceUnavailableException } from '@nestjs/common';
import { consumerCrashesTotal, consumerExpected } from '@rasta/observability';
import { EventConsumer, CONSUMER_CRASH_REASONS } from './event-consumer';
import { consumerFailures, assertConsumerHealth, ConsumerFailures } from './consumer-health';
import { fatalShutdown, FatalShutdown } from '../lifecycle/fatal-shutdown';
import { installGracefulShutdown } from '../lifecycle/graceful-shutdown';
import { FakeKafkaConsumer, FakeDlqProducer, withFakeKafka } from './__tests__/fake-kafka';

const SERVICE = 'crash-spec';
const GROUP = `${SERVICE}.projection`;
const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
function build() {
  const kafka = new FakeKafkaConsumer();
  const consumer = withFakeKafka(
    new EventConsumer(
      {
        brokers: ['localhost:9092'],
        clientId: SERVICE,
        groupId: GROUP,
        topics: ['rasta.asset.v1'],
      },
      async () => undefined,
      logger,
    ),
    kafka,
  );
  return { kafka, consumer };
}
async function count(reason: string): Promise<number> {
  return (
    (await consumerCrashesTotal.get()).values.find(
      (value) =>
        value.labels.service === SERVICE &&
        value.labels.group === GROUP &&
        value.labels.reason === reason,
    )?.value ?? -1
  );
}

describe('terminal Kafka consumer failure', () => {
  afterEach(() => jest.restoreAllMocks());

  it('initializes every closed reason at zero before the first crash', async () => {
    build();
    for (const reason of CONSUMER_CRASH_REASONS) expect(await count(reason)).toBe(0);
  });

  it('exports expected lag gates only for enabled fixed declared groups, never ephemeral test groups', async () => {
    const options = {
      brokers: ['localhost:9092'],
      clientId: 'fleet-service',
      topics: ['rasta.asset.v1'],
      deadLetterTopic: 'rasta.fleet.v1.dlq',
    };
    new EventConsumer(
      { ...options, groupId: 'fleet-service.asset-sync' },
      async () => undefined,
      logger,
    );
    new EventConsumer(
      { ...options, groupId: 'fleet-service.ephemeral-test' },
      async () => undefined,
      logger,
    );
    const values = (await consumerExpected.get()).values;
    expect(
      values.filter((value) => value.labels.group === 'fleet-service.asset-sync'),
    ).toHaveLength(2);
    expect(values.some((value) => value.labels.group === 'fleet-service.ephemeral-test')).toBe(
      false,
    );
    expect(values.some((value) => value.labels.service === 'disabled-service')).toBe(false);
  });

  it('DISCONNECT then CRASH restart=true stays running and counts, without failing readiness or exiting', async () => {
    const exit = jest.spyOn(fatalShutdown, 'request').mockImplementation(() => undefined);
    const report = jest.spyOn(consumerFailures, 'report');
    const { kafka, consumer } = build();
    await consumer.start();
    kafka.emit(kafka.events.STOP);
    kafka.emit(kafka.events.DISCONNECT);
    expect(consumer.isRunning()).toBe(true);
    const before = await count('other');
    kafka.emit(kafka.events.CRASH, true);
    expect(consumer.isRunning()).toBe(true);
    expect(consumer.failureReason()).toBeUndefined();
    expect(await count('other')).toBe(before + 1);
    expect(report).not.toHaveBeenCalled();
    expect(() => assertConsumerHealth(SERVICE)).not.toThrow();
    expect(exit).not.toHaveBeenCalled();
    await consumer.stop();
  });

  it.each(['MESSAGE_TOO_LARGE', 'arbitrary non-restarting failure'])(
    '%s goes down, makes readiness red, counts once, exits; no error text escapes',
    async (type) => {
      const exit = jest.spyOn(fatalShutdown, 'request').mockImplementation(() => undefined);
      const { kafka, consumer } = build();
      await consumer.start();
      const error = Object.assign(new Error('PAYLOAD_HEADER_SENTINEL'), {
        type,
        name: 'PAYLOAD_HEADER_SENTINEL',
      });
      const reason = type === 'MESSAGE_TOO_LARGE' ? 'message_too_large' : 'other';
      const before = await count(reason);
      kafka.emit(kafka.events.STOP);
      kafka.emit(kafka.events.DISCONNECT);
      kafka.emit(kafka.events.CRASH, false, error);
      expect(consumer.isRunning()).toBe(false);
      expect(consumer.failureReason()).toBe(reason);
      expect(() => assertConsumerHealth(SERVICE)).toThrow(ServiceUnavailableException);
      expect(await count(reason)).toBe(before + 1);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain('PAYLOAD_HEADER_SENTINEL');
      kafka.emit(kafka.events.CRASH, false, error);
      expect(await count(reason)).toBe(before + 1);
      await consumer.stop();
      expect(consumer.failureReason()).toBe(reason);
      await expect(consumer.start()).rejects.toThrow('CONSUMER_TERMINAL_CRASH');
    },
  );

  it('a crash during run startup cannot be overwritten by the successful run return', async () => {
    jest.spyOn(fatalShutdown, 'request').mockImplementation(() => undefined);
    const { kafka, consumer } = build();
    const run = kafka.run.bind(kafka);
    kafka.run = async (config) => {
      await run(config);
      kafka.emit(kafka.events.CRASH, false);
    };
    await consumer.start();
    expect(consumer.isRunning()).toBe(false);
    expect(consumer.failureReason()).toBe('other');
    expect(logger.log).not.toHaveBeenCalled();
    await consumer.stop();
  });

  it('logs only coordinates and a closed reason for a failed record, leaving its offset uncommitted', async () => {
    jest.spyOn(fatalShutdown, 'request').mockImplementation(() => undefined);
    const kafka = new FakeKafkaConsumer();
    const producer = new FakeDlqProducer();
    const error = Object.assign(new Error('RECORD_SECRET_SENTINEL'), { type: 'MESSAGE_TOO_LARGE' });
    producer.send = async () => {
      throw error;
    };
    const consumer = withFakeKafka(
      new EventConsumer(
        {
          brokers: ['localhost:9092'],
          clientId: SERVICE,
          groupId: GROUP,
          topics: ['rasta.asset.v1'],
          deadLetterTopic: 'rasta.asset.v1.dlq',
        },
        async () => undefined,
        logger,
      ),
      kafka,
      producer,
    );
    await consumer.start();
    await kafka.deliver({
      topic: 'rasta.asset.v1',
      partition: 2,
      offset: '42',
      value: Buffer.from('RECORD_SECRET_SENTINEL'),
    });
    kafka.emit(kafka.events.CRASH, false, error);
    const logged = logger.error.mock.calls.map(([line]) => line).join('\n');
    expect(logged).toContain('topic="rasta.asset.v1" partition=2 offset="42"');
    expect(logged).toContain('reason=message_too_large');
    expect(logged).not.toContain('RECORD_SECRET_SENTINEL');
    expect(kafka.committed).toEqual([]);
    expect(kafka.uncommitted.map(({ offset }) => offset)).toEqual(['42']);
    await consumer.stop();
  });

  it('normal shutdown ignores its trailing STOP/DISCONNECT/CRASH and never exits as a failure', async () => {
    const exit = jest.spyOn(fatalShutdown, 'request').mockImplementation(() => undefined);
    const { kafka, consumer } = build();
    await consumer.start();
    await consumer.stop();
    kafka.emit(kafka.events.STOP);
    kafka.emit(kafka.events.DISCONNECT);
    kafka.emit(kafka.events.CRASH, false);
    expect(consumer.isRunning()).toBe(false);
    expect(consumer.failureReason()).toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
  });

  it('an old run cannot crash a subsequent run', async () => {
    const exit = jest.spyOn(fatalShutdown, 'request').mockImplementation(() => undefined);
    const { kafka, consumer } = build();
    await consumer.start();
    await consumer.stop();
    await consumer.start();
    // The fake reuses the same instance, exercising both old and new listeners.
    kafka.emit(kafka.events.CRASH, true);
    expect(consumer.isRunning()).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    await consumer.stop();
  });

  it('a disabled consumer has no failure state', () => {
    const health = new ConsumerFailures();
    expect(health.isHealthy('disabled-service')).toBe(true);
    health.report('other-service');
    expect(health.isHealthy('disabled-service')).toBe(true);
  });

  it('a crash before graceful shutdown installation exits non-zero immediately', () => {
    const exit = jest.fn();
    new FatalShutdown(exit).request();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('joins graceful close, flushes after close, and exits non-zero even after successful cleanup', async () => {
    const exit = jest.fn();
    const order: string[] = [];
    const source = new FatalShutdown(exit);
    const shutdown = installGracefulShutdown(
      {
        close: async () => {
          order.push('close');
        },
      },
      {
        serviceName: SERVICE,
        timeoutMs: 100,
        fatalSource: source,
        signalSource: { on: () => undefined },
        logger,
        exit,
        afterClose: async () => {
          order.push('flush');
        },
      },
    );
    source.request();
    await shutdown.shutdown('SIGTERM');
    expect(order).toEqual(['close', 'flush']);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('a hung close begins immediately and exits within the total shutdown budget', async () => {
    const exit = jest.fn();
    const source = new FatalShutdown(exit);
    const close = jest.fn(() => new Promise<void>(() => undefined));
    installGracefulShutdown(
      { close },
      {
        serviceName: SERVICE,
        timeoutMs: 30,
        fatalSource: source,
        signalSource: { on: () => undefined },
        logger,
        exit,
      },
    );
    source.request();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
  it('a stuck telemetry flush cannot extend a fatal shutdown past the total budget', async () => {
    const exit = jest.fn();
    const source = new FatalShutdown(exit);
    const shutdown = installGracefulShutdown(
      { close: async () => undefined },
      {
        serviceName: SERVICE,
        timeoutMs: 30,
        afterCloseTimeoutMs: 100,
        afterClose: () => new Promise<void>(() => undefined),
        fatalSource: source,
        signalSource: { on: () => undefined },
        logger,
        exit,
      },
    );
    source.request();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    await shutdown.shutdown('SIGTERM');
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('a terminal failure escalates an existing normal shutdown to exit 1', async () => {
    const exit = jest.fn();
    const source = new FatalShutdown(exit);
    let release!: () => void;
    const shutdown = installGracefulShutdown(
      {
        close: () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      },
      {
        serviceName: SERVICE,
        timeoutMs: 100,
        fatalSource: source,
        signalSource: { on: () => undefined },
        logger,
        exit,
      },
    );
    const stopping = shutdown.shutdown('SIGTERM');
    await Promise.resolve();
    source.request();
    release();
    await stopping;
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
