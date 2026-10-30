import {
  EventConsumer,
  type ConsumerLogger,
  type EventConsumerOptions,
  type EventHandler,
} from './event-consumer';
import {
  FakeKafkaConsumer,
  envelopeOnAssetTopic,
  until,
  withFakeKafka,
} from './__tests__/fake-kafka';

/**
 * PR #493 r1, F1 (Medium): a consumer's startup-failure cleanup had no deadline.
 *
 * Two escapes, one policy. A `start()` that fails after the connection was made disconnects
 * it; a caller whose own step after a successful `start()` fails stops the consumer again
 * (`stopAfterFailedStart`). Both are held to the shutdown budget the connection carries
 * (`shutdownBudgetMs`, the same one a stop without a deadline gets), give up with a fixed
 * line, and leave the ORIGINAL error as the one that reaches the caller. And a later bounded
 * `stop()` tightens a stop already pending, because `stop()` caches its promise.
 *
 * Every stall below is a real never-settling `disconnect()` on the fake kafkajs consumer; a
 * stall that is not bounded shows as `STALLED`, not as a hung test.
 */
const TOPIC = 'rasta.asset.v1';
const BUDGET_MS = 200;

const STARTUP_FAILURE = 'This server does not host this topic-partition';
const DISCONNECT_FAILURE = 'Connection already closed';

const GIVE_UP_LINE = (groupId: string): string =>
  `error: ${groupId}: cleanup after a failed start did not finish within the shutdown budget; ` +
  'abandoned, the original startup error stands';

const options: EventConsumerOptions = {
  brokers: ['localhost:9092'],
  clientId: 'nest-common-startup-cleanup-spec',
  groupId: 'nest-common-startup-cleanup-spec.group',
  topics: [TOPIC],
  deadLetterTopic: 'rasta.asset.v1.dlq',
  shutdownBudgetMs: BUDGET_MS,
};

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

/** Settles with how `work` ended, or `STALLED` if it has not by `ms`. */
async function outcomeWithin(
  work: Promise<unknown>,
  ms: number,
): Promise<'resolved' | `rejected: ${string}` | 'STALLED'> {
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    work.then(
      () => 'resolved' as const,
      (error: unknown) => `rejected: ${(error as Error).message}` as const,
    ),
    new Promise<'STALLED'>((resolve) => {
      timer = setTimeout(() => resolve('STALLED'), ms);
    }),
  ]);
  clearTimeout(timer);
  return result;
}

function build(
  kafka: FakeKafkaConsumer,
  lines: string[],
  handler: EventHandler = async () => undefined,
): EventConsumer {
  const logger: ConsumerLogger = {
    log: () => undefined,
    warn: (message) => lines.push(`warn: ${message}`),
    error: (message) => lines.push(`error: ${message}`),
  };
  return withFakeKafka(new EventConsumer(options, handler, logger), kafka);
}

/** A kafkajs consumer whose broker refuses the subscription, and whose disconnect does `how`. */
function refusing(how: 'stalls' | 'fails' | 'works'): FakeKafkaConsumer {
  const kafka = new FakeKafkaConsumer();
  kafka.subscribe = async () => {
    throw new Error(STARTUP_FAILURE);
  };
  kafka.disconnect = async () => {
    kafka.disconnects += 1;
    if (how === 'stalls') return never<void>();
    if (how === 'fails') throw new Error(DISCONNECT_FAILURE);
  };
  return kafka;
}

describe('a failed start()’s cleanup is bounded (PR #493 r1, F1)', () => {
  it('rejects with the original error within the budget when the disconnect stalls', async () => {
    const lines: string[] = [];
    const kafka = refusing('stalls');
    const consumer = build(kafka, lines);

    const startedAt = Date.now();
    const outcome = await outcomeWithin(consumer.start(), 2000);

    expect(outcome).toBe(`rejected: ${STARTUP_FAILURE}`);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(BUDGET_MS - 20);
    expect(Date.now() - startedAt).toBeLessThan(1500);
    expect(kafka.disconnects).toBe(1);
    expect(lines).toContain(GIVE_UP_LINE(options.groupId));
    expect(consumer.isRunning()).toBe(false);
  });

  it('still rejects with the original error, not the cleanup error, when the disconnect fails', async () => {
    const lines: string[] = [];
    const consumer = build(refusing('fails'), lines);

    await expect(consumer.start()).rejects.toThrow(STARTUP_FAILURE);

    expect(
      lines.some((line) => line.includes(DISCONNECT_FAILURE) && line.includes(STARTUP_FAILURE)),
    ).toBe(true);
    expect(lines).not.toContain(GIVE_UP_LINE(options.groupId));
  });

  it('a disconnect that fails after the budget is consumed, not an unhandled rejection', async () => {
    const lines: string[] = [];
    const kafka = refusing('works');
    let failLate!: (error: Error) => void;
    kafka.disconnect = () =>
      new Promise<void>((_resolve, reject) => {
        failLate = reject;
      });
    const consumer = build(kafka, lines);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): number => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(consumer.start()).rejects.toThrow(STARTUP_FAILURE);
      failLate(new Error(DISCONNECT_FAILURE));
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it('a disconnect that ends in time is unchanged: no give-up line, one disconnect', async () => {
    const lines: string[] = [];
    const kafka = refusing('works');
    const consumer = build(kafka, lines);

    await expect(consumer.start()).rejects.toThrow(STARTUP_FAILURE);

    expect(kafka.disconnects).toBe(1);
    expect(lines).toEqual([]);
  });
});

describe('stopAfterFailedStart (a caller’s own step after start() failed)', () => {
  /** Started consumer whose disconnect `how`. */
  async function started(how: 'stalls' | 'fails' | 'works', lines: string[]) {
    const kafka = new FakeKafkaConsumer();
    kafka.disconnect = async () => {
      kafka.disconnects += 1;
      if (how === 'stalls') return never<void>();
      if (how === 'fails') throw new Error(DISCONNECT_FAILURE);
    };
    const consumer = build(kafka, lines);
    await consumer.start();
    return { consumer, kafka };
  }

  it('returns within the budget when the disconnect stalls, with the fixed line', async () => {
    const lines: string[] = [];
    const { consumer, kafka } = await started('stalls', lines);

    const startedAt = Date.now();
    const outcome = await outcomeWithin(consumer.stopAfterFailedStart(), 2000);

    expect(outcome).toBe('resolved');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(BUDGET_MS - 20);
    expect(Date.now() - startedAt).toBeLessThan(1500);
    expect(kafka.disconnects).toBe(1);
    expect(consumer.isRunning()).toBe(false);
    expect(lines).toContain(GIVE_UP_LINE(options.groupId));
  });

  it('never rejects: a failing disconnect is logged and the caller keeps its own error', async () => {
    const lines: string[] = [];
    const { consumer } = await started('fails', lines);

    await expect(consumer.stopAfterFailedStart()).resolves.toBeUndefined();

    expect(lines.some((line) => line.includes(DISCONNECT_FAILURE))).toBe(true);
  });

  it('returns once a stop already pending without a deadline is tightened by it', async () => {
    const lines: string[] = [];
    const { consumer } = await started('stalls', lines);
    const unbounded = consumer.stop();

    const outcome = await outcomeWithin(consumer.stopAfterFailedStart(), 2000);

    expect(outcome).toBe('resolved');
    expect(await outcomeWithin(unbounded, 500)).toBe('resolved');
  });
});

describe('a later bounded stop tightens the cached stop (PR #493 r1, F1)', () => {
  /** A consumer with a message that never ends, so its disconnect waits for it. */
  async function busy(lines: string[]) {
    let entered = false;
    const kafka = new FakeKafkaConsumer();
    const consumer = build(kafka, lines, async () => {
      entered = true;
      return never<void>();
    });
    await consumer.start();
    void kafka.deliver({
      topic: TOPIC,
      partition: 0,
      offset: '1',
      value: envelopeOnAssetTopic('01JSTARTUPCLEANUP0000000001'),
    });
    await until(() => entered);
    return { consumer, kafka };
  }

  it('a bounded stop after an unbounded one ends the wait at its deadline, on the same promise', async () => {
    const lines: string[] = [];
    const { consumer, kafka } = await busy(lines);

    const unbounded = consumer.stop();
    expect(await outcomeWithin(unbounded, 100)).toBe('STALLED');

    const startedAt = Date.now();
    const bounded = consumer.stop({ deadlineAt: Date.now() + 200 });
    expect(bounded).toBe(unbounded);

    expect(await outcomeWithin(bounded, 2000)).toBe('resolved');
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(kafka.disconnects).toBe(1);
    expect(
      lines.filter((line) => line.includes('did not stop by the shutdown deadline')),
    ).toHaveLength(1);
    expect(kafka.committed).toEqual([]);
  });

  it('a later deadline that is earlier than the pending one wins; a later one never loosens it', async () => {
    const lines: string[] = [];
    const { consumer } = await busy(lines);

    const startedAt = Date.now();
    const first = consumer.stop({ deadlineAt: Date.now() + 5000 });
    consumer.stop({ deadlineAt: Date.now() + 200 });
    consumer.stop({ deadlineAt: Date.now() + 60_000 });
    consumer.stop();

    expect(await outcomeWithin(first, 2500)).toBe('resolved');
    expect(Date.now() - startedAt).toBeLessThan(1500);
  });

  it('a deadline already past abandons at once', async () => {
    const lines: string[] = [];
    const { consumer } = await busy(lines);

    const first = consumer.stop();
    consumer.stop({ deadlineAt: Date.now() - 1 });

    expect(await outcomeWithin(first, 500)).toBe('resolved');
  });

  it('a bounded stop after the stop has finished changes nothing', async () => {
    const lines: string[] = [];
    const kafka = new FakeKafkaConsumer();
    const consumer = build(kafka, lines);
    await consumer.start();

    await consumer.stop();
    await consumer.stop({ deadlineAt: Date.now() - 1 });

    expect(kafka.disconnects).toBe(1);
    expect(lines).toEqual([]);
  });

  it('a stop that ends in time is unchanged: it waits for the message and commits it', async () => {
    const lines: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered = false;
    const kafka = new FakeKafkaConsumer();
    const consumer = build(kafka, lines, async () => {
      entered = true;
      await gate;
    });
    await consumer.start();
    const delivered = kafka.deliver({
      topic: TOPIC,
      partition: 0,
      offset: '2',
      value: envelopeOnAssetTopic('01JSTARTUPCLEANUP0000000002'),
    });
    await until(() => entered);

    const stopping = consumer.stop({ deadlineAt: Date.now() + 5000 });
    release();
    await stopping;
    await delivered;

    expect(kafka.committed).toEqual(['2']);
    expect(lines).toEqual([]);
  });
});
