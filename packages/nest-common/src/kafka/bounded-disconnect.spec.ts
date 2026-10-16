import {
  boundedDisconnect,
  kafkaShutdownDeadline,
  type Disconnectable,
  type DisconnectOutcome,
} from './bounded-disconnect';
import { kafkaConnection } from './connection';

/**
 * D-052 phase 4b (Codex r2 on #276, F2): a Kafka client's close, held to the
 * shutdown deadline. kafkajs's `disconnect()` waits for its requests in flight;
 * a broker that does not answer must not hold `app.close()` past it.
 */

/** A client whose `disconnect()` ends when the test says, or never. */
class Client implements Disconnectable {
  calls = 0;
  private finish!: () => void;
  private fail!: (error: unknown) => void;
  private readonly closed = new Promise<void>((resolve, reject) => {
    this.finish = resolve;
    this.fail = reject;
  });
  disconnect(): Promise<void> {
    this.calls += 1;
    return this.closed;
  }
  resolve(): void {
    this.finish();
  }
  reject(error: unknown): void {
    this.fail(error);
  }
}

const recorder = (): { warn: (message: string) => void; warnings: string[] } => {
  const warnings: string[] = [];
  return { warn: (message) => void warnings.push(message), warnings };
};

/** Settles-yet? without waiting for it. */
const probe = <T>(promise: Promise<T>): { settled: boolean; value?: T } => {
  const state: { settled: boolean; value?: T } = { settled: false };
  void promise.then((value) => {
    state.settled = true;
    state.value = value;
  });
  return state;
};

describe('boundedDisconnect', () => {
  beforeEach(() => jest.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => jest.useRealTimers());

  it('a close that finishes in time: disconnected, no warning, no timer left', async () => {
    const client = new Client();
    const logger = recorder();
    const outcome = boundedDisconnect(client, {
      deadlineAt: Date.now() + 5000,
      label: 'Kafka producer',
      logger,
    });
    client.resolve();
    await expect(outcome).resolves.toBe('disconnected');
    expect(logger.warnings).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a close that never finishes: returns at the deadline, abandoned, with a warning', async () => {
    const client = new Client();
    const logger = recorder();
    const state = probe(
      boundedDisconnect(client, { deadlineAt: Date.now() + 5000, label: 'Kafka producer', logger }),
    );

    await jest.advanceTimersByTimeAsync(4999);
    expect(state.settled).toBe(false);
    expect(logger.warnings).toEqual([]);

    await jest.advanceTimersByTimeAsync(1);
    expect(state).toEqual({ settled: true, value: 'abandoned' });
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toContain('Kafka producer');
    expect(logger.warnings[0]).toContain('abandoned');
    expect(logger.warnings[0]).toContain('5000 ms');
  });

  it('a second call joins the close under way: one disconnect, the first deadline', async () => {
    const client = new Client();
    const logger = recorder();
    const first = boundedDisconnect(client, {
      deadlineAt: Date.now() + 1000,
      label: 'Kafka producer',
      logger,
    });
    // A later hook, with a later deadline of its own.
    const second = boundedDisconnect(client, {
      deadlineAt: Date.now() + 60_000,
      label: 'Kafka producer',
      logger,
    });
    expect(second).toBe(first);

    await jest.advanceTimersByTimeAsync(1000);
    await expect(second).resolves.toBe('abandoned');
    expect(client.calls).toBe(1);
    expect(logger.warnings).toHaveLength(1);

    // And once it has returned, a call returns at once without disconnecting again.
    await expect(
      boundedDisconnect(client, { deadlineAt: Date.now() + 1000, label: 'x', logger }),
    ).resolves.toBe('abandoned');
    expect(client.calls).toBe(1);
  });

  it('a close that fails: does not reject; failed, with a warning naming the error', async () => {
    const client = new Client();
    const logger = recorder();
    const outcome = boundedDisconnect(client, {
      deadlineAt: Date.now() + 5000,
      label: 'Kafka producer',
      logger,
    });
    client.reject(new Error('broker gone'));
    await expect(outcome).resolves.toBe('failed');
    expect(logger.warnings).toEqual(['Kafka producer: disconnect failed: Error: broker gone']);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a disconnect that throws synchronously is a failed close, not an exception', async () => {
    const logger = recorder();
    const client: Disconnectable = {
      disconnect: () => {
        throw new TypeError('not connected');
      },
    };
    await expect(
      boundedDisconnect(client, { deadlineAt: Date.now() + 5000, label: 'Kafka producer', logger }),
    ).resolves.toBe('failed');
    expect(logger.warnings[0]).toContain('TypeError: not connected');
  });

  it('a close that fails after it was abandoned: consumed, no second warning', async () => {
    const client = new Client();
    const logger = recorder();
    const outcome = boundedDisconnect(client, {
      deadlineAt: Date.now() + 100,
      label: 'Kafka producer',
      logger,
    });
    await jest.advanceTimersByTimeAsync(100);
    await expect(outcome).resolves.toBe('abandoned');

    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      client.reject(new Error('late'));
      await jest.advanceTimersByTimeAsync(0);
      await new Promise((resolve) =>
        jest.requireActual<typeof import('timers')>('timers').setImmediate(resolve),
      );
    } finally {
      process.off('unhandledRejection', unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
    expect(logger.warnings).toHaveLength(1);
  });

  it('a deadline already past: a hung close is abandoned at once', async () => {
    const client = new Client();
    const logger = recorder();
    const state = probe(
      boundedDisconnect(client, { deadlineAt: Date.now() - 50, label: 'Kafka producer', logger }),
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(state).toEqual({ settled: true, value: 'abandoned' });
    expect(client.calls).toBe(1);
  });

  it('closes of different clients are independent', async () => {
    const a = new Client();
    const b = new Client();
    const logger = recorder();
    const outcomes: Promise<DisconnectOutcome>[] = [a, b].map((client) =>
      boundedDisconnect(client, { deadlineAt: Date.now() + 1000, label: 'p', logger }),
    );
    a.resolve();
    await jest.advanceTimersByTimeAsync(1000);
    await expect(Promise.all(outcomes)).resolves.toEqual(['disconnected', 'abandoned']);
  });
});

describe('boundedDisconnect on kafkajs’s own connection', () => {
  // The path Codex traced: `Connection.disconnect()` first waits for every
  // request in flight (`RequestQueue.waitForPendingRequests`).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Connection = require('kafkajs/src/network/connection') as new (options: object) => {
    disconnect(): Promise<boolean>;
    requestQueue: { inflight: Map<number, unknown>; emit(event: string): boolean };
  };
  const silent = {
    namespace() {
      return this;
    },
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  it('a request in flight that never ends: the close returns at the deadline; the connection closes once it ends', async () => {
    const connection = new Connection({
      host: 'unused.invalid',
      port: 9092,
      logger: silent,
      requestTimeout: 30_000,
      connectionTimeout: 1000,
    });
    // A request already in flight at SIGTERM. No socket is opened.
    connection.requestQueue.inflight.set(1, {});
    let closed = false;
    const client: Disconnectable = {
      disconnect: () => connection.disconnect().then(() => void (closed = true)),
    };
    const logger = recorder();

    const startedAt = Date.now();
    const outcome = await boundedDisconnect(client, {
      deadlineAt: startedAt + 200,
      label: 'Kafka producer',
      logger,
    });
    const tookMs = Date.now() - startedAt;

    expect(outcome).toBe('abandoned');
    expect(tookMs).toBeGreaterThanOrEqual(190);
    expect(tookMs).toBeLessThan(2000);
    expect(closed).toBe(false);
    expect(logger.warnings).toHaveLength(1);

    // The request ends after all: kafkajs finishes the close in the background.
    connection.requestQueue.inflight.clear();
    connection.requestQueue.emit('requestQueueEmpty');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(true);
  });
});

describe('kafkaShutdownDeadline', () => {
  it('the budget the connection carries, from now', () => {
    expect(kafkaShutdownDeadline({ shutdownBudgetMs: 7000 }, () => 1000)).toBe(8000);
  });

  it('without one (a script’s connection): the default timeout’s budget, 25 s − 2 s', () => {
    expect(kafkaShutdownDeadline({}, () => 1000)).toBe(24_000);
  });

  it('kafkaConnection carries outboxShutdownBudgetMs from SHUTDOWN_TIMEOUT_MS — the budget OutboxShutdown drains by', () => {
    const base = {
      NODE_ENV: 'test' as const,
      SERVICE_NAME: 'fleet-service',
      KAFKA_BROKERS: 'localhost:9092',
      KAFKA_SASL_MECHANISM: 'scram-sha-512' as const,
      KAFKA_SSL: false,
      KAFKA_ALLOW_PLAINTEXT: true,
    };
    expect(kafkaConnection({ ...base, SHUTDOWN_TIMEOUT_MS: 9000 }, 'c').shutdownBudgetMs).toBe(
      7000,
    );
    expect(kafkaConnection(base, 'c')).not.toHaveProperty('shutdownBudgetMs');
  });
});
