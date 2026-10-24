import { CompressionTypes } from 'kafkajs';
import { DLQ_REASONS } from '@rasta/contracts';
import { dlqMessagesTotal } from '@rasta/observability';
import {
  ConsumerStoppingError,
  EventConsumer,
  UnprocessableEventError,
  type ConsumerLogger,
  type EventConsumerOptions,
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
 * Codex on #267 (Medium): `EventConsumer.stop()` had no deadline. kafkajs's
 * `disconnect()` waits for the message in flight, so a slow handler, a retry
 * ladder's pauses, or a dead letter whose producer was still connecting or
 * whose send did not return held the close past SHUTDOWN_TIMEOUT_MS into the
 * forced exit.
 *
 * These drive the real consumer against a fake kafkajs that commits a message
 * only when its `eachMessage` returned (`__tests__/fake-kafka.ts`), so "lost"
 * and "delivered again" are asserted, not assumed.
 */
const TOPIC = 'rasta.asset.v1';
const DLQ_TOPIC = 'rasta.asset.v1.dlq';
const CLIENT_ID = 'nest-common-stop-spec';

const options: EventConsumerOptions = {
  brokers: ['localhost:9092'],
  clientId: CLIENT_ID,
  groupId: 'nest-common-stop-spec.group',
  topics: [TOPIC],
  deadLetterTopic: DLQ_TOPIC,
  maxRetries: 3,
  retryBackoffMs: 10,
};

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

function logger(lines: string[]): ConsumerLogger {
  return {
    log: () => undefined,
    warn: (message) => lines.push(`warn: ${message}`),
    error: (message) => lines.push(`error: ${message}`),
  };
}

interface Harness {
  consumer: EventConsumer;
  kafka: FakeKafkaConsumer;
  producer: FakeDlqProducer;
  lines: string[];
}

async function started(
  handler: EventHandler,
  overrides: Partial<EventConsumerOptions> = {},
  producer = new FakeDlqProducer(),
): Promise<Harness> {
  const lines: string[] = [];
  const kafka = new FakeKafkaConsumer();
  const consumer = withFakeKafka(
    new EventConsumer({ ...options, ...overrides }, handler, logger(lines)),
    kafka,
    producer,
  );
  await consumer.start();
  return { consumer, kafka, producer, lines };
}

const message = (
  offset: string,
  value = envelopeOnAssetTopic(`01JSTOPSPEC00000000000${offset}`),
) => ({
  topic: TOPIC,
  partition: 0,
  offset,
  value,
});

/** Times `stop`, and checks it settled. */
async function timedStop(consumer: EventConsumer, deadlineInMs?: number): Promise<number> {
  const startedAt = Date.now();
  await consumer.stop(
    deadlineInMs === undefined ? undefined : { deadlineAt: Date.now() + deadlineInMs },
  );
  return Date.now() - startedAt;
}

describe('EventConsumer.stop by a deadline (Codex on #267)', () => {
  beforeEach(() => dlqMessagesTotal.reset());
  afterAll(() => dlqMessagesTotal.reset());

  describe('a slow handler', () => {
    it('returns by the deadline and leaves the message uncommitted, with a warning', async () => {
      let calls = 0;
      const h = await started(async () => {
        calls += 1;
        return never<void>();
      });
      void h.kafka.deliver(message('7'));
      await until(() => calls === 1);

      const tookMs = await timedStop(h.consumer, 300);

      expect(tookMs).toBeGreaterThanOrEqual(290);
      expect(tookMs).toBeLessThan(800);
      expect(h.kafka.committed).toEqual([]);
      expect(calls).toBe(1);
      expect(h.lines.some((line) => line.includes('did not stop by the shutdown deadline'))).toBe(
        true,
      );
    });

    it('waits for a handler that ends in time, and commits it', async () => {
      // The handler ends when the test says so, not after a wall-clock delay: on a loaded runner
      // a 20 ms sleep before stop() could eat most of a 150 ms handler and fail a lower bound on
      // stop's duration (main be0f5fa7, #311, #318). What matters is the order — stop() resolves
      // only after the handler has finished — and that is checked directly.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let handlerStarted = false;
      let handlerFinished = false;
      const h = await started(async () => {
        handlerStarted = true;
        await gate;
        handlerFinished = true;
      });
      const delivered = h.kafka.deliver(message('8'));
      await until(() => handlerStarted);

      let stopped = false;
      let finishedWhenStopped = false;
      const stopping = timedStop(h.consumer, 2000).then((tookMs) => {
        stopped = true;
        finishedWhenStopped = handlerFinished;
        return tookMs;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(stopped).toBe(false);

      release();
      const tookMs = await stopping;
      await delivered;

      expect(finishedWhenStopped).toBe(true);
      expect(tookMs).toBeLessThan(1000);
      expect(h.kafka.committed).toEqual(['8']);
      expect(h.kafka.disconnected).toBe(true);
      expect(h.producer.disconnects).toBe(0);
      expect(h.lines).toEqual([]);
    });

    it('still waits without a deadline, as before', async () => {
      const h = await started(() => never<void>());
      void h.kafka.deliver(message('9'));

      let settled = false;
      void h.consumer.stop().then(() => (settled = true));
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(settled).toBe(false);
    });
  });

  describe('the retry ladder', () => {
    it('cuts the pause short and starts no further attempt and no dead letter', async () => {
      let calls = 0;
      const h = await started(
        async () => {
          calls += 1;
          throw new Error('database blip');
        },
        // A 10 s pause after the first failure: the stop must not wait it out.
        { retryBackoffMs: 10_000 },
      );
      const delivered = h.kafka.deliver(message('10'));
      await until(() => calls === 1);
      await new Promise((resolve) => setTimeout(resolve, 20));

      const tookMs = await timedStop(h.consumer, 5000);
      await delivered;

      expect(tookMs).toBeLessThan(500);
      expect(calls).toBe(1);
      expect(h.producer.sent).toEqual([]);
      expect(h.kafka.committed).toEqual([]);
      expect(h.kafka.uncommitted).toHaveLength(1);
      expect(h.kafka.uncommitted[0]?.error).toBeInstanceOf(ConsumerStoppingError);
      expect(h.lines).toContainEqual(
        expect.stringContaining(`${TOPIC}[0]@10 left uncommitted before attempt 2`),
      );
    });

    it('a failure that lands while stopping goes to no pause, attempt or dead letter', async () => {
      let calls = 0;
      let fail!: (error: Error) => void;
      const h = await started(() => {
        calls += 1;
        return new Promise<void>((_resolve, reject) => (fail = reject));
      });
      const delivered = h.kafka.deliver(message('11'));
      await until(() => calls === 1);

      const stopping = h.consumer.stop({ deadlineAt: Date.now() + 5000 });
      fail(new Error('database blip'));
      await stopping;
      await delivered;

      expect(calls).toBe(1);
      expect(h.producer.sent).toEqual([]);
      expect(h.kafka.committed).toEqual([]);
      expect(h.kafka.uncommitted[0]?.error).toBeInstanceOf(ConsumerStoppingError);
    });

    it('the last attempt failing while stopping writes no dead letter', async () => {
      let calls = 0;
      let fail!: (error: Error) => void;
      const h = await started(
        () => {
          calls += 1;
          return new Promise<void>((_resolve, reject) => (fail = reject));
        },
        { maxRetries: 1 },
      );
      const delivered = h.kafka.deliver(message('12'));
      await until(() => calls === 1);

      const stopping = h.consumer.stop({ deadlineAt: Date.now() + 5000 });
      fail(new Error('database blip'));
      await stopping;
      await delivered;

      expect(h.producer.sent).toEqual([]);
      expect(h.producer.connects).toBe(0);
      expect(h.kafka.committed).toEqual([]);
      expect(h.lines).toContainEqual(
        expect.stringContaining('left uncommitted before its dead letter was written'),
      );
    });
  });

  describe('a handler that finishes after the deadline (Codex r1 on #270)', () => {
    it('is not committed however it ends, is delivered again, and is applied once', async () => {
      // An idempotent handler, as A-09 has every handler be: the effect and its
      // marker in one step, a redelivery finding the marker.
      const processed = new Set<string>();
      let applied = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let calls = 0;
      const h = await started(async (envelope) => {
        calls += 1;
        if (calls === 1) await gate;
        if (processed.has(envelope.eventId)) return 'SKIPPED';
        processed.add(envelope.eventId);
        applied += 1;
      });
      const first = h.kafka.deliver(message('60'));
      await until(() => calls === 1);

      const tookMs = await timedStop(h.consumer, 300);
      expect(tookMs).toBeLessThan(800);
      // The consumer is started again before the abandoned handler ends: the
      // verdict belongs to the run the message was delivered in.
      await h.consumer.start();

      release();
      await first;
      expect(applied).toBe(1);
      expect(h.kafka.committed).toEqual([]);
      expect(h.kafka.uncommitted).toEqual([
        { offset: '60', error: expect.any(ConsumerStoppingError) },
      ]);
      expect(h.lines).toContainEqual(
        expect.stringContaining(`${TOPIC}[0]@60 left uncommitted after the shutdown deadline`),
      );

      // Delivered again: the marker absorbs it, and this time it is committed.
      await h.kafka.deliver(message('60'));
      expect(calls).toBe(2);
      expect(applied).toBe(1);
      expect(h.kafka.committed).toEqual(['60']);
      await h.consumer.stop({ deadlineAt: Date.now() + 1000 });
    });

    it('a failure after the deadline goes to no attempt and no dead letter', async () => {
      let fail!: (error: Error) => void;
      let calls = 0;
      const h = await started(() => {
        calls += 1;
        return new Promise<void>((_resolve, reject) => (fail = reject));
      });
      const delivered = h.kafka.deliver(message('61'));
      await until(() => calls === 1);

      await timedStop(h.consumer, 200);
      fail(new UnprocessableEventError(DLQ_REASONS.SOURCE_UNCONFIRMED, 'amount_mismatch'));
      await delivered;

      expect(calls).toBe(1);
      expect(h.producer.connects).toBe(0);
      expect(h.kafka.committed).toEqual([]);
      expect(h.kafka.uncommitted[0]?.error).toBeInstanceOf(ConsumerStoppingError);
    });

    it('past the deadline by the clock, before the stop’s timer fires: not committed', async () => {
      let release!: () => void;
      const h = await started(() => new Promise<void>((resolve) => (release = resolve)));
      const delivered = h.kafka.deliver(message('62'));
      await until(() => release !== undefined);

      // A deadline already behind: the handler's success lands with the stop
      // under way, and must not return.
      const stopping = h.consumer.stop({ deadlineAt: Date.now() - 1 });
      release();
      await stopping;
      await delivered;

      expect(h.kafka.committed).toEqual([]);
      expect(h.kafka.uncommitted[0]?.error).toBeInstanceOf(ConsumerStoppingError);
    });
  });

  describe('a slow dead letter (kafkajs-faithful producer, Codex r1 on #270)', () => {
    const refusing: EventHandler = async () => {
      throw new UnprocessableEventError(DLQ_REASONS.SOURCE_UNCONFIRMED, 'amount_mismatch');
    };

    const counted = async () =>
      (await dlqMessagesTotal.get()).values.filter((s) => s.value > 0).length;

    it('a connection that completes after the stop began starts no send', async () => {
      const h = await started(refusing, {}, new FakeDlqProducer('connect'));
      const delivered = h.kafka.deliver(message('20'));
      await until(() => h.producer.connects === 1);

      // Stopping with time to spare; the connection completes meanwhile, which
      // in kafkajs marks a closed producer connected again.
      const stopping = h.consumer.stop({ deadlineAt: Date.now() + 2000 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      h.producer.release();
      await stopping;
      await delivered;

      expect(h.producer.sendsStarted).toBe(0);
      expect(h.producer.sent).toEqual([]);
      expect(h.kafka.committed).toEqual([]);
      expect(h.kafka.uncommitted[0]?.error).toBeInstanceOf(ConsumerStoppingError);
      expect(h.lines).toContainEqual(
        expect.stringContaining(`${TOPIC}[0]@20 left uncommitted before its dead letter was sent`),
      );
      // Closed again after its late connection, not left open.
      await until(() => h.producer.status === 'disconnected');
      expect(await counted()).toBe(0);
    });

    it('a connection that completes after the deadline starts no send', async () => {
      const h = await started(refusing, {}, new FakeDlqProducer('connect'));
      const delivered = h.kafka.deliver(message('22'));
      await until(() => h.producer.connects === 1);

      const tookMs = await timedStop(h.consumer, 300);
      expect(tookMs).toBeGreaterThanOrEqual(290);
      expect(tookMs).toBeLessThan(800);
      expect(h.producer.disconnects).toBe(1);

      h.producer.release();
      await delivered;

      expect(h.producer.sendsStarted).toBe(0);
      expect(h.kafka.committed).toEqual([]);
      expect(h.kafka.uncommitted[0]?.error).toBeInstanceOf(ConsumerStoppingError);
      await until(() => h.producer.status === 'disconnected');
      await until(() => h.kafka.disconnected);
    });

    it('a send in flight at the deadline: the stop returns; if it lands, the message is still not committed, and is dead-lettered again on redelivery', async () => {
      const h = await started(refusing, {}, new FakeDlqProducer('send'));
      const delivered = h.kafka.deliver(message('23'));
      await until(() => h.producer.sendsStarted === 1);

      // kafkajs's close waits for the send rather than cancel it; the stop does not.
      const tookMs = await timedStop(h.consumer, 300);
      expect(tookMs).toBeGreaterThanOrEqual(290);
      expect(tookMs).toBeLessThan(800);
      expect(h.producer.disconnects).toBe(1);
      expect(h.producer.status).toBe('disconnecting');

      // The broker accepts it after the deadline.
      h.producer.release();
      await delivered;
      expect(h.producer.sent).toHaveLength(1);
      expect(h.kafka.committed).toEqual([]);
      expect(h.kafka.uncommitted[0]?.error).toBeInstanceOf(ConsumerStoppingError);
      await until(() => h.kafka.disconnected);

      // Delivered again after a restart: dead-lettered a second time — nothing
      // deduplicates dead letters (the record key is the aggregate's partition
      // key) — then committed. Both name the same original offset.
      await h.consumer.start();
      await h.kafka.deliver(message('23'));
      expect(h.producer.sent).toHaveLength(2);
      expect(h.kafka.committed).toEqual(['23']);
      const offsets = h.producer.sent.map(
        (record) => record.messages?.[0]?.headers?.['x-dlq-original-offset'],
      );
      expect(offsets).toEqual(['23', '23']);
      await h.consumer.stop({ deadlineAt: Date.now() + 1000 });
    });

    it('a dead letter that completes in time is committed as before', async () => {
      const h = await started(refusing);
      await h.kafka.deliver(message('21'));
      await h.consumer.stop({ deadlineAt: Date.now() + 2000 });

      expect(h.producer.sent).toEqual([
        {
          topic: DLQ_TOPIC,
          acks: -1,
          compression: CompressionTypes.GZIP,
          messages: expect.any(Array),
        },
      ]);
      expect(h.kafka.committed).toEqual(['21']);
      expect(h.producer.disconnects).toBe(1);
    });
  });

  it('starts nothing for a message delivered once stopping', async () => {
    let calls = 0;
    const h = await started(async () => {
      calls += 1;
    });
    // The fake's runner is stopped by `disconnect`; reach the consumer's own
    // guard by delivering in the same tick the stop begins.
    const stopping = h.consumer.stop({ deadlineAt: Date.now() + 1000 });
    const handle = h.consumer as unknown as {
      handleMessage(
        topic: string,
        partition: number,
        value: Buffer,
        headers: undefined,
        offset: string,
      ): Promise<void>;
    };
    await expect(
      handle.handleMessage(
        TOPIC,
        0,
        envelopeOnAssetTopic('01JSTOPSPEC000000000000030'),
        undefined,
        '30',
      ),
    ).rejects.toBeInstanceOf(ConsumerStoppingError);
    await stopping;

    expect(calls).toBe(0);
  });

  it('is one stop: a later call joins the first, and returns at once after it', async () => {
    const h = await started(() => never<void>());
    void h.kafka.deliver(message('40'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const first = h.consumer.stop({ deadlineAt: Date.now() + 300 });
    expect(h.consumer.stop()).toBe(first);
    await first;
    const again = Date.now();
    await h.consumer.stop();
    expect(Date.now() - again).toBeLessThan(50);
    expect(h.kafka.disconnects).toBe(1);
    expect(
      h.lines.filter((line) => line.includes('did not stop by the shutdown deadline')),
    ).toHaveLength(1);
  });

  it('a start after a stop consumes again and can be stopped again', async () => {
    const h = await started(async () => undefined);
    await h.consumer.stop({ deadlineAt: Date.now() + 1000 });
    expect(h.consumer.isRunning()).toBe(false);

    await h.consumer.start();
    expect(h.consumer.isRunning()).toBe(true);
    await h.kafka.deliver(message('50'));
    expect(h.kafka.committed).toEqual(['50']);

    await h.consumer.stop({ deadlineAt: Date.now() + 1000 });
    expect(h.kafka.disconnects).toBe(2);
  });

  it('rejects when the disconnect fails within the deadline, as it always has', async () => {
    const h = await started(async () => undefined);
    h.kafka.disconnect = async () => {
      throw new Error('Connection already closed');
    };
    await expect(h.consumer.stop({ deadlineAt: Date.now() + 1000 })).rejects.toThrow(
      'Connection already closed',
    );
  });
});
