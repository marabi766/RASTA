import type { OutboxRow } from '@rasta/nest-common';
import { KafkaEventPublisher } from './kafka.publisher';

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

jest.mock('kafkajs', () => {
  const actual = jest.requireActual('kafkajs');
  return {
    ...actual,
    Kafka: function () {
      return { producer, admin: jest.fn() };
    },
  };
});

function row(): OutboxRow {
  return {
    id: 'OBX_1',
    topic: 'rasta.notification.v1',
    partitionKey: 'NTF_1',
    payload: { eventName: 'NOTIFICATION_READ' },
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
});
