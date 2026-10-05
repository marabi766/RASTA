import type { OutboxRow } from '@rasta/nest-common';
import { InMemoryEventPublisher, KafkaEventPublisher } from './kafka.publisher';

/**
 * What this publisher does when the application is going away.
 *
 * Shutdown is the half nobody exercises by hand, and it fails in a way that
 * looks like nothing at all: the suite passes, every assertion holds, and then
 * the process simply does not exit. CI run 35474555558 (PR #60) is the worked
 * example — 110 integration tests green, "Jest did not exit one second after
 * the test run has completed", and a step that died twenty minutes later.
 *
 * Two distinct leaks, which is why there are two tests rather than one:
 *
 *   a connect in flight   `producer` is assigned only after `connect()`
 *                         resolves, and `connect()` retries on its own timers.
 *                         A shutdown in that window used to find nothing to
 *                         close and left the timers running.
 *   a publish after       `OutboxRelay.stop()` waits a bounded grace, so a
 *   shutdown              tick can reach `publish()` afterwards. It used to
 *                         open a *new* connection to a broker the application
 *                         had just finished leaving.
 *
 * kafkajs is stubbed: it is a network client to another process, and what is
 * under test is this class's lifecycle, not the broker's.
 */

const sendBatch = jest.fn(async () => undefined);
const disconnect = jest.fn(async () => undefined);
/** Resolves only when the test says so, standing in for a retrying connect. */
let releaseConnect: (() => void) | undefined;
const connect = jest.fn(
  () =>
    new Promise<void>((resolve) => {
      releaseConnect = resolve;
    }),
);
const producer = jest.fn(() => ({ connect, sendBatch, disconnect }));
const adminConnect = jest.fn(async () => undefined);
const listTopics = jest.fn(async () => [] as string[]);
const adminDisconnect = jest.fn(async () => undefined);
const admin = jest.fn(() => ({ connect: adminConnect, listTopics, disconnect: adminDisconnect }));

jest.mock('kafkajs', () => {
  const actual = jest.requireActual('kafkajs');
  return {
    ...actual,
    Kafka: function () {
      return { producer, admin };
    },
  };
});

function row(): OutboxRow {
  return {
    id: 'OBX_1',
    topic: 'rasta.contract.v1',
    partitionKey: 'NTF_1',
    payload: { eventName: 'PROJECT_CREATED' },
    headers: {},
  } as OutboxRow;
}

describe('KafkaEventPublisher shutdown', () => {
  let publisher: KafkaEventPublisher;

  beforeEach(() => {
    releaseConnect = undefined;
    publisher = new KafkaEventPublisher({ brokers: ['localhost:19092'], clientId: 'test' });
  });

  it('disconnects a producer whose connect has not landed yet', async () => {
    // A publish that is still waiting on `connect()` — the exact window the
    // relay's last tick sits in when the broker has gone.
    const publishing = publisher.publish([row()]).catch(() => undefined);
    await Promise.resolve();

    await publisher.onModuleDestroy();

    expect(disconnect).toHaveBeenCalledTimes(1);

    releaseConnect?.();
    await publishing;
  });

  it('refuses to open a new producer after shutdown rather than connecting again', async () => {
    await publisher.onModuleDestroy();

    await expect(publisher.publish([row()])).rejects.toThrow(/shut down/);
    // The refusal is the point: a new producer here is a connection opened
    // after the application has finished closing.
    expect(producer).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('is safe to destroy twice — shutdown paths get run more than once', async () => {
    await publisher.onModuleDestroy();
    await expect(publisher.onModuleDestroy()).resolves.toBeUndefined();
  });

  it('disconnects a connected producer, once', async () => {
    const publishing = publisher.publish([row()]);
    await Promise.resolve();
    releaseConnect?.();
    await publishing;
    disconnect.mockClear();

    await publisher.onModuleDestroy();

    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('KafkaEventPublisher publishing', () => {
  let publisher: KafkaEventPublisher;

  const connectNow = async (publishing: Promise<void>) => {
    await Promise.resolve();
    releaseConnect?.();
    await publishing;
  };

  beforeEach(() => {
    releaseConnect = undefined;
    publisher = new KafkaEventPublisher({ brokers: ['localhost:19092'], clientId: 'test' });
  });

  it('publishes nothing for no rows, and does not connect', async () => {
    await publisher.publish([]);
    expect(producer).not.toHaveBeenCalled();
  });

  it('sends one batch per topic, keyed by the partition key, with the envelope as the value', async () => {
    const other = {
      ...row(),
      id: 'OBX_2',
      topic: 'rasta.other.v1',
      partitionKey: 'K2',
    } as OutboxRow;
    await connectNow(publisher.publish([row(), other, row()]));

    expect(sendBatch).toHaveBeenCalledTimes(1);
    const [batch] = sendBatch.mock.calls[0] as unknown as [
      {
        acks: number;
        topicMessages: { topic: string; messages: { key: string; value: string }[] }[];
      },
    ];
    expect(batch.acks).toBe(-1);
    expect(batch.topicMessages.map((t) => [t.topic, t.messages.length])).toEqual([
      ['rasta.contract.v1', 2],
      ['rasta.other.v1', 1],
    ]);
    expect(batch.topicMessages[0]!.messages[0]).toMatchObject({
      key: 'NTF_1',
      value: JSON.stringify(row().payload),
    });
    await publisher.onModuleDestroy();
  });

  it('opens one producer for concurrent first publishes', async () => {
    const first = publisher.publish([row()]);
    const second = publisher.publish([row()]);
    await connectNow(Promise.all([first, second]).then(() => undefined));
    expect(producer).toHaveBeenCalledTimes(1);
    await publisher.onModuleDestroy();
  });

  it('forgets a failed connect, so the next publish tries again', async () => {
    connect.mockImplementationOnce(async () => {
      throw new Error('broker unreachable');
    });
    await expect(publisher.publish([row()])).rejects.toThrow('broker unreachable');

    await connectNow(publisher.publish([row()]));
    expect(producer).toHaveBeenCalledTimes(2);
    await publisher.onModuleDestroy();
  });

  it('reports healthy when the broker lists topics, and unhealthy when it cannot', async () => {
    expect(await publisher.isHealthy()).toBe(true);
    expect(adminDisconnect).toHaveBeenCalled();

    listTopics.mockRejectedValueOnce(new Error('down'));
    expect(await publisher.isHealthy()).toBe(false);
  });
});

describe('InMemoryEventPublisher', () => {
  it('records what it was asked to publish, and can be cleared', async () => {
    const memory = new InMemoryEventPublisher();
    await memory.publish([row()]);
    expect(memory.published).toHaveLength(1);
    expect(await memory.isHealthy()).toBe(true);
    memory.clear();
    expect(memory.published).toHaveLength(0);
  });
});
